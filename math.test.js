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

// --- bucketSlots: fixed general/congestion counts, remainder to protected.
// Only protected scales with the channel's max_accepted_htlcs.
eq(M.bucketSlots(483, 30, 10), { general: 30, congestion: 10, protected: 443 }, "483 split");
eq(M.bucketSlots(114, 30, 10), { general: 30, congestion: 10, protected: 74 }, "114 split");
eq(M.bucketSlots(50, 30, 10), { general: 30, congestion: 10, protected: 10 }, "50 split");
eq(M.bucketSlots(40, 30, 10), { general: 30, congestion: 10, protected: 0 }, "exact fit leaves protected empty");
// Channels too small for both fixed buckets fill general first, then congestion.
eq(M.bucketSlots(35, 30, 10), { general: 30, congestion: 5, protected: 0 }, "partial congestion");
eq(M.bucketSlots(20, 30, 10), { general: 20, congestion: 0, protected: 0 }, "general only");

// --- perPeerSlots: k = min(n, max(minSlots, floor(pct*n/100)))
eq(M.perPeerSlots(30, 5, 5), 5, "default k (5-slot floor beats 5% of 30)");
eq(M.perPeerSlots(30, 5, 20), 6, "pct path");
eq(M.perPeerSlots(4, 5, 5), 4, "k capped at n");
eq(M.perPeerSlots(200, 5, 10), 20, "pct path on a large general bucket");

// --- liquidity fractions (of max_htlc_value_in_flight)
approx(M.generalSlotFrac(40, 30), 0.4 / 30, 1e-12, "general per-slot (~1.333%)");
approx(M.peerGeneralFrac(40, 30, 5), (0.4 * 5) / 30, 1e-12, "largest general HTLC (~6.667%)");
approx(M.congestionSlotFrac(20, 10), 0.02, 1e-12, "congestion per slot (2%)");
ok(Number.isNaN(M.generalSlotFrac(40, 0)), "0 general slots -> NaN");
ok(Number.isNaN(M.congestionSlotFrac(20, 0)), "0 congestion slots -> NaN");

// --- channelsToSaturate: MC coupon collector, deterministic seed
between(M.channelsToSaturate(30, 5), 21, 25, "n=30 k=5 (default general bucket, ~23)");
between(M.channelsToSaturate(45, 5), 36, 40, "n=45 k=5 (restrictions.md: 38)");
between(M.channelsToSaturate(20, 5), 12, 15, "n=20 k=5 (restrictions.md: 13)");
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

// --- percentileSat: nearest rank over the same histogram.
// [[100,3],[200,5],[300,2]] -> 100 100 100 200 200 200 200 200 300 300
const pcdf = M.makeCdf([[100, 3], [200, 5], [300, 2]]);
eq(M.percentileSat(pcdf, 0), 100, "p0 -> smallest");
eq(M.percentileSat(pcdf, 10), 100, "p10 -> 1st value");
eq(M.percentileSat(pcdf, 30), 100, "p30 -> 3rd value, still the minimum");
eq(M.percentileSat(pcdf, 31), 200, "p31 -> 4th value");
eq(M.percentileSat(pcdf, 50), 200, "p50 -> 5th value");
eq(M.percentileSat(pcdf, 80), 200, "p80 -> 8th value");
eq(M.percentileSat(pcdf, 81), 300, "p81 -> 9th value");
eq(M.percentileSat(pcdf, 100), 300, "p100 -> largest");
eq(M.percentileSat(M.makeCdf([[42, 7]]), 50), 42, "one distinct value -> that value");
ok(Number.isNaN(M.percentileSat(M.makeCdf([]), 50)), "empty hist -> NaN");

console.log(`math.test.js: ${passed} assertions passed`);
