#!/usr/bin/env python3
"""Preprocess an `lncli describegraph` dump into data.js for the explorer.

Two datasets come out of one pass over the graph.

1. The per-direction histogram of advertised max_htlc, which drives the
   distribution and percentile tables. A direction is kept when the advertising
   node has more than one channel (single-channel nodes are assumed to be
   non-forwarding).

2. A sample of real routes through the graph, which drives the routability
   section. For each sampled route we record its *bottleneck*: the smallest
   max_htlc among the channels that a general bucket actually applies to.

   Under PR #1280 the sender does not apply the bucket to its own outgoing
   channel -- the restriction is applied by a forwarding node on its outbound
   channel. So a route's constrained channels are all but the first, and we
   index routes by their number of forwarding nodes: A->B is 0 hops (nothing is
   forwarded), A->B->C is 1 hop (B forwards over B->C).

   Because a route clears iff every constrained channel clears, and the general
   allocation is the same fraction `f` of every channel's max_htlc, the route
   clears a payment `p` iff bottleneck >= p / f. The bottleneck therefore
   depends only on the topology, and the page can vary every bucket parameter
   against a frozen sample.

About a fifth of directions advertise no max_htlc. Rather than drop them --
which would compound along a route and bias the sample towards paths made
entirely of well-configured nodes -- we impute IMPUTE_RATIO x capacity, which
is what the median advertising direction actually sets.

Usage:
    python3 build_data.py mainnet.json --output data.js
    python3 build_data.py --self-test
"""

import argparse
import heapq
import json
import os
import random
import sys
from collections import Counter, defaultdict
from datetime import date

DIRECTIONS = (("node1_pub", "node2_pub", "node1_policy"),
              ("node2_pub", "node1_pub", "node2_policy"))

# Where an advertising direction sits relative to its channel capacity: the
# median observed ratio, which 82% of directions are at or above.
IMPUTE_RATIO = 0.99

# Fees are scored for one nominal payment so that route choice does not shift
# under the page's payment-size control. 100k sat is mid-band at $75k/BTC.
NOMINAL_SAT = 100_000

# Routes with more forwarding nodes than this are counted and discarded; the
# page's heatmap stops at six.
MAX_HOPS = 6

DEFAULT_SOURCES = 1200
DEFAULT_PER_SOURCE = 60
DEFAULT_SEED = 7


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def channel_counts(edges):
    counts = Counter()
    for edge in edges:
        counts[edge.get("node1_pub")] += 1
        counts[edge.get("node2_pub")] += 1
    return counts


def median_fees(edges):
    """Median (base msat, ppm) over advertising directions, for imputed ones."""
    bases, rates = [], []
    for edge in edges:
        for _, _, policy_key in DIRECTIONS:
            policy = edge.get(policy_key)
            if not policy:
                continue
            bases.append(_int(policy.get("fee_base_msat")))
            rates.append(_int(policy.get("fee_rate_milli_msat")))
    if not bases:
        return 1000, 1
    bases.sort()
    rates.sort()
    return bases[len(bases) // 2], rates[len(rates) // 2]


def parse_graph(graph):
    """Return (hist_values, adjacency, stats).

    hist_values are the kept per-direction max_htlc sats. adjacency maps a node
    to [(peer, max_htlc_sat, fee_msat)] over directions it can forward on.
    """
    edges = graph.get("edges", [])
    counts = channel_counts(edges)
    base_msat, ppm = median_fees(edges)
    imputed_fee = base_msat + (NOMINAL_SAT * 1000 * ppm) // 1_000_000

    kept, dropped, imputed = [], 0, 0
    adjacency = defaultdict(list)
    for edge in edges:
        capacity = _int(edge.get("capacity"))
        for node_key, peer_key, policy_key in DIRECTIONS:
            node = edge.get(node_key)
            peer = edge.get(peer_key)
            policy = edge.get(policy_key)
            sat = _int(policy.get("max_htlc_msat")) // 1000 if policy else 0
            if sat <= 0:
                # No advertised limit: stand in the modal configuration so the
                # direction stays usable instead of silently leaving the graph.
                sat = int(capacity * IMPUTE_RATIO)
                if sat > 0:
                    imputed += 1
            if sat <= 0:
                dropped += 1
                continue

            # The histogram is about who could forward, so single-channel nodes
            # stay out of it -- but they are still valid route endpoints below.
            if counts[node] > 1:
                kept.append(sat)
            else:
                dropped += 1

            # A disabled direction cannot carry an HTLC, so no route uses it.
            if policy and policy.get("disabled"):
                continue
            if policy:
                fee = _int(policy.get("fee_base_msat")) + (
                    NOMINAL_SAT * 1000 * _int(policy.get("fee_rate_milli_msat"))
                ) // 1_000_000
            else:
                fee = imputed_fee
            adjacency[node].append((peer, sat, fee))

    stats = {
        "dropped": dropped,
        "imputed": imputed,
        "single": sum(1 for c in counts.values() if c == 1),
    }
    return kept, adjacency, stats


def route_bottleneck(path, htlc):
    """Smallest max_htlc among a path's constrained channels.

    htlc maps (u, v) -> max_htlc sat. The first channel is the sender's own and
    is never gated, so it is excluded; the rest are each some node's outbound
    forwarding channel.
    """
    return min(htlc[(path[i], path[i + 1])] for i in range(1, len(path) - 1))


def shortest_paths(adjacency, source):
    """Dijkstra from source over (hop count, fee). Returns the predecessor map.

    Ordering hops first and fee second keeps route lengths realistic: scoring on
    fee alone chases zero-fee channels through five- and six-hop paths, which is
    not what a sender picks. Among equally short routes the cheapest wins, which
    is what steers routes onto the well-connected, low-fee hubs.

    The sender pays no fee on its own first channel, matching how a real sender
    scores candidate routes.
    """
    dist = {source: (0, 0)}
    prev = {source: None}
    seen = set()
    queue = [((0, 0), source)]
    while queue:
        cost, node = heapq.heappop(queue)
        if node in seen:
            continue
        seen.add(node)
        for peer, _, fee in adjacency.get(node, ()):
            if peer in seen:
                continue
            step = 0 if node == source else fee
            through = (cost[0] + 1, cost[1] + step)
            if peer not in dist or through < dist[peer]:
                dist[peer] = through
                prev[peer] = node
                heapq.heappush(queue, (through, peer))
    return prev


def reconstruct(prev, dest):
    path = [dest]
    while prev[path[-1]] is not None:
        path.append(prev[path[-1]])
        if len(path) > 64:
            return None
    return path[::-1]


def sample_routes(adjacency, sources, per_source, seed):
    """Sample routes and bin their bottlenecks by forwarding-node count."""
    htlc = {}
    for node, out in adjacency.items():
        for peer, sat, _ in out:
            htlc[(node, peer)] = sat
    nodes = sorted(adjacency)
    if not nodes:
        return {}, {"sampled": 0, "direct": 0, "tooLong": 0, "unreachable": 0}

    rng = random.Random(seed)
    picks = nodes if len(nodes) <= sources else rng.sample(nodes, sources)
    hist = defaultdict(Counter)
    stats = {"sampled": 0, "direct": 0, "tooLong": 0, "unreachable": 0}

    for source in picks:
        prev = shortest_paths(adjacency, source)
        reachable = [n for n in prev if n != source]
        if not reachable:
            continue
        if len(reachable) > per_source:
            reachable = rng.sample(reachable, per_source)
        for dest in reachable:
            path = reconstruct(prev, dest)
            if path is None:
                stats["unreachable"] += 1
                continue
            hops = len(path) - 2          # forwarding nodes on the route
            if hops < 1:
                stats["direct"] += 1      # A->B: nothing is forwarded
                continue
            if hops > MAX_HOPS:
                stats["tooLong"] += 1
                continue
            hist[hops][route_bottleneck(path, htlc)] += 1
            stats["sampled"] += 1
    return hist, stats


def render_data_js(kept, route_hist, route_stats, stats, source,
                   sources, per_source, seed):
    hist = sorted(Counter(kept).items())
    payload = {
        "source": os.path.basename(source),
        "generated": date.today().isoformat(),
        "directionsKept": len(kept),
        "directionsDropped": stats["dropped"],
        "directionsImputed": stats["imputed"],
        "singleChannelNodes": stats["single"],
        "hist": [[s, c] for s, c in hist],
        "routes": {
            "sources": sources,
            "perSource": per_source,
            "seed": seed,
            "nominalSat": NOMINAL_SAT,
            "stats": route_stats,
            # keyed by number of forwarding nodes on the route
            "hops": {str(h): [[s, c] for s, c in sorted(route_hist[h].items())]
                     for h in sorted(route_hist)},
        },
    }
    return "window.EDGE_DATA = %s;\n" % json.dumps(payload, separators=(",", ":"))


FIXTURE = {
    "edges": [
        # A is a hub (four channels); B, C, D, E hang off it. C-D gives the
        # graph an interior path so routes longer than one hop exist.
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
    kept, adjacency, stats = parse_graph(FIXTURE)
    # Imputed: C->A (no policy) and A->D (zero max_htlc). E->A has no capacity
    # to fall back on, and A->E floors to zero sat.
    assert stats["imputed"] == 2, stats
    assert stats["single"] == 2, stats            # B and E
    # Only multi-channel advertisers land in the histogram, so B->A's 2000 sat
    # stays out: A->B, A->C, A->D, C->A, C->D, D->C, D->A.
    assert sorted(kept) == [800, 900, 1500, 1500, 3000, 990000,
                            3960000], sorted(kept)
    assert stats["dropped"] == 3, stats           # A->E, E->A, B->A

    # A->E had no limit and no capacity to impute from, so E left the graph.
    assert all(p != "E" for p, _, _ in adjacency["A"]), adjacency["A"]

    # B -> A -> C is one hop: A forwards over A->C (1500 sat). The sender's own
    # B->A channel is not gated and must not bind the bottleneck.
    htlc = {(n, p): s for n, out in adjacency.items() for p, s, _ in out}
    assert route_bottleneck(["B", "A", "C"], htlc) == 1500
    # B -> A -> D -> C is two hops, binding on min(A->D 3960000, D->C 800).
    assert route_bottleneck(["B", "A", "D", "C"], htlc) == 800

    route_hist, route_stats = sample_routes(adjacency, 10, 10, DEFAULT_SEED)
    assert route_stats["sampled"] > 0, route_stats
    assert route_stats["direct"] > 0, route_stats  # A's neighbours are 0 hops
    assert all(1 <= h <= MAX_HOPS for h in route_hist), sorted(route_hist)

    js = render_data_js(kept, route_hist, route_stats, stats, "path/to/f.json",
                        10, 10, DEFAULT_SEED)
    assert js.startswith("window.EDGE_DATA = {") and js.endswith(";\n"), js[:40]
    payload = json.loads(js[len("window.EDGE_DATA = "):-2])
    assert payload["hist"] == [[800, 1], [900, 1], [1500, 2], [3000, 1],
                               [990000, 1], [3960000, 1]], payload["hist"]
    assert payload["source"] == "f.json"
    assert payload["routes"]["hops"], payload["routes"]
    for entries in payload["routes"]["hops"].values():
        assert entries == sorted(entries), entries
    print("build_data.py self-test: OK")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("graph", nargs="?", default="mainnet.json",
                        help="describegraph JSON (default: ./mainnet.json)")
    parser.add_argument("--output", default="data.js",
                        help="output JS file (default: ./data.js)")
    parser.add_argument("--sources", type=int, default=DEFAULT_SOURCES,
                        help="route-sample source nodes (default: %(default)s)")
    parser.add_argument("--per-source", type=int, default=DEFAULT_PER_SOURCE,
                        help="destinations per source (default: %(default)s)")
    parser.add_argument("--route-seed", type=int, default=DEFAULT_SEED,
                        help="route sampling seed (default: %(default)s)")
    parser.add_argument("--self-test", action="store_true",
                        help="run the built-in fixture test and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    with open(args.graph) as fh:
        graph = json.load(fh)
    kept, adjacency, stats = parse_graph(graph)
    if not kept:
        print("no usable directed policies found", file=sys.stderr)
        return 1
    print(f"kept {len(kept):,} directions ({len(set(kept)):,} distinct values), "
          f"dropped {stats['dropped']:,}, imputed {stats['imputed']:,}, "
          f"single-channel nodes {stats['single']:,}")

    print(f"sampling routes from {args.sources:,} sources ...")
    route_hist, route_stats = sample_routes(
        adjacency, args.sources, args.per_source, args.route_seed)
    print("  " + ", ".join(f"{h} hop: {sum(route_hist[h].values()):,}"
                           for h in sorted(route_hist)))
    print(f"  direct {route_stats['direct']:,}, "
          f"over {MAX_HOPS} hops {route_stats['tooLong']:,}")

    with open(args.output, "w") as fh:
        fh.write(render_data_js(kept, route_hist, route_stats, stats,
                                args.graph, args.sources, args.per_source,
                                args.route_seed))
    print(f"wrote {os.path.getsize(args.output):,} bytes to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
