/* General-bucket routability visualizer.
 *
 * One question: under the local resource conservation limits, what share of
 * payments keeps flowing through the general bucket — no reputation required?
 *
 * Both curves come from routes sampled out of the real graph at build time
 * (see build_data.py), indexed by how many nodes forward on them: A->B->C is
 * one hop, because only B forwards. Each sampled route is reduced to its
 * bottleneck — the smallest max_htlc among the channels a general bucket
 * actually applies to — so the share of routes that clear a payment is just
 * the share of bottlenecks at or above payment / frac. Every bucket parameter
 * on the page moves frac; the sampled topology stays put.
 *
 * All bucket math lives in math.js; this file owns the section's own state
 * (payment cursor, price, channel type) and its SVG rendering. app.js hands it
 * the current bucket parameters on every render.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RoutabilityView = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------- palette ----------------
  // The site's own hue angles (moss 134°, clay 62°) stepped just past the
  // chroma floor so they still do identity work. Validated light-mode:
  // CVD dE 10.4 protan, normal-vision 20.7, both >= 3:1 on the surface.
  const SERIES = {
    hop: "#477129",    // slot 1 — per-hop
    route: "#C38144",  // slot 2 — per-route
  };
  // Single-hue sequential ramp for the heatmap, light -> dark = less -> more
  // stays in general. Light end clears 2:1 on the surface.
  const RAMP = ["#B1B8AB", "#9BA494", "#85907D", "#6F7B66", "#58674F"];
  const GRID = "#DED8CF";
  const AXIS_INK = "#78786C";

  // Payment-size axis: five decades, $0.10 to $10,000.
  const USD_MIN = 0.1;
  const USD_MAX = 10000;
  const DECADES = [0.1, 1, 10, 100, 1000, 10000];
  // Where everyday Lightning payments actually sit. Shaded, not labelled.
  const TYPICAL = [10, 200];
  const ROUTE_HOPS = 3;
  const ALL_HOPS = [1, 2, 3, 4, 5, 6];
  // Presets for the matrix's corner dropdown, matching the distribution
  // table's thresholds. Dragging still lands on arbitrary amounts, which the
  // dropdown picks up as an extra option.
  const PAYMENTS = [1, 5, 10, 25, 50, 100, 250, 500];
  const HEAT_COLS = 25;          // half-decade-ish columns across the span
  const CURVE_POINTS = 160;

  const clampUsd = (u) => Math.min(USD_MAX, Math.max(USD_MIN, u));

  // Routing roles, ordered as the matrix reads. Descriptions are the whole
  // justification for the split, so they live next to it.
  const TIERS = [
    { key: "terminal", label: "Terminal",
      blurb: "never forwards for anyone — wallets and merchants" },
    { key: "peripheral", label: "Peripheral",
      blurb: "forwards, but carries little of the traffic" },
    { key: "core", label: "Core",
      blurb: "the smallest set carrying 90% of all transit" },
  ];

  const state = {
    payUsd: 50,
    price: 75000,
    type: 483,
    src: "terminal",     // who is paying
    dst: "terminal",     // who is being paid
  };

  // Hop counts the sample actually covers, so a thin dataset cannot leave
  // empty rows on the heatmap.
  let HEAT_HOPS = ALL_HOPS;

  // Live handles into the rendered SVG, so dragging the cursor can move it
  // without rebuilding the whole section on every pointer event.
  const refs = {
    payInput: null, cursorLine: null, hopDot: null, routeDot: null,
    heatBox: null, heatCellW: 0,
  };

  let M = null;
  let MATRIX = null;      // MATRIX[sender][receiver] = { "1": cdf, ..., all }
  let params = null;      // { typeMetrics, channelTypes, prices }
  let mounted = false;
  let tooltipEl = null;

  // ---------------- helpers ----------------

  const $ = (id) => document.getElementById(id);

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

  const fmtPct1 = (x) => (x * 100).toFixed(1) + "%";
  const fmtInt = (x) => Math.round(x).toLocaleString("en-US");

  function fmtUsd(x) {
    if (x >= 1000) return "$" + (x / 1000).toLocaleString("en-US",
      { maximumFractionDigits: x >= 10000 ? 0 : 1 }) + "k";
    if (x >= 1) return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return "$" + x.toFixed(2);
  }

  // Resolve a stored selection against what is actually configured.
  const pick = (want, list, fallback) =>
    list.includes(want) ? want : fallback(list);

  function activeType() {
    return pick(state.type, params.channelTypes, (l) => Math.max(...l));
  }
  function activePrice() {
    return pick(state.price, params.prices, (l) => {
      const s = [...l].sort((a, b) => a - b);
      return s[Math.floor((s.length - 1) / 2)];
    });
  }

  // The fraction of an edge's max_htlc one peer may push through general.
  function routableFrac() {
    return params.typeMetrics(activeType()).peerGeneralFrac;
  }

  // The selected sender -> receiver cell.
  function cell(src, dst) {
    return (MATRIX[src || state.src] || {})[dst || state.dst] || {};
  }

  // Share of sampled `hops`-hop routes whose bottleneck clears this payment.
  // hops "all" merges every route length in the cell.
  function routeAt(usd, hops, src, dst) {
    const sat = M.usdToSat(usd, activePrice());
    return M.routeRoutability(cell(src, dst)[hops], sat, routableFrac());
  }

  // ---------------- verdict ----------------

  // Reserved status states, always shipped with a glyph and a word so the
  // reading never rests on colour alone.
  const VERDICTS = [
    { min: 0.6, key: "good", glyph: "●", label: "flows in general" },
    { min: 0.2, key: "warning", glyph: "◐", label: "partly reputation-gated" },
    { min: 0, key: "critical", glyph: "▲", label: "mostly needs reputation" },
  ];
  const verdictFor = (routeShare) => VERDICTS.find((v) => routeShare >= v.min);

  // ---------------- main chart ----------------

  const CW = 720, CH = 300;
  const PAD = { top: 16, right: 96, bottom: 40, left: 52 };
  const PW = CW - PAD.left - PAD.right;
  const PH = CH - PAD.top - PAD.bottom;

  const xOf = (usd) =>
    PAD.left + (Math.log10(usd / USD_MIN) / 5) * PW;
  const yOf = (share) => PAD.top + (1 - share) * PH;

  function curvePoints() {
    const pts = [];
    for (let i = 0; i <= CURVE_POINTS; i++) {
      const usd = USD_MIN * Math.pow(10, (i / CURVE_POINTS) * 5);
      pts.push({ usd, hop: routeAt(usd, 1), route: routeAt(usd, ROUTE_HOPS) });
    }
    return pts;
  }

  function pathFrom(pts, key) {
    return pts.map((p, i) =>
      (i ? "L" : "M") + xOf(p.usd).toFixed(2) + " " + yOf(p[key]).toFixed(2)
    ).join(" ");
  }

  function renderChart(pts) {
    const node = svg("svg", {
      viewBox: `0 0 ${CW} ${CH}`,
      class: "routability-chart",
      role: "img",
      "aria-label":
        "Share of sampled routes clearing the general bucket against payment " +
        "size, for one-hop and for three-hop routes. Figures for the selected " +
        "payment size are stated in the tiles above the chart.",
    });

    // Typical-payment reference band, behind everything.
    node.appendChild(svg("rect", {
      x: xOf(TYPICAL[0]), y: PAD.top,
      width: xOf(TYPICAL[1]) - xOf(TYPICAL[0]), height: PH,
      fill: "rgba(193, 140, 93, 0.07)",
    }));

    // Hairline grid + axes, solid, one shade off the surface.
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      const y = yOf(share);
      node.appendChild(svg("line", {
        x1: PAD.left, y1: y, x2: PAD.left + PW, y2: y,
        stroke: GRID, "stroke-width": 1,
      }));
      node.appendChild(svg("text", {
        x: PAD.left - 10, y: y + 4, "text-anchor": "end", class: "chart-tick",
      }, Math.round(share * 100) + "%"));
    }
    for (const d of DECADES) {
      node.appendChild(svg("text", {
        x: xOf(d), y: CH - PAD.bottom + 20, "text-anchor": "middle",
        class: "chart-tick",
      }, fmtUsd(d)));
    }
    node.appendChild(svg("text", {
      x: PAD.left + PW / 2, y: CH - 6, "text-anchor": "middle",
      class: "chart-axis-title",
    }, "payment size (log scale)"));

    node.appendChild(svg("path", {
      d: pathFrom(pts, "hop"), fill: "none", stroke: SERIES.hop,
      "stroke-width": 2, "stroke-linejoin": "round",
    }));
    node.appendChild(svg("path", {
      d: pathFrom(pts, "route"), fill: "none", stroke: SERIES.route,
      "stroke-width": 2, "stroke-linejoin": "round",
    }));

    // Selective direct labels, placed where the curves are furthest apart.
    // Labelling the right-hand ends would stack them: both converge on zero
    // there. The curves cross -- a one-hop route's only gated channel is a
    // hub's channel to a leaf -- so the label goes above whichever is higher
    // at that point rather than assuming an order.
    let widest = pts[0];
    const gap = (p) => Math.abs(p.hop - p.route);
    for (const p of pts) if (gap(p) > gap(widest)) widest = p;
    const lx = xOf(widest.usd);
    const hopOnTop = widest.hop >= widest.route;
    node.appendChild(svg("text", {
      x: lx, y: yOf(widest.hop) + (hopOnTop ? -9 : 18), "text-anchor": "middle",
      class: "chart-label", fill: SERIES.hop,
    }, "one hop"));
    node.appendChild(svg("text", {
      x: lx, y: yOf(widest.route) + (hopOnTop ? 18 : -9), "text-anchor": "middle",
      class: "chart-label", fill: SERIES.route,
    }, ROUTE_HOPS + "-hop route"));

    // Cursor. Draggable: the line is the payment-size control, mirrored by the
    // input field above the chart.
    const cx = xOf(state.payUsd);
    const hop = routeAt(state.payUsd, 1);
    const route = routeAt(state.payUsd, ROUTE_HOPS);
    refs.cursorLine = svg("line", {
      x1: cx, y1: PAD.top, x2: cx, y2: PAD.top + PH,
      stroke: AXIS_INK, "stroke-width": 1,
    });
    node.appendChild(refs.cursorLine);
    // 2px surface ring rather than a border, so overlapping dots separate.
    refs.hopDot = svg("circle", {
      cx, cy: yOf(hop), r: 5, fill: SERIES.hop,
      stroke: "#FEFEFA", "stroke-width": 2,
    });
    refs.routeDot = svg("circle", {
      cx, cy: yOf(route), r: 5, fill: SERIES.route,
      stroke: "#FEFEFA", "stroke-width": 2,
    });
    node.append(refs.hopDot, refs.routeDot);

    // One overlay across the plot handles both the crosshair tooltip and the
    // drag, so the hit target is the whole plot rather than the 1px line.
    const overlay = svg("rect", {
      x: PAD.left, y: PAD.top, width: PW, height: PH,
      fill: "transparent", class: "chart-overlay",
    });
    const usdAt = (clientX) => {
      const box = node.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * CW;   // viewBox units
      return clampUsd(USD_MIN * Math.pow(10, ((px - PAD.left) / PW) * 5));
    };
    const nearest = (usd) => {
      const i = Math.round((Math.log10(usd / USD_MIN) / 5) * CURVE_POINTS);
      return pts[Math.min(pts.length - 1, Math.max(0, i))];
    };
    overlay.addEventListener("pointermove", (e) => {
      if (!dragging) showChartTip(nearest(usdAt(e.clientX)), e);
    });
    overlay.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hideTip();
      startDrag(usdAt);
      setPayment(usdAt(e.clientX));
    });
    node.appendChild(overlay);
    node.addEventListener("pointerleave", () => { if (!dragging) hideTip(); });

    return node;
  }

  // ---------------- payment cursor ----------------

  let dragging = false;

  // Listeners live on the document so the drag survives the pointer leaving
  // the plot, and so re-rendering the SVG mid-drag cannot orphan them.
  function startDrag(usdAt) {
    dragging = true;
    document.body.classList.add("dragging-cursor");
    const move = (e) => setPayment(usdAt(e.clientX));
    const end = () => {
      dragging = false;
      document.body.classList.remove("dragging-cursor");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
  }

  // Moves the cursor without rebuilding the section: the curves and the
  // heatmap cells don't depend on the payment size, only the marks on top do.
  function setPayment(usd) {
    state.payUsd = clampUsd(usd);
    const cx = xOf(state.payUsd);
    const hop = routeAt(state.payUsd, 1);
    const route = routeAt(state.payUsd, ROUTE_HOPS);
    if (refs.cursorLine) {
      refs.cursorLine.setAttribute("x1", cx);
      refs.cursorLine.setAttribute("x2", cx);
      refs.hopDot.setAttribute("cx", cx);
      refs.hopDot.setAttribute("cy", yOf(hop));
      refs.routeDot.setAttribute("cx", cx);
      refs.routeDot.setAttribute("cy", yOf(route));
    }
    if (refs.heatBox) {
      refs.heatBox.setAttribute("x",
        HPAD.left + heatIndex(state.payUsd) * refs.heatCellW - 2);
    }
    if (refs.payInput && document.activeElement !== refs.payInput) {
      refs.payInput.value = roundForInput(state.payUsd);
    }
    $("rout-tiles").replaceChildren(renderTiles());
    // The matrix is shaded at the payment size too, so a drag has to carry it
    // along or the grid silently describes the old amount.
    $("rout-matrix").replaceChildren(renderMatrix());
    renderCaption();
  }

  // Dragging lands on arbitrary reals; show something a person would type.
  function roundForInput(usd) {
    if (usd >= 100) return String(Math.round(usd));
    if (usd >= 10) return String(Math.round(usd * 10) / 10);
    return String(Math.round(usd * 100) / 100);
  }

  // ---------------- heatmap ----------------

  const rampIndex = (share) => Math.min(RAMP.length - 1,
    Math.max(0, Math.floor(share * RAMP.length)));

  // Each column is a bin covering an equal slice of the log axis, represented
  // by the payment size at its midpoint. Indexing by i/(HEAT_COLS-1) instead
  // would drift the cells off the axis labels by up to a cell at the far end.
  const heatFrac = (i) => (i + 0.5) / HEAT_COLS;
  const heatIndex = (usd) => Math.min(HEAT_COLS - 1, Math.max(0,
    Math.floor((Math.log10(usd / USD_MIN) / 5) * HEAT_COLS)));

  // Each row is its own measured sample now, so a column carries one share per
  // hop count rather than a single figure raised to a power.
  function heatColumns() {
    const cols = [];
    for (let i = 0; i < HEAT_COLS; i++) {
      const usd = USD_MIN * Math.pow(10, heatFrac(i) * 5);
      const byHop = {};
      for (const h of HEAT_HOPS) byHop[h] = routeAt(usd, h);
      cols.push({ usd, byHop });
    }
    return cols;
  }

  const HW = 720, HROW = 30, HPAD = { top: 8, right: 12, bottom: 34, left: 52 };

  function renderHeatmap(cols) {
    const height = HPAD.top + HEAT_HOPS.length * HROW + HPAD.bottom;
    const plotW = HW - HPAD.left - HPAD.right;
    const cellW = plotW / HEAT_COLS;
    const node = svg("svg", {
      viewBox: `0 0 ${HW} ${height}`,
      class: "routability-heat",
      role: "img",
      "aria-label":
        "Share of sampled routes clearing the general bucket by payment size " +
        "and hop count, one to six hops. Hovering a cell states its figure.",
    });

    HEAT_HOPS.forEach((h, r) => {
      const y = HPAD.top + r * HROW;
      node.appendChild(svg("text", {
        x: HPAD.left - 10, y: y + HROW / 2 + 4, "text-anchor": "end",
        class: "chart-tick",
      }, h + (h === 1 ? " hop" : " hops")));
      cols.forEach((c, i) => {
        const share = c.byHop[h];
        // 2px surface gap between cells instead of a border.
        node.appendChild(svg("rect", {
          x: HPAD.left + i * cellW + 1, y: y + 1,
          width: Math.max(1, cellW - 2), height: HROW - 2,
          fill: RAMP[rampIndex(share)], rx: 3,
        }));
      });
    });

    // Cursor column outline goes on last, so the cells don't cover it.
    refs.heatCellW = cellW;
    refs.heatBox = svg("rect", {
      x: HPAD.left + heatIndex(state.payUsd) * cellW - 2, y: HPAD.top - 4,
      width: cellW + 4, height: HEAT_HOPS.length * HROW + 8,
      fill: "none", stroke: "#4A4A40", "stroke-width": 1.5, rx: 6,
      "pointer-events": "none",
    });
    node.appendChild(refs.heatBox);

    // One overlay across the grid, as on the chart: it carries both the
    // per-cell tooltip and the drag, so the payment size can be swept here too.
    const gridH = HEAT_HOPS.length * HROW;
    const overlay = svg("rect", {
      x: HPAD.left, y: HPAD.top, width: plotW, height: gridH,
      fill: "transparent", class: "chart-overlay",
    });
    const usdAt = (clientX) => {
      const box = node.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * HW;   // viewBox units
      return clampUsd(USD_MIN * Math.pow(10, ((px - HPAD.left) / plotW) * 5));
    };
    overlay.addEventListener("pointermove", (e) => {
      if (dragging) return;
      const box = node.getBoundingClientRect();
      const py = ((e.clientY - box.top) / box.height) * height;
      const r = Math.min(HEAT_HOPS.length - 1,
        Math.max(0, Math.floor((py - HPAD.top) / HROW)));
      const c = cols[heatIndex(usdAt(e.clientX))];
      showHeatTip(c.usd, HEAT_HOPS[r], c.byHop[HEAT_HOPS[r]], e);
    });
    overlay.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hideTip();
      startDrag(usdAt);
      setPayment(usdAt(e.clientX));
    });
    node.appendChild(overlay);

    for (const d of DECADES) {
      const frac = Math.log10(d / USD_MIN) / 5;
      node.appendChild(svg("text", {
        x: HPAD.left + frac * plotW, y: height - HPAD.bottom + 22,
        "text-anchor": "middle", class: "chart-tick",
      }, fmtUsd(d)));
    }
    node.addEventListener("pointerleave", () => { if (!dragging) hideTip(); });
    return node;
  }

  function renderRampLegend() {
    const wrap = el("div", "ramp-legend");
    wrap.appendChild(el("span", "ramp-cap", "less stays in general"));
    for (let i = 0; i < RAMP.length; i++) {
      const sw = el("span", "ramp-step");
      sw.style.background = RAMP[i];
      sw.title = `${i * 20}–${(i + 1) * 20}%`;
      wrap.appendChild(sw);
    }
    wrap.appendChild(el("span", "ramp-cap", "more"));
    return wrap;
  }

  // ---------------- tooltips ----------------

  function place(e) {
    const pad = 14;
    const rect = tooltipEl.getBoundingClientRect();
    let left = e.clientX + pad;
    let top = e.clientY + pad;
    if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - pad;
    tooltipEl.style.left = left + "px";
    tooltipEl.style.top = top + "px";
  }

  function showChartTip(p, e) {
    tooltipEl.replaceChildren(
      el("div", "tt-value", fmtUsd(p.usd) + " payment"),
      el("div", "tt-line", "one hop: " + fmtPct1(p.hop)),
      el("div", "tt-line", ROUTE_HOPS + "-hop route: " + fmtPct1(p.route)),
    );
    tooltipEl.classList.remove("hidden");
    place(e);
  }

  function showHeatTip(usd, hops, share, e) {
    tooltipEl.replaceChildren(
      el("div", "tt-value", fmtPct1(share) + " of routes clear"),
      el("div", "tt-line", fmtUsd(usd) + " over " + hops +
        (hops === 1 ? " hop" : " hops")),
      el("div", "tt-line", "at " + fmtUsd(activePrice()) + " / BTC"),
    );
    tooltipEl.classList.remove("hidden");
    place(e);
  }

  const hideTip = () => tooltipEl.classList.add("hidden");

  // ---------------- controls ----------------

  function select(label, values, selected, format, onPick) {
    const sel = el("select", "corner-select");
    sel.setAttribute("aria-label", label);
    for (const v of values) {
      const opt = el("option", null, format(v));
      opt.value = String(v);
      if (v === selected) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => { onPick(Number(sel.value)); render(); });
    return sel;
  }

  function field(labelText, control) {
    const wrap = el("label", "rout-field");
    wrap.appendChild(el("span", "rout-field-label", labelText));
    wrap.appendChild(control);
    return wrap;
  }

  function renderControls() {
    const row = el("div", "rout-controls");

    row.appendChild(select("BTC price", [...params.prices].sort((a, b) => a - b),
      activePrice(), (p) => "@ " + fmtUsd(p) + " / BTC",
      (p) => { state.price = p; }));
    row.appendChild(select("Channel type",
      [...params.channelTypes].sort((a, b) => b - a), activeType(),
      (n) => fmtInt(n) + " slots", (n) => { state.type = n; }));

    const pay = el("input", "pay-input");
    pay.type = "number";
    pay.min = String(USD_MIN);
    pay.max = String(USD_MAX);
    pay.step = "1";
    pay.value = roundForInput(state.payUsd);
    pay.setAttribute("aria-label", "Payment size in dollars");
    pay.addEventListener("input", () => {
      const v = parseFloat(pay.value);
      const ok = Number.isFinite(v) && v >= USD_MIN && v <= USD_MAX;
      pay.classList.toggle("invalid", !ok);
      if (ok) setPayment(v);
    });
    refs.payInput = pay;
    row.appendChild(field("Payment size (USD)", pay));

    return row;
  }

  // ---------------- who pays whom ----------------

  // Rows are the sender's role, columns the receiver's. Both matter, but not
  // equally: the sender's own first channel is never gated, so its role only
  // shapes the route, while the receiver's role sets the last gated channel.
  // Shading matches the distribution table's ramp, including its contrast
  // switch, so the two read the same way.
  function renderMatrix() {
    const wrap = el("div", "matrix-wrap");
    const table = el("table", "persona-matrix");

    // The corner carries the payment size, as the percentile table's corner
    // carries its price. Dragging the chart or heatmap can land between the
    // presets, so the live value joins the list when it is not already there.
    const corner = el("th", "matrix-corner");
    const options = PAYMENTS.includes(state.payUsd)
      ? PAYMENTS
      : [...PAYMENTS, state.payUsd].sort((a, b) => a - b);
    // Not fmtUsd: it rounds to whole dollars and abbreviates thousands, so a
    // dragged $7.50 would be labelled $8 against its own value.
    corner.appendChild(select("Payment size", options, state.payUsd,
      (v) => "$" + roundForInput(v), (v) => { state.payUsd = clampUsd(v); }));
    const head = el("tr");
    head.appendChild(corner);
    for (const t of TIERS) {
      const th = el("th", null, t.label);
      th.title = t.blurb;
      head.appendChild(th);
    }
    const thead = el("thead");
    thead.appendChild(head);
    table.appendChild(thead);

    // Shares here sit in a narrow band, so a 0-100% ramp would render the whole
    // grid near-white. Scale to the strongest cell instead: every cell prints
    // its own figure, so the shading only has to carry the comparison.
    let peak = 0;
    for (const src of TIERS) {
      for (const dst of TIERS) {
        peak = Math.max(peak, routeAt(state.payUsd, "all", src.key, dst.key));
      }
    }

    const body = el("tbody");
    for (const src of TIERS) {
      const tr = el("tr");
      const rowHead = el("th", "row-head", src.label);
      rowHead.title = src.blurb;
      tr.appendChild(rowHead);
      for (const dst of TIERS) {
        const share = routeAt(state.payUsd, "all", src.key, dst.key);
        const td = el("td", "matrix-cell");
        const btn = el("button", "matrix-btn", fmtPct1(share));
        btn.type = "button";
        btn.setAttribute("aria-pressed",
          String(src.key === state.src && dst.key === state.dst));
        btn.setAttribute("aria-label",
          `${src.label} paying ${dst.label}: ${fmtPct1(share)} of routes clear`);
        const alpha = peak > 0 ? (share / peak) * 0.92 : 0;
        btn.style.background = "rgba(var(--cell-rgb), " + alpha.toFixed(3) + ")";
        if (alpha > 0.7) btn.classList.add("cell-dark");
        if (src.key === state.src && dst.key === state.dst) {
          td.classList.add("matrix-selected");
        }
        const total = (cell(src.key, dst.key).all || {}).total || 0;
        btn.addEventListener("click", () => {
          state.src = src.key;
          state.dst = dst.key;
          render();
        });
        btn.addEventListener("pointermove", (e) => showMatrixTip(src, dst, share, total, e));
        btn.addEventListener("pointerleave", hideTip);
        td.appendChild(btn);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  function showMatrixTip(src, dst, share, total, e) {
    tooltipEl.replaceChildren(
      el("div", "tt-value", fmtPct1(share) + " of routes clear"),
      el("div", "tt-line", src.label + " pays " + dst.label),
      el("div", "tt-line", fmtInt(total) + " sampled routes"),
      el("div", "tt-line", "receiver: " + dst.blurb),
    );
    tooltipEl.classList.remove("hidden");
    place(e);
  }

  const tierLabel = (key) =>
    (TIERS.find((t) => t.key === key) || { label: key }).label;

  // The corner cell holds the payment dropdown, so the axes are named here.
  // Everything below the matrix describes the selected cell, so say which.
  function renderCaption() {
    $("rout-caption").textContent =
      "Rows are who pays, columns who is paid, shaded against the strongest " +
      "cell. Everything below is for a " + tierLabel(state.src).toLowerCase() +
      " node paying a " + tierLabel(state.dst).toLowerCase() + " node — " +
      fmtInt((cell().all || {}).total || 0) + " sampled routes.";
  }

  // ---------------- tiles ----------------

  function renderTiles() {
    const hop = routeAt(state.payUsd, 1);
    const route = routeAt(state.payUsd, ROUTE_HOPS);
    const v = verdictFor(route);
    const row = el("div", "tile-row");

    const tile = (label, value, hue) => {
      const t = el("div", "tile");
      t.appendChild(el("div", "tile-label", label));
      const val = el("div", "tile-value", value);
      if (hue) val.style.color = hue;
      t.appendChild(val);
      return t;
    };

    row.appendChild(tile("Clears one hop", fmtPct1(hop), SERIES.hop));
    row.appendChild(tile("Clears a " + ROUTE_HOPS + "-hop route",
      fmtPct1(route), SERIES.route));

    const verdict = el("div", "tile tile-verdict verdict-" + v.key);
    verdict.appendChild(el("div", "tile-label", "Verdict at " + fmtUsd(state.payUsd)));
    const line = el("div", "verdict-line");
    line.appendChild(el("span", "verdict-glyph", v.glyph));
    line.appendChild(el("span", "verdict-label", v.label));
    verdict.appendChild(line);
    // The complement of the route figure, stated rather than characterised.
    verdict.appendChild(el("div", "tile-note",
      fmtPct1(1 - route) + " of " + ROUTE_HOPS + "-hop routes need reputation"));
    row.appendChild(verdict);

    return row;
  }

  // ---------------- render ----------------

  function render() {
    if (!mounted) return;
    const pts = curvePoints();

    $("rout-matrix").replaceChildren(renderMatrix());
    $("rout-controls-slot").replaceChildren(renderControls());
    $("rout-tiles").replaceChildren(renderTiles());
    $("rout-chart").replaceChildren(renderChart(pts));
    $("rout-legend").replaceChildren(renderLegend());
    $("rout-heat").replaceChildren(renderHeatmap(heatColumns()));
    $("rout-heat-legend").replaceChildren(renderRampLegend());
    renderCaption();
  }

  // A legend is always present for two series; the swatch carries identity and
  // the text stays in ink.
  function renderLegend() {
    const wrap = el("div", "chart-legend");
    for (const [hue, text] of [
      [SERIES.hop, "clears one hop"],
      [SERIES.route, "clears a " + ROUTE_HOPS + "-hop route"],
    ]) {
      const item = el("span", "legend-item");
      const sw = el("span", "legend-swatch");
      sw.style.background = hue;
      item.append(sw, el("span", null, text));
      wrap.appendChild(item);
    }
    return wrap;
  }

  function mount(deps) {
    M = deps.M;
    MATRIX = deps.MATRIX;
    tooltipEl = deps.tooltip;
    // A hop count earns a heatmap row if any cell sampled a route of that
    // length, so a thin dataset cannot leave empty rows.
    const sampled = (h) => TIERS.some((s) => TIERS.some((d) => {
      const c = (MATRIX[s.key] || {})[d.key];
      return c && c[h] && c[h].total > 0;
    }));
    HEAT_HOPS = ALL_HOPS.filter(sampled);
    mounted = true;
  }

  function update(next) {
    params = next;
    render();
  }

  return { mount, update, SERIES, RAMP };
});
