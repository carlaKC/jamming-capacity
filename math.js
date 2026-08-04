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
  // suffix[i] = number of edges with value >= sats[i].
  function makeCdf(hist) {
    const n = hist.length;
    const sats = new Float64Array(n);
    const suffix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sats[i] = hist[i][0];
    for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + hist[i][1];
    return { sats, suffix, total: suffix[0] };
  }

  // Drop histogram entries below minSat. The page's filter treats those edges
  // as absent from the graph, so every table downstream reads a CDF built from
  // what survives here rather than reweighting the full one.
  function filterHist(hist, minSat) {
    if (!(minSat > 0)) return hist;
    return hist.filter((entry) => entry[0] >= minSat);
  }

  // Summed advertised max_htlc over a histogram. Counting edges and summing
  // what they advertise answer different questions about a filter: the small
  // channels are numerous but hold little, so dropping a fifth of the edges
  // need not drop anything like a fifth of the liquidity.
  function histValueTotal(hist) {
    let total = 0;
    for (const [sat, count] of hist) total += sat * count;
    return total;
  }

  // Log-spaced buckets for the edge histogram: `perDecade` bars per power of
  // ten, covering 1 sat up to 10^decades. Bucket i spans
  // [10^(i/perDecade), 10^((i+1)/perDecade)), so the bars tile the log axis
  // exactly and a filter threshold can cut one of them in half.
  function histogramBuckets(hist, perDecade, decades) {
    const n = perDecade * decades;
    const counts = new Float64Array(n);
    for (const [sat, count] of hist) {
      if (!(sat > 0)) continue;
      const i = Math.min(n - 1, Math.floor(Math.log10(sat) * perDecade));
      counts[i] += count;
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        lo: Math.pow(10, i / perDecade),
        hi: Math.pow(10, (i + 1) / perDecade),
        count: counts[i],
      });
    }
    return out;
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

  // ---------------- routing over the real graph ----------------
  //
  // graph.js ships the topology in CSR form: off[u]..off[u+1] bracket node u's
  // outbound directions in to[]/maxHtlc[]/baseMsat[]/ppm[]. Only directions
  // that could actually forward are in it -- see build_data.py.

  // Senders cap routes at 20 hops, so a path longer than that is not one
  // anybody would build.
  const MAX_HOPS = 20;

  // Incoming-edge view of the same graph, for searching backwards from a
  // destination. Derived data, so it is built here rather than shipped.
  function reverseGraph(g) {
    const n = g.n;
    const m = g.to.length;
    const off = new Int32Array(n + 2);
    for (let i = 0; i < m; i++) off[g.to[i] + 2]++;
    for (let i = 0; i < n; i++) off[i + 2] += off[i + 1];
    const from = new Int32Array(m);
    const maxHtlc = new Float64Array(m);
    const baseMsat = new Float64Array(m);
    const ppm = new Float64Array(m);
    for (let u = 0; u < n; u++) {
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        // off[v + 1] doubles as the fill cursor for v, leaving off[] as the
        // finished offset array once every edge is placed.
        const slot = off[g.to[e] + 1]++;
        from[slot] = u;
        maxHtlc[slot] = g.maxHtlc[e];
        baseMsat[slot] = g.baseMsat[e];
        ppm[slot] = g.ppm[e];
      }
    }
    return { n, off: off.subarray(0, n + 1), from, maxHtlc, baseMsat, ppm };
  }

  // What a node can put into a single payment: its largest outbound max_htlc
  // that survives the filter. A node left at zero has no way to originate one.
  //
  // The largest rather than the total, because the bands are read off the
  // page's channel percentiles, which are percentiles of one edge's advertised
  // max_htlc. Summing a node's channels would compare a total against a
  // single-channel scale.
  function nodePeak(g, minSat) {
    const peak = new Float64Array(g.n);
    for (let u = 0; u < g.n; u++) {
      let best = 0;
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        if (g.maxHtlc[e] >= minSat && g.maxHtlc[e] > best) best = g.maxHtlc[e];
      }
      peak[u] = best;
    }
    return peak;
  }

  // Sort the nodes that can originate into bands at fixed sat thresholds --
  // the whole-graph edge percentiles the Channel percentiles table already
  // uses. thresholds is ascending, so two of them give three bands, and a node
  // sitting exactly on one falls to the lower band.
  //
  // Because the thresholds come from the whole graph they do not move with the
  // filter: raising it empties a band from below rather than redrawing where
  // the bands are, which is what keeps two settings comparable. Each band comes
  // back sorted ascending, which is what lets pickByFraction() hold its
  // positions steady.
  function bandNodes(peak, thresholds) {
    const groups = [];
    for (let i = 0; i <= thresholds.length; i++) groups.push([]);
    const live = [];
    for (let u = 0; u < peak.length; u++) if (peak[u] > 0) live.push(u);
    live.sort((a, b) => peak[a] - peak[b] || a - b);
    for (const u of live) {
      let band = thresholds.length;
      for (let i = 0; i < thresholds.length; i++) {
        if (peak[u] <= thresholds[i]) { band = i; break; }
      }
      groups[band].push(u);
    }
    return { groups, total: live.length };
  }

  // Pick sample members at fixed fractional positions in a rank-sorted band.
  // Drawing fresh members whenever the band changes would make the figures jump
  // between unrelated nodes every time the filter moves; holding the positions
  // still lets the sample slide through the band as it grows or shrinks.
  // Positions can collide in a small band, so the result is deduplicated.
  function pickByFraction(sorted, fracs) {
    const seen = new Set();
    const out = [];
    for (const f of fracs) {
      if (!sorted.length) break;
      const node = sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
      if (!seen.has(node)) { seen.add(node); out.push(node); }
    }
    return out;
  }

  // Evenly-distributed fractions in [0, 1), drawn once from a fixed seed so a
  // reload lands on the same sample.
  function sampleFractions(count, seed) {
    const rand = mulberry32(seed === undefined ? 1280 : seed);
    const out = [];
    for (let i = 0; i < count; i++) out.push(rand());
    return out;
  }

  // Cheapest way to deliver amountSat to dest, from every node at once.
  //
  // Searched backwards, because fees accumulate towards the sender: the amount
  // that must flow over a hop is the amount its far end needs plus the fee the
  // near end charges to forward it. So amt[x] is what x must receive for
  // amountSat to arrive, and amt[x] - amountSat is the fee paid to get there --
  // minimising one minimises the other, which is why there is no second cost
  // array. Fees are non-decreasing in amount, so Dijkstra stays correct even
  // though the edge weights depend on the running total.
  //
  // frac is the share of a channel's max_htlc the bucket admits, so a hop is
  // only usable if frac x max_htlc covers what would flow over it. Pass 1 for
  // the unrestricted case, where only the filter constrains a hop.
  function routeCosts(rev, dest, amountSat, frac, minSat) {
    const n = rev.n;
    const amt = new Float64Array(n).fill(Infinity);
    const hops = new Int32Array(n).fill(-1);
    amt[dest] = amountSat;
    hops[dest] = 0;
    // Binary min-heap with lazy deletion: an improved node is pushed again and
    // the stale copy is skipped on the way out.
    const keys = [amountSat];
    const nodes = [dest];
    while (keys.length) {
      const topKey = keys[0];
      const v = nodes[0];
      const lastKey = keys.pop();
      const lastNode = nodes.pop();
      if (keys.length) {
        keys[0] = lastKey;
        nodes[0] = lastNode;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let s = i;
          if (l < keys.length && keys[l] < keys[s]) s = l;
          if (r < keys.length && keys[r] < keys[s]) s = r;
          if (s === i) break;
          const k = keys[i]; keys[i] = keys[s]; keys[s] = k;
          const d = nodes[i]; nodes[i] = nodes[s]; nodes[s] = d;
          i = s;
        }
      }
      if (topKey > amt[v]) continue;
      const need = amt[v];
      for (let e = rev.off[v]; e < rev.off[v + 1]; e++) {
        const cap = rev.maxHtlc[e];
        if (cap < minSat) continue;
        if (frac * cap < need) continue;
        const u = rev.from[e];
        const cand = need + rev.baseMsat[e] / 1000 + (need * rev.ppm[e]) / 1e6;
        if (cand >= amt[u]) continue;
        amt[u] = cand;
        hops[u] = hops[v] + 1;
        let i = keys.length;
        keys.push(cand);
        nodes.push(u);
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (keys[p] <= keys[i]) break;
          const k = keys[i]; keys[i] = keys[p]; keys[p] = k;
          const d = nodes[i]; nodes[i] = nodes[p]; nodes[p] = d;
          i = p;
        }
      }
    }
    return { amt, hops };
  }

  // Which nodes can pay dest, given a completed backwards search.
  //
  // The sender's own first hop is not bucket-constrained: the bucket applies at
  // a forwarding node's outgoing channel, and the sender forwards nothing. So
  // routeCosts() runs with the bucket applied to every hop -- correct for all
  // of them but the first -- and the first is settled here against the raw
  // max_htlc instead. Among qualifying first hops the cheapest wins, which is
  // the one whose far end needs the least.
  function sourceResults(g, dest, res, minSat, maxHops) {
    const cap = maxHops === undefined ? MAX_HOPS : maxHops;
    const n = g.n;
    const ok = new Uint8Array(n);
    const sent = new Float64Array(n).fill(Infinity);
    const hops = new Int32Array(n).fill(-1);
    for (let u = 0; u < n; u++) {
      if (u === dest) continue;
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        const limit = g.maxHtlc[e];
        if (limit < minSat) continue;
        const v = g.to[e];
        const need = res.amt[v];
        if (!isFinite(need) || limit < need) continue;
        // res.hops[v] is the length of the cheapest path from v, so this drops
        // a pair whose cheapest route is too long rather than searching for the
        // cheapest route within the cap -- see the caveat on the page.
        if (res.hops[v] + 1 > cap) continue;
        if (need >= sent[u]) continue;
        sent[u] = need;
        hops[u] = res.hops[v] + 1;
        ok[u] = 1;
      }
    }
    return { ok, sent, hops };
  }

  return {
    SAT_PER_BTC,
    MAX_HOPS,
    reverseGraph,
    nodePeak,
    bandNodes,
    pickByFraction,
    sampleFractions,
    routeCosts,
    sourceResults,
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
    filterHist,
    histValueTotal,
    histogramBuckets,
    shareAtOrAbove,
    percentileSat,
  };
});
