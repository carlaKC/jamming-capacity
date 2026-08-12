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

// Builds a CSR graph from [from, to, maxHtlc, baseMsat, ppm, minHtlc, cltv]
// rows, the same shape build_data.py emits. The last three default to zero --
// a free hop with no floor and no time lock. Rows may be given in any order.
function csr(n, rows) {
  const sorted = [...rows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const off = new Array(n + 1).fill(0);
  for (const [u] of sorted) off[u + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const col = (i) => sorted.map((r) => r[i] || 0);
  return {
    n, off,
    to: sorted.map((r) => r[1]),
    maxHtlc: col(2),
    baseMsat: col(3),
    ppm: col(4),
    minHtlc: col(5),
    cltv: col(6),
  };
}

// A line: 0 -> 1 -> 2 -> 3, plus a fat shortcut 0 -> 3 and a return leg.
const LINE = csr(4, [
  [0, 1, 1000],
  [1, 2, 1000],
  [2, 3, 1000],
  [0, 3, 10],
  [3, 2, 500],
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
{
  const r = M.reverseGraph(csr(2, [[0, 1, 1000, 5, 6, 7, 8]]));
  eq([r.maxHtlc[0], r.baseMsat[0], r.ppm[0], r.minHtlc[0], r.cltv[0]],
    [1000, 5, 6, 7, 8], "reverse carries every policy field a search reads");
}

// --- hopWeight: LND's fee plus its penalty on the time lock.
// 1000 sat over a 1 sat + 100 ppm hop is 1000 + 100 = 1100 msat of fee; a 144
// block delta adds 1000 * 1000 msat * 144 * 15 / 1e9 = 2.16 msat.
approx(M.hopWeight(1000, 100, 0, 1000), 1100, 1e-9, "no time lock, no penalty");
approx(M.hopWeight(1000, 100, 144, 1000), 1100 + 2.16, 1e-9, "144 blocks of risk");
ok(M.hopWeight(0, 0, 144, 1000) > 0, "a free hop still costs its time lock");

// --- hopAdmits: the things that stop a direction forwarding an amount. A
// channel under the exemption threshold is not excluded; it answers to the
// whole general bucket (exemptFrac) instead of the per-peer column frac.
ok(M.hopAdmits(1000, 0, 1000, 1, 0, 1), "exactly at max_htlc clears");
ok(!M.hopAdmits(1000, 0, 1001, 1, 0, 1), "one sat over does not");
ok(!M.hopAdmits(1000, 500, 400, 1, 0, 1), "under min_htlc is refused");
ok(M.hopAdmits(1000, 500, 500, 1, 0, 1), "exactly at min_htlc clears");
ok(!M.hopAdmits(1000, 0, 500, 0.1, 0, 1), "the bucket admits a tenth of max_htlc");
ok(M.hopAdmits(1000, 0, 300, 0.1, 5000, 0.4),
  "under the threshold the whole bucket applies, not the per-peer slice");
ok(!M.hopAdmits(1000, 0, 500, 0.1, 5000, 0.4),
  "an exempt channel is still held to the whole bucket");
ok(!M.hopAdmits(1000, 0, 500, 0.1, 1000, 1),
  "exactly at the threshold is enforced, not exempt");
ok(!M.hopAdmits(1000, 500, 400, 0.1, 5000, 1),
  "exemption lifts the bucket, not the channel's own min_htlc");

// --- routeCosts: reachability and the amount that must flow over each hop.
// Unrestricted (frac 1, no filter), 5 sat fits every hop including the
// shortcut, which is the shortest way from 0 to 3.
{
  const r = M.routeCosts(rev, 3, 5, 1, 0, 1);
  eq(r.amt[3], 5, "the destination needs the payment itself");
  eq(r.amt[0], 5, "zero-fee line: nothing accumulates");
  eq(r.hops[0], 1, "0 reaches 3 over the shortcut in one hop");
  eq(r.hops[1], 2, "1 reaches 3 in two");
}
// At 500 sat the 10-sat shortcut cannot carry it, so 0 falls back to the line.
{
  const r = M.routeCosts(rev, 3, 500, 1, 0, 1);
  eq(r.hops[0], 3, "a hop too small for the amount is not a route");
  ok(isFinite(r.amt[0]), "the long way round still reaches");
}
// The bucket takes a tenth of each forwarded hop, so a 1000-sat channel
// carries 100 -- but only where the node it enters forwards. The hop into the
// destination is never bucket-constrained: the destination just receives.
{
  eq(M.routeCosts(rev, 3, 100, 0.1, 0, 1).hops[1], 2, "exactly at the allocation clears");
  ok(!isFinite(M.routeCosts(rev, 3, 101, 0.1, 0, 1).amt[1]),
    "one sat over the allocation does not");
  eq(M.routeCosts(rev, 3, 500, 0.1, 0, 1).hops[2], 1,
    "the final hop is not bucket-constrained: raw 1000 carries 500");
  eq(M.routeCosts(rev, 3, 5, 0.1, 0, 1).hops[0], 1,
    "the 10-sat shortcut lands on the destination, so frac does not apply");
  ok(!isFinite(M.routeCosts(rev, 3, 11, 1, 0, 1).amt[0]) ||
    M.routeCosts(rev, 3, 11, 1, 0, 1).hops[0] === 3,
    "the final hop still has to fit the amount in its raw max_htlc");
}
// Below the threshold the whole bucket applies instead of the column's frac.
// The exempt channel must sit on a forwarded hop to be tested at all -- here
// 0 -> 1 is 10 sat and node 1 forwards, so it offers 40% of itself.
{
  const g = csr(3, [[0, 1, 10], [1, 2, 1000]]);
  const rv = M.reverseGraph(g);
  eq(M.routeCosts(rv, 2, 4, 1, 600, 0.4).hops[0], 2,
    "4 sat fits the exempt hop's whole bucket");
  ok(!isFinite(M.routeCosts(rv, 2, 5, 1, 600, 0.4).amt[0]),
    "5 sat does not: the exempt hop only offers 40% of its 10 sat");
  // A threshold above the whole graph exempts every channel, so a column
  // whose own frac would refuse everything still routes.
  eq(M.routeCosts(M.reverseGraph(csr(3, [[0, 1, 1000], [1, 2, 1000]])),
    2, 100, 0.001, 2000, 0.4).hops[0], 2,
    "an exempt hop ignores the per-peer frac entirely");
}
// The page passes exemptFrac = 1: a channel under the threshold assigns all
// of its liquidity to the general bucket and puts no liquidity limit on the
// slots, so a forwarded hop under the threshold admits its full max_htlc.
{
  const g = csr(3, [[0, 1, 1000], [1, 2, 100000]]);
  const rv = M.reverseGraph(g);
  eq(M.routeCosts(rv, 2, 1000, 0.05, 2000, 1).hops[0], 2,
    "an exempt hop admits everything it advertises");
  ok(!isFinite(M.routeCosts(rv, 2, 1000, 0.05, 0, 1).amt[0]),
    "with no threshold the same hop is held to the per-peer frac");
}
// A direction that will not accept the amount at its lower bound is no more
// use than one too small to hold it. 0 -> 3 sets a 50-sat floor, so a 5-sat
// payment goes the long way even though the channel is fat enough.
{
  const g = csr(4, [
    [0, 1, 1000], [1, 2, 1000], [2, 3, 1000], [0, 3, 1000, 0, 0, 50],
  ]);
  const r = M.routeCosts(M.reverseGraph(g), 3, 5, 1, 0, 1);
  eq(r.hops[0], 3, "min_htlc keeps the shortcut out of a small payment's route");
  eq(M.routeCosts(M.reverseGraph(g), 3, 50, 1, 0, 1).hops[0], 1,
    "at the floor itself the shortcut is back");
}

// --- fees accumulate towards the sender, and steer the route.
// 0 -> 1 -> 2: node 1 charges 1 sat base + 1% to forward.
const FEES = csr(3, [
  [0, 1, 100000],
  [1, 2, 100000, 1000, 10000],
]);
{
  const r = M.routeCosts(M.reverseGraph(FEES), 2, 1000, 1, 0, 1);
  eq(r.amt[2], 1000, "the destination receives the payment");
  eq(r.amt[1], 1011, "1 must receive 1000 + 1 sat base + 10 sat proportional");
  eq(r.amt[0], 1011, "the sender charges itself nothing, so 0 sends what 1 needs");
  eq(r.hops[0], 2, "two hops");
}
// Given two ways round, the cheapest wins even when it is longer.
const CHOICE = csr(4, [
  [0, 1, 100000],
  [1, 3, 100000, 50000, 0],   // one hop, 50 sat base
  [0, 2, 100000],
  [2, 3, 100000, 1000, 0],    // the same length, 1 sat base
]);
{
  const r = M.routeCosts(M.reverseGraph(CHOICE), 3, 1000, 1, 0, 1);
  eq(r.amt[0], 1001, "0 routes via the 1-sat hop, not the 50-sat one");
}
// Fees being equal, the route asking for less of the sender's time wins --
// which is what makes this the route a sender picks rather than the cheapest.
{
  const g = csr(4, [
    [0, 1, 10000000], [1, 3, 10000000, 1000, 0, 0, 2016],
    [0, 2, 10000000], [2, 3, 10000000, 1000, 0, 0, 40],
  ]);
  const r = M.routeCosts(M.reverseGraph(g), 3, 1000000, 1, 0, 1);
  eq(r.hops[0], 2, "both ways are two hops and cost the same in fees");
  ok(r.dist[2] < r.dist[1], "the 40-block hop weighs less than the 2016-block one");
  eq(r.amt[0], r.amt[2], "so the sender is routed through 2");
}

// --- sourceResults: reads senders off the completed search. The bucket sits
// on the forwarding node's incoming channel, so the sender's first hop IS
// constrained (its peer forwards) and the final hop into the destination is
// not (the destination just receives).
// 0 -> 1 -> 2, both channels 1000 sat, bucket at 10%. The 0 -> 1 hop must fit
// inside 100 sat; 1 -> 2 lands on the destination and answers to the raw 1000.
const FIRST = csr(3, [
  [0, 1, 1000],
  [1, 2, 1000],
]);
{
  const r = M.routeCosts(M.reverseGraph(FIRST), 2, 100, 0.1, 0, 1);
  const s = M.sourceResults(2, r);
  eq(s.ok[0], 1, "0 pays 2: its first hop fits the allocation exactly");
  eq(s.hops[0], 2, "over two hops");
  eq(s.ok[1], 1, "1 pays 2 directly");
  eq(s.hops[1], 1, "a direct peer is one hop and has no constrained channel");
  eq(s.ok[2], 0, "a node never counts as paying itself");
}
// Raise the amount past what the first hop's allocation admits and 0 is cut
// off, while the direct pair is untouched.
{
  const r = M.routeCosts(M.reverseGraph(FIRST), 2, 101, 0.1, 0, 1);
  const s = M.sourceResults(2, r);
  eq(s.ok[0], 0, "the sender's first hop is one sat over its allocation");
  eq(s.ok[1], 1, "the direct pair still clears: no hop is constrained");
}
// The first hop answers to the bucket like any other forwarded hop: 10% of
// 120 sat is 12, nowhere near 100 -- though the raw channel would carry it.
{
  const g = csr(3, [[0, 1, 120], [1, 2, 100000]]);
  const r = M.routeCosts(M.reverseGraph(g), 2, 100, 0.1, 0, 1);
  eq(M.sourceResults(2, r).ok[0], 0,
    "the first hop is held to the bucket, not its raw max_htlc");
  const r2 = M.routeCosts(M.reverseGraph(g), 2, 100, 1, 0, 1);
  eq(M.sourceResults(2, r2).ok[0], 1, "unrestricted, 120 sat carries 100");
}
// The first hop's own min_htlc still applies: the bucket is one admission
// rule among the advertised ones, not a replacement for them.
{
  const g = csr(3, [[0, 1, 100000, 0, 0, 500], [1, 2, 100000]]);
  const r = M.routeCosts(M.reverseGraph(g), 2, 100, 1, 0, 1);
  eq(M.sourceResults(2, r).ok[0], 0, "100 sat is under the first hop's floor");
}

// --- the hop cap is enforced while searching, not applied to the winner.
{
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push([i, i + 1, 100000]);
  const chain = csr(26, rows);
  const r = M.routeCosts(M.reverseGraph(chain), 25, 100, 1, 0, 1);
  eq(r.hops[5], 20, "5 is 20 hops from the end, which is the cap");
  eq(r.hops[4], -1, "21 hops is past it, so the search never labels 4");
  ok(!isFinite(r.amt[0]), "and nothing beyond that is reached at all");
  const s = M.sourceResults(25, r);
  eq(s.ok[5], 1, "a 20-hop route is one a sender would build");
  eq(s.hops[5], 20, "and is reported as such");
  eq(s.ok[4], 0, "a 21-hop one is not");
  eq(s.ok[0], 0, "nor is the whole 25-hop chain");
}

// --- eligibleNodes: everyone with a channel, in each direction. Nothing is
// excluded any more -- below-threshold channels are exempt, not absent.
{
  const g = csr(4, [
    [0, 1, 1000],
    [1, 0, 1000],
    [2, 3, 200],     // 2 and 3 share nothing but a small channel
    [3, 2, 200],
  ]);
  eq(M.eligibleNodes(g), [0, 1, 2, 3], "every node with a channel is in");
}
// Which view is handed in is the difference between "can send" and "can be
// paid" -- a node with only an inbound channel is a destination and not a
// sender, and sampling it as one would only add pairs that cannot exist.
{
  const g = csr(2, [[0, 1, 1000]]);
  eq(M.eligibleNodes(g), [0], "only 0 has an outbound channel");
  eq(M.eligibleNodes(M.reverseGraph(g)), [1], "only 1 has an inbound one");
}

// --- sampleNodes: a random subset that survives the pool changing.
{
  const pool = [];
  for (let i = 0; i < 200; i++) pool.push(i);
  const pick = M.sampleNodes(pool, 20, 7);
  eq(pick.length, 20, "the requested count comes back");
  eq(pick, M.sampleNodes(pool, 20, 7), "seeded, so a reload lands on the same sample");
  ok(pick.join() !== M.sampleNodes(pool, 20, 8).join(), "a different seed picks differently");
  ok(new Set(pick).size === pick.length, "without replacement");
  // Spread across the pool rather than clustered at one end: the sample is by
  // hash of the node's index, which is unrelated to its position.
  between(pick.filter((u) => u >= 100).length, 4, 16, "both halves of the pool are drawn from");
  // Halving the pool keeps every survivor that was already in the sample --
  // which is what stops the figures jumping when the filter moves.
  const shrunk = M.sampleNodes(pool.filter((u) => u < 100), 20, 7);
  const kept = pick.filter((u) => u < 100);
  ok(kept.every((u) => shrunk.includes(u)),
    "a node's place in the sample does not depend on who else is eligible");
  eq(M.sampleNodes([1, 2, 3], 20, 7), [1, 2, 3], "a pool smaller than the sample is taken whole");
  eq(M.sampleNodes([], 5, 7), [], "an empty pool samples to nothing");
}

// --- nodeOutTotals / nodeTiers: placing a node at the edge, periphery or
// core of the network by the total max_htlc it advertises outward.
{
  const g = csr(4, [
    [0, 1, 1000],
    [0, 2, 500],
    [1, 0, 200],
    [3, 0, 50],
  ]);
  eq(Array.from(M.nodeOutTotals(g)), [1500, 200, 0, 50],
    "a node's total is the sum over its outgoing directions");
}
{
  // Ten nodes advertising 10..100; one advertising nothing. Nearest-rank
  // cuts over the advertisers: p15 = 20, p25 = 30, p50 = 50, p75 = 80.
  const totals = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const t = M.nodeTiers(totals);
  eq(Array.from(t.cuts), [20, 30, 50, 80],
    "cuts at p15 / p25 / p50 / p75 of advertisers");
  eq(Array.from(t.tier), [-1, 0, 0, 1, 2, 2, 3, 3, 3, 4, 4],
    "0 advertised is outside every tier; cuts fall to the lower tier");
}
{
  // The bottom tier starts at p0: any advertiser lands somewhere, however
  // small, and only a node advertising nothing is out of the sample.
  const t = M.nodeTiers([5, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  eq(t.tier[0], 0, "the smallest advertiser is still edgelord");
  eq(t.tier[1], 0, "ties spanning the cuts fall together");
}
// --- shareAdmitting: the distribution table's two-segment share. Edges at or
// above the threshold answer to the column's frac, edges below it to the
// whole bucket, and the denominator is every edge in the histogram.
{
  const c = M.makeCdf([[100, 1], [200, 2], [400, 1]]);
  eq(M.shareAdmitting(c, 100, 1, 0, 1), 1, "no exemption, frac 1: shareAtOrAbove");
  eq(M.shareAdmitting(c, 100, 0.5, 0, 1), 0.75, "no exemption: needs max_htlc >= 200");
  eq(M.shareAdmitting(c, 150, 0.5, 0, 1), 0.25, "no exemption: needs max_htlc >= 300");
  eq(M.shareAdmitting(c, 150, 0.5, 300, 1), 0.75,
    "exemption rescues the 200s: below 300 the whole channel counts");
  eq(M.shareAdmitting(c, 150, 0.5, 300, 0.5), 0.25,
    "an exempt edge is still held to the whole bucket's frac");
  eq(M.shareAdmitting(c, 100, 0.1, 200, 1), 0.25,
    "edges exactly at the threshold are enforced, not exempt");
  eq(M.shareAdmitting(c, 100, NaN, 300, 1), 0.75,
    "a column with no frac still shows what the exempt edges carry");
  eq(M.shareAdmitting(M.makeCdf([]), 100, 1, 0, 1), 0, "empty hist -> 0");
}

console.log(`math.test.js: ${passed} assertions passed`);
