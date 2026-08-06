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
  // outbound directions in to[]/maxHtlc[]/minHtlc[]/baseMsat[]/ppm[]/cltv[].
  // Only directions that could actually forward are in it -- see build_data.py.

  // Senders cap routes at 20 hops, so a path longer than that is not one
  // anybody would build.
  const MAX_HOPS = 20;

  // LND's RiskFactorBillionths. A hop's time lock is a cost to the sender as
  // well as its fee -- capital sits locked up for cltv_expiry_delta blocks if
  // the payment hangs -- so the route a sender picks minimises
  // fee + amt x cltv x 15 / 1e9 msat, not fee alone.
  const RISK_FACTOR_BILLIONTHS = 15;

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
    const minHtlc = new Float64Array(m);
    const baseMsat = new Float64Array(m);
    const ppm = new Float64Array(m);
    const cltv = new Float64Array(m);
    for (let u = 0; u < n; u++) {
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        // off[v + 1] doubles as the fill cursor for v, leaving off[] as the
        // finished offset array once every edge is placed.
        const slot = off[g.to[e] + 1]++;
        from[slot] = u;
        maxHtlc[slot] = g.maxHtlc[e];
        minHtlc[slot] = g.minHtlc[e];
        baseMsat[slot] = g.baseMsat[e];
        ppm[slot] = g.ppm[e];
        cltv[slot] = g.cltv[e];
      }
    }
    return {
      n, off: off.subarray(0, n + 1), from, maxHtlc, minHtlc, baseMsat, ppm, cltv,
    };
  }

  // What forwarding needSat over a direction costs its sender, in msat: the
  // fee, plus LND's penalty on the time lock it asks for.
  function hopFeeMsat(baseMsat, ppm, needSat) {
    return baseMsat + (needSat * ppm) / 1000;
  }

  function hopWeight(baseMsat, ppm, cltv, needSat) {
    return hopFeeMsat(baseMsat, ppm, needSat) +
      (needSat * cltv * RISK_FACTOR_BILLIONTHS) / 1e6;
  }

  // Whether a direction will forward needSat at all: inside both advertised
  // bounds, above the page's filter, and within whatever share of its
  // max_htlc the bucket admits (frac = 1 for the unrestricted case).
  function hopAdmits(maxHtlc, minHtlc, needSat, frac, minSat) {
    return maxHtlc >= minSat && needSat >= minHtlc && frac * maxHtlc >= needSat;
  }

  // The route a sender would build to dest, from every node at once.
  //
  // Searched backwards, because fees accumulate towards the sender: the amount
  // that must flow over a hop is the amount its far end needs plus the fee the
  // near end charges to forward it. So amt[x] is what x must receive for
  // amountSat to arrive, and one search answers for every possible sender.
  //
  // What is minimised is LND's weight rather than the amount, so dist[] and
  // amt[] are separate: the cheapest route by weight is not always the one
  // carrying the least. The hop cap is enforced during the search rather than
  // applied to the winner afterwards.
  //
  // frac is the share of a channel's max_htlc the bucket admits, applied to
  // every hop. Pass 1 for the unrestricted case.
  function routeCosts(rev, dest, amountSat, frac, minSat) {
    const n = rev.n;
    const dist = new Float64Array(n).fill(Infinity);
    const amt = new Float64Array(n).fill(Infinity);
    const hops = new Int32Array(n).fill(-1);
    dist[dest] = 0;
    amt[dest] = amountSat;
    hops[dest] = 0;
    // Binary min-heap with lazy deletion: an improved node is pushed again and
    // the stale copy is skipped on the way out.
    const keys = [0];
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
      if (topKey > dist[v]) continue;
      // A hop into v would be the (hops[v] + 1)th, and nothing past the cap can
      // appear in a route anybody builds. Like LND, this is judged on the
      // cheapest path to v rather than on every path to it.
      if (hops[v] >= MAX_HOPS) continue;
      const need = amt[v];
      for (let e = rev.off[v]; e < rev.off[v + 1]; e++) {
        if (!hopAdmits(rev.maxHtlc[e], rev.minHtlc[e], need, frac, minSat)) continue;
        const u = rev.from[e];
        const cand = dist[v] +
          hopWeight(rev.baseMsat[e], rev.ppm[e], rev.cltv[e], need);
        if (cand >= dist[u]) continue;
        dist[u] = cand;
        amt[u] = need + hopFeeMsat(rev.baseMsat[e], rev.ppm[e], need) / 1000;
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
    return { amt, hops, dist };
  }

  // Which nodes can pay dest, given a completed backwards search.
  //
  // The sender's own first hop is not bucket-constrained: the bucket applies at
  // a forwarding node's outgoing channel, and the sender forwards nothing. So
  // routeCosts() runs with the bucket applied to every hop -- correct for all
  // of them but the first -- and the first is settled here against the raw
  // max_htlc instead. Among qualifying first hops the cheapest wins.
  //
  // senders is optional: pass a list to score only those nodes. One backwards
  // search answers for every sender at once, so this is the cheap half of a
  // pair sample and there is no reason to walk the whole graph for it.
  function sourceResults(g, dest, res, minSat, senders) {
    const n = g.n;
    const ok = new Uint8Array(n);
    const sent = new Float64Array(n).fill(Infinity);
    const hops = new Int32Array(n).fill(-1);
    const from = senders || null;
    const count = from ? from.length : n;
    for (let i = 0; i < count; i++) {
      const u = from ? from[i] : i;
      if (u === dest) continue;
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        const v = g.to[e];
        const need = res.amt[v];
        if (!isFinite(need)) continue;
        if (res.hops[v] + 1 > MAX_HOPS) continue;
        if (!hopAdmits(g.maxHtlc[e], g.minHtlc[e], need, 1, minSat)) continue;
        if (need >= sent[u]) continue;
        sent[u] = need;
        hops[u] = res.hops[v] + 1;
        ok[u] = 1;
      }
    }
    return { ok, sent, hops };
  }

  // ---------------- sampling nodes ----------------

  // Nodes the filter leaves standing: those with at least one channel at or
  // above the floor. Below it the page treats a channel as absent, so a node
  // with nothing left is out of the sample entirely.
  //
  // Takes either view of the graph, and which one matters: over the forward CSR
  // this is the nodes that can still send, over the reverse it is the ones that
  // can still be paid. Sampling senders from the second would fill the pair
  // sample with nodes that have no way to originate anything.
  function eligibleNodes(view, minSat) {
    const out = [];
    for (let u = 0; u < view.n; u++) {
      for (let e = view.off[u]; e < view.off[u + 1]; e++) {
        if (view.maxHtlc[e] >= minSat) { out.push(u); break; }
      }
    }
    return out;
  }

  // Deterministic 32-bit hash of a node index under a seed.
  function hashNode(u, seed) {
    let h = (u ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  // A random subset of the nodes, drawn by scoring each one with a hash of its
  // own index and keeping the lowest scores.
  //
  // Shuffling the eligible list would do as well for randomness but not for
  // steadiness: a node's score here does not depend on which other nodes are
  // eligible, so moving the filter adds and removes members rather than
  // redrawing the whole sample, and the figures slide instead of jumping.
  function sampleNodes(nodes, count, seed) {
    if (nodes.length <= count) return nodes.slice();
    return nodes
      .map((u) => [hashNode(u, seed), u])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .slice(0, count)
      .map((pair) => pair[1]);
  }

  // ---------------- per-channel forwarding ----------------

  // Which band a channel falls in, against ascending sat thresholds. A channel
  // sitting exactly on a threshold falls to the lower band.
  function bandIndex(sat, thresholds) {
    for (let i = 0; i < thresholds.length; i++) {
      if (sat <= thresholds[i]) return i;
    }
    return thresholds.length;
  }

  // How many surviving channels sit in each band. Depends only on the filter.
  function bandChannelCounts(g, minSat, thresholds) {
    const counts = new Float64Array(thresholds.length + 1);
    for (let e = 0; e < g.to.length; e++) {
      if (g.maxHtlc[e] >= minSat) counts[bandIndex(g.maxHtlc[e], thresholds)]++;
    }
    return counts;
  }

  // Counters for one run: per band, how many forwarding attempts were made,
  // how many the channel could meet unrestricted, and how many it could meet
  // under each of the fractions on offer (one column of the table each).
  function emptyBandTally(bands, cols) {
    const okBucket = [];
    for (let c = 0; c < cols; c++) okBucket.push(new Float64Array(bands));
    return {
      attempts: new Float64Array(bands),
      okBase: new Float64Array(bands),
      okBucket,
      demand: new Float64Array(bands),
      channels: new Float64Array(bands),
    };
  }

  // One destination's contribution to the per-band counters.
  //
  // Every surviving channel u -> v is asked the same question: if a payment
  // bound for dest were handed to u, could this channel carry it onwards? The
  // amount is not the payment but what v must receive for it to land, so a
  // channel deep in the network is asked for more than one beside the
  // destination -- which is the whole reason this routes rather than reading a
  // distribution.
  //
  // An attempt only counts where v can reach dest inside the hop cap. Where it
  // cannot, nothing downstream works and the channel's own size is not what the
  // payment failed on.
  //
  // Every fraction is scored against the same demand, taken off the route a
  // sender builds today. A bucket that emptied the graph would otherwise
  // reroute the payment and change what the channel is asked for, and the two
  // figures in a cell would no longer differ by the bucket alone.
  function tallyBands(g, dest, base, fracs, minSat, thresholds, acc) {
    for (let u = 0; u < g.n; u++) {
      if (u === dest) continue;
      for (let e = g.off[u]; e < g.off[u + 1]; e++) {
        const cap = g.maxHtlc[e];
        if (cap < minSat) continue;
        const v = g.to[e];
        const need = base.amt[v];
        if (!isFinite(need) || base.hops[v] + 1 > MAX_HOPS) continue;
        const b = bandIndex(cap, thresholds);
        const floor = g.minHtlc[e];
        acc.attempts[b]++;
        acc.demand[b] += need;
        if (hopAdmits(cap, floor, need, 1, minSat)) acc.okBase[b]++;
        for (let c = 0; c < fracs.length; c++) {
          if (hopAdmits(cap, floor, need, fracs[c], minSat)) acc.okBucket[c][b]++;
        }
      }
    }
  }

  return {
    SAT_PER_BTC,
    MAX_HOPS,
    RISK_FACTOR_BILLIONTHS,
    reverseGraph,
    hopWeight,
    hopAdmits,
    routeCosts,
    sourceResults,
    eligibleNodes,
    hashNode,
    sampleNodes,
    bandIndex,
    bandChannelCounts,
    emptyBandTally,
    tallyBands,
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
