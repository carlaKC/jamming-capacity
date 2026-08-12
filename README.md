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

- **General routability**: the other three sections ask what a channel can
  carry in the abstract. This one asks what real payments ask of it, by routing
  between node pairs drawn at random and reading the demand off the routes.

  Rows are **channels**, banded by their own advertised `max_htlc` against the
  **same whole-graph percentiles** the table above prints — `≤ p10`,
  `p10–p25` … `> p99`. Each cell carries two figures: large, the share of those
  channels that can forward what the payment asks of them once the general
  bucket's allocation applies; underneath in small type, the share that could
  with no bucket at all. **The gap between the two is what the proposal costs.**
  A low pair of figures is the graph's doing; a wide gap is the bucket's. Hover
  a cell for the channel count, the number of forwarding attempts behind it and
  the average amount asked.

  The last row leaves the channels and asks whether the payment gets all the
  way across: the share of sampled sender/receiver pairs that still find a
  route once every hop they forward over is held to its allocation.

  The payment size is a dropdown. Columns follow the distribution table's rule —
  the two general buckets under fixed slots, the channel types under percentage
  slots with the tab row picking the bucket.

  At the default settings the table says something quite sharp. A $50 payment
  is 66,667 sat; one general slot of a 30-slot bucket is 1.33% of a channel, so
  it takes a 5 M sat channel to clear it and **every band up to p75 reads
  0.0%** — against 99.9–100% unrestricted. A peer's whole allocation is 6.67%,
  which needs 1 M sat, and the p50–p75 band jumps to 99.8%. End to end, 96.8%
  of sampled pairs can pay each other today, 59.8% can through a whole general
  allocation and 26.8% through a single general slot.

  Because the band thresholds come off the whole graph they do not move with
  the filter, so two settings stay comparable — the filter empties a band from
  below rather than redrawing where it sits. The default 100,000 sat floor
  empties `≤ p10` outright and leaves 658 of the p10–p25 band; emptied rows grey
  out, exactly as in the percentile table. That is the finding rather than a
  fault: the filter removes precisely the channels that could not forward
  anything once restricted.

## How routability is computed

**Senders and destinations are drawn at random** from the nodes the filter
leaves standing — a node with no channel at or above the floor has nothing the
page considers usable, so it is out of the sample as a sender, as a receiver and
as somewhere a route could pass through. The two pools differ: a sender needs a
channel it can send over and a destination one it can be paid over, and 16,475
disabled directions mean plenty of nodes have only the one. At the default floor
that is 5,936 nodes that can send and 4,493 that can be paid.

The sample is drawn by hashing each node's own index and keeping the lowest
scores. A node's place in it therefore does not depend on which other nodes are
eligible, so moving the filter adds and removes members rather than redrawing
the sample, and the figures slide rather than jump.

Routes are found **the way a sender finds them**: LND's weighting, minimising
fee plus a penalty on each hop's time lock (`amt × cltv_delta × 15 / 1e9` msat),
over hops that will accept the amount — inside `min_htlc` and `max_htlc`, above
the filter, and within 20 hops, which is enforced while searching rather than
applied to the winner afterwards.

The search runs **backwards from the destination**, because fees accumulate
towards the sender: the amount that must flow over a hop is what its far end
needs plus the fee the near end charges to forward it. One such search answers
for every possible sender at once, which is why senders are nearly free and
destinations are what set the cost.

**What a channel is asked to forward** is the payment plus every fee charged
downstream of it, read straight off that search. So a channel deep in the
network is asked for more than one sitting beside the destination, which is the
whole reason this section routes rather than reading a distribution. A channel
`u → v` counts an attempt for every sampled destination `v` can reach inside the
hop cap; where it cannot, nothing downstream works and the channel's own size is
not what the payment failed on. Every channel is scored against every
destination, so a band's figure is both "share of attempts" and "mean over
channels of the share of destinations it can serve" — which is what lets the
cell be read as a share of channels.

The demand is measured **unrestricted** for both figures in a cell. Under the
bucket a payment might reroute and be asked for slightly more; holding the
demand fixed is what makes the two figures differ by the bucket alone rather
than by the bucket plus a change of route.

**The final channel into the destination is not restricted.** The bucket sits
on the *incoming* channel of a node that forwards — an HTLC occupies that
channel's resources for as long as it is in flight, and the forward is what
commits them — so a channel is constrained exactly when the node at its far end
forwards. On `s → n₁ → n₂ → d` the constrained channels are `(s,n₁)`, checked
by n₁, and `(n₁,n₂)`, checked by n₂; `(n₂,d)` is never checked, because d only
receives. The sender's own first channel therefore *is* restricted — by its
peer, not by itself — and a pair that are already direct peers has no
constrained channel at all.

The band rows need very little sampling — every surviving channel is scored
against every destination, so a cell averages millions of attempts and is steady
to a tenth of a point by forty destinations. It is the end-to-end row that wants
them, because reachability is close to all-or-nothing per destination: either a
node can be paid or nobody can reach it, whichever sender is asked. That row
still moves by three points at a hundred destinations and settles by 150, which
is what the page uses, at ~500 ms. The command line takes 30 by default, and 400
senders on the page against 200 there.

One caveat specific to this section, stated on the page. It routes over a
**strict subset** of the edges the rest of the page counts: a direction is only
in the routing graph if it gossiped a policy and is not `disabled`, which is
60,162 of the 96,808 directions the filter reports on.

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
`--route-senders`);
`--csv PATH` dumps every cell for further plotting. Defaults match the page, so
a bare run reproduces the example screenshots above. It reads the graph dump
directly rather than `data.js`.

The routability table is the only one that walks the graph, and it is most of
the run's few seconds; `--no-routability` skips it. Its `--route-dests` defaults
to 30 against the page's 150, which is what keeps a bare run quick. The band
rows land on the page's figures either way; it is the end-to-end row that wants
destinations, so raise it to match the page exactly.

## Regenerate the data

`data.js` and `graph.js` are both committed so the page works from a clone. To
rebuild them from a fresh `lncli describegraph` dump:

```
python3 build_data.py mainnet.json --output data.js --graph-output graph.js
```

`data.js` (152 KB) is the per-direction histogram of advertised `max_htlc` that
drives the first three sections. `graph.js` (1.5 MB, 299 KB gzipped) is the
topology the routability section routes over, in CSR form — `off[]` indexing
into `to[]`/`maxHtlc[]`/`minHtlc[]`/`baseMsat[]`/`ppm[]`/`cltv[]`, node indices
only, no pubkeys, since nothing on the page names a node. `min_htlc` and
`cltv_expiry_delta` are in there because the section routes the way a sender
routes: a hop is only usable if the amount is inside both of its advertised
bounds, and the cheapest route weighs fee against time lock rather than fee
alone. It is deliberately a smaller set of
directions than the histogram, for the reason given above. Every script tag is
`defer`red, so the topology stays off the parse path without disturbing the
order the files load in.

## Tests

```
node math.test.js                    # pure bucket math (browser)
python3 build_data.py --self-test    # graph filtering and imputation
python3 analyze_buckets.py --self-test   # command-line bucket math
```
