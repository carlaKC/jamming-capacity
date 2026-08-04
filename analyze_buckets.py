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

from build_data import parse_graph

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
    if not hist:
        print(f"--min-max-htlc {cfg['min_max_htlc']} filtered out every edge",
              file=sys.stderr)
        return 1

    metrics = [type_metrics(n, cfg)
               for n in sorted(cfg["channel_types"], reverse=True)]

    print("=" * 78)
    print("BOLT #1280 local resource conservation — mainnet bucket analysis")
    print("=" * 78)
    print(f"Data: {os.path.basename(source)} — {len(kept):,} directed edges kept, "
          f"{stats['dropped']:,} dropped (single-channel node), "
          f"{stats['imputed']:,} with max_htlc imputed from capacity.")
    if cfg["min_max_htlc"] > 0:
        removed = len(kept) - int(cdf.total)
        full_value = hist_value_total(full_hist)
        kept_value = hist_value_total(hist)
        dropped_value = full_value - kept_value
        print(f"Graph filter: max_htlc >= {cfg['min_max_htlc']:,} sat — "
              f"{removed:,} more edges dropped "
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

    cfg = {
        "channel_types": args.channel_types,
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
    }

    with open(args.graph) as fh:
        graph = json.load(fh)

    return analyze(graph, cfg, args.graph, csv_path=args.csv)


if __name__ == "__main__":
    sys.exit(main())
