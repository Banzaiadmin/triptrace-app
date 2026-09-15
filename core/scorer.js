/**
 * scorer.js — port of scorer.py.
 *
 * This is the first module of the native core. It goes first, ahead of the parser, for two reasons:
 * it needs no timezone library (the body clock runs off a numeric offset the parser already put in
 * the trace), so it sidesteps the unresolved React Native / Hermes ICU question entirely; and it is
 * the safety-critical arithmetic, which makes it the sharpest test of whether numbers survive the
 * language change at all.
 *
 * **Python is the reference implementation.** This file is correct when it reproduces `goldens/`.
 * Never change a number here to make a diff go green — change scorer.py, re-freeze, then port.
 *
 * Structure deliberately mirrors scorer.py section for section so the two can be read side by side.
 * Where JavaScript and Python genuinely differ, the difference is named at the call site rather
 * than smoothed over; `pyRound` (in py.js) is the important one.
 *
 * Complete: every field scorer.py writes — numbers, timestamps, and the prose in
 * `outputs.riskiest_drivers`, `outputs.transparency.*`, `rest_periods[].assumptions`,
 * `circadian.anchor_basis` and `threshold_crossings[]` — is produced here and diffed exactly.
 */

import {
  MODEL_PARAMS,
  EFFECTIVENESS_BANDS,
  SLEEP_OPPORTUNITY_SUBTRACTIONS,
  SCORER_CALIBRATION as CAL,
  WORKLOAD,
} from "./constants.js?v=29";
import { deepCopy, hmFromHours, minBy, pyFloatStr, pyFmt, pyRound } from "./py.js?v=29";
import { fmtUtc, parseUtc } from "./tz.js?v=29";

// Re-exported for the browser harness and older importers.
export { pyRound } from "./py.js?v=29";
export { fmtUtc, parseUtc } from "./tz.js?v=29";

export class ScoringError extends Error {}

// ── Constants that live in scorer.py below the generated set ────────────────

const MIN_SLEEP_BLOCK_HOURS = 0.75;
const MAX_CORE_SLEEP_HOURS = 8.5;
const MAX_NAP_HOURS = 2.0;
const SPLIT_SLEEP_THRESHOLD_HOURS = 5.0;
// See scorer.py: a layover containing several body-clock nights is slept in several nights.
const MIN_WAKE_BETWEEN_SLEEPS_HOURS = 12.0;
const MAX_SLEEP_BLOCKS_PER_REST = 8;
const PRE_TRIP_SLEEP_HOURS = 7.5;
const PRE_TRIP_LEAD_HOURS = 48;
const BODY_NIGHT_START_HOUR = 22.0;
const BODY_NIGHT_END_HOUR = 8.0;

const MINUTE = 60_000;
const HOUR = 3_600_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

const hoursBetween = (a, b) => (b - a) / HOUR;

function bandFor(pct) {
  return EFFECTIVENESS_BANDS.find((b) => b.low <= pct && pct < b.high) ??
    EFFECTIVENESS_BANDS[EFFECTIVENESS_BANDS.length - 1];
}

function hhmmToHours(text) {
  const [h, m] = text.split(":");
  return Number(h) + Number(m) / 60;
}

// ── Circadian process ───────────────────────────────────────────────────────

export function circadian(bodyHour) {
  const first = Math.cos((2 * Math.PI * (bodyHour - CAL.circadian_peak_hour)) / 24);
  const second = Math.cos(
    (4 * Math.PI * (bodyHour - CAL.circadian_peak_hour - CAL.second_harmonic_offset_hours)) / 24,
  );
  return first + CAL.second_harmonic_weight * second;
}

// Circadian multiplier on sleep intensity — see scorer.py for the reasoning. Built once, per
// minute of the body-clock day, in the same arithmetic order as Python so the two agree exactly.
function buildSleepPropensity() {
  const centre = (hhmmToHours(MODEL_PARAMS.wocl_body_clock_start) + hhmmToHours(MODEL_PARAMS.wocl_body_clock_end)) / 2;
  const grid = [];
  for (let m = 0; m < 1440; m += 1) grid.push(Math.cos((2 * Math.PI * (m / 60 - centre)) / 24));
  const raw = grid.map((c) => CAL.sleep_propensity_floor + (1 - CAL.sleep_propensity_floor) * ((c + 1) / 2));
  let nightSum = 0, nightCount = 0;
  for (let m = 0; m < 1440; m += 1) {
    const h = m / 60;
    if (h >= CAL.body_night_start_hour || h < CAL.body_night_end_hour) { nightSum += raw[m]; nightCount += 1; }
  }
  const nightMean = nightSum / nightCount;
  return raw.map((v) => v / nightMean);
}
const SLEEP_PROPENSITY = buildSleepPropensity();

export function sleepPropensity(bodyHour) {
  const minute = pyRound(((bodyHour % 24) + 24) % 24 * 60) % 1440;
  return SLEEP_PROPENSITY[minute];
}

export function sleepIntensity(reservoir, capacity) {
  const deficit = Math.max(0, 1 - reservoir / capacity);
  return MODEL_PARAMS.max_sleep_intensity_units_per_min *
    Math.pow(deficit, CAL.sleep_intensity_exponent);
}

export function effectiveness(reservoir, capacity, bodyHour) {
  const ratio = reservoir / capacity;
  const amplitude =
    MODEL_PARAMS.circadian_a1_pct + MODEL_PARAMS.circadian_a2_pct * (1 - ratio);
  return Math.max(0, Math.min(100, 100 * ratio + amplitude * circadian(bodyHour)));
}

// ── Body clock ──────────────────────────────────────────────────────────────

class BodyClock {
  constructor(domicileOffsetHours) {
    this.baseOffset = domicileOffsetHours;
    this.marks = [];                       // [{ when, drift }], appended in time order
  }

  addDriftMark(when, drift) {
    this.marks.push({ when, drift });
  }

  driftAt(when) {
    let drift = 0;
    for (const mark of this.marks) {
      if (mark.when <= when) drift = mark.drift;
      else break;
    }
    return drift;
  }

  hour(when) {
    const shifted = new Date(when + (this.baseOffset + this.driftAt(when)) * HOUR);
    return shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600;
  }

  isNight(when) {
    const hour = this.hour(when);
    return hour >= BODY_NIGHT_START_HOUR || hour < BODY_NIGHT_END_HOUR;
  }

  inWocl(when) {
    const start = hhmmToHours(MODEL_PARAMS.wocl_body_clock_start);
    const end = hhmmToHours(MODEL_PARAMS.wocl_body_clock_end);
    const hour = this.hour(when);
    return start <= hour && hour < end;
  }
}

// ── Sleep planning ──────────────────────────────────────────────────────────

class PlannedSleep {
  constructor(start, end, kind, efficiency, source = "assumed", restIndex = null) {
    this.start = start;
    this.end = end;
    this.kind = kind;
    this.efficiency = efficiency;
    this.source = source;
    this.restIndex = restIndex;
  }

  get hours() {
    return hoursBetween(this.start, this.end);
  }
}

function nightOverlapHours(start, end, clock) {
  let overlap = 0;
  for (let probe = start; probe < end; probe += 15 * MINUTE) {
    if (clock.isNight(probe)) overlap += 0.25;
  }
  return overlap;
}

function mostlyNight(start, end, clock) {
  const span = hoursBetween(start, end);
  return span > 0 && nightOverlapHours(start, end, clock) / span >= 0.6;
}

function bestNightAlignedStart(start, end, clock) {
  let bestStart = start;
  let bestScore = -1;
  const horizon = end - MIN_SLEEP_BLOCK_HOURS * HOUR;
  for (let probe = start; probe <= horizon; probe += 30 * MINUTE) {
    const length = Math.min(MAX_CORE_SLEEP_HOURS, hoursBetween(probe, end));
    const score = nightOverlapHours(probe, probe + length * HOUR, clock);
    if (score > bestScore + 1e-9) {
      bestStart = probe;
      bestScore = score;
    }
  }
  return bestStart;
}

function planRestSleep(windowStart, windowEnd, clock) {
  const total = hoursBetween(windowStart, windowEnd);
  if (total < MIN_SLEEP_BLOCK_HOURS) return [];

  // One core per body-clock night the window contains. A 67:50 layover is three nights in a hotel,
  // not one followed by 56 hours awake — see the long comment in scorer.py.
  const events = [];
  let segmentStart = windowStart;
  while (events.length < MAX_SLEEP_BLOCKS_PER_REST) {
    const remainingWindow = hoursBetween(segmentStart, windowEnd);
    if (remainingWindow < MIN_SLEEP_BLOCK_HOURS) break;

    let coreStart = bestNightAlignedStart(segmentStart, windowEnd, clock);
    let coreHours = Math.min(MAX_CORE_SLEEP_HOURS, hoursBetween(coreStart, windowEnd));
    if (coreHours < MIN_SLEEP_BLOCK_HOURS) {
      coreStart = segmentStart;
      coreHours = Math.min(MAX_CORE_SLEEP_HOURS, remainingWindow);
    }

    const end = coreStart + coreHours * HOUR;
    const isNight = mostlyNight(coreStart, end, clock);
    events.push(new PlannedSleep(
      coreStart, end,
      isNight ? "anchor" : "hotel_core",
      isNight ? MODEL_PARAMS.nocturnal_sleep_efficiency : MODEL_PARAMS.daytime_sleep_efficiency,
    ));
    segmentStart = end + MIN_WAKE_BETWEEN_SLEEPS_HOURS * HOUR;
  }

  const last = events[events.length - 1];
  const coreHours = hoursBetween(last.start, last.end);
  const coreEnd = last.end;

  const remaining = hoursBetween(coreEnd, windowEnd);
  if (coreHours < SPLIT_SLEEP_THRESHOLD_HOURS && remaining >= MIN_SLEEP_BLOCK_HOURS + 0.5) {
    const napHours = Math.min(MAX_NAP_HOURS, remaining - 0.5);
    const napStart = windowEnd - napHours * HOUR;
    if (napStart > coreEnd) {
      events.push(new PlannedSleep(
        napStart, windowEnd, "pre_duty_nap",
        MODEL_PARAMS.daytime_sleep_efficiency * 0.9,
      ));
    }
  }
  return events;
}

function bodyTimeBefore(when, bodyHour, clock) {
  let probe = when;
  for (let i = 0; i < 48 * 4; i += 1) {
    if (Math.abs(clock.hour(probe) - bodyHour) < 0.26) return probe;
    probe -= 15 * MINUTE;
  }
  return when - 24 * HOUR;
}

function resolveOverlaps(sleeps) {
  const resolved = [];
  for (const planned of sleeps) {
    if (resolved.length && planned.start < resolved[resolved.length - 1].end) {
      planned.start = resolved[resolved.length - 1].end;
    }
    if (planned.end - planned.start >= MIN_SLEEP_BLOCK_HOURS * HOUR) resolved.push(planned);
  }
  return resolved;
}

function buildSleepPlan(trace, duties, clock, tripStart) {
  const sleeps = [];

  const nightEnd = bodyTimeBefore(tripStart, BODY_NIGHT_END_HOUR, clock);
  sleeps.push(new PlannedSleep(
    nightEnd - PRE_TRIP_SLEEP_HOURS * HOUR, nightEnd, "pre_trip",
    MODEL_PARAMS.nocturnal_sleep_efficiency,
  ));

  if (hoursBetween(nightEnd, tripStart) > 12) {
    const napEnd = tripStart - 1.5 * HOUR;
    const napStart = Math.max(nightEnd + 6 * HOUR, napEnd - MAX_NAP_HOURS * HOUR);
    if (napEnd - napStart >= MIN_SLEEP_BLOCK_HOURS * HOUR) {
      sleeps.push(new PlannedSleep(
        napStart, napEnd, "pre_duty_nap",
        MODEL_PARAMS.daytime_sleep_efficiency * 0.85,
      ));
    }
  }

  (trace.rest_periods ?? []).forEach((rest, index) => {
    const window = rest.sleep_opportunity_window ?? {};
    if (!(window.start_utc && window.end_utc)) return;
    for (const planned of planRestSleep(parseUtc(window.start_utc), parseUtc(window.end_utc), clock)) {
      planned.restIndex = index;
      sleeps.push(planned);
    }
  });

  for (const duty of duties) {
    for (const leg of duty.legs) {
      const augmentation = leg.augmentation;
      if (!augmentation || !augmentation.has_bunk) continue;
      const target = augmentation.bunk_target_hours ?? 0;
      if (target < MIN_SLEEP_BLOCK_HOURS) continue;
      const dep = parseUtc(leg.dep.utc);
      const arr = parseUtc(leg.arr.utc);
      const midpoint = dep + (arr - dep) / 2;
      sleeps.push(new PlannedSleep(
        midpoint - (target / 2) * HOUR, midpoint + (target / 2) * HOUR,
        "bunk", MODEL_PARAMS.bunk_quality_factor,
      ));
    }
  }

  sleeps.sort((a, b) => a.start - b.start);
  return resolveOverlaps(sleeps);
}

function applyActuals(sleeps, actuals, trace) {
  if (!actuals.length) return { sleeps, used: 0 };

  const parsed = [];
  for (const entry of actuals) {
    let start;
    let end;
    try {
      start = parseUtc(entry.start_utc);
      end = parseUtc(entry.end_utc);
    } catch {
      continue;
    }
    if (end <= start) continue;
    parsed.push(new PlannedSleep(
      start, end, entry.type ?? "hotel_core",
      Number(entry.efficiency || MODEL_PARAMS.nocturnal_sleep_efficiency),
      "actual",
    ));
  }
  if (!parsed.length) return { sleeps, used: 0 };

  const windows = [];
  (trace.rest_periods ?? []).forEach((rest, index) => {
    const window = rest.sleep_opportunity_window ?? {};
    if (window.start_utc && window.end_utc) {
      windows.push({
        index,
        start: parseUtc(window.start_utc) - 2 * HOUR,
        end: parseUtc(window.end_utc) + 1 * HOUR,
      });
    }
  });

  const claimed = new Set();
  for (const actual of parsed) {
    let bestIndex = null;
    let bestOverlap = 0;
    for (const w of windows) {
      const overlap = Math.min(w.end, actual.end) - Math.max(w.start, actual.start);
      if (overlap > bestOverlap) {
        bestIndex = w.index;
        bestOverlap = overlap;
      }
    }
    if (bestIndex !== null && bestOverlap >= 30 * MINUTE) {
      actual.restIndex = bestIndex;
      claimed.add(bestIndex);
    }
  }

  // Per-layover override, not per-interval — see the note in scorer.py. Keeping the modeled block
  // that happens not to overlap would credit sleep the pilot just told us they did not get.
  const kept = sleeps.filter((s) =>
    !claimed.has(s.restIndex) &&
    !parsed.some((a) => a.start < s.end && s.start < a.end));
  kept.push(...parsed);
  kept.sort((a, b) => a.start - b.start);
  return { sleeps: resolveOverlaps(kept), used: parsed.length };
}

function applyDrift(clock, sleeps) {
  const cap = MODEL_PARAMS.body_clock_drift_cap_hours_per_day;
  let drift = 0;
  let previous = null;

  for (const planned of sleeps) {
    if (!["anchor", "hotel_core", "pre_trip"].includes(planned.kind) || planned.hours < 3) continue;
    const midpoint = planned.start + (planned.end - planned.start) / 2;
    let target = clock.hour(midpoint) - 3;
    if (target > 12) target -= 24;
    else if (target < -12) target += 24;

    const elapsedDays = previous === null ? 1 : Math.max(0.25, hoursBetween(previous, midpoint) / 24);
    const step = Math.max(-cap * elapsedDays, Math.min(cap * elapsedDays, target - drift));
    drift += step;
    clock.addDriftMark(midpoint, pyRound(drift, 3));
    previous = midpoint;
  }
}

// ── Integration ─────────────────────────────────────────────────────────────

function integrate(sleeps, tripStart, tripEnd, clock) {
  const capacity = MODEL_PARAMS.reservoir_capacity_units;
  const depletion = MODEL_PARAMS.depletion_slope_units_per_min;
  const step = CAL.step_minutes * MINUTE;

  const begin = Math.min(tripStart - PRE_TRIP_LEAD_HOURS * HOUR, ...sleeps.map((s) => s.start)) - HOUR;
  const finish = tripEnd + HOUR;

  let reservoir = capacity;
  let lastWake = null;
  let wokeFromWocl = false;
  const samples = [];

  for (let when = begin; when <= finish; when += step) {
    const active = sleeps.find((s) => s.start <= when && when < s.end) ?? null;

    if (active !== null) {
      reservoir = Math.min(
        capacity,
        reservoir + sleepIntensity(reservoir, capacity) * active.efficiency
          * sleepPropensity(clock.hour(when)) * CAL.step_minutes,
      );
      lastWake = null;
    } else {
      reservoir = Math.max(0, reservoir - depletion * CAL.step_minutes);
      if (lastWake === null) {
        const ended = sleeps.filter((s) => s.end <= when);
        if (ended.length) {
          // Python's max() with a key keeps the FIRST maximum; reduce with > matches that.
          const mostRecent = ended.reduce((best, s) => (s.end > best.end ? s : best));
          if (when - mostRecent.end < CAL.step_minutes * 2 * MINUTE) {
            lastWake = mostRecent.end;
            wokeFromWocl = clock.inWocl(mostRecent.end);
          }
        }
      }
    }

    const bodyHour = clock.hour(when);
    let value = effectiveness(reservoir, capacity, bodyHour);

    if (lastWake !== null) {
      const window = wokeFromWocl ? CAL.inertia_minutes_from_wocl : CAL.inertia_minutes;
      const elapsed = (when - lastWake) / MINUTE;
      if (elapsed >= 0 && elapsed < window) {
        value = Math.max(0, value - CAL.inertia_penalty_points * (1 - elapsed / window));
      }
    }

    samples.push({ when, reservoir, effectiveness: value, asleep: active !== null, bodyHour });
  }
  return samples;
}

const windowOf = (samples, start, end) => samples.filter((s) => s.when >= start && s.when <= end);

function isDeadhead(leg) {
  return Boolean(leg && leg.raw && leg.raw.deadhead);
}

function effectivenessBlock(samples, start, end, location) {
  const span = windowOf(samples, start, end);
  if (!span.length) return null;

  const lowest = minBy(span, (s) => s.effectiveness);
  const capacity = MODEL_PARAMS.reservoir_capacity_units;
  const info = bandFor(lowest.effectiveness);
  const inertia = span.find((s) => s.when === start);

  const block = {
    start_pct: pyRound(span[0].effectiveness, 1),
    min_pct: pyRound(lowest.effectiveness, 1),
    min_at_utc: fmtUtc(lowest.when),
    min_location: location,
    end_pct: pyRound(span[span.length - 1].effectiveness, 1),
    reservoir_pct: pyRound((100 * lowest.reservoir) / capacity, 1),
    band: info.band,
    bac_equivalent: info.bac,
    inertia_minutes: inertia && inertia.effectiveness < 100 ? CAL.inertia_minutes : 0,
    // Present-and-null, not absent: the parser prunes nulls, but the scorer writes into the trace
    // after pruning, so these two survive as nulls in the Python output and must here too.
    workload_norm: null,
    combined_capacity: null,
  };
  return block;
}

function annotate(trace, duties, samples, clock) {
  for (const duty of duties) {
    const report = parseUtc(duty.report.utc);
    const release = parseUtc(duty.release.utc);

    for (const leg of duty.legs) {
      const block = effectivenessBlock(
        samples, parseUtc(leg.dep.utc), parseUtc(leg.arr.utc),
        `${leg.flight} ${leg.dep_station}-${leg.arr_station}`,
      );
      if (block) leg.effectiveness = block;
    }

    const scoredLegs = duty.legs.filter((l) => l.effectiveness);
    const flown = scoredLegs.filter((l) => !isDeadhead(l));
    const pool = flown.length ? flown : scoredLegs;
    const worst = minBy(pool, (l) => l.effectiveness.min_pct);
    const location = worst
      ? `${worst.effectiveness.min_location}${isDeadhead(worst) ? " (deadhead)" : ""}, near ${worst.arr_station}`
      : "duty period";

    const block = effectivenessBlock(samples, report, release, location);
    if (block) duty.effectiveness = block;

    const circadianBlock = duty.circadian ?? (duty.circadian = {});
    circadianBlock.drift_from_domicile_hours = pyRound(clock.driftAt(report), 2);
    circadianBlock.body_clock_anchor_tz_offset_hours =
      pyRound(clock.baseOffset + clock.driftAt(report), 2);
    circadianBlock.anchor_basis =
      `domicile anchor drifted ${pyFmt(clock.driftAt(report), 1, { sign: true })} h toward the trip's ` +
      `sleep pattern by this duty day (cap ${pyFmt(MODEL_PARAMS.body_clock_drift_cap_hours_per_day, 1)} h/day)`;
  }
}

function writeRestPeriods(trace, sleeps, clock) {
  const rests = trace.rest_periods ?? [];
  rests.forEach((rest, index) => {
    const events = sleeps
      .filter((s) => s.restIndex === index)
      .map((planned) => ({
        type: planned.kind,
        window: { start_utc: fmtUtc(planned.start), end_utc: fmtUtc(planned.end) },
        window_hours: pyRound(planned.hours, 2),
        efficiency: pyRound(planned.efficiency, 3),
        effective_sleep_hours: pyRound(planned.hours * planned.efficiency, 2),
        is_daytime: !mostlyNight(planned.start, planned.end, clock),
        overlaps_wocl: clock.inWocl(planned.start) || clock.inWocl(planned.end),
        source: planned.source,
      }));
    rest.sleep_events = events;
    if (events.length) {
      rest.total_effective_sleep_hours = pyRound(
        events.reduce((sum, e) => sum + e.effective_sleep_hours, 0), 2,
      );
    }
    const modeled = events.filter((e) => e.source === "assumed");
    rest.assumptions =
      `${events.length} sleep block(s) modeled from the opportunity window: ` +
      `${events.map((e) => `${e.type} ${pyFmt(e.window_hours, 1)}h @${pyFmt(e.efficiency, 2)}`).join(", ") || "none"}. ` +
      `Daytime efficiency ${pyFmt(MODEL_PARAMS.daytime_sleep_efficiency, 2)}, ` +
      `nocturnal ${pyFmt(MODEL_PARAMS.nocturnal_sleep_efficiency, 2)}. ` +
      (modeled.length === events.length
        ? "All modeled — no pilot actuals."
        : "Includes pilot-reported or wearable actuals, which override the model.");
  });
}

// ── Trip-level outputs ──────────────────────────────────────────────────────

function writeOutputs(trace, duties, clock, usedActuals) {
  const scored = duties.filter((d) => d.effectiveness);
  if (!scored.length) throw new ScoringError("No duty period could be scored.");

  const worstDuty = minBy(scored, (d) => d.effectiveness.min_pct);
  const worstBlock = worstDuty.effectiveness;

  // The trip minimum is reported honestly wherever it falls, but "riskiest leg" means the leg
  // carrying operational risk — a pilot riding in back at 68% is not the same hazard as a pilot
  // flying an approach at 68%.
  const allLegs = duties.flatMap((d) => d.legs).filter((l) => l.effectiveness);
  const flownLegs = allLegs.filter((l) => !isDeadhead(l));
  const worstLeg = minBy(flownLegs, (l) => l.effectiveness.min_pct);
  const worstAny = minBy(allLegs, (l) => l.effectiveness.min_pct);
  const minOnDeadhead = Boolean(worstAny && isDeadhead(worstAny));

  const crossings = [];
  for (const duty of scored) {
    const block = duty.effectiveness;
    if (!["red", "purple"].includes(block.band)) continue;
    const layover = duty.layover_after ?? {};
    crossings.push({
      duty_day: duty.day_index,
      leg: worstLeg ? worstLeg.effectiveness.min_location : undefined,
      band: block.band,
      trigger: triggerText(block, clock),
      worse_if: "Delays, a reduced layover, hotel noise, a missed nap, or a duty extension " +
        "toward soft max.",
      contract_note: contractNote(layover),
    });
  }

  trace.outputs = {
    trip_min_effectiveness_pct: worstBlock.min_pct,
    trip_min_at_utc: worstBlock.min_at_utc,
    riskiest_duty_day: worstDuty.day_index,
    riskiest_leg: worstLeg ? worstLeg.effectiveness.min_location : undefined,
    riskiest_drivers: drivers(trace, worstDuty, worstBlock, minOnDeadhead, worstAny),
    threshold_crossings: crossings,
    risk_label: `D${worstDuty.day_index} ${worstBlock.min_location}`,
    transparency: {
      sleep_assumptions: sleepAssumptions(usedActuals),
      circadian_anchors: circadianSummary(duties, clock),
      confidence_by_day: Object.fromEntries(
        duties.map((d) => [String(d.day_index), "confidence" in d ? d.confidence : "medium"]),
      ),
      reminder:
        "SAFTE-style approximation produced by software, not validated biomathematical " +
        "modeling and not legal or contractual advice. Sleep is modeled, not measured, " +
        "unless actuals were provided. Your own symptoms — microsleeps, fixation, missed " +
        "radio calls, poor crosscheck — outrank every number here.",
    },
  };
}

function triggerText(block, clock) {
  const when = parseUtc(block.min_at_utc);
  const hour = clock.hour(when);
  const p = (n) => String(n).padStart(2, "0");
  return `Effectiveness reaches ${pyFmt(block.min_pct, 0)}% (${block.bac_equivalent}) at body-clock ` +
    `${p(Math.trunc(hour))}:${p(Math.trunc((hour % 1) * 60))}${clock.inWocl(when) ? ", inside the WOCL" : ""}.`;
}

function contractNote(layover) {
  if (!layover || !Object.keys(layover).length) {
    return "Legal is not the same as safe. UPS operates outside FAR Part 117, so mitigation " +
      "is contractual and self-managed. The fatigue call is the pilot's authority; " +
      "contractual disputes go to the IPA.";
  }
  return `Layover ${hmFromHours(layover.length_hours ?? null)} at ${layover.station ?? "?"} against a ` +
    `${hmFromHours(layover.contract_floor_hours ?? null)} contractual floor` +
    `${layover.at_or_near_floor ? " — at or near it" : ""}. Legal is not the same as safe: UPS ` +
    "operates outside FAR Part 117, so mitigation is contractual and self-managed. The fatigue " +
    "call is the pilot's authority; contractual disputes go to the IPA.";
}

function drivers(trace, duty, block, minOnDeadhead, worstAny) {
  const rests = trace.rest_periods ?? [];
  const prior = rests.filter((r) => (r.after_duty_day ?? 0) < duty.day_index);
  const slept = prior
    .map((r) => r.total_effective_sleep_hours)
    .filter((h) => h !== null && h !== undefined);
  const parts = [`Reservoir down to ${pyFmt(block.reservoir_pct, 0)}% of capacity by this point.`];
  if (slept.length) {
    const total = slept.reduce((sum, h) => sum + h, 0);
    parts.push(`Modeled effective sleep across the ${slept.length} preceding layover(s) averages ` +
      `${pyFmt(total / slept.length, 1)} h.`);
  }
  if (duty.landings) parts.push(`${duty.landings} landing(s) in this duty period.`);
  parts.push(`Minimum falls at ${block.min_location}.`);
  if (block.workload_norm !== null && block.workload_norm !== undefined) {
    parts.push(`Reported conditions add workload ${pyFloatStr(block.workload_norm)}/100 on this duty day; ` +
      `combined capacity ${pyFloatStr(block.combined_capacity)}%.`);
  }
  if (minOnDeadhead && worstAny) {
    parts.push(`Note: the trip's lowest point falls on ${worstAny.flight} ${worstAny.dep_station}-` +
      `${worstAny.arr_station}, a deadhead — real fatigue, but carried as a passenger rather than at ` +
      "the controls. The lowest point while actually flying is reported separately.");
  }
  return parts.join(" ");
}

function sleepAssumptions(usedActuals) {
  const s = SLEEP_OPPORTUNITY_SUBTRACTIONS;
  return `Sleep opportunity = printed layover minus transport ${pyFmt(s.transport_hours, 2)} h, ` +
    `wind-down ${pyFmt(s.wind_down_hours, 2)} h, meal ${pyFmt(s.meal_hours, 2)} h, and pre-report prep ` +
    `${pyFmt(s.pre_report_prep_hours, 2)} h. Daytime efficiency ${pyFmt(MODEL_PARAMS.daytime_sleep_efficiency, 2)}, ` +
    `nocturnal ${pyFmt(MODEL_PARAMS.nocturnal_sleep_efficiency, 2)}, bunk quality factor ` +
    `${pyFmt(MODEL_PARAMS.bunk_quality_factor, 2)}. Sleep inertia ${pyFmt(CAL.inertia_minutes, 0)} min after ` +
    `waking (${pyFmt(CAL.inertia_minutes_from_wocl, 0)} min from a WOCL wake). ` +
    (usedActuals
      ? `${usedActuals} pilot-reported or wearable sleep period(s) overrode the model.`
      : "No actuals supplied — every sleep block is modeled.");
}

function circadianSummary(duties, clock) {
  const drifts = duties.map((d) => clock.driftAt(parseUtc(d.report.utc)));
  return `Body clock anchored to domicile (UTC${pyFmt(clock.baseOffset, 0, { sign: true })}) and drifted ` +
    `toward the trip's sleep pattern at no more than ${pyFmt(MODEL_PARAMS.body_clock_drift_cap_hours_per_day, 1)} h/day, ` +
    `ending ${pyFmt(drifts[drifts.length - 1], 1, { sign: true })} h from domicile. WOCL tracked as ` +
    `${MODEL_PARAMS.wocl_body_clock_start}-${MODEL_PARAMS.wocl_body_clock_end} body-clock time and ` +
    "re-expressed in UTC per duty day.";
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Score a parsed TripTrace. Returns a new object; the input is never mutated.
 *
 * @param {object} input parsed (or revised) trace
 * @param {{actualSleep?: Array<object>, workload?: Record<string|number, number>}} [options]
 *   `workload` is {day_index: points} from revisions.js; it fills the spec's Combined Capacity
 *   fields on that day's blocks and nothing else.
 */
export function scoreTrace(input, options = {}) {
  const trace = deepCopy(input);                 // json round-trip, exactly as scorer.py does
  const duties = trace.duty_periods ?? [];
  if (!duties.length) throw new ScoringError("Trace has no duty periods to score.");
  const workload = new Map(Object.entries(options.workload ?? {}).map(([k, v]) => [Number(k), v]));

  const offset = domicileOffset(duties);
  const clock = new BodyClock(offset);

  const tripStart = parseUtc(duties[0].report.utc);
  const tripEnd = parseUtc(duties[duties.length - 1].release.utc);

  let sleeps = buildSleepPlan(trace, duties, clock, tripStart);
  const applied = applyActuals(sleeps, options.actualSleep ?? [], trace);
  sleeps = applied.sleeps;

  trace.meta = trace.meta ?? {};
  trace.meta.pilot_reported_actuals = Boolean(applied.used);

  applyDrift(clock, sleeps);

  const samples = integrate(sleeps, tripStart, tripEnd, clock);
  annotate(trace, duties, samples, clock);
  applyWorkload(duties, workload);
  writeRestPeriods(trace, sleeps, clock);
  writeOutputs(trace, duties, clock, applied.used);
  return trace;
}

/** Spec §4 Combined Capacity, filled only for days that reported something. */
function applyWorkload(duties, workload) {
  for (const duty of duties) {
    const points = workload.get(duty.day_index);
    if (points === undefined || points === null) continue;
    const norm = pyRound(Math.min(100.0, (100.0 * points) / WORKLOAD.max_points), 1);
    const blocks = duty.legs.filter((leg) => leg.effectiveness).map((leg) => leg.effectiveness);
    if (duty.effectiveness) blocks.push(duty.effectiveness);
    for (const block of blocks) {
      block.workload_norm = norm;
      block.combined_capacity = pyRound((block.min_pct + block.reservoir_pct + (100.0 - norm)) / 3.0, 1);
    }
  }
}

function domicileOffset(duties) {
  for (const duty of duties) {
    const offset = duty.circadian?.body_clock_anchor_tz_offset_hours;
    if (offset !== undefined && offset !== null) return Number(offset);
  }
  throw new ScoringError(
    "Trace carries no body_clock_anchor_tz_offset_hours; the parser normally sets it.",
  );
}
