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

console.log(`math.test.js: ${passed} assertions passed`);
