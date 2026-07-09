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

// --- bucketSlots: floor general/congestion, remainder to protected.
// Reproduces restrictions.md's tables exactly.
eq(M.bucketSlots(483, 40, 20), { general: 193, congestion: 96, protected: 194 }, "483 split");
eq(M.bucketSlots(114, 40, 20), { general: 45, congestion: 22, protected: 47 }, "114 split");
eq(M.bucketSlots(50, 40, 20), { general: 20, congestion: 10, protected: 20 }, "50 split");
eq(M.bucketSlots(110, 40, 20), { general: 44, congestion: 22, protected: 44 }, "exact when pct*N/100 is an integer");

// --- perPeerSlots: k = min(n, max(minSlots, floor(pct*n/100)))
eq(M.perPeerSlots(193, 5, 5), 9, "483 default k");
eq(M.perPeerSlots(45, 5, 5), 5, "114 default k (min wins)");
eq(M.perPeerSlots(20, 5, 5), 5, "50 default k (min wins)");
eq(M.perPeerSlots(4, 5, 5), 4, "k capped at n");
eq(M.perPeerSlots(200, 5, 10), 20, "pct path");

// --- liquidity fractions (of max_htlc_value_in_flight)
approx(M.generalSlotFrac(40, 193), 0.4 / 193, 1e-12, "general per-slot 483 (~0.207%)");
approx(M.peerGeneralFrac(40, 193, 9), (0.4 * 9) / 193, 1e-12, "483 largest general HTLC (~1.865%)");
approx(M.generalSlotFrac(40, 20), 0.02, 1e-12, "50: 2% per slot");
approx(M.peerGeneralFrac(40, 20, 5), 0.10, 1e-12, "50: 10% max per peer");
approx(M.congestionSlotFrac(20, 96), 0.2 / 96, 1e-12, "483 congestion per slot (~0.208%)");
ok(Number.isNaN(M.generalSlotFrac(40, 0)), "0 general slots -> NaN");
ok(Number.isNaN(M.congestionSlotFrac(20, 0)), "0 congestion slots -> NaN");

// --- channelsToSaturate: MC coupon collector, deterministic seed
between(M.channelsToSaturate(45, 5), 36, 40, "n=45 k=5 (restrictions.md: 38)");
between(M.channelsToSaturate(20, 5), 12, 15, "n=20 k=5 (restrictions.md: 13)");
between(M.channelsToSaturate(193, 9), 118, 128, "n=193 k=9 (~123; NOT restrictions.md's 50)");
eq(M.channelsToSaturate(10, 20), 1, "k >= n saturates in one channel");
eq(M.channelsToSaturate(45, 5), M.channelsToSaturate(45, 5), "deterministic");
ok(Number.isNaN(M.channelsToSaturate(0, 5)), "n=0 -> NaN");
ok(Number.isNaN(M.channelsToSaturate(45, 0)), "k=0 -> NaN");

// --- conversions
approx(M.usdToSat(10, 50000), 20000, 1e-6, "$10 @ $50k = 20,000 sat");
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

console.log(`math.test.js: ${passed} assertions passed`);
