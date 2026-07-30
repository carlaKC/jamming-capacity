# Channel Jamming Mitigation Explorer

Interactive explorer for the resource-bucket parameters proposed in
[BOLT PR #1280](https://github.com/lightning/bolts/pull/1280) (local resource
conservation), evaluated against the observed mainnet graph.

**Live page: <https://carlakc.github.io/jamming-capacity/>**

## Run it

Try it in your browser at <https://carlakc.github.io/jamming-capacity/>, or run
it locally: open `index.html` — no build step, no server needed.
(`python3 -m http.server` works too if you prefer a URL.)

## What it shows

The page has a **Parameters** row across the top and three result sections
below it — **Channel statistics**, **Channel distribution** and **Channel
percentiles** — each collapsible by its heading.

- **Channel statistics**, per `max_accepted_htlcs`: slots per bucket
  (general / congestion / protected), per-peer general slot allocation
  `k = max(min_slots, ⌊general_slots × pct⌋)`, the expected number of channels
  an attacker needs to saturate the general bucket (coupon collector over the
  random slot assignment), and liquidity limits as a percentage of
  `max_htlc_value_in_flight_msat`.

The channel types (483 / 114 / 50) and BTC prices ($50k / $75k / $100k) are
fixed on the page; `analyze_buckets.py` takes `--channel-types` and `--prices`
to vary them.

**Liquidity** is always split by percentage of `max_htlc_value_in_flight_msat`
— general and congestion, with protected taking the remainder.

**Slots** can be split either way, via the toggle beside the "Bucket slots"
heading:

- **`%`** (default) — a percentage of `max_accepted_htlcs`, so each bucket
  scales with the channel. 40/20 gives the 193/96/194, 45/22/47 and 20/10/20
  splits from the proposal.
- **`fixed`** — hard-set counts that don't scale, 30 and 10 by default.
  Protected takes whatever is left, so only it varies by channel type.

Protected is derived in both modes and never editable. Fixed counts that
wouldn't fit inside a selected channel type are refused rather than clamped:
picking 30 + 10 with a 20-slot type in play raises an error on the page and
exits non-zero on the command line.
- **Channel distribution**: share of mainnet directed edges able to carry a
  single HTLC of at least $X in the general bucket (per-peer liquidity
  allocation) or the congestion bucket (one slot's liquidity), across the three
  BTC prices. Hover a cell for sat values. The dollar thresholds are
  the rows, and are edited in place: `+` on the last row adds one (the table
  re-sorts around it), and hovering a row reveals a `×` to drop it.
- **Channel percentiles**: the inverse question — what the edge at a
  given `max_htlc` percentile can actually forward, in dollars, through one
  general slot, a peer's whole general allocation (k slots), or a congestion
  slot. The corner cell picks the BTC price and the channel type; hover a cell
  for sat values.
- **General-bucket routability**: what share of routes keeps moving through the
  general bucket with no reputation, against payment size. Measured over real
  routes sampled from the graph, not composed from a per-hop probability. A
  3×3 matrix picks who is paying whom — every node is sorted into a routing
  role, and the chart, tiles and heatmap all follow the selected cell. Set the
  payment size by typing it or by dragging across either the chart or the
  heatmap; the shaded band marks the $10–$200 range where everyday payments sit.

At the defaults, a $50 payment at $75k/BTC is routable in general for 9.9% of
terminal→terminal pairs — but only 4.6% get there on the first attempt. Paying a
core node instead takes that band to 30.7% / 12.6%.

The base value per edge is the direction's advertised `max_htlc_msat` — the
observable lower bound on `max_htlc_value_in_flight_msat`. Where a direction
advertises none (about a fifth of them), 99% of channel capacity stands in: the
median advertising direction sets exactly that, and dropping them would compound
along a route and bias the sample towards paths of well-configured nodes.
Directed policies enter the histogram only when the advertising node has more
than one channel (single-channel nodes are assumed to be non-forwarding), though
such nodes are still sampled as route endpoints.

### How routes are sampled

`build_data.py` walks the real graph, and the page reads the result:

- Every node is sorted into a **routing role** by betweenness — how often it
  sits in the middle of somebody else's shortest path:

  | role | nodes | definition |
  |---|---|---|
  | terminal | 12,281 | never an intermediate on anyone's path |
  | peripheral | 2,814 | forwards, but outside the core |
  | core | 661 | the smallest set carrying 90% of all transit |

  Only `terminal` and `core` are defined outright; `peripheral` is the
  remainder. Degree is the obvious axis and is the wrong one — the roles
  overlap heavily in channel count, so a degree threshold misclassifies a large
  minority. Channel size separates nodes better than either, but it is what the
  page then measures, so tiering on it would make the result circular.
- Sampling is **stratified**: equal sources from each role, equal destinations
  per receiver role. Uniform draws would put core-to-core at 0.2% × 0.2% and it
  would never fill in. Every cell gets 8,000–10,000 routes, so cells are
  comparable with each other — but there is no meaningful overall figure to
  read off the matrix.
- Each pair is routed **two ways**, giving a band rather than a point:
  - **first attempt** — shortest hop count, cheapest among equals. Scoring on
    fee alone chases zero-fee channels through five- and six-hop paths, which
    is not what a sender picks. Route choice ignores channel size, exactly as a
    real sender's does, so one attempt walks into small channels.
  - **best available** — the widest path within a six-hop budget, computed by a
    max-min dynamic program over hop count. This is where a sender retrying
    converges, and it is what the topology permits.

  The gap is large: core→core at $1 is 62.8% on the first attempt against 90.0%
  best available. Nothing can aim at the upper figure deliberately, because the
  general-bucket limit is not gossiped — repeated failure is the only signal a
  sender gets — but it is the honest measure of what the network can carry.
- A **hop** is a node that forwards. `A→B→C` is one hop; a direct payment is
  none.
- The route's first channel is dropped — the sender is not forwarding, so no
  general bucket applies to it. This matters: the sender's own channel is the
  single binding constraint on about 44% of routes, and it is systematically
  the smallest one on the path.
- What remains is reduced to the route's **bottleneck**, the smallest
  `max_htlc` among the gated channels.

Because the general allocation is the same fraction `f` of every channel's
`max_htlc`, a route clears a payment `p` exactly when `bottleneck ≥ p / f`. The
bottleneck therefore depends only on the topology, so every bucket parameter on
the page stays live against a frozen route sample.

### Who pays whom

At $50, rows the sender's role and columns the receiver's, as
`best available / first attempt`:

```
                terminal    peripheral          core
terminal        9.9/4.6%     26.4/9.8%    30.7/12.6%
peripheral      9.7/5.4%    24.8/11.7%    28.8/13.9%
core           10.6/5.3%    27.6/11.5%    32.3/13.7%
```

**The receiver dominates.** Along a row (changing who is paid) routability
roughly triples; down a column (changing who pays) it barely moves. That falls
out of the sender's own first channel never being gated: your role only shapes
the route, while theirs sets the last gated channel.

Both series cover the same sampled pairs, so they are directly comparable, and
the heatmap sweeps the hop budget over those same pairs — each row is a longer
route allowance, so the rows nest and more hops never hurts.

## Screenshots

The parameters row and the channel statistics table:

![Explorer overview](page.png)

The distribution table — share of mainnet edges able to carry a single HTLC of
at least $X across BTC prices and channel types:

![HTLC distribution table](htlc_table.png)

The channel percentile table — what each bucket lets the edge at a given
`max_htlc` percentile forward:

![Channel percentile table](percentile_table.png)

The routability visualizer — the share of sampled routes still clearing the
general bucket without reputation:

![General-bucket routability](routability.png)

## Reproduce the numbers on the command line

`analyze_buckets.py` is the headless twin of the page: it runs the same bucket
math over the same filtered graph and prints the three tables you see in the
browser — the per-channel-type metrics, the distribution table and the channel
percentiles. Point it at a `describegraph` dump:

```
python3 analyze_buckets.py mainnet.json
```

All the page's controls are flags (`--general-pct`, `--congestion-pct`,
`--slot-mode`, `--general-slot-pct`, `--congestion-slot-pct`,
`--general-slots`, `--congestion-slots`, `--channel-types`, `--min-slots`,
`--alloc-pct`, `--prices`, `--thresholds`, `--percentiles`,
`--percentile-price`, `--percentile-type`, `--payments`, `--transit-sources`,
`--sources-per-tier`, `--per-dest-tier`, `--core-transit-share`, `--route-pair`,
`--route-seed`);
`--csv PATH` dumps every cell for further plotting. Defaults match the page, so
a bare run reproduces the example screenshots above. It re-samples routes from
the graph rather than reading `data.js`, so with the default seed it reproduces
the page's routability figures exactly.

## Regenerate the data

`data.js` is committed so the page works from a clone. To rebuild it from a
fresh `lncli describegraph` dump:

```
python3 build_data.py mainnet.json --output data.js
```

This also classifies nodes by role and re-samples the routes behind the
routability section (`--transit-sources`, `--sources-per-tier`,
`--per-dest-tier`, `--core-transit-share`, `--route-seed`), which takes about
50 seconds. `--core-transit-share 0.5` gives a much tighter core — the 61 nodes
carrying half of all transit — if you want the roles further apart.

## Tests

```
node math.test.js                    # pure bucket math (browser)
python3 build_data.py --self-test    # graph filtering, imputation, route sampling
python3 analyze_buckets.py --self-test   # command-line bucket math
```
