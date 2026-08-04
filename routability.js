/* General routability section.
 *
 * One question: with the general bucket's allocation applied to every hop a
 * payment is forwarded over, what share of node pairs can still pay each other?
 *
 * Unlike the tables above it, this reads the real topology (graph.js) rather
 * than a distribution, because whether a payment routes depends on which
 * channels sit next to which. Nodes are banded by how much they can push --
 * edge, periphery, core -- and the heatmap is the share of pairs that clear,
 * from each band to each band.
 *
 * Everything is recomputed against the current filter: the bands are
 * percentiles of the surviving graph, so raising the floor can demote a node or
 * remove it. The bucket parameters and the payment amount move it too.
 *
 * All routing lives in math.js; this file owns the section's own state
 * (payment amount, bucket tab, channel type) and its rendering. app.js hands it
 * the current parameters on every render.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RoutabilityView = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Round payment sizes spanning what Lightning actually carries, from a tip to
  // a large transfer. The same list the distribution table uses for its rows.
  const PAY_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
  const DEFAULT_PAY_USD = 50;

  // Where the bands are cut, as percentiles of the whole graph's advertised
  // max_htlc -- the same rows the Channel percentiles table prints. app.js
  // resolves them to sat thresholds, since it owns the edge histogram.
  //
  // Taking them over the whole graph rather than the survivors is what the page
  // does everywhere, and it means the filter empties a band from below instead
  // of redrawing where the bands are. So the edge band thinning out as the
  // floor rises is the finding, not an artefact.
  const CUTS = [25, 80];

  // How many destinations to sample from each band. Sources are not sampled:
  // one backwards search answers for every node at once, so a band contributes
  // all of its members.
  //
  // The destination count is what actually sets the precision, though, and it
  // needs to be this high. Reachability is close to all-or-nothing per
  // destination -- either a node has a channel big enough to be paid over or it
  // does not, and then nobody can reach it -- so a cell is really an average
  // over destinations, however many senders each one is scored against. Ten
  // destinations quantised every cell to a multiple of 10%; a hundred lands
  // within a couple of points of where four hundred does.
  const DESTS_PER_BAND = 100;
  const SEED = 1280;

  const BANDS = [
    { key: "edge", label: "edge" },
    { key: "periphery", label: "periphery" },
    { key: "core", label: "core" },
  ];

  // Which share of a channel's max_htlc the bucket admits. Only the general
  // bucket is on offer here -- the section is about what routes without
  // reputation.
  const TABS = {
    generalSlot: { label: "Single general slot", frac: (m) => m.generalSlotFrac },
    general: { label: "All general slots", frac: (m) => m.peerGeneralFrac },
  };

  const state = {
    payUsd: DEFAULT_PAY_USD,
    tab: "general",
    type: 483,
  };

  let M = null;
  let G = null;            // forward CSR, straight off graph.js
  let REV = null;          // incoming-edge view, built once
  let FRACS = null;        // fixed sample positions within a band
  let params = null;       // { typeMetrics, channelTypes, slotMode, price, minHtlcSat }
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

  // Yield often enough that the page stays responsive, but not once per search:
  // a timer per destination would cost more in clamped setTimeout delays than
  // the searches themselves.
  const YIELD_MS = 16;
  let lastYield = 0;
  function maybeYield() {
    const now = Date.now();
    if (now - lastYield < YIELD_MS) return null;
    lastYield = now;
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ---------------- parameters ----------------

  // Under fixed slots every channel type yields the same fraction, so there is
  // nothing to choose; under percentage slots it scales with the type.
  function activeType() {
    if (params.slotMode === "fixed") return Math.max(...params.channelTypes);
    return params.channelTypes.includes(state.type)
      ? state.type
      : Math.max(...params.channelTypes);
  }

  const tabDef = () => TABS[state.tab] || TABS.general;

  function activeFrac() {
    return tabDef().frac(params.typeMetrics(activeType()));
  }

  const amountSat = () => M.usdToSat(state.payUsd, params.price);

  // ---------------- computation ----------------

  // Which nodes are in which band, and which of them are sampled as
  // destinations. Depends only on the filter, since the band thresholds are
  // fixed.
  function layout(minSat) {
    const peak = M.nodePeak(G, minSat);
    const { groups, total } = M.bandNodes(peak, params.thresholds);
    return { groups, total, dests: groups.map((b) => M.pickByFraction(b, FRACS)) };
  }

  // Tally one completed search into the column its destination belongs to.
  function tally(cells, groups, to, dest, sub, key, withHops) {
    for (let from = 0; from < BANDS.length; from++) {
      const cell = cells[from][to];
      for (const u of groups[from]) {
        if (u === dest) continue;
        if (key === "baseOk") cell.pairs++;
        if (!sub.ok[u]) continue;
        cell[key]++;
        if (withHops) cell.hops[sub.hops[u]]++;
      }
    }
  }

  const emptyCells = () => BANDS.map(() => BANDS.map(() => ({
    ok: 0, pairs: 0, baseOk: 0, hops: new Int32Array(M.MAX_HOPS + 1),
  })));

  // The unrestricted figure a cell reports on hover depends only on the filter
  // and the amount, so it survives every change to the bucket parameters. It is
  // half the searches, and those are the changes a reader makes most.
  let baseCache = { key: null, value: null };

  async function computeBaseline(id, minSat, amount, place) {
    const key = minSat + "|" + amount;
    if (baseCache.key === key) return baseCache.value;
    const cells = emptyCells();
    for (let to = 0; to < BANDS.length; to++) {
      for (const dest of place.dests[to]) {
        if (id !== runId) return null;
        const res = M.routeCosts(REV, dest, amount, 1, minSat);
        tally(cells, place.groups, to, dest,
          M.sourceResults(G, dest, res, minSat), "baseOk", false);
        const pause = maybeYield();
        if (pause) await pause;
      }
    }
    baseCache = { key, value: cells };
    return cells;
  }

  // One backwards search per sampled destination, run twice: once with the
  // bucket's fraction and once unrestricted, so a cell can say how much of its
  // shortfall the bucket is responsible for rather than leaving the reader to
  // guess whether the graph could carry the amount at all.
  async function compute(id) {
    const minSat = params.minHtlcSat;
    const amount = amountSat();
    const frac = activeFrac();
    const place = layout(minSat);

    const cells = await computeBaseline(id, minSat, amount, place);
    if (!cells || id !== runId) return null;
    // The baseline is cached and reused, so its pair and baseOk counts are
    // copied out rather than added to in place.
    const merged = emptyCells();
    for (let from = 0; from < BANDS.length; from++) {
      for (let to = 0; to < BANDS.length; to++) {
        merged[from][to].pairs = cells[from][to].pairs;
        merged[from][to].baseOk = cells[from][to].baseOk;
      }
    }

    if (frac > 0) {
      for (let to = 0; to < BANDS.length; to++) {
        for (const dest of place.dests[to]) {
          if (id !== runId) return null;
          const res = M.routeCosts(REV, dest, amount, frac, minSat);
          tally(merged, place.groups, to, dest,
            M.sourceResults(G, dest, res, minSat), "ok", true);
          const pause = maybeYield();
          if (pause) await pause;
        }
      }
    }
    return {
      cells: merged, groups: place.groups, total: place.total,
      dests: place.dests, minSat, amount, frac,
    };
  }

  // Hop count of the middle successful pair, read off the per-cell histogram.
  function medianHops(cell) {
    if (!cell.ok) return NaN;
    const half = cell.ok / 2;
    let seen = 0;
    for (let h = 0; h < cell.hops.length; h++) {
      seen += cell.hops[h];
      if (seen >= half) return h;
    }
    return NaN;
  }

  // ---------------- rendering ----------------

  function bandRange(i) {
    const t = params.thresholds;
    const lo = i > 0 ? fmt.compactSat(t[i - 1]) : null;
    const hi = i < t.length ? fmt.compactSat(t[i]) : null;
    if (!lo) return "≤ " + hi + " sat";
    if (!hi) return "> " + lo + " sat";
    return lo + " – " + hi + " sat";
  }

  function bandPercentiles(i) {
    if (i === 0) return "to p" + CUTS[0];
    if (i === CUTS.length) return "p" + CUTS[CUTS.length - 1] + " up";
    return "p" + CUTS[i - 1] + " – p" + CUTS[i];
  }

  function bandHead(i, result, klass) {
    const th = el("th", klass);
    th.appendChild(el("span", "band-name", BANDS[i].label));
    th.appendChild(el("span", "band-range", bandPercentiles(i) + " · " + bandRange(i)));
    const count = result.groups[i].length;
    const nodes = el("span", "band-range", fmt.int(count) + " nodes");
    // A band the filter has emptied is worth saying out loud: it is the reason
    // its row and column read n/a, and it is the finding rather than a fault.
    if (!count) nodes.textContent = "emptied by the filter";
    th.appendChild(nodes);
    return th;
  }

  function renderHeat(result) {
    const table = el("table", "heat");
    const thead = el("thead");
    const hr = el("tr");
    const corner = el("th", "row-head");
    corner.appendChild(el("span", "corner-note", "from ↓ / to →"));
    hr.appendChild(corner);
    for (let to = 0; to < BANDS.length; to++) hr.appendChild(bandHead(to, result));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (let from = 0; from < BANDS.length; from++) {
      const tr = el("tr");
      tr.appendChild(bandHead(from, result, "row-head"));
      for (let to = 0; to < BANDS.length; to++) {
        const cell = result.cells[from][to];
        const td = el("td");
        if (!cell.pairs) {
          td.textContent = "n/a";
          td.classList.add("na");
        } else {
          const share = cell.ok / cell.pairs;
          td.textContent = fmt.pct(share, 1);
          params.shade(td, share);
          td.dataset.from = String(from);
          td.dataset.to = String(to);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    $("route-wrap").replaceChildren(table);
  }

  function renderCaption(result) {
    const sampled = result.dests.reduce((a, d) => a + d.length, 0);
    const parts = [
      "Share of node pairs that can route " + fmt.usd(state.payUsd) + " — " +
      fmt.sat(Math.round(result.amount)) + " at " + fmt.usd(params.price) +
      " / BTC — through the general bucket, with " +
      fmt.pct(result.frac) + " of each forwarded channel's max_htlc available.",
      "A node is banded by its largest advertised max_htlc that survives the " +
      "filter, against the same whole-graph percentiles the table above uses: " +
      "p" + CUTS[0] + " is " + fmt.sat(params.thresholds[0]) + " and p" +
      CUTS[1] + " is " + fmt.sat(params.thresholds[1]) + ". " +
      fmt.int(result.total) + " nodes can originate a payment at this filter. " +
      "Every one of them is a sender; " + sampled + " are sampled as " +
      "destinations. Hover a cell for the unrestricted figure.",
    ];
    $("route-caption").replaceChildren(...parts.map((t) => el("span", "caption-line", t)));
  }

  function renderControls() {
    const wrap = $("route-controls");
    const fields = [];

    const pay = el("select", "corner-select");
    pay.setAttribute("aria-label", "Payment amount");
    for (const usd of PAY_PRESETS) {
      const opt = el("option", null, fmt.usd(usd));
      opt.value = String(usd);
      if (usd === state.payUsd) opt.selected = true;
      pay.appendChild(opt);
    }
    pay.addEventListener("change", () => {
      state.payUsd = Number(pay.value);
      schedule();
    });
    fields.push(field("Payment amount", pay));

    if (params.slotMode !== "fixed") {
      const type = el("select", "corner-select");
      type.setAttribute("aria-label", "Channel type");
      for (const n of [...params.channelTypes].sort((a, b) => b - a)) {
        const opt = el("option", null, fmt.int(n) + " slots");
        opt.value = String(n);
        if (n === activeType()) opt.selected = true;
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

  function field(labelText, control) {
    const label = el("label", "route-field");
    label.appendChild(el("span", "route-field-label", labelText));
    label.appendChild(control);
    return label;
  }

  function syncTabs() {
    for (const btn of document.querySelectorAll("#route-tabs .tab")) {
      btn.classList.toggle("active", btn.dataset.routeTab === state.tab);
    }
  }

  function setBusy(busy) {
    $("route-wrap").classList.toggle("is-busy", busy);
  }

  // ---------------- tooltip ----------------

  function showCellTip(td, x, y) {
    const from = Number(td.dataset.from);
    const to = Number(td.dataset.to);
    const cell = lastResult.cells[from][to];
    const share = cell.ok / cell.pairs;
    const base = cell.baseOk / cell.pairs;
    const hops = medianHops(cell);
    const lines = [
      el("div", "tt-value", BANDS[from].label + " → " + BANDS[to].label),
      el("div", "tt-line", "general bucket " + fmt.pct(share, 1)),
      el("div", "tt-line", "unrestricted " + fmt.pct(base, 1)),
      el("div", "tt-line", "cost of the bucket " +
        ((share - base) * 100).toFixed(1) + "pp"),
      el("div", "tt-line", fmt.int(cell.pairs) + " pairs"),
    ];
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
    const key = [params.minHtlcSat, params.price, state.payUsd, state.tab,
      activeType(), activeFrac()].join("|");
    if (key === lastKey) return;
    lastKey = key;
    renderControls();
    syncTabs();
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
    renderCaption(result);
    renderHeat(result);
  }

  function mount(deps) {
    M = deps.M;
    G = deps.GRAPH;
    fmt = deps.fmt;
    tip = deps.tip;
    REV = M.reverseGraph(G);
    FRACS = M.sampleFractions(DESTS_PER_BAND, SEED);
    for (const btn of document.querySelectorAll("#route-tabs .tab")) {
      btn.addEventListener("click", () => {
        state.tab = btn.dataset.routeTab;
        schedule();
      });
    }
    deps.bindTooltip("route-wrap", "td[data-from]", showCellTip);
    mounted = true;
  }

  function update(next) {
    params = next;
    schedule();
  }

  return { mount, update, PAY_PRESETS, BANDS, CUTS };
});
