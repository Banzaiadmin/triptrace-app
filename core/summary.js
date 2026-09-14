/**
 * summary.js — the content of a Trip Fatigue Summary, as data.
 *
 * One model, two renderers: the printable page in the app and the PDF writer both draw from what
 * this returns, so the document a pilot hands to a chief pilot and the page they read on the phone
 * cannot disagree. Everything here is lifted from a scored TripTrace and its report; nothing is
 * computed, and nothing is written for tone. A figure that is not in the trace is not in the
 * summary.
 */

import { BAND_LABELS } from "./constants.js";
import { hmFromHours } from "./py.js";

const BAC_TEXT = {
  green: "negligible impairment equivalence",
  yellow: "about 0.01–0.02 BAC equivalent",
  orange: "about 0.03–0.04 BAC equivalent",
  red: "about 0.05 BAC equivalent",
  purple: "0.08+ BAC equivalent",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  const minPct = outputs.trip_min_effectiveness_pct;
  const worstDuty = duties.find((d) => d.day_index === outputs.riskiest_duty_day);
  const band = worstDuty && worstDuty.effectiveness ? worstDuty.effectiveness.band : null;

  const headline = typeof minPct === "number" ? {
    minPct,
    band,
    bandLabel: BAND_LABELS[band] ?? "—",
    where: outputs.risk_label ?? "",
    at: outputs.trip_min_at_utc ? zulu(outputs.trip_min_at_utc) : "",
    bac: BAC_TEXT[band] ?? "",
    fatigueCallIndicated: minPct < 80,
  } : null;

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
    const flownLegs = legs.filter((l) => !(l.raw ?? {}).deadhead).length;
    const layover = d.layover_after;
    return {
      day: d.day_index,
      date: dateText(d.date_local),
      route,
      legs: legs.length,
      deadheads: legs.length - flownLegs,
      report: clockText(d.report),
      release: clockText(d.release),
      duty: hmFromHours((d.scheduled_duty ?? {}).scheduled_hours ?? null),
      landings: d.landings ?? 0,
      minPct: e ? e.min_pct : null,
      band: e ? e.band : null,
      bandLabel: e ? BAND_LABELS[e.band] ?? "" : "",
      startPct: e ? e.start_pct : null,
      endPct: e ? e.end_pct : null,
      minWhere: e ? e.min_location : "",
      minAt: e ? zulu(e.min_at_utc) : "",
      combined: e && e.combined_capacity !== null && e.combined_capacity !== undefined ? e.combined_capacity : null,
      workload: e && e.workload_norm !== null && e.workload_norm !== undefined ? e.workload_norm : null,
      actualDuty: (d.scheduled_duty ?? {}).actual_hours !== undefined && (d.scheduled_duty ?? {}).actual_hours !== null
        ? hmFromHours(d.scheduled_duty.actual_hours) : null,
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
    return { day: r.day_index, text: bits.join(" · "), note: r.note || "" };
  }).filter((r) => r.text);

  const gaps = (trace.missing_data ?? []).map((m) => ({
    kind: m.kind,
    label: KIND_LABELS[m.kind] ?? m.kind,
    severe: m.kind === "time_conflict" || m.kind === "cut_off",
    detail: m.detail,
    wouldChange: m.would_change ?? "",
  }));

  // The assessment paragraph from the safety report — the one place the conclusion is stated.
  const safety = report.safety_report ?? "";
  const assessment = sectionOf(safety, "4. ASSESSMENT", "5. STATEMENT");
  const statement = sectionOf(safety, "5. STATEMENT", "6. LIMITATIONS");

  return {
    title: `Trip ${pairing.pairing_id ?? ""} — Fatigue Summary`.trim(),
    subtitle: [meta.operator, meta.domicile && `${meta.domicile} ${meta.fleet ?? ""}`.trim(),
      `${pairing.duty_days ?? duties.length} duty periods`, `TAFB ${hmFromHours(pairing.tafb_hours ?? null)}`]
      .filter(Boolean).join(" · "),
    prepared: `Prepared ${stampText(context.now ?? Date.now())} by TripTrace · SAFTE-style approximation, not validated software`,
    revised: rescheduled.length ? rescheduled.join("; ") : "",
    factors,
    logged,
    headline,
    facts,
    narrative: report.narrative ?? "",
    duties: dutyRows,
    sleep: sleepRows,
    crossings,
    recommendations: report.recommendations ?? [],
    watch: report.watch ?? [],
    gaps,
    assessment,
    statement,
    reminder: (outputs.transparency ?? {}).reminder ?? "",
    modelAssumptions: (outputs.transparency ?? {}).sleep_assumptions ?? "",
    circadian: (outputs.transparency ?? {}).circadian_anchors ?? "",
    engine: payload.engine === "device" ? "Analyzed on this device" : "Analyzed by the TripTrace service",
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
  if (model.headline) {
    lines.push(`LOWEST ESTIMATED EFFECTIVENESS: ${model.headline.minPct}% — ${model.headline.bandLabel} band`);
    lines.push(`At ${model.headline.where}${model.headline.at ? ` (${model.headline.at})` : ""}; ${model.headline.bac}.`);
    lines.push("");
  }
  lines.push("TRIP FACTS");
  for (const [k, v] of model.facts) lines.push(`  ${k}: ${v}`);
  if (model.revised) lines.push(`  Schedule revision: ${model.revised}`);
  if (model.factors.length) lines.push(`  Conditions across the trip: ${model.factors.join(", ")}`);
  for (const l of model.logged) lines.push(`  Logged on day ${l.day}: ${l.text}${l.note ? ` — ${l.note}` : ""}`);
  lines.push("", "HOW THIS TRIP IS BUILT", model.narrative, "", "BY DUTY PERIOD");
  for (const d of model.duties) {
    lines.push(`  D${d.day} ${d.date} · ${d.route} · report ${d.report} → release ${d.release} · duty ${d.duty} · ${d.landings} landing(s)`);
    lines.push(`     lowest ${d.minPct ?? "—"}% (${d.bandLabel}) near ${d.minWhere}${d.minAt ? ` at ${d.minAt}` : ""}` +
      `${d.combined !== null ? ` · combined capacity ${d.combined}% (workload ${d.workload}/100)` : ""} · then ${d.layover}`);
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
  lines.push("", "MODEL NOTES", model.modelAssumptions, model.circadian, "", model.reminder, model.engine);
  return lines.join("\n");
}
