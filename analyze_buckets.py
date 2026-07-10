#!/usr/bin/env python3
"""Analyze BOLT #1280 local resource conservation buckets against a mainnet graph.

Reads a `lncli describegraph` JSON dump and, for every directed channel policy
that advertises `max_htlc_msat`, works out how the proposed general / congestion
/ protected buckets would look, and whether an average ~$10 payment fits.

See PR: https://github.com/lightning/bolts/pull/1280
Design: ~/Work/daybook/plans/2026-07-08-bolt1280-bucket-analysis-design.md
"""

import argparse
import csv as csvmod
import json
import math
import os
import sys
from collections import defaultdict

# --------------------------------------------------------------------------
# Protocol constants (from BOLT #1280 recommended defaults + BOLT 2 hard cap).
# --------------------------------------------------------------------------

# BOLT 2 hard cap on max_accepted_htlcs per party. Verified in LND:
#   config.go            defaultRemoteMaxHtlcs = 483
#   input/size.go        MaxHTLCNumber = 966  (both parties; /2 = 483 per party)
#   reputation/config.go protocolMaxAcceptedHTLCs = 483
MAX_ACCEPTED_HTLCS = 483

# Bucket split as fractions of slots (max_accepted_htlcs) and liquidity.
GENERAL_FRAC = 0.40
CONGESTION_FRAC = 0.20
PROTECTED_FRAC = 0.40

# Slot counts are network-wide constants (they only depend on 483).
GENERAL_SLOTS = round(GENERAL_FRAC * MAX_ACCEPTED_HTLCS)      # 193
CONGESTION_SLOTS = round(CONGESTION_FRAC * MAX_ACCEPTED_HTLCS)  # 97
PROTECTED_SLOTS = round(PROTECTED_FRAC * MAX_ACCEPTED_HTLCS)   # 193

# Per-peer general-bucket allocation (PR formulas).
#   general_bucket_slot_allocation = max(5, general_bucket_slot_total * 5/100)
GENERAL_SLOT_ALLOCATION = max(5, GENERAL_SLOTS * 5 // 100)     # 9

def set_bucket_params(n=None, general_frac=None, congestion_frac=None):
    """Recompute constants for a different max_accepted_htlcs / bucket split.

    Protected absorbs the remainder so the three fractions always sum to 1.
    """
    global MAX_ACCEPTED_HTLCS, GENERAL_FRAC, CONGESTION_FRAC, PROTECTED_FRAC
    global GENERAL_SLOTS, CONGESTION_SLOTS, PROTECTED_SLOTS
    global GENERAL_SLOT_ALLOCATION
    if n is not None:
        MAX_ACCEPTED_HTLCS = n
    if general_frac is not None:
        GENERAL_FRAC = general_frac
    if congestion_frac is not None:
        CONGESTION_FRAC = congestion_frac
    PROTECTED_FRAC = 1.0 - GENERAL_FRAC - CONGESTION_FRAC
    assert PROTECTED_FRAC >= 0, "general + congestion fractions exceed 1"
    GENERAL_SLOTS = round(GENERAL_FRAC * MAX_ACCEPTED_HTLCS)
    CONGESTION_SLOTS = round(CONGESTION_FRAC * MAX_ACCEPTED_HTLCS)
    PROTECTED_SLOTS = round(PROTECTED_FRAC * MAX_ACCEPTED_HTLCS)
    GENERAL_SLOT_ALLOCATION = max(5, GENERAL_SLOTS * 5 // 100)


# Analysis inputs.
PAYMENT_USD = 10.0
PRICES_USD = [50_000, 75_000, 100_000]
SAT_PER_BTC = 100_000_000
MSAT_PER_SAT = 1_000


# --------------------------------------------------------------------------
# Pure bucket math (base `B` is the direction's max_htlc_msat, in msat).
# --------------------------------------------------------------------------

def htlc_msat_for_price(price_usd):
    """msat value of a PAYMENT_USD payment at the given BTC price."""
    btc = PAYMENT_USD / price_usd
    sat = btc * SAT_PER_BTC
    return sat * MSAT_PER_SAT


def congestion_threshold_msat(base_msat):
    """Largest single HTLC the congestion bucket will admit.

    Rule 5 of the PR: amount_msat < bucket_capacity_msat / bucket_slots.
    The 20% liquidity / 20% slot fractions nearly cancel, so this is ~= B/483.
    """
    return (CONGESTION_FRAC * base_msat) / CONGESTION_SLOTS


def congestion_fits(base_msat, htlc_msat):
    return htlc_msat < congestion_threshold_msat(base_msat)


def general_liquidity_msat(base_msat):
    return GENERAL_FRAC * base_msat


def general_peer_liquidity_allocation_msat(base_msat):
    """Per-peer share of the general bucket's liquidity (PR formula)."""
    return general_liquidity_msat(base_msat) * GENERAL_SLOT_ALLOCATION / GENERAL_SLOTS


def general_peer_htlc_count(base_msat, htlc_msat):
    """How many average HTLCs one peer fits in the general bucket.

    One slot per HTLC, capped at GENERAL_SLOT_ALLOCATION slots; liquidity
    "overflows" only up to the per-peer liquidity allocation.
    """
    liq = general_peer_liquidity_allocation_msat(base_msat)
    by_liquidity = int(liq // htlc_msat)
    return min(GENERAL_SLOT_ALLOCATION, by_liquidity)


def general_wholebucket_htlc_count(base_msat, htlc_msat):
    """Whole-bucket count (ignoring per-peer allocation), for context."""
    by_liquidity = int(general_liquidity_msat(base_msat) // htlc_msat)
    return min(GENERAL_SLOTS, by_liquidity)


# --------------------------------------------------------------------------
# Data loading.
# --------------------------------------------------------------------------

def iter_directed_bases(graph):
    """Yield (channel_id, direction, capacity_sat, base_msat) per directed policy.

    A direction is included only if it advertises max_htlc_msat > 0. Directions
    without a policy (or with max_htlc_msat == 0) are skipped by the caller's
    counting; here we yield None base for them so callers can tally "ignored".
    """
    for edge in graph.get("edges", []):
        chan_id = edge.get("channel_id")
        try:
            capacity_sat = int(edge.get("capacity", 0))
        except (TypeError, ValueError):
            capacity_sat = 0
        for direction, key in ((1, "node1_policy"), (2, "node2_policy")):
            policy = edge.get(key)
            base = None
            if policy:
                raw = policy.get("max_htlc_msat")
                if raw is not None:
                    try:
                        val = int(raw)
                    except (TypeError, ValueError):
                        val = 0
                    if val > 0:
                        base = val
            yield chan_id, direction, capacity_sat, base


# --------------------------------------------------------------------------
# Stats helpers.
# --------------------------------------------------------------------------

def percentile(sorted_vals, p):
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * p / 100.0
    f = int(math.floor(k))
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def summarize(vals):
    """Return a dict of summary stats for a list of numbers."""
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    return {
        "n": n,
        "mean": sum(s) / n,
        "min": s[0],
        "p10": percentile(s, 10),
        "p25": percentile(s, 25),
        "p50": percentile(s, 50),
        "p75": percentile(s, 75),
        "p90": percentile(s, 90),
        "max": s[-1],
    }


def fmt_sat(msat):
    """Format a msat amount as sat (rounded) with thousands separators."""
    return f"{int(round(msat / MSAT_PER_SAT)):,} sat"


def fmt_int(x):
    return f"{int(round(x)):,}"


def print_summary_table(title, stats, formatter):
    print(f"  {title}")
    if not stats:
        print("    (no data)")
        return
    order = ["min", "p10", "p25", "p50", "p75", "p90", "max", "mean"]
    labels = {"p50": "p50(median)"}
    for k in order:
        label = labels.get(k, k)
        print(f"    {label:<12} {formatter(stats[k])}")


def decade_histogram(vals, label, to_display=lambda v: v):
    """Log10-decade histogram for wide-ranging positive values."""
    counts = defaultdict(int)
    sub_one = 0  # displayed value < 1 (dust / sub-satoshi)
    for v in vals:
        d = to_display(v)
        if d < 1:
            sub_one += 1
            continue
        counts[int(math.floor(math.log10(d)))] += 1
    if not counts and not sub_one:
        return
    print(f"  {label} (log10 decades)")
    total = len(vals)
    if sub_one:
        _hist_row("<1", sub_one, total)
    if counts:
        for d in range(min(counts), max(counts) + 1):
            lo = 10 ** d
            hi = 10 ** (d + 1)
            _hist_row(f"{fmt_int(lo)}–{fmt_int(hi)}", counts.get(d, 0), total)


def integer_histogram(vals, label, max_val):
    """Histogram over small integer values 0..max_val."""
    counts = defaultdict(int)
    for v in vals:
        counts[int(v)] += 1
    print(f"  {label}")
    total = len(vals)
    for i in range(0, max_val + 1):
        _hist_row(str(i), counts.get(i, 0), total)


def _hist_row(label, count, total, width=40):
    frac = count / total if total else 0
    bar = "█" * int(round(frac * width))
    print(f"    {label:>22} | {bar:<{width}} {count:>8,} ({frac*100:5.1f}%)")


# --------------------------------------------------------------------------
# Main analysis.
# --------------------------------------------------------------------------

def analyze(graph, csv_path=None):
    bases = []          # base_msat per included direction
    ignored = 0
    csv_rows = []

    for chan_id, direction, capacity_sat, base in iter_directed_bases(graph):
        if base is None:
            ignored += 1
            continue
        bases.append(base)

    total_dirs = len(bases) + ignored
    print("=" * 78)
    print("BOLT #1280 local resource conservation — mainnet bucket analysis")
    print("=" * 78)
    print(f"Directed policies analyzed : {len(bases):,}")
    print(f"Directed policies ignored  : {ignored:,} (no policy / no max_htlc_msat)")
    print(f"Total directions considered: {total_dirs:,}")
    print()
    print("Protocol constants:")
    print(f"  max_accepted_htlcs        = {MAX_ACCEPTED_HTLCS}")
    print(f"  general slots ({GENERAL_FRAC:.0%})      = {GENERAL_SLOTS}")
    print(f"  congestion slots ({CONGESTION_FRAC:.0%})   = {CONGESTION_SLOTS}")
    print(f"  protected slots ({PROTECTED_FRAC:.0%})    = {PROTECTED_SLOTS}")
    print(f"  general per-peer slots    = {GENERAL_SLOT_ALLOCATION} "
          f"(= max(5, {GENERAL_SLOTS}*5/100))")
    print("  Base value B per direction = the policy's max_htlc_msat")
    print()

    # ------------------------------------------------------------------
    # Price-independent distributions (base + bucket liquidity sizes).
    # ------------------------------------------------------------------
    print("-" * 78)
    print("Base & bucket-liquidity distributions (price-independent)")
    print("-" * 78)
    print_summary_table("max_htlc_msat (base B), shown as sat",
                         summarize(bases), fmt_sat)
    print()
    print_summary_table(f"General bucket liquidity ({GENERAL_FRAC:.0%} of B), sat",
                         summarize([general_liquidity_msat(b) for b in bases]),
                         fmt_sat)
    print()
    print_summary_table(f"Congestion bucket liquidity ({CONGESTION_FRAC:.0%} of B), sat",
                         summarize([CONGESTION_FRAC * b for b in bases]),
                         fmt_sat)
    print()
    print_summary_table("Congestion per-slot max HTLC threshold "
                         f"(~B/{MAX_ACCEPTED_HTLCS}), sat",
                         summarize([congestion_threshold_msat(b) for b in bases]),
                         fmt_sat)
    print()

    # Headline: the most a single peer can ever hold in the general bucket,
    # across all 9 of its per-peer slots. This is a liquidity cap, so it does
    # not depend on payment size or BTC price.
    peer_alloc_msat = [general_peer_liquidity_allocation_msat(b) for b in bases]
    print_summary_table(
        "Per-peer general liquidity allocation "
        "(max one peer can hold, all slots), sat",
        summarize(peer_alloc_msat), fmt_sat)
    print()
    print("  Same, expressed in USD at each price (key percentiles):")
    alloc_sat_sorted = sorted(m / MSAT_PER_SAT for m in peer_alloc_msat)
    header = "    {:<14}".format("percentile") + "".join(
        f"${p//1000}k".rjust(14) for p in PRICES_USD)
    print(header)
    for label, q in (("p10", 10), ("p25", 25), ("p50", 50),
                     ("p75", 75), ("p90", 90)):
        sat = percentile(alloc_sat_sorted, q)
        cells = "".join(
            f"${sat / SAT_PER_BTC * price:,.2f}".rjust(14) for price in PRICES_USD)
        print(f"    {label:<14}" + cells)
    print()
    decade_histogram(peer_alloc_msat,
                     "Per-peer general liquidity allocation",
                     to_display=lambda m: m / MSAT_PER_SAT)
    print()

    decade_histogram(bases, "max_htlc_msat distribution",
                     to_display=lambda m: m / MSAT_PER_SAT)
    print()

    # ------------------------------------------------------------------
    # Per-price analysis.
    # ------------------------------------------------------------------
    for price in PRICES_USD:
        htlc_msat = htlc_msat_for_price(price)
        htlc_sat = htlc_msat / MSAT_PER_SAT
        print("=" * 78)
        print(f"Price ${price:,}/BTC  →  ${PAYMENT_USD:g} payment = "
              f"{fmt_int(htlc_sat)} sat ({htlc_msat:,.0f} msat)")
        print("=" * 78)

        # (1) Congestion fit.
        n_fit = sum(1 for b in bases if congestion_fits(b, htlc_msat))
        pct_fit = 100.0 * n_fit / len(bases) if bases else 0
        print(f"(1) Congestion bucket: an average payment fits in "
              f"{n_fit:,} / {len(bases):,} directions ({pct_fit:.1f}%).")
        # Minimum base needed for the payment to fit.
        min_base_sat = htlc_msat * CONGESTION_SLOTS / CONGESTION_FRAC / MSAT_PER_SAT
        print(f"    (requires max_htlc_msat > {fmt_int(min_base_sat)} sat)")
        print()

        # (2) General bucket per-peer count.
        peer_counts = [general_peer_htlc_count(b, htlc_msat) for b in bases]
        whole_counts = [general_wholebucket_htlc_count(b, htlc_msat) for b in bases]
        n_nonzero = sum(1 for c in peer_counts if c > 0)
        pct_nonzero = 100.0 * n_nonzero / len(peer_counts) if peer_counts else 0
        n_maxed = sum(1 for c in peer_counts if c == GENERAL_SLOT_ALLOCATION)
        pct_maxed = 100.0 * n_maxed / len(peer_counts) if peer_counts else 0
        print(f"(2) General bucket (per-peer): a single peer fits "
              f"min({GENERAL_SLOT_ALLOCATION}, liq/htlc) average payments.")
        print(f"    Directions where a peer fits >=1 payment : "
              f"{n_nonzero:,} ({pct_nonzero:.1f}%)")
        print(f"    Directions where a peer fits all "
              f"{GENERAL_SLOT_ALLOCATION} slots : "
              f"{n_maxed:,} ({pct_maxed:.1f}%)")
        print_summary_table("Per-peer general HTLC count",
                            summarize(peer_counts), fmt_int)
        print()
        integer_histogram(peer_counts, "Per-peer general HTLC count distribution",
                          GENERAL_SLOT_ALLOCATION)
        print()

        # (3) Extra distribution: whole-bucket general count.
        print_summary_table("Whole general-bucket HTLC count (context)",
                            summarize(whole_counts), fmt_int)
        print()

        if csv_path:
            for b in bases:
                csv_rows.append({
                    "price_usd": price,
                    "max_htlc_msat": b,
                    "htlc_msat": int(htlc_msat),
                    "congestion_threshold_sat":
                        round(congestion_threshold_msat(b) / MSAT_PER_SAT),
                    "congestion_fits": int(congestion_fits(b, htlc_msat)),
                    "general_peer_count": general_peer_htlc_count(b, htlc_msat),
                    "general_wholebucket_count":
                        general_wholebucket_htlc_count(b, htlc_msat),
                })

    if csv_path:
        with open(csv_path, "w", newline="") as fh:
            writer = csvmod.DictWriter(fh, fieldnames=list(csv_rows[0].keys()))
            writer.writeheader()
            writer.writerows(csv_rows)
        print(f"Wrote {len(csv_rows):,} rows to {csv_path}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "graph", nargs="?", default="mainnet.json",
        help="Path to describegraph JSON (default: ./mainnet.json)")
    parser.add_argument(
        "--csv", metavar="PATH", default=None,
        help="Optional path to dump per-direction rows for plotting")
    parser.add_argument(
        "--max-htlcs", type=int, default=MAX_ACCEPTED_HTLCS, metavar="N",
        help="max_accepted_htlcs to assume per direction (default: 483)")
    parser.add_argument(
        "--general-frac", type=float, default=GENERAL_FRAC, metavar="F",
        help="general bucket fraction of slots/liquidity (default: 0.40)")
    parser.add_argument(
        "--congestion-frac", type=float, default=CONGESTION_FRAC, metavar="F",
        help="congestion bucket fraction of slots/liquidity (default: 0.20)")
    args = parser.parse_args(argv)

    set_bucket_params(args.max_htlcs, args.general_frac, args.congestion_frac)

    if not os.path.exists(args.graph):
        parser.error(f"graph file not found: {args.graph}")

    with open(args.graph) as fh:
        graph = json.load(fh)

    analyze(graph, csv_path=args.csv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
