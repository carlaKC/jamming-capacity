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

   Endpoints are classified by the role they play in routing, and routes are
   sampled between every ordered pair of roles, so the page can show who is
   paying whom rather than one blended number. See classify_nodes().

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
import math
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

DEFAULT_SEED = 7

# Pass 1 estimates betweenness from this many shortest-path trees; pass 2 draws
# this many sources from each role and this many destinations per source per
# destination role.
DEFAULT_TRANSIT_SOURCES = 400
DEFAULT_SOURCES_PER_TIER = 400
DEFAULT_PER_DEST_TIER = 25

# The smallest set of nodes carrying this share of all transit is the core.
CORE_TRANSIT_SHARE = 0.90

# Ordered so the page can lay the matrix out directly.
TIERS = ("terminal", "peripheral", "core")

INF = math.inf

# Bottlenecks are stored to this many significant figures; see quantize().
SIG_FIGS = 3


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
    """Return (hist_values, adjacency, degrees, stats).

    hist_values are the kept per-direction max_htlc sats. adjacency maps a node
    to [(peer, max_htlc_sat, fee_msat)] over directions it can forward on.
    degrees is each node's channel count, which selects route endpoints -- note
    it counts channels, not usable directions, so a node whose channels are
    disabled still reads as well-connected.
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
    return kept, adjacency, counts, stats


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


def tree_depths(prev, source):
    """Depth of every node in a predecessor tree, memoised up the parent chain."""
    depth = {source: 0}
    for node in prev:
        if node in depth:
            continue
        chain = []
        cur = node
        while cur not in depth:
            chain.append(cur)
            cur = prev[cur]
        d = depth[cur]
        for c in reversed(chain):
            d += 1
            depth[c] = d
    return depth


def transit_counts(adjacency, sources, seed):
    """How many sampled shortest paths pass *through* each node.

    A node is an intermediate on the path to d exactly when it is a proper
    ancestor of d in the source's shortest-path tree, so the count for one
    source is its subtree size less itself -- no need to walk every path.
    """
    nodes = sorted(adjacency)
    rng = random.Random(seed)
    picks = nodes if len(nodes) <= sources else rng.sample(nodes, sources)
    through = Counter()
    for source in picks:
        prev = shortest_paths(adjacency, source)
        depth = tree_depths(prev, source)
        size = dict.fromkeys(prev, 1)
        for node in sorted(prev, key=lambda n: -depth[n]):
            parent = prev[node]
            if parent is not None:
                size[parent] += size[node]
        for node in prev:
            if node != source:
                through[node] += size[node] - 1
    return through


def widest_within(adjacency, source, max_hops):
    """best[h - 1][node] = widest bottleneck reachable using <= h gated channels.

    The sender's own first channel is never gated, so the search starts from
    the source's peers with no constraint yet. Relaxation is strictly
    level-by-level -- a node updated in round h is only expanded in round
    h + 1 -- so each snapshot really is "within h hops" rather than whatever
    an in-place sweep happened to propagate.
    """
    best = {}
    for peer, _, _ in adjacency.get(source, ()):
        if peer != source:
            best[peer] = INF
    frontier = dict(best)
    out = []
    for _ in range(max_hops):
        changed = {}
        for node, width in frontier.items():
            for peer, sat, _ in adjacency.get(node, ()):
                candidate = width if width < sat else sat
                if candidate > best.get(peer, 0):
                    best[peer] = candidate
                    changed[peer] = candidate
        frontier = changed
        out.append(dict(best))
        if not frontier:
            # Nothing improved, so longer budgets cannot either.
            out.extend([out[-1]] * (max_hops - len(out)))
            break
    return out


def node_universe(adjacency):
    """Every node a route can touch.

    A node with no usable outgoing direction never appears as an adjacency key,
    but is still reachable and can still be paid -- it just cannot forward, so
    it is terminal by construction.
    """
    nodes = set(adjacency)
    for out in adjacency.values():
        for peer, _, _ in out:
            nodes.add(peer)
    return sorted(nodes)


def classify_nodes(adjacency, through, core_share=CORE_TRANSIT_SHARE):
    """Label every node by the role it plays in routing.

    terminal    never an intermediate on anybody's path -- it only sends and
                receives. A structural fact, not a threshold.
    core        the smallest set of nodes carrying `core_share` of all transit.
                A Pareto cut rather than a hand-picked line.
    peripheral  forwards, but is not part of that core.

    Degree would be the obvious axis and is the wrong one: the tiers overlap
    heavily in degree, so a degree threshold misclassifies a large minority.
    Channel size separates nodes better but is what the page then measures, so
    tiering on it would make the result circular.
    """
    nodes = node_universe(adjacency)
    carriers = sorted((n for n in nodes if through[n] > 0),
                      key=lambda n: (-through[n], n))
    total = sum(through[n] for n in carriers)
    tier = {n: "terminal" for n in nodes if through[n] == 0}
    run = 0
    for node in carriers:
        # The node that tips the running total past the share is still core, so
        # the set genuinely covers it.
        tier[node] = "core" if run < total * core_share else "peripheral"
        run += through[node]
    return tier


def sample_matrix(adjacency, tier, sources_per_tier, per_dest_tier, seed):
    """Sample node pairs between every ordered pair of roles.

    Stratified, not uniform: core-to-core is 0.2% x 0.2% of a uniform draw and
    would never fill in. Each cell instead gets its own quota, which means cell
    figures are comparable to each other but there is no meaningful "overall"
    number to read off the matrix.

    Each pair yields two bottlenecks, which bracket the answer:

    first  the route a fee-optimising sender actually picks -- shortest, then
           cheapest. Route choice never looks at channel size, exactly as a
           sender's does not, so this is what one attempt gets you.
    best   the widest path available within a hop budget. A sender who keeps
           retrying converges here. The general-bucket limit is not gossiped,
           so nobody can aim at this deliberately, but it is what the topology
           permits.

    Both are properties of the pair rather than of a payment size, so both
    freeze into data.js and stay live under every bucket parameter. Every
    series covers the same population of pairs, so they are directly
    comparable -- unlike binning by a route's own length, where each hop count
    is a different set of pairs.
    """
    htlc = {}
    for node, out in adjacency.items():
        for peer, sat, _ in out:
            htlc[(node, peer)] = sat

    # Sources must be able to originate, so they come from the adjacency; any
    # classified node can be a destination.
    by_tier = defaultdict(list)
    for node in sorted(adjacency):
        by_tier[tier[node]].append(node)
    population = Counter(tier.values())

    rng = random.Random(seed)
    # (src_tier, dst_tier) -> {"first": Counter, "best": {budget: Counter}}
    hist = {}

    def cell(src, dst):
        return hist.setdefault((src, dst), {
            "first": Counter(),
            "best": {h: Counter() for h in range(1, MAX_HOPS + 1)},
        })

    stats = {"sampled": 0, "direct": 0, "tooLong": 0,
             "tiers": {t: population[t] for t in TIERS},
             "senders": {t: len(by_tier[t]) for t in TIERS}}

    for src_tier in TIERS:
        pool = by_tier[src_tier]
        if not pool:
            continue
        picks = (pool if len(pool) <= sources_per_tier
                 else rng.sample(pool, sources_per_tier))
        for source in picks:
            prev = shortest_paths(adjacency, source)
            widest = widest_within(adjacency, source, MAX_HOPS)
            reach = defaultdict(list)
            for node in prev:
                if node != source:
                    reach[tier[node]].append(node)
            for dst_tier in TIERS:
                cand = reach.get(dst_tier, [])
                if not cand:
                    continue
                if len(cand) > per_dest_tier:
                    cand = rng.sample(cand, per_dest_tier)
                for dest in cand:
                    path = reconstruct(prev, dest)
                    if path is None:
                        continue
                    hops = len(path) - 2      # forwarding nodes on the route
                    if hops < 1:
                        stats["direct"] += 1  # A->B: nothing is forwarded
                        continue
                    if hops > MAX_HOPS:
                        stats["tooLong"] += 1
                        continue
                    entry = cell(src_tier, dst_tier)
                    entry["first"][route_bottleneck(path, htlc)] += 1
                    for budget in range(1, MAX_HOPS + 1):
                        # 0 when no path of that length reaches the
                        # destination, which clears nothing.
                        entry["best"][budget][
                            widest[budget - 1].get(dest, 0)] += 1
                    stats["sampled"] += 1
    return hist, stats


def quantize(value, digits=SIG_FIGS):
    """Round a bottleneck down to `digits` significant figures.

    Six series per cell at full precision run data.js past 650kB, and the extra
    digits are noise next to the modelling error. Rounding *down* keeps the
    figure conservative -- a route never looks wider than it is -- at under 1%.
    """
    if value <= 0:
        return value
    step = 10 ** max(0, len(str(value)) - digits)
    return (value // step) * step


def matrix_payload(route_hist):
    """pairs[src][dst] = {"first": [[sat, n], ...], "best": {budget: [...]}}."""
    def as_hist(counts):
        merged = Counter()
        for value, n in counts.items():
            merged[quantize(value)] += n
        return [[s, c] for s, c in sorted(merged.items())]
    pairs = {}
    for (src, dst), entry in route_hist.items():
        pairs.setdefault(src, {})[dst] = {
            "first": as_hist(entry["first"]),
            "best": {str(h): as_hist(c) for h, c in sorted(entry["best"].items())},
        }
    return pairs


def render_data_js(kept, route_hist, route_stats, stats, source, cfg):
    hist = sorted(Counter(kept).items())
    payload = {
        "source": os.path.basename(source),
        "generated": date.today().isoformat(),
        "directionsKept": len(kept),
        "directionsDropped": stats["dropped"],
        "directionsImputed": stats["imputed"],
        "singleChannelNodes": stats["single"],
        "hist": [[s, c] for s, c in hist],
        "routes": dict(cfg, nominalSat=NOMINAL_SAT, tiers=list(TIERS),
                       stats=route_stats,
                       # pairs[sender role][receiver role][forwarding nodes]
                       pairs=matrix_payload(route_hist)),
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
    kept, adjacency, degrees, stats = parse_graph(FIXTURE)
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

    # Roles. Every route between B, C and D forwards through A, and nothing
    # ever forwards through the leaves, so A is the whole core.
    through = transit_counts(adjacency, 10, DEFAULT_SEED)
    assert through["A"] > 0, dict(through)
    assert through["B"] == 0, dict(through)
    tier = classify_nodes(adjacency, through)
    assert tier["A"] == "core", tier
    assert tier["B"] == "terminal", tier
    # C and D forward for each other over the C-D channel, so they carry some
    # transit without being core.
    assert set(tier.values()) <= {"terminal", "peripheral", "core"}, tier

    # The node tipping the running total past the share stays inside the core.
    only = classify_nodes(adjacency, Counter({"A": 10, "C": 1}))
    assert only["A"] == "core" and only["C"] == "peripheral", only

    # Widest path. B's only gated option to C is A->C (1500 sat); reaching D
    # via A->D is 3960000, and B->A->D->C is capped by D->C at 800.
    wide = widest_within(adjacency, "B", MAX_HOPS)
    assert wide[0]["C"] == 1500, wide[0]
    assert wide[0]["D"] == 3960000, wide[0]
    # Two hops can reach C the long way round, but A->C is still the widest.
    assert wide[1]["C"] == 1500, wide[1]
    # The source's own peers carry no gated channel yet, so they sit at INF and
    # are excluded from sampling as direct payments.
    assert wide[0]["A"] == INF, wide[0]
    # From C, one hop reaches B over A->B (1500), not over B's own A-facing
    # direction: only the forwarder's outbound side is gated.
    lone = widest_within(adjacency, "C", 1)
    assert lone[0]["B"] == 1500, lone[0]

    route_hist, route_stats = sample_matrix(adjacency, tier, 10, 10,
                                            DEFAULT_SEED)
    assert route_stats["sampled"] > 0, route_stats
    assert route_stats["direct"] > 0, route_stats  # A's neighbours are 0 hops
    assert route_stats["tiers"]["core"] == 1, route_stats
    assert all(s in TIERS and d in TIERS for s, d in route_hist), \
        sorted(route_hist)
    for entry in route_hist.values():
        assert sorted(entry["best"]) == list(range(1, MAX_HOPS + 1)), entry
        # Every series covers the same pairs, so the totals must agree.
        n = sum(entry["first"].values())
        for budget, counts in entry["best"].items():
            assert sum(counts.values()) == n, (budget, n)
        # A bigger budget can only help.
        for budget in range(2, MAX_HOPS + 1):
            lo = sorted(entry["best"][budget - 1].elements())
            hi = sorted(entry["best"][budget].elements())
            assert all(a <= b for a, b in zip(lo, hi)), budget

    # Quantisation rounds down to three significant figures and never up.
    assert quantize(0) == 0 and quantize(7) == 7 and quantize(999) == 999
    assert quantize(1500) == 1500, quantize(1500)
    assert quantize(149878) == 149000, quantize(149878)
    assert quantize(3960000) == 3960000, quantize(3960000)
    assert quantize(4294967295) == 4290000000, quantize(4294967295)

    cfg = {"sourcesPerTier": 10, "perDestTier": 10, "seed": DEFAULT_SEED,
           "coreTransitShare": CORE_TRANSIT_SHARE}
    js = render_data_js(kept, route_hist, route_stats, stats, "path/to/f.json",
                        cfg)
    assert js.startswith("window.EDGE_DATA = {") and js.endswith(";\n"), js[:40]
    payload = json.loads(js[len("window.EDGE_DATA = "):-2])
    assert payload["hist"] == [[800, 1], [900, 1], [1500, 2], [3000, 1],
                               [990000, 1], [3960000, 1]], payload["hist"]
    assert payload["source"] == "f.json"
    pairs = payload["routes"]["pairs"]
    assert pairs, payload["routes"]
    for by_dst in pairs.values():
        for entry in by_dst.values():
            assert entry["first"] == sorted(entry["first"]), entry["first"]
            assert sorted(entry["best"]) == [str(h) for h in
                                             range(1, MAX_HOPS + 1)], entry
            for hist_ in entry["best"].values():
                assert hist_ == sorted(hist_), hist_
    print("build_data.py self-test: OK")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("graph", nargs="?", default="mainnet.json",
                        help="describegraph JSON (default: ./mainnet.json)")
    parser.add_argument("--output", default="data.js",
                        help="output JS file (default: ./data.js)")
    parser.add_argument("--transit-sources", type=int,
                        default=DEFAULT_TRANSIT_SOURCES, metavar="N",
                        help="trees used to estimate betweenness "
                             "(default: %(default)s)")
    parser.add_argument("--sources-per-tier", type=int,
                        default=DEFAULT_SOURCES_PER_TIER, metavar="N",
                        help="route-sample sources drawn from each role "
                             "(default: %(default)s)")
    parser.add_argument("--per-dest-tier", type=int,
                        default=DEFAULT_PER_DEST_TIER, metavar="N",
                        help="destinations per source, per role "
                             "(default: %(default)s)")
    parser.add_argument("--core-transit-share", type=float,
                        default=CORE_TRANSIT_SHARE, metavar="F",
                        help="core is the smallest set carrying this share of "
                             "transit (default: %(default)s)")
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
    kept, adjacency, degrees, stats = parse_graph(graph)
    if not kept:
        print("no usable directed policies found", file=sys.stderr)
        return 1
    print(f"kept {len(kept):,} directions ({len(set(kept)):,} distinct values), "
          f"dropped {stats['dropped']:,}, imputed {stats['imputed']:,}, "
          f"single-channel nodes {stats['single']:,}")

    print(f"estimating betweenness over {args.transit_sources:,} trees ...")
    through = transit_counts(adjacency, args.transit_sources, args.route_seed)
    tier = classify_nodes(adjacency, through, args.core_transit_share)
    counts = Counter(tier.values())
    for name in TIERS:
        sel = [n for n in tier if tier[n] == name]
        deg = sorted(degrees[n] for n in sel) or [0]
        print(f"  {name:<11} {counts[name]:>7,} nodes  "
              f"degree p50 {deg[len(deg) // 2]:>5,}")

    print(f"sampling routes from {args.sources_per_tier:,} sources per role ...")
    route_hist, route_stats = sample_matrix(
        adjacency, tier, args.sources_per_tier, args.per_dest_tier,
        args.route_seed)
    for src in TIERS:
        row = [sum(route_hist.get((src, dst), {}).get("first", Counter()).values())
               for dst in TIERS]
        print(f"  {src:<11} -> " + "  ".join(f"{dst} {n:,}"
                                             for dst, n in zip(TIERS, row)))
    print(f"  direct {route_stats['direct']:,}, "
          f"over {MAX_HOPS} hops {route_stats['tooLong']:,}")

    cfg = {"sourcesPerTier": args.sources_per_tier,
           "perDestTier": args.per_dest_tier,
           "transitSources": args.transit_sources,
           "coreTransitShare": args.core_transit_share,
           "seed": args.route_seed}
    with open(args.output, "w") as fh:
        fh.write(render_data_js(kept, route_hist, route_stats, stats,
                                args.graph, cfg))
    print(f"wrote {os.path.getsize(args.output):,} bytes to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
