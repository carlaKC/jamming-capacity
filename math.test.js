"use strict";
const assert = require("assert");
const M = require("./math.js");

let passed = 0;
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; }
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function between(x, lo, hi, msg) {
  assert.ok(x >= lo && x <= hi, `${msg}: ${x} not in [${lo}, ${hi}]`); passed++;
}
function approx(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} !~ ${b}`); passed++;
}

// --- bucketSlotsPct: floor general/congestion, remainder to protected.
// Reproduces restrictions.md's tables exactly. This is the default mode.
eq(M.bucketSlotsPct(483, 40, 20), { general: 193, congestion: 96, protected: 194 }, "483 split");
eq(M.bucketSlotsPct(114, 40, 20), { general: 45, congestion: 22, protected: 47 }, "114 split");
eq(M.bucketSlotsPct(50, 40, 20), { general: 20, congestion: 10, protected: 20 }, "50 split");
eq(M.bucketSlotsPct(110, 40, 20), { general: 44, congestion: 22, protected: 44 }, "exact when pct*N/100 is an integer");

// --- bucketSlotsFixed: hard-set counts, remainder to protected.
// Only protected scales with the channel's max_accepted_htlcs.
eq(M.bucketSlotsFixed(483, 30, 10), { general: 30, congestion: 10, protected: 443 }, "483 fixed");
eq(M.bucketSlotsFixed(114, 30, 10), { general: 30, congestion: 10, protected: 74 }, "114 fixed");
eq(M.bucketSlotsFixed(50, 30, 10), { general: 30, congestion: 10, protected: 10 }, "50 fixed");
eq(M.bucketSlotsFixed(40, 30, 10), { general: 30, congestion: 10, protected: 0 }, "exact fit leaves protected empty");

// --- slotsFitType: the guard callers must apply before bucketSlotsFixed.
ok(M.slotsFitType(50, 30, 10), "40 slots fit in 50");
ok(M.slotsFitType(40, 30, 10), "exact fit is allowed");
ok(!M.slotsFitType(39, 30, 10), "one slot short does not fit");
ok(!M.slotsFitType(20, 30, 10), "20-slot channel cannot fund 30 + 10");

// --- perPeerSlots: k = min(n, max(minSlots, floor(pct*n/100)))
eq(M.perPeerSlots(193, 5, 5), 9, "483 default k");
eq(M.perPeerSlots(45, 5, 5), 5, "114 default k (min wins)");
eq(M.perPeerSlots(30, 5, 5), 5, "5-slot floor beats 5% of 30");
eq(M.perPeerSlots(4, 5, 5), 4, "k capped at n");
eq(M.perPeerSlots(200, 5, 10), 20, "pct path");

// --- liquidity fractions (of max_htlc_value_in_flight)
approx(M.generalSlotFrac(40, 193), 0.4 / 193, 1e-12, "general per-slot 483 (~0.207%)");
approx(M.peerGeneralFrac(40, 193, 9), (0.4 * 9) / 193, 1e-12, "483 largest general HTLC (~1.865%)");
approx(M.generalSlotFrac(40, 30), 0.4 / 30, 1e-12, "fixed-mode per-slot (~1.333%)");
approx(M.peerGeneralFrac(40, 30, 5), (0.4 * 5) / 30, 1e-12, "fixed-mode largest general HTLC (~6.667%)");
approx(M.congestionSlotFrac(20, 96), 0.2 / 96, 1e-12, "483 congestion per slot (~0.208%)");
approx(M.congestionSlotFrac(20, 10), 0.02, 1e-12, "fixed-mode congestion per slot (2%)");
ok(Number.isNaN(M.generalSlotFrac(40, 0)), "0 general slots -> NaN");
ok(Number.isNaN(M.congestionSlotFrac(20, 0)), "0 congestion slots -> NaN");

// --- channelsToSaturate: MC coupon collector, deterministic seed
between(M.channelsToSaturate(193, 9), 118, 128, "n=193 k=9 (~123; NOT restrictions.md's 50)");
between(M.channelsToSaturate(45, 5), 36, 40, "n=45 k=5 (restrictions.md: 38)");
between(M.channelsToSaturate(20, 5), 12, 15, "n=20 k=5 (restrictions.md: 13)");
between(M.channelsToSaturate(30, 5), 21, 25, "n=30 k=5 (fixed-mode default, ~23)");
eq(M.channelsToSaturate(10, 20), 1, "k >= n saturates in one channel");
eq(M.channelsToSaturate(45, 5), M.channelsToSaturate(45, 5), "deterministic");
ok(Number.isNaN(M.channelsToSaturate(0, 5)), "n=0 -> NaN");
ok(Number.isNaN(M.channelsToSaturate(45, 0)), "k=0 -> NaN");

// --- conversions
approx(M.usdToSat(10, 50000), 20000, 1e-6, "$10 @ $50k = 20,000 sat");
approx(M.satToUsd(20000, 50000), 10, 1e-9, "20,000 sat @ $50k = $10");
approx(M.satToUsd(M.usdToSat(37, 75000), 75000), 37, 1e-9, "round trip");
approx(M.requiredBaseSat(10, 50000, 0.02), 1000000, 1e-4, "needs 1M sat base");
eq(M.requiredBaseSat(10, 50000, 0), Infinity, "zero frac -> Infinity");
eq(M.requiredBaseSat(10, 50000, NaN), Infinity, "NaN frac -> Infinity");

// --- CDF over the histogram
const cdf = M.makeCdf([[100, 1], [200, 2], [400, 1]]);
eq(cdf.total, 4, "total mass");
eq(M.shareAtOrAbove(cdf, 1), 1, "everything qualifies");
eq(M.shareAtOrAbove(cdf, 100), 1, "inclusive at the minimum");
eq(M.shareAtOrAbove(cdf, 101), 0.75, "past the minimum");
eq(M.shareAtOrAbove(cdf, 200), 0.75, "inclusive at mid");
eq(M.shareAtOrAbove(cdf, 201), 0.25, "past mid");
eq(M.shareAtOrAbove(cdf, 400), 0.25, "top value");
eq(M.shareAtOrAbove(cdf, 401), 0, "nothing qualifies");
eq(M.shareAtOrAbove(cdf, Infinity), 0, "Infinity -> 0");
eq(M.shareAtOrAbove(M.makeCdf([]), 100), 0, "empty hist -> 0");

// --- filterHist: the graph filter drops whole entries, it does not reweight.
const fhist = [[100, 1], [200, 2], [400, 1]];
eq(M.filterHist(fhist, 0), fhist, "no floor -> the same array");
eq(M.filterHist(fhist, -5), fhist, "negative floor -> the same array");
eq(M.filterHist(fhist, 200).length, 2, "floor at 200 keeps 200 and 400");
eq(M.makeCdf(M.filterHist(fhist, 200)).total, 3, "and 3 of the 4 edges");
eq(M.filterHist(fhist, 100).length, 3, "floor is inclusive");
eq(M.filterHist(fhist, 401).length, 0, "floor above everything empties it");
// A filtered CDF renormalises: the survivors are the whole population now.
eq(M.shareAtOrAbove(M.makeCdf(M.filterHist(fhist, 200)), 400), 1 / 3,
  "share is over survivors, not the original total");

// --- histValueTotal: summed advertised max_htlc, the liquidity-side counterpart
// to the edge count. 100x1 + 200x2 + 400x1 = 900.
eq(M.histValueTotal(fhist), 900, "summed advertised value");
eq(M.histValueTotal([]), 0, "empty hist -> 0");
// The point of tracking both: a floor at 200 drops 1 of 4 edges (25%) but only
// 100 of 900 sat (11%), because the dropped edge is the smallest one.
eq(M.makeCdf(M.filterHist(fhist, 200)).total / M.makeCdf(fhist).total, 0.75,
  "three quarters of the edges survive");
approx(M.histValueTotal(M.filterHist(fhist, 200)) / M.histValueTotal(fhist),
  800 / 900, 1e-12, "but eight ninths of the advertised value");

// --- histogramBuckets: log-spaced bars that tile the axis exactly.
const buckets = M.histogramBuckets([[1, 5], [10, 3], [15, 2], [50, 4], [999, 7]], 2, 3);
eq(buckets.length, 6, "2 per decade x 3 decades");
eq(buckets[0].count, 5, "1 sat lands in the first bucket");
eq(buckets[2].lo, 10, "bucket 2 starts at 10^(2/2)");
eq(buckets[2].count, 5, "10 and 15 sat share the lower half-decade [10, 31.6)");
eq(buckets[3].count, 4, "50 sat is the upper half-decade [31.6, 100)");
eq(buckets[5].count, 7, "999 sat lands in the last bucket");
approx(buckets[0].hi, buckets[1].lo, 1e-9, "buckets tile without a gap");
eq(M.histogramBuckets([[1e12, 1]], 2, 3)[5].count, 1, "over-range clamps to last");
eq(M.histogramBuckets([[0, 9]], 2, 3).reduce((a, b) => a + b.count, 0), 0,
  "zero-sat entries have no log position and are skipped");

// --- percentileSat: nearest rank over the same histogram.
// [[100,3],[200,5],[300,2]] -> 100 100 100 200 200 200 200 200 300 300
const pcdf = M.makeCdf([[100, 3], [200, 5], [300, 2]]);
eq(M.percentileSat(pcdf, 0), 100, "p0 -> smallest");
eq(M.percentileSat(pcdf, 10), 100, "p10 -> 1st value");
eq(M.percentileSat(pcdf, 30), 100, "p30 -> 3rd value, still the minimum");
eq(M.percentileSat(pcdf, 31), 200, "p31 -> 4th value");
eq(M.percentileSat(pcdf, 80), 200, "p80 -> 8th value");
eq(M.percentileSat(pcdf, 81), 300, "p81 -> 9th value");
eq(M.percentileSat(pcdf, 100), 300, "p100 -> largest");
ok(Number.isNaN(M.percentileSat(M.makeCdf([]), 50)), "empty hist -> NaN");
// The percentile rows are taken over the whole graph, not the filtered set, so
// that a row means the same edge whatever the filter is doing.
const wide = M.makeCdf([[100, 3], [200, 5], [300, 2]]);
eq(M.percentileSat(wide, 50), M.percentileSat(M.makeCdf([[100, 3], [200, 5], [300, 2]]), 50),
  "percentiles depend only on the histogram handed in");
ok(M.percentileSat(M.makeCdf(M.filterHist([[100, 3], [200, 5], [300, 2]], 200)), 10) !==
  M.percentileSat(wide, 10),
  "filtering first would move the rows -- which is why the page does not");

// --- routing over the real graph -------------------------------------------

// Builds a CSR graph from [from, to, maxHtlc, baseMsat, ppm] rows, the same
// shape build_data.py emits. Rows may be given in any order.
function csr(n, rows) {
  const sorted = [...rows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const off = new Array(n + 1).fill(0);
  for (const [u] of sorted) off[u + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  return {
    n, off,
    to: sorted.map((r) => r[1]),
    maxHtlc: sorted.map((r) => r[2]),
    baseMsat: sorted.map((r) => r[3]),
    ppm: sorted.map((r) => r[4]),
  };
}

// A line: 0 -> 1 -> 2 -> 3, plus a fat shortcut 0 -> 3 and a return leg.
const LINE = csr(4, [
  [0, 1, 1000, 0, 0],
  [1, 2, 1000, 0, 0],
  [2, 3, 1000, 0, 0],
  [0, 3, 10, 0, 0],
  [3, 2, 500, 0, 0],
]);

// --- reverseGraph: the incoming-edge view, offsets and payload intact.
const rev = M.reverseGraph(LINE);
eq(rev.n, 4, "reverse keeps the node count");
eq(Array.from(rev.off), [0, 0, 1, 3, 5], "reverse offsets bracket each node's in-edges");
eq(rev.off[rev.n], LINE.to.length, "reverse holds every edge");
// Node 3 is reached from 2 and from 0; the shortcut keeps its own max_htlc.
eq(Array.from(rev.from.slice(rev.off[3], rev.off[4])).sort(), [0, 2], "3's in-edges");
const shortcut = rev.off[3] + Array.from(rev.from.slice(rev.off[3], rev.off[4])).indexOf(0);
eq(rev.maxHtlc[shortcut], 10, "reverse carries the edge's max_htlc, not its peer's");
eq(rev.off[0], rev.off[1], "node 0 has no in-edges");

// --- routeCosts: reachability and the amount that must flow over each hop.
// Unrestricted (frac 1, no filter), 5 sat fits every hop including the
// shortcut, which is the shortest way from 0 to 3.
{
  const r = M.routeCosts(rev, 3, 5, 1, 0);
  eq(r.amt[3], 5, "the destination needs the payment itself");
  eq(r.amt[0], 5, "zero-fee line: nothing accumulates");
  eq(r.hops[0], 1, "0 reaches 3 over the shortcut in one hop");
  eq(r.hops[1], 2, "1 reaches 3 in two");
}
// At 500 sat the 10-sat shortcut cannot carry it, so 0 falls back to the line.
{
  const r = M.routeCosts(rev, 3, 500, 1, 0);
  eq(r.hops[0], 3, "a hop too small for the amount is not a route");
  ok(isFinite(r.amt[0]), "the long way round still reaches");
}
// The bucket takes a tenth of each hop, so a 1000-sat channel carries 100.
{
  eq(M.routeCosts(rev, 3, 100, 0.1, 0).hops[1], 2, "exactly at the allocation clears");
  ok(!isFinite(M.routeCosts(rev, 3, 101, 0.1, 0).amt[1]),
    "one sat over the allocation does not");
}
// The filter excludes a hop outright, whatever the bucket would have allowed:
// the 10-sat shortcut carries 5 sat happily but is below a 600-sat floor.
{
  const r = M.routeCosts(rev, 3, 5, 1, 600);
  eq(r.hops[2], 1, "2 -> 3 survives a 600-sat floor");
  eq(r.hops[0], 3, "0 loses the shortcut and takes the line instead");
  ok(!isFinite(M.routeCosts(rev, 3, 5, 1, 2000).amt[0]),
    "a floor above every channel disconnects the graph");
}

// --- fees accumulate towards the sender, and steer the route.
// 0 -> 1 -> 2: node 1 charges 1 sat base + 1% to forward.
const FEES = csr(3, [
  [0, 1, 100000, 0, 0],
  [1, 2, 100000, 1000, 10000],
]);
{
  const r = M.routeCosts(M.reverseGraph(FEES), 2, 1000, 1, 0);
  eq(r.amt[2], 1000, "the destination receives the payment");
  eq(r.amt[1], 1011, "1 must receive 1000 + 1 sat base + 10 sat proportional");
  eq(r.amt[0], 1011, "the sender charges itself nothing, so 0 sends what 1 needs");
  eq(r.hops[0], 2, "two hops");
}
// Given two ways round, the cheapest wins even when it is longer.
const CHOICE = csr(4, [
  [0, 1, 100000, 0, 0],
  [1, 3, 100000, 50000, 0],   // one hop, 50 sat base
  [0, 2, 100000, 0, 0],
  [2, 3, 100000, 1000, 0],    // the same length, 1 sat base
]);
{
  const r = M.routeCosts(M.reverseGraph(CHOICE), 3, 1000, 1, 0);
  eq(r.amt[0], 1001, "0 routes via the 1-sat hop, not the 50-sat one");
}

// --- sourceResults: the sender's own first hop is not bucket-constrained.
// 0 -> 1 -> 2, both channels 1000 sat, bucket at 10%. The 1 -> 2 hop must fit
// inside 100 sat, but 0 -> 1 only has to fit inside the raw 1000.
const FIRST = csr(3, [
  [0, 1, 1000, 0, 0],
  [1, 2, 1000, 0, 0],
]);
{
  const g = FIRST;
  const r = M.routeCosts(M.reverseGraph(g), 2, 100, 0.1, 0);
  const s = M.sourceResults(g, 2, r, 0, M.MAX_HOPS);
  eq(s.ok[0], 1, "0 pays 2: its first hop is exempt, the forwarding hop fits");
  eq(s.hops[0], 2, "over two hops");
  eq(s.ok[1], 1, "1 pays 2 directly");
  eq(s.hops[1], 1, "a direct peer is one hop and has no constrained channel");
  eq(s.ok[2], 0, "a node never counts as paying itself");
}
// Raise the amount past what the forwarding hop's allocation admits and 0 is
// cut off, while the direct pair is untouched.
{
  const g = FIRST;
  const r = M.routeCosts(M.reverseGraph(g), 2, 101, 0.1, 0);
  const s = M.sourceResults(g, 2, r, 0, M.MAX_HOPS);
  eq(s.ok[0], 0, "the forwarding hop is one sat short");
  eq(s.ok[1], 1, "the direct pair still clears: no hop is constrained");
}
// The first hop is exempt from the bucket but not from its own max_htlc.
{
  const g = csr(3, [[0, 1, 120, 0, 0], [1, 2, 100000, 0, 0]]);
  const r = M.routeCosts(M.reverseGraph(g), 2, 100, 0.1, 0);
  eq(M.sourceResults(g, 2, r, 0, M.MAX_HOPS).ok[0], 1, "120 sat carries 100");
  const r2 = M.routeCosts(M.reverseGraph(g), 2, 130, 0.1, 0);
  eq(M.sourceResults(g, 2, r2, 0, M.MAX_HOPS).ok[0], 0,
    "the first hop still has to fit the amount in its raw max_htlc");
}

// --- the hop cap drops pairs whose cheapest route is too long.
{
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push([i, i + 1, 100000, 0, 0]);
  const chain = csr(26, rows);
  const r = M.routeCosts(M.reverseGraph(chain), 25, 100, 1, 0);
  eq(r.hops[0], 25, "the chain is 25 hops end to end");
  const s = M.sourceResults(chain, 25, r, 0, M.MAX_HOPS);
  eq(s.ok[0], 0, "25 hops is past the 20-hop cap");
  eq(s.ok[5], 1, "20 hops is not");
  eq(s.hops[5], 20, "and is reported as such");
  eq(s.ok[4], 0, "21 hops is");
}

// --- nodePeak: the largest outbound max_htlc that survives the filter.
{
  const g = csr(3, [
    [0, 1, 1000, 0, 0],
    [0, 2, 200, 0, 0],
    [1, 0, 5000, 0, 0],
  ]);
  eq(Array.from(M.nodePeak(g, 0)), [1000, 5000, 0],
    "the largest channel, not the sum: the bands are a single-channel scale");
  eq(Array.from(M.nodePeak(g, 500)), [1000, 5000, 0], "the 200-sat edge was never the peak");
  eq(Array.from(M.nodePeak(g, 1500)), [0, 5000, 0], "the filter can take a node's only usable edge");
  eq(M.nodePeak(g, 0)[2], 0, "a node with no outbound direction cannot originate");
}

// --- bandNodes: fixed sat thresholds, boundaries falling to the lower band.
// The thresholds are the page's whole-graph edge percentiles, so they do not
// move with the filter.
{
  const peak = Float64Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 0]);
  const { groups, total } = M.bandNodes(peak, [30, 80]);
  eq(total, 10, "the node with no surviving edge is not in the population");
  eq(groups[0], [0, 1, 2], "edge: up to and including the p25 threshold");
  eq(groups[1], [3, 4, 5, 6, 7], "periphery: above it, up to and including p80");
  eq(groups[2], [8, 9], "core: above p80");
  eq(groups[0].concat(groups[1], groups[2]).length, total, "every node lands in one band");
  ok(peak[groups[0][0]] <= peak[groups[0][2]], "bands come back sorted");
}
// Raising the filter empties a band from below rather than redrawing where the
// bands sit -- which is the point of taking the thresholds off the whole graph.
{
  const g = csr(4, [
    [0, 1, 100, 0, 0],
    [1, 2, 5000, 0, 0],
    [2, 3, 9000000, 0, 0],
    [3, 0, 9000000, 0, 0],
  ]);
  const wide = M.bandNodes(M.nodePeak(g, 0), [125000, 5630259]);
  eq(wide.groups.map((b) => b.length), [2, 0, 2], "unfiltered: two small, two large");
  const tight = M.bandNodes(M.nodePeak(g, 125000), [125000, 5630259]);
  eq(tight.groups.map((b) => b.length), [0, 0, 2],
    "a floor at the p25 threshold empties the band below it, leaving the rest put");
  eq(tight.total, 2, "and the emptied nodes leave the population entirely");
}
// Ties on a threshold go downwards, whole.
{
  const peak = Float64Array.from([5, 5, 5, 9]);
  const { groups } = M.bandNodes(peak, [5, 8]);
  eq(groups[0].length, 3, "every node exactly on the threshold falls to the lower band");
  eq(groups[1].length, 0, "which can leave the band above it empty");
  eq(groups[2], [3], "and only the node past the upper threshold");
}
ok(M.bandNodes(Float64Array.from([0, 0]), [25, 80]).groups.every((g) => !g.length),
  "no candidates gives empty bands rather than throwing");

// --- pickByFraction: stable positions in a rank-sorted band.
{
  const band = [11, 22, 33, 44, 55, 66, 77, 88, 99, 110];
  eq(M.pickByFraction(band, [0, 0.5, 0.99]), [11, 66, 110], "position, not value");
  // The same fractions over a band that has shrunk pick neighbours of the old
  // choice rather than an unrelated sample -- which is what keeps the figures
  // steady while the filter is dragged.
  eq(M.pickByFraction(band.slice(0, 5), [0, 0.5, 0.99]), [11, 33, 55], "shrunk band");
  eq(M.pickByFraction([7, 8], [0.1, 0.2, 0.3]), [7], "collisions deduplicate");
  eq(M.pickByFraction([], [0.5]), [], "an empty band picks nothing");
}
eq(M.sampleFractions(4, 7), M.sampleFractions(4, 7), "the sample is seeded, so it is stable");
ok(M.sampleFractions(30, 1280).every((f) => f >= 0 && f < 1), "fractions are in [0, 1)");

console.log(`math.test.js: ${passed} assertions passed`);
