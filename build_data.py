#!/usr/bin/env python3
"""Preprocess an `lncli describegraph` dump into data.js for the explorer.

For every directed channel policy, keep max_htlc_msat (converted to sats)
when:
- the advertising node has more than one channel (single-channel nodes are
  assumed to be non-forwarding), and
- the policy exists and advertises max_htlc_msat > 0.

Kept values are aggregated into an ascending [sat, count] histogram written
as a `window.EDGE_DATA = {...};` assignment so the page works from file://.

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

DIRECTIONS = (("node1_pub", "node1_policy"), ("node2_pub", "node2_policy"))


def channel_counts(edges):
    counts = Counter()
    for edge in edges:
        counts[edge.get("node1_pub")] += 1
        counts[edge.get("node2_pub")] += 1
    return counts


def collect(graph):
    """Return (kept_sat_values, dropped_directions, single_channel_nodes)."""
    edges = graph.get("edges", [])
    counts = channel_counts(edges)
    kept = []
    dropped = 0
    for edge in edges:
        for node_key, policy_key in DIRECTIONS:
            if counts[edge.get(node_key)] <= 1:
                dropped += 1
                continue
            policy = edge.get(policy_key)
            msat = 0
            if policy:
                try:
                    msat = int(policy.get("max_htlc_msat") or 0)
                except (TypeError, ValueError):
                    msat = 0
            sat = msat // 1000
            if sat <= 0:
                dropped += 1
                continue
            kept.append(sat)
    single = sum(1 for c in counts.values() if c == 1)
    return kept, dropped, single


def render_data_js(kept, dropped, single, source):
    hist = sorted(Counter(kept).items())
    payload = {
        "source": os.path.basename(source),
        "generated": date.today().isoformat(),
        "directionsKept": len(kept),
        "directionsDropped": dropped,
        "singleChannelNodes": single,
        "hist": [[s, c] for s, c in hist],
    }
    return "window.EDGE_DATA = %s;\n" % json.dumps(payload, separators=(",", ":"))


FIXTURE = {
    "edges": [
        # A has four channels; B, C, D, E have one each.
        {"node1_pub": "A", "node2_pub": "B",
         "node1_policy": {"max_htlc_msat": "1500000"},
         "node2_policy": {"max_htlc_msat": "2000000"}},
        {"node1_pub": "A", "node2_pub": "C",
         "node1_policy": {"max_htlc_msat": "1500499"},  # floors to 1500 sat
         "node2_policy": None},                          # missing policy
        {"node1_pub": "A", "node2_pub": "D",
         "node1_policy": {"max_htlc_msat": "0"},         # zero max_htlc
         "node2_policy": {"max_htlc_msat": "3000000"}},
        {"node1_pub": "A", "node2_pub": "E",
         "node1_policy": {"max_htlc_msat": "500"},       # floors to 0 sat -> dropped
         "node2_policy": None},
    ]
}


def self_test():
    kept, dropped, single = collect(FIXTURE)
    # A's two usable directions, both flooring to 1500 sat.
    assert kept == [1500, 1500], kept
    # Dropped: B/C/D/E's four single-channel directions + A's zero max_htlc +
    # A's 500-msat direction (floors to 0 sat).
    assert dropped == 6, dropped
    assert single == 4, single
    js = render_data_js(kept, dropped, single, "path/to/fixture.json")
    assert js.startswith("window.EDGE_DATA = {") and js.endswith(";\n"), js[:40]
    payload = json.loads(js[len("window.EDGE_DATA = "):-2])
    assert payload["hist"] == [[1500, 2]], payload["hist"]
    assert payload["directionsKept"] == 2
    assert payload["source"] == "fixture.json"
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
    kept, dropped, single = collect(graph)
    if not kept:
        print("no usable directed policies found", file=sys.stderr)
        return 1
    with open(args.output, "w") as fh:
        fh.write(render_data_js(kept, dropped, single, args.graph))
    print(f"kept {len(kept):,} directions ({len(set(kept)):,} distinct values), "
          f"dropped {dropped:,}, single-channel nodes {single:,}")
    print(f"wrote {os.path.getsize(args.output):,} bytes to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
