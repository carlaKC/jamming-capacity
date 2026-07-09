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

  // ---------------- rendering: metric cards ----------------

  function statTile(label, value, note) {
    const tile = el("div", "stat");
    tile.appendChild(el("div", "stat-label", label));
    tile.appendChild(el("div", "stat-value", value));
    if (note) tile.appendChild(el("div", "stat-note", note));
    return tile;
  }

  function renderMetrics(metrics) {
    const root = $("metrics");
    root.replaceChildren();
    for (const m of metrics) {
      const card = el("div", "metric-card");
      card.appendChild(el("h3", null, fmtInt(m.maxAcceptedHtlcs) + " slot channel"));
      const grid = el("div", "stat-grid");
      grid.appendChild(statTile(
        "Slots g / c / p",
        m.slots.general + " / " + m.slots.congestion + " / " + m.slots.protected));
      grid.appendChild(statTile("Per-peer general slots", String(m.k)));
      grid.appendChild(statTile(
        "Channels to saturate general",
        isFinite(m.saturate) ? "~" + fmtInt(m.saturate) : "n/a",
        "coupon-collector expectation"));
      grid.appendChild(statTile(
        "Liquidity per general slot",
        fmtPct(m.generalSlotFrac),
        "of max_htlc_value_in_flight"));
      grid.appendChild(statTile(
        "Max per-peer in general",
        fmtPct(m.peerGeneralFrac),
        "largest single HTLC"));
      grid.appendChild(statTile(
        "Congestion per slot",
        fmtPct(m.congestionSlotFrac),
        "largest congestion HTLC"));
      card.appendChild(grid);
      root.appendChild(card);
    }
  }

  // Replaced with the real table renderer in the next commit.
  function renderTable(metrics) {} // eslint-disable-line no-unused-vars

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
    $("split-preset").classList.toggle("active", g === 40 && c === 20);
    renderAll();
  }

  $("general-pct").addEventListener("input", onSplitInput);
  $("congestion-pct").addEventListener("input", onSplitInput);
  $("split-preset").addEventListener("click", () => {
    $("general-pct").value = "40";
    $("congestion-pct").value = "20";
    onSplitInput();
  });
  $("split-custom-toggle").addEventListener("click", () => {
    $("split-custom").classList.toggle("hidden");
  });

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

  // ---------------- removable value chips (prices, thresholds) ----------------

  function renderValueChips(rootId, key, format, errId, keepMsg) {
    const root = $(rootId);
    root.replaceChildren();
    for (const v of [...state[key]].sort((a, b) => a - b)) {
      const chip = el("button", "chip active", format(v));
      chip.type = "button";
      chip.appendChild(el("span", "x", "×"));
      chip.addEventListener("click", () => {
        if (state[key].length === 1) {
          setError(errId, keepMsg);
          return;
        }
        state[key] = state[key].filter((x) => x !== v);
        setError(errId, null);
        renderValueChips(rootId, key, format, errId, keepMsg);
        renderAll();
      });
      root.appendChild(chip);
    }
  }

  const renderPriceChips = () =>
    renderValueChips("price-chips", "prices", (p) => "$" + compactUsd(p),
      "price-error", "Keep at least one price.");
  const renderThresholdChips = () =>
    renderValueChips("threshold-chips", "thresholds", (t) => fmtUsd(t),
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
      renderPriceChips();
    });

  bindAdd("threshold-add", "threshold-add-btn", "threshold-error",
    (v) => (v > 0 ? null : "Enter a positive dollar amount."),
    (v) => {
      if (!state.thresholds.includes(v)) state.thresholds.push(v);
      renderThresholdChips();
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

  // ---------------- boot ----------------

  $("provenance").textContent =
    "Data: " + DATA.source + " (" + DATA.generated + ") — " +
    fmtInt(DATA.directionsKept) + " directed edges kept, " +
    fmtInt(DATA.directionsDropped) +
    " dropped (single-channel node or no max_htlc).";

  renderTypeChips();
  renderPriceChips();
  renderThresholdChips();
  renderAll();
})();
