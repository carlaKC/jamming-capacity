/* General routability section.
 *
 * One question, asked of a channel rather than of the network: when a payment
 * comes past, can this channel forward it once the general bucket's allocation
 * applies?
 *
 * Unlike the tables above it, this reads the real topology (graph.js) rather
 * than a distribution, because what a channel is asked to forward is not the
 * payment. It is the payment plus every fee charged downstream of it, which
 * depends on where the channel sits and on the route a sender would build. So
 * the page routes: it draws senders and destinations at random from the nodes
 * the filter leaves standing, finds the route a sender would find, and reads
 * the demand off it.
 *
 * Rows are channel bands, cut at the same whole-graph max_htlc percentiles the
 * Channel percentiles table prints. Each cell carries two figures: the share of
 * channels that can forward through the general bucket, and underneath it in
 * small type the share that could with no bucket at all. The gap is what the
 * proposal costs; the small figure is what the network could not do anyway.
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

  // Where the channel bands are cut, as percentiles of the whole graph's
  // advertised max_htlc -- the same rows the Channel percentiles table prints,
  // so "p25" means one thing on this page. app.js resolves them to sat
  // thresholds, since it owns the edge histogram.
  //
  // Taking them over the whole graph rather than the survivors is what the page
  // does everywhere, and it means the filter empties a band from below instead
  // of redrawing where the bands are. So the bottom bands going quiet as the
  // floor rises is the finding, not an artefact.
  const CUTS = [10, 25, 50, 75, 90, 99];

  // How many nodes to draw. Destinations set the cost: each one is a search per
  // column plus a pass over every channel. Senders are nearly free, since one
  // backwards search answers for all of them at once, so the pair count comes
  // cheaply from that side.
  //
  // The band rows barely need any of this -- every surviving channel is scored
  // against every destination, so a cell averages millions of forwarding
  // attempts and is steady to a tenth of a point by forty. It is the end-to-end
  // row that wants destinations, because reachability is close to
  // all-or-nothing per destination: either a node can be paid or nobody can
  // reach it, whichever sender is asked. That row still moves by three points
  // at a hundred and settles by a hundred and fifty, which is ~500ms.
  const DESTS = 150;
  const SENDERS = 400;
  const DEST_SEED = 1280;
  const SENDER_SEED = 8080;

  // Which share of a channel's max_htlc the bucket admits. Only the general
  // bucket is on offer here -- the section is about what routes without
  // reputation.
  const BUCKETS = {
    generalSlot: { label: "Single general slot", frac: (m) => m.generalSlotFrac },
    general: { label: "All general slots", frac: (m) => m.peerGeneralFrac },
  };
  const BUCKET_ORDER = ["generalSlot", "general"];

  const state = {
    payUsd: DEFAULT_PAY_USD,
    tab: "general",
  };

  let M = null;
  let G = null;            // forward CSR, straight off graph.js
  let REV = null;          // incoming-edge view, built once
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

  const bucketDef = () => BUCKETS[state.tab] || BUCKETS.general;

  // The table's columns, on the same rule the distribution table follows.
  //
  // Fixed slot counts do not scale with max_accepted_htlcs, so a column per
  // channel type would print one column three times; the axis that does vary is
  // which bucket the payment sits in, and both fit on screen. Under percentage
  // slots the buckets scale with the channel, the types genuinely differ, and
  // the tab row picks one bucket at a time.
  function columns() {
    if (params.slotMode === "fixed") {
      const m = params.typeMetrics(Math.max(...params.channelTypes));
      return BUCKET_ORDER.map((key) => ({
        label: BUCKETS[key].label, frac: BUCKETS[key].frac(m),
      }));
    }
    const bucket = bucketDef();
    return [...params.channelTypes].sort((a, b) => b - a).map((n) => ({
      label: fmt.int(n) + " slots", frac: bucket.frac(params.typeMetrics(n)),
    }));
  }

  const amountSat = () => M.usdToSat(state.payUsd, params.price);

  // ---------------- computation ----------------

  async function compute(id) {
    const minSat = params.minHtlcSat;
    const amount = amountSat();
    const thresholds = params.thresholds;
    const bands = thresholds.length + 1;
    const cols = columns();

    // Nodes underneath the filter are out of the sample entirely: the page
    // treats their channels as absent, so they can neither send, receive nor
    // sit in the middle of a route. A sender needs a channel it can send over
    // and a destination one it can be paid over, which are not the same set.
    const canSend = M.eligibleNodes(G, minSat);
    const canReceive = M.eligibleNodes(REV, minSat);
    const dests = M.sampleNodes(canReceive, DESTS, DEST_SEED);
    const senders = M.sampleNodes(canSend, SENDERS, SENDER_SEED);
    const channels = M.bandChannelCounts(G, minSat, thresholds);

    const fracs = cols.map((c) => (c.frac > 0 ? c.frac : 0));
    const acc = M.emptyBandTally(bands, cols.length);
    acc.channels.set(channels);
    const ends = cols.map(() => ({ ok: 0, hops: new Int32Array(M.MAX_HOPS + 1) }));
    let pairs = 0;
    let baseOk = 0;
    const baseHops = new Int32Array(M.MAX_HOPS + 1);

    for (const dest of dests) {
      if (id !== runId) return null;
      // One unrestricted search per destination answers the whole table: it is
      // where every column reads its demand, and it is the end-to-end row's own
      // baseline.
      const base = M.routeCosts(REV, dest, amount, 1, minSat);
      M.tallyBands(G, dest, base, fracs, minSat, thresholds, acc);
      const baseSrc = M.sourceResults(G, dest, base, minSat, senders);
      for (const u of senders) {
        if (u === dest) continue;
        pairs++;
        if (baseSrc.ok[u]) { baseOk++; baseHops[baseSrc.hops[u]]++; }
      }
      // Whether a payment gets all the way across is a different question, and
      // it needs its own search: a route only counts if every hop it forwards
      // over admits the amount.
      for (let c = 0; c < cols.length; c++) {
        if (!fracs[c]) continue;
        const res = M.routeCosts(REV, dest, amount, fracs[c], minSat);
        const src = M.sourceResults(G, dest, res, minSat, senders);
        for (const u of senders) {
          if (u === dest || !src.ok[u]) continue;
          ends[c].ok++;
          ends[c].hops[src.hops[u]]++;
        }
      }
      const pause = maybeYield();
      if (pause) await pause;
    }
    return {
      cols, acc, ends, channels, thresholds, bands, minSat, amount,
      pairs, baseOk, baseHops, dests: dests.length, senders: senders.length,
      canSend: canSend.length, canReceive: canReceive.length,
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

  function bandLabel(i, n) {
    if (i === 0) return "up to p" + CUTS[0];
    if (i === n - 1) return "above p" + CUTS[CUTS.length - 1];
    return "p" + CUTS[i - 1] + " – p" + CUTS[i];
  }

  function bandRange(i, thresholds) {
    const lo = i > 0 ? fmt.compactSat(thresholds[i - 1]) : null;
    const hi = i < thresholds.length ? fmt.compactSat(thresholds[i]) : null;
    if (!lo) return "≤ " + hi + " sat";
    if (!hi) return "> " + lo + " sat";
    return lo + " – " + hi + " sat";
  }

  function bandHead(i, result) {
    const th = el("th", "row-head");
    th.appendChild(el("span", "band-name", bandLabel(i, result.bands)));
    th.appendChild(el("span", "band-range", bandRange(i, result.thresholds)));
    const count = result.channels[i];
    // A band the filter has emptied is worth saying out loud: it is the reason
    // the row reads n/a, and it is the finding rather than a fault.
    th.appendChild(el("span", "band-range", count
      ? fmt.int(count) + " channels"
      : "emptied by the filter"));
    return th;
  }

  // Two figures in one cell: what the bucket allows, and underneath it what the
  // network would manage without one. Printing the second is the point -- a low
  // figure with a low baseline underneath is the graph's doing, not the
  // bucket's.
  function twoFigureCell(td, share, base) {
    if (!isFinite(share) || !isFinite(base)) {
      td.textContent = "n/a";
      td.classList.add("na");
      return td;
    }
    td.appendChild(el("span", "cell-main", fmt.pct(share, 1)));
    td.appendChild(el("span", "cell-sub", fmt.pct(base, 1) + " unrestricted"));
    params.shade(td, share);
    return td;
  }

  function renderTable(result) {
    const table = el("table", "heat route-table");
    const thead = el("thead");
    const hr = el("tr");
    const corner = el("th", "row-head");
    corner.appendChild(el("span", "corner-note", "channel band"));
    hr.appendChild(corner);
    for (const col of result.cols) hr.appendChild(el("th", null, col.label));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (let b = 0; b < result.bands; b++) {
      const empty = !result.channels[b];
      const tr = el("tr", empty ? "pct-excluded" : null);
      tr.appendChild(bandHead(b, result));
      const attempts = result.acc.attempts[b];
      for (let c = 0; c < result.cols.length; c++) {
        const td = el("td");
        if (!attempts || !(result.cols[c].frac > 0)) {
          td.textContent = "n/a";
          td.classList.add("na");
        } else {
          twoFigureCell(td, result.acc.okBucket[c][b] / attempts,
            result.acc.okBase[b] / attempts);
          td.dataset.band = String(b);
          td.dataset.col = String(c);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // The section's other question, kept where it can be read against the
    // rows above: a channel being able to forward is not the same as a payment
    // getting all the way across.
    const tfoot = el("tfoot");
    const tr = el("tr");
    const head = el("th", "row-head");
    head.appendChild(el("span", "band-name", "payments end to end"));
    head.appendChild(el("span", "band-range",
      fmt.int(result.pairs) + " sampled pairs"));
    tr.appendChild(head);
    for (let c = 0; c < result.cols.length; c++) {
      const td = el("td");
      if (!result.pairs || !(result.cols[c].frac > 0)) {
        td.textContent = "n/a";
        td.classList.add("na");
      } else {
        twoFigureCell(td, result.ends[c].ok / result.pairs,
          result.baseOk / result.pairs);
        td.dataset.end = String(c);
      }
      tr.appendChild(td);
    }
    tfoot.appendChild(tr);
    table.appendChild(tfoot);

    $("route-wrap").replaceChildren(table);
  }

  function renderCaption(result) {
    const parts = [
      "Share of surviving channels that can forward " + fmt.usd(state.payUsd) +
      " — " + fmt.sat(Math.round(result.amount)) + " at " +
      fmt.usd(params.price) + " / BTC — when a payment comes past, with the " +
      "general bucket applied to every channel a payment is forwarded over. " +
      "The smaller figure under each is the same share with no bucket at all.",
      "A channel is asked for the payment plus every fee charged downstream of " +
      "it, which is read off the route a sender would build to " + result.dests +
      " destinations drawn at random from the " + fmt.int(result.canReceive) +
      " nodes the filter leaves able to be paid. Channels are banded by their " +
      "own advertised max_htlc against the whole-graph percentiles the table " +
      "above prints. Hover a cell for the counts behind it.",
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
    wrap.replaceChildren(...fields);
  }

  function field(labelText, control) {
    const label = el("label", "route-field");
    label.appendChild(el("span", "route-field-label", labelText));
    label.appendChild(control);
    return label;
  }

  // The bucket tabs pick one column under percentage slots; under fixed slots
  // both buckets are already columns, so there is nothing to pick.
  function syncTabs() {
    $("route-tabs").classList.toggle("hidden", params.slotMode === "fixed");
    for (const btn of document.querySelectorAll("#route-tabs .tab")) {
      btn.classList.toggle("active", btn.dataset.routeTab === state.tab);
    }
  }

  function setBusy(busy) {
    $("route-wrap").classList.toggle("is-busy", busy);
  }

  // ---------------- tooltip ----------------

  function showCellTip(td, x, y) {
    if (td.dataset.end !== undefined) return showEndTip(td, x, y);
    const b = Number(td.dataset.band);
    const c = Number(td.dataset.col);
    const acc = lastResult.acc;
    const attempts = acc.attempts[b];
    const share = acc.okBucket[c][b] / attempts;
    const base = acc.okBase[b] / attempts;
    tip.show([
      el("div", "tt-value", bandLabel(b, lastResult.bands) + " — " +
        lastResult.cols[c].label.toLowerCase()),
      el("div", "tt-line", "general bucket " + fmt.pct(share, 1)),
      el("div", "tt-line", "unrestricted " + fmt.pct(base, 1)),
      el("div", "tt-line", "cost of the bucket " +
        ((share - base) * 100).toFixed(1) + "pp"),
      el("div", "tt-line", fmt.int(lastResult.channels[b]) + " channels, " +
        fmt.int(attempts) + " forwarding attempts"),
      el("div", "tt-line", "asked for " +
        fmt.sat(Math.round(acc.demand[b] / attempts)) + " on average"),
    ], x, y);
  }

  function showEndTip(td, x, y) {
    const c = Number(td.dataset.end);
    const end = lastResult.ends[c];
    const share = end.ok / lastResult.pairs;
    const base = lastResult.baseOk / lastResult.pairs;
    const hops = medianHops(end.hops, end.ok);
    const lines = [
      el("div", "tt-value", "payments end to end — " +
        lastResult.cols[c].label.toLowerCase()),
      el("div", "tt-line", "general bucket " + fmt.pct(share, 1)),
      el("div", "tt-line", "unrestricted " + fmt.pct(base, 1)),
      el("div", "tt-line", "cost of the bucket " +
        ((share - base) * 100).toFixed(1) + "pp"),
      el("div", "tt-line", fmt.int(lastResult.pairs) + " pairs — " +
        lastResult.senders + " senders x " + lastResult.dests + " destinations"),
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
    const key = [params.minHtlcSat, params.price, state.payUsd, params.slotMode,
      columns().map((c) => c.label + ":" + c.frac).join(",")].join("|");
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
    renderTable(result);
  }

  function mount(deps) {
    M = deps.M;
    G = deps.GRAPH;
    fmt = deps.fmt;
    tip = deps.tip;
    REV = M.reverseGraph(G);
    for (const btn of document.querySelectorAll("#route-tabs .tab")) {
      btn.addEventListener("click", () => {
        state.tab = btn.dataset.routeTab;
        schedule();
      });
    }
    deps.bindTooltip("route-wrap", "td[data-band], td[data-end]", showCellTip);
    mounted = true;
  }

  function update(next) {
    params = next;
    schedule();
  }

  return { mount, update, PAY_PRESETS, CUTS, DESTS, SENDERS };
});
