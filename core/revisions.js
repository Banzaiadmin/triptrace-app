/**
 * revisions.js — port of revisions.py. What actually happened, applied to the schedule.
 *
 * Two different things that must not be confused (see revisions.py for the reasoning):
 *   - a DELAY is a change of time, applied to the trace: legs move, release moves, the layover
 *     that follows shrinks, and the scorer re-integrates the revised timeline;
 *   - a CONDITION (weather, MEL, ATC…) is WORKLOAD: points per duty day that fill the spec's
 *     Combined Capacity fields and never touch the effectiveness estimate.
 *
 * **Python is the reference implementation.** Correct when it reproduces the `revised` member and
 * `inputs.workload` of every golden.
 */

import { NEAR_FLOOR_MARGIN_HOURS, WORKLOAD } from "./constants.js?v=25";
import { deepCopy, hmFromHours, pyRound } from "./py.js?v=25";
import { fmtLocal, fmtUtc, parseUtc } from "./tz.js?v=25";

const MINUTE = 60_000;

/** Coerce client input into clean records; drop anything unusable. Sorted by day, stably. */
export function normalizeRevisions(raw) {
  const out = [];
  for (const item of raw ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const day = Number(item.day_index);
    if (!Number.isFinite(day)) continue;
    let delay = Number(item.delay_minutes ?? 0);
    delay = Number.isFinite(delay) ? Math.max(0, Math.trunc(delay)) : 0;
    const flightRaw = item.flight;
    const flight = flightRaw === null || flightRaw === undefined || flightRaw === "" ? "" : String(flightRaw).trim();
    const factors = (item.factors ?? []).map((f) => String(f).trim()).filter(Boolean);
    const note = item.note ? String(item.note).trim() : "";
    if (delay === 0 && !factors.length) continue;
    out.push({
      day_index: Math.trunc(day),
      delay_minutes: delay,
      flight: flight || null,
      factors,
      note: note || null,
    });
  }
  return out.sort((a, b) => a.day_index - b.day_index);
}

/** Returns { trace, applied }. The input trace is never mutated. */
export function applyRevisions(input, revisions) {
  const trace = deepCopy(input);
  const applied = [];
  if (!revisions || !revisions.length) return { trace, applied };

  const duties = new Map((trace.duty_periods ?? []).map((d) => [d.day_index, d]));
  const rests = new Map((trace.rest_periods ?? []).map((r) => [r.after_duty_day, r]));
  const domicileTz = (trace.meta ?? {}).domicile_tz || "America/New_York";
  const notes = [];

  for (const rev of revisions) {
    const duty = duties.get(rev.day_index);
    if (!duty) continue;
    const record = {
      day_index: rev.day_index,
      delay_minutes: rev.delay_minutes,
      from_flight: null,
      factors: [...rev.factors],
      note: rev.note,
      release_utc: duty.release.utc,
      layover_after_station: null,
      layover_after_hours: null,
    };
    const delay = rev.delay_minutes;
    if (delay <= 0) { applied.push(record); continue; }

    const legs = duty.legs ?? [];
    let start = 0;
    if (rev.flight) {
      const index = legs.findIndex((leg) => String(leg.flight) === rev.flight);
      if (index >= 0) start = index;
    }
    record.from_flight = legs.length ? legs[start].flight : null;
    const deltaMs = delay * MINUTE;

    for (const leg of legs.slice(start)) {
      shiftClock(leg.dep, deltaMs, domicileTz);
      shiftClock(leg.arr, deltaMs, domicileTz);
    }
    shiftClock(duty.release, deltaMs, domicileTz);
    record.release_utc = duty.release.utc;

    const scheduled = duty.scheduled_duty ?? (duty.scheduled_duty = {});
    if (scheduled.scheduled_hours !== null && scheduled.scheduled_hours !== undefined) {
      scheduled.actual_hours = pyRound(scheduled.scheduled_hours + delay / 60, 6);
    }

    const layover = duty.layover_after;
    if (layover && layover.length_hours !== null && layover.length_hours !== undefined) {
      const printed = layover.length_hours;
      let newLength = pyRound(printed - delay / 60, 6);
      if (newLength < 0) {
        (trace.missing_data ?? (trace.missing_data = [])).push({
          kind: "time_conflict",
          detail: `A logged delay of ${delay} min on duty day ${rev.day_index} exceeds the ${hmFromHours(printed)} ` +
            `layover at ${layover.station ?? "?"}; the next report time is already past release.`,
          would_change: "Whether the next duty period can start as scheduled at all.",
        });
        newLength = 0.0;
      }
      const floor = layover.contract_floor_hours ?? null;
      layover.length_hours = newLength;
      layover.source = "actual";
      if (floor !== null) layover.at_or_near_floor = newLength <= floor + NEAR_FLOOR_MARGIN_HOURS;
      layover.extension_exposure =
        `Logged delay of ${delay} min from ${record.from_flight}: release ${duty.release.utc}, layover cut from ` +
        `${hmFromHours(printed)} to ${hmFromHours(newLength)}` +
        `${floor !== null ? ` against a ${hmFromHours(floor)} contractual floor` : ""}.`;
      record.layover_after_station = layover.station ?? null;
      record.layover_after_hours = newLength;

      const rest = rests.get(rev.day_index);
      if (rest) {
        const window = rest.sleep_opportunity_window ?? {};
        if (window.start_utc) {
          let startMs = parseUtc(window.start_utc) + deltaMs;
          if (window.end_utc && startMs > parseUtc(window.end_utc)) startMs = parseUtc(window.end_utc);
          window.start_utc = fmtUtc(startMs);
        }
        if (rest.sleep_opportunity_hours !== null && rest.sleep_opportunity_hours !== undefined) {
          rest.sleep_opportunity_hours = pyRound(Math.max(0, rest.sleep_opportunity_hours - delay / 60), 2);
        }
        rest.layover_length_hours = newLength;
        (rest.scheduled_rest ?? (rest.scheduled_rest = {})).actual_hours = newLength;
        rest.assumptions = `${rest.assumptions ?? ""} A logged delay of ${delay} min moved the start of this window later.`.trim();
      }
    }

    notes.push(`D${rev.day_index} +${delay} min from ${record.from_flight}` +
      `${rev.factors.length ? ` (${rev.factors.join(", ")})` : ""}`);
    applied.push(record);
  }

  for (const rev of revisions) {
    if (rev.delay_minutes <= 0 && rev.factors.length && duties.has(rev.day_index)) {
      notes.push(`D${rev.day_index} conditions: ${rev.factors.join(", ")}`);
    }
  }

  if (notes.length) {
    const meta = trace.meta ?? (trace.meta = {});
    meta.notes = `${meta.notes ?? ""} Revisions applied: ${notes.join("; ")}.`.trim();
  }
  return { trace, applied };
}

function shiftClock(clock, deltaMs, domicileTz) {
  const ms = parseUtc(clock.utc) + deltaMs;
  clock.utc = fmtUtc(ms);
  if (clock.station_tz) clock.station_local = fmtLocal(clock.station_tz, ms);
  clock.body_clock = fmtLocal(domicileTz, ms);
  clock.source = "actual";
}

/** Points per duty day; days with nothing reported are absent. */
export function workloadPoints(dayIndexes, revisions, tripFactors = []) {
  const out = {};
  const weight = (f) => WORKLOAD.points[f] ?? WORKLOAD.default_points;
  const trip = (tripFactors ?? []).reduce((sum, f) => sum + weight(f), 0);
  for (const day of dayIndexes) {
    let points = trip;
    for (const rev of revisions ?? []) {
      if (rev.day_index !== day) continue;
      points += rev.factors.reduce((sum, f) => sum + weight(f), 0);
      if (rev.delay_minutes > 0) {
        const blocks = Math.floor((rev.delay_minutes + 29) / 30);
        points += Math.min(WORKLOAD.delay_points_cap, WORKLOAD.delay_points_per_30_min * blocks);
      }
    }
    if (points) out[day] = points;
  }
  return out;
}
