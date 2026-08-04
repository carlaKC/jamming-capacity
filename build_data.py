#!/usr/bin/env python3
"""Preprocess an `lncli describegraph` dump into data.js for the explorer.

One dataset comes out of a pass over the graph: the per-direction histogram of
advertised max_htlc, which drives every table on the page. Every direction that
advertises a usable max_htlc is kept -- the page's Filtering control is the only
thing that excludes an edge, so what it reports as dropped is the whole story.

About a fifth of directions advertise no max_htlc. Rather than drop them --
which would bias the histogram towards well-configured nodes -- we impute
IMPUTE_RATIO x capacity, which is what the median advertising direction
actually sets.

Usage:
    python3 build_data.py mainnet.json --output data.js
    python3 build_data.py --self-test
"""

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date

DIRECTIONS = (("node1_pub", "node2_pub", "node1_policy"),
              ("node2_pub", "node1_pub", "node2_policy"))

# Where an advertising direction sits relative to its channel capacity: the
# median observed ratio, which 82% of directions are at or above.
IMPUTE_RATIO = 0.99

def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def parse_graph(graph):
    """Return (hist_values, stats).

    hist_values are the kept per-direction max_htlc sats.
    """
    edges = graph.get("edges", [])
    kept, dropped, imputed = [], 0, 0
    for edge in edges:
        capacity = _int(edge.get("capacity"))
        for _node_key, _peer_key, policy_key in DIRECTIONS:
            policy = edge.get(policy_key)
            sat = _int(policy.get("max_htlc_msat")) // 1000 if policy else 0
            if sat <= 0:
                # No advertised limit: stand in the modal configuration so the
                # direction stays usable instead of silently leaving the graph.
                sat = int(capacity * IMPUTE_RATIO)
                if sat > 0:
                    imputed += 1
            if sat <= 0:
                # No advertised limit and no capacity to impute from: there is
                # no value to put in the histogram at all.
                dropped += 1
                continue
            kept.append(sat)

    stats = {"dropped": dropped, "imputed": imputed}
    return kept, stats


def render_data_js(kept, stats, source):
    hist = sorted(Counter(kept).items())
    payload = {
        "source": os.path.basename(source),
        "generated": date.today().isoformat(),
        "directionsKept": len(kept),
        "directionsDropped": stats["dropped"],
        "directionsImputed": stats["imputed"],
        "hist": [[s, c] for s, c in hist],
    }
    return "window.EDGE_DATA = %s;\n" % json.dumps(payload, separators=(",", ":"))


FIXTURE = {
    "edges": [
        # A is a hub (four channels); B, C, D, E hang off it. Every advertising
        # direction is kept now, however few channels its node has.
        {"node1_pub": "A", "node2_pub": "B", "capacity": "1000000",
         "node1_policy": {"max_htlc_msat": "1500000"},
         "node2_policy": {"max_htlc_msat": "2000000"}},
        {"node1_pub": "A", "node2_pub": "C", "capacity": "1000000",
         "node1_policy": {"max_htlc_msat": "1500499"},  # floors to 1500 sat
         "node2_policy": None},                          # imputed: 990000 sat
        {"node1_pub": "A", "node2_pub": "D", "capacity": "4000000",
         "node1_policy": {"max_htlc_msat": "0"},         # imputed: 3960000 sat
         "node2_policy": {"max_htlc_msat": "3000000"}},  # 3000 sat
        {"node1_pub": "A", "node2_pub": "E", "capacity": "0",
         "node1_policy": {"max_htlc_msat": "500"},       # floors to 0, no
         "node2_policy": None},                          # capacity to impute
        {"node1_pub": "C", "node2_pub": "D", "capacity": "2000000",
         "node1_policy": {"max_htlc_msat": "900000"},
         "node2_policy": {"max_htlc_msat": "800000"}},
    ]
}


def self_test():
    kept, stats = parse_graph(FIXTURE)
    # Imputed: C->A (no policy) and A->D (zero max_htlc). E->A has no capacity
    # to fall back on, and A->E floors to zero sat.
    assert stats["imputed"] == 2, stats
    # Every advertising direction lands in the histogram, including B->A's
    # 2000 sat: B has one channel, which no longer keeps it out.
    assert sorted(kept) == [800, 900, 1500, 1500, 2000, 3000, 990000,
                            3960000], sorted(kept)
    # The only drops left are directions with no advertised limit and no
    # capacity to impute one from: A->E floors to zero sat, E->A has neither.
    assert stats["dropped"] == 2, stats

    js = render_data_js(kept, stats, "path/to/f.json")
    assert js.startswith("window.EDGE_DATA = {") and js.endswith(";\n"), js[:40]
    payload = json.loads(js[len("window.EDGE_DATA = "):-2])
    assert payload["hist"] == [[800, 1], [900, 1], [1500, 2], [2000, 1],
                               [3000, 1], [990000, 1],
                               [3960000, 1]], payload["hist"]
    assert payload["source"] == "f.json"
    assert payload["hist"] == sorted(payload["hist"]), payload["hist"]
    print("build_data.py self-test: OK")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("graph", nargs="?", default="mainnet.json",
                        help="describegraph JSON (default: ./mainnet.json)")
    parser.add_argument("--output", default="data.js",
                        help="output JS file (default: ./data.js)")
    parser.add_argument("--self-test", action="store_true",
                        help="run the built-in fixture test and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    with open(args.graph) as fh:
        graph = json.load(fh)
    kept, stats = parse_graph(graph)
    if not kept:
        print("no usable directed policies found", file=sys.stderr)
        return 1
    print(f"kept {len(kept):,} directions ({len(set(kept)):,} distinct values), "
          f"dropped {stats['dropped']:,} (no max_htlc and no capacity), "
          f"imputed {stats['imputed']:,}")

    with open(args.output, "w") as fh:
        fh.write(render_data_js(kept, stats, args.graph))
    print(f"wrote {os.path.getsize(args.output):,} bytes to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
