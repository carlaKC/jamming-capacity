/* UI wiring for the jamming mitigation explorer. All bucket math lives in
 * math.js; this file owns state, validation and rendering. */
(function () {
  "use strict";

  const M = window.BucketMath;
  const DATA = window.EDGE_DATA;
  const FULL_CDF = M.makeCdf(DATA.hist);
  // The same CDF weighted by what each edge advertises rather than by one vote
  // each, so shareAtOrAbove() reads out liquidity share. Built once: the
  // percentile rows are over the whole graph, filter or no filter.
  const VALUE_CDF = M.makeCdf(DATA.hist.map(([sat, count]) => [sat, sat * count]));
  const cdfFor = (sat) =>
    sat > 0 ? M.makeCdf(M.filterHist(DATA.hist, sat)) : FULL_CDF;

  const PERCENTILES = [10, 25, 50, 75, 90, 99];
  const DEFAULT_PRICE = 75000;
  // The cutoff under consideration: below this a channel is too small to
  // forward a payment once any bucket restriction applies to it.
  const DEFAULT_MIN_HTLC_SAT = 100000;

  const state = {
    generalPct: 50,
    congestionPct: 10,
    // Slots hard-set to fixed counts by default; "pct" splits them by
    // percentage of max_accepted_htlcs instead.
    slotMode: "fixed",
    // Advertised max_htlc floor, in sats. 0 keeps the whole graph.
    minHtlcSat: DEFAULT_MIN_HTLC_SAT,
    generalSlotPct: 40,
    congestionSlotPct: 20,
    generalSlots: 30,
    congestionSlots: 10,
    // Channel types and prices are fixed: they are the tables' columns and are
    // no longer editable from the page.
    channelTypes: [483, 114, 50],
    minSlots: 5,
    allocPct: 5,
    // Channels under the max_htlc threshold assign all of their liquidity to
    // the general bucket and put no liquidity limit on its slots: the slot
    // counts stay, but a payment through them may use the whole channel.
    // Off pins the threshold to zero, so every channel enforces per-peer
    // rules and nothing is exempt.
    unlimitedBelowThreshold: true,
    prices: [50000, 75000, 100000],
    thresholds: [1, 5, 10, 25, 50, 100, 250, 500],
    tab: "general",
    // The current BTC price, used wherever the page turns sats into dollars
    // outside the distribution table (whose columns are their own price list).
    price: DEFAULT_PRICE,
    pctType: 483,
  };

  // Rebuilt whenever the graph filter moves; every table reads this one. Seeded
  // from the default floor rather than the whole graph, so the first paint is
  // already filtered and the tables agree with the line above them.
  let CDF = cdfFor(state.minHtlcSat);

  // What an exempt channel answers to instead of the per-peer allocation:
  // everything it advertises. Under the threshold the whole channel is
  // general and its slots carry no liquidity limit, so a single payment --
  // which only ever wants one slot -- may use the full max_htlc.
  const EXEMPT_FRAC = 1;

  // Where the threshold sat before the toggle was switched off, so switching
  // it back on lands where the reader left it rather than at zero.
  let rememberedFloor = DEFAULT_MIN_HTLC_SAT;

  const $ = (id) => document.getElementById(id);

  // ---------------- formatting ----------------

  const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
  const fmtSat = (x) => fmtInt(x) + " sat";
  const fmtUsd = (x) => "$" + x.toLocaleString("en-US");
  // Money to the cent — percentile cells span well under a dollar to thousands.
  // Rounds to an integer number of cents first so analyze_buckets.py, which
  // formats the same doubles in Python, lands on the same cent: Intl and
  // Python's %.2f disagree on halfway-looking values such as 9.045.
  const fmtUsdCents = (x) =>
    "$" + (Math.round(x * 100) / 100).toLocaleString("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (frac, digits) =>
    isFinite(frac) ? (frac * 100).toFixed(digits === undefined ? 2 : digits) + "%" : "n/a";
  // 10 -> "10th", 21 -> "21st", 11 -> "11th".
  function ordinal(n) {
    if (!Number.isInteger(n)) return String(n) + "th";
    const teen = Math.abs(n) % 100;
    if (teen >= 11 && teen <= 13) return n + "th";
    return n + (["th", "st", "nd", "rd"][Math.abs(n) % 10] || "th");
  }
  const fmtPctile = (p) => ordinal(p) + " percentile";
  // Short money for chart labels: cents only where the figure needs them.
  function fmtUsdShort(x) {
    if (x >= 100) return "$" + Math.round(x).toLocaleString("en-US");
    if (x >= 1) return "$" + (Math.round(x * 10) / 10).toLocaleString("en-US");
    return "$" + (Math.round(x * 100) / 100).toFixed(2);
  }
  // One formatter spanning cents to millions -- the routability tier cuts run
  // from a few dollars at the edge to eight figures in the core.
  function fmtUsdCompact(x) {
    if (x >= 1e6) return "$" + (Math.round(x / 1e5) / 10).toLocaleString("en-US") + "M";
    if (x >= 1e3) return "$" + (Math.round(x / 100) / 10).toLocaleString("en-US") + "k";
    return fmtUsdShort(x);
  }
  // compactUsd would render a million as "$1,000k"; prices reach that now.
  const fmtPriceShort = (x) =>
    x >= 1e6
      ? "$" + (Math.round(x / 1e5) / 10).toLocaleString("en-US") + "M"
      : "$" + compactUsd(x);
  const compactUsd = (x) =>
    x >= 1000
      ? (x / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "k"
      : String(x);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // 1, 10k, 1M, 1G — the histogram axis has ten decades to label and no room
  // for grouped digits.
  function compactSat(sat) {
    const units = [[1e9, "G"], [1e6, "M"], [1e3, "k"]];
    for (const [size, suffix] of units) {
      if (sat >= size) {
        return (Math.round((sat / size) * 10) / 10).toLocaleString("en-US") + suffix;
      }
    }
    return String(Math.round(sat));
  }

  // ---------------- derived metrics ----------------

  const saturationCache = new Map();
  function channelsToSaturate(n, k) {
    const key = n + ":" + k;
    if (!saturationCache.has(key)) {
      saturationCache.set(key, M.channelsToSaturate(n, k));
    }
    return saturationCache.get(key);
  }

  function slotsFor(n) {
    return state.slotMode === "fixed"
      ? M.bucketSlotsFixed(n, state.generalSlots, state.congestionSlots)
      : M.bucketSlotsPct(n, state.generalSlotPct, state.congestionSlotPct);
  }

  function typeMetrics(n) {
    const slots = slotsFor(n);
    const k = M.perPeerSlots(slots.general, state.minSlots, state.allocPct);
    return {
      maxAcceptedHtlcs: n,
      slots,
      k,
      saturate: slots.general > 0 && k > 0 ? channelsToSaturate(slots.general, k) : NaN,
      generalSlotFrac: M.generalSlotFrac(state.generalPct, slots.general),
      peerGeneralFrac: M.peerGeneralFrac(state.generalPct, slots.general, k),
      congestionSlotFrac: M.congestionSlotFrac(state.congestionPct, slots.congestion),
    };
  }

  function activeMetrics() {
    return [...state.channelTypes].sort((a, b) => b - a).map(typeMetrics);
  }

  // ---------------- rendering: metrics comparison table ----------------

  const METRIC_ROWS = [
    ["General slots", (m) => String(m.slots.general)],
    ["Congestion slots", (m) => String(m.slots.congestion)],
    ["Protected slots", (m) => String(m.slots.protected)],
    ["Per-peer general slots (k)", (m) => String(m.k)],
    ["Channels to saturate general",
      (m) => (isFinite(m.saturate) ? "~" + fmtInt(m.saturate) : "n/a")],
    ["Liquidity per general slot", (m) => fmtPct(m.generalSlotFrac)],
    ["Largest HTLC per outgoing channel", (m) => fmtPct(m.peerGeneralFrac)],
    ["Largest congestion HTLC", (m) => fmtPct(m.congestionSlotFrac)],
  ];

  function renderMetrics(metrics) {
    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    hr.appendChild(el("th", "row-head", "Metric"));
    for (const m of metrics) {
      hr.appendChild(el("th", null, fmtInt(m.maxAcceptedHtlcs) + " slots"));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const [label, value] of METRIC_ROWS) {
      const tr = el("tr");
      tr.appendChild(el("th", "row-head", label));
      for (const m of metrics) tr.appendChild(el("td", null, value(m)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrap = el("div", "table-wrap");
    wrap.appendChild(table);
    $("metrics").replaceChildren(wrap);
  }

  // ---------------- rendering: distribution table ----------------

  // The largest single HTLC the selected bucket admits, as a fraction of the
  // edge's max_htlc. "All general slots" is a peer's whole allocation and is
  // the default; the other two narrow it to one slot's worth.
  const CELL_MODES = {
    generalSlot: {
      label: "Single general slot",
      frac: (m) => m.generalSlotFrac,
      caption: "One general slot: we assume the payment occupies a single " +
        "slot of the general bucket.",
    },
    general: {
      label: "All general slots",
      frac: (m) => m.peerGeneralFrac,
      caption: "All general slots: we assume that the payment is using the " +
        "full allocation of slots for this bucket.",
    },
    congestion: {
      label: "Congestion bucket",
      frac: (m) => m.congestionSlotFrac,
      caption: "Congestion bucket: we assume that the payment is using a " +
        "single slot in the congestion bucket.",
    },
  };
  const CELL_MODE_ORDER = ["generalSlot", "general", "congestion"];

  const cellMode = () => CELL_MODES[state.tab] || CELL_MODES.general;

  function cellFrac(m) {
    return cellMode().frac(m);
  }

  function shadeCell(td, share) {
    const alpha = share * 0.92;
    td.style.background = "rgba(var(--cell-rgb), " + alpha.toFixed(3) + ")";
    // Deep-moss ramp: pale-mist text only once the fill is dark enough to
    // carry it (~4.5:1 at 0.7 on the rice-paper surface).
    if (alpha > 0.7) td.classList.add("cell-dark");
  }

  // Thresholds are the distribution table's rows, and are edited there rather
  // than from the sidebar: they affect no other table.

  function redrawTable() {
    renderTable(activeMetrics());
  }

  function thresholdHead(t) {
    const th = el("th", "row-head threshold-head");
    th.appendChild(el("span", null, "≥ " + fmtUsd(t)));
    const remove = el("button", "row-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove the " + fmtUsd(t) + " threshold");
    remove.addEventListener("click", () => {
      if (state.thresholds.length === 1) {
        setError("threshold-error", "Keep at least one threshold.");
        return;
      }
      state.thresholds = state.thresholds.filter((x) => x !== t);
      setError("threshold-error", null);
      redrawTable();
    });
    th.appendChild(remove);
    return th;
  }

  // Trailing row: a "+" that swaps in place for an input. Committing re-renders
  // the table, so the new row lands in sorted position.
  function thresholdAddRow(cellCount) {
    const tr = el("tr", "add-row-tr");
    const th = el("th", "row-head");

    const plus = el("button", "row-add", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", "Add an HTLC threshold");

    const form = el("span", "row-add-form hidden");
    const input = el("input");
    input.type = "number";
    input.min = "0.01";
    input.step = "1";
    input.placeholder = "$";
    input.setAttribute("aria-label", "New HTLC threshold in dollars");

    const commit = () => {
      const v = parseFloat(input.value);
      if (!(v > 0)) {
        setError("threshold-error", "Enter a positive dollar amount.");
        input.classList.add("invalid");
        return;
      }
      if (!state.thresholds.includes(v)) state.thresholds.push(v);
      setError("threshold-error", null);
      redrawTable();
    };
    const cancel = () => {
      form.classList.add("hidden");
      plus.classList.remove("hidden");
      input.value = "";
      input.classList.remove("invalid");
      setError("threshold-error", null);
    };

    plus.addEventListener("click", () => {
      plus.classList.add("hidden");
      form.classList.remove("hidden");
      input.focus();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") cancel();
    });
    const ok = el("button", "small", "add");
    ok.type = "button";
    ok.addEventListener("click", commit);

    form.append(input, ok);
    th.append(plus, form);
    tr.appendChild(th);
    const filler = el("td", "add-row-filler");
    filler.colSpan = cellCount;
    tr.appendChild(filler);
    return tr;
  }

  // The table's column groups, each a label and the frac its cells use.
  //
  // Under fixed slots every channel type has the same 30 general and 10
  // congestion slots, so the per-type groups are three copies of one column.
  // The axis that does vary is which bucket the payment uses, so that becomes
  // the grouping and all three buckets are readable at once. Under percentage
  // slots the buckets scale with max_accepted_htlcs, the types genuinely
  // differ, and one bucket at a time is the only way to show them.
  function columnGroups(metrics) {
    if (state.slotMode !== "fixed") {
      return metrics.map((m) => ({
        label: fmtInt(m.maxAcceptedHtlcs) + " slots",
        frac: cellFrac(m),
      }));
    }
    const m = metrics[0];
    return CELL_MODE_ORDER.map((key) => ({
      label: CELL_MODES[key].label,
      frac: CELL_MODES[key].frac(m),
    }));
  }

  function renderTable(metrics) {
    const fixed = state.slotMode === "fixed";
    const groups = columnGroups(metrics);
    const table = el("table");
    const thead = el("thead");

    const row1 = el("tr");
    row1.appendChild(el("th"));
    for (const g of groups) {
      const th = el("th", "type-head group-start", g.label);
      th.colSpan = state.prices.length;
      row1.appendChild(th);
    }
    thead.appendChild(row1);

    const prices = [...state.prices].sort((a, b) => a - b);
    const thresholds = [...state.thresholds].sort((a, b) => a - b);

    const row2 = el("tr");
    row2.appendChild(el("th", "row-head", "Threshold"));
    for (let g = 0; g < groups.length; g++) {
      prices.forEach((p, i) => {
        row2.appendChild(el("th", "price-head" + (i === 0 ? " group-start" : ""),
          "@ $" + compactUsd(p)));
      });
    }
    thead.appendChild(row2);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const t of thresholds) {
      const tr = el("tr");
      tr.appendChild(thresholdHead(t));
      for (const group of groups) {
        const frac = group.frac;
        prices.forEach((p, i) => {
          const td = el("td", i === 0 ? "group-start" : null);
          if (!(frac > 0)) {
            td.textContent = "n/a";
            td.classList.add("na");
          } else {
            // Over every edge: the ones under the threshold are not gone,
            // they admit their whole max_htlc instead of the per-peer frac.
            const share = M.shareAdmitting(FULL_CDF, M.usdToSat(t, p), frac,
              state.minHtlcSat, EXEMPT_FRAC);
            td.textContent = (share * 100).toFixed(1) + "%";
            td.dataset.threshold = String(t);
            td.dataset.price = String(p);
            td.dataset.required = String(Math.ceil(M.requiredBaseSat(t, p, frac)));
            td.dataset.share = String(share);
            shadeCell(td, share);
          }
          tr.appendChild(td);
        });
      }
      tbody.appendChild(tr);
    }
    tbody.appendChild(thresholdAddRow(groups.length * prices.length));
    table.appendChild(tbody);
    $("table-wrap").replaceChildren(table);
  }

  // ---------------- rendering: channel percentile table ----------------

  // What each bucket lets an edge forward, as a multiple of one general slot's
  // liquidity. Two slots is between a single slot and the whole allocation,
  // and is n/a when a peer is not allowed that many.
  // The general columns collapse to one figure on an exempt row: a channel
  // under the threshold puts no liquidity limit on its general slots, so one
  // slot, two slots and the whole allocation all mean the whole channel.
  const PCT_COLUMNS = [
    { label: "One general slot", frac: (m) => m.generalSlotFrac, general: true },
    {
      label: "Two general slots",
      frac: (m) => (m.k >= 2 ? m.generalSlotFrac * 2 : NaN),
      general: true,
    },
    { label: "All general slots", frac: (m) => m.peerGeneralFrac, general: true },
    { label: "Congestion slot", frac: (m) => m.congestionSlotFrac },
    // The whole protected bucket, not a per-slot slice: what the edge holds
    // back for reputed traffic. Unaffected by the exemption, which only
    // lifts per-peer rules inside general.
    { label: "Protected bucket", frac: () =>
      (100 - state.generalPct - state.congestionPct) / 100 },
  ];

  function cornerSelect(label, values, selected, format, onPick) {
    const select = el("select", "corner-select");
    select.setAttribute("aria-label", label);
    for (const v of values) {
      const opt = el("option", null, format(v));
      opt.value = String(v);
      if (v === selected) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      onPick(Number(select.value));
      renderPercentiles();
    });
    return select;
  }

  const pctType = () =>
    state.channelTypes.includes(state.pctType)
      ? state.pctType
      : Math.max(...state.channelTypes);

  function renderPercentiles() {
    const price = state.price;
    // Under fixed slots every channel type gives the same fracs, so there is
    // nothing to choose; under percentage slots they scale with the type.
    const fixed = state.slotMode === "fixed";
    const type = fixed ? Math.max(...state.channelTypes) : pctType();
    const m = typeMetrics(type);
    const floor = state.minHtlcSat;

    $("pct-caption").textContent =
      "What the edge at each percentile of the whole graph can forward, in " +
      "USD at " + fmtUsd(price) + " / BTC. Percentiles are over all " +
      fmtInt(FULL_CDF.total) +
      " directed edges; greyed rows are below the current threshold and " +
      "put no liquidity limit on their general slots, so their general " +
      "columns all show the whole channel. Hover a cell for sat values.";

    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");

    const corner = el("th", "row-head");
    corner.appendChild(el("span", "corner-note", "@ " + fmtPriceShort(price) + " / BTC"));
    if (!fixed) {
      corner.appendChild(cornerSelect(
        "Channel type for the percentile table",
        [...state.channelTypes].sort((a, b) => b - a), type,
        (n) => fmtInt(n) + " slots",
        (n) => { state.pctType = n; }));
    }
    hr.appendChild(corner);
    for (const c of PCT_COLUMNS) hr.appendChild(el("th", null, c.label));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const p of PERCENTILES) {
      // Over FULL_CDF deliberately: filtering first would move every row, and
      // a percentile that means a different edge at every filter setting is
      // not comparable with the one beside it.
      const base = M.percentileSat(FULL_CDF, p);
      const excluded = floor > 0 && isFinite(base) && base < floor;
      const tr = el("tr", excluded ? "pct-excluded" : null);
      const head = el("th", "row-head", fmtPctile(p));
      if (isFinite(base)) {
        head.dataset.pctile = String(p);
        head.dataset.base = String(base);
        head.dataset.excluded = excluded ? "1" : "";
      }
      tr.appendChild(head);
      for (const c of PCT_COLUMNS) {
        const frac = excluded && c.general ? EXEMPT_FRAC : c.frac(m);
        const td = el("td");
        if (!(frac > 0) || !isFinite(base)) {
          td.textContent = "n/a";
          td.classList.add("na");
        } else {
          const sat = base * frac;
          td.textContent = fmtUsdCents(M.satToUsd(sat, price));
          td.dataset.pctile = String(p);
          td.dataset.bucket = excluded && c.general
            ? "Whole channel" : c.label;
          td.dataset.base = String(base);
          td.dataset.sat = String(sat);
          td.dataset.frac = String(frac);
          td.dataset.price = String(price);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    $("pct-wrap").replaceChildren(table);
  }

  // ---------------- rendering: graph filter ----------------

  // Round sat floors spanning the range where the graph's mass actually sits.
  // 0 is "keep everything"; the largest still leaves about an eighth of the
  // edges, so no choice can empty the tables below.
  const HTLC_FLOORS = [0, 1e3, 1e4, 5e4, 1e5, 5e5, 1e6, 5e6, 1e7];

  // Four bars per power of ten, from 1 sat to 1 G sat — the observed range is
  // 1 sat to 990 M.
  const HIST_PER_DECADE = 4;
  const HIST_DECADES = 9;
  const HIST_BUCKETS = M.histogramBuckets(DATA.hist, HIST_PER_DECADE, HIST_DECADES);
  const HIST_MAX = HIST_BUCKETS.reduce((a, b) => Math.max(a, b.count), 0);

  const GW = 720, GH = 210;
  const GPAD = { top: 12, right: 14, bottom: 34, left: 54 };
  const GPW = GW - GPAD.left - GPAD.right;
  const GPH = GH - GPAD.top - GPAD.bottom;

  // Bars tile the log axis, so a bar's left and right edges are the log
  // positions of the sat range it covers.
  const gx = (sat) => GPAD.left + (Math.log10(sat) / HIST_DECADES) * GPW;
  const gy = (count) => GPAD.top + (1 - (HIST_MAX ? count / HIST_MAX : 0)) * GPH;

  // Bars sit on the axis, so only the top corners round -- and a bar cut by the
  // filter rounds only its outer top corner, so the two segments still read as
  // one bar. Radius shrinks on narrow or short bars rather than swallowing them.
  function barPath(x, y, w, h, roundLeft, roundRight) {
    const r = Math.max(0, Math.min(4, w / 2, h));
    const rl = roundLeft ? r : 0;
    const rr = roundRight ? r : 0;
    return "M" + x + " " + (y + h) +
      "L" + x + " " + (y + rl) +
      (rl ? "A" + rl + " " + rl + " 0 0 1 " + (x + rl) + " " + y : "L" + x + " " + y) +
      "L" + (x + w - rr) + " " + y +
      (rr ? "A" + rr + " " + rr + " 0 0 1 " + (x + w) + " " + (y + rr) : "") +
      "L" + (x + w) + " " + (y + h) + "Z";
  }

  // Edge counts straight off the unfiltered CDF, so a bar the filter cuts can
  // state how many of its edges fall each side of the cut.
  const edgesAtOrAbove = (sat) =>
    Math.round(M.shareAtOrAbove(FULL_CDF, sat) * FULL_CDF.total);
  const edgesIn = (lo, hi) => edgesAtOrAbove(lo) - edgesAtOrAbove(hi);

  function showBarTooltip(b, x, y) {
    const floor = state.minHtlcSat;
    const lines = [
      el("div", "tt-value", compactSat(b.lo) + " – " + compactSat(b.hi) + " sat"),
      el("div", "tt-line", fmtInt(b.count) + " edges — " +
        fmtPct(FULL_CDF.total ? b.count / FULL_CDF.total : 0, 1) + " of the graph"),
    ];
    if (floor >= b.hi) {
      lines.push(el("div", "tt-line",
        "below the threshold — no per-peer liquidity limits"));
    } else if (floor > b.lo) {
      lines.push(el("div", "tt-line", "cut by the threshold — " +
        fmtInt(edgesIn(b.lo, floor)) + " exempt, " +
        fmtInt(edgesIn(floor, b.hi)) + " enforcing"));
    } else {
      lines.push(el("div", "tt-line", "enforces per-peer rules"));
    }
    lines.push(el("div", "tt-line", state.unlimitedBelowThreshold
      ? "drag to move the filter"
      : LOCKED_FILTER_HINT));
    tooltip.replaceChildren(...lines);
    placeTooltip(x, y);
  }

  // Pointer x to a sat value. This measures whatever SVG is on the page right
  // now rather than closing over one: setting the filter re-renders the chart,
  // so a node captured at pointerdown is detached by the first drag move and
  // reports a zero-width box.
  function satAt(clientX) {
    const live = $("filter-hist").querySelector("svg");
    if (!live) return 0;
    const box = live.getBoundingClientRect();
    if (!box.width) return 0;
    const px = ((clientX - box.left) / box.width) * GW;  // viewBox units
    const decades = ((px - GPAD.left) / GPW) * HIST_DECADES;
    return Math.pow(10, Math.min(HIST_DECADES, Math.max(0, decades)));
  }

  function bucketAt(sat) {
    const i = Math.floor(Math.log10(Math.max(1, sat)) * HIST_PER_DECADE);
    return HIST_BUCKETS[Math.min(HIST_BUCKETS.length - 1, Math.max(0, i))];
  }

  function renderHistogram() {
    const floor = state.minHtlcSat;
    const node = svg("svg", {
      viewBox: "0 0 " + GW + " " + GH,
      class: "filter-hist",
      role: "img",
      "aria-label":
        "Histogram of advertised max_htlc across the graph's directed edges, " +
        "on a log scale from 1 satoshi to 1 billion. " +
        (floor > 0
          ? "Bars below the " + compactSat(floor) + " satoshi filter, worth " +
            fmtUsdShort(M.satToUsd(floor, state.price)) +
            " at the current price, are greyed out."
          : "No filter is applied, so every bar is included."),
    });

    for (let i = 0; i <= 4; i++) {
      const y = GPAD.top + (i / 4) * GPH;
      node.appendChild(svg("line", {
        x1: GPAD.left, y1: y, x2: GPAD.left + GPW, y2: y,
        stroke: "#DED8CF", "stroke-width": 1,
      }));
      node.appendChild(svg("text", {
        x: GPAD.left - 10, y: y + 4, "text-anchor": "end", class: "chart-tick",
      }, fmtInt((HIST_MAX * (4 - i)) / 4)));
    }

    for (const b of HIST_BUCKETS) {
      if (!(b.count > 0)) continue;
      const x0 = gx(b.lo);
      const x1 = gx(b.hi);
      const y = gy(b.count);
      const h = GPAD.top + GPH - y;
      // A bar covers a range of values, so a floor inside that range keeps
      // part of it. Cut the rectangle at the floor rather than colouring the
      // whole bar by which side its edge falls on.
      const cut = Math.min(x1, Math.max(x0, gx(Math.max(1, floor))));
      const seg = (a, w, cls, roundLeft, roundRight) => {
        if (w <= 0.05) return;
        // 1px of surface between bars, so neighbours read as separate.
        node.appendChild(svg("path", {
          d: barPath(a, y, Math.max(0.5, w - 1), h, roundLeft, roundRight),
          class: cls,
        }));
      };
      if (floor > 0) {
        seg(x0, cut - x0, "hist-bar hist-bar-out", true, cut >= x1);
        seg(cut, x1 - cut, "hist-bar", cut <= x0, true);
      } else {
        seg(x0, x1 - x0, "hist-bar", true, true);
      }
    }

    // Quiet percentile markers: dotted verticals with the rank in small type
    // above the plot. Over FULL_CDF like the percentile table, so a marker
    // means the same edge whatever the filter is doing.
    for (const p of PERCENTILES) {
      const sat = M.percentileSat(FULL_CDF, p);
      if (!isFinite(sat)) continue;
      const x = gx(Math.max(1, sat));
      node.appendChild(svg("line", {
        x1: x, y1: GPAD.top, x2: x, y2: GPAD.top + GPH,
        class: "hist-pctile",
      }));
      node.appendChild(svg("text", {
        x, y: GPAD.top - 3, "text-anchor": "middle", class: "hist-pctile-label",
      }, "p" + p));
    }

    if (floor > 0) {
      const x = gx(floor);
      node.appendChild(svg("line", {
        x1: x, y1: GPAD.top - 2, x2: x, y2: GPAD.top + GPH,
        stroke: "#A85448", "stroke-width": 1.5,
      }));
      // A grip at the top of the rule, so the cut reads as something you can
      // take hold of rather than a plain annotation.
      node.appendChild(svg("rect", {
        x: x - 4, y: GPAD.top - 8, width: 8, height: 12, rx: 4,
        fill: "#A85448", class: "hist-grip",
      }));
      // Dollars, not sats: the axis already carries the sat scale, and what a
      // reader wants from the handle is what the cutoff is worth.
      node.appendChild(svg("text", {
        x: Math.min(x + 10, GPAD.left + GPW - 4), y: GPAD.top + 10,
        class: "chart-label", fill: "#A85448",
      }, fmtUsdShort(M.satToUsd(floor, state.price))));
    }

    for (let d = 0; d <= HIST_DECADES; d++) {
      node.appendChild(svg("text", {
        x: gx(Math.pow(10, d)), y: GH - GPAD.bottom + 20,
        "text-anchor": "middle", class: "chart-tick",
      }, compactSat(Math.pow(10, d))));
    }
    node.appendChild(svg("text", {
      x: GPAD.left + GPW / 2, y: GH - 4, "text-anchor": "middle",
      class: "chart-axis-title",
    }, "advertised max_htlc, sat (log scale)"));

    // One overlay across the plot carries both the hover and the drag, so the
    // hit target is the whole plot rather than each bar and the 1.5px rule.
    const overlay = svg("rect", {
      x: GPAD.left, y: GPAD.top - 10, width: GPW, height: GPH + 10,
      fill: "transparent", class: "chart-overlay",
    });
    overlay.addEventListener("pointermove", (e) => {
      if (!dragging) showBarTooltip(bucketAt(satAt(e.clientX)), e.clientX, e.clientY);
    });
    overlay.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // The tooltip is already saying why the filter will not move.
      if (!state.unlimitedBelowThreshold) return;
      hideTooltip();
      startFilterDrag();
      setMinHtlc(snapFloor(satAt(e.clientX)));
    });
    node.appendChild(overlay);
    node.addEventListener("pointerleave", () => { if (!dragging) hideTooltip(); });

    return node;
  }

  // ---------------- dragging the filter on the histogram ----------------

  let dragging = false;

  // Dragging lands on arbitrary reals; two significant figures is a number a
  // person would have picked from the dropdown. Below the first bar there is
  // nothing left to filter, so that end of the axis clears the filter. The top
  // is capped at the largest advertised max_htlc: past that every edge is gone
  // and the tables below are a wall of n/a.
  const MAX_HTLC_SAT = DATA.hist.length ? DATA.hist[DATA.hist.length - 1][0] : 0;

  function snapFloor(sat) {
    if (!(sat > 1.5)) return 0;
    const mag = Math.pow(10, Math.floor(Math.log10(sat)) - 1);
    return Math.min(MAX_HTLC_SAT, Math.max(1, Math.round(sat / mag) * mag));
  }

  // Listeners live on the document so the drag survives the pointer leaving
  // the plot, and so re-rendering the SVG mid-drag cannot orphan them.
  function startFilterDrag() {
    dragging = true;
    document.body.classList.add("dragging-cursor");
    let queued = null;
    const move = (e) => {
      // Coalesce to one re-render per frame: a move recomputes the CDF and
      // every table under it.
      if (queued !== null) cancelAnimationFrame(queued);
      const x = e.clientX;
      queued = requestAnimationFrame(() => {
        queued = null;
        setMinHtlc(snapFloor(satAt(x)));
      });
    };
    const end = () => {
      dragging = false;
      if (queued !== null) cancelAnimationFrame(queued);
      document.body.classList.remove("dragging-cursor");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
  }

  // A flat 0% or 100% next to a count that says otherwise reads as a bug: the
  // far end of the drag genuinely lands at 99.998%, and the liquidity share at
  // the default floor is 0.09%, which is the whole point of stating it.
  function fmtFilteredShare(part, whole, digits) {
    const pct = whole > 0 ? (part / whole) * 100 : 0;
    const step = Math.pow(10, -digits);
    if (part > 0 && pct < step / 2) return "under " + step.toFixed(digits) + "%";
    if (part < whole && pct >= 100 - step / 2) {
      return "over " + (100 - step).toFixed(digits) + "%";
    }
    return pct.toFixed(digits) + "%";
  }

  const FULL_VALUE = M.histValueTotal(DATA.hist);

  function renderFilter() {
    const kept = CDF.total;
    const total = FULL_CDF.total;
    const removed = total - kept;
    // Edges and liquidity answer different questions: the small channels are
    // numerous but hold almost nothing, and the gap between the two figures is
    // the argument for exempting them at all.
    const keptValue = state.minHtlcSat > 0
      ? M.histValueTotal(M.filterHist(DATA.hist, state.minHtlcSat))
      : FULL_VALUE;
    $("filter-share").textContent = state.minHtlcSat > 0
      ? "Below the threshold: " + fmtFilteredShare(removed, total, 1) +
        " of edges and " + fmtFilteredShare(FULL_VALUE - keptValue, FULL_VALUE, 2) +
        " of advertised liquidity enforce no per-peer liquidity limits — " +
        fmtInt(removed) + " of " + fmtInt(total) +
        " directed edges exempt, " + fmtInt(kept) + " enforcing."
      : state.unlimitedBelowThreshold
        ? "No threshold: all " + fmtInt(total) +
          " directed edges enforce per-peer rules."
        : "Unlimited Below Threshold is off: the threshold is pinned to " +
          "zero and all " + fmtInt(total) +
          " directed edges enforce per-peer rules.";
    syncFilterSelect();
    $("filter-hist").replaceChildren(renderHistogram());
  }

  // The routability section owns its own state and its own recompute schedule;
  // it is handed the parameters it reads and decides for itself whether any of
  // them moved. Routing the whole graph is far too expensive to redo on every
  // keystroke in the Parameters row.
  function renderRoutability() {
    window.RoutabilityView.update({
      typeMetrics,
      channelTypes: state.channelTypes,
      slotMode: state.slotMode,
      price: state.price,
      minHtlcSat: state.minHtlcSat,
      bucketFrac: state.generalPct / 100,
      shade: shadeCell,
    });
  }

  function renderAll() {
    const metrics = activeMetrics();
    renderFilter();
    renderMetrics(metrics);
    renderTable(metrics);
    renderPercentiles();
    renderRoutability();
  }

  function setMinHtlc(sat) {
    // A drag crosses many pointer positions that snap to the floor already in
    // force; rebuilding every table for those is wasted work.
    if (sat === state.minHtlcSat) return;
    state.minHtlcSat = sat;
    CDF = cdfFor(sat);
    renderAll();
  }

  // The dropdown offers round floors; dragging the histogram can land between
  // them. Rather than snapping the drag to the presets, the select grows a
  // single extra option holding whatever the drag chose, so the two controls
  // always agree on one value.
  function syncFilterSelect() {
    const sel = $("min-htlc");
    const sat = state.minHtlcSat;
    let custom = sel.querySelector("option[data-custom]");
    if (HTLC_FLOORS.includes(sat)) {
      if (custom) custom.remove();
    } else {
      if (!custom) {
        custom = el("option");
        custom.dataset.custom = "1";
        sel.appendChild(custom);
      }
      custom.value = String(sat);
      custom.textContent = "≥ " + compactSat(sat) + " sat";
    }
    sel.value = String(sat);
  }

  function mountFilterControl() {
    const sel = $("min-htlc");
    for (const sat of HTLC_FLOORS) {
      const opt = el("option", null,
        sat > 0 ? "≥ " + compactSat(sat) + " sat" : "No filter");
      opt.value = String(sat);
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => setMinHtlc(Number(sel.value)));
  }

  // ---------------- validation helpers ----------------

  function readNumber(input) {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : NaN;
  }

  function setError(id, msg) {
    const p = $(id);
    if (msg) {
      p.textContent = msg;
      p.classList.remove("hidden");
    } else {
      p.textContent = "";
      p.classList.add("hidden");
    }
  }

  // ---------------- bucket liquidity split ----------------

  function onSplitInput() {
    const g = readNumber($("general-pct"));
    const c = readNumber($("congestion-pct"));
    const valid = g >= 0 && c >= 0 && g + c <= 100;
    $("general-pct").classList.toggle("invalid", !valid);
    $("congestion-pct").classList.toggle("invalid", !valid);
    if (!valid) {
      setError("split-error", "General and congestion must each be ≥ 0 and sum to ≤ 100.");
      return;
    }
    setError("split-error", null);
    state.generalPct = g;
    state.congestionPct = c;
    $("protected-pct").textContent = String(Math.round((100 - g - c) * 100) / 100);
    renderAll();
  }

  $("general-pct").addEventListener("input", onSplitInput);
  $("congestion-pct").addEventListener("input", onSplitInput);

  // ---------------- bucket slots ----------------

  // Smallest channel type the fixed counts would have to fit inside, or null
  // when they all have room. Percentage mode always fits.
  function tooSmallForFixed(general, congestion, types) {
    if (state.slotMode !== "fixed") return null;
    const offenders = types.filter((n) => !M.slotsFitType(n, general, congestion));
    return offenders.length ? offenders.sort((a, b) => a - b) : null;
  }

  function fixedFitMessage(offenders, general, congestion) {
    return "General + congestion = " + (general + congestion) +
      " slots, more than channel type" + (offenders.length > 1 ? "s " : " ") +
      offenders.join(", ") + " can hold. Lower the counts or drop " +
      (offenders.length > 1 ? "those types." : "that type.");
  }

  function onSlotsPctInput() {
    const g = readNumber($("general-slot-pct"));
    const c = readNumber($("congestion-slot-pct"));
    const valid = g >= 0 && c >= 0 && g + c <= 100;
    $("general-slot-pct").classList.toggle("invalid", !valid);
    $("congestion-slot-pct").classList.toggle("invalid", !valid);
    if (!valid) {
      setError("slots-error", "General and congestion must each be ≥ 0 and sum to ≤ 100.");
      return;
    }
    setError("slots-error", null);
    state.generalSlotPct = g;
    state.congestionSlotPct = c;
    $("protected-slot-pct").textContent = String(Math.round((100 - g - c) * 100) / 100);
    renderAll();
  }

  function onSlotsFixedInput() {
    const g = readNumber($("general-slots"));
    const c = readNumber($("congestion-slots"));
    const gOk = Number.isInteger(g) && g >= 0 && g <= 483;
    const cOk = Number.isInteger(c) && c >= 0 && c <= 483;
    $("general-slots").classList.toggle("invalid", !gOk);
    $("congestion-slots").classList.toggle("invalid", !cOk);
    if (!gOk || !cOk) {
      setError("slots-error",
        "Slot counts must be whole numbers between 0 and 483 (the BOLT 2 maximum).");
      return;
    }
    const offenders = tooSmallForFixed(g, c, state.channelTypes);
    if (offenders) {
      $("general-slots").classList.add("invalid");
      $("congestion-slots").classList.add("invalid");
      setError("slots-error", fixedFitMessage(offenders, g, c));
      return;
    }
    setError("slots-error", null);
    state.generalSlots = g;
    state.congestionSlots = c;
    renderAll();
  }

  $("general-slot-pct").addEventListener("input", onSlotsPctInput);
  $("congestion-slot-pct").addEventListener("input", onSlotsPctInput);
  $("general-slots").addEventListener("input", onSlotsFixedInput);
  $("congestion-slots").addEventListener("input", onSlotsFixedInput);

  // ---------------- slot mode toggle ----------------

  const SLOT_HINTS = {
    pct: "% of max_accepted_htlcs; protected takes the remainder",
    fixed: "fixed counts, not scaled by channel size; protected takes the remainder",
  };

  function syncSlotModeUi() {
    for (const btn of document.querySelectorAll(".mode[data-slot-mode]")) {
      btn.classList.toggle("active", btn.dataset.slotMode === state.slotMode);
    }
    $("slots-hint").textContent = SLOT_HINTS[state.slotMode];
    $("slots-pct-fields").classList.toggle("hidden", state.slotMode !== "pct");
    $("slots-fixed-fields").classList.toggle("hidden", state.slotMode !== "fixed");
  }

  function setSlotMode(mode) {
    const prev = state.slotMode;
    state.slotMode = mode;
    // Switching into fixed mode with counts that don't fit is refused rather
    // than silently clamped; stay in the mode the user came from.
    const offenders = tooSmallForFixed(
      state.generalSlots, state.congestionSlots, state.channelTypes);
    if (offenders) {
      state.slotMode = prev;
      setError("slots-error",
        fixedFitMessage(offenders, state.generalSlots, state.congestionSlots));
      return;
    }
    setError("slots-error", null);
    syncSlotModeUi();
    renderAll();
  }

  for (const btn of document.querySelectorAll(".mode[data-slot-mode]")) {
    btn.addEventListener("click", () => setSlotMode(btn.dataset.slotMode));
  }

  // ---------------- current price ----------------

  // Round rates from the current market up. A select rather than a free field:
  // the exact rate is never the point here, only the order of magnitude that
  // turns sats into money a reader recognises.
  const PRICE_PRESETS = [50000, 75000, 100000, 125000, 150000, 200000, 250000,
    500000, 1000000];

  function mountPriceControl() {
    const sel = $("btc-price");
    for (const p of PRICE_PRESETS) {
      const opt = el("option", null, fmtPriceShort(p));
      opt.value = String(p);
      if (p === state.price) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      state.price = Number(sel.value);
      renderAll();
    });
  }

  // ---------------- per-peer allocation ----------------

  function onAllocInput() {
    const min = readNumber($("min-slots"));
    const pct = readNumber($("alloc-pct"));
    const minOk = Number.isInteger(min) && min >= 0;
    const pctOk = pct >= 0 && pct <= 100;
    $("min-slots").classList.toggle("invalid", !minOk);
    $("alloc-pct").classList.toggle("invalid", !pctOk);
    if (!minOk || !pctOk) {
      setError("alloc-error", "Min slots must be a whole number ≥ 0; percent 0–100.");
      return;
    }
    setError("alloc-error", null);
    state.minSlots = min;
    state.allocPct = pct;
    renderAll();
  }

  $("min-slots").addEventListener("input", onAllocInput);
  $("alloc-pct").addEventListener("input", onAllocInput);

  // ---------------- unlimited below threshold ----------------

  // The threshold only means anything while channels under it are exempt, so
  // switching the exemption off pins the filter to zero and locks it; the old
  // floor is remembered and restored when the toggle comes back on.
  function syncUnlimitedUi() {
    for (const btn of document.querySelectorAll(".mode[data-unlimited]")) {
      btn.classList.toggle("active",
        (btn.dataset.unlimited === "on") === state.unlimitedBelowThreshold);
    }
    $("min-htlc").disabled = !state.unlimitedBelowThreshold;
  }

  function setUnlimited(on) {
    if (on === state.unlimitedBelowThreshold) return;
    state.unlimitedBelowThreshold = on;
    if (!on) {
      if (state.minHtlcSat > 0) rememberedFloor = state.minHtlcSat;
      state.minHtlcSat = 0;
    } else {
      state.minHtlcSat = rememberedFloor;
    }
    CDF = cdfFor(state.minHtlcSat);
    syncUnlimitedUi();
    renderAll();
  }

  for (const btn of document.querySelectorAll(".mode[data-unlimited]")) {
    btn.addEventListener("click", () => setUnlimited(btn.dataset.unlimited === "on"));
  }

  const LOCKED_FILTER_HINT =
    "Turn on Unlimited Below Threshold to move the filter.";

  // A locked select swallows no pointer events (its CSS turns them off), so
  // the label underneath explains why it will not move.
  $("filter-control").addEventListener("pointermove", (e) => {
    if (state.unlimitedBelowThreshold) return;
    tooltip.replaceChildren(el("div", "tt-line", LOCKED_FILTER_HINT));
    placeTooltip(e.clientX, e.clientY);
  });
  $("filter-control").addEventListener("pointerleave", () => {
    if (!state.unlimitedBelowThreshold) hideTooltip();
  });

  // ---------------- tabs ----------------

  // Scoped to this table's own tabs: the routability section has a tab row of
  // its own, and an unscoped .tab query would clear its selection and set
  // state.tab to whatever that row's buttons carry.
  const BUCKET_TABS = document.querySelectorAll("#bucket-tabs .tab");
  for (const btn of BUCKET_TABS) {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      for (const b of BUCKET_TABS) b.classList.toggle("active", b === btn);
      redrawTable();
    });
  }

  // ---------------- tooltip ----------------

  const tooltip = $("tooltip");

  function hideTooltip() {
    tooltip.classList.add("hidden");
  }

  function placeTooltip(x, y) {
    tooltip.classList.remove("hidden");
    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  function showTooltip(td, x, y) {
    const t = Number(td.dataset.threshold);
    const p = Number(td.dataset.price);
    const req = Number(td.dataset.required);
    const share = Number(td.dataset.share);
    const lines = [
      el("div", "tt-value", fmtUsd(t) + " ≈ " + fmtSat(M.usdToSat(t, p))),
      el("div", "tt-line", "at $" + p.toLocaleString("en-US") + " / BTC"),
      el("div", "tt-line", "needs max_htlc ≥ " + fmtSat(req)),
    ];
    if (state.minHtlcSat > 0) {
      lines.push(el("div", "tt-line",
        "under " + compactSat(state.minHtlcSat) + " sat: needs ≥ " +
        fmtSat(Math.ceil(M.usdToSat(t, p)))));
    }
    lines.push(el("div", "tt-line",
      fmtInt(share * FULL_CDF.total) + " of " + fmtInt(FULL_CDF.total) +
      " edges qualify"));
    tooltip.replaceChildren(...lines);
    placeTooltip(x, y);
  }

  // Hovering a percentile row states how much of the network's advertised
  // liquidity sits at or below it. The count and the value diverge sharply --
  // the smaller half of edges hold a fortieth of the liquidity -- which is the
  // whole reason the filter reports both.
  function showPctRowTooltip(th, x, y) {
    const base = Number(th.dataset.base);
    // Strictly-above uses base + 1 because sats are integers, so "at or below"
    // keeps every edge tied at the percentile's own value.
    const edgesBelow = 1 - M.shareAtOrAbove(FULL_CDF, base + 1);
    const valueBelow = 1 - M.shareAtOrAbove(VALUE_CDF, base + 1);
    const lines = [
      el("div", "tt-value", fmtPctile(Number(th.dataset.pctile))),
      el("div", "tt-line", "advertises " + fmtSat(base)),
      el("div", "tt-line", "edges at or below hold " + fmtPct(valueBelow, 2) +
        " of advertised liquidity"),
      el("div", "tt-line", "that is " + fmtPct(edgesBelow, 1) + " of all " +
        fmtInt(FULL_CDF.total) + " edges"),
    ];
    if (th.dataset.excluded) {
      lines.push(el("div", "tt-line",
        "below the " + compactSat(state.minHtlcSat) +
        " sat threshold — no per-peer liquidity limits"));
    }
    tooltip.replaceChildren(...lines);
    placeTooltip(x, y);
  }

  function showPctTooltip(td, x, y) {
    const d = td.dataset;
    const base = Number(d.base);
    const sat = Number(d.sat);
    const price = Number(d.price);
    tooltip.replaceChildren(
      el("div", "tt-value", fmtSat(Math.floor(sat))),
      el("div", "tt-line", d.bucket.toLowerCase() + " — " +
        fmtPct(Number(d.frac)) + " of max_htlc"),
      el("div", "tt-line",
        fmtPctile(Number(d.pctile)) + " edge advertises " + fmtSat(base)),
      el("div", "tt-line", "at $" + price.toLocaleString("en-US") + " / BTC"),
    );
    placeTooltip(x, y);
  }

  function bindTooltip(wrapId, selector, show) {
    $(wrapId).addEventListener("pointermove", (e) => {
      const td = e.target.closest(selector);
      if (td) show(td, e.clientX, e.clientY);
      else hideTooltip();
    });
    $(wrapId).addEventListener("pointerleave", hideTooltip);
  }

  bindTooltip("table-wrap", "td[data-price]", showTooltip);
  bindTooltip("pct-wrap", "td[data-sat], th[data-pctile]", (node, x, y) => {
    if (node.tagName === "TH") showPctRowTooltip(node, x, y);
    else showPctTooltip(node, x, y);
  });

  // ---------------- boot ----------------

  // Every advertising direction is in the data set; the Filtering control is
  // the only thing that takes any of them out of view.
  $("provenance").textContent =
    "Data: " + DATA.source + " (" + DATA.generated + ") — " +
    fmtInt(DATA.directionsKept) + " directed edges, " +
    fmtInt(DATA.directionsImputed) + " with max_htlc imputed from capacity.";

  mountFilterControl();
  mountPriceControl();
  syncSlotModeUi();
  syncUnlimitedUi();
  // Formatting and the tooltip stay owned here, so the two files cannot drift
  // into rendering the same figure two ways.
  window.RoutabilityView.mount({
    M,
    GRAPH: window.GRAPH_DATA,
    bindTooltip,
    fmt: {
      int: fmtInt,
      sat: fmtSat,
      usd: fmtUsd,
      usdCompact: fmtUsdCompact,
      pct: fmtPct,
      compactSat,
    },
    tip: {
      show: (nodes, x, y) => { tooltip.replaceChildren(...nodes); placeTooltip(x, y); },
    },
  });
  renderAll();
})();
