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

The page has a **Parameters** row across the top, a **Filtering** section under
it, and four result sections below that — **Channel statistics**, **Channel
distribution**, **Channel percentiles** and **General routability** — each
collapsible by its heading.

- **Channel statistics**, per `max_accepted_htlcs`: slots per bucket
  (general / congestion / protected), per-peer general slot allocation
  `k = max(min_slots, ⌊general_slots × pct⌋)`, the expected number of channels
  an attacker needs to saturate the general bucket (coupon collector over the
  random slot assignment), and liquidity limits as a percentage of
  `max_htlc_value_in_flight_msat`.

The channel types (483 / 114 / 50) and the distribution table's three BTC price
columns ($50k / $75k / $100k) are fixed on the page; `analyze_buckets.py` takes
`--channel-types` and `--prices` to vary them.

Separately, **Current price** in the Parameters row sets the one rate the rest
of the page converts sats at — the filter handle's dollar figure and the
percentile table. It is a dropdown of round rates from $50k to $1M, defaulting
to $75,000 / BTC — the exact rate is never the point, only the order of
magnitude that turns sats into money a reader recognises. On the command line
it is `--current-price`, which takes any value.

**Liquidity** is always split by percentage of `max_htlc_value_in_flight_msat`
— general and congestion, with protected taking the remainder.

**Slots** can be split either way, via the toggle beside the "Bucket slots"
heading:

- **`fixed`** (default) — hard-set counts that don't scale, 30 and 10 by
  default. Protected takes whatever is left, so only it varies by channel type.
- **`%`** — a percentage of `max_accepted_htlcs`, so each bucket scales with
  the channel. 40/20 gives the 193/96/194, 45/22/47 and 20/10/20 splits from
  the proposal.

Protected is derived in both modes and never editable. Fixed counts that
wouldn't fit inside a selected channel type are refused rather than clamped:
picking 30 + 10 with a 20-slot type in play raises an error on the page and
exits non-zero on the command line.
- **Channel distribution**: share of mainnet directed edges able to carry a
  single HTLC of at least $X, across the three BTC prices. Hover a cell for sat
  values. The dollar thresholds are the rows, and are edited in place: `+` on
  the last row adds one (the table re-sorts around it), and hovering a row
  reveals a `×` to drop it. Caveats on how the figures are derived sit under
  the table.

  **What the columns are depends on the slot mode.** Fixed slot counts do not
  scale with `max_accepted_htlcs`, so every channel type yields the same
  figures — grouping by type would print one column three times. The columns
  are the three buckets instead, and all of them are readable at once: a single
  general slot, a peer's whole general allocation, and one congestion slot.
  Under percentage slots the buckets do scale with the channel, so the columns
  go back to being the channel types and a row of tabs above the table picks
  which bucket to show. `analyze_buckets.py` splits the same way: one
  by-bucket table under `--slot-mode fixed`, one table per bucket otherwise.

- **Channel percentiles**: the inverse question — what the edge at a given
  `max_htlc` percentile can forward through one general slot, two, a peer's
  whole allocation, or a congestion slot. It reads in the **Current price** set
  in Parameters, which the corner cell states; under percentage slots the
  corner also picks the channel type. Hover a cell for sat values, or a row's
  percentile label for how much of the network's advertised liquidity sits at
  or below that percentile — the smaller half of edges hold about 2% of it, and
  the top 1% hold a third, which is the same count-versus-value gap the filter
  reports.

  Percentiles are taken over the **whole** graph rather than the filtered set,
  so a row means the same edge whatever the filter is doing and the rows stay
  comparable as you move it. Recomputing them over the survivors would make the
  50th percentile a different edge at every setting. Rows the filter excludes
  are greyed instead of dropped, and the boundary is exactly where the filter's
  reported share falls: dropping 20.2% of edges greys every row below the 20th
  percentile, so p10 greys and p25 stays. `analyze_buckets.py` marks the same
  rows `(filtered)`.

- **General routability**: the other three sections ask what a single channel
  can carry. This one asks whether a payment gets all the way across, by
  routing between real node pairs. Nodes are banded by their largest advertised
  `max_htlc` against the **same whole-graph percentiles** the table above
  prints — `edge` to p25 (125,000 sat), `periphery` to p80 (5,630,259 sat),
  `core` above it — and each cell of the 3×3 heatmap is the share of pairs
  that can still pay each other once the general bucket's allocation applies to
  every channel the payment is forwarded over. Hover a cell for the
  unrestricted figure beside it, the gap between them, the pair count and the
  median hop count. The payment size is a dropdown; the bucket tab picks a
  single general slot or a peer's whole allocation.

  Because the band thresholds come off the whole graph they do not move with
  the filter, so two settings stay comparable — the filter empties a band from
  below rather than redrawing where it sits. The default 100,000 sat floor
  lands just under p25, which takes the edge band from 2,387 nodes to 121; a
  1 M floor empties it entirely and the row and column go `n/a`. That is the
  finding rather than a fault: the filter removes precisely the class of node
  the edge band is about. It also makes the bucket nearly free at that floor —
  periphery→periphery is 49.3% against an unrestricted 49.4% — because every
  channel still standing is large enough for the allocation not to bind.

## How routability is computed

Routes are found the way a sender finds them: hops that cannot carry the amount
are dropped first, and the cheapest of what survives wins. A pair counts as
routable if **any** route survives, so the figure is about whether the network
can still carry the payment, not whether one particular path happened to hold.

The search runs **backwards from the destination**, because fees accumulate
towards the sender: the amount that must flow over a hop is what its far end
needs plus the fee the near end charges to forward it. One such search answers
for every possible sender at once, which is why senders are not sampled at all —
every node in a row's band is scored. Only destinations are sampled, 100 per
band on the page and 30 on the command line.

The destination count is what sets the precision. Reachability is close to
all-or-nothing per destination — either a node has a channel big enough to be
paid over or nobody can reach it — so a cell is really an average over
destinations however many senders each is scored against. Ten destinations
quantised every cell to a multiple of 10%; a hundred lands within a couple of
points of where four hundred does. The sample itself is taken at fixed
fractional positions in the rank-sorted band rather than redrawn each time, so
dragging the filter slides the sample through the band instead of jumping it
between unrelated nodes.

**The sender's own first channel is not restricted.** The bucket applies where
a node *forwards*, and the sender forwards nothing, so on `s → n₁ → n₂ → d` the
constrained channels are `(n₁,n₂)` and `(n₂,d)`. A pair that are already direct
peers has no constrained channel at all.

Two caveats specific to this section, both stated on the page. It routes over a
**strict subset** of the edges the rest of the page counts: a direction is only
in the routing graph if it gossiped a policy and is not `disabled`, which is
60,162 of the 96,808 directions the filter reports on. And the 20-hop limit is
applied by finding the cheapest route and dropping it if it runs long, rather
than searching for the cheapest route *within* 20 hops — base fees keep cheap
routes short, so the two should rarely differ.

## Filtering

The **Filtering** section sets a floor on advertised `max_htlc`: edges below it
are excluded from further analysis, treated as absent from the graph rather than
down-weighted. Every table underneath is recomputed over the survivors, so its
percentages are shares of what is left rather than of the whole network. The
filtering matters because some channels are simply too small to forward payments
with any additional restriction placed on them.

**The default floor is 100,000 sat** — about $75 at $75,000/BTC — which is the
cutoff under consideration. A fresh page is therefore already filtered.

Beside the dropdown, the section states what the current floor removes, as both
a share of edges and a share of advertised liquidity. The two are worth reading
together: at the default floor they are 23.8% and 0.12%. Nearly a quarter of the
graph's directed edges advertise under 100,000 sat, and between them they hold
about a thousandth of its advertised liquidity — which is the case for setting
them aside.

Below the control sits a histogram of advertised `max_htlc` across all directed
edges, four bars per power of ten from 1 sat to 1 G sat. Filtered bars grey out.
Because a bar covers a range of values, a floor landing inside one cuts that bar
in two rather than colouring the whole thing by which side its edge falls on; a
rule marks the cut. The handle is labelled in dollars at the current price —
the axis already carries the sat scale, and what a reader wants from the handle
is what the cutoff is worth.

The histogram is also the control. Hovering a bar states its range, how many
edges it holds and what share of the graph that is, and — where the filter cuts
through it — how many of its edges fall each side of the cut. Dragging across
the plot moves the filter, at two significant figures rather than snapped to the
dropdown's presets; the dropdown grows an entry for whatever the drag picks, so
the two controls always agree. Dragging off the left end clears the filter.

The dropdown offers floors from 1 k to 10 M sat, the largest of which still
leaves about an eighth of the edges in view, plus "No filter". A drag can go
further, but stops at the largest advertised `max_htlc` so it can never empty
the graph and leave the tables a wall of `n/a`. On the command line the same
control is `--min-max-htlc SAT`, defaulting to 100000 to match the page.

The base value per edge is the direction's advertised `max_htlc_msat` — the
observable lower bound on `max_htlc_value_in_flight_msat`. Where a direction
advertises none (about a fifth of them), 99% of channel capacity stands in: the
median advertising direction sets exactly that, and dropping them would bias the
histogram towards well-configured nodes.

Every advertising direction enters the histogram, whatever its node's degree:
the Filtering control is the only thing that excludes an edge, so the share it
reports is the whole of what has been set aside. Earlier revisions also dropped
directions advertised by single-channel nodes, on the grounds that a node with
one channel cannot forward; that removed 9,261 of 96,808 directions before any
of the page's own controls saw them.

## Screenshots

The parameters row and the channel statistics table:

![Explorer overview](page.png)

The distribution table — share of mainnet edges able to carry a single HTLC of
at least $X across BTC prices and channel types:

![HTLC distribution table](htlc_table.png)

## Reproduce the numbers on the command line

`analyze_buckets.py` is the headless twin of the page: it runs the same bucket
math over the same filtered graph and prints the same tables you see in the
browser — the per-channel-type metrics, the distribution table and the channel
percentiles. Point it at a `describegraph` dump:

```
python3 analyze_buckets.py mainnet.json
```

All the page's controls are flags (`--general-pct`, `--congestion-pct`,
`--slot-mode`, `--general-slot-pct`, `--congestion-slot-pct`,
`--general-slots`, `--congestion-slots`, `--channel-types`, `--min-slots`,
`--alloc-pct`, `--min-max-htlc`, `--prices`, `--thresholds`, `--percentiles`,
`--current-price`, `--percentile-type`, `--payment-usd`, `--route-dests`,
`--route-seed`);
`--csv PATH` dumps every cell for further plotting. Defaults match the page, so
a bare run reproduces the example screenshots above. It reads the graph dump
directly rather than `data.js`.

The routability heatmap is the only table that walks the graph, and it is most
of the run's few seconds; `--no-routability` skips it. Its `--route-dests`
defaults to 30 against the page's 100, which is what keeps a bare run quick —
raise it to match the page exactly.

## Regenerate the data

`data.js` and `graph.js` are both committed so the page works from a clone. To
rebuild them from a fresh `lncli describegraph` dump:

```
python3 build_data.py mainnet.json --output data.js --graph-output graph.js
```

`data.js` (152 KB) is the per-direction histogram of advertised `max_htlc` that
drives the first three sections. `graph.js` (1.2 MB, 389 KB gzipped) is the
topology the routability section routes over, in CSR form — `off[]` indexing
into `to[]`/`maxHtlc[]`/`baseMsat[]`/`ppm[]`, node indices only, no pubkeys,
since nothing on the page names a node. It is deliberately a smaller set of
directions than the histogram, for the reason given above. Every script tag is
`defer`red, so the topology stays off the parse path without disturbing the
order the files load in.

## Tests

```
node math.test.js                    # pure bucket math (browser)
python3 build_data.py --self-test    # graph filtering and imputation
python3 analyze_buckets.py --self-test   # command-line bucket math
```
