#!/usr/bin/env python3
"""Reproduce the jamming-mitigation explorer's numbers from the command line.

This is the headless twin of the web explorer: it runs the *same* bucket math
as `math.js` over the *same* filtered mainnet graph as `build_data.py`, so the
two tables it prints match what the page renders.

  1. Per-channel-type metrics (slots per bucket, per-peer allocation `k`,
     channels an attacker needs to saturate the general bucket, and the
     largest single HTLC each bucket admits as a % of max_htlc_value_in_flight).
  2. The distribution table: the share of mainnet directed edges able to carry
     a single HTLC of at least $X in the general / congestion bucket, across
     the BTC prices and dollar thresholds you configure.
  3. The channel percentile table: what the edge at a given max_htlc percentile
     can forward through each bucket.
  4. The general routability table: drawing node pairs at random and routing
     between them, the share of channels that can still forward what a payment
     asks of them once the general bucket applies -- and, in its last row, the
     share of pairs that can still pay each other at all.

Base value `B` per direction is the advertised `max_htlc_msat` (the observable
lower bound on `max_htlc_value_in_flight_msat`). Every advertising direction is
kept — --min-max-htlc is the only thing that excludes one, identical to the
page's Filtering control.

See PR: https://github.com/lightning/bolts/pull/1280
"""

import argparse
import bisect
import csv as csvmod
import heapq
import json
import math
import os
import sys
from collections import Counter, namedtuple

from build_data import parse_graph, parse_routing_graph

# --------------------------------------------------------------------------
# Units.
# --------------------------------------------------------------------------

SAT_PER_BTC = 100_000_000

# The cutoff under consideration: below this a channel is too small to forward
# a payment once any bucket restriction applies to it. Matches app.js.
DEFAULT_MIN_MAX_HTLC = 100_000
MSAT_PER_SAT = 1_000


# --------------------------------------------------------------------------
# Pure bucket math — a faithful port of math.js so the numbers line up.
# Liquidity is split by *percentage* of max_htlc_value_in_flight. Slots are
# hard-set to fixed counts by default, or split by percentage of
# max_accepted_htlcs with --slot-mode pct. Protected takes the remainder
# either way.
# --------------------------------------------------------------------------

def bucket_slots_pct(max_accepted_htlcs, general_pct, congestion_pct):
    """Percentage slot split; protected takes the remainder. Reproduces
    restrictions.md's 193/96/194, 45/22/47, 20/10/20."""
    general = (general_pct * max_accepted_htlcs) // 100
    congestion = (congestion_pct * max_accepted_htlcs) // 100
    return {
        "general": general,
        "congestion": congestion,
        "protected": max_accepted_htlcs - general - congestion,
    }


def bucket_slots_fixed(max_accepted_htlcs, general_slots, congestion_slots):
    """Hard-set slot counts; protected takes the remainder. Callers must reject
    general + congestion > max_accepted_htlcs first (see slots_fit_type)."""
    return {
        "general": general_slots,
        "congestion": congestion_slots,
        "protected": max_accepted_htlcs - general_slots - congestion_slots,
    }


def slots_fit_type(max_accepted_htlcs, general_slots, congestion_slots):
    return general_slots + congestion_slots <= max_accepted_htlcs


def bucket_slots(n, cfg):
    if cfg["slot_mode"] == "fixed":
        return bucket_slots_fixed(n, cfg["general_slots"], cfg["congestion_slots"])
    return bucket_slots_pct(n, cfg["general_slot_pct"], cfg["congestion_slot_pct"])


def per_peer_slots(general_slots, min_slots, alloc_pct):
    """Per-peer general slot allocation: max(min, floor(pct% of n)), capped at n."""
    by_pct = (alloc_pct * general_slots) // 100
    return min(general_slots, max(min_slots, by_pct))


def general_slot_frac(general_pct, general_slots):
    """Fraction of max_htlc_value_in_flight held by one general slot."""
    if general_slots <= 0:
        return math.nan
    return general_pct / 100 / general_slots


def peer_general_frac(general_pct, general_slots, k):
    """Largest general HTLC = the whole per-peer allocation (k slots' worth)."""
    return general_slot_frac(general_pct, general_slots) * k


def congestion_slot_frac(congestion_pct, congestion_slots):
    """Largest HTLC congestion admits: one slot's worth (amount < cap/slots)."""
    if congestion_slots <= 0:
        return math.nan
    return congestion_pct / 100 / congestion_slots


# Deterministic 32-bit PRNG (mulberry32), ported bit-for-bit from math.js so the
# Monte-Carlo saturation figure matches the page. All arithmetic is kept in the
# unsigned low-32-bit space; XOR/add there agree bit-for-bit with JS's ToInt32.
def _mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def rand():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (1 | t)) & 0xFFFFFFFF
        t = ((t + ((t ^ (t >> 7)) * (61 | t))) ^ t) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rand


def channels_to_saturate(n, k, trials=3000, seed=42):
    """Expected channels to cover all n general slots when each channel is
    assigned k unique uniformly-random slots (coupon collector, group drawings).

    Monte Carlo because exact inclusion-exclusion is unstable near n = 193.
    """
    if not (n > 0) or not (k > 0):
        return math.nan
    if k >= n:
        return 1.0
    rand = _mulberry32(seed)
    total = 0
    for _ in range(trials):
        slots = list(range(n))
        covered = bytearray(n)
        covered_count = 0
        channels = 0
        while covered_count < n:
            channels += 1
            # Partial Fisher-Yates: the first k entries become this channel's
            # unique slot assignment.
            for i in range(k):
                j = i + int(rand() * (n - i))
                slots[i], slots[j] = slots[j], slots[i]
                if not covered[slots[i]]:
                    covered[slots[i]] = 1
                    covered_count += 1
        total += channels
    return total / trials


def usd_to_sat(usd, price_usd_per_btc):
    return (usd / price_usd_per_btc) * SAT_PER_BTC


def sat_to_usd(sat, price_usd_per_btc):
    return (sat / SAT_PER_BTC) * price_usd_per_btc


def required_base_sat(threshold_usd, price_usd_per_btc, frac):
    """Smallest max_htlc (sat) an edge needs so `frac` of it covers the threshold."""
    if not (frac > 0):
        return math.inf
    return usd_to_sat(threshold_usd, price_usd_per_btc) / frac


# --------------------------------------------------------------------------
# CDF over the kept edge values (ascending [sat, count] histogram).
# --------------------------------------------------------------------------

Cdf = namedtuple("Cdf", "sats suffix total")


def make_cdf(hist):
    """hist: list of (sat, count) ascending.

    suffix[i] = number of edges with value >= sats[i]
    """
    sats = [s for s, _ in hist]
    n = len(hist)
    suffix = [0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix[i] = suffix[i + 1] + hist[i][1]
    return Cdf(sats, suffix, (suffix[0] if n else 0))


def filter_hist(hist, min_sat):
    """Drop entries below min_sat, mirroring math.js's filterHist.

    The page's graph filter treats those edges as absent rather than
    down-weighted, so every figure downstream is a share of the survivors.
    """
    if not (min_sat > 0):
        return hist
    return [(sat, count) for sat, count in hist if sat >= min_sat]


def hist_value_total(hist):
    """Summed advertised max_htlc, mirroring math.js's histValueTotal.

    Counting edges and summing what they advertise answer different questions
    about a filter: the small channels are numerous but hold little.
    """
    return sum(sat * count for sat, count in hist)


def share_at_or_above(cdf, required_sat):
    """Share of edges (0..1) whose value is >= required_sat."""
    if cdf.total == 0 or required_sat == math.inf:
        return 0.0
    lo = bisect.bisect_left(cdf.sats, required_sat)
    return cdf.suffix[lo] / cdf.total


def percentile_sat(cdf, p):
    """Nearest-rank percentile: smallest observed value at or below which at
    least p% of the edges fall. p is 0..100."""
    sats, suffix, total = cdf.sats, cdf.suffix, cdf.total
    n = len(sats)
    if n == 0 or total <= 0:
        return math.nan
    rank = min(total, max(1, math.ceil(p / 100 * total)))
    # count of edges <= sats[i] is total - suffix[i + 1], non-decreasing in i.
    lo, hi = 0, n - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if total - suffix[mid + 1] >= rank:
            hi = mid
        else:
            lo = mid + 1
    return sats[lo]


def type_metrics(n, cfg):
    slots = bucket_slots(n, cfg)
    k = per_peer_slots(slots["general"], cfg["min_slots"], cfg["alloc_pct"])
    saturate = (channels_to_saturate(slots["general"], k, cfg["trials"])
                if slots["general"] > 0 and k > 0 else math.nan)
    return {
        "n": n,
        "slots": slots,
        "k": k,
        "saturate": saturate,
        "general_slot_frac": general_slot_frac(cfg["general_pct"], slots["general"]),
        "peer_general_frac": peer_general_frac(
            cfg["general_pct"], slots["general"], k),
        "congestion_slot_frac": congestion_slot_frac(
            cfg["congestion_pct"], slots["congestion"]),
    }


def fmt_pct(frac, digits=2):
    return f"{frac * 100:.{digits}f}%" if math.isfinite(frac) else "n/a"


def fmt_int(x):
    return f"{round(x):,}"


METRIC_ROWS = [
    ("General slots", lambda m: str(m["slots"]["general"])),
    ("Congestion slots", lambda m: str(m["slots"]["congestion"])),
    ("Protected slots", lambda m: str(m["slots"]["protected"])),
    ("Per-peer general slots (k)", lambda m: str(m["k"])),
    ("Channels to saturate general",
     lambda m: "~" + fmt_int(m["saturate"]) if math.isfinite(m["saturate"]) else "n/a"),
    ("Liquidity per general slot", lambda m: fmt_pct(m["general_slot_frac"])),
    ("Largest HTLC per outgoing channel", lambda m: fmt_pct(m["peer_general_frac"])),
    ("Largest congestion HTLC", lambda m: fmt_pct(m["congestion_slot_frac"])),
]


def print_metrics_table(metrics, col=12):
    print("-" * 78)
    print("Per-channel-type metrics (max_accepted_htlcs)")
    print("-" * 78)
    head = f"  {'Metric':<34}" + "".join(f"{fmt_int(m['n']) + ' slots':>{col}}"
                                          for m in metrics)
    print(head)
    for label, value in METRIC_ROWS:
        row = f"  {label:<34}" + "".join(f"{value(m):>{col}}" for m in metrics)
        print(row)
    print()


# --------------------------------------------------------------------------
# Distribution table (mirrors app.js renderTable): share of edges able to
# carry a single HTLC of at least $X in the chosen bucket.
# --------------------------------------------------------------------------

def _compact_usd(x):
    if x >= 1000:
        return f"{x / 1000:g}k"
    return str(x)


# The three bucket views the page offers, in the order it shows them.
BUCKET_VIEWS = (
    ("Single general slot", "general_slot_frac"),
    ("All general slots", "peer_general_frac"),
    ("Congestion bucket", "congestion_slot_frac"),
)


def _distribution_rows(groups, cdf, prices, thresholds, col):
    """Shared body: one column per (group, price), one row per threshold."""
    group_head = " " * 12
    for label, _ in groups:
        group_head += f"{label:^{col * len(prices)}}"
    print(group_head)
    sub = f"{'Threshold':<12}"
    for _ in groups:
        for p in prices:
            sub += f"{'@$' + _compact_usd(p):>{col}}"
    print(sub)

    for t in thresholds:
        row = f"{'>= $' + _compact_usd(t):<12}"
        for _, frac in groups:
            for p in prices:
                if not (frac > 0):
                    row += f"{'n/a':>{col}}"
                else:
                    req = required_base_sat(t, p, frac)
                    row += f"{share_at_or_above(cdf, req) * 100:>{col - 1}.1f}%"
        print(row)
    print()


def print_bucket_distribution_table(metrics, cdf, prices, thresholds, col=11):
    """Fixed slots: every channel type gives the same figures, so the columns
    are the three buckets and one table says everything."""
    m = metrics[0]
    groups = [(label, m[key]) for label, key in BUCKET_VIEWS]
    print("-" * 78)
    print("Distribution by bucket — fixed slot counts")
    print("Share of mainnet directed edges able to carry a single HTLC of >= $X.")
    print("Fixed counts do not scale with max_accepted_htlcs, so every channel")
    print("type gives these same figures.")
    print("-" * 78)
    _distribution_rows(groups, cdf, sorted(prices), sorted(thresholds), col)


def print_distribution_table(bucket, metrics, cdf, prices, thresholds, col=9):
    """Percentage slots: the buckets scale with the channel, so the columns are
    the channel types and each bucket needs its own table."""
    frac_key = "peer_general_frac" if bucket == "general" else "congestion_slot_frac"
    where = ("per-peer liquidity allocation, k slots' worth"
             if bucket == "general" else "one slot's worth of liquidity")
    groups = [(fmt_int(m["n"]) + " slots", m[frac_key]) for m in metrics]

    print("-" * 78)
    print(f"Distribution — {bucket} bucket ({where})")
    print("Share of mainnet directed edges able to carry a single HTLC of >= $X.")
    print("-" * 78)
    _distribution_rows(groups, cdf, sorted(prices), sorted(thresholds), col)


# --------------------------------------------------------------------------
# Channel percentile table (mirrors app.js renderPercentiles): the inverse of
# the distribution table. Instead of "what share of edges clears $X", it asks
# what the edge at percentile P can forward.
#
# Percentiles are taken over the WHOLE graph, not the filtered set, so a row
# means the same edge whatever --min-max-htlc is doing. Rows the filter excludes
# are marked rather than dropped, and the boundary is exactly where the filter's
# reported share falls.
# --------------------------------------------------------------------------

PCT_COLUMNS = (
    ("One general slot", lambda m: m["general_slot_frac"]),
    ("Two general slots",
     lambda m: m["general_slot_frac"] * 2 if m["k"] >= 2 else math.nan),
    ("All general slots", lambda m: m["peer_general_frac"]),
    ("Congestion slot", lambda m: m["congestion_slot_frac"]),
)


def _fmt_pctile(p):
    """10 -> '10th percentile', 21 -> '21st percentile' (mirrors app.js)."""
    if p != int(p):
        return f"{p:g}th percentile"
    n = int(p)
    if 11 <= abs(n) % 100 <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(abs(n) % 10, "th")
    return f"{n}{suffix} percentile"


def print_percentile_table(full_cdf, cfg, metrics, col=19, label_col=18):
    n = cfg["percentile_type"]
    m = next(x for x in metrics if x["n"] == n)
    price = cfg["current_price"]
    floor = cfg["min_max_htlc"]

    print("-" * 78)
    print(f"Channel percentiles — {n}-slot channels")
    print("Largest single HTLC each bucket admits for the edge at a given")
    print(f"max_htlc percentile, in USD at ${price:,.0f}/BTC, over all "
          f"{int(full_cdf.total):,} edges.")
    if floor > 0:
        print(f"Rows marked (filtered) are below the {floor:,} sat filter and "
              f"are excluded")
        print("from the tables above.")
    print("-" * 78)

    print(" " * (label_col + 2)
          + "".join(f"{label:>{col}}" for label, _ in PCT_COLUMNS))
    for p in cfg["percentiles"]:
        base = percentile_sat(full_cdf, p)
        row = f"  {_fmt_pctile(p):<{label_col}}"
        for _, pick in PCT_COLUMNS:
            frac = pick(m)
            if not (frac > 0) or math.isnan(base):
                row += f"{'n/a':>{col}}"
            else:
                row += f"{'$' + f'{sat_to_usd(base * frac, price):,.2f}':>{col}}"
        if floor > 0 and not math.isnan(base) and base < floor:
            row += "  (filtered)"
        print(row)
    print()


# --------------------------------------------------------------------------
# General routability (mirrors routability.js): draw node pairs at random,
# route between them the way a sender would, and ask each channel on the way
# whether it could forward what the payment needs.
#
# A port of the routing half of math.js. Channels are banded by their own
# advertised max_htlc against the whole-graph percentiles the table above
# prints, so the bands sit at fixed sat thresholds and raising --min-max-htlc
# empties one from below rather than moving it.
#
# Only directions that could actually forward are in this graph -- see
# parse_routing_graph -- so it is a strict subset of the edges the tables above
# count, and these shares are shares of that subset.
# --------------------------------------------------------------------------

# Senders cap routes at 20 hops, so a longer path is not one anybody builds.
MAX_HOPS = 20
# LND's RiskFactorBillionths: a hop's time lock costs the sender
# amt_msat * cltv_delta * 15 / 1e9 msat of weight alongside its fee.
RISK_FACTOR_BILLIONTHS = 15
ROUTE_CUTS = (10, 25, 50, 75, 90, 99)
DEFAULT_PAYMENT_USD = 50
# The page draws 150 destinations and 400 senders. Destinations are what cost
# anything -- each is a search plus a pass over every channel -- so the command
# line takes fewer. The band rows land on the page's figures either way; it is
# the end-to-end row that wants destinations, and 30 leaves it a few points
# short of where 150 settles.
DEFAULT_ROUTE_DESTS = 30
DEFAULT_ROUTE_SENDERS = 200
DEST_SEED = 1280
SENDER_SEED = 8080


def reverse_graph(g):
    """Incoming-edge view of the CSR graph, for searching backwards."""
    n, to = g["n"], g["to"]
    m = len(to)
    off = [0] * (n + 2)
    for v in to:
        off[v + 2] += 1
    for i in range(n):
        off[i + 2] += off[i + 1]
    src = [0] * m
    fields = {k: [0] * m for k in ("maxHtlc", "minHtlc", "baseMsat", "ppm", "cltv")}
    for u in range(n):
        for e in range(g["off"][u], g["off"][u + 1]):
            # off[v + 1] doubles as the fill cursor for v, leaving off[] as the
            # finished offset array once every edge is placed.
            slot = off[to[e] + 1]
            off[to[e] + 1] += 1
            src[slot] = u
            for k, col in fields.items():
                col[slot] = g[k][e]
    out = {"n": n, "off": off[:n + 1], "from": src}
    out.update(fields)
    return out


def hop_fee_msat(base_msat, ppm, need_sat):
    return base_msat + need_sat * ppm / MSAT_PER_SAT


def hop_weight(base_msat, ppm, cltv, need_sat):
    """What forwarding need_sat over a direction costs its sender, in msat:
    the fee, plus LND's penalty on the time lock it asks for."""
    return (hop_fee_msat(base_msat, ppm, need_sat)
            + need_sat * cltv * RISK_FACTOR_BILLIONTHS / 1e6)


def hop_admits(max_htlc, min_htlc, need_sat, frac, min_sat):
    """Whether a direction will forward need_sat at all: inside both advertised
    bounds, above the filter, and within the share the bucket admits."""
    return (max_htlc >= min_sat and need_sat >= min_htlc
            and frac * max_htlc >= need_sat)


def route_costs(rev, dest, amount_sat, frac, min_sat):
    """The route a sender would build to dest, from every node at once.

    Searched backwards because fees accumulate towards the sender: amt[x] is
    what x must receive for amount_sat to arrive, so one search answers for
    every possible sender. What is minimised is LND's weight rather than the
    amount, so dist and amt are separate -- the cheapest route by weight is not
    always the one carrying the least. frac is the share of a channel's
    max_htlc the bucket admits; pass 1 for the unrestricted case.
    """
    n = rev["n"]
    inf = float("inf")
    dist = [inf] * n
    amt = [inf] * n
    hops = [-1] * n
    dist[dest] = 0
    amt[dest] = amount_sat
    hops[dest] = 0
    heap = [(0, dest)]
    roff, rfrom = rev["off"], rev["from"]
    rmax, rmin = rev["maxHtlc"], rev["minHtlc"]
    rbase, rppm, rcltv = rev["baseMsat"], rev["ppm"], rev["cltv"]
    while heap:
        key, v = heapq.heappop(heap)
        if key > dist[v]:
            continue
        # A hop into v would be the (hops[v] + 1)th, and nothing past the cap
        # can appear in a route anybody builds. Like LND, this is judged on the
        # cheapest path to v rather than on every path to it.
        if hops[v] >= MAX_HOPS:
            continue
        need = amt[v]
        for e in range(roff[v], roff[v + 1]):
            if not hop_admits(rmax[e], rmin[e], need, frac, min_sat):
                continue
            u = rfrom[e]
            cand = key + hop_weight(rbase[e], rppm[e], rcltv[e], need)
            if cand < dist[u]:
                dist[u] = cand
                amt[u] = need + hop_fee_msat(rbase[e], rppm[e], need) / MSAT_PER_SAT
                hops[u] = hops[v] + 1
                heapq.heappush(heap, (cand, u))
    return amt, hops


def source_results(g, dest, amt, hops, min_sat, senders=None):
    """Which nodes can pay dest, given a completed backwards search.

    The sender's own first hop is not bucket-constrained -- the bucket applies
    where a node forwards, and the sender forwards nothing -- so it is settled
    here against the raw max_htlc instead. senders is optional: one backwards
    search answers for every sender at once, so there is no reason to walk the
    whole graph when only a sample is being scored.
    """
    n = g["n"]
    ok = [False] * n
    out_hops = [-1] * n
    inf = float("inf")
    for u in (range(n) if senders is None else senders):
        if u == dest:
            continue
        best = inf
        for e in range(g["off"][u], g["off"][u + 1]):
            v = g["to"][e]
            need = amt[v]
            if need == inf or hops[v] + 1 > MAX_HOPS:
                continue
            if not hop_admits(g["maxHtlc"][e], g["minHtlc"][e], need, 1, min_sat):
                continue
            if need < best:
                best = need
                out_hops[u] = hops[v] + 1
                ok[u] = True
    return ok, out_hops


def eligible_nodes(view, min_sat):
    """Nodes the filter leaves standing, in whichever direction is handed in:
    over the forward CSR those that can still send, over the reverse those that
    can still be paid."""
    out = []
    for u in range(view["n"]):
        for e in range(view["off"][u], view["off"][u + 1]):
            if view["maxHtlc"][e] >= min_sat:
                out.append(u)
                break
    return out


def hash_node(u, seed):
    """Deterministic 32-bit hash of a node index under a seed."""
    h = (u ^ seed) & 0xFFFFFFFF
    for _ in range(2):
        h = ((h ^ (h >> 16)) * 0x45D9F3B) & 0xFFFFFFFF
    return h ^ (h >> 16)


def sample_nodes(nodes, count, seed):
    """A random subset, drawn by scoring each node with a hash of its own index
    and keeping the lowest scores. A node's score does not depend on which
    other nodes are eligible, so moving the filter adds and removes members
    rather than redrawing the whole sample."""
    if len(nodes) <= count:
        return list(nodes)
    return [u for _, u in sorted((hash_node(u, seed), u) for u in nodes)[:count]]


def band_index(sat, thresholds):
    """Which band a channel falls in. One sitting exactly on a threshold falls
    to the lower band."""
    for i, t in enumerate(thresholds):
        if sat <= t:
            return i
    return len(thresholds)


def band_channel_counts(g, min_sat, thresholds):
    counts = [0] * (len(thresholds) + 1)
    for sat in g["maxHtlc"]:
        if sat >= min_sat:
            counts[band_index(sat, thresholds)] += 1
    return counts


def tally_bands(g, dest, amt, hops, fracs, min_sat, thresholds, acc):
    """One destination's contribution to the per-band counters.

    Every surviving channel u -> v is asked the same question: if a payment
    bound for dest were handed to u, could this channel carry it onwards? The
    amount is not the payment but what v must receive for it to land, so a
    channel deep in the network is asked for more than one beside the
    destination. An attempt only counts where v can reach dest inside the hop
    cap; where it cannot, nothing downstream works and the channel's own size
    is not what the payment failed on.
    """
    inf = float("inf")
    for u in range(g["n"]):
        if u == dest:
            continue
        for e in range(g["off"][u], g["off"][u + 1]):
            cap = g["maxHtlc"][e]
            if cap < min_sat:
                continue
            v = g["to"][e]
            need = amt[v]
            if need == inf or hops[v] + 1 > MAX_HOPS:
                continue
            b = band_index(cap, thresholds)
            floor = g["minHtlc"][e]
            acc["attempts"][b] += 1
            acc["demand"][b] += need
            if hop_admits(cap, floor, need, 1, min_sat):
                acc["ok_base"][b] += 1
            for c, frac in enumerate(fracs):
                if hop_admits(cap, floor, need, frac, min_sat):
                    acc["ok_bucket"][c][b] += 1


def routability_columns(cfg, metrics):
    """The table's columns, on the same rule the distribution table follows:
    the two general buckets under fixed slots, the channel types under
    percentage slots."""
    if cfg["slot_mode"] == "fixed":
        m = max(metrics, key=lambda x: x["n"])
        return [("single general slot", m["general_slot_frac"]),
                ("all general slots", m["peer_general_frac"])]
    return [(f"{m['n']} slots", m["peer_general_frac"]) for m in metrics]


def print_routability_table(graph, full_cdf, cfg, metrics, col=21, label_col=20):
    g, gstats = parse_routing_graph(graph)
    if not g["to"]:
        print("no routable directions found; skipping routability",
              file=sys.stderr)
        return
    rev = reverse_graph(g)
    thresholds = [percentile_sat(full_cdf, p) for p in ROUTE_CUTS]
    min_sat = cfg["min_max_htlc"]
    price = cfg["current_price"]
    amount = usd_to_sat(cfg["payment_usd"], price)

    can_send = eligible_nodes(g, min_sat)
    can_receive = eligible_nodes(rev, min_sat)
    dests = sample_nodes(can_receive, cfg["route_dests"], DEST_SEED)
    senders = sample_nodes(can_send, cfg["route_senders"], SENDER_SEED)
    channels = band_channel_counts(g, min_sat, thresholds)

    columns = routability_columns(cfg, metrics)
    fracs = [f if f > 0 else 0 for _, f in columns]
    bands = len(thresholds) + 1
    acc = {"attempts": [0] * bands, "ok_base": [0] * bands,
           "demand": [0.0] * bands,
           "ok_bucket": [[0] * bands for _ in columns]}
    end_ok = [0] * len(columns)
    pairs = 0
    base_ok = 0

    for dest in dests:
        amt, hops = route_costs(rev, dest, amount, 1.0, min_sat)
        tally_bands(g, dest, amt, hops, fracs, min_sat, thresholds, acc)
        ok, _ = source_results(g, dest, amt, hops, min_sat, senders)
        for u in senders:
            if u == dest:
                continue
            pairs += 1
            if ok[u]:
                base_ok += 1
        for c, frac in enumerate(fracs):
            if not frac:
                continue
            r_amt, r_hops = route_costs(rev, dest, amount, frac, min_sat)
            r_ok, _ = source_results(g, dest, r_amt, r_hops, min_sat, senders)
            end_ok[c] += sum(1 for u in senders if u != dest and r_ok[u])

    print("-" * 78)
    print("General routability — per channel")
    print(f"Share of surviving channels that can forward ${cfg['payment_usd']:,.0f} "
          f"({amount:,.0f} sat at ${price:,.0f}/BTC)")
    print("when a payment comes past, with the general bucket applied to every "
          "channel a")
    print("payment is forwarded over. Unrestricted share in brackets.")
    print(f"Routable graph: {len(g['to']):,} directions over {g['n']:,} nodes "
          f"({gstats['noPolicy']:,} with no")
    print(f"policy and {gstats['disabled']:,} disabled are not in it).")
    print(f"Sampled {len(dests)} destinations of the {len(can_receive):,} that "
          f"can be paid at this filter,")
    print(f"and {len(senders)} senders of the {len(can_send):,} that can send.")
    print(f"Bands by advertised max_htlc, at the whole-graph percentiles the "
          f"table above prints.")
    print("-" * 78)

    def band_label(i):
        if i == 0:
            return f"to p{ROUTE_CUTS[0]}"
        if i == len(thresholds):
            return f"above p{ROUTE_CUTS[-1]}"
        return f"p{ROUTE_CUTS[i - 1]}-p{ROUTE_CUTS[i]}"

    header = "  " + f"{'channel band':<{label_col}}" + f"{'channels':>10}"
    for label, _ in columns:
        header += f"{label:>{col}}"
    print(header)
    for b in range(bands):
        row = f"  {band_label(b):<{label_col}}" + f"{channels[b]:>10,}"
        attempts = acc["attempts"][b]
        for c in range(len(columns)):
            if not attempts or not fracs[c]:
                row += f"{'n/a':>{col}}"
            else:
                shown = (f"{acc['ok_bucket'][c][b] / attempts * 100:.1f}% "
                         f"({acc['ok_base'][b] / attempts * 100:.1f}%)")
                row += f"{shown:>{col}}"
        print(row)
    # A different question from the bands above it -- payments, not channels --
    # so it is set apart rather than read as one more band.
    row = f"  {'payments end to end':<{label_col}}" + f"{pairs:>10,}"
    for c in range(len(columns)):
        if not pairs or not fracs[c]:
            row += f"{'n/a':>{col}}"
        else:
            shown = (f"{end_ok[c] / pairs * 100:.1f}% "
                     f"({base_ok / pairs * 100:.1f}%)")
            row += f"{shown:>{col}}"
    print("  " + "-" * (label_col + 10 + col * len(columns) - 2))
    print(row)
    empty = [band_label(b) for b in range(bands) if not channels[b]]
    if empty:
        print(f"\n  The {', '.join(empty)} band is emptied by the "
              f"{min_sat:,} sat filter.")
    print()


# --------------------------------------------------------------------------
# Main analysis.
# --------------------------------------------------------------------------

def analyze(graph, cfg, source, csv_path=None):
    kept, stats = parse_graph(graph)
    if not kept:
        print("no usable directed policies found", file=sys.stderr)
        return 1

    full_hist = sorted(Counter(kept).items())
    hist = filter_hist(full_hist, cfg["min_max_htlc"])
    cdf = make_cdf(hist)
    full_cdf = make_cdf(full_hist)
    if not hist:
        print(f"--min-max-htlc {cfg['min_max_htlc']} filtered out every edge",
              file=sys.stderr)
        return 1

    metrics = [type_metrics(n, cfg)
               for n in sorted(cfg["channel_types"], reverse=True)]

    print("=" * 78)
    print("BOLT #1280 local resource conservation — mainnet bucket analysis")
    print("=" * 78)
    print(f"Data: {os.path.basename(source)} — {len(kept):,} directed edges, "
          f"{stats['imputed']:,} with max_htlc imputed from capacity.")
    if cfg["min_max_htlc"] > 0:
        removed = len(kept) - int(cdf.total)
        full_value = hist_value_total(full_hist)
        kept_value = hist_value_total(hist)
        dropped_value = full_value - kept_value
        print(f"Graph filter: max_htlc >= {cfg['min_max_htlc']:,} sat — "
              f"{removed:,} edges dropped "
              f"({removed / len(kept) * 100:.1f}% of edges, "
              f"{dropped_value / full_value * 100:.2f}% of advertised "
              f"liquidity), {int(cdf.total):,} left. Every figure below is a "
              f"share of those.")
    print(f"Bucket liquidity split: general {cfg['general_pct']}%, "
          f"congestion {cfg['congestion_pct']}%, "
          f"protected {100 - cfg['general_pct'] - cfg['congestion_pct']}% "
          f"(protected takes the remainder).")
    if cfg["slot_mode"] == "fixed":
        print(f"Bucket slots: general {cfg['general_slots']}, "
              f"congestion {cfg['congestion_slots']}, "
              f"protected the remainder (fixed counts, not scaled by channel size).")
    else:
        print(f"Bucket slots: general {cfg['general_slot_pct']}%, "
              f"congestion {cfg['congestion_slot_pct']}%, "
              f"protected "
              f"{100 - cfg['general_slot_pct'] - cfg['congestion_slot_pct']}% "
              f"of max_accepted_htlcs (protected takes the remainder).")
    print(f"Per-peer general allocation: max({cfg['min_slots']}, "
          f"{cfg['alloc_pct']}% of general slots).")
    print()

    print_metrics_table(metrics)
    if cfg["slot_mode"] == "fixed":
        print_bucket_distribution_table(metrics, cdf, cfg["prices"],
                                        cfg["thresholds"])
    else:
        print_distribution_table("general", metrics, cdf,
                                 cfg["prices"], cfg["thresholds"])
        print_distribution_table("congestion", metrics, cdf,
                                 cfg["prices"], cfg["thresholds"])

    print_percentile_table(full_cdf, cfg, metrics)

    if cfg["routability"]:
        print_routability_table(graph, full_cdf, cfg, metrics)

    if csv_path:
        _write_csv(csv_path, metrics, cdf, cfg)
    return 0


def _write_csv(csv_path, metrics, cdf, cfg):
    rows = []
    for bucket, frac_key in (("general_slot", "general_slot_frac"),
                             ("general", "peer_general_frac"),
                             ("congestion", "congestion_slot_frac")):
        for m in metrics:
            frac = m[frac_key]
            for t in sorted(cfg["thresholds"]):
                for p in sorted(cfg["prices"]):
                    req = required_base_sat(t, p, frac)
                    rows.append({
                        "bucket": bucket,
                        "max_accepted_htlcs": m["n"],
                        "threshold_usd": t,
                        "price_usd": p,
                        "required_max_htlc_sat":
                            "" if req == math.inf else math.ceil(req),
                        "share": round(share_at_or_above(cdf, req), 6),
                    })
    with open(csv_path, "w", newline="") as fh:
        writer = csvmod.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows):,} rows to {csv_path}")


# --------------------------------------------------------------------------
# Self-test: verify the ported math against the page's published defaults.
# --------------------------------------------------------------------------

def self_test():
    # Percentage slots (the default) reproduce the page's 193/96/194 columns.
    assert bucket_slots_pct(483, 40, 20) == {"general": 193, "congestion": 96,
                                             "protected": 194}
    assert bucket_slots_pct(114, 40, 20) == {"general": 45, "congestion": 22,
                                             "protected": 47}
    assert bucket_slots_pct(50, 40, 20) == {"general": 20, "congestion": 10,
                                            "protected": 20}
    # Fixed 30/10 slots: only protected varies with channel size.
    assert bucket_slots_fixed(483, 30, 10) == {"general": 30, "congestion": 10,
                                               "protected": 443}
    assert bucket_slots_fixed(114, 30, 10) == {"general": 30, "congestion": 10,
                                               "protected": 74}
    assert bucket_slots_fixed(40, 30, 10) == {"general": 30, "congestion": 10,
                                              "protected": 0}
    # slots_fit_type is the guard callers apply before bucket_slots_fixed.
    assert slots_fit_type(50, 30, 10)
    assert slots_fit_type(40, 30, 10)
    assert not slots_fit_type(39, 30, 10)
    assert not slots_fit_type(20, 30, 10)
    # The cfg dispatcher picks the mode.
    pct_cfg = {"slot_mode": "pct", "general_slot_pct": 40,
               "congestion_slot_pct": 20, "general_slots": 30,
               "congestion_slots": 10}
    assert bucket_slots(483, pct_cfg)["general"] == 193
    assert bucket_slots(483, {**pct_cfg, "slot_mode": "fixed"})["general"] == 30
    # Per-peer allocation.
    assert per_peer_slots(193, 5, 5) == 9
    assert per_peer_slots(45, 5, 5) == 5
    assert per_peer_slots(30, 5, 5) == 5                  # floor beats 5% of 30
    assert per_peer_slots(4, 5, 5) == 4
    # Bucket fractions (largest single HTLC as % of max_htlc).
    assert abs(peer_general_frac(40, 193, 9) - 0.018653) < 1e-6      # 1.87%
    assert abs(congestion_slot_frac(20, 96) - 0.0020833) < 1e-6      # 0.21%
    assert abs(general_slot_frac(40, 30) - 0.0133333) < 1e-6         # 1.33%
    assert abs(peer_general_frac(40, 30, 5) - 0.0666667) < 1e-6      # 6.67%
    assert abs(congestion_slot_frac(20, 10) - 0.02) < 1e-9           # 2.00%
    # CDF share.
    cdf = make_cdf([(100, 3), (200, 5), (300, 2)])
    assert cdf[2] == 10                                              # total
    assert share_at_or_above(cdf, 200) == 0.7                       # 7 of 10
    assert share_at_or_above(cdf, 250) == 0.2                       # 2 of 10
    assert share_at_or_above(cdf, math.inf) == 0.0
    # The graph filter drops whole entries; the survivors renormalise.
    fhist = [(100, 1), (200, 2), (400, 1)]
    assert filter_hist(fhist, 0) is fhist
    assert filter_hist(fhist, -1) is fhist
    assert filter_hist(fhist, 100) == fhist                # inclusive
    assert filter_hist(fhist, 200) == [(200, 2), (400, 1)]
    assert filter_hist(fhist, 401) == []
    assert make_cdf(filter_hist(fhist, 200)).total == 3
    # Edges and liquidity move differently: a floor at 200 drops 1 of 4 edges
    # but only 100 of 900 sat, because the dropped edge is the smallest.
    assert hist_value_total(fhist) == 900
    assert hist_value_total([]) == 0
    assert hist_value_total(filter_hist(fhist, 200)) == 800
    assert abs(share_at_or_above(make_cdf(filter_hist(fhist, 200)), 400)
               - 1 / 3) < 1e-12
    # Nearest-rank percentiles over 100 100 100 200 200 200 200 200 300 300.
    pcdf = make_cdf([(100, 3), (200, 5), (300, 2)])
    assert percentile_sat(pcdf, 0) == 100
    assert percentile_sat(pcdf, 30) == 100
    assert percentile_sat(pcdf, 31) == 200
    assert percentile_sat(pcdf, 80) == 200
    assert percentile_sat(pcdf, 81) == 300
    assert percentile_sat(pcdf, 100) == 300
    assert math.isnan(percentile_sat(make_cdf([]), 50))
    # Ordinal row labels match app.js's fmtPctile.
    assert _fmt_pctile(10) == "10th percentile"
    assert _fmt_pctile(1) == "1st percentile"
    assert _fmt_pctile(2) == "2nd percentile"
    assert _fmt_pctile(3) == "3rd percentile"
    assert _fmt_pctile(11) == "11th percentile"
    assert _fmt_pctile(21) == "21st percentile"
    assert _fmt_pctile(99.5) == "99.5th percentile"
    # Conversions round trip.
    assert abs(sat_to_usd(20_000, 50_000) - 10) < 1e-9
    assert abs(sat_to_usd(usd_to_sat(37, 75_000), 75_000) - 37) < 1e-9
    # Saturation is deterministic (seeded) and in the coupon-collector range.
    sat = channels_to_saturate(193, 9, trials=200)
    assert 100 < sat < 160, sat
    sat = channels_to_saturate(30, 5, trials=200)
    assert 21 < sat < 25, sat

    # --- routing, against the same fixture build_data.py uses. Its routable
    # subset is A->B, B->A, A->C, A->D, D->A, D->C: C->A and E->A never
    # gossiped a policy, C->D is disabled, and E is in no routable direction.
    from build_data import FIXTURE
    g, _ = parse_routing_graph(FIXTURE)
    rev = reverse_graph(g)
    assert rev["n"] == 4 and len(rev["from"]) == 6
    assert rev["off"][rev["n"]] == 6, rev["off"]
    # A (0) is reached from B (1) and D (3); nothing reaches E, which is absent.
    assert sorted(rev["from"][rev["off"][0]:rev["off"][1]]) == [1, 3]

    # B pays C for 500 sat: B->A advertises 2000 and A->C 1500, so it clears
    # unrestricted but not once a tenth of each forwarded hop is all that is
    # available (A->C would need 5000).
    amt, hops = route_costs(rev, 2, 500, 1.0, 0)
    ok, out_hops = source_results(g, 2, amt, hops, 0)
    assert ok[1] and out_hops[1] == 2, (ok, out_hops)
    amt, hops = route_costs(rev, 2, 500, 0.1, 0)
    assert not source_results(g, 2, amt, hops, 0)[0][1]
    # A itself is a direct peer of C, so no hop is constrained and it clears
    # either way -- the sender forwards nothing.
    assert source_results(g, 2, amt, hops, 0)[0][0]

    # Fees accumulate towards the sender: A->B charges 1000 msat + 100 ppm, so
    # delivering 1000 sat to B needs A to send 1001.1.
    amt, _ = route_costs(reverse_graph(g), 1, 1000, 1.0, 0)
    assert abs(amt[0] - 1001.1) < 1e-9, amt[0]

    # min_htlc keeps a direction out of a payment it will not accept: A->B
    # sets a 2 sat floor, so B cannot be paid 1 sat over it at all.
    amt, hops = route_costs(rev, 1, 1, 1.0, 0)
    assert amt[0] == float("inf"), amt[0]
    # A hop's time lock costs the sender as well as its fee: A->B asks for 144
    # blocks, which is 1000 * 144 * 15 / 1e6 msat on top of the 1100 msat fee.
    assert abs(hop_weight(1000, 100, 144, 1000) - (1100 + 2.16)) < 1e-9
    assert hop_admits(1000, 0, 1000, 1, 0) and not hop_admits(1000, 0, 1001, 1, 0)
    assert not hop_admits(1000, 500, 400, 1, 0)   # under min_htlc
    assert not hop_admits(1000, 0, 500, 0.1, 0)   # over the bucket's share
    assert not hop_admits(1000, 0, 10, 1, 5000)   # under the page's filter

    # Which view decides what a node is eligible for: C has no outbound
    # direction at all, so it can be paid but can never send.
    assert eligible_nodes(g, 0) == [0, 1, 3], eligible_nodes(g, 0)
    assert eligible_nodes(rev, 0) == [0, 1, 2, 3]
    # A floor above a node's every channel takes it out of the sample.
    assert eligible_nodes(g, 2500) == [0, 3], eligible_nodes(g, 2500)

    # The sample is seeded, drawn without replacement, and a node's place in it
    # does not depend on which other nodes are eligible -- so shrinking the
    # pool slides the sample rather than redrawing it.
    pool = list(range(200))
    pick = sample_nodes(pool, 20, 7)
    assert len(pick) == 20 and len(set(pick)) == 20
    assert pick == sample_nodes(pool, 20, 7)
    assert pick != sample_nodes(pool, 20, 8)
    shrunk = sample_nodes([u for u in pool if u < 100], 20, 7)
    assert all(u in shrunk for u in pick if u < 100)
    assert sample_nodes([1, 2, 3], 20, 7) == [1, 2, 3]

    # Channels band by what they advertise, ties falling to the lower band.
    assert band_index(25, [25, 80]) == 0 and band_index(26, [25, 80]) == 1
    assert band_index(9000, [25, 80]) == 2
    # The fixture's six routable directions advertise 1500, 1500, 3960000,
    # 2000, 3000 and 800 sat.
    assert band_channel_counts(g, 0, [1500, 3000]) == [3, 2, 1]
    assert band_channel_counts(g, 1600, [1500, 3000]) == [0, 2, 1], \
        band_channel_counts(g, 1600, [1500, 3000])

    # Every channel with a path onwards is asked once, for what its far end
    # needs. Unrestricted they all clear; a tenth of each leaves only A->D,
    # which is four million sat wide.
    thresholds = [1500, 3000]
    acc = {"attempts": [0] * 3, "ok_base": [0] * 3, "demand": [0.0] * 3,
           "ok_bucket": [[0] * 3]}
    amt, hops = route_costs(rev, 2, 500, 1.0, 0)
    tally_bands(g, 2, amt, hops, [0.1], 0, thresholds, acc)
    assert acc["attempts"] == [3, 2, 1], acc["attempts"]
    assert acc["ok_base"] == [3, 2, 1], acc["ok_base"]
    assert acc["ok_bucket"][0] == [0, 0, 1], acc["ok_bucket"]
    # Band 0 holds A->B, A->C and D->C. A->C and D->C sit next to the
    # destination and are asked for the payment itself; A->B is asked for what
    # B needs, which is the payment plus B->A's 1 ppm on the way back.
    assert abs(acc["demand"][0] - (1500 + 0.0005)) < 1e-9, acc["demand"]
    assert acc["demand"][1:] == [1000.0, 500.0], acc["demand"]

    print("analyze_buckets.py self-test: OK")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "graph", nargs="?", default="mainnet.json",
        help="describegraph JSON (default: ./mainnet.json)")
    parser.add_argument("--csv", metavar="PATH", default=None,
                        help="dump per-cell shares to CSV")
    parser.add_argument("--self-test", action="store_true",
                        help="check the ported math and exit")
    parser.add_argument("--channel-types", type=int, nargs="+",
                        default=[483, 114, 50], metavar="N",
                        help="max_accepted_htlcs columns (default: 483 114 50)")
    parser.add_argument("--general-pct", type=float, default=40, metavar="P",
                        help="general bucket %% of liquidity (default: 40)")
    parser.add_argument("--congestion-pct", type=float, default=20, metavar="P",
                        help="congestion bucket %% of liquidity (default: 20)")
    parser.add_argument("--slot-mode", choices=("pct", "fixed"), default="fixed",
                        help="hard-set slot counts or split by percentage "
                             "(default: fixed)")
    parser.add_argument("--general-slot-pct", type=float, default=40, metavar="P",
                        help="general bucket %% of max_accepted_htlcs "
                             "(--slot-mode pct; default: 40)")
    parser.add_argument("--congestion-slot-pct", type=float, default=20, metavar="P",
                        help="congestion bucket %% of max_accepted_htlcs "
                             "(--slot-mode pct; default: 20)")
    parser.add_argument("--general-slots", type=int, default=30, metavar="N",
                        help="general bucket slot count "
                             "(--slot-mode fixed; default: 30)")
    parser.add_argument("--congestion-slots", type=int, default=10, metavar="N",
                        help="congestion bucket slot count "
                             "(--slot-mode fixed; default: 10)")
    parser.add_argument("--percentiles", type=float, nargs="+",
                        default=[10, 25, 50, 75, 90, 99], metavar="P",
                        help="max_htlc percentile rows (default: 10 25 50 75 90 99)")
    parser.add_argument("--current-price", type=float, default=75_000,
                        metavar="USD",
                        help="BTC price the percentile table reads in, matching "
                             "the page's Current price control (default: 75000)")
    parser.add_argument("--percentile-type", type=int, default=None, metavar="N",
                        help="channel type for the percentile table "
                             "(default: the largest --channel-types entry)")
    parser.add_argument("--min-max-htlc", type=int,
                        default=DEFAULT_MIN_MAX_HTLC, metavar="SAT",
                        help="drop directions advertising less than this many "
                             "sats, as the page's Filtering section does "
                             "(default: %(default)s; 0 keeps the whole graph)")
    parser.add_argument("--min-slots", type=int, default=5, metavar="N",
                        help="per-peer general slot floor (default: 5)")
    parser.add_argument("--alloc-pct", type=float, default=5, metavar="P",
                        help="per-peer general slot %% (default: 5)")
    parser.add_argument("--prices", type=float, nargs="+",
                        default=[50_000, 75_000, 100_000], metavar="USD",
                        help="BTC prices (default: 50000 75000 100000)")
    parser.add_argument("--thresholds", type=float, nargs="+",
                        default=[1, 5, 10, 25, 50, 100, 250, 500], metavar="USD",
                        help="dollar thresholds (default: 1 5 10 25 50 100 250 500)")
    parser.add_argument("--saturation-trials", type=int, default=3000, metavar="N",
                        help="Monte-Carlo trials for saturation (default: 3000)")
    parser.add_argument("--payment-usd", type=float,
                        default=DEFAULT_PAYMENT_USD, metavar="USD",
                        help="payment size the routability table routes "
                             "(default: %(default)s)")
    parser.add_argument("--route-dests", type=int,
                        default=DEFAULT_ROUTE_DESTS, metavar="N",
                        help="destinations sampled; the page uses 150 "
                             "(default: %(default)s)")
    parser.add_argument("--route-senders", type=int,
                        default=DEFAULT_ROUTE_SENDERS, metavar="N",
                        help="senders sampled for the end-to-end row; the page "
                             "uses 400 (default: %(default)s)")
    parser.add_argument("--no-routability", action="store_true",
                        help="skip the routability table, which is the only "
                             "one that walks the graph")
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    if not os.path.exists(args.graph):
        parser.error(f"graph file not found: {args.graph}")

    # Fixed counts that don't fit a selected channel type are an error, not
    # something to clamp — the page refuses the same combination.
    if args.slot_mode == "fixed":
        total = args.general_slots + args.congestion_slots
        offenders = sorted(n for n in args.channel_types
                           if not slots_fit_type(n, args.general_slots,
                                                 args.congestion_slots))
        if offenders:
            parser.error(
                f"general + congestion = {total} slots, more than channel "
                f"type{'s' if len(offenders) > 1 else ''} "
                f"{', '.join(str(n) for n in offenders)} can hold; lower the "
                f"counts or drop {'those types' if len(offenders) > 1 else 'that type'}")

    if args.min_max_htlc < 0:
        parser.error("--min-max-htlc must be >= 0")

    percentile_type = args.percentile_type
    if percentile_type is None:
        percentile_type = max(args.channel_types)
    elif percentile_type not in args.channel_types:
        parser.error(f"--percentile-type {percentile_type} is not one of "
                     f"--channel-types {args.channel_types}")

    cfg = {
        "channel_types": args.channel_types,
        "percentile_type": percentile_type,
        "percentiles": args.percentiles,
        "current_price": args.current_price,
        "min_max_htlc": args.min_max_htlc,
        "general_pct": args.general_pct,
        "congestion_pct": args.congestion_pct,
        "slot_mode": args.slot_mode,
        "general_slot_pct": args.general_slot_pct,
        "congestion_slot_pct": args.congestion_slot_pct,
        "general_slots": args.general_slots,
        "congestion_slots": args.congestion_slots,
        "min_slots": args.min_slots,
        "alloc_pct": args.alloc_pct,
        "prices": args.prices,
        "thresholds": args.thresholds,
        "trials": args.saturation_trials,
        "payment_usd": args.payment_usd,
        "route_dests": args.route_dests,
        "route_senders": args.route_senders,
        "routability": not args.no_routability,
    }

    with open(args.graph) as fh:
        graph = json.load(fh)

    return analyze(graph, cfg, args.graph, csv_path=args.csv)


if __name__ == "__main__":
    sys.exit(main())
