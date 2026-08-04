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
  3. The channel percentile table: the inverse question — what the edge at a
     given max_htlc percentile can actually forward, in dollars, through one
     general slot, a peer's whole general allocation, or a congestion slot.
  4. General-bucket routability: the share of payment flow that clears the
     general bucket with no reputation, per hop and composed over a route.

Base value `B` per direction is the advertised `max_htlc_msat` (the observable
lower bound on `max_htlc_value_in_flight_msat`), kept only when the advertising
node forwards on more than one channel — identical to the page's data set.

See PR: https://github.com/lightning/bolts/pull/1280
"""

import argparse
import bisect
import csv as csvmod
import json
import math
import os
import sys
from collections import Counter, namedtuple

from build_data import (parse_graph, sample_routes, DEFAULT_SOURCES,
                        DEFAULT_PER_SOURCE, DEFAULT_SEED)

# --------------------------------------------------------------------------
# Units.
# --------------------------------------------------------------------------

SAT_PER_BTC = 100_000_000
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

Cdf = namedtuple("Cdf", "sats suffix total value_suffix value_total")


def make_cdf(hist):
    """hist: list of (sat, count) ascending.

    suffix[i]       = number of edges with value >= sats[i]
    value_suffix[i] = their summed max_htlc, for weighting an edge by the size
                      it advertises rather than one-edge-one-vote.
    """
    sats = [s for s, _ in hist]
    n = len(hist)
    suffix = [0] * (n + 1)
    value_suffix = [0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix[i] = suffix[i + 1] + hist[i][1]
        value_suffix[i] = value_suffix[i + 1] + hist[i][0] * hist[i][1]
    return Cdf(sats, suffix, (suffix[0] if n else 0), value_suffix,
               (value_suffix[0] if n else 0))


def share_at_or_above(cdf, required_sat):
    """Share of edges (0..1) whose value is >= required_sat."""
    if cdf.total == 0 or required_sat == math.inf:
        return 0.0
    lo = bisect.bisect_left(cdf.sats, required_sat)
    return cdf.suffix[lo] / cdf.total


def value_share_at_or_above(cdf, required_sat):
    """Share of total advertised max_htlc (0..1) sitting on edges >= required."""
    if cdf.value_total <= 0 or required_sat == math.inf:
        return 0.0
    lo = bisect.bisect_left(cdf.sats, required_sat)
    return cdf.value_suffix[lo] / cdf.value_total


def per_hop_routability(cdf, sat, frac, weighting):
    """Share of the flow one hop's general bucket admits at payment `sat`."""
    if not (frac > 0):
        return 0.0
    required = sat / frac
    return (share_at_or_above(cdf, required) if weighting == "count"
            else value_share_at_or_above(cdf, required))


def route_routability(route_cdf, sat, frac):
    """Share of sampled routes whose bottleneck clears a payment of `sat`.

    A route clears when every channel a general bucket applies to clears, and
    the allocation is the same fraction `frac` of each channel's max_htlc, so
    the test collapses to bottleneck >= sat / frac. Routes count once each.
    """
    if route_cdf is None or not (frac > 0):
        return 0.0
    return share_at_or_above(route_cdf, sat / frac)


def make_route_cdfs(route_hist):
    """{hops: Counter({bottleneck_sat: routes})} -> {hops: Cdf}."""
    return {h: make_cdf(sorted(counts.items()))
            for h, counts in route_hist.items()}


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


# --------------------------------------------------------------------------
# Per-channel-type metrics (mirrors app.js typeMetrics / METRIC_ROWS).
# --------------------------------------------------------------------------

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


def print_distribution_table(bucket, metrics, cdf, prices, thresholds, col=9):
    frac_key = "peer_general_frac" if bucket == "general" else "congestion_slot_frac"
    where = ("per-peer liquidity allocation, k slots' worth"
             if bucket == "general" else "one slot's worth of liquidity")
    prices = sorted(prices)
    thresholds = sorted(thresholds)

    print("-" * 78)
    print(f"Distribution — {bucket} bucket ({where})")
    print("Share of mainnet directed edges able to carry a single HTLC of >= $X.")
    print("-" * 78)

    # Type group header, then per-price sub-header.
    group = " " * 12
    for m in metrics:
        group += f"{fmt_int(m['n']) + ' slots':^{col * len(prices)}}"
    print(group)
    sub = f"{'Threshold':<12}"
    for _ in metrics:
        for p in prices:
            sub += f"{'@$' + _compact_usd(p):>{col}}"
    print(sub)

    for t in thresholds:
        row = f"{'>= $' + _compact_usd(t):<12}"
        for m in metrics:
            frac = m[frac_key]
            for p in prices:
                if not (frac > 0):
                    row += f"{'n/a':>{col}}"
                else:
                    req = required_base_sat(t, p, frac)
                    share = share_at_or_above(cdf, req)
                    row += f"{share * 100:>{col - 1}.1f}%"
        print(row)
    print()


# --------------------------------------------------------------------------
# Channel percentile table (mirrors app.js renderPercentiles): the inverse
# question to the distribution table — instead of "what share of edges clear
# $X", it asks what the edge at percentile P can actually forward.
#
# Slots are fixed counts, so the three limits below don't depend on the
# channel type; they hold for any channel with at least general + congestion
# slots.
# --------------------------------------------------------------------------

PCT_COLUMNS = [
    ("One general slot", "general_slot_frac"),
    ("All general slots", "peer_general_frac"),
    ("Congestion slot", "congestion_slot_frac"),
]


def _fmt_usd_cents(x):
    # floor(x + 0.5) matches JS Math.round, so the page and this table agree
    # to the cent (see fmtUsdCents in app.js).
    return f"${math.floor(x * 100 + 0.5) / 100:,.2f}"


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


def print_percentile_table(cdf, cfg, metrics, col=20, label_col=18):
    # One channel type at a time: under percentage slots the three limits scale
    # with max_accepted_htlcs, so there is no single answer across types.
    # Reuses the already-computed metrics so saturation isn't simulated twice.
    n = cfg["percentile_type"]
    m = next(x for x in metrics if x["n"] == n)
    price = cfg["percentile_price"]

    print("-" * 78)
    print(f"Channel percentiles — {n}-slot channels")
    print("Largest single HTLC each bucket admits for the edge at a given max_htlc")
    print(f"percentile, in USD at ${price:,.0f}/BTC. 'All general slots' is one "
          f"peer's")
    print(f"allocation of k = {m['k']} of the {m['slots']['general']} general slots.")
    print("-" * 78)

    head = f"  {'':<{label_col}}" + "".join(f"{label:>{col}}"
                                            for label, _ in PCT_COLUMNS)
    print(head)
    for p in cfg["percentiles"]:
        base = percentile_sat(cdf, p)
        row = f"  {_fmt_pctile(p):<{label_col}}"
        for _, key in PCT_COLUMNS:
            frac = m[key]
            if not (frac > 0) or not math.isfinite(base):
                row += f"{'n/a':>{col}}"
            else:
                row += f"{_fmt_usd_cents(sat_to_usd(base * frac, price)):>{col}}"
        print(row)
    print()


# --------------------------------------------------------------------------
# General-bucket routability (mirrors routability.js).
#
# What share of payments keeps flowing through the general bucket with no
# reputation? Measured over routes sampled from the real graph at build time,
# indexed by how many nodes forward on them: A->B->C is one hop, a direct
# payment is none. Each route is reduced to its bottleneck — the smallest
# max_htlc among the channels a general bucket applies to, which excludes the
# sender's own first channel.
# --------------------------------------------------------------------------

ROUTE_HOPS = [1, 2, 3, 4, 5, 6]


def print_routability_table(route_cdfs, cfg, metrics, col=9):
    n = cfg["percentile_type"]
    m = next(x for x in metrics if x["n"] == n)
    price = cfg["percentile_price"]
    frac = m["peer_general_frac"]
    hops = [h for h in ROUTE_HOPS if h in route_cdfs]

    print("-" * 78)
    print(f"General-bucket routability — {n}-slot channels")
    print("Share of sampled routes clearing the general bucket with no")
    print(f"reputation (k = {m['k']} of {m['slots']['general']} general slots).")
    print("A hop is a forwarding node, so each column is its own sample of")
    print("node pairs and the columns are not nested.")
    print("-" * 78)

    if not hops:
        print("  no sampled routes in this dataset\n")
        return

    print("  " + f"{'Payment':<12}" + "".join(
        f"{str(h) + (' hop' if h == 1 else ' hops'):>{col}}" for h in hops))
    for usd in cfg["payments"]:
        sat = usd_to_sat(usd, price)
        row = f"  {'$' + _compact_usd(usd):<12}"
        for h in hops:
            row += f"{route_routability(route_cdfs[h], sat, frac) * 100:>{col - 1}.1f}%"
        print(row)
    print("  " + f"{'routes':<12}" + "".join(
        f"{route_cdfs[h].total:>{col},.0f}" for h in hops))
    print()


# --------------------------------------------------------------------------
# Main analysis.
# --------------------------------------------------------------------------

def analyze(graph, cfg, source, csv_path=None):
    kept, adjacency, stats = parse_graph(graph)
    if not kept:
        print("no usable directed policies found", file=sys.stderr)
        return 1

    hist = sorted(Counter(kept).items())
    cdf = make_cdf(hist)
    route_hist, route_stats = sample_routes(
        adjacency, cfg["route_sources"], cfg["route_per_source"],
        cfg["route_seed"])
    route_cdfs = make_route_cdfs(route_hist)

    metrics = [type_metrics(n, cfg)
               for n in sorted(cfg["channel_types"], reverse=True)]

    print("=" * 78)
    print("BOLT #1280 local resource conservation — mainnet bucket analysis")
    print("=" * 78)
    print(f"Data: {os.path.basename(source)} — {len(kept):,} directed edges kept, "
          f"{stats['dropped']:,} dropped (single-channel node), "
          f"{stats['imputed']:,} with max_htlc imputed from capacity.")
    print(f"Routes: {route_stats['sampled']:,} sampled from "
          f"{cfg['route_sources']:,} sources (seed {cfg['route_seed']}).")
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
    print_distribution_table("general", metrics, cdf,
                             cfg["prices"], cfg["thresholds"])
    print_distribution_table("congestion", metrics, cdf,
                             cfg["prices"], cfg["thresholds"])
    print_percentile_table(cdf, cfg, metrics)
    print_routability_table(route_cdfs, cfg, metrics)

    if csv_path:
        _write_csv(csv_path, metrics, cdf, cfg)
    return 0


def _write_csv(csv_path, metrics, cdf, cfg):
    rows = []
    for bucket, frac_key in (("general", "peer_general_frac"),
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
    # Nearest-rank percentiles over 100 100 100 200 200 200 200 200 300 300.
    assert percentile_sat(cdf, 0) == 100
    assert percentile_sat(cdf, 30) == 100
    assert percentile_sat(cdf, 31) == 200
    assert percentile_sat(cdf, 50) == 200
    assert percentile_sat(cdf, 80) == 200
    assert percentile_sat(cdf, 81) == 300
    assert percentile_sat(cdf, 100) == 300
    assert math.isnan(percentile_sat(make_cdf([]), 50))
    # Liquidity weighting over 3x100 + 5x200 + 2x300 = 1,900 sat of max_htlc.
    assert cdf.value_total == 1900
    assert value_share_at_or_above(cdf, 1) == 1.0
    assert abs(value_share_at_or_above(cdf, 200) - 1600 / 1900) < 1e-12
    assert abs(value_share_at_or_above(cdf, 250) - 600 / 1900) < 1e-12
    assert value_share_at_or_above(cdf, 301) == 0.0
    assert value_share_at_or_above(make_cdf([]), 100) == 0.0
    # Weighting big edges up never lowers the share when the qualifying set is
    # the largest edges.
    for t in (1, 100, 150, 200, 250, 300):
        assert value_share_at_or_above(cdf, t) >= share_at_or_above(cdf, t) - 1e-12
    # Routability: frac 0.5 means a 100-sat payment needs a 200-sat edge.
    assert per_hop_routability(cdf, 100, 0.5, "count") == 0.7
    assert abs(per_hop_routability(cdf, 100, 0.5, "value") - 1600 / 1900) < 1e-12
    assert per_hop_routability(cdf, 100, 0, "count") == 0.0
    # Route bottlenecks, not per-channel values. Mirrors math.test.js: at
    # frac 0.5 a 100-sat payment needs a 200-sat bottleneck.
    route_cdfs = make_route_cdfs({
        1: Counter({100: 2, 200: 5, 400: 3}),
        3: Counter({100: 6, 200: 3, 400: 1}),
    })
    assert abs(route_routability(route_cdfs[1], 100, 0.5) - 0.8) < 1e-12
    assert abs(route_routability(route_cdfs[3], 100, 0.5) - 0.4) < 1e-12
    assert route_routability(route_cdfs[1], 100, 0) == 0.0
    assert route_routability(None, 100, 0.5) == 0.0
    assert route_routability(route_cdfs[1], 1, 0.5) == 1.0
    assert route_routability(route_cdfs[1], 10**9, 0.5) == 0.0
    assert make_route_cdfs({}) == {}
    # Ordinal row labels match app.js's fmtPctile.
    assert _fmt_pctile(10) == "10th percentile"
    assert _fmt_pctile(1) == "1st percentile"
    assert _fmt_pctile(2) == "2nd percentile"
    assert _fmt_pctile(3) == "3rd percentile"
    assert _fmt_pctile(11) == "11th percentile"
    assert _fmt_pctile(21) == "21st percentile"
    assert _fmt_pctile(99) == "99th percentile"
    assert _fmt_pctile(99.5) == "99.5th percentile"
    # Conversions round trip.
    assert abs(sat_to_usd(20_000, 50_000) - 10) < 1e-9
    assert abs(sat_to_usd(usd_to_sat(37, 75_000), 75_000) - 37) < 1e-9
    # Saturation is deterministic (seeded) and in the coupon-collector range.
    sat = channels_to_saturate(193, 9, trials=200)
    assert 100 < sat < 160, sat
    sat = channels_to_saturate(30, 5, trials=200)
    assert 21 < sat < 25, sat
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
    parser.add_argument("--percentiles", type=float, nargs="+",
                        default=[10, 25, 50, 75, 90, 99], metavar="P",
                        help="max_htlc percentile rows (default: 10 25 50 75 90 99)")
    parser.add_argument("--percentile-price", type=float, default=75_000,
                        metavar="USD",
                        help="BTC price for the percentile table (default: 75000)")
    parser.add_argument("--percentile-type", type=int, default=None, metavar="N",
                        help="channel type for the percentile and routability "
                             "tables (default: the largest --channel-types entry)")
    parser.add_argument("--payments", type=float, nargs="+",
                        default=[0.1, 1, 5, 10, 50, 100, 500, 1000, 10000],
                        metavar="USD",
                        help="payment sizes for the routability table "
                             "(default: 0.1 1 5 10 50 100 500 1000 10000)")
    parser.add_argument("--saturation-trials", type=int, default=3000, metavar="N",
                        help="Monte-Carlo trials for saturation (default: 3000)")
    parser.add_argument("--route-sources", type=int, default=DEFAULT_SOURCES,
                        metavar="N",
                        help="route-sample source nodes (default: %(default)s)")
    parser.add_argument("--route-per-source", type=int,
                        default=DEFAULT_PER_SOURCE, metavar="N",
                        help="destinations per source (default: %(default)s)")
    parser.add_argument("--route-seed", type=int, default=DEFAULT_SEED,
                        metavar="N",
                        help="route sampling seed (default: %(default)s)")
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

    percentile_type = args.percentile_type
    if percentile_type is None:
        percentile_type = max(args.channel_types)
    elif percentile_type not in args.channel_types:
        parser.error(f"--percentile-type {percentile_type} is not one of "
                     f"--channel-types {args.channel_types}")

    cfg = {
        "channel_types": args.channel_types,
        "general_pct": args.general_pct,
        "congestion_pct": args.congestion_pct,
        "slot_mode": args.slot_mode,
        "general_slot_pct": args.general_slot_pct,
        "congestion_slot_pct": args.congestion_slot_pct,
        "general_slots": args.general_slots,
        "congestion_slots": args.congestion_slots,
        "percentile_type": percentile_type,
        "min_slots": args.min_slots,
        "alloc_pct": args.alloc_pct,
        "prices": args.prices,
        "thresholds": args.thresholds,
        "percentiles": args.percentiles,
        "percentile_price": args.percentile_price,
        "payments": args.payments,
        "trials": args.saturation_trials,
        "route_sources": args.route_sources,
        "route_per_source": args.route_per_source,
        "route_seed": args.route_seed,
    }

    with open(args.graph) as fh:
        graph = json.load(fh)

    return analyze(graph, cfg, args.graph, csv_path=args.csv)


if __name__ == "__main__":
    sys.exit(main())
