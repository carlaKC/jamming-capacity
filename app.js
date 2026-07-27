/* UI wiring for the jamming mitigation explorer. All bucket math lives in
 * math.js; this file owns state, validation and rendering. */
(function () {
  "use strict";

  const M = window.BucketMath;
  const DATA = window.EDGE_DATA;
  const CDF = M.makeCdf(DATA.hist);

  const PRESET_TYPES = [483, 114, 50];
  const PERCENTILES = [10, 25, 50, 75, 90, 99];
  const DEFAULT_PCT_PRICE = 75000;

  const state = {
    generalPct: 40,
    congestionPct: 20,
    // Slots split by percentage of max_accepted_htlcs by default; "fixed"
    // hard-sets the two counts instead.
    slotMode: "pct",
    generalSlotPct: 40,
    congestionSlotPct: 20,
    generalSlots: 30,
    congestionSlots: 10,
    channelTypes: [483, 114, 50],
    minSlots: 5,
    allocPct: 5,
    prices: [50000, 75000, 100000],
    thresholds: [1, 5, 10, 25, 50, 100, 250, 500],
    tab: "general",
    pctPrice: DEFAULT_PCT_PRICE,
    pctType: 483,
  };

  const $ = (id) => document.getElementById(id);

  // ---------------- formatting ----------------

  const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
  const fmtSat = (x) => fmtInt(x) + " sat";
  const fmtUsd = (x) => "$" + x.toLocaleString("en-US");
  // Money to the cent — percentile cells span $0.66 to $13,200. Rounds to an
  // integer number of cents first so analyze_buckets.py, which formats the
  // same doubles in Python, lands on the same cent. Intl and Python's %.2f
  // disagree on halfway-looking values such as 9.045.
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

  // The selected price, falling back to the median configured one when the
  // selection has been removed from the sidebar list.
  function pctPrice() {
    if (state.prices.includes(state.pctPrice)) return state.pctPrice;
    const sorted = [...state.prices].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  }

  // The percentile table shows one channel type at a time: under percentage
  // slots the three limits scale with max_accepted_htlcs, so there is no
  // single answer across types. Falls back to the largest active type.
  function pctType() {
    if (state.channelTypes.includes(state.pctType)) return state.pctType;
    return Math.max(...state.channelTypes);
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
      tr.appendChild(thresholdHead(t));
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
    tbody.appendChild(thresholdAddRow(metrics.length * prices.length));
    table.appendChild(tbody);
    $("table-wrap").replaceChildren(table);
  }

  // ---------------- rendering: channel percentile table ----------------

  // Inverse of the distribution table: instead of "what share of edges clear
  // $X", it asks "what can the edge at percentile P actually forward".
  const PCT_COLUMNS = [
    ["One general slot", (m) => m.generalSlotFrac],
    ["All general slots", (m) => m.peerGeneralFrac],
    ["Congestion slot", (m) => m.congestionSlotFrac],
  ];

  // A <select> for the percentile table's corner cell.
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

  function renderPercentiles() {
    const price = pctPrice();
    const type = pctType();
    const m = typeMetrics(type);

    $("pct-caption").textContent =
      "Largest single HTLC each bucket admits for the edge at a given " +
      "max_htlc percentile, in USD. \"All general slots\" is one peer's " +
      "allocation of k = " + m.k + " of the " + m.slots.general +
      " general slots. Hover a cell for sat values.";

    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");

    // Corner cell holds the price and channel-type selectors.
    const corner = el("th", "row-head");
    corner.appendChild(cornerSelect(
      "BTC price for the percentile table",
      [...state.prices].sort((a, b) => a - b), price,
      (p) => "@ $" + compactUsd(p) + " / BTC",
      (p) => { state.pctPrice = p; }));
    corner.appendChild(cornerSelect(
      "Channel type for the percentile table",
      [...state.channelTypes].sort((a, b) => b - a), type,
      (n) => fmtInt(n) + " slots",
      (n) => { state.pctType = n; }));
    hr.appendChild(corner);

    for (const [label] of PCT_COLUMNS) hr.appendChild(el("th", null, label));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const p of PERCENTILES) {
      const base = M.percentileSat(CDF, p);
      const tr = el("tr");
      tr.appendChild(el("th", "row-head", fmtPctile(p)));
      for (const [label, pick] of PCT_COLUMNS) {
        const frac = pick(m);
        const td = el("td");
        if (!(frac > 0) || !isFinite(base)) {
          td.textContent = "n/a";
          td.classList.add("na");
        } else {
          const sat = base * frac;
          td.textContent = fmtUsdCents(M.satToUsd(sat, price));
          td.dataset.pctile = String(p);
          td.dataset.bucket = label;
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

  function renderAll() {
    const metrics = activeMetrics();
    renderMetrics(metrics);
    renderTable(metrics);
    renderPercentiles();
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
        if (!active) {
          const offenders = tooSmallForFixed(
            state.generalSlots, state.congestionSlots, [n]);
          if (offenders) {
            setError("type-error", fixedFitMessage(
              offenders, state.generalSlots, state.congestionSlots));
            return;
          }
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
    (v) => {
      if (!(Number.isInteger(v) && v >= 1 && v <= 483)) {
        return "Enter a whole number of slots between 1 and 483 (the BOLT 2 maximum).";
      }
      const offenders = tooSmallForFixed(
        state.generalSlots, state.congestionSlots, [v]);
      return offenders
        ? fixedFitMessage(offenders, state.generalSlots, state.congestionSlots)
        : null;
    },
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

  // ---------------- tabs ----------------

  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      for (const b of document.querySelectorAll(".tab")) {
        b.classList.toggle("active", b === btn);
      }
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
    tooltip.replaceChildren(
      el("div", "tt-value", fmtUsd(t) + " ≈ " + fmtSat(M.usdToSat(t, p))),
      el("div", "tt-line", "at $" + p.toLocaleString("en-US") + " / BTC"),
      el("div", "tt-line", "needs max_htlc ≥ " + fmtSat(req)),
      el("div", "tt-line",
        fmtInt(share * CDF.total) + " of " + fmtInt(CDF.total) + " edges qualify"),
    );
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
  bindTooltip("pct-wrap", "td[data-sat]", showPctTooltip);

  // ---------------- boot ----------------

  $("provenance").textContent =
    "Data: " + DATA.source + " (" + DATA.generated + ") — " +
    fmtInt(DATA.directionsKept) + " directed edges kept, " +
    fmtInt(DATA.directionsDropped) +
    " dropped (single-channel node or no max_htlc).";

  syncSlotModeUi();
  renderTypeChips();
  renderPriceList();
  renderAll();
})();
