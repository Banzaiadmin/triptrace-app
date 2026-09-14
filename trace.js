/*
 * trace.js — the Trace, and the sparkline that echoes it in a list row.
 *
 * A sleep tracker puts one night on a hypnogram: time across, state stacked, the biological night
 * shaded behind it. A pairing is four of those nights with flying in between, so this draws the
 * same picture at trip scale — effectiveness as a band-coloured curve, duty periods and modeled
 * sleep as rows beneath it, and the window of circadian low shaded behind the lot. Reading the
 * shape tells you the thing a table of percentages never does: whether the trip is digging a hole
 * or letting you climb out.
 *
 * It renders values the model produced and nothing else. Between two known points the line is
 * drawn straight because that is a drawing convention, not a claim — no interpolated number is
 * ever printed, and every figure the app displays comes from the engine.
 */

import { MODEL_PARAMS } from "./core/constants.js";

const HOUR = 3600e3;

// The lines the curve is read against are the model's, not the chart's: the Combined Capacity
// white paper puts the fatigue criterion at 77% effectiveness and the reservoir floor at 75%.
export const EFF_THRESHOLD = MODEL_PARAMS.effectiveness_fatigue_threshold;
export const RES_THRESHOLD = MODEL_PARAMS.reservoir_fatigue_threshold;

const BANDS = [
  { min: 90, key: "green",  label: "Normal" },
  { min: 85, key: "yellow", label: "Monitor" },
  { min: 80, key: "orange", label: "Elevated" },
  { min: 75, key: "red",    label: "High" },
  { min: 0,  key: "purple", label: "Critical" },
];
export const bandFor = (pct) => BANDS.find((b) => pct >= b.min) ?? BANDS[BANDS.length - 1];
export const bandVar = (key) => `var(--band-${key})`;
export const bandColor = (pct) => bandVar(bandFor(pct).key);

const ms = (iso) => (iso ? Date.parse(iso) : null);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const localHM = (t, tz) => new Date(t).toLocaleTimeString([], {
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz,
});
const zulu = (t) => `${String(new Date(t).getUTCHours()).padStart(2, "0")}:${String(new Date(t).getUTCMinutes()).padStart(2, "0")}`;
const dayName = (t) => new Date(t).toLocaleDateString(undefined,
  { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Flatten the trace into the few series the chart needs. Everything here is read straight off the
 * scored trace; nothing is derived beyond picking which timestamps to plot.
 */
export function traceModel(trace) {
  const duties = trace?.duty_periods ?? [];
  const rests = trace?.rest_periods ?? [];
  if (!duties.length) return null;

  const dutyRows = duties.map((d) => {
    const eff = d.effectiveness ?? {};
    const legs = (d.legs ?? []).map((l) => ({
      flight: l.flight ?? "",
      from: l.dep_station ?? "",
      to: l.arr_station ?? "",
      dep: ms(l.dep?.utc),
      arr: ms(l.arr?.utc),
      deadhead: /^DH/i.test(l.position ?? "") || /deadhead/i.test(l.position ?? ""),
      startPct: l.effectiveness?.start_pct ?? null,
      minPct: l.effectiveness?.min_pct ?? null,
      endPct: l.effectiveness?.end_pct ?? null,
      startRes: l.effectiveness?.reservoir_pct ?? null,
      minRes: l.effectiveness?.reservoir_pct ?? null,
      endRes: l.effectiveness?.reservoir_pct ?? null,
      minAt: ms(l.effectiveness?.min_at_utc),
    }));
    return {
      day: d.day_index,
      date: d.date_local,
      report: ms(d.report?.utc),
      release: ms(d.release?.utc),
      landings: d.landings ?? 0,
      route: [legs[0]?.from, ...legs.map((l) => l.to)].filter(Boolean).join("-"),
      startPct: eff.start_pct ?? null,
      minPct: eff.min_pct ?? null,
      endPct: eff.end_pct ?? null,
      startRes: eff.reservoir_pct ?? null,
      endRes: eff.reservoir_pct ?? null,
      combined: eff.combined_capacity ?? null,
      workload: eff.workload_norm ?? null,
      minAt: ms(eff.min_at_utc),
      minWhere: eff.min_location ?? "",
      band: eff.band ?? null,
      wocl: d.circadian?.wocl_window
        ? { start: ms(d.circadian.wocl_window.start_utc), end: ms(d.circadian.wocl_window.end_utc) }
        : null,
      legs,
    };
  });

  const sleepRows = rests.map((r) => ({
    afterDay: r.after_duty_day,
    station: r.station ?? "",
    winStart: ms(r.sleep_opportunity_window?.start_utc),
    winEnd: ms(r.sleep_opportunity_window?.end_utc),
    blocks: (r.sleep_events ?? []).map((e) => ({
      start: ms(e.window?.start_utc),
      end: ms(e.window?.end_utc),
      hours: e.effective_sleep_hours ?? null,
      daytime: Boolean(e.is_daytime),
      measured: e.source === "actual",
      type: e.type ?? "",
    })),
  })).filter((r) => r.winStart && r.winEnd);

  // The curve: every point the model actually produced, in order. Awake stretches sit flat at the
  // release value and the climb happens across the modeled sleep window, which is where the model
  // puts it too.
  const pts = [];
  const push = (t, pct, res, label, kind) => {
    if (t && pct !== null && pct !== undefined) pts.push({ t, pct, res: res ?? null, label, kind });
  };
  dutyRows.forEach((d, i) => {
    push(d.report, d.startPct, d.startRes, `D${d.day} report`, "duty");
    for (const l of d.legs) {
      const tag = `${l.flight}${l.deadhead ? " DH" : ""} ${l.from}–${l.to}`;
      push(l.dep, l.startPct, l.startRes, `${tag} off`, "duty");
      push(l.minAt, l.minPct, l.minRes, `${tag} low`, "duty");
      push(l.arr, l.endPct, l.endRes, `${tag} on`, "duty");
    }
    push(d.release, d.endPct, d.endRes, `D${d.day} release`, "duty");
    const rest = sleepRows.find((r) => r.afterDay === d.day);
    const next = dutyRows[i + 1];
    if (rest && next) {
      push(rest.winStart, d.endPct, d.endRes, `${rest.station} sleep window opens`, "rest");
      push(rest.winEnd, next.startPct, next.startRes, `${rest.station} sleep window closes`, "rest");
    }
  });
  pts.sort((a, b) => a.t - b.t);
  const curve = pts.filter((p, i) => i === 0 || p.t !== pts[i - 1].t || p.pct !== pts[i - 1].pct);

  const lowest = curve.reduce((a, b) => (b.pct < a.pct ? b : a), curve[0] ?? { t: 0, pct: 100 });
  const worstDuty = dutyRows.reduce((a, b) =>
    (b.minPct !== null && (a.minPct === null || b.minPct < a.minPct) ? b : a), dutyRows[0]);

  return {
    duties: dutyRows,
    sleeps: sleepRows,
    curve,
    lowest,
    worst: worstDuty,
    t0: Math.min(...dutyRows.map((d) => d.report).filter(Boolean)),
    t1: Math.max(...dutyRows.map((d) => d.release).filter(Boolean),
                 ...sleepRows.map((r) => r.winEnd).filter(Boolean)),
  };
}

/** Window of the chart for a scope: "trip", or a duty day index. */
function windowFor(model, scope) {
  if (scope === "trip") return { from: model.t0 - HOUR, to: model.t1 + HOUR, px: null };
  const d = model.duties.find((x) => x.day === scope);
  if (!d) return { from: model.t0 - HOUR, to: model.t1 + HOUR, px: null };
  const rest = model.sleeps.find((r) => r.afterDay === d.day);
  const before = model.sleeps.find((r) => r.afterDay === d.day - 1);
  return {
    from: (before?.winStart ?? d.report) - HOUR,
    to: (rest?.winEnd ?? d.release) + HOUR,
    px: 30,
  };
}

/**
 * Draw the Trace. `container` is any element; it gets one <svg>.
 * Options: scope ("trip" or a day index), now (ms), width (visible px, for density only).
 */
export function renderTrace(container, model, {
  scope = "trip", now = Date.now(), width = 340,
  series = { effectiveness: true, reservoir: false }, bands = false, tzName = null,
} = {}) {
  if (!model) { container.innerHTML = ""; return; }

  const win = windowFor(model, scope);
  const hours = (win.to - win.from) / HOUR;
  const pxPerHour = win.px ?? Math.max(8, Math.min(15, (width * 2.6) / hours));
  const PAD_L = 40, PAD_R = 18;   // the DUTY/REST row labels live here; 30 clipped them
  const W = Math.round(hours * pxPerHour) + PAD_L + PAD_R;

  const TOP = 22, CURVE_H = 128;
  const DUTY_Y = TOP + CURVE_H + 20, DUTY_H = 20;
  const SLEEP_Y = DUTY_Y + DUTY_H + 12, SLEEP_H = 18;
  const AXIS_Y = SLEEP_Y + SLEEP_H + 16;
  const H = AXIS_Y + 26;

  const x = (t) => PAD_L + ((t - win.from) / HOUR) * pxPerHour;
  const y = (pct) => TOP + CURVE_H - ((Math.max(55, Math.min(100, pct)) - 55) / 45) * CURVE_H;
  const clampX = (t) => Math.max(PAD_L, Math.min(W - PAD_R, x(t)));
  const inWin = (t) => t >= win.from && t <= win.to;

  const out = [];

  // Circadian low, shaded behind everything: the body's night, not the clock's.
  let woclLabelled = false;
  for (const d of model.duties) {
    if (!d.wocl || d.wocl.end < win.from || d.wocl.start > win.to) continue;
    const x0 = clampX(d.wocl.start), x1 = clampX(d.wocl.end);
    if (x1 - x0 < 0.5) continue;
    out.push(`<rect class="wocl-band" x="${x0.toFixed(1)}" y="${TOP - 8}" width="${(x1 - x0).toFixed(1)}" height="${SLEEP_Y + SLEEP_H - TOP + 8}" rx="3"/>`);
    if (!woclLabelled && x1 - x0 > 26) {
      out.push(`<text class="wocl-label" x="${((x0 + x1) / 2).toFixed(1)}" y="${TOP - 12}" text-anchor="middle">WOCL</text>`);
      woclLabelled = true;
    }
  }

  // Optional band shading: the five operational risk bands as horizontal zones, so the curve is
  // read against the scale it is scored on rather than against a bare grid.
  if (bands) {
    const zones = [[90, 100, "green"], [85, 90, "yellow"], [80, 85, "orange"], [75, 80, "red"], [55, 75, "purple"]];
    for (const [lo, hi, key] of zones) {
      out.push(`<rect class="zone" fill="var(--band-${key})" x="${PAD_L}" y="${y(hi).toFixed(1)}" `
        + `width="${(W - PAD_R - PAD_L).toFixed(1)}" height="${(y(lo) - y(hi)).toFixed(1)}"/>`);
    }
  }

  for (const g of [100, 90, 80, 70, 60]) {
    out.push(`<line class="grid" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/>`);
    out.push(`<text class="gridlabel" x="${PAD_L - 6}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end">${g}</text>`);
  }

  // The baseline the whole document argues about: the model's own fatigue criterion. Drawn as a
  // dashed rule across the chart so every point can be read as above it or below it at a glance.
  const baseline = (value, cls, label) => {
    out.push(`<line class="${cls}" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/>`);
    out.push(`<text class="${cls}-label" x="${W - PAD_R - 3}" y="${(y(value) - 5).toFixed(1)}" text-anchor="end">${label}</text>`);
  };
  if (series.effectiveness) baseline(EFF_THRESHOLD, "thresh", `FATIGUE CRITERION ${EFF_THRESHOLD}%`);
  if (series.reservoir) baseline(RES_THRESHOLD, "thresh-res", `RESERVOIR FLOOR ${RES_THRESHOLD}%`);

  // The curve, colour-graded along its own length so a dip through a band is visible as colour.
  const shown = model.curve.filter((p) => inWin(p.t));
  if (shown.length > 1) {
    const span = Math.max(1, x(shown[shown.length - 1].t) - x(shown[0].t));
    const stops = shown.map((p) => {
      const off = ((x(p.t) - x(shown[0].t)) / span) * 100;
      return `<stop offset="${Math.max(0, Math.min(100, off)).toFixed(2)}%" stop-color="${bandColor(p.pct)}"/>`;
    }).join("");
    out.push(`<defs><linearGradient id="tg" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient></defs>`);

    const line = shown.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.pct).toFixed(1)}`).join("");
    const base = TOP + CURVE_H;
    if (series.effectiveness) {
      out.push(`<path class="curve-fill" fill="url(#tg)" d="${line}L${x(shown[shown.length - 1].t).toFixed(1)},${base}L${x(shown[0].t).toFixed(1)},${base}Z"/>`);
      out.push(`<path class="curve" stroke="url(#tg)" d="${line}"/>`);
    }
    if (series.reservoir) {
      const res = shown.filter((p) => p.res !== null && p.res !== undefined);
      if (res.length > 1) {
        const rline = res.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.res).toFixed(1)}`).join("");
        out.push(`<path class="curve-res" d="${rline}"/>`);
      }
    }
  }

  // Duty periods, with a tick at every leg boundary and the flown/deadhead split visible.
  model.duties.forEach((d, i) => {
    if (!d.report || !d.release || d.release < win.from || d.report > win.to) return;
    const x0 = clampX(d.report), x1 = clampX(d.release);
    out.push(`<rect class="duty-bar" style="animation-delay:${(140 + i * 70)}ms" x="${x0.toFixed(1)}" y="${DUTY_Y}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${DUTY_H}" rx="5"/>`);
    for (const l of d.legs) {
      if (!l.dep || !inWin(l.dep)) continue;  // eslint-disable-line no-continue
      out.push(`<line class="leg-tick" x1="${x(l.dep).toFixed(1)}" x2="${x(l.dep).toFixed(1)}" y1="${DUTY_Y}" y2="${DUTY_Y + DUTY_H}"/>`);
    }
    if (x1 - x0 > 26) {
      out.push(`<text class="duty-label" x="${(x0 + 6).toFixed(1)}" y="${DUTY_Y + 14}">D${d.day}</text>`);
    }
  });

  // Modeled sleep: the opportunity window dim, each modeled block bright inside it.
  model.sleeps.forEach((r, i) => {
    if (r.winEnd < win.from || r.winStart > win.to) return;
    const delay = 180 + i * 70;
    const x0 = clampX(r.winStart), x1 = clampX(r.winEnd);
    out.push(`<rect class="sleep-bar" style="animation-delay:${delay}ms" x="${x0.toFixed(1)}" y="${SLEEP_Y}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${SLEEP_H}" rx="5"/>`);
    for (const b of r.blocks) {
      if (!b.start || !b.end) continue;
      const b0 = clampX(b.start), b1 = clampX(b.end);
      if (b1 - b0 < 0.5) continue;
      out.push(`<rect class="sleep-eff" style="animation-delay:${delay + 90}ms" x="${b0.toFixed(1)}" y="${SLEEP_Y + 3}" width="${(b1 - b0).toFixed(1)}" height="${SLEEP_H - 6}" rx="3"/>`);
    }
  });
  out.push(`<text class="rowlabel" x="${PAD_L - 6}" y="${DUTY_Y + 14}" text-anchor="end">DUTY</text>`);
  out.push(`<text class="rowlabel" x="${PAD_L - 6}" y="${SLEEP_Y + 13}" text-anchor="end">REST</text>`);

  // Time axis: a mark at each duty day, six-hourly ticks in Zulu underneath.
  const firstTick = Math.ceil(win.from / (6 * HOUR)) * 6 * HOUR;
  for (let t = firstTick; t <= win.to; t += 6 * HOUR) {
    out.push(`<line class="grid" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${AXIS_Y - 6}" y2="${AXIS_Y - 2}"/>`);
    out.push(`<text class="gridlabel" x="${x(t).toFixed(1)}" y="${AXIS_Y + 8}" text-anchor="middle">${
      tzName ? `${localHM(t, tzName)}` : `${zulu(t)}Z`}</text>`);
  }
  let lastDay = null;                 // two duties can report on the same date; label it once
  for (const d of model.duties) {
    if (!d.report || !inWin(d.report)) continue;
    const name = dayName(d.report);
    if (name === lastDay) continue;
    lastDay = name;
    out.push(`<text class="daymark" x="${x(d.report).toFixed(1)}" y="${AXIS_Y + 22}" text-anchor="middle">${esc(name)}</text>`);
  }

  // The lowest point, called out where it happens.
  const low = model.lowest;
  if (low && inWin(low.t)) {
    const lx = x(low.t), ly = y(low.pct);
    const anchor = lx > W - 90 ? "end" : "start";
    const dx = anchor === "end" ? -9 : 9;
    out.push(`<circle class="minpt" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="5" fill="${bandColor(low.pct)}"/>`);
    out.push(`<text class="minlabel" x="${(lx + dx).toFixed(1)}" y="${(ly - 13).toFixed(1)}" text-anchor="${anchor}">${low.pct.toFixed(1)}%</text>`);
  }

  // Where the pilot is right now.
  if (inWin(now)) {
    const nx = x(now);
    out.push(`<line class="nowline" x1="${nx.toFixed(1)}" x2="${nx.toFixed(1)}" y1="${TOP - 6}" y2="${SLEEP_Y + SLEEP_H + 4}"/>`);
    out.push(`<text class="nowlabel" x="${nx.toFixed(1)}" y="${TOP - 10}" text-anchor="middle">NOW</text>`);
  }

  container.innerHTML =
    `<svg class="trace" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
       aria-label="Estimated effectiveness across the trip, with duty periods, modeled sleep and the window of circadian low.">${out.join("")}</svg>`;

  // Draw the line on from the start of the trip, the way a Health chart does. The dash length has
  // to come from the laid-out path, so this happens after the SVG is in the document.
  // Hand the geometry back so the app can scrub the chart: the readout snaps to points the model
  // actually produced, never to an interpolated value between them.
  container._trace = {
    x, y, win, points: model.curve.filter((p) => inWin(p.t)),
    top: TOP, bottom: TOP + CURVE_H, tzName,
  };

  const path = container.querySelector(".curve");
  if (path && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; });
  }
}

/** The same shape, 52px wide, for a list row. */
export function sparkline(startPct, minPct, endPct) {
  const vals = [startPct, minPct, endPct].map((v) => (v === null || v === undefined ? 85 : v));
  const y = (p) => 17 - ((Math.max(60, Math.min(100, p)) - 60) / 40) * 14;
  const d = `M1,${y(vals[0]).toFixed(1)}L26,${y(vals[1]).toFixed(1)}L51,${y(vals[2]).toFixed(1)}`;
  return `<svg class="duty-spark" viewBox="0 0 52 20" aria-hidden="true">
    <path d="${d}" stroke="${bandColor(vals[1])}" fill="none"/></svg>`;
}
