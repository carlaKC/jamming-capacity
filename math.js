/* Pure bucket math for the BOLT PR #1280 jamming mitigation explorer.
 * Loaded in the browser as window.BucketMath and in node via require. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BucketMath = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SAT_PER_BTC = 100000000;

  // Floor general and congestion; protected takes the remainder so the
  // three buckets always sum to maxAcceptedHtlcs (matches restrictions.md's
  // 193/96/194, 45/22/47, 20/10/20).
  function bucketSlots(maxAcceptedHtlcs, generalPct, congestionPct) {
    const general = Math.floor((generalPct * maxAcceptedHtlcs) / 100);
    const congestion = Math.floor((congestionPct * maxAcceptedHtlcs) / 100);
    return {
      general,
      congestion,
      protected: maxAcceptedHtlcs - general - congestion,
    };
  }

  // Per-peer general slot allocation: max(minSlots, floor(pct% of n)),
  // capped at n. Spec default: max(5, n*5/100).
  function perPeerSlots(generalSlots, minSlots, allocPct) {
    const byPct = Math.floor((allocPct * generalSlots) / 100);
    return Math.min(generalSlots, Math.max(minSlots, byPct));
  }

  // Fraction of max_htlc_value_in_flight held by one general slot.
  function generalSlotFrac(generalPct, generalSlots) {
    if (generalSlots <= 0) return NaN;
    return generalPct / 100 / generalSlots;
  }

  // Largest single HTLC in general = the whole per-peer liquidity
  // allocation (k slots' worth).
  function peerGeneralFrac(generalPct, generalSlots, k) {
    return generalSlotFrac(generalPct, generalSlots) * k;
  }

  // Largest HTLC admitted to congestion: amount < capacity / slots,
  // i.e. one slot's worth of the congestion bucket.
  function congestionSlotFrac(congestionPct, congestionSlots) {
    if (congestionSlots <= 0) return NaN;
    return congestionPct / 100 / congestionSlots;
  }

  // Deterministic PRNG so the saturation figure is stable across renders.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Expected number of channels to cover all n general slots when each
  // channel is deterministically assigned k unique uniformly-random slots
  // (PR #1280's ChaCha20 assignment ~ random k-subsets; coupon collector
  // with group drawings). Monte Carlo because exact inclusion-exclusion is
  // numerically unstable around n = 193.
  function channelsToSaturate(n, k, trials, seed) {
    if (!(n > 0) || !(k > 0)) return NaN;
    if (k >= n) return 1;
    trials = trials || 3000;
    const rand = mulberry32(seed === undefined ? 42 : seed);
    const slots = new Int32Array(n);
    let total = 0;
    for (let t = 0; t < trials; t++) {
      const covered = new Uint8Array(n);
      let coveredCount = 0;
      let channels = 0;
      for (let i = 0; i < n; i++) slots[i] = i;
      while (coveredCount < n) {
        channels++;
        // Partial Fisher-Yates: the first k entries become this
        // channel's unique slot assignment.
        for (let i = 0; i < k; i++) {
          const j = i + Math.floor(rand() * (n - i));
          const tmp = slots[i];
          slots[i] = slots[j];
          slots[j] = tmp;
          if (!covered[slots[i]]) {
            covered[slots[i]] = 1;
            coveredCount++;
          }
        }
      }
      total += channels;
    }
    return total / trials;
  }

  function usdToSat(usd, priceUsdPerBtc) {
    return (usd / priceUsdPerBtc) * SAT_PER_BTC;
  }

  // Smallest max_htlc (sats) an edge needs so that `frac` of it covers the
  // dollar threshold.
  function requiredBaseSat(thresholdUsd, priceUsdPerBtc, frac) {
    if (!(frac > 0)) return Infinity;
    return usdToSat(thresholdUsd, priceUsdPerBtc) / frac;
  }

  // hist: [[sat, count], ...] ascending by sat.
  // suffix[i] = number of edges with value >= sats[i].
  function makeCdf(hist) {
    const n = hist.length;
    const sats = new Float64Array(n);
    const suffix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sats[i] = hist[i][0];
    for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + hist[i][1];
    return { sats, suffix, total: suffix[0] };
  }

  // Share of edges (0..1) whose value is >= requiredSat.
  function shareAtOrAbove(cdf, requiredSat) {
    if (cdf.total === 0 || requiredSat === Infinity) return 0;
    let lo = 0;
    let hi = cdf.sats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf.sats[mid] >= requiredSat) hi = mid;
      else lo = mid + 1;
    }
    return cdf.suffix[lo] / cdf.total;
  }

  return {
    SAT_PER_BTC,
    bucketSlots,
    perPeerSlots,
    generalSlotFrac,
    peerGeneralFrac,
    congestionSlotFrac,
    mulberry32,
    channelsToSaturate,
    usdToSat,
    requiredBaseSat,
    makeCdf,
    shareAtOrAbove,
  };
});
