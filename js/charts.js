// Minimal inline-SVG charts (no dependencies). Every chart returns an SVG string.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const W = 640, PADL = 64, PADR = 14, PADT = 14, PADB = 30;
const C = { amber: "#e2a336", mint: "#9dffb0", red: "#ff7a6e", muted: "#b4b09f", line: "rgba(244,234,214,0.12)", ink: "#f6f1e6" };
export { C as COLORS };

function scale(d0, d1, r0, r1) { const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0); return (v) => r0 + (v - d0) * k; }
function niceTicks(lo, hi, n = 4, minStep = 0) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0)), err = step0 / mag;
  const step = Math.max(minStep, (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag);
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(12));
  return out;
}
const empty = (h, msg) => `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(msg)}"><text x="${W / 2}" y="${h / 2}" text-anchor="middle" fill="${C.muted}" font-size="16">${esc(msg)}</text></svg>`;

// series: [{name, color, points:[{x,y}], dash, area}]
export function lineChart({ series, height = 220, yFmt = (v) => v.toFixed(3), xFmt = (v) => v, label = "chart", zero = true, step = false, yMin, yMax }) {
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) return empty(height, "not enough data yet");
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  let lo = yMin != null ? yMin : Math.min(...ys, zero ? 0 : Infinity), hi = yMax != null ? yMax : Math.max(...ys, zero ? 0 : -Infinity);
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 0.01; hi += Math.abs(hi) * 0.1 || 0.01; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = scale(Math.min(...xs), Math.max(...xs), PADL, W - PADR), y = scale(lo, hi, height - PADB, PADT);
  const ticks = niceTicks(lo, hi);
  let g = ticks.map((t) => `<line x1="${PADL}" x2="${W - PADR}" y1="${y(t)}" y2="${y(t)}" stroke="${C.line}"/><text x="${PADL - 6}" y="${y(t) + 5}" text-anchor="end" fill="${C.muted}" font-size="13">${esc(yFmt(t))}</text>`).join("");
  if (zero && lo < 0 && hi > 0) g += `<line x1="${PADL}" x2="${W - PADR}" y1="${y(0)}" y2="${y(0)}" stroke="${C.muted}" stroke-dasharray="3 3" opacity="0.6"/>`;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  g += `<text x="${PADL}" y="${height - 8}" fill="${C.muted}" font-size="13">${esc(xFmt(x0))}</text><text x="${W - PADR}" y="${height - 8}" text-anchor="end" fill="${C.muted}" font-size="13">${esc(xFmt(x1))}</text>`;
  for (const s of series) {
    if (!s.points.length) continue;
    let d = "";
    s.points.forEach((p, i) => {
      if (i === 0) d += `M${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
      else if (step) d += `H${x(p.x).toFixed(1)}V${y(p.y).toFixed(1)}`;
      else d += `L${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
    });
    if (s.area) {
      const base = y(Math.max(lo, Math.min(hi, 0)));
      g += `<path d="${d}V${base}H${x(s.points[0].x)}Z" fill="${s.color}" opacity="0.22"/>`;
    }
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`;
  }
  const legend = series.filter((s) => s.name).map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
  return `<div class="legend">${legend}</div><svg class="chart" data-chart="${esc(label)}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${g}</svg>`;
}

// bars: [{label, value, value2?, title}] vertical
export function barChart({ bars, height = 200, yFmt = (v) => String(v), label = "bars", colorFor = (b) => C.amber, intTicks = false }) {
  if (!bars.length) return empty(height, "no data");
  const vals = bars.map((b) => b.value);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals) || 1;
  const y = scale(lo, hi, height - PADB, PADT);
  const bw = (W - PADL - PADR) / bars.length;
  let g = niceTicks(lo, hi, 3, intTicks ? 1 : 0).map((t) => `<line x1="${PADL}" x2="${W - PADR}" y1="${y(t)}" y2="${y(t)}" stroke="${C.line}"/><text x="${PADL - 6}" y="${y(t) + 5}" text-anchor="end" fill="${C.muted}" font-size="13">${esc(yFmt(t))}</text>`).join("");
  bars.forEach((b, i) => {
    const x0 = PADL + i * bw + bw * 0.12, w = bw * 0.76;
    const top = y(Math.max(0, b.value)), bot = y(Math.min(0, b.value));
    g += `<rect data-bar="${esc(b.label)}" data-value="${b.value}" x="${x0.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" rx="3" fill="${colorFor(b)}" ${b.hollow ? `fill-opacity="0.25" stroke="${colorFor(b)}"` : ""}><title>${esc(b.title || `${b.label}: ${b.value}`)}</title></rect>`;
    if (bars.length <= 14 || i % 2 === 0) g += `<text x="${(x0 + w / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" fill="${C.muted}" font-size="12">${esc(b.label)}</text>`;
    if (b.value && b.showValue !== false) g += `<text x="${(x0 + w / 2).toFixed(1)}" y="${(b.value >= 0 ? top - 4 : bot + 14).toFixed(1)}" text-anchor="middle" fill="${C.ink}" font-size="12">${esc(b.valueLabel != null ? b.valueLabel : yFmt(b.value))}</text>`;
  });
  return `<svg class="chart" data-chart="${esc(label)}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${g}</svg>`;
}

// rows: [{label, a, b}] horizontal stacked (a = realized, b = unrealized)
export function hBars({ rows, label = "per-token", fmt = (v) => v.toFixed(4) }) {
  if (!rows.length) return empty(120, "no positions");
  const rowH = 30, height = rows.length * rowH + 26;
  const vals = rows.flatMap((r) => [r.a, r.a + r.b, 0, r.b]);
  const lo = Math.min(...vals), hi = Math.max(...vals) || 1;
  const LBL = 92;
  const x = scale(lo, hi, LBL, W - 90);
  let g = `<line x1="${x(0)}" x2="${x(0)}" y1="4" y2="${height - 20}" stroke="${C.muted}" opacity="0.5"/>`;
  rows.forEach((r, i) => {
    const yy = 8 + i * rowH;
    const seg = (from, to, color, op, kind) => { const a = x(Math.min(from, to)), b = x(Math.max(from, to)); return `<rect data-hbar="${esc(r.label)}" data-kind="${kind}" data-value="${to - from}" x="${a.toFixed(1)}" y="${yy}" width="${Math.max(1, b - a).toFixed(1)}" height="18" rx="3" fill="${color}" opacity="${op}"/>`; };
    g += `<text x="${LBL - 8}" y="${yy + 14}" text-anchor="end" fill="${C.ink}" font-size="13">${esc(r.label)}</text>`;
    g += seg(0, r.a, r.a >= 0 ? C.mint : C.red, 0.95, "realized");
    if (r.b) g += seg(r.a, r.a + r.b, r.b >= 0 ? C.mint : C.red, 0.4, "unrealized");
    g += `<text x="${W - 86}" y="${yy + 14}" fill="${C.muted}" font-size="12">${esc(fmt(r.a + r.b))}</text>`;
  });
  g += `<text x="${LBL}" y="${height - 4}" fill="${C.muted}" font-size="12">solid = realized · faded = unrealized (SOL)</text>`;
  return `<svg class="chart" data-chart="${esc(label)}" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(label)}">${g}</svg>`;
}

// days: [{day:"YYYY-MM-DD", pnl}] ; weeks Monday-first
export function calendar({ days, todayIso, label = "calendar", fmt = (v) => v.toFixed(4) }) {
  const map = new Map(days.map((d) => [d.day, d]));
  const first = days.length ? days[0].day : todayIso;
  const d0 = new Date(first + "T00:00:00Z");
  const start = new Date(d0.getTime() - ((d0.getUTCDay() + 6) % 7) * 864e5);
  const end = new Date(todayIso + "T00:00:00Z");
  const curWeek = new Date(end.getTime() - ((end.getUTCDay() + 6) % 7) * 864e5);
  const firstShown = new Date(Math.min(start.getTime(), curWeek.getTime() - 4 * 7 * 864e5));
  const weeks = Math.round((curWeek - firstShown) / (7 * 864e5)) + 1;
  const cell = 40, gap = 5, LBL = 40;
  const maxAbs = Math.max(1e-9, ...days.map((d) => Math.abs(d.pnl)));
  let g = ["M", "T", "W", "T", "F", "S", "S"].map((l, i) => `<text x="${LBL + i * (cell + gap) + cell / 2}" y="14" text-anchor="middle" fill="${C.muted}" font-size="12">${l}</text>`).join("");
  for (let w = 0; w < weeks; w++) {
    for (let i = 0; i < 7; i++) {
      const dt = new Date(firstShown.getTime() + (w * 7 + i) * 864e5);
      const iso = dt.toISOString().slice(0, 10);
      const d = map.get(iso);
      const future = iso > todayIso;
      const k = d ? Math.min(1, Math.abs(d.pnl) / maxAbs) : 0;
      const fill = d ? (d.pnl >= 0 ? `rgba(157,255,176,${0.15 + 0.75 * k})` : `rgba(255,122,110,${0.15 + 0.75 * k})`) : "rgba(244,234,214,0.05)";
      const x0 = LBL + i * (cell + gap), y0 = 22 + w * (cell + gap);
      g += `<rect data-day="${iso}"${d ? ` data-pnl="${d.pnl}"` : ""} x="${x0}" y="${y0}" width="${cell}" height="${cell}" rx="7" fill="${fill}" opacity="${future ? 0.35 : 1}" ${iso === todayIso ? `stroke="${C.amber}" stroke-width="2"` : ""}><title>${iso}${d ? `: ${esc(fmt(d.pnl))} SOL` : ""}</title></rect><text x="${x0 + 6}" y="${y0 + 15}" fill="${C.muted}" font-size="11">${dt.getUTCDate()}</text>`;
    }
    const wk = new Date(firstShown.getTime() + w * 7 * 864e5);
    g += `<text x="0" y="${22 + w * (cell + gap) + 25}" fill="${C.muted}" font-size="11">${wk.toISOString().slice(5, 10)}</text>`;
  }
  const height = 22 + weeks * (cell + gap);
  const width = LBL + 7 * (cell + gap);
  return `<svg class="chart cal" data-chart="${esc(label)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${g}</svg>`;
}

// Progress bar toward targets; markers: [{x, label, kind}]
export function progress({ x, lo, hi, markers, log = false }) {
  const f = (v) => (log ? Math.log(v) : v);
  const pos = (v) => Math.max(0, Math.min(100, ((f(v) - f(lo)) / (f(hi) - f(lo))) * 100));
  const now = x == null ? null : pos(x);
  const m = markers.map((k) => `<span class="pm ${k.kind || ""}" style="left:${pos(k.x).toFixed(2)}%" title="${esc(k.label)}"><em>${esc(k.label)}</em></span>`).join("");
  return `<div class="prog" data-progress="${now == null ? "" : now.toFixed(2)}"><div class="prog-track">${now == null ? "" : `<div class="prog-fill ${x < 1 ? "neg" : ""}" style="width:${now.toFixed(2)}%"></div><span class="prog-now" style="left:${now.toFixed(2)}%"></span>`}${m}</div></div>`;
}
