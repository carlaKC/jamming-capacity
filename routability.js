/* General-bucket routability visualizer.
 *
 * One question: under the local resource conservation limits, what share of
 * payments keeps flowing through the general bucket — no reputation required?
 *
 * The point of the section is the gap between two curves. Per *hop* the limits
 * look survivable; payments cross several hops and general-bucket clearance
 * composes multiplicatively, so per *route* it falls off a cliff.
 *
 * All bucket math lives in math.js; this file owns the section's own state
 * (payment cursor, weighting, oversubscription, price, channel type) and its
 * SVG rendering. app.js hands it the current bucket parameters on every
 * render.
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
  const WEDGE = "rgba(120, 120, 108, 0.13)";   // annotation, not a third series
  const GRID = "#DED8CF";
  const AXIS_INK = "#78786C";

  // Payment-size axis: five decades, $0.10 to $10,000.
  const USD_MIN = 0.1;
  const USD_MAX = 10000;
  const DECADES = [0.1, 1, 10, 100, 1000, 10000];
  // Where everyday Lightning payments actually sit.
  const TYPICAL = [1, 100];
  const ROUTE_HOPS = 3;
  const HEAT_HOPS = [1, 2, 3, 4, 5, 6];
  const HEAT_COLS = 25;          // half-decade-ish columns across the span
  const CURVE_POINTS = 160;

  const SLIDER_MAX = 1000;
  const sliderToUsd = (v) => USD_MIN * Math.pow(10, (v / SLIDER_MAX) * 5);
  const usdToSlider = (u) =>
    Math.round((Math.log10(u / USD_MIN) / 5) * SLIDER_MAX);

  const state = {
    payUsd: 50,
    weighting: "value",   // "value" (liquidity-weighted) | "count"
    oversub: 1,
    price: 75000,
    type: 483,
  };

  let M = null;
  let CDF = null;
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

  // The fraction of an edge's max_htlc one peer may push through general, with
  // any per-slot oversubscription applied.
  function routableFrac() {
    const m = params.typeMetrics(activeType());
    return m.peerGeneralFrac * state.oversub;
  }

  function perHopAt(usd) {
    const sat = M.usdToSat(usd, activePrice());
    return M.perHopRoutability(CDF, sat, routableFrac(), state.weighting);
  }

  // ---------------- verdict ----------------

  // Reserved status states, always shipped with a glyph and a word so the
  // reading never rests on colour alone.
  const VERDICTS = [
    { min: 0.6, key: "good", glyph: "●", label: "flows in general",
      note: "most routes clear without reputation" },
    { min: 0.2, key: "warning", glyph: "◐", label: "partly reputation-gated",
      note: "a large minority of routes need reputation" },
    { min: 0, key: "critical", glyph: "▲", label: "mostly needs reputation",
      note: "the general bucket rarely carries a whole route" },
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
      const hop = perHopAt(usd);
      pts.push({ usd, hop, route: M.routeRoutability(hop, ROUTE_HOPS) });
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
        "Share of payments clearing the general bucket against payment size, " +
        "for one hop and for a three-hop route. Full figures are in the table " +
        "below the chart.",
    });

    // Typical-payment reference band, behind everything.
    node.appendChild(svg("rect", {
      x: xOf(TYPICAL[0]), y: PAD.top,
      width: xOf(TYPICAL[1]) - xOf(TYPICAL[0]), height: PH,
      fill: "rgba(193, 140, 93, 0.07)",
    }));
    // Sits at the foot of the band: the curves live along the top edge for
    // small payments, so a label up there would collide with them.
    node.appendChild(svg("text", {
      x: (xOf(TYPICAL[0]) + xOf(TYPICAL[1])) / 2, y: PAD.top + PH - 8,
      "text-anchor": "middle", class: "chart-annot",
    }, "typical payments"));

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

    // The wedge: payments a hop admits but a whole route does not.
    const wedge = pathFrom(pts, "hop") + " " +
      [...pts].reverse().map((p) =>
        "L" + xOf(p.usd).toFixed(2) + " " + yOf(p.route).toFixed(2)).join(" ") + " Z";
    node.appendChild(svg("path", { d: wedge, fill: WEDGE }));

    node.appendChild(svg("path", {
      d: pathFrom(pts, "hop"), fill: "none", stroke: SERIES.hop,
      "stroke-width": 2, "stroke-linejoin": "round",
    }));
    node.appendChild(svg("path", {
      d: pathFrom(pts, "route"), fill: "none", stroke: SERIES.route,
      "stroke-width": 2, "stroke-linejoin": "round",
    }));

    // Selective direct labels, placed where the wedge is widest. Labelling the
    // right-hand ends would stack them on top of each other: both curves
    // converge on zero there.
    let widest = pts[0];
    for (const p of pts) if (p.hop - p.route > widest.hop - widest.route) widest = p;
    const lx = xOf(widest.usd);
    node.appendChild(svg("text", {
      x: lx, y: yOf(widest.hop) - 9, "text-anchor": "middle",
      class: "chart-label", fill: SERIES.hop,
    }, "one hop"));
    node.appendChild(svg("text", {
      x: lx, y: yOf(widest.route) + 18, "text-anchor": "middle",
      class: "chart-label", fill: SERIES.route,
    }, ROUTE_HOPS + "-hop route"));

    // Cursor.
    const cx = xOf(state.payUsd);
    const hop = perHopAt(state.payUsd);
    const route = M.routeRoutability(hop, ROUTE_HOPS);
    node.appendChild(svg("line", {
      x1: cx, y1: PAD.top, x2: cx, y2: PAD.top + PH,
      stroke: AXIS_INK, "stroke-width": 1,
    }));
    for (const [share, fill] of [[hop, SERIES.hop], [route, SERIES.route]]) {
      // 2px surface ring rather than a border, so overlapping dots separate.
      node.appendChild(svg("circle", {
        cx, cy: yOf(share), r: 5, fill, stroke: "#FEFEFA", "stroke-width": 2,
      }));
    }

    // Hover layer: one full-height band per sample, so the hit target is the
    // column rather than the 2px line.
    const hover = svg("g", { class: "hover-layer" });
    const bandW = PW / CURVE_POINTS;
    for (const p of pts) {
      const band = svg("rect", {
        x: xOf(p.usd) - bandW / 2, y: PAD.top, width: bandW, height: PH,
        fill: "transparent",
      });
      band.addEventListener("pointerenter", (e) => showChartTip(p, e));
      hover.appendChild(band);
    }
    node.appendChild(hover);
    node.addEventListener("pointerleave", hideTip);

    return node;
  }

  // ---------------- heatmap ----------------

  const rampIndex = (share) => Math.min(RAMP.length - 1,
    Math.max(0, Math.floor(share * RAMP.length)));

  function heatColumns() {
    const cols = [];
    for (let i = 0; i < HEAT_COLS; i++) {
      const usd = USD_MIN * Math.pow(10, (i / (HEAT_COLS - 1)) * 5);
      cols.push({ usd, hop: perHopAt(usd) });
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
        "Share of routes clearing the general bucket by payment size and hop " +
        "count, one to six hops. Full figures are in the table below.",
    });

    HEAT_HOPS.forEach((h, r) => {
      const y = HPAD.top + r * HROW;
      node.appendChild(svg("text", {
        x: HPAD.left - 10, y: y + HROW / 2 + 4, "text-anchor": "end",
        class: "chart-tick",
      }, h + (h === 1 ? " hop" : " hops")));
      cols.forEach((c, i) => {
        const share = M.routeRoutability(c.hop, h);
        // 2px surface gap between cells instead of a border.
        const cell = svg("rect", {
          x: HPAD.left + i * cellW + 1, y: y + 1,
          width: Math.max(1, cellW - 2), height: HROW - 2,
          fill: RAMP[rampIndex(share)], rx: 3,
        });
        cell.addEventListener("pointerenter", (e) =>
          showHeatTip(c.usd, h, share, e));
        node.appendChild(cell);
      });
    });

    // Cursor column outline goes on last, so the cells don't cover it.
    const ci = Math.round((Math.log10(state.payUsd / USD_MIN) / 5) * (HEAT_COLS - 1));
    node.appendChild(svg("rect", {
      x: HPAD.left + ci * cellW - 2, y: HPAD.top - 4,
      width: cellW + 4, height: HEAT_HOPS.length * HROW + 8,
      fill: "none", stroke: "#4A4A40", "stroke-width": 1.5, rx: 6,
      "pointer-events": "none",
    }));

    for (const d of DECADES) {
      const frac = Math.log10(d / USD_MIN) / 5;
      node.appendChild(svg("text", {
        x: HPAD.left + frac * plotW, y: height - HPAD.bottom + 22,
        "text-anchor": "middle", class: "chart-tick",
      }, fmtUsd(d)));
    }
    node.addEventListener("pointerleave", hideTip);
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
      el("div", "tt-line",
        "forced to reputation: " + fmtPct1(p.hop - p.route) + " of hops"),
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

  // ---------------- table view ----------------

  // Every value in the charts is reachable here too — the charts enhance it,
  // they do not gate it.
  function renderTableView() {
    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    hr.appendChild(el("th", "row-head", "Payment"));
    hr.appendChild(el("th", null, "One hop"));
    for (const h of HEAT_HOPS.slice(1)) hr.appendChild(el("th", null, h + " hops"));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const usd of [0.1, 1, 5, 10, 50, 100, 500, 1000, 10000]) {
      const hop = perHopAt(usd);
      const tr = el("tr");
      tr.appendChild(el("th", "row-head", fmtUsd(usd)));
      for (const h of HEAT_HOPS) {
        tr.appendChild(el("td", null, fmtPct1(M.routeRoutability(hop, h))));
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrap = el("div", "table-wrap");
    wrap.appendChild(table);
    return wrap;
  }

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

    const toggle = el("div", "mode-toggle");
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Edge weighting");
    for (const [key, text] of [["value", "by liquidity"], ["count", "by count"]]) {
      const btn = el("button", "mode" + (state.weighting === key ? " active" : ""), text);
      btn.type = "button";
      btn.addEventListener("click", () => { state.weighting = key; render(); });
      toggle.appendChild(btn);
    }
    row.appendChild(toggle);

    const pay = el("input");
    pay.type = "range";
    pay.min = "0";
    pay.max = String(SLIDER_MAX);
    pay.step = "1";
    pay.value = String(usdToSlider(state.payUsd));
    pay.addEventListener("input", () => {
      state.payUsd = sliderToUsd(Number(pay.value));
      render();
    });
    row.appendChild(field("Payment " + fmtUsd(state.payUsd), pay));

    const over = el("input");
    over.type = "range";
    over.min = "50";
    over.max = "400";
    over.step = "10";
    over.value = String(Math.round(state.oversub * 100));
    over.addEventListener("input", () => {
      state.oversub = Number(over.value) / 100;
      render();
    });
    row.appendChild(field("Oversubscription ×" + state.oversub.toFixed(1), over));

    return row;
  }

  // ---------------- tiles ----------------

  function renderTiles() {
    const hop = perHopAt(state.payUsd);
    const route = M.routeRoutability(hop, ROUTE_HOPS);
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
    verdict.appendChild(el("div", "tile-note", v.note));
    row.appendChild(verdict);

    return row;
  }

  // ---------------- render ----------------

  function render() {
    if (!mounted) return;
    const m = params.typeMetrics(activeType());
    const pts = curvePoints();

    $("rout-caption").textContent =
      "Share of payments a channel's general bucket admits with no reputation, " +
      "against payment size. One peer may push " +
      (m.peerGeneralFrac * 100).toFixed(2) + "% of an edge's max_htlc (k = " +
      m.k + " of " + m.slots.general + " general slots)" +
      (state.oversub === 1 ? "" : ", oversubscribed ×" + state.oversub.toFixed(1)) +
      ". Edges are weighted " +
      (state.weighting === "value" ? "by advertised liquidity" : "one edge, one vote") +
      "; the " + ROUTE_HOPS + "-hop curve composes the per-hop share " +
      "multiplicatively.";

    $("rout-controls-slot").replaceChildren(renderControls());
    $("rout-tiles").replaceChildren(renderTiles());
    $("rout-chart").replaceChildren(renderChart(pts));
    $("rout-legend").replaceChildren(renderLegend());
    $("rout-heat").replaceChildren(renderHeatmap(heatColumns()));
    $("rout-heat-legend").replaceChildren(renderRampLegend());
    $("rout-table").replaceChildren(renderTableView());
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
    const wedge = el("span", "legend-item");
    const ws = el("span", "legend-swatch legend-wedge");
    wedge.append(ws, el("span", null, "forced to reputation"));
    wrap.appendChild(wedge);
    return wrap;
  }

  function mount(deps) {
    M = deps.M;
    CDF = deps.CDF;
    tooltipEl = deps.tooltip;
    mounted = true;
  }

  function update(next) {
    params = next;
    render();
  }

  return { mount, update, SERIES, RAMP };
});
