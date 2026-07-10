/* UI wiring for the jamming mitigation explorer. All bucket math lives in
 * math.js; this file owns state, validation and rendering. */
(function () {
  "use strict";

  const M = window.BucketMath;
  const DATA = window.EDGE_DATA;
  const CDF = M.makeCdf(DATA.hist);

  const PRESET_TYPES = [483, 114, 50];

  const state = {
    generalPct: 40,
    congestionPct: 20,
    channelTypes: [483, 114, 50],
    minSlots: 5,
    allocPct: 5,
    prices: [50000, 75000, 100000],
    thresholds: [1, 5, 10, 25, 50, 100, 250, 500],
    tab: "general",
  };

  const $ = (id) => document.getElementById(id);

  // ---------------- formatting ----------------

  const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
  const fmtSat = (x) => fmtInt(x) + " sat";
  const fmtUsd = (x) => "$" + x.toLocaleString("en-US");
  const fmtPct = (frac, digits) =>
    isFinite(frac) ? (frac * 100).toFixed(digits === undefined ? 2 : digits) + "%" : "n/a";
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

  // ---------------- derived metrics ----------------

  const saturationCache = new Map();
  function channelsToSaturate(n, k) {
    const key = n + ":" + k;
    if (!saturationCache.has(key)) {
      saturationCache.set(key, M.channelsToSaturate(n, k));
    }
    return saturationCache.get(key);
  }

  function typeMetrics(n) {
    const slots = M.bucketSlots(n, state.generalPct, state.congestionPct);
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
    ["Largest per-peer general HTLC", (m) => fmtPct(m.peerGeneralFrac)],
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

  // The bucket's largest single HTLC as a fraction of the edge's max_htlc:
  // general = the whole per-peer liquidity allocation; congestion = one
  // slot's worth.
  function cellFrac(m) {
    return state.tab === "general" ? m.peerGeneralFrac : m.congestionSlotFrac;
  }

  function shadeCell(td, share) {
    const alpha = share * 0.92;
    td.style.background = "rgba(var(--cell-rgb), " + alpha.toFixed(3) + ")";
    // Deep-moss ramp: pale-mist text only once the fill is dark enough to
    // carry it (~4.5:1 at 0.7 on the rice-paper surface).
    if (alpha > 0.7) td.classList.add("cell-dark");
  }

  function renderTable(metrics) {
    $("table-caption").textContent = state.tab === "general"
      ? "Share of mainnet directed edges able to carry a single HTLC of at " +
        "least $X in the general bucket (per-peer liquidity allocation: " +
        "k slots' worth). Hover a cell for sat values."
      : "Share of mainnet directed edges able to carry a single HTLC of at " +
        "least $X in the congestion bucket (one slot's worth of liquidity). " +
        "Hover a cell for sat values.";

    const table = el("table");
    const thead = el("thead");

    const row1 = el("tr");
    row1.appendChild(el("th"));
    for (const m of metrics) {
      const th = el("th", "type-head group-start", fmtInt(m.maxAcceptedHtlcs) + " slots");
      th.colSpan = state.prices.length;
      row1.appendChild(th);
    }
    thead.appendChild(row1);

    const prices = [...state.prices].sort((a, b) => a - b);
    const thresholds = [...state.thresholds].sort((a, b) => a - b);

    const row2 = el("tr");
    row2.appendChild(el("th", "row-head", "Threshold"));
    for (let g = 0; g < metrics.length; g++) {
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
      tr.appendChild(el("th", "row-head", "≥ " + fmtUsd(t)));
      for (const m of metrics) {
        const frac = cellFrac(m);
        prices.forEach((p, i) => {
          const td = el("td", i === 0 ? "group-start" : null);
          if (!(frac > 0)) {
            td.textContent = "n/a";
            td.classList.add("na");
          } else {
            const req = M.requiredBaseSat(t, p, frac);
            const share = M.shareAtOrAbove(CDF, req);
            td.textContent = (share * 100).toFixed(1) + "%";
            td.dataset.threshold = String(t);
            td.dataset.price = String(p);
            td.dataset.required = String(Math.ceil(req));
            td.dataset.share = String(share);
            shadeCell(td, share);
          }
          tr.appendChild(td);
        });
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    $("table-wrap").replaceChildren(table);
  }

  function renderAll() {
    const metrics = activeMetrics();
    renderMetrics(metrics);
    renderTable(metrics);
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

  // ---------------- bucket split ----------------

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

  // ---------------- channel type chips ----------------

  function renderTypeChips() {
    const root = $("type-chips");
    root.replaceChildren();
    const all = [...new Set([...PRESET_TYPES, ...state.channelTypes])].sort((a, b) => b - a);
    for (const n of all) {
      const active = state.channelTypes.includes(n);
      const custom = !PRESET_TYPES.includes(n);
      const chip = el("button", "chip" + (active ? " active" : ""), String(n));
      chip.type = "button";
      if (custom) chip.appendChild(el("span", "x", "×"));
      chip.addEventListener("click", () => {
        if (active && state.channelTypes.length === 1) {
          setError("type-error", "Keep at least one channel type.");
          return;
        }
        state.channelTypes = active
          ? state.channelTypes.filter((v) => v !== n)
          : [...state.channelTypes, n];
        setError("type-error", null);
        renderTypeChips();
        renderAll();
      });
      root.appendChild(chip);
    }
  }

  // ---------------- sorted value lists (prices, thresholds) ----------------

  function renderValueList(rootId, key, format, errId, keepMsg) {
    const root = $(rootId);
    root.replaceChildren();
    for (const v of [...state[key]].sort((a, b) => a - b)) {
      const row = el("div", "value-row");
      row.appendChild(el("span", "value-label", format(v)));
      const remove = el("button", "value-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + format(v));
      remove.addEventListener("click", () => {
        if (state[key].length === 1) {
          setError(errId, keepMsg);
          return;
        }
        state[key] = state[key].filter((x) => x !== v);
        setError(errId, null);
        renderValueList(rootId, key, format, errId, keepMsg);
        renderAll();
      });
      row.appendChild(remove);
      root.appendChild(row);
    }
  }

  const renderPriceList = () =>
    renderValueList("price-list", "prices", fmtUsd,
      "price-error", "Keep at least one price.");
  const renderThresholdList = () =>
    renderValueList("threshold-list", "thresholds", fmtUsd,
      "threshold-error", "Keep at least one threshold.");

  // ---------------- add-value inputs ----------------

  function bindAdd(inputId, btnId, errId, parse, apply) {
    const submit = () => {
      const raw = readNumber($(inputId));
      const err = parse(raw);
      if (err) {
        setError(errId, err);
        $(inputId).classList.add("invalid");
        return;
      }
      $(inputId).classList.remove("invalid");
      $(inputId).value = "";
      setError(errId, null);
      apply(raw);
      renderAll();
    };
    $(btnId).addEventListener("click", submit);
    $(inputId).addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  bindAdd("type-add", "type-add-btn", "type-error",
    (v) => (Number.isInteger(v) && v >= 1 && v <= 483
      ? null
      : "Enter a whole number of slots between 1 and 483 (the BOLT 2 maximum)."),
    (v) => {
      if (!state.channelTypes.includes(v)) state.channelTypes.push(v);
      renderTypeChips();
    });

  bindAdd("price-add", "price-add-btn", "price-error",
    (v) => (v > 0 ? null : "Enter a positive price."),
    (v) => {
      if (!state.prices.includes(v)) state.prices.push(v);
      renderPriceList();
    });

  bindAdd("threshold-add", "threshold-add-btn", "threshold-error",
    (v) => (v > 0 ? null : "Enter a positive dollar amount."),
    (v) => {
      if (!state.thresholds.includes(v)) state.thresholds.push(v);
      renderThresholdList();
    });

  // ---------------- tabs ----------------

  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      for (const b of document.querySelectorAll(".tab")) {
        b.classList.toggle("active", b === btn);
      }
      renderTable(activeMetrics());
    });
  }

  // ---------------- tooltip ----------------

  const tooltip = $("tooltip");

  function hideTooltip() {
    tooltip.classList.add("hidden");
  }

  function showTooltip(td, x, y) {
    const t = Number(td.dataset.threshold);
    const p = Number(td.dataset.price);
    const req = Number(td.dataset.required);
    const share = Number(td.dataset.share);
    tooltip.replaceChildren(
      el("div", "tt-value", fmtUsd(t) + " ≈ " + fmtSat(M.usdToSat(t, p))),
      el("div", "tt-line", "at $" + p.toLocaleString("en-US") + " / BTC"),
      el("div", "tt-line", "needs max_htlc ≥ " + fmtSat(req)),
      el("div", "tt-line",
        fmtInt(share * CDF.total) + " of " + fmtInt(CDF.total) + " edges qualify"),
    );
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

  $("table-wrap").addEventListener("pointermove", (e) => {
    const td = e.target.closest("td[data-price]");
    if (td) showTooltip(td, e.clientX, e.clientY);
    else hideTooltip();
  });
  $("table-wrap").addEventListener("pointerleave", hideTooltip);

  // ---------------- boot ----------------

  $("provenance").textContent =
    "Data: " + DATA.source + " (" + DATA.generated + ") — " +
    fmtInt(DATA.directionsKept) + " directed edges kept, " +
    fmtInt(DATA.directionsDropped) +
    " dropped (single-channel node or no max_htlc).";

  renderTypeChips();
  renderPriceList();
  renderThresholdList();
  renderAll();
})();
