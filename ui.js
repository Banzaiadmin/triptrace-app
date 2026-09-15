/*
 * ui.js — the standalone app shell.
 *
 * Same contract as the original client: this file formats, animates and navigates. It computes
 * nothing. Every percentage, band, time and sentence comes from core/engine.js — the JavaScript
 * core the differential proves identical to Python on every golden — or from core/summary.js
 * built on top of it.
 *
 * One rule worth restating because a clock-driven UI tempts you to break it: the app never
 * interpolates a number to "now". The Trace draws a line between points the model produced, which
 * is a drawing convention, but no figure on screen is ever invented between two model outputs.
 * Where the pilot is right now is shown by position on the chart, not by a made-up percentage.
 */

import { traceModel, renderTrace, sparkline, bandFor, bandColor, bandVar, EFF_THRESHOLD } from "./trace.js?v=30";

const V = "30";
const $ = (id) => document.getElementById(id);
const LAST_KEY = "triptrace.last";
const REVISIONS_KEY = "triptrace.revisions";
const THEME_KEY = "triptrace.theme";
const TZ_KEY = "triptrace.station-tz";
const COMMUTE_KEY = "triptrace.commute";

/**
 * How the pilot reached base for duty day 1. The Trip Board cannot show it and the parser files it
 * under `no_commute_info`, so it is asked before the analysis rather than explained afterwards.
 * Only the long answer changes a number, and it changes it the one honest way available: as
 * workload, through the same "Long commute" condition the log uses.
 */
const COMMUTE_CHOICES = [
  { id: "based", label: "I live in base", factor: false,
    note: "No commute before duty day 1 — the pilot lives in base." },
  { id: "short", label: "Short drive", factor: false,
    note: "A short drive to base before duty day 1." },
  { id: "long", label: "Long drive or a flight", factor: true,
    note: "A long commute to base before duty day 1, counted as workload." },
  { id: "night", label: "Travelled overnight", factor: true,
    note: "Overnight travel to base before duty day 1, counted as workload." },
];

// Enough of the world for a UPS network, and the pilot can always pick the closest match.
const TZ_CHOICES = [
  ["America/New_York", "US Eastern"], ["America/Chicago", "US Central"],
  ["America/Denver", "US Mountain"], ["America/Phoenix", "US Arizona (no DST)"],
  ["America/Los_Angeles", "US Pacific"], ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"], ["America/Toronto", "Canada Eastern"],
  ["America/Vancouver", "Canada Pacific"], ["America/Mexico_City", "Mexico City"],
  ["America/Sao_Paulo", "Brazil"], ["Europe/London", "UK"], ["Europe/Paris", "Central Europe"],
  ["Europe/Istanbul", "Turkey"], ["Asia/Dubai", "Gulf"], ["Asia/Kolkata", "India"],
  ["Asia/Shanghai", "China"], ["Asia/Hong_Kong", "Hong Kong"], ["Asia/Seoul", "Korea"],
  ["Asia/Tokyo", "Japan"], ["Australia/Sydney", "Eastern Australia"], ["UTC", "UTC"],
];

const BAC_TEXT = {
  green: "negligible impairment equivalence",
  yellow: "≈ 0.01–0.02 BAC equivalent",
  orange: "≈ 0.03–0.04 BAC equivalent",
  red: "≈ 0.05 BAC equivalent",
  purple: "≈ 0.08+ BAC equivalent",
};
const DELAY_CHOICES = [["On time", 0], ["+15", 15], ["+30", 30], ["+60", 60], ["+120", 120]];

const state = {
  payload: null,
  carrier: "ups",
  carriers: [],
  samples: [],
  file: null,
  source: "sample",
  revisions: {},        // day_index -> { delay_minutes, flight, factors:Set, note }
  sleep: [],
  sleepVendor: null,
  tab: "trip",
  scope: "trip",
  series: { effectiveness: true, reservoir: false },
  bands: false,
  localClock: false,
  stationTz: {},        // IATA -> IANA, supplied by the pilot for stations the table lacks
  commute: null,        // null = not asked yet
  installPrompt: null,
};

let engine = null;
let summaryMod = null;
const engineReady = import(`./core/engine.js?v=${V}`)
  .then((m) => { engine = m; })
  .catch((e) => { console.error("engine unavailable", e); });

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Count a number up into place. Apple's fitness rings do this and it is not decoration: a value
 * that arrives over half a second reads as measured, where one that snaps in reads as printed.
 */
function countTo(node, to, { decimals = 0, duration = 900, suffix = "" } = {}) {
  const final = to.toFixed(decimals) + suffix;
  // The true value goes in first, unconditionally. The count-up is a flourish layered on top,
  // and it only runs when the page is visible: in a hidden tab neither animation frames nor
  // timers are reliable, and a report that opens behind another window must already be right.
  node.textContent = final;
  if (reduceMotion || document.visibilityState !== "visible") return;
  const start = performance.now();
  let done = false;
  const step = (now) => {
    if (done) return;
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = (to * eased).toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(step); else done = true;
  };
  requestAnimationFrame(step);
  // Animation frames pause in a background tab, and a page that opens behind another window
  // must not sit on "0%" until it is looked at. The timer lands the final value regardless.
  setTimeout(() => { if (!done) { done = true; node.textContent = final; } }, duration + 250);
}

// ── Formatting ──────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hm = (h) => (h === null || h === undefined ? "—"
  : `${Math.floor(Math.round(h * 60) / 60)}:${String(Math.round(h * 60) % 60).padStart(2, "0")}`);
const zulu = (iso) => (iso ? `${iso.slice(11, 16)}Z` : "—");
const localHM = (clock) => (clock?.station_local ? clock.station_local.slice(11, 16) : null);
const dayText = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined,
  { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "");
/**
 * Round for display, except when rounding would cross a band edge. 74.9 shown as "75%" next to
 * the word Critical reads as a bug, and worse, it reads as the safer side of a threshold the
 * whole document argues about. In that case show the decimal the model produced.
 */
const pct = (v) => {
  if (v === null || v === undefined) return "—";
  const r = Math.round(v);
  return bandFor(r).key === bandFor(v).key ? `${r}%` : `${v.toFixed(1)}%`;
};

/** "2d 14h" / "6h 12m" / "18m" — a countdown a pilot reads at a glance. */
function untilText(fromMs, toMs) {
  const mins = Math.max(0, Math.round((toMs - fromMs) / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

const trace = () => state.payload?.trace ?? null;
const report = () => state.payload?.report ?? null;

// ── Theme ───────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#F4F6FA" : "#0A0E17");
  $("menu-theme").textContent = theme === "light" ? "Switch to dark" : "Switch to light";
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* private mode */ }
}
try { applyTheme(localStorage.getItem(THEME_KEY) || "dark"); } catch (_) { applyTheme("dark"); }
$("menu-theme").addEventListener("click", () =>
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"));

// ── Sheets ──────────────────────────────────────────────────────────────────

let lockedScroll = 0;
function syncSheetState() {
  const open = [...document.querySelectorAll(".sheet-bg")].some((s) => !s.hidden);
  const was = document.body.classList.contains("sheet-open");
  if (open === was) return;
  if (open) {
    lockedScroll = window.scrollY;
    document.body.classList.add("sheet-open");
    document.body.style.top = `-${lockedScroll}px`;
  } else {
    document.body.classList.remove("sheet-open");
    document.body.style.top = "";
    window.scrollTo(0, lockedScroll);
  }
}
const openSheet = (id) => {
  const sheet = $(id).querySelector(".sheet");
  sheet.classList.remove("dragging", "settling");
  sheet.style.transform = "";
  $(id).hidden = false;
  syncSheetState();
};
const closeSheet = (id) => { $(id).hidden = true; syncSheetState(); };

/**
 * Drag a sheet down to dismiss it. Past a third of its height, or on a decisive flick, it goes;
 * otherwise it springs back. Pointer events cover touch, pen and mouse in one path.
 */
function makeDraggable(sheet, bgId) {
  let startY = 0, lastY = 0, lastT = 0, dy = 0, active = false;
  const grab = sheet.querySelector(".grabber");
  const canStart = (e) => {
    const body = sheet.querySelector(".sheet-body");
    // Only take the gesture when the content is already at its top, or the list would not scroll.
    return e.target === grab || e.target.closest(".sheet-head") || (body && body.scrollTop <= 0);
  };
  sheet.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.target !== grab && !e.target.closest(".sheet-head")) return;
    if (!canStart(e)) return;
    active = true; startY = lastY = e.clientY; lastT = performance.now(); dy = 0;
    sheet.classList.add("dragging");
  });
  sheet.addEventListener("pointermove", (e) => {
    if (!active) return;
    dy = Math.max(0, e.clientY - startY);
    if (dy > 4) sheet.setPointerCapture?.(e.pointerId);
    lastY = e.clientY; lastT = performance.now();
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!active) return;
    active = false;
    sheet.classList.remove("dragging");
    sheet.classList.add("settling");
    const flick = (performance.now() - lastT) < 220 && dy > 60;
    if (dy > sheet.offsetHeight * 0.3 || flick) {
      sheet.style.transform = "translateY(100%)";
      setTimeout(() => { closeSheet(bgId); sheet.style.transform = ""; sheet.classList.remove("settling"); }, 260);
    } else {
      sheet.style.transform = "";
      setTimeout(() => sheet.classList.remove("settling"), 320);
    }
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
}
for (const bg of document.querySelectorAll(".sheet-bg")) {
  const sheet = bg.querySelector(".sheet");
  if (sheet) makeDraggable(sheet, bg.id);
}
for (const b of document.querySelectorAll("[data-close]")) {
  b.addEventListener("click", () => closeSheet(b.dataset.close));
}
for (const bg of document.querySelectorAll(".sheet-bg")) {
  bg.addEventListener("click", (e) => { if (e.target === bg) closeSheet(bg.id); });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".sheet-bg").forEach((s) => { s.hidden = true; });
  syncSheetState();
});

// ── Tabs ────────────────────────────────────────────────────────────────────

const TABS = ["trip", "now", "rest", "doc"];
function setTab(name) {
  const from = TABS.indexOf(state.tab), to = TABS.indexOf(name);
  state.tab = name;
  for (const t of [...TABS, "empty"]) $(`tab-${t}`).hidden = true;
  if (!state.payload) { $("tab-empty").hidden = false; return; }

  // Come in from the side the tab lives on, so the four of them feel like places.
  const panel = $(`tab-${name}`);
  panel.classList.remove("from-left", "from-right");
  if (from >= 0 && to >= 0 && from !== to) panel.classList.add(to > from ? "from-right" : "from-left");
  panel.hidden = false;

  for (const b of document.querySelectorAll(".tabbtn")) {
    const on = b.dataset.tab === name;
    b.setAttribute("aria-selected", String(on));
    b.classList.remove("pop");
    if (on && from !== to) { void b.offsetWidth; b.classList.add("pop"); }
  }
  $("scroll").scrollTop = 0;
  window.scrollTo({ top: 0, behavior: "auto" });
  onScroll();
  if (name === "trip") drawTrace();
}

/**
 * The nav bar earns its separator, and the trip title hands off from the hero to the bar as the
 * hero leaves. Two elements crossfading beats one element resizing: no reflow, no jitter.
 */
function onScroll() {
  const past = window.scrollY > 150 || state.tab !== "trip";
  $("topbar").classList.toggle("scrolled", past && Boolean(state.payload));
}
window.addEventListener("scroll", onScroll, { passive: true });
for (const b of document.querySelectorAll(".tabbtn")) {
  b.addEventListener("click", () => setTab(b.dataset.tab));
}

// ── Working overlay ─────────────────────────────────────────────────────────

const working = (text) => { $("working-text").textContent = text; $("working").hidden = false; };
const done = () => { $("working").hidden = true; };

// ═══ RENDER ════════════════════════════════════════════════════════════════

function renderAll() {
  const t = trace();
  if (!t) {
    $("tabbar").hidden = true;
    $("trip-pill").hidden = true;
    setTab("trip");
    return;
  }
  $("tabbar").hidden = false;
  $("trip-pill").hidden = false;
  state.tmodel = traceModel(t);          // must precede the pill: its fallback reads this model
  renderStationBanner();
  const lowPct = t.outputs?.trip_min_effectiveness_pct ?? state.tmodel?.lowest?.pct ?? null;
  $("trip-pill").innerHTML = `<b>${esc(t.pairing?.pairing_id ?? "Trip")}</b>${
    lowPct === null ? "" : ` · <span style="color:${bandColor(lowPct)}">${esc(pct(lowPct))}</span>`}`;
  renderTrip();
  renderNow();
  renderRest();
  renderDoc();
  setTab(state.tab);
}

// ── Trip ────────────────────────────────────────────────────────────────────

function renderTrip() {
  const t = trace();
  const out = t.outputs ?? {};
  // The engine names this `trip_min_effectiveness_pct`; the curve's own minimum is only a fallback
  // for a trace that could not be scored. They agreed on every sample, which is exactly why a typo
  // here would never have surfaced.
  const low = out.trip_min_effectiveness_pct ?? state.tmodel?.lowest?.pct ?? null;
  const band = bandFor(low ?? 100);

  drawRing(low ?? 0, band);
  $("hero-where").textContent = out.risk_label
    ? `${out.risk_label}` : (state.tmodel?.worst?.minWhere ?? "");
  $("hero-bac").textContent = BAC_TEXT[band.key]
    ? BAC_TEXT[band.key].charAt(0).toUpperCase() + BAC_TEXT[band.key].slice(1) : "";

  const p = t.pairing ?? {};
  $("statstrip").innerHTML = [
    [hm(p.tafb_hours), "TAFB"],
    [hm(p.total_block_hours), "Block"],
    [String(p.landings_count ?? ""), "Ldg"],
    [String(p.duty_days ?? t.duty_periods.length), "Days"],
  ].map(([v, l]) => `<div><div class="sv">${esc(v)}</div><div class="sl">${esc(l)}</div></div>`).join("");

  $("duty-list").innerHTML = state.tmodel.duties.map((d) => {
    const b = bandFor(d.minPct ?? 100);
    const logged = state.revisions[d.day];
    const tag = logged && (logged.delay_minutes || logged.factors?.size)
      ? `<span class="flag floor">Logged</span> ` : "";
    return `<button class="duty-row" data-day="${d.day}">
      <div>
        <div class="duty-day">D${d.day}</div>
        <div class="duty-date">${esc(dayText(d.date))}</div>
      </div>
      <div>
        <div class="duty-seq">${esc(d.route)}</div>
        <div class="duty-meta">${tag}${esc(zulu(new Date(d.report).toISOString()))} → ${esc(zulu(new Date(d.release).toISOString()))} · ${d.landings} ldg</div>
      </div>
      <div>
        <div class="duty-pct" style="color:${bandVar(b.key)}">${pct(d.minPct)}</div>
        ${sparkline(d.startPct, d.minPct, d.endPct)}
      </div>
    </button>`;
  }).join("");
  for (const row of $("duty-list").querySelectorAll(".duty-row")) {
    row.addEventListener("click", () => openDuty(Number(row.dataset.day)));
  }

  renderExposure(t);

  const watch = report()?.watch ?? [];
  $("trip-watch").innerHTML = watch.length
    ? watch.map((w) => `<li>${esc(w)}</li>`).join("")
    : `<li class="sub">Nothing flagged beyond the duty detail above.</li>`;

  renderScopes();
}

/**
 * Flight time against fatigue exposure. The 30-hour figure is the reference used for the
 * 30-in-7 flight-time limit, shown as a scale and nothing more: the panel exists precisely
 * because a trip can sit comfortably inside a block-time limit while duty, positioning and
 * nights away pile up underneath it. Every figure is read off the trace; none is a ruling.
 */
function renderExposure(t) {
  const p = t.pairing ?? {};
  const duties = t.duty_periods ?? [];
  const block = p.total_block_hours ?? 0;
  const duty = duties.reduce((a, d) => a + ((d.scheduled_duty?.actual_hours ?? d.scheduled_duty?.scheduled_hours) ?? 0), 0);
  // The parser records a deadhead in the leg's raw block; the Pos column is the pilot's seat.
  const deadhead = duties.flatMap((d) => d.legs ?? [])
    .filter((l) => l.raw?.deadhead === true || /^(CML|DHD|DH)$/i.test(l.flight ?? ""))
    .reduce((a, l) => a + ((Date.parse(l.arr?.utc) - Date.parse(l.dep?.utc)) / 3600e3 || 0), 0);
  const nights = duties.filter((d) => {
    const w = d.circadian?.wocl_window;
    return w && Date.parse(d.report?.utc) < Date.parse(w.end_utc) && Date.parse(d.release?.utc) > Date.parse(w.start_utc);
  }).length;
  const low = t.outputs?.trip_min_effectiveness_pct ?? null;
  const REF = 30;
  $("exposure").innerHTML = `
    <div class="exp-grid">
      <div><div class="v">${esc(hm(block))}</div><div class="l">Operating block</div></div>
      <div><div class="v">${esc(hm(duty))}</div><div class="l">Duty exposure</div></div>
      <div><div class="v">${esc(hm(deadhead))}</div><div class="l">Positioning</div></div>
      <div><div class="v">${esc(hm(p.tafb_hours))}</div><div class="l">Time away</div></div>
      <div><div class="v">${nights}</div><div class="l">Duties touching the WOCL</div></div>
      <div><div class="v" style="color:${low === null ? "inherit" : bandColor(low)}">${esc(pct(low))}</div><div class="l">Trip minimum</div></div>
    </div>
    <div class="exp-bar"><i style="transform:scaleX(${Math.min(1, block / REF).toFixed(3)})"></i></div>
    <div class="exp-note"><span>Block ${esc(hm(block))} of a ${REF}:00 reference</span><span>${esc(hm(Math.max(0, REF - block)))} remaining</span></div>
    <p class="sub small" style="margin:12px 0 0">Regulatory flight-time compliance and physiological fatigue are related but not equivalent measures.</p>`;
}

function drawRing(value, band) {
  const R = 86, C = 2 * Math.PI * R;
  const fill = Math.max(0, Math.min(1, (value - 55) / 45));
  const color = bandVar(band.key);
  $("hero-ring").innerHTML = `
    <svg viewBox="0 0 216 216" aria-label="Lowest estimated effectiveness ${Math.round(value)} percent, ${band.label} band">
      <circle class="ring-track" cx="108" cy="108" r="${R}" stroke-width="13" fill="none"/>
      <circle class="ring-arc" id="ring-arc" cx="108" cy="108" r="${R}" stroke="${color}" stroke-width="13"
        stroke-linecap="round" fill="none" transform="rotate(-90 108 108)"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(reduceMotion ? C * (1 - fill) : C).toFixed(1)}"/>
      <text class="ring-num" x="108" y="104" text-anchor="middle" fill="var(--ink)" stroke="none"
        ><tspan id="ring-val">${pct(value).replace("%", "")}</tspan><tspan class="unit">%</tspan></text>
      <text class="ring-band" x="108" y="130" text-anchor="middle" fill="${color}" stroke="none"
        >${esc(band.label)}</text>
    </svg>`;
  // The markup above already carries the true number. The sweep and the count-up are flourishes:
  // the count-up is started synchronously (it decides for itself whether the page is visible),
  // and only the arc's transition waits for a frame. Nothing about the value depends on a frame.
  if (!reduceMotion) {
    const shown = pct(value);
    const decimals = shown.includes(".") ? 1 : 0;
    const val = $("ring-val");
    if (val) countTo(val, value, { decimals, duration: 1150 });
    requestAnimationFrame(() => {
      const arc = $("ring-arc");
      if (arc) arc.style.strokeDashoffset = String(C * (1 - fill));
    });
  }
}

function renderScopes() {
  const scopes = [["trip", "Whole trip"], ...state.tmodel.duties.map((d) => [d.day, `D${d.day}`])];
  $("trace-scopes").innerHTML = scopes.map(([v, l]) =>
    `<button class="scope" data-scope="${v}" aria-pressed="${String(v) === String(state.scope)}">${esc(l)}</button>`).join("");
  for (const b of $("trace-scopes").querySelectorAll(".scope")) {
    b.addEventListener("click", () => {
      state.scope = b.dataset.scope === "trip" ? "trip" : Number(b.dataset.scope);
      renderScopes();
      drawTrace();
      $("trace-scroll").scrollLeft = 0;
    });
  }
}

/** The domicile's zone is the one "local" a whole-trip axis can honestly speak. */
const axisTz = () => (state.localClock
  ? (trace()?.meta?.domicile_tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  : null);

function drawTrace() {
  if (!state.tmodel) return;
  renderTrace($("trace-chart"), state.tmodel, {
    scope: state.scope,
    now: Date.now(),
    width: $("trace-scroll").clientWidth || 340,
    series: state.series,
    bands: state.bands,
    tzName: axisTz(),
  });
  resetReadout();
  attachScrub();
}

/** The chart's resting caption: what the whole view is showing. */
function resetReadout() {
  const m = state.tmodel;
  if (!m) return;
  const low = m.lowest;
  const b = bandFor(low?.pct ?? 100);
  $("trace-readout").innerHTML = `
    <div class="rv" style="color:${bandVar(b.key)}">${esc(pct(low?.pct))} lowest · ${esc(b.label)}</div>
    <div class="rl">${esc(low?.label ?? "")} · drag across the chart to read any point</div>`;
}

/**
 * Scrub the chart. The marker snaps to points the model actually produced — never to a value
 * interpolated between them — so every number this readout shows is one the engine computed.
 */
function attachScrub() {
  const host = $("trace-chart");
  const geom = host._trace;
  const svg = host.querySelector("svg");
  if (!geom || !svg || !geom.points.length) return;

  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(layer);

  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = (clientX - box.left) * (svg.viewBox.baseVal.width / box.width);
    let best = geom.points[0], bestD = Infinity;
    for (const p of geom.points) {
      const d = Math.abs(geom.x(p.t) - px);
      if (d < bestD) { bestD = d; best = p; }
    }
    const bx = geom.x(best.t), by = geom.y(best.pct);
    const band = bandFor(best.pct);
    layer.innerHTML =
      `<line class="scrub-line" x1="${bx.toFixed(1)}" x2="${bx.toFixed(1)}" y1="${geom.top}" y2="${geom.bottom}"/>`
      + `<circle class="scrub-dot" cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="5.5" fill="${bandColor(best.pct)}"/>`;
    const when = geom.tzName
      ? `${new Date(best.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: geom.tzName })} local`
      : `${zulu(new Date(best.t).toISOString())}`;
    $("trace-readout").innerHTML = `
      <div class="rv" style="color:${bandVar(band.key)}">${esc(pct(best.pct))} ${esc(band.label)}${
        best.res !== null && best.res !== undefined ? ` <span class="rl">· reservoir ${esc(pct(best.res))}</span>` : ""}</div>
      <div class="rl">${esc(best.label ?? "")} · ${esc(when)}</div>`;
  };

  const end = () => { layer.innerHTML = ""; resetReadout(); };
  svg.style.touchAction = "pan-x";
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture?.(e.pointerId); show(e.clientX); });
  svg.addEventListener("pointermove", (e) => { if (e.buttons) show(e.clientX); });
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", end);
}

for (const b of document.querySelectorAll("#trace-ctl .ctl")) {
  b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    const key = b.dataset.s;
    if (key === "bands") state.bands = on;
    else if (key === "clock") state.localClock = on;
    else {
      // One series has to stay on, or the chart is an empty box.
      const other = key === "effectiveness" ? "reservoir" : "effectiveness";
      if (!on && !state.series[other]) return;
      state.series[key] = on;
    }
    b.setAttribute("aria-pressed", String(on));
    drawTrace();
  });
}
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawTrace, 180);
});

// ── Duty detail ─────────────────────────────────────────────────────────────

function openDuty(day) {
  const d = state.tmodel.duties.find((x) => x.day === day);
  const raw = trace().duty_periods.find((x) => x.day_index === day);
  if (!d || !raw) return;
  const b = bandFor(d.minPct ?? 100);
  const lay = raw.layover_after ?? null;
  const rest = trace().rest_periods?.find((r) => r.after_duty_day === day) ?? null;

  $("duty-sheet-title").textContent = `D${day} · ${d.route}`;
  $("duty-sheet-body").innerHTML = `
    <div class="card">
      <div class="nowpct">
        <div class="v" style="color:${bandVar(b.key)}">${pct(d.minPct)}</div>
        <div><div style="font-weight:650">${esc(b.label)}</div>
          <div class="t">${esc(d.minWhere)}${d.minAt ? ` · ${esc(zulu(new Date(d.minAt).toISOString()))}` : ""}</div></div>
      </div>
      <div style="margin-top:14px">
        <div class="kv"><span>Report</span><span>${esc(localHM(raw.report) ?? "—")}L · ${esc(zulu(raw.report?.utc))}</span></div>
        <div class="kv"><span>Release</span><span>${esc(localHM(raw.release) ?? "—")}L · ${esc(zulu(raw.release?.utc))}</span></div>
        <div class="kv"><span>Duty</span><span>${esc(hm(raw.scheduled_duty?.actual_hours ?? raw.scheduled_duty?.scheduled_hours))}${raw.scheduled_duty?.actual_hours ? " (actual)" : ""}</span></div>
        <div class="kv"><span>Landings</span><span>${raw.landings ?? 0}</span></div>
      </div>
      <div class="rest-nums" style="margin-top:14px">
        <div><div class="v">${pct(d.startPct)}</div><div class="l">At report</div></div>
        <div><div class="v" style="color:${bandVar(b.key)}">${pct(d.minPct)}</div><div class="l">Lowest</div></div>
        <div><div class="v">${pct(d.endPct)}</div><div class="l">At release</div></div>
      </div>
    </div>

    <div class="card" style="margin-top:10px">
      <h3 class="card-h">Legs</h3>
      ${d.legs.map((l) => `
        <div class="kv">
          <span>${esc(l.flight)}${l.deadhead ? " · DH" : ""} ${esc(l.from)}–${esc(l.to)}</span>
          <span>${esc(zulu(new Date(l.dep).toISOString()))} → ${esc(zulu(new Date(l.arr).toISOString()))}${
            l.minPct !== null ? ` · <span style="color:${bandColor(l.minPct)}">${pct(l.minPct)}</span>` : ""}</span>
        </div>`).join("")}
    </div>

    ${lay ? `<div class="card" style="margin-top:10px">
      <h3 class="card-h">Layover after</h3>
      <div class="kv"><span>Station</span><span>${esc(lay.station ?? "—")}</span></div>
      <div class="kv"><span>Length</span><span class="${lay.at_or_near_floor ? "warn" : ""}">${esc(hm(lay.length_hours))}</span></div>
      <div class="kv"><span>Contract floor</span><span>${esc(hm(lay.contract_floor_hours))}${lay.reducible ? ` · reducible to ${esc(hm(lay.reducible_to_hours))}` : ""}</span></div>
      ${rest ? `<div class="kv"><span>Sleep opportunity</span><span>${esc(hm(rest.sleep_opportunity_hours))}</span></div>
      <div class="kv"><span>Modeled effective</span><span>${esc(hm(rest.total_effective_sleep_hours))}</span></div>` : ""}
    </div>` : ""}

    <button class="btn btn-primary btn-lg" style="margin-top:14px" id="duty-log">Log what happened on D${day}</button>`;

  $("duty-log").addEventListener("click", () => { closeSheet("duty-sheet"); openLog(day); });
  openSheet("duty-sheet");
}

// ── Now ─────────────────────────────────────────────────────────────────────

function renderNow() {
  const now = Date.now();
  const m = state.tmodel;
  const duties = m.duties;
  const first = duties[0], last = duties[duties.length - 1];
  const parts = [];
  state.countTarget = null;

  const current = duties.find((d) => now >= d.report && now <= d.release);
  const next = duties.find((d) => d.report > now);
  const restNow = m.sleeps.find((r) => now >= r.winStart && now <= r.winEnd);

  // Phase card.
  if (now < first.report) {
    parts.push(phaseCard("Before the trip", `D${first.day} reports in`, untilText(now, first.report),
      `${zulu(new Date(first.report).toISOString())} · ${dayText(first.date)}`, null, first.report));
  } else if (current) {
    const leg = current.legs.find((l) => now >= l.dep && now <= l.arr);
    parts.push(phaseCard(`D${current.day} in progress`,
      leg ? `Airborne · ${leg.flight} ${leg.from}–${leg.to}` : "On the ground",
      untilText(now, current.release), `Release ${zulu(new Date(current.release).toISOString())}`,
      { at: now, from: current.report, to: current.release, a: "Report", b: "Release" }, current.release));
  } else if (restNow && next) {
    parts.push(phaseCard(`Layover · ${restNow.station}`, `D${next.day} reports in`,
      untilText(now, next.report), `${zulu(new Date(next.report).toISOString())} · ${dayText(next.date)}`,
      { at: now, from: restNow.winStart, to: restNow.winEnd, a: "Window opens", b: "Window closes" }, next.report));
  } else if (next) {
    parts.push(phaseCard("Between duties", `D${next.day} reports in`, untilText(now, next.report),
      `${zulu(new Date(next.report).toISOString())} · ${dayText(next.date)}`, null, next.report));
  } else {
    parts.push(`<div class="phase-card">
      <div class="phase-tag">Trip complete</div>
      <div class="phase-what">Released ${esc(zulu(new Date(last.release).toISOString()))} on ${esc(dayText(last.date))}</div>
      <p class="sub small" style="margin-top:10px">Every duty period has been released. The Trace
        and the report describe the trip as flown, including anything logged along the way.</p>
    </div>`);
  }

  // The duty in focus: the one running, or the next one.
  const focus = current ?? next ?? last;
  if (focus) {
    const b = bandFor(focus.minPct ?? 100);
    parts.push(`<div class="card">
      <h3 class="card-h">${current ? "This duty" : next ? "Next duty" : "Last duty"} · D${focus.day}</h3>
      <div class="nowpct">
        <div class="v" style="color:${bandVar(b.key)}">${pct(focus.minPct)}</div>
        <div><div style="font-weight:650">${esc(b.label)} at its lowest</div>
          <div class="t">${esc(focus.minWhere)}</div></div>
      </div>
      <div style="margin-top:12px">
        <div class="kv"><span>Route</span><span>${esc(focus.route)}</span></div>
        <div class="kv"><span>Report → release</span><span>${esc(zulu(new Date(focus.report).toISOString()))} → ${esc(zulu(new Date(focus.release).toISOString()))}</span></div>
        <div class="kv"><span>At report / low / release</span><span>${pct(focus.startPct)} · ${pct(focus.minPct)} · ${pct(focus.endPct)}</span></div>
      </div>
    </div>`);
  }

  // The next sleep the schedule allows — the one thing on this screen the pilot can act on.
  const nextRest = restNow ?? m.sleeps.find((r) => r.winStart > now);
  if (nextRest) {
    const raw = trace().rest_periods.find((r) => r.after_duty_day === nextRest.afterDay);
    const anyDay = nextRest.blocks.some((x) => x.daytime);
    parts.push(`<div class="card">
      <h3 class="card-h">${restNow ? "Sleep window now open" : "Next sleep window"} · ${esc(nextRest.station)}</h3>
      <div class="kv"><span>Window</span><span>${esc(zulu(new Date(nextRest.winStart).toISOString()))} → ${esc(zulu(new Date(nextRest.winEnd).toISOString()))}</span></div>
      <div class="kv"><span>Opportunity</span><span>${esc(hm(raw?.sleep_opportunity_hours))}</span></div>
      <div class="kv"><span>Modeled effective</span><span>${esc(hm(raw?.total_effective_sleep_hours))}</span></div>
      <p class="tagline">${anyDay
        ? `<span class="flag day">Daytime</span>Sleeping against the body clock. The model already discounts this window; a dark, cold room and a single consolidated block are what close the gap.`
        : `<span class="flag night">Overnight</span>This window sits with the body clock rather than against it, which is why it is worth protecting.`}</p>
    </div>`);
  }

  // Riskiest duty still ahead — the decision this app exists for.
  const remaining = duties.filter((d) => d.release > now);
  const riskiest = remaining.length
    ? remaining.reduce((a, b) => (b.minPct < a.minPct ? b : a))
    : null;
  if (riskiest && riskiest !== focus) {
    const b = bandFor(riskiest.minPct ?? 100);
    parts.push(`<div class="card">
      <h3 class="card-h">Riskiest duty still ahead</h3>
      <div class="nowpct">
        <div class="v" style="color:${bandVar(b.key)}">${pct(riskiest.minPct)}</div>
        <div><div style="font-weight:650">D${riskiest.day} ${esc(riskiest.route)}</div>
          <div class="t">${esc(dayText(riskiest.date))} · ${esc(riskiest.minWhere)}</div></div>
      </div>
    </div>`);
  }

  $("now-body").innerHTML = parts.join("");
}

function phaseCard(tag, what, count, sub, progress, target = null) {
  const soon = /^(\d+)m$/.test(count) || /^[0-5]h/.test(count);
  if (target) state.countTarget = target;
  return `<div class="phase-card">
    <div class="phase-tag">${esc(tag)}</div>
    <div class="phase-what">${esc(what)}</div>
    <div class="count ${soon ? "soon" : ""}" id="count-live">${esc(count)}</div>
    <div class="count-sub">${esc(sub)}</div>
    ${progress ? `
      <div class="bar"><i style="width:${(Math.max(0, Math.min(1, (progress.at - progress.from) / (progress.to - progress.from))) * 100).toFixed(1)}%"></i></div>
      <div class="bar-note"><span>${esc(progress.a)}</span><span>${esc(progress.b)}</span></div>` : ""}
  </div>`;
}

$("now-log").addEventListener("click", () => {
  const now = Date.now();
  const d = state.tmodel.duties.find((x) => now >= x.report && now <= x.release)
    ?? state.tmodel.duties.find((x) => x.report > now)
    ?? state.tmodel.duties[0];
  openLog(d.day);
});

// ── Rest ────────────────────────────────────────────────────────────────────

function renderRest() {
  const t = trace();
  const rests = t.rest_periods ?? [];
  if (!rests.length) {
    $("rest-body").innerHTML = `<div class="card"><p class="sub">This pairing has no layover between duty periods.</p></div>`;
    return;
  }
  $("rest-body").innerHTML = rests.map((r) => {
    const lay = t.duty_periods.find((d) => d.day_index === r.after_duty_day)?.layover_after ?? {};
    const short = (r.total_effective_sleep_hours ?? 0) < 6.5;
    const day = (r.sleep_events ?? []).some((e) => e.is_daytime);
    const measured = (r.sleep_events ?? []).some((e) => e.source === "actual");
    const wocl = t.duty_periods.find((d) => d.day_index === r.after_duty_day + 1)?.circadian?.wocl_window
      ?? t.duty_periods.find((d) => d.day_index === r.after_duty_day)?.circadian?.wocl_window;
    return `<div class="rest-card">
      <div class="rest-top">
        <div class="rest-station">${esc(r.station)}</div>
        <div class="rest-after">After D${r.after_duty_day}</div>
      </div>
      ${hypnogram(r, wocl)}
      <div class="rest-nums">
        <div><div class="v">${esc(hm(r.layover_length_hours))}</div><div class="l">Layover</div></div>
        <div><div class="v">${esc(hm(r.sleep_opportunity_hours))}</div><div class="l">Opportunity</div></div>
        <div><div class="v ${short ? "short" : ""}">${esc(hm(r.total_effective_sleep_hours))}</div><div class="l">Effective</div></div>
      </div>
      <p class="tagline">
        ${measured ? `<span class="flag measured">Measured</span>` : ""}
        ${day ? `<span class="flag day">Daytime</span>` : `<span class="flag night">Overnight</span>`}
        ${lay.at_or_near_floor ? `<span class="flag floor">At the floor</span>` : ""}
        ${esc(restText(r, day, measured, lay))}
      </p>
    </div>`;
  }).join("");
}

/**
 * What this layover actually offers, in the pilot's terms. The engine's own `assumptions` string
 * names the model's efficiency constants, and the app does not disclose those.
 */
function restText(r, daytime, measured, lay) {
  const n = (r.sleep_events ?? []).length;
  const bits = [];
  bits.push(n === 0 ? "No usable sleep block fits inside this layover."
    : n === 1 ? "One consolidated block fits inside the opportunity window."
    : `${n} separate blocks fit inside the opportunity window, so this rest is split rather than consolidated.`);
  if (measured) bits.push("Your measured sleep has replaced the model for this layover.");
  else if (daytime) bits.push("It falls in daylight, against the body clock, and is discounted accordingly.");
  else bits.push("It sits with the body clock rather than against it, which is why it is worth protecting.");
  if (lay?.at_or_near_floor) bits.push("The layover is at or near its contractual floor, so there is nothing to give back.");
  return bits.join(" ");
}

/** One layover as a hypnogram strip: opportunity window, modeled blocks inside it, WOCL behind. */
function hypnogram(rest, wocl) {
  const s = Date.parse(rest.sleep_opportunity_window?.start_utc ?? "");
  const e = Date.parse(rest.sleep_opportunity_window?.end_utc ?? "");
  if (!s || !e || e <= s) return "";
  const W = 320, H = 46, barY = 12, barH = 20;
  const pad = (e - s) * 0.04;
  const from = s - pad, to = e + pad;
  const x = (t) => ((t - from) / (to - from)) * W;
  const parts = [];
  if (wocl) {
    const w0 = Math.max(from, Date.parse(wocl.start_utc)), w1 = Math.min(to, Date.parse(wocl.end_utc));
    if (w1 > w0) parts.push(`<rect class="woclb" x="${x(w0).toFixed(1)}" y="4" width="${(x(w1) - x(w0)).toFixed(1)}" height="${H - 16}" rx="3"/>`);
  }
  parts.push(`<rect class="win" x="${x(s).toFixed(1)}" y="${barY}" width="${(x(e) - x(s)).toFixed(1)}" height="${barH}" rx="6"/>`);
  for (const b of rest.sleep_events ?? []) {
    const rawStart = Date.parse(b.window?.start_utc ?? ""), rawEnd = Date.parse(b.window?.end_utc ?? "");
    if (!rawStart || !rawEnd || rawEnd <= rawStart) continue;
    const b0 = Math.max(s, rawStart), b1 = Math.min(e, rawEnd);
    if (b1 <= b0) continue;
    parts.push(`<rect class="blk" x="${x(b0).toFixed(1)}" y="${barY + 3}" width="${Math.max(2, x(b1) - x(b0)).toFixed(1)}" height="${barH - 6}" rx="4"/>`);
  }
  parts.push(`<text x="${x(s).toFixed(1)}" y="${H - 2}" text-anchor="start">${esc(zulu(rest.sleep_opportunity_window.start_utc))}</text>`);
  parts.push(`<text x="${x(e).toFixed(1)}" y="${H - 2}" text-anchor="end">${esc(zulu(rest.sleep_opportunity_window.end_utc))}</text>`);
  return `<svg class="hyp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${parts.join("")}</svg>`;
}

// ── Doc ─────────────────────────────────────────────────────────────────────

function renderDoc() {
  const r = report();
  const t = trace();
  // An answered question is no longer a gap. The parser cannot know the pilot told us, so the
  // answer is substituted here — it is their statement being shown back, not a model input.
  const choice = COMMUTE_CHOICES.find((c) => c.id === state.commute);
  const gaps = (t.missing_data ?? []).map((g) =>
    (g.kind === "no_commute_info" && choice
      ? { ...g, kind: "answered", detail: choice.note }
      : g));
  $("doc-body").innerHTML = `
    <section class="block" style="margin-top:22px">
      <div class="block-head"><h2>How this trip is built</h2></div>
      <div class="card"><p style="margin:0">${esc(r?.narrative ?? "")}</p></div>
    </section>

    <section class="block">
      <div class="block-head"><h2>What helps</h2></div>
      <div class="card"><ul class="bullets">${(r?.recommendations ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </section>

    <section class="block">
      <div class="block-head"><h2>What the model cannot see</h2></div>
      <div class="card">
        <p class="sub small">Every item here would change the result. It is part of the output, not
          a footnote to it.</p>
        ${gaps.length ? gaps.map((g) => `<div class="kv"><span>${esc(g.kind ?? "note")}</span><span>${esc(g.detail ?? g.description ?? "")}</span></div>`).join("")
          : `<p class="sub small" style="margin:0">Nothing ambiguous in this board.</p>`}
      </div>
    </section>

    <section class="block">
      <div class="block-head"><h2>Safety write-up</h2></div>
      <div class="card">
        <p class="sub small">Written from computed values only, in the language of a safety report
          rather than a complaint.</p>
        <pre id="safety-text" style="white-space:pre-wrap;font:inherit;margin:0">${esc(r?.safety_report ?? "")}</pre>
        <button class="btn btn-quiet" style="margin-top:12px;width:100%" id="copy-safety">Copy write-up</button>
      </div>
    </section>

    <button class="btn btn-primary btn-lg block-btn" id="open-summary">Create safety summary</button>
    <p class="sub tiny" style="text-align:center;margin-top:16px">Decision support for professional
      flight crews — not validated software, and not legal or contractual advice. The fatigue call
      is the pilot's authority.</p>`;

  $("copy-safety").addEventListener("click", () =>
    copyText($("safety-text").textContent, "Copied."));
  $("open-summary").addEventListener("click", openSummary);
}

async function copyText(text, okLabel) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); }
    else {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    $("summary-status").textContent = okLabel;
  } catch (_) { $("summary-status").textContent = "Could not copy — select the text instead."; }
}

// ── Safety summary (the exported document) ─────────────────────────────────

async function currentSummary() {
  summaryMod = summaryMod || await import(`./core/summary.js?v=${V}`);
  return summaryMod.summaryModel(state.payload, { factors: [], rescheduled: [] });
}

async function openSummary() {
  $("summary-status").textContent = "";
  openSheet("summary-sheet");
  try {
    renderSummary(await currentSummary());
  } catch (err) {
    $("summary-doc").innerHTML = `<p class="sub">Could not build the summary: ${esc(err.message)}</p>`;
  }
  const probe = new File([new Uint8Array([37, 80, 68, 70])], "p.pdf", { type: "application/pdf" });
  const canShare = Boolean(navigator.canShare && navigator.canShare({ files: [probe] }));
  $("summary-share").textContent = canShare ? "Share PDF" : "Download PDF";
}

function renderSummary(model) {
  const chip = (p, band) => (p === null || p === undefined ? "—"
    : `<span class="pchip" style="background:${bandVar(band)}22;color:${bandVar(band)}">${p}%</span>`);
  const cell = (attrs, html) => `<td ${attrs}><span class="v">${html}</span></td>`;
  const h = model.headline, t = model.today, r = model.riskiest, rec = model.recovery;

  $("summary-doc").innerHTML = `
    <div class="masthead">
      <div class="wordmark"><span class="a">TRIP</span><span class="b">TRACE</span></div>
      <div class="eyebrow">Safety risk summary${h && h.updated ? " — updated" : ""}</div>
    </div>
    <h1>${esc(model.title)}</h1>
    <div class="meta">${esc(model.subtitle)}</div>
    <div class="meta">${esc(model.prepared)}</div>

    <div class="tiles">${model.tiles.map((x) => `
      <div class="tile ${x.alert ? "alert" : ""}">
        <div class="tv" ${x.band ? `style="color:${bandVar(x.band)}"` : ""}>${esc(x.value)}</div>
        <div class="tl">${esc(x.label)}</div>
      </div>`).join("")}</div>

    ${model.logged.length ? `<div class="box event"><h3>Operational events logged</h3>
      ${model.logged.map((l) => `<p><b>Day ${l.day}:</b> ${esc(l.text)}${l.note ? ` — ${esc(l.note)}` : ""}</p>`).join("")}
      </div>` : ""}

    ${h ? `<div class="box" style="border-left-color:${bandVar(h.band)}">
      <h3>${h.updated ? "Updated current" : "Current"} safety assessment</h3>
      <div class="big">Trip minimum effectiveness: ${Math.round(h.minPct)}%
        <span style="color:${bandVar(h.band)}">${esc(h.bandLabel)}</span></div>
      <p>At ${esc(h.where)}${h.at ? ` (${esc(h.at)})` : ""}. ${esc(h.bac[0].toUpperCase() + h.bac.slice(1))}.
        ${h.fatigueCallIndicated ? "A fatigue call is professionally defensible at this level." : "Above the fatigue-call threshold."}</p>
    </div>` : ""}

    <h2>Duty-by-duty effectiveness</h2>
    <table>
      <thead><tr><th>Day</th><th>Sequence</th><th>Report → release (local)</th><th>Duty</th>
        <th>Start</th><th>Low</th><th>End</th><th>Where · then</th></tr></thead>
      <tbody>${model.duties.map((d) => `<tr>
        ${cell('class="num rowhead" data-l="Day"', `<b>D${d.day}</b><br><span class="sub">${esc(d.date)}</span>`)}
        ${cell('data-l="Sequence"', esc(d.sequence))}
        ${cell('class="num" data-l="Report → release"', `${esc(d.report)}<br>→ ${esc(d.release)}`)}
        ${cell('class="num" data-l="Duty"', `${d.actualDuty ? `<span class="short">${esc(d.actualDuty)}</span>` : esc(d.duty)}<br><span class="sub">${d.landings} ldg</span>`)}
        ${cell('class="num" data-l="Start"', chip(d.startPct, d.startBand))}
        ${cell('class="num" data-l="Low"', `${chip(d.minPct, d.band)}${d.combined !== null ? `<br><span class="sub">CC ${d.combined}%</span>` : ""}`)}
        ${cell('class="num" data-l="End"', chip(d.endPct, d.endBand))}
        ${cell('class="sub" data-l="Where · then"', `${esc(d.minWhere)}<br>then ${esc(d.layover)}`)}
      </tr>`).join("")}</tbody>
    </table>

    <div class="panels" style="margin-top:14px">
      <div class="box today"><h3>${t.phase === "complete" ? "Trip complete" : t.phase === "in progress" ? `Today — D${t.day}` : `Next up — D${t.day}`}</h3>
        ${t.phase === "complete" ? `<p class="sub">Every duty period has been released.</p>` : `
          ${t.pickup ? `<div class="kv"><span>Hotel pickup</span><span>${esc(t.pickup)}</span></div>` : ""}
          <div class="kv"><span>Report</span><span>${esc(t.report)} at ${esc(t.reportStation)}</span></div>
          <div class="kv"><span>Release</span><span>${esc(t.release)}</span></div>
          <div class="kv"><span>Lowest</span><span>${esc(t.lowest)}</span></div>`}
      </div>
      ${r ? `<div class="box" style="border-left-color:${bandVar(r.band)}">
        <h3>${r.remaining ? "Most risky remaining duty" : "Most risky duty"} — D${r.day}</h3>
        <div class="big">${r.minPct}% <span style="color:${bandVar(r.band)}">${esc(r.bandLabel)}</span></div>
        <ul>${r.bullets.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>` : ""}
    </div>

    ${rec ? `<div class="box recover"><h3>Recovery — ${esc(rec.station)} after D${rec.afterDay} (${esc(rec.layover)})</h3>
      <div class="kv"><span>Sleep opportunity</span><span>${esc(rec.opportunityHours)} · ${esc(rec.window)}</span></div>
      <div class="kv"><span>Modeled effective</span><span class="${rec.short ? "short" : ""}">${esc(rec.effective)}</span></div>
    </div>` : ""}

    <h2>Trip facts</h2>
    <div class="facts">${model.facts.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}</div>

    <h2>How this trip is built</h2><p>${esc(model.narrative)}</p>

    ${model.sleep.length ? `<h2>Sleep by layover</h2><table>
      <thead><tr><th>After</th><th>Station</th><th>Layover</th><th>Opportunity</th><th>Effective</th><th>Modeled blocks</th></tr></thead>
      <tbody>${model.sleep.map((s) => `<tr>
        ${cell('class="num rowhead" data-l="After"', `<b>D${s.afterDay}</b>`)}
        ${cell('data-l="Station"', esc(s.station))}
        ${cell('class="num" data-l="Layover"', esc(s.layover))}
        ${cell('class="num" data-l="Opportunity"', esc(s.opportunity))}
        ${cell(`class="num ${s.short ? "short" : ""}" data-l="Effective"`, esc(s.effective))}
        ${cell('class="sub" data-l="Modeled blocks"', s.blocks.map(esc).join("<br>") || "none modeled")}
      </tr>`).join("")}</tbody></table>` : ""}

    <h2>What helps</h2>
    <ul>${model.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>

    <h2>Worth knowing</h2>
    <ul>${model.watch.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>

    <h2>What the model cannot see</h2>
    ${model.gaps.map((g) => `<div class="gap ${g.severe ? "severe" : ""}"><b>${esc(g.label)}.</b> ${esc(g.detail)}</div>`).join("")}

    ${model.assessment ? `<h2>Assessment</h2><p>${esc(model.assessment).replace(/\n/g, "<br>")}</p>` : ""}
    ${model.statement ? `<h2>Statement</h2><p>${esc(model.statement).replace(/\n/g, "<br>")}</p>` : ""}`;
}

async function summaryFile() {
  const [{ summaryPdf }, model] = await Promise.all([import(`./pdf.js?v=${V}`), currentSummary()]);
  const id = (trace()?.pairing?.pairing_id ?? "trip").replace(/[^A-Za-z0-9]/g, "");
  return new File([summaryPdf(model)], `TripTrace-${id}-safety-summary.pdf`, { type: "application/pdf" });
}

$("summary-share").addEventListener("click", async () => {
  $("summary-status").textContent = "Building the PDF…";
  try {
    const file = await summaryFile();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      $("summary-status").textContent = "Shared.";
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $("summary-status").textContent = `Saved ${file.name}.`;
  } catch (err) {
    $("summary-status").textContent = err.name === "AbortError" ? ""
      : `Could not share the PDF: ${err.message}. Use “Print or save as PDF” instead.`;
  }
});
$("summary-print").addEventListener("click", () => { $("summary-status").textContent = ""; window.print(); });

// The one-page card: a phone-sized PNG drawn from the summary model, for sending by text.
$("summary-card").addEventListener("click", async () => {
  $("summary-status").textContent = "Drawing the card…";
  try {
    const [{ summaryCard }, model] = await Promise.all([import(`./card.js?v=${V}`), currentSummary()]);
    const blob = await summaryCard(model);
    const id = (trace()?.pairing?.pairing_id ?? "trip").replace(/[^A-Za-z0-9]/g, "");
    const file = new File([blob], `TripTrace-${id}-summary.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      $("summary-status").textContent = "Shared.";
      return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $("summary-status").textContent = `Saved ${file.name}.`;
  } catch (err) {
    $("summary-status").textContent = err.name === "AbortError" ? "" : `Could not draw the card: ${err.message}`;
  }
});

// Desktop only: the Trip Board is open in another window, so read it straight off the screen.
if (window.triptraceDesktop?.captureScreen) {
  $("capture-shot").hidden = false;
  $("capture-shot").addEventListener("click", async () => {
    try {
      const bytes = await window.triptraceDesktop.captureScreen();
      setSource("shot");
      acceptScreenshot(new File([bytes], "screen-capture.png", { type: "image/png" }));
    } catch (err) {
      $("drop-note").textContent = `Could not capture the screen: ${err.message}`;
    }
  });
}
$("summary-copy").addEventListener("click", async () => {
  summaryMod = summaryMod || await import(`./core/summary.js?v=${V}`);
  copyText(summaryMod.summaryText(await currentSummary()), "Copied as text.");
});

// ── Log what happened ───────────────────────────────────────────────────────

function openLog(day) {
  const d = state.tmodel.duties.find((x) => x.day === day);
  if (!d) return;
  const cur = state.revisions[day] ?? { delay_minutes: 0, flight: "", factors: new Set(), note: "" };
  const conditions = engine?.CONDITIONS ?? [];

  $("log-sheet-body").innerHTML = `
    <p class="sub small">D${day} · ${esc(d.route)} · ${esc(dayText(d.date))}</p>
    <h3 class="card-h" style="margin-top:16px">Delay</h3>
    <div class="chips" id="log-delay">${DELAY_CHOICES.map(([l, v]) =>
      `<button class="chip" data-min="${v}" aria-pressed="${cur.delay_minutes === v}">${esc(l)}</button>`).join("")}</div>
    <div style="margin-top:10px">
      <label class="sub small">From which leg</label>
      <div class="chips" id="log-leg" style="margin-top:6px">${d.legs.map((l) =>
        `<button class="chip" data-flight="${esc(l.flight)}" aria-pressed="${cur.flight === l.flight}">${esc(l.flight)} ${esc(l.from)}–${esc(l.to)}</button>`).join("")}</div>
    </div>
    <h3 class="card-h" style="margin-top:20px">Conditions</h3>
    <p class="sub small">Counted as workload in Combined Capacity. They never change the
      effectiveness estimate itself.</p>
    <div class="chips" id="log-cond">${conditions.map((c) =>
      `<button class="chip" data-c="${esc(c)}" aria-pressed="${cur.factors.has(c)}">${esc(c)}</button>`).join("")}</div>
    <h3 class="card-h" style="margin-top:20px">Note</h3>
    <textarea id="log-note" rows="3" placeholder="Anything worth remembering about this duty.">${esc(cur.note)}</textarea>
    <button class="btn btn-primary btn-lg" style="margin-top:16px" id="log-save">Apply to the analysis</button>
    <button class="btn btn-ghost btn-lg" style="margin-top:8px" id="log-clear">Clear this day</button>`;

  const toggleOne = (wrap, attr) => {
    for (const b of $(wrap).querySelectorAll(".chip")) {
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") === "true";
        for (const o of $(wrap).querySelectorAll(".chip")) o.setAttribute("aria-pressed", "false");
        b.setAttribute("aria-pressed", String(!on));
      });
    }
  };
  toggleOne("log-delay"); toggleOne("log-leg");
  for (const b of $("log-cond").querySelectorAll(".chip")) {
    b.addEventListener("click", () =>
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")));
  }

  $("log-save").addEventListener("click", async () => {
    const picked = (wrap, attr) => {
      const on = $(wrap).querySelector('.chip[aria-pressed="true"]');
      return on ? on.dataset[attr] : null;
    };
    const mins = Number(picked("log-delay", "min") ?? 0);
    const flight = picked("log-leg", "flight") ?? "";
    const factors = new Set([...$("log-cond").querySelectorAll('.chip[aria-pressed="true"]')].map((b) => b.dataset.c));
    const note = $("log-note").value.trim();
    if (!mins && !factors.size && !note) delete state.revisions[day];
    else state.revisions[day] = { delay_minutes: mins, flight, factors, note };
    saveRevisions();
    closeSheet("log-sheet");
    await rerun();
  });
  $("log-clear").addEventListener("click", async () => {
    delete state.revisions[day];
    saveRevisions();
    closeSheet("log-sheet");
    await rerun();
  });
  openSheet("log-sheet");
}

function revisionsPayload() {
  return Object.entries(state.revisions).map(([day, r]) => ({
    day_index: Number(day),
    delay_minutes: r.delay_minutes || 0,
    flight: r.flight || null,
    factors: [...(r.factors ?? [])],
    note: r.note || null,
  }));
}
function saveRevisions() {
  try {
    localStorage.setItem(REVISIONS_KEY, JSON.stringify(revisionsPayload()));
  } catch (_) { /* quota or private mode */ }
}
function restoreRevisions() {
  try {
    const raw = JSON.parse(localStorage.getItem(REVISIONS_KEY) ?? "[]");
    state.revisions = {};
    for (const r of raw) {
      state.revisions[r.day_index] = {
        delay_minutes: r.delay_minutes ?? 0, flight: r.flight ?? "",
        factors: new Set(r.factors ?? []), note: r.note ?? "",
      };
    }
  } catch (_) { state.revisions = {}; }
}

async function rerun() {
  if (!state.payload?.transcript) { renderAll(); return; }
  working("Re-running with what you logged");
  try {
    await engineReady;
    const transcript = state.payload.transcript;
    const wasOcr = Boolean(state.payload.ocr);
    state.payload = engine.analyzeText(transcript, {
      carrier: state.carrier, actualSleep: state.sleep, revisions: revisionsPayload(),
      factors: commuteFactors(),
      stationTzOverrides: Object.keys(state.stationTz).length ? state.stationTz : null,
    });
    state.payload.transcript = transcript;
    state.payload.ocr = wasOcr;
    persist();
    renderAll();
  } catch (err) {
    console.error(err);
  } finally { done(); }
}

// ── Import ──────────────────────────────────────────────────────────────────

function moveSegIndicator() {
  const on = $("import-seg").querySelector("button.on");
  const ind = $("seg-ind");
  if (!on || !ind) return;
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
}

function setSource(src) {
  state.source = src;
  for (const b of $("import-seg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.src === src);
  moveSegIndicator();
  $("src-sample").hidden = src !== "sample";
  $("src-shot").hidden = src !== "shot";
  $("src-text").hidden = src !== "text";
  refreshImportButton();
}
for (const b of $("import-seg").querySelectorAll("button")) {
  b.addEventListener("click", () => setSource(b.dataset.src));
}

function refreshImportButton() {
  const ready = (state.source === "shot" && state.file) || (state.source === "text" && $("text").value.trim());
  $("import-run").disabled = !ready;
  $("import-run").hidden = state.source === "sample";
}
$("text").addEventListener("input", refreshImportButton);

$("drop").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) acceptScreenshot(e.target.files[0]);
  e.target.value = "";
});
function acceptScreenshot(file) {
  state.file = file;
  $("drop").classList.add("loaded");
  $("drop-lead").textContent = "✓ Screenshot ready";
  $("drop-note").textContent = `${file.name || "screenshot"} · ${(file.size / 1024).toFixed(0)} KB`;
  refreshImportButton();
}
$("drop").addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("hot"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("hot"));
$("drop").addEventListener("drop", (e) => {
  e.preventDefault(); $("drop").classList.remove("hot");
  if (e.dataTransfer?.files?.[0]) acceptScreenshot(e.dataTransfer.files[0]);
});

/** Chrome fills `files`; Safari puts the image in `items`. Reading one is why paste used to fail. */
function imageFromClipboard(data) {
  if (!data) return null;
  const direct = [...(data.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (direct) return direct;
  for (const item of data.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}
document.addEventListener("paste", (e) => {
  const f = imageFromClipboard(e.clipboardData);
  if (!f) return;                       // plain text paste belongs to whatever has focus
  e.preventDefault();
  setSource("shot");
  acceptScreenshot(f);
});
// iOS Safari never fires `paste` outside an editable field, so a button is the only route there.
if (navigator.clipboard?.read) {
  $("paste-shot").hidden = false;
  $("drop-note").textContent = "Tap to choose · or paste · or drop";
  $("paste-shot").addEventListener("click", async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((x) => x.startsWith("image/"));
        if (!type) continue;
        acceptScreenshot(new File([await item.getType(type)], "pasted-screenshot.png", { type }));
        return;
      }
      $("drop-note").textContent = "No picture on the clipboard — copy your screenshot first.";
    } catch (err) {
      $("drop-note").textContent = "Clipboard blocked — use “Tap to choose” instead.";
    }
  });
}

$("import-run").addEventListener("click", async () => {
  $("import-error").hidden = true;
  try {
    if (state.source === "text") await analyzeTranscript($("text").value, state.carrier);
    else if (state.source === "shot") await analyzeScreenshot(state.file);
    closeSheet("import-sheet");
  } catch (err) {
    $("import-error").textContent = err.message;
    $("import-error").hidden = false;
  } finally { done(); }
});

async function analyzeTranscript(text, carrier, { ocr = false } = {}) {
  if (typeof text !== "string") throw new Error("Nothing readable came back from that screenshot.");
  working("Reading the trip");
  await engineReady;
  if (!engine) throw new Error("The analysis core did not load. Reload the app and try again.");
  const payload = engine.analyzeText(text, {
    carrier, actualSleep: state.sleep, revisions: revisionsPayload(),
    factors: commuteFactors(),
    stationTzOverrides: Object.keys(state.stationTz).length ? state.stationTz : null,
  });
  payload.transcript = text;
  payload.ocr = ocr;
  state.payload = payload;
  state.scope = "trip";
  persist();
  renderAll();
  setTab("trip");
  // A transcript the device read itself deserves a look before the numbers are trusted.
  if (ocr) $("ocr-note").hidden = false;
}

async function analyzeScreenshot(file) {
  working("Reading the screenshot on this device");
  const { transcribeOnDevice } = await import(`./ocr.js?v=${V}`);
  // transcribeOnDevice resolves to { text, confidence } — taking the object whole was a real bug.
  const { text } = await transcribeOnDevice(file, (message, progress) => {
    $("working-text").textContent = progress
      ? `${message} ${Math.round(progress * 100)}%` : message;
  });
  await analyzeTranscript(text, state.carrier, { ocr: true });
}

// ── Samples and carriers ────────────────────────────────────────────────────

async function loadSamples() {
  try {
    const list = await (await fetch(`samples.json?v=${V}`)).json();
    state.samples = Array.isArray(list) ? list : (list.samples ?? []);
  } catch (_) { state.samples = []; }
  $("sample-list").innerHTML = state.samples.map((s, i) => `
    <button class="sample-row" data-i="${i}">
      <div class="t">${esc(s.label)}</div>
      <div class="m">${esc(s.summary ?? "")}</div>
      <div class="d">${esc(s.note ?? "")}</div>
    </button>`).join("");
  for (const b of $("sample-list").querySelectorAll(".sample-row")) {
    b.addEventListener("click", async () => {
      const s = state.samples[Number(b.dataset.i)];
      state.carrier = s.carrier ?? "ups";
      state.revisions = {}; saveRevisions();
      closeSheet("import-sheet");
      try { await analyzeTranscript(s.text, state.carrier); }
      catch (err) { alert(err.message); }
      finally { done(); }
    });
  }
}

function renderCarriers() {
  const list = engine?.CARRIERS ?? [{ id: "ups", name: "UPS", available: true }];
  state.carriers = list;
  $("carriers").innerHTML = list.map((c) => `
    <button class="chip" data-id="${esc(c.id)}" ${c.available ? "" : "disabled"}
      aria-pressed="${state.carrier === c.id}">${esc(c.name)}${c.available ? "" : '<span class="soon">SOON</span>'}</button>`).join("");
  for (const b of $("carriers").querySelectorAll(".chip")) {
    b.addEventListener("click", () => { state.carrier = b.dataset.id; renderCarriers(); });
  }
}

// ── Wearable import ─────────────────────────────────────────────────────────

const VENDORS = [["whoop", "Whoop"], ["oura", "Oura"], ["apple_health", "Apple Health"], ["generic", "Other / CSV"]];
function renderVendors() {
  $("rest-vendors").innerHTML = VENDORS.map(([id, name]) =>
    `<button class="chip" data-v="${id}" aria-pressed="${state.sleepVendor === id}">${esc(name)}</button>`).join("");
  for (const b of $("rest-vendors").querySelectorAll(".chip")) {
    b.addEventListener("click", () => { state.sleepVendor = b.dataset.v; renderVendors(); });
  }
}
$("rest-import").addEventListener("click", () => $("sleep-file").click());
$("sleep-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  $("rest-import-status").textContent = "Reading…";
  try {
    await engineReady;
    const raw = await file.text();
    const parsed = file.name.endsWith(".json") ? JSON.parse(raw) : raw;
    const res = engine.importSleep(parsed, state.sleepVendor);
    state.sleep = res.sleep ?? res.nights ?? res;
    $("rest-import-status").textContent =
      `${Array.isArray(state.sleep) ? state.sleep.length : 0} night(s) imported — re-running.`;
    await rerun();
  } catch (err) {
    $("rest-import-status").textContent = `Could not read that file: ${err.message}`;
  }
});

// ── Persistence, menu, install ─────────────────────────────────────────────

function persist() {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(state.payload)); } catch (_) { /* quota */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw);
    if (!p?.trace?.duty_periods?.length) return false;
    state.payload = p;
    return true;
  } catch (_) { return false; }
}

$("open-menu").addEventListener("click", () => openSheet("menu-sheet"));
$("trip-pill").addEventListener("click", () => openSheet("menu-sheet"));
// The packaged desktop app ships one layout, so the link to the old one would be a dead end.
if (window.triptraceDesktop) {
  document.querySelector('a[href="classic.html"]')?.remove();
}

$("menu-new").addEventListener("click", () => { closeSheet("menu-sheet"); setSource("sample"); openSheet("import-sheet"); requestAnimationFrame(moveSegIndicator); });
$("ocr-open").addEventListener("click", () => { $("menu-transcript").click(); });
$("ocr-dismiss").addEventListener("click", () => { $("ocr-note").hidden = true; });
$("menu-transcript").addEventListener("click", () => {
  closeSheet("menu-sheet");
  $("transcript-text").value = state.payload?.transcript ?? "";
  $("transcript-hint").textContent = state.payload?.ocr
    ? "This was read on the device. Check it against the screenshot, fix anything wrong, and re-analyze."
    : "The table this analysis was built from. Fix a misread digit and re-analyze.";
  openSheet("transcript-sheet");
});
$("transcript-run").addEventListener("click", async () => {
  const text = $("transcript-text").value;
  closeSheet("transcript-sheet");
  try { await analyzeTranscript(text, state.carrier); }
  catch (err) { alert(err.message); }
  finally { done(); }
});
$("menu-about").addEventListener("click", () => { $("about-text").hidden = !$("about-text").hidden; });
$("menu-clear").addEventListener("click", () => {
  state.payload = null; state.revisions = {}; state.sleep = []; state.file = null;
  try { localStorage.removeItem(LAST_KEY); localStorage.removeItem(REVISIONS_KEY); } catch (_) { /* fine */ }
  closeSheet("menu-sheet");
  renderAll();
});
$("empty-add").addEventListener("click", () => { setSource("shot"); openSheet("import-sheet"); requestAnimationFrame(moveSegIndicator); });
$("empty-sample").addEventListener("click", () => { setSource("sample"); openSheet("import-sheet"); requestAnimationFrame(moveSegIndicator); });
$("trace-legend-btn").addEventListener("click", () => {
  $("legend-body").innerHTML = `
    <div class="legend-row"><span class="legend-key" style="background:var(--band-green)"></span>
      <span>The curve is estimated effectiveness. It takes the colour of the band it is in, so a dip
      through a threshold is visible as a colour change, not just a shape.</span></div>
    <div class="legend-row"><span class="legend-key" style="background:var(--duty)"></span>
      <span>Duty periods, report to release. The ticks are leg boundaries.</span></div>
    <div class="legend-row"><span class="legend-key" style="background:var(--sleep)"></span>
      <span>Modeled sleep. The dim bar is the opportunity the layover allows once transport,
      wind-down and pre-report prep come out; the bright bar is sleep the model expects you to get.</span></div>
    <div class="legend-row"><span class="legend-key" style="background:var(--wocl);border:1px solid var(--hair)"></span>
      <span>The window of circadian low, on body-clock time rather than local time. Arrivals inside
      it are the ones worth looking at twice.</span></div>
    <p class="sub small" style="margin-top:14px">Bands: Normal ≥ 90, Monitor 85–90, Elevated 80–85,
      High 75–80, Critical below 75. The line between two plotted points is drawn straight as a
      convention; no number in this app is invented between model outputs.</p>`;
  openSheet("legend-sheet");
});

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
  $("install-tip").hidden = false;
  $("install-tip").innerHTML = `<button class="btn btn-quiet" id="do-install" style="width:100%">Install TripTrace</button>`;
  $("do-install").addEventListener("click", async () => {
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $("install-tip").hidden = true;
  });
});
const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone;
if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  $("install-tip").hidden = false;
  $("install-tip").textContent = "Install it: tap Share, then “Add to Home Screen”. It opens full screen and works without a signal.";
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is optional */ });
}

// ── How the pilot got to base, and stations the table has never seen ───────

function renderCommute() {
  $("commute-chips").innerHTML = COMMUTE_CHOICES.map((c) =>
    `<button class="chip" data-c="${c.id}" aria-pressed="${state.commute === c.id}">${esc(c.label)}</button>`).join("");
  for (const b of $("commute-chips").querySelectorAll(".chip")) {
    b.addEventListener("click", () => {
      state.commute = state.commute === b.dataset.c ? null : b.dataset.c;
      try { localStorage.setItem(COMMUTE_KEY, state.commute ?? ""); } catch (_) { /* fine */ }
      renderCommute();
    });
  }
}

/** The only commute answers that move a number do it as workload, like any other condition. */
const commuteFactors = () => {
  const choice = COMMUTE_CHOICES.find((c) => c.id === state.commute);
  return choice?.factor ? ["Long commute"] : [];
};

/** Stations the parser could not place, read straight out of what it reported. */
function unknownStations() {
  const out = new Set();
  for (const m of trace()?.missing_data ?? []) {
    const hit = /Station ([A-Z0-9]{3,4}) is not in the timezone table/.exec(m.detail ?? "");
    if (hit) out.add(hit[1]);
  }
  return [...out];
}

function renderStationBanner() {
  const unknown = unknownStations();
  $("tz-note").hidden = unknown.length === 0;
  if (!unknown.length) return;
  $("tz-note-text").textContent = unknown.length === 1
    ? `${unknown[0]} is not in the app's table, so its legs have no local clock.`
    : `${unknown.join(", ")} are not in the app's table, so their legs have no local clock.`;
}

function openStationSheet() {
  const unknown = unknownStations();
  $("station-list").innerHTML = unknown.map((code) => `
    <div class="station-row">
      <div class="code">${esc(code)}</div>
      <select data-code="${esc(code)}">
        <option value="">Choose a time zone…</option>
        ${TZ_CHOICES.map(([tz, label]) =>
          `<option value="${esc(tz)}" ${state.stationTz[code] === tz ? "selected" : ""}>${esc(label)} · ${esc(tz)}</option>`).join("")}
      </select>
    </div>`).join("");
  openSheet("station-sheet");
}

$("tz-fix").addEventListener("click", openStationSheet);
$("station-save").addEventListener("click", async () => {
  for (const sel of $("station-list").querySelectorAll("select")) {
    if (sel.value) state.stationTz[sel.dataset.code] = sel.value;
  }
  try { localStorage.setItem(TZ_KEY, JSON.stringify(state.stationTz)); } catch (_) { /* fine */ }
  closeSheet("station-sheet");
  await rerun();
});
$("menu-commute").addEventListener("click", async () => {
  closeSheet("menu-sheet");
  setSource(state.source);
  openSheet("import-sheet");
  requestAnimationFrame(moveSegIndicator);
});

// ── Boot ────────────────────────────────────────────────────────────────────

(async function boot() {
  restoreRevisions();
  try { state.stationTz = JSON.parse(localStorage.getItem(TZ_KEY) ?? "{}"); } catch (_) { state.stationTz = {}; }
  try { state.commute = localStorage.getItem(COMMUTE_KEY) || null; } catch (_) { state.commute = null; }
  renderCommute();
  renderVendors();
  loadSamples();
  await engineReady;
  renderCarriers();
  setSource("sample");
  requestAnimationFrame(moveSegIndicator);
  if (restore()) renderAll();
  else { $("tabbar").hidden = true; setTab("trip"); }
  // A countdown that never moves is worse than no countdown. Only the digits are touched, so the
  // card's entrance animation is not restarted once a second.
  let lastCount = "";
  setInterval(() => {
    if (!state.payload || state.tab !== "now" || !state.countTarget) return;
    const node = $("count-live");
    if (!node) return;
    const next = untilText(Date.now(), state.countTarget);
    if (next === lastCount) return;
    lastCount = next;
    node.textContent = next;
    if (!reduceMotion) { node.classList.remove("tick"); void node.offsetWidth; node.classList.add("tick"); }
  }, 1000);
  setInterval(() => { if (state.payload && state.tab === "now") renderNow(); }, 120000);
})();
