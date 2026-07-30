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

  // Slots split by percentage of max_accepted_htlcs. Floor general and
  // congestion; protected takes the remainder so the three buckets always sum
  // to maxAcceptedHtlcs (matches restrictions.md's 193/96/194, 45/22/47,
  // 20/10/20).
  function bucketSlotsPct(maxAcceptedHtlcs, generalPct, congestionPct) {
    const general = Math.floor((generalPct * maxAcceptedHtlcs) / 100);
    const congestion = Math.floor((congestionPct * maxAcceptedHtlcs) / 100);
    return {
      general,
      congestion,
      protected: maxAcceptedHtlcs - general - congestion,
    };
  }

  // Slots hard-set to fixed counts, protected taking the remainder. Callers
  // must reject generalSlots + congestionSlots > maxAcceptedHtlcs first;
  // slotsFitType() is the check, and protected would otherwise go negative.
  function bucketSlotsFixed(maxAcceptedHtlcs, generalSlots, congestionSlots) {
    return {
      general: generalSlots,
      congestion: congestionSlots,
      protected: maxAcceptedHtlcs - generalSlots - congestionSlots,
    };
  }

  function slotsFitType(maxAcceptedHtlcs, generalSlots, congestionSlots) {
    return generalSlots + congestionSlots <= maxAcceptedHtlcs;
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

  function satToUsd(sat, priceUsdPerBtc) {
    return (sat / SAT_PER_BTC) * priceUsdPerBtc;
  }

  // Smallest max_htlc (sats) an edge needs so that `frac` of it covers the
  // dollar threshold.
  function requiredBaseSat(thresholdUsd, priceUsdPerBtc, frac) {
    if (!(frac > 0)) return Infinity;
    return usdToSat(thresholdUsd, priceUsdPerBtc) / frac;
  }

  // hist: [[sat, count], ...] ascending by sat.
  // suffix[i]      = number of edges with value >= sats[i].
  // valueSuffix[i] = summed max_htlc of those edges, for weighting an edge by
  //                  the size it advertises rather than one-edge-one-vote.
  function makeCdf(hist) {
    const n = hist.length;
    const sats = new Float64Array(n);
    const suffix = new Float64Array(n + 1);
    const valueSuffix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sats[i] = hist[i][0];
    for (let i = n - 1; i >= 0; i--) {
      suffix[i] = suffix[i + 1] + hist[i][1];
      valueSuffix[i] = valueSuffix[i + 1] + hist[i][0] * hist[i][1];
    }
    return {
      sats,
      suffix,
      valueSuffix,
      total: suffix[0],
      valueTotal: valueSuffix[0],
    };
  }

  // Index of the first entry with value >= requiredSat.
  function lowerBound(cdf, requiredSat) {
    let lo = 0;
    let hi = cdf.sats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf.sats[mid] >= requiredSat) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // Share of edges (0..1) whose value is >= requiredSat.
  function shareAtOrAbove(cdf, requiredSat) {
    if (cdf.total === 0 || requiredSat === Infinity) return 0;
    return cdf.suffix[lowerBound(cdf, requiredSat)] / cdf.total;
  }

  // Share of total advertised max_htlc (0..1) sitting on edges >= requiredSat.
  // The liquidity-weighted counterpart to shareAtOrAbove: big edges carry more
  // of the traffic a payment could route over, so they count for more.
  function valueShareAtOrAbove(cdf, requiredSat) {
    if (!(cdf.valueTotal > 0) || requiredSat === Infinity) return 0;
    return cdf.valueSuffix[lowerBound(cdf, requiredSat)] / cdf.valueTotal;
  }

  // A payment of `sat` clears one hop's general bucket when the edge's base
  // value is at least sat / frac, where frac is the per-peer general
  // allocation scaled by any per-slot oversubscription.
  function perHopRoutability(cdf, sat, frac, weighting) {
    if (!(frac > 0)) return 0;
    const required = sat / frac;
    return weighting === "count"
      ? shareAtOrAbove(cdf, required)
      : valueShareAtOrAbove(cdf, required);
  }

  // A sampled route clears when every channel a general bucket applies to
  // clears. The allocation is the same fraction `frac` of every channel's
  // max_htlc, so the route clears a payment of `sat` exactly when its
  // bottleneck -- the smallest max_htlc among those channels -- is at least
  // sat / frac. routeCdf is built over the sampled bottlenecks for one hop
  // count; routes count once each, since weighting them by size would weight
  // them by the very quantity being tested.
  function routeRoutability(routeCdf, sat, frac) {
    if (!routeCdf || !(frac > 0)) return 0;
    return shareAtOrAbove(routeCdf, sat / frac);
  }

  // One sender-to-receiver cell: two bottleneck series over the same pairs.
  //   first        the route a fee-optimising sender picks — one attempt
  //   best[budget] the widest path available within that many gated hops,
  //                which is where retrying converges
  // Both cover the same population, so they bracket rather than describe
  // different things.
  function makeCellCdfs(cell) {
    const best = {};
    const budgets = (cell && cell.best) || {};
    for (const budget in budgets) best[budget] = makeCdf(budgets[budget]);
    return { first: makeCdf((cell && cell.first) || []), best };
  }

  // pairs[senderRole][receiverRole] -> cell cdfs.
  function makeMatrixCdfs(pairs) {
    const out = {};
    for (const src in pairs) {
      out[src] = {};
      for (const dst in pairs[src]) out[src][dst] = makeCellCdfs(pairs[src][dst]);
    }
    return out;
  }

  // Nearest-rank percentile: the smallest observed value at or below which at
  // least p% of the edges fall. p is 0..100; p=100 gives the largest value.
  function percentileSat(cdf, p) {
    const n = cdf.sats.length;
    if (n === 0 || !(cdf.total > 0)) return NaN;
    const rank = Math.min(cdf.total,
      Math.max(1, Math.ceil((p / 100) * cdf.total)));
    // count of edges <= sats[i] is total - suffix[i + 1], non-decreasing in i.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf.total - cdf.suffix[mid + 1] >= rank) hi = mid;
      else lo = mid + 1;
    }
    return cdf.sats[lo];
  }

  return {
    SAT_PER_BTC,
    bucketSlotsPct,
    bucketSlotsFixed,
    slotsFitType,
    perPeerSlots,
    generalSlotFrac,
    peerGeneralFrac,
    congestionSlotFrac,
    mulberry32,
    channelsToSaturate,
    usdToSat,
    satToUsd,
    requiredBaseSat,
    makeCdf,
    shareAtOrAbove,
    valueShareAtOrAbove,
    perHopRoutability,
    routeRoutability,
    makeCellCdfs,
    makeMatrixCdfs,
    percentileSat,
  };
});
