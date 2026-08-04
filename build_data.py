#!/usr/bin/env python3
"""Preprocess an `lncli describegraph` dump into data.js and graph.js.

Two datasets come out of a pass over the graph, and they deliberately cover
different sets of directions.

data.js is the per-direction histogram of advertised max_htlc, which drives
every table on the page. Every direction that advertises a usable max_htlc is
kept -- the page's Filtering control is the only thing that excludes an edge, so
what it reports as dropped is the whole story. About a fifth of directions
advertise no max_htlc; rather than drop them -- which would bias the histogram
towards well-configured nodes -- we impute IMPUTE_RATIO x capacity, which is
what the median advertising direction actually sets.

graph.js is the topology the General routability section routes over, and it is
a strict subset: a direction is only there if it could actually carry an HTLC.
That drops the ones with no gossiped policy (no fee to charge, and no sender
will use them) and the ones flagged `disabled` (they will not forward). On the
current dump that is 96,808 histogram directions against 60,162 routable ones,
so the routability section reads a graph 38% smaller than the one the filter
reports on. The page says so; the two numbers are not meant to agree.

Topology ships in CSR form -- off[] indexing into to[]/max_htlc[]/base[]/ppm[]
-- because that is the adjacency list the browser needs, so there is no
graph-building step in JS. Node indices only: nothing on the page names a node,
and dropping pubkeys keeps the payload numeric (1.4 MB, 389 KB gzipped).

Usage:
    python3 build_data.py mainnet.json --output data.js --graph-output graph.js
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


def parse_routing_graph(graph):
    """Return (csr, stats) over the directions that can actually forward.

    csr is a dict of parallel arrays in compressed-sparse-row order: off[u] and
    off[u+1] bracket node u's outbound directions in to[]/max_htlc[]/base[]/ppm[].

    A node only gets an index if it appears on a routable direction, so nodes
    whose every channel is disabled or unadvertised drop out of the graph rather
    than sitting in it as unreachable indices.
    """
    index = {}
    dirs = []
    no_policy, disabled, no_value = 0, 0, 0
    for edge in graph.get("edges", []):
        capacity = _int(edge.get("capacity"))
        for node_key, peer_key, policy_key in DIRECTIONS:
            policy = edge.get(policy_key)
            if not policy:
                # Never gossiped: there is no fee to charge and no sender will
                # build a route over it.
                no_policy += 1
                continue
            if policy.get("disabled"):
                disabled += 1
                continue
            sat = _int(policy.get("max_htlc_msat")) // 1000
            if sat <= 0:
                # Same imputation as the histogram, but only for a direction
                # that is otherwise usable.
                sat = int(capacity * IMPUTE_RATIO)
            if sat <= 0:
                no_value += 1
                continue
            u, v = edge.get(node_key), edge.get(peer_key)
            for pub in (u, v):
                if pub not in index:
                    index[pub] = len(index)
            dirs.append((index[u], index[v], sat,
                         _int(policy.get("fee_base_msat")),
                         _int(policy.get("fee_rate_milli_msat"))))

    n = len(index)
    dirs.sort(key=lambda d: (d[0], d[1]))
    off = [0] * (n + 1)
    for u, *_ in dirs:
        off[u + 1] += 1
    for i in range(n):
        off[i + 1] += off[i]

    csr = {
        "n": n,
        "off": off,
        "to": [d[1] for d in dirs],
        "maxHtlc": [d[2] for d in dirs],
        "baseMsat": [d[3] for d in dirs],
        "ppm": [d[4] for d in dirs],
    }
    stats = {"noPolicy": no_policy, "disabled": disabled, "noValue": no_value}
    return csr, stats


def render_graph_js(csr, stats, source):
    payload = dict(csr)
    payload.update({
        "source": os.path.basename(source),
        "generated": date.today().isoformat(),
        "directionsNoPolicy": stats["noPolicy"],
        "directionsDisabled": stats["disabled"],
    })
    return "window.GRAPH_DATA = %s;\n" % json.dumps(payload, separators=(",", ":"))


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
        # direction is kept in the histogram, however few channels its node has
        # and whether or not it could carry an HTLC.
        {"node1_pub": "A", "node2_pub": "B", "capacity": "1000000",
         "node1_policy": {"max_htlc_msat": "1500000", "fee_base_msat": "1000",
                          "fee_rate_milli_msat": "100"},
         "node2_policy": {"max_htlc_msat": "2000000", "fee_base_msat": "0",
                          "fee_rate_milli_msat": "1"}},
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
         # Advertised, so the histogram counts it, but disabled, so no route
         # can use it.
         "node1_policy": {"max_htlc_msat": "900000", "disabled": True},
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

    csr, gstats = parse_routing_graph(FIXTURE)
    # C->A and E->A never gossiped a policy; A->E did but has no value to use.
    assert gstats["noPolicy"] == 2, gstats
    assert gstats["disabled"] == 1, gstats     # C->D is advertised but disabled
    assert gstats["noValue"] == 1, gstats      # A->E floors to zero sat
    # E is only ever on unusable directions, so it is not in the routing graph
    # at all -- A, B, C, D are, in order of first appearance.
    assert csr["n"] == 4, csr["n"]
    m = len(csr["to"])
    assert m == 6, m
    assert csr["off"] == [0, 3, 4, 4, 6], csr["off"]
    assert csr["off"][csr["n"]] == m, csr["off"]
    assert csr["off"] == sorted(csr["off"]), csr["off"]
    # A's three outbound directions, ascending by peer index: B, C, D. A->D
    # keeps the histogram's imputed value, and A->C floors the same way.
    assert csr["to"][0:3] == [1, 2, 3], csr["to"]
    assert csr["maxHtlc"][0:3] == [1500, 1500, 3960000], csr["maxHtlc"]
    assert csr["baseMsat"][0] == 1000 and csr["ppm"][0] == 100, csr
    # A direction with a policy but no fee fields reads as a zero-fee hop
    # rather than dropping out.
    assert csr["baseMsat"][1] == 0 and csr["ppm"][1] == 0, csr
    # D keeps both directions; the disabled C->D is gone but D->C remains.
    assert csr["to"][4:6] == [0, 2], csr["to"]
    assert csr["maxHtlc"][4:6] == [3000, 800], csr["maxHtlc"]
    # The histogram still counts the disabled direction and the unadvertised
    # ones: 8 entries against 6 routable directions.
    assert len(kept) == 8 and m == 6, (len(kept), m)

    gjs = render_graph_js(csr, gstats, "path/to/f.json")
    assert gjs.startswith("window.GRAPH_DATA = {"), gjs[:40]
    gpayload = json.loads(gjs[len("window.GRAPH_DATA = "):-2])
    assert gpayload["n"] == 4 and gpayload["source"] == "f.json", gpayload
    assert gpayload["directionsDisabled"] == 1, gpayload
    print("build_data.py self-test: OK")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("graph", nargs="?", default="mainnet.json",
                        help="describegraph JSON (default: ./mainnet.json)")
    parser.add_argument("--output", default="data.js",
                        help="output JS file (default: ./data.js)")
    parser.add_argument("--graph-output", default="graph.js",
                        help="routing topology JS file (default: ./graph.js)")
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

    csr, gstats = parse_routing_graph(graph)
    routable = len(csr["to"])
    if not routable:
        print("no routable directions found", file=sys.stderr)
        return 1
    print(f"routable {routable:,} directions over {csr['n']:,} nodes "
          f"(excluded {gstats['noPolicy']:,} with no policy, "
          f"{gstats['disabled']:,} disabled, {gstats['noValue']:,} with no value)")
    with open(args.graph_output, "w") as fh:
        fh.write(render_graph_js(csr, gstats, args.graph))
    print(f"wrote {os.path.getsize(args.graph_output):,} bytes to "
          f"{args.graph_output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
