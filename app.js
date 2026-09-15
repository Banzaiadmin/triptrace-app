/*
 * app.js — TripTrace client.
 *
 * Formats and animates; computes nothing itself. Every percentage, band, and sentence on screen
 * comes from one of two places that are proven identical by the differential in CI:
 *
 *   - the on-device core (core/engine.js — parser, scorer, report in JavaScript), used for pasted
 *     text and the sample pairings. No server, no signal needed.
 *   - the Python service (api.py), used for screenshots — the vision call needs the API key — and
 *     as the fallback if the core cannot load.
 *
 * Python is the reference implementation; the core is correct when it reproduces the goldens.
 */

const $ = (id) => document.getElementById(id);
const LAST_KEY = "triptrace.last";
const INSTALL_DISMISSED_KEY = "triptrace.install-dismissed";
// Bump together with ASSET_VERSION in sw.js and the ?v= in index.html.
const V = "29";

// The on-device engine, loaded lazily so a browser that cannot run it still has the service path.
let engine = null;
const engineReady = import("./core/engine.js?v=29")
  .then((module) => { engine = module; })
  .catch((error) => { console.warn("on-device engine unavailable; using the service", error); });

const BANDS = [
  { min: 90, key: "green",  label: "Normal",   css: "--band-green" },
  { min: 85, key: "yellow", label: "Monitor",  css: "--band-yellow" },
  { min: 80, key: "orange", label: "Elevated", css: "--band-orange" },
  { min: 75, key: "red",    label: "High",     css: "--band-red" },
  { min: 0,  key: "purple", label: "Critical", css: "--band-purple" },
];
const BAC_TEXT = {
  green: "Negligible impairment equivalence",
  yellow: "≈ 0.01–0.02 BAC equivalent",
  orange: "≈ 0.03–0.04 BAC equivalent",
  red: "≈ 0.05 BAC equivalent",
  purple: "≈ 0.08+ BAC equivalent",
};
const bandFor = (pct) => BANDS.find((b) => pct >= b.min) || BANDS[BANDS.length - 1];
const bandColor = (pct) =>
  getComputedStyle(document.documentElement).getPropertyValue(bandFor(pct).css).trim();

const FACTORS = ["Weather", "MEL / swap", "Sort delay", "ATC delays", "Reduced rest",
                 "Hotel disruption", "Long commute", "Extended duty"];
const RESCHED = ["Duty extended toward soft max", "Rest reduced", "Report moved earlier",
                 "Extra leg added", "Revised after trip start"];
const VENDOR_LABELS = { whoop: "Whoop", oura: "Oura", apple_health: "Apple Health", generic: "Other / CSV" };

const REVISIONS_KEY = "triptrace.revisions";
const DELAY_CHOICES = [["On time", 0], ["+15", 15], ["+30", 30], ["+60", 60], ["+120", 120]];
// Only promise "paste" where a paste can actually be received — see the clipboard button below.
const DROP_NOTE = navigator.clipboard?.read
  ? "Tap to choose · or paste · or drop"
  : "Tap to choose · or drop";

const state = {
  carrier: "ups",
  file: null,
  transcript: "",
  sleep: [],
  sleepVendor: null,
  factors: new Set(),
  resched: new Set(),
  revisions: {},                    // day_index -> { delay_minutes, flight, factors: Set, note }
  payload: null,
  serviceTranscription: false,      // does the service have a vision key configured?
  readOnDevice: false,              // pilot chose the on-device reader over the service
  installPrompt: null,              // Android/desktop Chrome's deferred install prompt
};

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ── Formatting ──────────────────────────────────────────────────────────────

const hm = (h) => (h === undefined || h === null ? "—"
  : `${Math.floor(Math.round(h * 60) / 60)}:${String(Math.round(h * 60) % 60).padStart(2, "0")}`);
const zulu = (iso) => (iso ? `${iso.slice(11, 16)}Z` : "—");
const localOf = (clock) => (clock?.station_local ? clock.station_local.slice(11, 16) : null);
const dayLabel = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined,
  { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── Views ───────────────────────────────────────────────────────────────────

function show(name) {
  for (const v of ["input", "working", "error", "report"]) $(`view-${v}`).hidden = v !== name;
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}
function fail(message) { $("error-text").textContent = message; show("error"); }

// ── Chips ───────────────────────────────────────────────────────────────────

function renderChips(container, items, isOn, onClick) {
  container.innerHTML = "";
  for (const item of items) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.innerHTML = item.html ?? esc(item.label);
    chip.setAttribute("aria-pressed", String(isOn(item)));
    chip.disabled = item.disabled === true;
    chip.addEventListener("click", () => { onClick(item); });
    container.appendChild(chip);
  }
}

function renderCarriers(carriers) {
  renderChips($("carriers"),
    carriers.map((c) => ({
      ...c,
      disabled: !c.available,
      html: esc(c.name) + (c.available ? "" : '<span class="soon">SOON</span>'),
    })),
    (c) => state.carrier === c.id,
    (c) => { state.carrier = c.id; renderCarriers(carriers); },
  );
}

function renderToggle(container, values, set) {
  renderChips(container, values.map((v) => ({ label: v })),
    (v) => set.has(v.label),
    (v) => { set.has(v.label) ? set.delete(v.label) : set.add(v.label); renderToggle(container, values, set); });
}

// ── Ring ────────────────────────────────────────────────────────────────────

function drawRing(pct) {
  const R = 84, CIRC = 2 * Math.PI * R;
  const fill = Math.max(0, Math.min(1, (pct - 60) / 40));
  const color = bandColor(pct);
  const info = bandFor(pct);

  $("ring").innerHTML = `
    <svg width="208" height="208" viewBox="0 0 208 208" aria-hidden="true">
      <circle cx="104" cy="104" r="${R}" fill="none" stroke="var(--hair)" stroke-width="14"/>
      <circle id="ring-arc" cx="104" cy="104" r="${R}" fill="none" stroke="${color}"
        stroke-width="14" stroke-linecap="round" stroke-dasharray="${CIRC}"
        stroke-dashoffset="${reduceMotion ? CIRC * (1 - fill) : CIRC}"
        style="transition:${reduceMotion ? "none" : "stroke-dashoffset 1.4s cubic-bezier(.22,1,.36,1)"}"/>
    </svg>
    <div class="center">
      <div class="pct" id="ring-num">${reduceMotion ? Math.round(pct) : 0}<span>%</span></div>
      <div class="label" style="color:${color}">${info.label}</div>
    </div>`;

  if (reduceMotion) return;
  requestAnimationFrame(() => { $("ring-arc").style.strokeDashoffset = String(CIRC * (1 - fill)); });

  const start = performance.now(), duration = 1400, node = $("ring-num");
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    node.innerHTML = `${Math.round(pct * (1 - Math.pow(1 - p, 3)))}<span>%</span>`;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Per-duty sparkline: report → lowest point → release. */
function traceSvg(startPct, lowPct, endPct) {
  const y = (p) => 52 - ((Math.max(60, Math.min(100, p ?? 85)) - 60) / 40) * 44;
  const pts = [[6, y(startPct)], [130, y(lowPct)], [254, y(endPct)]];
  const color = bandColor(lowPct);
  return `<svg class="trace" viewBox="0 0 260 60" aria-hidden="true">
    ${[90, 80, 70].map((g) => `<line x1="6" x2="254" y1="${y(g)}" y2="${y(g)}"
        stroke="var(--hair)" stroke-width="1"/>`).join("")}
    <polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}"
      stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map(([x, yy], i) => `<circle cx="${x}" cy="${yy}" r="4"
        fill="${i === 1 ? color : "#FFF"}" stroke="${i === 1 ? "#FFF" : color}" stroke-width="2"/>`).join("")}
  </svg>`;
}

// ── Report rendering ────────────────────────────────────────────────────────

function render(payload, { keepScroll = false } = {}) {
  state.payload = payload;
  const { trace, report } = payload;
  const outputs = trace.outputs || {};
  const min = outputs.trip_min_effectiveness_pct;
  const scrollY = window.scrollY;

  if (payload.transcript) state.transcript = payload.transcript;
  $("transcript").value = state.transcript;
  $("json").textContent = JSON.stringify(trace, null, 2);

  $("report-eyebrow").textContent =
    `Pairing ${trace.pairing.pairing_id} · lowest estimated effectiveness`;

  if (typeof min === "number") {
    drawRing(min);
    $("min-where").textContent = outputs.risk_label || "";
    $("min-bac").textContent = BAC_TEXT[bandFor(min).key];
    $("bac-callout").hidden = min >= 85;
    $("bac-callout").textContent =
      "0.04 BAC is the FAR 91.17 limit for flying. This estimate reaches a comparable impairment level.";
  } else {
    $("ring").innerHTML = "";
    $("min-where").textContent = "Not scored";
    $("min-bac").textContent = payload.scoring_error || "";
    $("bac-callout").hidden = true;
  }

  $("narrative").textContent = report?.narrative || "";
  $("duties").innerHTML = (trace.duty_periods || []).map(dutyBlock).join("");

  $("recs").innerHTML = (report?.recommendations || [])
    .map((r) => `<li><span class="dot"></span><span>${esc(r)}</span></li>`).join("");
  $("watch").innerHTML = (report?.watch || []).map((w) => `<li>${esc(w)}</li>`).join("");
  $("watch-card").hidden = !(report?.watch || []).length;

  $("gaps").innerHTML = (trace.missing_data || []).map(gapRow).join("")
    || '<p class="sub small" style="margin:0">Nothing flagged.</p>';

  $("engine-note").textContent = payload.engine === "device"
    ? "— analyzed on this device" : "— analyzed by the TripTrace service";

  // A transcript that came from the on-device reader deserves a look before the numbers are
  // trusted; open it and say so. A vision-model or pasted transcript stays folded.
  $("transcript-panel").open = Boolean(payload.ocr);
  $("transcript-hint").textContent = payload.ocr
    ? "— read on this device: check it against the screen, fix anything, re-run"
    : "— fix a misread digit and re-run";

  const conf = trace.outputs?.transparency?.reminder || "";
  $("disclaimer").textContent = conf;
  $("safety-text").textContent = report?.safety_report || "";

  try { localStorage.setItem(LAST_KEY, JSON.stringify(payload)); } catch (_) { /* quota */ }
  if (keepScroll) {
    // A re-run from the log must not throw the pilot back to the top of the report.
    for (const v of ["input", "working", "error", "report"]) $(`view-${v}`).hidden = v !== "report";
    window.scrollTo({ top: scrollY, behavior: "auto" });
  } else {
    show("report");
  }
}

function dutyBlock(duty) {
  const e = duty.effectiveness;
  const color = e ? bandColor(e.min_pct) : "var(--sub)";
  const route = `${duty.legs[0].dep_station}–${duty.legs[duty.legs.length - 1].arr_station}`;
  const reportLocal = localOf(duty.report), releaseLocal = localOf(duty.release);
  const actualDuty = duty.scheduled_duty?.actual_hours;
  const log = state.revisions[duty.day_index] || { delay_minutes: 0, flight: null, factors: new Set(), note: "" };
  const cc = e && e.combined_capacity !== null && e.combined_capacity !== undefined ? e.combined_capacity : null;

  return `
    <div class="duty" data-day="${duty.day_index}">
      <div class="duty-head">
        <div class="name">D${duty.day_index} · ${esc(route)}
          <span class="sub small" style="font-weight:400">${dayLabel(duty.date_local)}</span>
        </div>
        <div class="duty-pills">
          ${cc !== null ? `<div class="duty-pill cc" title="Combined capacity: effectiveness, reservoir and workload averaged">CC ${cc}%</div>` : ""}
          ${e ? `<div class="duty-pill" style="background:${color}1A;color:${color}">${e.min_pct}%</div>` : ""}
        </div>
      </div>
      ${e ? traceSvg(e.start_pct, e.min_pct, e.end_pct) : ""}
      <div class="when">
        ${zulu(duty.report.utc)}${reportLocal ? ` (${reportLocal}L)` : ""}
        → ${zulu(duty.release.utc)}${releaseLocal ? ` (${releaseLocal}L)` : ""}
        · ${hm(actualDuty ?? duty.scheduled_duty?.scheduled_hours)} duty${actualDuty !== undefined && actualDuty !== null ? " (actual)" : ""}
        · ${duty.landings ?? 0} landing${duty.landings === 1 ? "" : "s"}
        ${duty.layover_after ? `· ${hm(duty.layover_after.length_hours)} at ${duty.layover_after.station}` : "· trip ends"}
        ${duty.layover_after?.at_or_near_floor
          ? '<span class="tag alert" style="margin-left:6px">at/near floor</span>' : ""}
      </div>
      ${e ? `<div class="when" style="margin-top:2px">Lowest near ${esc(e.min_location || "")}</div>` : ""}
      ${duty.layover_after?.extension_exposure ? `<div class="logged">${esc(duty.layover_after.extension_exposure)}</div>` : ""}
      ${logBlock(duty, log)}
    </div>`;
}

/** The real-time log for one duty period: a delay (moves the timeline) and conditions (workload). */
function logBlock(duty, log) {
  const legs = duty.legs.map((l) => ({ flight: l.flight, label: `${l.flight} ${l.dep_station}–${l.arr_station}` }));
  const summary = [];
  if (log.delay_minutes) summary.push(`${log.delay_minutes} min late${log.flight ? ` from ${log.flight}` : ""}`);
  if (log.factors.size) summary.push([...log.factors].join(", "));
  const conditions = engine ? engine.CONDITIONS : FACTORS;
  return `
    <details class="log" data-day="${duty.day_index}" ${summary.length ? "open" : ""}>
      <summary>Log what happened${summary.length ? ` <span class="log-state">· ${esc(summary.join(" · "))}</span>` : ""}</summary>
      <div class="log-body">
        <div class="lbl">Delay</div>
        <div class="log-row">
          <div class="chips delay-chips">${DELAY_CHOICES.map(([label, minutes]) =>
            `<button type="button" class="chip" data-delay="${minutes}" aria-pressed="${log.delay_minutes === minutes}">${label}</button>`).join("")}</div>
          <input type="number" class="delay-min" min="0" step="5" value="${log.delay_minutes || ""}" placeholder="min" aria-label="Delay in minutes">
        </div>
        <div class="log-row" style="margin-top:8px">
          <span class="sub small">from</span>
          <select class="from-leg" aria-label="Leg the delay starts at">
            <option value="">first leg</option>
            ${legs.map((l) => `<option value="${esc(l.flight)}" ${log.flight === l.flight ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
          </select>
        </div>
        <div class="lbl">Conditions</div>
        <div class="chips cond-chips">${conditions.map((c) =>
          `<button type="button" class="chip" data-cond="${esc(c)}" aria-pressed="${log.factors.has(c)}">${esc(c)}</button>`).join("")}</div>
        <input class="log-note" value="${esc(log.note || "")}" placeholder="Note — “hold into CAE, MEL on the APU”">
      </div>
    </details>`;
}

function logFor(day) {
  return state.revisions[day] || (state.revisions[day] = { delay_minutes: 0, flight: null, factors: new Set(), note: "" });
}

function revisionsPayload() {
  return Object.entries(state.revisions)
    .map(([day, log]) => ({
      day_index: Number(day),
      delay_minutes: log.delay_minutes || 0,
      flight: log.flight || null,
      factors: [...log.factors],
      note: log.note || null,
    }))
    .filter((r) => r.delay_minutes || r.factors.length);
}

function saveRevisions() {
  try {
    localStorage.setItem(REVISIONS_KEY, JSON.stringify(revisionsPayload()));
  } catch (_) { /* fine */ }
}

function restoreRevisions() {
  try {
    const saved = JSON.parse(localStorage.getItem(REVISIONS_KEY) || "[]");
    for (const r of saved) {
      state.revisions[r.day_index] = {
        delay_minutes: r.delay_minutes || 0, flight: r.flight || null,
        factors: new Set(r.factors || []), note: r.note || "",
      };
    }
  } catch (_) { /* ignore */ }
}

// Every change re-runs the analysis from the transcript — instant on the device — so the ring,
// the traces, the layovers, and the safety report all reflect the trip as it actually stands.
let rerunTimer = null;
function rerun() {
  saveRevisions();
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(() => { state.file = null; analyze({ keepScroll: true }); }, 250);
}

$("duties").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const day = Number(chip.closest("details.log")?.dataset.day);
  if (!day) return;
  const log = logFor(day);
  if (chip.dataset.delay !== undefined) {
    log.delay_minutes = Number(chip.dataset.delay);
  } else if (chip.dataset.cond !== undefined) {
    if (log.factors.has(chip.dataset.cond)) log.factors.delete(chip.dataset.cond);
    else log.factors.add(chip.dataset.cond);
  } else return;
  rerun();
});
$("duties").addEventListener("change", (e) => {
  const details = e.target.closest("details.log");
  if (!details) return;
  const log = logFor(Number(details.dataset.day));
  if (e.target.classList.contains("delay-min")) log.delay_minutes = Math.max(0, Math.trunc(Number(e.target.value) || 0));
  else if (e.target.classList.contains("from-leg")) log.flight = e.target.value || null;
  else if (e.target.classList.contains("log-note")) { log.note = e.target.value; saveRevisions(); return; }
  else return;
  rerun();
});

function gapRow(item) {
  const severe = item.kind === "time_conflict" || item.kind === "cut_off";
  const label = { time_conflict: "Time conflict", cut_off: "Cut off", ambiguous: "Ambiguous",
    unknown_actual: "No actuals", no_commute_info: "No commute", no_hotel_info: "No hotel info" };
  return `<div class="gap-item">
      <span class="tag ${severe ? "alert" : ""}">${label[item.kind] || item.kind}</span>
      ${esc(item.detail)}
      ${item.would_change ? `<span class="would">Would change: ${esc(item.would_change)}</span>` : ""}
    </div>`;
}

// ── Network ─────────────────────────────────────────────────────────────────

const STEPS = [
  ["Reading schedule…", 0],
  ["Converting Zulu to local · building duty periods", 900],
  ["Modeling sleep and the circadian timeline…", 2100],
  ["Writing your report…", 3400],
];
let stepTimers = [];

async function analyze({ keepScroll = false } = {}) {
  const common = {
    carrier: state.carrier,
    factors: [...state.factors],
    rescheduled: [...state.resched],
    actual_sleep: state.sleep,
    revisions: revisionsPayload(),
  };

  // Text goes through the on-device core: instant, and it works with no signal.
  if (!state.file) {
    await engineReady;
    if (engine) {
      try {
        render(engine.analyzeText(state.transcript, {
          carrier: state.carrier,
          actualSleep: state.sleep,
          factors: [...state.factors],
          rescheduled: [...state.resched],
          revisions: common.revisions,
        }), { keepScroll });
        return;
      } catch (err) {
        if (err instanceof engine.EngineError) { fail(err.message); return; }
        // Anything else is a defect in the core, not in the schedule. Log it and let the service
        // — the reference implementation — have a go rather than dead-ending the pilot.
        console.error("on-device analysis failed; falling back to the service", err);
      }
    }
  }

  // A screenshot with no service key behind it — or the pilot's choice — is read on the device.
  if (state.file && (state.readOnDevice || !state.serviceTranscription)) {
    await analyzeScreenshotOnDevice();
    return;
  }

  show("working");
  stepTimers.forEach(clearTimeout);
  stepTimers = STEPS.map(([msg, at]) => setTimeout(() => { $("progress").textContent = msg; }, at));

  try {
    let response;
    if (state.file) {
      const form = new FormData();
      form.append("image", state.file, state.file.name || "screenshot.png");
      form.append("carrier", state.carrier);
      form.append("actual_sleep", JSON.stringify(state.sleep));
      form.append("factors", JSON.stringify([...state.factors]));
      form.append("rescheduled", JSON.stringify([...state.resched]));
      form.append("revisions", JSON.stringify(common.revisions));
      response = await fetch("/api/analyze-image", { method: "POST", body: form });
    } else {
      response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...common, text: state.transcript }),
      });
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { fail(body.detail || `Server returned ${response.status}.`); return; }
    render({ ...body, engine: "service" }, { keepScroll });
  } catch (err) {
    fail(navigator.onLine
      ? `Could not reach the TripTrace service: ${err.message}`
      : "You're offline. Reading a screenshot needs a connection — paste the table as text " +
        "and the report runs right here on your device.");
  } finally {
    stepTimers.forEach(clearTimeout);
  }
}

/**
 * Screenshot → transcript on the device (Tesseract), then the same on-device analysis as pasted
 * text. No key, no account, no server. Raw OCR misreads more than a vision model, which is why
 * the report opens with the transcript expanded and asks for a check.
 */
async function analyzeScreenshotOnDevice() {
  show("working");
  stepTimers.forEach(clearTimeout);
  $("progress").textContent = "Loading the on-device reader…";
  try {
    const { transcribeOnDevice } = await import(`./ocr.js?v=${V}`);
    const { text } = await transcribeOnDevice(state.file, (message, progress) => {
      $("progress").textContent = progress ? `${message} ${Math.round(progress * 100)}%` : message;
    });
    await engineReady;
    if (!engine) throw new Error("the on-device analysis core did not load");
    state.transcript = text;
    $("text").value = text;
    const payload = engine.analyzeText(text, {
      carrier: state.carrier,
      actualSleep: state.sleep,
      factors: [...state.factors],
      rescheduled: [...state.resched],
    });
    render({ ...payload, ocr: true });
  } catch (err) {
    if (engine && err instanceof engine.EngineError) {
      fail(`${err.message} The on-device reader may have misread the table — open "Paste the table as text instead" and paste or correct it.`);
      return;
    }
    fail(`Could not read the screenshot on this device: ${err.message}. Paste the table as text instead — that path always works.`);
  }
}

async function importSleep(file) {
  try {
    let body = null;

    // On the device first: the normalizers are part of the core and need no service.
    await engineReady;
    if (engine) {
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch (err) {
        fail(`That file isn't valid JSON: ${err.message}`);
        return;
      }
      try {
        body = engine.importSleep(payload);
      } catch (err) {
        if (err instanceof engine.EngineError) { fail(err.message); return; }
        console.error("on-device sleep import failed; falling back to the service", err);
      }
    }

    if (!body) {
      const form = new FormData();
      form.append("file", file, file.name || "sleep.json");
      const response = await fetch("/api/sleep/import", { method: "POST", body: form });
      body = await response.json();
      if (!response.ok) { fail(body.detail || "Could not read that sleep file."); return; }
    }

    state.sleep = body.sessions.map((s) => ({
      start_utc: s.start_utc, end_utc: s.end_utc, efficiency: s.efficiency, type: s.type,
    }));
    state.sleepVendor = body.vendor;

    $("sleep-drop").classList.add("loaded");
    $("sleep-lead").textContent =
      `✓ ${body.sessions.length} sleep period${body.sessions.length === 1 ? "" : "s"} from ${VENDOR_LABELS[body.vendor] || body.vendor}`;
    $("sleep-note").textContent = `${body.total_hours} h recorded · matched to layovers when you run the report`;

    const list = $("sleep-summary");
    list.hidden = false;
    list.innerHTML = body.sessions.slice(0, 6).map((s) => `
      <div class="session">
        <span>${s.start_utc.slice(0, 10)} · ${zulu(s.start_utc)}–${zulu(s.end_utc)}</span>
        <span class="len">${s.hours} h</span>
      </div>`).join("");
  } catch (err) {
    fail(`Could not import sleep data: ${err.message}`);
  }
}

// ── Input wiring ────────────────────────────────────────────────────────────

function refreshRunButton() {
  const ready = Boolean(state.file || $("text").value.trim());
  $("run").disabled = !ready;
  $("run-hint").hidden = ready;
}

$("drop").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) acceptScreenshot(file);
  e.target.value = "";
});

function acceptScreenshot(file) {
  state.file = file;
  $("drop").classList.add("loaded");
  $("drop-lead").textContent = "✓ Screenshot ready";
  $("drop-note").textContent = `${file.name || "screenshot"} · ${(file.size / 1024).toFixed(0)} KB`;
  refreshRunButton();
}

$("sleep-drop").addEventListener("click", () => $("sleep-file").click());
$("sleep-file").addEventListener("change", (e) => {
  if (e.target.files[0]) importSleep(e.target.files[0]);
  e.target.value = "";
});

$("text").addEventListener("input", () => {
  state.transcript = $("text").value;
  if (state.transcript.trim()) {
    state.file = null;
    $("drop").classList.remove("loaded");
    $("drop-lead").textContent = "Add Trip Board screenshot";
    $("drop-note").textContent = DROP_NOTE;
  }
  refreshRunButton();
});

$("run").addEventListener("click", analyze);
$("error-back").addEventListener("click", () => show("input"));
$("restart").addEventListener("click", () => {
  state.file = null; state.transcript = ""; $("text").value = "";
  state.revisions = {};
  try { localStorage.removeItem(REVISIONS_KEY); } catch (_) { /* fine */ }
  $("drop").classList.remove("loaded");
  $("drop-lead").textContent = "Add Trip Board screenshot";
  $("drop-note").textContent = DROP_NOTE;
  refreshRunButton();
  show("input");
});
$("reparse").addEventListener("click", () => {
  state.transcript = $("transcript").value;
  state.file = null;
  analyze();
});

/**
 * Pull an image out of a clipboard payload.
 *
 * Two shapes have to be handled: `files`, which is what Chrome fills in, and `items`, which is
 * where Safari puts a copied image and where a screenshot sometimes lands even in Chrome. Reading
 * only `files` is why pasting a screenshot silently did nothing for some pilots.
 */
function imageFromClipboard(data) {
  if (!data) return null;
  const direct = [...(data.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (direct) return direct;
  for (const item of data.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

document.addEventListener("paste", (e) => {
  // An image on the clipboard is a screenshot no matter where the caret is: pasting a picture
  // into the transcript box used to be swallowed in silence. Text still pastes wherever focus is.
  const file = imageFromClipboard(e.clipboardData);
  if (!file) return;
  e.preventDefault();
  acceptScreenshot(file);
});

// iOS Safari only fires `paste` into an editable field, so the keyboard/long-press route above
// can never run on a phone. navigator.clipboard.read() is the one that does, and it needs a real
// tap plus the platform's own permission prompt — hence a button rather than an automatic read.
$("drop-note").textContent = DROP_NOTE;
if (navigator.clipboard?.read) {
  $("paste-shot").hidden = false;
  $("paste-shot").addEventListener("click", async () => {
    const note = $("drop-note");
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        acceptScreenshot(new File([blob], "pasted-screenshot.png", { type }));
        return;
      }
      note.textContent = "No picture on the clipboard — copy your Trip Board screenshot first.";
    } catch (err) {
      // Denied permission, an empty clipboard, or a browser that refuses outside a user gesture.
      note.textContent = err.name === "NotAllowedError"
        ? "Clipboard access was blocked — use “Tap to choose” and pick the screenshot instead."
        : "Could not read the clipboard — use “Tap to choose” and pick the screenshot instead.";
    }
  });
}

for (const [zone, handler] of [["drop", acceptScreenshot], ["sleep-drop", importSleep]]) {
  const el = $(zone);
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("hot"); });
  el.addEventListener("dragleave", () => el.classList.remove("hot"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); el.classList.remove("hot");
    const file = e.dataTransfer?.files?.[0];
    if (file) handler(file);
  });
}

// ── Sheets ──────────────────────────────────────────────────────────────────

$("help-open").addEventListener("click", () => { $("help-sheet").hidden = false; });
$("safety-open").addEventListener("click", () => {
  $("copy-status").textContent = "";
  $("safety-sheet").hidden = false;
});

// ── Safety summary ──────────────────────────────────────────────────────────

let summaryModule = null;
async function currentSummary() {
  summaryModule = summaryModule || await import("./core/summary.js?v=29");
  return summaryModule.summaryModel(state.payload, {
    factors: [...state.factors],
    rescheduled: [...state.resched],
  });
}

function renderSummary(model) {
  const bandVar = (band) => `var(--band-${band || "green"})`;
  const chip = (pct, band) => (pct === null || pct === undefined ? "—"
    : `<span class="pchip" style="background:${bandVar(band)}22;color:${bandVar(band)}">${pct}%</span>`);
  const tiles = model.tiles.map((t) => `
    <div class="tile ${t.alert ? "alert" : ""}">
      <div class="tv" ${t.band ? `style="color:${bandVar(t.band)}"` : ""}>${esc(t.value)}</div>
      <div class="tl">${esc(t.label)}</div>
    </div>`).join("");
  const facts = model.facts.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  // data-l carries each cell's column name so the narrow-screen rules can stack a row into a
  // labelled card. Below ~560px the eight duty columns cannot share a line without pushing the
  // effectiveness numbers — the whole point of the table — off the right edge.
  // Every cell's value is wrapped in one .v span and the column name rides along in data-l.
  // Below ~560px the stacked rules turn each cell into "LABEL … value": the label is the td's
  // ::before and .v is the only other child, so a <br> inside a value still breaks the line
  // instead of being split into a second column.
  const cell = (attrs, html) => `<td ${attrs}><span class="v">${html}</span></td>`;
  const duties = model.duties.map((d) => `
    <tr>
      ${cell('class="num rowhead" data-l="Day"', `<b>D${d.day}</b><br><span class="sub">${esc(d.date)}</span>`)}
      ${cell('data-l="Sequence"', `${esc(d.sequence)}${d.deadheads ? `<br><span class="sub">${d.deadheads} deadhead${d.deadheads === 1 ? "" : "s"}</span>` : ""}`)}
      ${cell('class="num" data-l="Report → release"', `${esc(d.report)}<br>→ ${esc(d.release)}`)}
      ${cell('class="num" data-l="Duty"', `${d.actualDuty ? `<span class="short">${esc(d.actualDuty)}</span>` : esc(d.duty)}<br><span class="sub">${d.landings} ldg</span>`)}
      ${cell('class="num" data-l="Start"', chip(d.startPct, d.startBand))}
      ${cell('class="num" data-l="Low"', `${chip(d.minPct, d.band)}${d.combined !== null ? `<br><span class="sub">CC ${d.combined}%</span>` : ""}`)}
      ${cell('class="num" data-l="End"', chip(d.endPct, d.endBand))}
      ${cell('class="sub" data-l="Where · then"', `${esc(d.minWhere)}${d.minAt ? ` · ${esc(d.minAt)}` : ""}<br>then ${esc(d.layover)}`)}
    </tr>`).join("");
  const sleep = model.sleep.map((s) => `
    <tr>
      ${cell('class="num rowhead" data-l="After"', `<b>D${s.afterDay}</b>`)}
      ${cell('data-l="Station"', esc(s.station))}
      ${cell('class="num" data-l="Layover"', esc(s.layover))}
      ${cell('class="num" data-l="Opportunity"', esc(s.opportunity))}
      ${cell(`class="num ${s.short ? "short" : ""}" data-l="Effective"`, esc(s.effective))}
      ${cell('class="sub" data-l="Modeled blocks"', s.blocks.map(esc).join("<br>") || "none modeled")}
    </tr>`).join("");
  const h = model.headline;
  const t = model.today;
  const r = model.riskiest;
  const rec = model.recovery;

  $("summary-doc").innerHTML = `
    <div class="masthead">
      <div class="wordmark"><span class="a">TRIP</span><span class="b">TRACE</span></div>
      <div class="eyebrow">Safety risk summary${h && h.updated ? " — updated" : ""}</div>
    </div>
    <h1>${esc(model.title)}</h1>
    <div class="meta">${esc(model.subtitle)}</div>
    <div class="meta">${esc(model.prepared)}</div>

    <div class="tiles">${tiles}</div>

    ${model.logged.length ? `
      <div class="box event">
        <h3>Operational events logged</h3>
        ${model.logged.map((l) => `<p><b>Day ${l.day}:</b> ${esc(l.text)}${l.note ? ` — <span class="sub">${esc(l.note)}</span>` : ""}</p>`).join("")}
        <p class="notes">Delays are applied to the timeline (legs, release, and the layover that follows). Conditions are workload in the Combined Capacity figure and do not alter the effectiveness estimate.</p>
      </div>` : ""}

    ${h ? `
      <div class="box assess" style="border-left-color:${bandVar(h.band)}">
        <h3>${h.updated ? "Updated current" : "Current"} safety assessment</h3>
        <div class="big">Trip minimum effectiveness: ${Math.round(h.minPct)}% <span style="color:${bandVar(h.band)}">${esc(h.bandLabel)}</span></div>
        <p>At ${esc(h.where)}${h.at ? ` (${esc(h.at)})` : ""}. ${esc(h.bac[0].toUpperCase() + h.bac.slice(1))}.
          ${h.fatigueCallIndicated ? "A fatigue call is professionally defensible at this level." : "Above the fatigue-call threshold."}</p>
      </div>` : ""}

    <h2>Duty-by-duty effectiveness</h2>
    <div class="table-scroll"><table>
      <thead><tr><th>Day</th><th>Sequence</th><th>Report → release (local)</th><th>Duty</th><th>Start</th><th>Low</th><th>End</th><th>Where · then</th></tr></thead>
      <tbody>${duties}</tbody>
    </table></div>
    <p class="notes" style="margin-top:8px">Report and release are solved from the printed Duty and L/O columns. Bands: Normal ≥ 90, Monitor 85–90, Elevated 80–85, High 75–80, Critical &lt; 75. A red duty length is the logged actual.</p>

    <div class="panels">
      <div class="box today">
        <h3>${t.phase === "complete" ? "Trip complete" : t.phase === "in progress" ? `Today — D${t.day} in progress` : `Next up — D${t.day}`}</h3>
        ${t.phase === "complete" ? `<p class="sub">Every duty period has been released. The panels below describe the trip as flown.</p>` : `
          ${t.pickup ? `<div class="kv"><span>Hotel pickup</span><span>${esc(t.pickup)}</span></div>` : ""}
          <div class="kv"><span>Report</span><span>${esc(t.report)} at ${esc(t.reportStation)}</span></div>
          ${t.legs.map((l) => `<div class="kv"><span>Leg</span><span>${esc(l)}</span></div>`).join("")}
          <div class="kv"><span>Release</span><span>${esc(t.release)}</span></div>
          <div class="kv"><span>Duty length</span><span>${esc(t.duty)}${t.actual ? " (actual)" : ""}</span></div>
          <div class="kv"><span>Lowest</span><span>${esc(t.lowest)}</span></div>
          <div class="kv"><span>Then</span><span>${esc(t.layoverAfter)}${t.recoveryTo ? ` → recovery to ${t.recoveryTo}` : ""}</span></div>`}
      </div>
      ${r ? `
      <div class="box risky" style="border-left-color:${bandVar(r.band)}">
        <h3>${r.remaining ? "Most risky remaining duty" : "Most risky duty"} — D${r.day} ${esc(r.route)}</h3>
        <div class="big">${r.minPct}% <span style="color:${bandVar(r.band)}">${esc(r.bandLabel)}</span></div>
        <ul>${r.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
      </div>` : ""}
    </div>

    ${rec ? `
      <div class="box recover">
        <h3>Recovery — ${esc(rec.station)} layover after D${rec.afterDay} (${esc(rec.layover)})</h3>
        <div class="kv"><span>Sleep opportunity</span><span>${esc(rec.opportunityHours)} · ${esc(rec.window)}</span></div>
        <div class="kv"><span>Modeled effective</span><span class="${rec.short ? "short" : ""}">${esc(rec.effective)}</span></div>
        ${rec.blocks.map((b) => `<div class="kv"><span>Block</span><span>${esc(b)}</span></div>`).join("")}
        <ul>${model.recommendations.slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>` : ""}

    <h2>Trip facts</h2>
    <div class="facts">${facts}</div>
    ${model.revised ? `<p class="revised">Schedule revision: ${esc(model.revised)}</p>` : ""}
    ${model.factors.length ? `<p class="sub small" style="margin-top:8px">Conditions across the trip (counted as workload): ${esc(model.factors.join(", "))}</p>` : ""}

    <h2>How this trip is built</h2>
    <p>${esc(model.narrative)}</p>

    ${model.sleep.length ? `
      <h2>Sleep by layover</h2>
      <div class="table-scroll"><table>
        <thead><tr><th>After</th><th>Station</th><th>Layover</th><th>Opportunity</th><th>Effective</th><th>Modeled blocks</th></tr></thead>
        <tbody>${sleep}</tbody>
      </table></div>` : ""}

    ${model.crossings.length ? `
      <h2>Threshold crossings</h2>
      ${model.crossings.map((c) => `
        <p><b>Duty day ${c.day} — ${esc(c.bandLabel)}.</b> ${esc(c.trigger)}<br>
        <span class="sub">Worse if: ${esc(c.worseIf)}</span><br>
        <span class="sub">${esc(c.contractNote)}</span></p>`).join("")}` : ""}

    <h2>What helps</h2>
    <ul>${model.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>

    <h2>Worth knowing</h2>
    <ul>${model.watch.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>

    <h2>What the model cannot see</h2>
    <p class="sub small">Every item here would change the result. It is part of the output, not a footnote to it.</p>
    ${model.gaps.map((g) => `<div class="gap ${g.severe ? "severe" : ""}"><b>${esc(g.label)}.</b> ${esc(g.detail)}${g.wouldChange ? ` <span class="sub">Would change: ${esc(g.wouldChange)}</span>` : ""}</div>`).join("")}

    ${model.assessment ? `<h2>Assessment</h2><p>${esc(model.assessment).replace(/\n/g, "<br>")}</p>` : ""}
    ${model.statement ? `<h2>Statement</h2><p>${esc(model.statement).replace(/\n/g, "<br>")}</p>` : ""}
`;
}

async function summaryFile() {
  const [{ summaryPdf }, model] = await Promise.all([import(`./pdf.js?v=${V}`), currentSummary()]);
  const bytes = summaryPdf(model);
  const id = (state.payload?.trace?.pairing?.pairing_id || "trip").replace(/[^A-Za-z0-9]/g, "");
  return new File([bytes], `TripTrace-${id}-safety-summary.pdf`, { type: "application/pdf" });
}

$("summary-open").addEventListener("click", async () => {
  if (!state.payload) return;
  $("summary-status").textContent = "";
  try {
    renderSummary(await currentSummary());
  } catch (err) {
    $("summary-doc").innerHTML = `<p class="sub">Could not build the summary: ${esc(err.message)}</p>`;
  }
  // The share sheet is the natural home for a PDF on a phone; a download link is the desktop way.
  const probe = new File([new Uint8Array([37, 80, 68, 70])], "probe.pdf", { type: "application/pdf" });
  const canShareFiles = Boolean(navigator.canShare && navigator.canShare({ files: [probe] }));
  $("summary-share").textContent = canShareFiles ? "Share PDF" : "Download PDF";
  $("summary-sheet").hidden = false;
});

$("summary-share").addEventListener("click", async () => {
  const status = $("summary-status");
  status.textContent = "Building the PDF…";
  try {
    const file = await summaryFile();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      status.textContent = "Shared.";
      return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    status.textContent = `Saved ${file.name}.`;
  } catch (err) {
    status.textContent = err.name === "AbortError" ? "" : `Could not share the PDF: ${err.message}. Use “Print or save as PDF” instead.`;
  }
});

$("summary-print").addEventListener("click", () => {
  $("summary-status").textContent = "";
  window.print();
});

$("summary-copy").addEventListener("click", async () => {
  summaryModule = summaryModule || await import("./core/summary.js?v=29");
  copyText(summaryModule.summaryText(await currentSummary()), $("summary-status"), "Copied as text.");
});
for (const sheet of document.querySelectorAll(".sheet-bg")) {
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.hidden = true; });
}
for (const btn of document.querySelectorAll("[data-close]")) {
  btn.addEventListener("click", () => { $(btn.dataset.close).hidden = true; });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".sheet-bg").forEach((s) => { s.hidden = true; });
});

async function copyText(text, statusNode, doneLabel) {
  let ok = false;
  // navigator.clipboard needs a secure context; testing over http:// on a LAN IP isn't one.
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (_) { /* fall through */ }
  if (!ok) {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(scratch);
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    scratch.remove();
  }
  statusNode.textContent = ok ? doneLabel : "Copy isn't available here — select the text and copy manually.";
}

$("copy-safety").addEventListener("click", () =>
  copyText($("safety-text").textContent, $("copy-status"), "Copied — paste it anywhere you need it."));
$("copy-json").addEventListener("click", (e) => {
  copyText(JSON.stringify(state.payload?.trace ?? {}, null, 2), { set textContent(v) {
    e.target.textContent = v === "Copied" ? "Copied" : e.target.textContent;
  } }, "Copied");
  e.target.textContent = "Copied";
  setTimeout(() => { e.target.textContent = "Copy to clipboard"; }, 1600);
});

// ── Startup ─────────────────────────────────────────────────────────────────

renderToggle($("factors"), FACTORS, state.factors);
renderToggle($("resched"), RESCHED, state.resched);

$("legend").innerHTML = BANDS.map((b) => `
  <div class="legend">
    <span class="swatch" style="background:var(${b.css})"></span>
    <span class="nm">${b.label}</span>
    <span class="ds">${BAC_TEXT[b.key]}</span>
  </div>`).join("");

// Sample pairings — real trips, already verified by the test suite. They exist so a demo never
// depends on the one step that can fail for reasons outside the code: the vision call. The static
// copy is generated from samples/ and ships with the app, so they load with no service at all.
fetch(`samples.json?v=${V}`)
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .catch(() => fetch("/api/samples").then((r) => r.json()))
  .then((samples) => {
  if (!samples.length) return;
  $("samples-block").hidden = false;
  $("samples").innerHTML = samples.map((s, i) => `
    <button class="sample" type="button" data-sample="${i}">
      <div class="nm">${esc(s.label)}</div>
      <div class="sm">${esc(s.summary)}</div>
      <div class="nt">${esc(s.note)}</div>
    </button>`).join("");

  for (const button of $("samples").querySelectorAll("[data-sample]")) {
    button.addEventListener("click", () => {
      const sample = samples[Number(button.dataset.sample)];
      state.file = null;
      state.transcript = sample.text;
      $("text").value = sample.text;
      refreshRunButton();
      analyze();
    });
  }
}).catch(() => { /* samples are a convenience, never a dependency */ });

fetch("/api/health").then((r) => r.json()).then((health) => {
  renderCarriers(health.carriers);
  renderChips($("vendors"),
    health.wearable_vendors.map((v) => ({ label: VENDOR_LABELS[v] || v, id: v })),
    () => false, () => $("sleep-file").click());
  state.serviceTranscription = Boolean(health.transcription_available);
  if (state.serviceTranscription) {
    $("ocr-toggle").hidden = false;
  } else {
    $("schedule-hint").textContent =
      "Screenshots are read on this device (beta) — no key is configured on the service. Check the " +
      "transcript afterwards, or paste the table as text.";
  }
}).catch(async () => {
  // No service reachable. The on-device core still runs pasted text, the samples, and sleep import
  // in full; say plainly what needs the service rather than letting a tap fail later.
  await engineReady;
  renderCarriers(engine ? engine.CARRIERS : [{ id: "ups", name: "UPS", available: true }]);
  state.serviceTranscription = false;
  $("schedule-hint").textContent =
    "The TripTrace service isn't reachable, so screenshots are read on this device (beta) — check " +
    "the transcript afterwards, or paste the table as text. Samples and pasted text run here too.";
  if (engine) {
    renderChips($("vendors"),
      engine.WEARABLE_VENDORS.map((v) => ({ label: VENDOR_LABELS[v] || v, id: v })),
      () => false, () => $("sleep-file").click());
  } else {
    $("sleep-drop").disabled = true;
    $("sleep-note").textContent = "Sleep import needs the TripTrace service — not reachable right now.";
  }
});

restoreRevisions();
try {
  const saved = localStorage.getItem(LAST_KEY);
  if (saved) { render(JSON.parse(saved)); show("input"); }
} catch (_) { /* ignore a corrupt entry */ }

refreshRunButton();

$("read-on-device").addEventListener("change", (e) => { state.readOnDevice = e.target.checked; });

// ── Install ─────────────────────────────────────────────────────────────────
// The app is installed from the browser, not a store: Android and desktop Chrome raise an install
// prompt we can trigger; iOS Safari has no prompt, only Share → Add to Home Screen, so we say so.

const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let installDismissed = false;
try { installDismissed = localStorage.getItem(INSTALL_DISMISSED_KEY) === "1"; } catch (_) { /* fine */ }

function offerInstall(how, canPrompt) {
  if (isStandalone || installDismissed) return;
  $("install-how").textContent = how;
  $("install-go").hidden = !canPrompt;
  $("install").hidden = false;
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installPrompt = e;
  offerInstall("It opens full-screen from your home screen and works without a signal.", true);
});
if (isIOS && !isStandalone) {
  offerInstall("In Safari, tap Share, then “Add to Home Screen”. It opens full-screen and works without a signal.", false);
}
$("install-go").addEventListener("click", async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  const { outcome } = await state.installPrompt.userChoice;
  state.installPrompt = null;
  if (outcome === "accepted") $("install").hidden = true;
});
$("install-dismiss").addEventListener("click", () => {
  $("install").hidden = true;
  try { localStorage.setItem(INSTALL_DISMISSED_KEY, "1"); } catch (_) { /* fine */ }
});
window.addEventListener("appinstalled", () => { $("install").hidden = true; });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
