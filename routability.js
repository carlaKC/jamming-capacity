/* General routability section.
 *
 * One question, asked of the network's shape: who can pay whom once the
 * general bucket's allocation applies? Nodes are placed at the edge,
 * periphery or core of the network by the total max_htlc they advertise
 * outward — edge is p10–p25 of advertisers, periphery p25–p75, core p75 and
 * up — and the matrix reports, for each sender-tier / destination-tier pair,
 * the share of sampled payments that still find a route.
 *
 * This reads the real topology (graph.js) rather than a distribution, because
 * what a route asks of each channel is not the payment but the payment plus
 * every fee charged downstream of it. Channels under the page's threshold
 * enforce no per-peer rules — they admit up to the whole general bucket — and
 * nodes under the p10 cut are never sampled as endpoints but stay in the
 * graph, where the router uses them only when they can carry the amount.
 *
 * All routing lives in math.js; this file owns the section's own state
 * (payment amount, channel type) and its rendering. app.js hands it the
 * current parameters on every render.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RoutabilityView = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Round payment sizes spanning what Lightning actually carries, from a tip
  // to a large transfer. The same list the distribution table uses for rows.
  const PAY_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
  const DEFAULT_PAY_USD = 10;

  const TIER_NAMES = ["edgelord", "edge", "periphery", "center", "core"];
  const TIER_RANGES = ["p0 – p15", "p15 – p25", "p25 – p50", "p50 – p75", "p75 – p100"];
  const N_TIERS = TIER_NAMES.length;

  // How many nodes to draw from each tier. Destinations set the cost: each is
  // two searches (mitigated and unrestricted). Senders are nearly free, since
  // one backwards search answers for all of them at once, so the pair count
  // comes cheaply from that side: 250 senders x 60 destinations per tier pair.
  const DESTS_PER_TIER = 60;
  const SENDERS_PER_TIER = 250;
  const DEST_SEED = 1280;
  const SENDER_SEED = 8080;

  const state = {
    payUsd: DEFAULT_PAY_USD,
    type: null,          // channel type under percentage slots
  };

  let M = null;
  let G = null;            // forward CSR, straight off graph.js
  let REV = null;          // incoming-edge view, built once
  let TIERS = null;        // node tiers and per-tier samples, fixed per graph
  let params = null;       // { typeMetrics, channelTypes, slotMode, price,
                           //   minHtlcSat, exemptFrac }
  let fmt = null;
  let tip = null;
  let mounted = false;

  // Bumped on every recompute so a run superseded mid-flight stops instead of
  // painting stale figures over the one behind it.
  let runId = 0;
  let timer = null;
  let lastKey = null;
  let lastResult = null;

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Yield often enough that the page stays responsive, but not once per
  // search: a timer per destination would cost more in clamped setTimeout
  // delays than the searches themselves.
  const YIELD_MS = 16;
  let lastYield = 0;
  function maybeYield() {
    const now = Date.now();
    if (now - lastYield < YIELD_MS) return null;
    lastYield = now;
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ---------------- tiers ----------------

  // Placement depends only on the graph, so it is built once at mount. A
  // sender needs its advertised liquidity (which implies an outgoing
  // channel); a destination additionally needs a channel it can be paid over.
  function buildTiers() {
    const totals = M.nodeOutTotals(G);
    const { tier, cuts } = M.nodeTiers(totals);
    const senders = TIER_NAMES.map(() => []);
    const dests = TIER_NAMES.map(() => []);
    for (let u = 0; u < G.n; u++) {
      const t = tier[u];
      if (t < 0) continue;
      senders[t].push(u);
      if (REV.off[u + 1] > REV.off[u]) dests[t].push(u);
    }
    TIERS = {
      cuts,
      counts: senders.map((s) => s.length),
      senders: senders.map((s) => M.sampleNodes(s, SENDERS_PER_TIER, SENDER_SEED)),
      dests: dests.map((d) => M.sampleNodes(d, DESTS_PER_TIER, DEST_SEED)),
    };
    TIERS.allSenders = TIERS.senders.flat();
  }

  // ---------------- parameters ----------------

  // Under fixed slots every channel type carries the same bucket fracs; under
  // percentage slots they scale with the type, so the controls grow a
  // selector and the largest type is the default.
  function chanType() {
    if (params.slotMode === "fixed" || !params.channelTypes.includes(state.type)) {
      return Math.max(...params.channelTypes);
    }
    return state.type;
  }

  // A payment succeeds if the general bucket can route it using any number
  // of slots, so the mitigated figure holds each hop to the whole per-peer
  // allocation -- k slots' worth of the general bucket. The bucket sits on
  // the forwarding node's incoming channel, so every hop is constrained
  // except the one into the destination, which only receives.
  const mitigatedFrac = () => params.typeMetrics(chanType()).peerGeneralFrac;
  const amountSat = () => M.usdToSat(state.payUsd, params.price);

  // ---------------- computation ----------------

  function emptyCells() {
    const cells = [];
    for (let s = 0; s < N_TIERS; s++) {
      cells.push(TIER_NAMES.map(() => ({
        pairs: 0, ok: 0, okBucket: 0, okBase: 0,
        hops: new Int32Array(M.MAX_HOPS + 1),
      })));
    }
    return cells;
  }

  async function compute(id) {
    const exemptSat = params.minHtlcSat;
    const exemptFrac = params.exemptFrac;
    const amount = amountSat();
    const frac = mitigatedFrac();
    const cells = emptyCells();

    for (let d = 0; d < N_TIERS; d++) {
      for (const dest of TIERS.dests[d]) {
        if (id !== runId) return null;
        // Three searches per destination, one per rung of the ladder: what
        // routes with no mitigation at all; what fits inside the general
        // bucket's liquidity share alone (the whole allocation, no slot
        // division, so the exemption threshold changes nothing); and what
        // survives the full per-peer slot allocation. Each answers for every
        // sampled sender at once.
        const base = M.routeCosts(REV, dest, amount, 1, 0, 1);
        const baseSrc = M.sourceResults(dest, base, TIERS.allSenders);
        const inBucket = exemptFrac > 0
          ? M.routeCosts(REV, dest, amount, exemptFrac, 0, 1)
          : null;
        const bucketSrc = inBucket
          ? M.sourceResults(dest, inBucket, TIERS.allSenders) : null;
        const res = frac > 0
          ? M.routeCosts(REV, dest, amount, frac, exemptSat, exemptFrac)
          : null;
        const src = res ? M.sourceResults(dest, res, TIERS.allSenders) : null;
        for (let s = 0; s < N_TIERS; s++) {
          const cell = cells[s][d];
          for (const u of TIERS.senders[s]) {
            if (u === dest) continue;
            cell.pairs++;
            if (baseSrc.ok[u]) cell.okBase++;
            if (bucketSrc && bucketSrc.ok[u]) cell.okBucket++;
            if (src && src.ok[u]) {
              cell.ok++;
              cell.hops[src.hops[u]]++;
            }
          }
        }
        const pause = maybeYield();
        if (pause) await pause;
      }
    }
    return {
      cells, frac, amount, exemptSat, exemptFrac, price: params.price,
      cuts: TIERS.cuts, counts: TIERS.counts,
      senders: TIERS.senders.map((s) => s.length),
      dests: TIERS.dests.map((d) => d.length),
    };
  }

  // Hop count of the middle successful pair, read off a hop histogram.
  function medianHops(hist, total) {
    if (!total) return NaN;
    let seen = 0;
    for (let h = 0; h < hist.length; h++) {
      seen += hist[h];
      if (seen >= total / 2) return h;
    }
    return NaN;
  }

  // ---------------- rendering ----------------

  // Three figures in one cell, one per rung of the mitigation: the big one
  // is the full per-peer slot allocation, under it the bucket's liquidity
  // share alone, and under that the bare graph. Reading down a cell separates
  // what the bucket costs from what the slot division on top of it costs --
  // and a low figure with a low floor underneath is the graph's doing, not
  // the mitigation's.
  function threeFigureCell(td, share, bucket, base) {
    if (!isFinite(share) || !isFinite(base)) {
      td.textContent = "n/a";
      td.classList.add("na");
      return td;
    }
    td.appendChild(el("span", "cell-main", fmt.pct(share, 1)));
    if (isFinite(bucket)) {
      td.appendChild(el("span", "cell-sub", fmt.pct(bucket, 1) + " in bucket"));
    }
    td.appendChild(el("span", "cell-sub", fmt.pct(base, 1) + " no mitigation"));
    params.shade(td, share);
    return td;
  }

  // The tier cuts are node totals in sat; shown as money so a reader can
  // place a node without knowing the percentiles by heart.
  function tierUsdRange(cuts, price, i) {
    if (!(price > 0) || !isFinite(cuts[0])) return null;
    const usd = (sat) => fmt.usdCompact(M.satToUsd(sat, price));
    if (i === 0) return "≤ " + usd(cuts[0]);
    if (i >= cuts.length) return "> " + usd(cuts[cuts.length - 1]);
    return usd(cuts[i - 1]) + " – " + usd(cuts[i]);
  }

  function tierHead(cls, name, i, result) {
    const th = el("th", cls);
    th.appendChild(el("span", "band-name", name));
    th.appendChild(el("span", "band-range", TIER_RANGES[i]));
    const range = tierUsdRange(result.cuts, result.price, i);
    if (range) th.appendChild(el("span", "band-range", range));
    return th;
  }

  function renderTable(result) {
    const table = el("table", "heat route-table");
    const thead = el("thead");
    const hr = el("tr");
    const corner = el("th", "row-head");
    corner.appendChild(el("span", "corner-note", "sender ↓ · destination →"));
    hr.appendChild(corner);
    for (let d = 0; d < N_TIERS; d++) {
      hr.appendChild(tierHead(null, "to " + TIER_NAMES[d], d, result));
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (let s = 0; s < N_TIERS; s++) {
      const tr = el("tr");
      tr.appendChild(tierHead("row-head", "from " + TIER_NAMES[s], s, result));
      for (let d = 0; d < N_TIERS; d++) {
        const td = el("td");
        const cell = result.cells[s][d];
        if (!cell.pairs || !(result.frac > 0)) {
          td.textContent = "n/a";
          td.classList.add("na");
        } else {
          threeFigureCell(td, cell.ok / cell.pairs,
            result.exemptFrac > 0 ? cell.okBucket / cell.pairs : NaN,
            cell.okBase / cell.pairs);
          td.dataset.s = String(s);
          td.dataset.d = String(d);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    $("route-wrap").replaceChildren(table);
  }

  function field(labelText, control) {
    const label = el("label", "route-field");
    label.appendChild(el("span", "route-field-label", labelText));
    label.appendChild(control);
    return label;
  }

  // Rebuilt only when the control set itself changes (the type selector comes
  // and goes with the slot mode) -- never on a recompute, which would tear
  // the payment box out from under a reader mid-keystroke.
  let controlsKey = null;

  function renderControls() {
    const key = params.slotMode + "|" + params.channelTypes.join(",");
    if (key === controlsKey) return;
    controlsKey = key;
    const wrap = $("route-controls");
    const fields = [];

    // A text box rather than a select: the presets are suggestions, and any
    // positive dollar amount is a fair question to ask of the graph. Text
    // with a datalist rather than a number input, so the presets come as a
    // dropdown instead of spinner arrows.
    const pay = el("input", "corner-select route-pay");
    pay.type = "text";
    pay.inputMode = "decimal";
    pay.autocomplete = "off";
    pay.value = String(state.payUsd);
    pay.setAttribute("aria-label", "Payment amount in dollars");
    pay.setAttribute("list", "route-pay-presets");
    const presets = el("datalist");
    presets.id = "route-pay-presets";
    for (const usd of PAY_PRESETS) {
      const opt = el("option");
      opt.value = String(usd);
      presets.appendChild(opt);
    }
    pay.addEventListener("input", () => {
      const v = parseFloat(pay.value);
      const ok = v > 0;
      pay.classList.toggle("invalid", !ok);
      if (!ok) return;
      state.payUsd = v;
      schedule();
    });
    const payField = field("Payment amount ($)", pay);
    payField.appendChild(presets);
    fields.push(payField);

    // The per-peer allocation only varies by channel type under percentage
    // slots; under fixed slots there is nothing to pick.
    if (params.slotMode !== "fixed") {
      const type = el("select", "corner-select");
      type.setAttribute("aria-label", "Channel type");
      for (const n of [...params.channelTypes].sort((a, b) => b - a)) {
        const opt = el("option", null, fmt.int(n) + " slots");
        opt.value = String(n);
        if (n === chanType()) opt.selected = true;
        type.appendChild(opt);
      }
      type.addEventListener("change", () => {
        state.type = Number(type.value);
        schedule();
      });
      fields.push(field("Channel type", type));
    }
    wrap.replaceChildren(...fields);
  }

  function setBusy(busy) {
    $("route-wrap").classList.toggle("is-busy", busy);
  }

  // ---------------- tooltip ----------------

  function showCellTip(td, x, y) {
    const s = Number(td.dataset.s);
    const d = Number(td.dataset.d);
    const cell = lastResult.cells[s][d];
    const share = cell.ok / cell.pairs;
    const bucket = cell.okBucket / cell.pairs;
    const base = cell.okBase / cell.pairs;
    const hops = medianHops(cell.hops, cell.ok);
    const lines = [
      el("div", "tt-value", TIER_NAMES[s] + " pays " + TIER_NAMES[d]),
      el("div", "tt-line", "per-peer allocation " + fmt.pct(share, 1)),
    ];
    if (lastResult.exemptFrac > 0) {
      lines.push(el("div", "tt-line", "whole general bucket " + fmt.pct(bucket, 1)));
    }
    lines.push(
      el("div", "tt-line", "no mitigation " + fmt.pct(base, 1)),
      el("div", "tt-line", "cost of the mitigation " +
        ((share - base) * 100).toFixed(1) + "pp"),
      el("div", "tt-line", fmt.int(cell.pairs) + " pairs — " +
        lastResult.senders[s] + " senders x " + lastResult.dests[d] +
        " destinations"),
    );
    if (isFinite(hops)) {
      lines.push(el("div", "tt-line",
        "median " + hops + (hops === 1 ? " hop" : " hops")));
    }
    tip.show(lines, x, y);
  }

  // ---------------- driving ----------------

  // Recompute only when something it depends on has actually moved: app.js
  // re-renders the whole page on every keystroke in the Parameters row, and
  // most of those leave this section's inputs alone.
  function schedule() {
    if (!mounted || !params) return;
    const key = [params.minHtlcSat, params.exemptFrac, params.price,
      state.payUsd, params.slotMode, chanType(), mitigatedFrac(),
    ].join("|");
    if (key === lastKey) return;
    lastKey = key;
    renderControls();
    setBusy(true);
    // A filter drag fires continuously; each frame would otherwise start a
    // search that the next frame throws away.
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  }

  async function run() {
    const id = ++runId;
    const result = await compute(id);
    if (!result || id !== runId) return;
    lastResult = result;
    setBusy(false);
    renderTable(result);
  }

  function mount(deps) {
    M = deps.M;
    G = deps.GRAPH;
    fmt = deps.fmt;
    tip = deps.tip;
    REV = M.reverseGraph(G);
    buildTiers();
    deps.bindTooltip("route-wrap", "td[data-s]", showCellTip);
    mounted = true;
  }

  function update(next) {
    params = next;
    schedule();
  }

  return { mount, update, PAY_PRESETS, DESTS_PER_TIER, SENDERS_PER_TIER };
});
