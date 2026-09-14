/**
 * summary.js — the content of a Trip Safety Summary, as data.
 *
 * One model, two renderers: the printable page in the app and the PDF writer both draw from what
 * this returns, so the document a pilot hands to a chief pilot and the page they read on the phone
 * cannot disagree. Everything here is lifted from a scored TripTrace and its report; nothing is
 * computed, and nothing is written for tone. A figure that is not in the trace is not in the
 * summary.
 *
 * The shape follows the owner's reference document: the numbers that matter in a row of tiles,
 * what changed (logged events), the current assessment, every duty day with start/low/end, then
 * "where you are right now" — today's duty reconstructed, the riskiest duty still ahead, and the
 * recovery window before it. That last part depends on the clock, so `context.now` is an input.
 */

import {
  BAND_LABELS, EFFECTIVENESS_BANDS, HOTEL_PICKUP_HOURS, REPORT_ALLOWANCE_HOURS, STATIONS,
} from "./constants.js";
import { hmFromHours } from "./py.js";
import { fmtLocal, parseUtc } from "./tz.js";

const BAC_TEXT = {
  green: "negligible impairment equivalence",
  yellow: "about 0.01–0.02 BAC equivalent",
  orange: "about 0.03–0.04 BAC equivalent",
  red: "about 0.05 BAC equivalent",
  purple: "0.08+ BAC equivalent",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR = 3_600_000;

const zulu = (iso) => (iso ? `${iso.slice(11, 16)}Z` : "—");
const local = (clock) => (clock && clock.station_local ? clock.station_local.slice(11, 16) : null);
const clockText = (clock) => {
  if (!clock) return "—";
  const l = local(clock);
  return l ? `${l}L (${zulu(clock.utc)})` : zulu(clock.utc);
};
const dateText = (isoDate) => {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const stampText = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
};
const fmt1 = (n) => (n === null || n === undefined ? "—" : (Math.round(n * 10) / 10).toFixed(1));
const bandOf = (pct) => (EFFECTIVENESS_BANDS.find((b) => b.low <= pct && pct < b.high) ??
  EFFECTIVENESS_BANDS[EFFECTIVENESS_BANDS.length - 1]).band;
const stationTz = (code) => (STATIONS[code] ? STATIONS[code][0] : null);

/**
 * Hotel pickup for a duty that starts away from domicile: pickup is HOTEL_PICKUP_HOURS before
 * departure and show is REPORT_ALLOWANCE_HOURS before it, so pickup precedes report by the
 * difference (owner-confirmed: 30 minutes, domestic and international). Null at domicile.
 */
function hotelPickup(duty, domicile) {
  const first = (duty.legs ?? [])[0];
  if (!first || first.dep_station === domicile) return null;
  const kind = first.is_international ? "international" : "domestic";
  const before = HOTEL_PICKUP_HOURS[kind] - REPORT_ALLOWANCE_HOURS[`${kind}_away`];
  const ms = parseUtc(duty.report.utc) - before * HOUR;
  const tz = stationTz(first.dep_station);
  const localText = tz ? `${fmtLocal(tz, ms).slice(11, 16)}L` : null;
  const z = zulu(new Date(ms).toISOString().slice(0, 19) + "Z");
  return localText ? `${localText} (${z})` : z;
}

/**
 * "Sun 18:33 – Mon 23:30 local (01:33Z–06:30Z, 29.0 h)" style window at a station. The day names
 * matter: a long layover's sleep window crosses a calendar day, and clock times alone would read
 * as a few hours instead of more than a day.
 */
function localWindow(startIso, endIso, station) {
  if (!startIso || !endIso) return null;
  const tz = stationTz(station);
  const s = parseUtc(startIso);
  const e = parseUtc(endIso);
  const stamp = (ms) => {
    const localIso = tz ? fmtLocal(tz, ms) : new Date(ms).toISOString().slice(0, 19);
    const day = DAYS[new Date(`${localIso}Z`).getUTCDay()];
    return `${day} ${localIso.slice(11, 16)}`;
  };
  const hours = fmt1((e - s) / HOUR);
  return {
    local: `${stamp(s)} – ${stamp(e)} ${tz ? "local" : "Z"}`,
    zulu: `${zulu(startIso)}–${zulu(endIso)}, ${hours} h`,
    hours,
  };
}

const KIND_LABELS = {
  time_conflict: "Time conflict",
  cut_off: "Cut off",
  ambiguous: "Ambiguous",
  unknown_actual: "No actuals",
  no_commute_info: "No commute info",
  no_hotel_info: "No hotel info",
};

const SLEEP_LABELS = {
  pre_trip: "pre-trip night",
  pre_duty_nap: "pre-duty nap",
  hotel_core: "hotel core",
  anchor: "anchor sleep",
  bunk: "bunk",
  nap: "nap",
  split_block: "split block",
};

/**
 * @param {object} payload the analysis result (trace + report + inputs) the app holds
 * @param {{factors?: string[], rescheduled?: string[], now?: number}} [context]
 */
export function summaryModel(payload, context = {}) {
  const trace = payload.trace ?? {};
  const report = payload.report ?? {};
  const outputs = trace.outputs ?? {};
  const pairing = trace.pairing ?? {};
  const meta = trace.meta ?? {};
  const duties = trace.duty_periods ?? [];
  const rests = trace.rest_periods ?? [];
  const factors = context.factors ?? [];
  const rescheduled = context.rescheduled ?? [];
  const now = context.now ?? Date.now();

  const minPct = outputs.trip_min_effectiveness_pct;
  const worstDuty = duties.find((d) => d.day_index === outputs.riskiest_duty_day);
  const band = worstDuty && worstDuty.effectiveness ? worstDuty.effectiveness.band : null;
  const delayed = duties.filter((d) => (d.scheduled_duty ?? {}).actual_hours !== undefined && (d.scheduled_duty ?? {}).actual_hours !== null);
  const totalActualDuty = duties.reduce((sum, d) => {
    const s = d.scheduled_duty ?? {};
    return sum + (s.actual_hours ?? s.scheduled_hours ?? 0);
  }, 0);

  const headline = typeof minPct === "number" ? {
    minPct,
    band,
    bandLabel: BAND_LABELS[band] ?? "—",
    where: outputs.risk_label ?? "",
    at: outputs.trip_min_at_utc ? zulu(outputs.trip_min_at_utc) : "",
    bac: BAC_TEXT[band] ?? "",
    fatigueCallIndicated: minPct < 80,
    updated: delayed.length > 0,
  } : null;

  // The numbers that matter, as tiles. Actual duty appears only once something was logged.
  const tiles = [
    { label: "TAFB", value: hmFromHours(pairing.tafb_hours ?? null) },
    { label: "Sched block", value: hmFromHours(pairing.total_block_hours ?? null) },
    { label: delayed.length ? "Duty (actual)" : "Sched duty", value: hmFromHours(totalActualDuty || (pairing.total_duty_hours ?? null)), alert: delayed.length > 0 },
    { label: "Landings", value: String(pairing.landings_count ?? "—") },
    { label: "Trip minimum", value: typeof minPct === "number" ? `${Math.round(minPct)}%` : "—", band },
  ];

  const facts = [
    ["Pairing", `${pairing.pairing_id ?? "—"}${meta.operator ? ` · ${meta.operator}` : ""}`],
    ["Domicile / fleet", `${meta.domicile ?? "—"} · ${meta.fleet ?? "—"}`],
    ["Duty periods", String(pairing.duty_days ?? duties.length)],
    ["Legs / landings", `${pairing.legs_count ?? "—"} / ${pairing.landings_count ?? "—"}`],
    ["Block", hmFromHours(pairing.total_block_hours ?? null)],
    ["Time away from base", hmFromHours(pairing.tafb_hours ?? null)],
    ["Time zones crossed", pairing.timezones_crossed === undefined ? "—" : `${pairing.timezones_crossed} h of offset`],
    ["Sleep basis", meta.pilot_reported_actuals ? "Measured sleep data applied" : "Modeled from the schedule only"],
  ];

  const dutyRows = duties.map((d) => {
    const e = d.effectiveness ?? null;
    const legs = d.legs ?? [];
    const route = legs.length ? `${legs[0].dep_station}–${legs[legs.length - 1].arr_station}` : "—";
    const sequence = legs.map((l, i) => (i === 0 ? `${l.dep_station}-${l.arr_station}` : l.arr_station)).join("-");
    const flownLegs = legs.filter((l) => !(l.raw ?? {}).deadhead).length;
    const layover = d.layover_after;
    const actual = (d.scheduled_duty ?? {}).actual_hours;
    return {
      day: d.day_index,
      date: dateText(d.date_local),
      route,
      sequence,
      legs: legs.length,
      deadheads: legs.length - flownLegs,
      report: clockText(d.report),
      release: clockText(d.release),
      duty: hmFromHours((d.scheduled_duty ?? {}).scheduled_hours ?? null),
      actualDuty: actual !== undefined && actual !== null ? hmFromHours(actual) : null,
      landings: d.landings ?? 0,
      minPct: e ? e.min_pct : null,
      band: e ? e.band : null,
      bandLabel: e ? BAND_LABELS[e.band] ?? "" : "",
      startPct: e ? e.start_pct : null,
      startBand: e ? bandOf(e.start_pct) : null,
      endPct: e ? e.end_pct : null,
      endBand: e ? bandOf(e.end_pct) : null,
      minWhere: e ? e.min_location : "",
      minAt: e ? zulu(e.min_at_utc) : "",
      combined: e && e.combined_capacity !== null && e.combined_capacity !== undefined ? e.combined_capacity : null,
      workload: e && e.workload_norm !== null && e.workload_norm !== undefined ? e.workload_norm : null,
      layover: layover
        ? `${hmFromHours(layover.length_hours)} at ${layover.station}${layover.at_or_near_floor ? " (at/near floor)" : ""}`
        : "trip ends",
      confidence: d.confidence ?? "",
    };
  });

  const sleepRows = rests.map((r) => {
    const events = r.sleep_events ?? [];
    return {
      afterDay: r.after_duty_day,
      station: r.station ?? "—",
      layover: hmFromHours(r.layover_length_hours ?? null),
      opportunity: hmFromHours(r.sleep_opportunity_hours ?? null),
      effective: r.total_effective_sleep_hours === undefined ? "—" : `${fmt1(r.total_effective_sleep_hours)} h`,
      short: (r.total_effective_sleep_hours ?? 99) < 6.5,
      measured: events.some((e) => e.source === "actual"),
      blocks: events.map((e) =>
        `${SLEEP_LABELS[e.type] ?? e.type} ${fmt1(e.window_hours)} h @ ${Math.round((e.efficiency ?? 0) * 100)}%${e.source === "actual" ? " (measured)" : ""}`),
    };
  });

  const crossings = (outputs.threshold_crossings ?? []).map((c) => ({
    day: c.duty_day,
    band: c.band,
    bandLabel: BAND_LABELS[c.band] ?? "",
    trigger: c.trigger ?? "",
    worseIf: c.worse_if ?? "",
    contractNote: c.contract_note ?? "",
  }));

  // What was logged as the trip unfolded: delays (already in the timeline above) and conditions.
  const logged = (report.revisions ?? []).map((r) => {
    const bits = [];
    if (r.delay_minutes) {
      bits.push(`${r.delay_minutes} min late from ${r.from_flight || "the first leg"}` +
        (r.layover_after_station ? `; ${r.layover_after_station} layover cut to ${hmFromHours(r.layover_after_hours ?? null)}` : ""));
    }
    if (r.factors && r.factors.length) bits.push(`conditions: ${r.factors.join(", ")}`);
    return { day: r.day_index, text: bits.join(" · "), note: r.note || "", delay: r.delay_minutes || 0 };
  }).filter((r) => r.text);

  const gaps = (trace.missing_data ?? []).map((m) => ({
    kind: m.kind,
    label: KIND_LABELS[m.kind] ?? m.kind,
    severe: m.kind === "time_conflict" || m.kind === "cut_off",
    detail: m.detail,
    wouldChange: m.would_change ?? "",
  }));

  // ── Where you are right now ────────────────────────────────────────────────
  // Today's duty is the one in progress, else the next one to report; after the last release the
  // trip is complete and the panels describe the trip as a whole.
  const timeline = duties.map((d) => ({ d, report: parseUtc(d.report.utc), release: parseUtc(d.release.utc) }));
  let current = timeline.find((t) => t.report <= now && now <= t.release) ?? null;
  let phase = current ? "in progress" : null;
  if (!current) {
    current = timeline.find((t) => t.report > now) ?? null;
    phase = current ? "next" : "complete";
  }
  const today = current ? {
    phase,
    day: current.d.day_index,
    date: dateText(current.d.date_local),
    report: clockText(current.d.report),
    reportStation: current.d.legs?.[0]?.dep_station ?? "",
    pickup: hotelPickup(current.d, meta.domicile),
    legs: (current.d.legs ?? []).map((l) => `${l.flight} ${l.dep_station}–${l.arr_station} ${clockText(l.dep)} → ${clockText(l.arr)}${(l.raw ?? {}).deadhead ? " (deadhead)" : ""}`),
    release: clockText(current.d.release),
    duty: hmFromHours((current.d.scheduled_duty ?? {}).actual_hours ?? (current.d.scheduled_duty ?? {}).scheduled_hours ?? null),
    actual: (current.d.scheduled_duty ?? {}).actual_hours !== undefined && (current.d.scheduled_duty ?? {}).actual_hours !== null,
    lowest: current.d.effectiveness ? `${current.d.effectiveness.min_pct}% (${BAND_LABELS[current.d.effectiveness.band] ?? ""}) near ${current.d.effectiveness.min_location}` : "—",
    layoverAfter: current.d.layover_after
      ? `${hmFromHours(current.d.layover_after.length_hours)} at ${current.d.layover_after.station}` : "trip ends",
    recoveryTo: current.d.layover_after ? `D${current.d.day_index + 1}` : null,
  } : { phase: "complete" };

  // The riskiest duty still ahead (or the riskiest of the trip once it is over).
  const ahead = timeline.filter((t) => t.release > now && t.d.effectiveness);
  const pool = ahead.length ? ahead : timeline.filter((t) => t.d.effectiveness);
  const riskiestT = pool.length ? pool.reduce((best, t) => (t.d.effectiveness.min_pct < best.d.effectiveness.min_pct ? t : best)) : null;
  let riskiest = null;
  if (riskiestT) {
    const d = riskiestT.d;
    const e = d.effectiveness;
    const legs = d.legs ?? [];
    const wocl = (d.circadian ?? {}).wocl_window ?? {};
    const inWocl = wocl.start_utc && wocl.end_utc
      ? legs.filter((l) => !(l.raw ?? {}).deadhead && parseUtc(l.arr.utc) >= parseUtc(wocl.start_utc) && parseUtc(l.arr.utc) <= parseUtc(wocl.end_utc)).length
      : 0;
    const restBefore = rests.find((r) => r.after_duty_day === d.day_index - 1);
    const bodyReport = d.report.body_clock ? d.report.body_clock.slice(11, 16) : null;
    const pickup = hotelPickup(d, meta.domicile);
    riskiest = {
      day: d.day_index,
      remaining: ahead.length > 0,
      route: legs.length ? `${legs[0].dep_station}–${legs[legs.length - 1].arr_station}` : "",
      minPct: e.min_pct,
      band: e.band,
      bandLabel: BAND_LABELS[e.band] ?? "",
      bullets: [
        `${pickup ? `Hotel pickup ${pickup}, report` : "Report"} ${clockText(d.report)} at ${legs[0]?.dep_station ?? "—"}${bodyReport ? `, body clock ${bodyReport}` : ""}.`,
        `Lowest point ${e.min_pct}% near ${e.min_location} at ${zulu(e.min_at_utc)}${BAC_TEXT[e.band] ? ` — ${BAC_TEXT[e.band]}` : ""}.`,
        inWocl ? `${inWocl} landing${inWocl === 1 ? "" : "s"} inside the window of circadian low.` : "No landing inside the window of circadian low.",
        `${d.landings ?? 0} landing${(d.landings ?? 0) === 1 ? "" : "s"} over ${hmFromHours((d.scheduled_duty ?? {}).actual_hours ?? (d.scheduled_duty ?? {}).scheduled_hours ?? null)} of duty.`,
        restBefore
          ? `Sleep opportunity before it: ${hmFromHours(restBefore.sleep_opportunity_hours ?? null)} at ${restBefore.station}, modeled ${fmt1(restBefore.total_effective_sleep_hours)} h effective${(restBefore.sleep_events ?? []).some((s) => s.source === "actual") ? " (measured)" : ""}.`
          : "First duty of the trip: rest before it is the pre-trip night at home.",
      ],
    };
  }

  // The recovery window that matters most: the layover before the riskiest duty ahead, else the
  // next layover after today's duty.
  let recovery = null;
  const recoveryRest = riskiest && riskiest.remaining
    ? rests.find((r) => r.after_duty_day === riskiest.day - 1)
    : (today.day ? rests.find((r) => r.after_duty_day === today.day) : null);
  if (recoveryRest) {
    const w = recoveryRest.sleep_opportunity_window ?? {};
    const window = localWindow(w.start_utc, w.end_utc, recoveryRest.station);
    const blocks = (recoveryRest.sleep_events ?? []).map((ev) => {
      const lw = localWindow(ev.window?.start_utc, ev.window?.end_utc, recoveryRest.station);
      return `${SLEEP_LABELS[ev.type] ?? ev.type}: ${lw ? lw.local : "—"} (${fmt1(ev.window_hours)} h @ ${Math.round((ev.efficiency ?? 0) * 100)}%)${ev.source === "actual" ? " — measured" : ""}`;
    });
    recovery = {
      station: recoveryRest.station,
      afterDay: recoveryRest.after_duty_day,
      layover: hmFromHours(recoveryRest.layover_length_hours ?? null),
      window: window ? `${window.local} (${window.zulu})` : "—",
      opportunityHours: hmFromHours(recoveryRest.sleep_opportunity_hours ?? null),
      effective: recoveryRest.total_effective_sleep_hours === undefined ? "—" : `${fmt1(recoveryRest.total_effective_sleep_hours)} h`,
      blocks,
      short: (recoveryRest.total_effective_sleep_hours ?? 99) < 6.5,
    };
  }

  // The assessment paragraph from the safety report — the one place the conclusion is stated.
  const safety = report.safety_report ?? "";
  const assessment = sectionOf(safety, "4. ASSESSMENT", "5. STATEMENT");
  const statement = sectionOf(safety, "5. STATEMENT", "6. LIMITATIONS");

  const firstDate = duties[0]?.date_local;
  const lastDate = duties[duties.length - 1]?.date_local;
  return {
    title: `Trip ${pairing.pairing_id ?? ""} — Safety Summary${delayed.length ? " (updated)" : ""}`.trim(),
    subtitle: [meta.operator, meta.domicile && `${meta.domicile} ${meta.fleet ?? ""}`.trim(),
      firstDate && lastDate ? `${dateText(firstDate)} – ${dateText(lastDate)}` : null,
      `${pairing.duty_days ?? duties.length} duty periods`, `TAFB ${hmFromHours(pairing.tafb_hours ?? null)}`]
      .filter(Boolean).join(" · "),
    prepared: `Prepared ${stampText(now)} by TripTrace · Decision support, not validated software`,
    revised: rescheduled.length ? rescheduled.join("; ") : "",
    factors,
    logged,
    tiles,
    headline,
    facts,
    narrative: report.narrative ?? "",
    duties: dutyRows,
    sleep: sleepRows,
    crossings,
    today,
    riskiest,
    recovery,
    recommendations: report.recommendations ?? [],
    watch: report.watch ?? [],
    gaps,
    assessment,
    statement,
    // No model-notes block. The owner asked (2026-09-14) that the summary not disclose the model
    // at the bottom, and that the Statement stay. The document keeps every caveat that protects
    // the pilot — "not validated software" rides in `prepared`, the gaps section still says what
    // the analysis cannot see, and the Statement is untouched — it just no longer prints the
    // sleep-efficiency constants, the circadian drift, or which engine ran it. Do not re-add.
  };
}

function sectionOf(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const end = text.indexOf(endMarker, start);
  return text.slice(start + startMarker.length, end < 0 ? undefined : end).trim();
}

/** Plain-text rendering, for copy/paste and as the accessible fallback. */
export function summaryText(model) {
  const lines = [model.title.toUpperCase(), model.subtitle, model.prepared, ""];
  lines.push(model.tiles.map((t) => `${t.label} ${t.value}`).join(" | "), "");
  if (model.headline) {
    lines.push(`LOWEST ESTIMATED EFFECTIVENESS: ${model.headline.minPct}% — ${model.headline.bandLabel} band`);
    lines.push(`At ${model.headline.where}${model.headline.at ? ` (${model.headline.at})` : ""}; ${model.headline.bac}.`);
    lines.push("");
  }
  if (model.logged.length) {
    lines.push("OPERATIONAL EVENTS LOGGED");
    for (const l of model.logged) lines.push(`  Day ${l.day}: ${l.text}${l.note ? ` — ${l.note}` : ""}`);
    lines.push("");
  }
  lines.push("TRIP FACTS");
  for (const [k, v] of model.facts) lines.push(`  ${k}: ${v}`);
  if (model.revised) lines.push(`  Schedule revision: ${model.revised}`);
  if (model.factors.length) lines.push(`  Conditions across the trip: ${model.factors.join(", ")}`);
  lines.push("", "HOW THIS TRIP IS BUILT", model.narrative, "", "BY DUTY PERIOD");
  for (const d of model.duties) {
    lines.push(`  D${d.day} ${d.date} · ${d.sequence} · report ${d.report} → release ${d.release} · duty ${d.actualDuty ?? d.duty}${d.actualDuty ? " (actual)" : ""} · ${d.landings} landing(s)`);
    lines.push(`     start ${d.startPct ?? "—"}% · low ${d.minPct ?? "—"}% (${d.bandLabel}) near ${d.minWhere}${d.minAt ? ` at ${d.minAt}` : ""} · end ${d.endPct ?? "—"}%` +
      `${d.combined !== null ? ` · combined capacity ${d.combined}% (workload ${d.workload}/100)` : ""} · then ${d.layover}`);
  }
  if (model.today.phase !== "complete") {
    lines.push("", `${model.today.phase === "in progress" ? "TODAY — IN PROGRESS" : "NEXT UP"} — D${model.today.day} ${model.today.date}`);
    if (model.today.pickup) lines.push(`  Hotel pickup ${model.today.pickup}`);
    lines.push(`  Report ${model.today.report} at ${model.today.reportStation}`);
    for (const l of model.today.legs) lines.push(`  ${l}`);
    lines.push(`  Release ${model.today.release} · duty ${model.today.duty}${model.today.actual ? " (actual)" : ""} · lowest ${model.today.lowest} · then ${model.today.layoverAfter}`);
  } else {
    lines.push("", "TRIP COMPLETE");
  }
  if (model.riskiest) {
    lines.push("", `${model.riskiest.remaining ? "MOST RISKY REMAINING DUTY" : "MOST RISKY DUTY"} — D${model.riskiest.day} ${model.riskiest.route} · ${model.riskiest.minPct}% (${model.riskiest.bandLabel})`);
    for (const b of model.riskiest.bullets) lines.push(`  • ${b}`);
  }
  if (model.recovery) {
    lines.push("", `RECOVERY — ${model.recovery.station} layover after D${model.recovery.afterDay} (${model.recovery.layover})`);
    lines.push(`  Sleep opportunity ${model.recovery.opportunityHours}: ${model.recovery.window}; modeled effective ${model.recovery.effective}`);
    for (const b of model.recovery.blocks) lines.push(`  ${b}`);
  }
  lines.push("", "SLEEP BY LAYOVER");
  for (const s of model.sleep) {
    lines.push(`  After D${s.afterDay} at ${s.station}: layover ${s.layover}, opportunity ${s.opportunity}, effective ${s.effective}${s.short ? " (short)" : ""}`);
    for (const b of s.blocks) lines.push(`     ${b}`);
  }
  if (model.crossings.length) {
    lines.push("", "THRESHOLD CROSSINGS");
    for (const c of model.crossings) lines.push(`  D${c.day} (${c.bandLabel}): ${c.trigger} ${c.contractNote}`);
  }
  lines.push("", "WHAT HELPS");
  for (const r of model.recommendations) lines.push(`  • ${r}`);
  lines.push("", "WORTH KNOWING");
  for (const w of model.watch) lines.push(`  • ${w}`);
  lines.push("", "WHAT THE MODEL CANNOT SEE");
  for (const g of model.gaps) lines.push(`  [${g.label}] ${g.detail}${g.wouldChange ? ` Would change: ${g.wouldChange}` : ""}`);
  if (model.assessment) lines.push("", "ASSESSMENT", model.assessment);
  if (model.statement) lines.push("", "STATEMENT", model.statement);
  return lines.join("\n");
}
