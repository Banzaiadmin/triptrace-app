/**
 * report.js — port of report.py. Prose generated from a scored TripTrace.
 *
 * Every sentence is assembled from values already computed and present in the trace. Nothing is
 * written by a language model at request time, and nothing is invented for tone: a pilot may hand
 * the safety report to a chief pilot, and every number in it has to be traceable to something the
 * model actually calculated.
 *
 * **Python is the reference implementation.** This file is correct when it reproduces the `report`
 * member of every golden, character for character. The Python-format helpers in py.js exist for
 * exactly this file: "%.0f" is half-to-even in Python, and str(70.0) is "70.0".
 */

import { BAND_LABELS, MODEL_PARAMS } from "./constants.js?v=30";
import { hmFromHours, maxBy, minBy, pyFloatStr, pyFmt, pyStr } from "./py.js?v=30";
import { parseUtc } from "./tz.js?v=30";

const CITATIONS = {
  sleep_opportunity: "FAA AC 120-100",
  cumulative: "Van Dongen et al., 2003",
  bac: "Dawson & Reid, 1997; Lamond & Dawson, 1999",
  wocl: "Dinges & Graeber, 1996",
};

const hm = hmFromHours;

function localClock(clock) {
  const local = clock.station_local;
  return local ? local.slice(11, 16) : `${clock.utc.slice(11, 16)}Z`;
}

const duties = (trace) => (trace.duty_periods ?? []).filter((d) => d.effectiveness);

const shortRests = (trace) =>
  (trace.rest_periods ?? []).filter((r) => (r.total_effective_sleep_hours || 99) < 6.5);

const nearFloor = (trace) =>
  (trace.duty_periods ?? [])
    .filter((d) => (d.layover_after ?? {}).at_or_near_floor)
    .map((d) => d.layover_after);

/** Python's dict.get(key, default): the default applies only when the key is absent. */
const getOr = (obj, key, fallback) => (key in obj ? obj[key] : fallback);

// ── Narrative ───────────────────────────────────────────────────────────────

export function narrative(trace) {
  const scored = duties(trace);
  const outputs = trace.outputs ?? {};
  if (!scored.length || !Object.keys(outputs).length) {
    return "This trip has not been scored, so there is nothing to describe yet.";
  }

  const pairing = trace.pairing ?? {};
  const worstDay = outputs.riskiest_duty_day;
  const tripMin = outputs.trip_min_effectiveness_pct;
  const short = shortRests(trace);
  const arrivals = nightArrivals(trace);

  const parts = [
    `This pairing runs ${pyStr(pairing.duty_days)} duty periods over ${hm(pairing.tafb_hours ?? null)} ` +
      `of time away from base, with ${hm(pairing.total_block_hours ?? null)} block and ` +
      `${pyStr(pairing.landings_count)} landings.`,
  ];

  if (short.length) {
    const stations = short
      .map((r) => `${pyStr(r.station)} (${pyFmt(r.total_effective_sleep_hours || 0, 1)} h)`)
      .join(", ");
    parts.push(
      `${short.length} of the ${(trace.rest_periods ?? []).length} layovers model out to under 6.5 hours ` +
        "of realistic sleep once transport, wind-down, and pre-report prep come off the clock: " +
        `${stations}. That gap between rest on paper and sleep in practice is where the debt accumulates.`,
    );
  } else {
    parts.push(
      "Every layover on this trip models out to more than 6.5 hours of realistic sleep, so " +
        "the schedule is not fighting the pilot on rest length.",
    );
  }

  if (arrivals.length) {
    const count = arrivals.length;
    parts.push(
      `${count} arrival${count === 1 ? " lands" : "s land"} inside or adjacent to the window of circadian ` +
        "low, when alertness is at its floor regardless of how the preceding rest went.",
    );
  }

  const trendText = trend(scored);
  if (trendText) parts.push(trendText);

  parts.push(
    `The low point is ${pyFloatStr(tripMin)}% on day ${pyStr(worstDay)}, at ` +
      `${getOr(outputs, "risk_label", "the trip minimum")}. ${bandSentence(tripMin)}`,
  );
  return parts.join(" ");
}

function nightArrivals(trace) {
  const hits = [];
  for (const duty of trace.duty_periods ?? []) {
    const window = (duty.circadian ?? {}).wocl_window ?? {};
    if (!(window.start_utc && window.end_utc)) continue;
    const start = parseUtc(window.start_utc);
    const end = parseUtc(window.end_utc);
    for (const leg of duty.legs) {
      if ((leg.raw ?? {}).deadhead) continue;
      const arr = parseUtc(leg.arr.utc);
      if (start <= arr && arr <= end) hits.push(leg);
    }
  }
  return hits;
}

function trend(scored) {
  const mins = scored.map((d) => d.effectiveness.min_pct);
  if (mins.length < 3) return null;
  const first = mins[0];
  const last = mins[mins.length - 1];
  if (last < first - 4) {
    return `Daily minimums decline across the trip, from ${pyFmt(first, 0)}% on day 1 to ${pyFmt(last, 0)}% on the ` +
      "last duty period — the pattern of a trip the pilot does not recover from in place.";
  }
  if (last > first + 4) {
    return `Daily minimums improve across the trip, from ${pyFmt(first, 0)}% to ${pyFmt(last, 0)}%, so the schedule ` +
      "does allow some recovery as it goes.";
  }
  return `Daily minimums stay in a narrow band (${pyFmt(Math.min(...mins), 0)}-${pyFmt(Math.max(...mins), 0)}%), ` +
    "so no single duty period is the outlier — the exposure is the accumulation.";
}

function bandSentence(pct) {
  if (pct === null || pct === undefined) return "";
  if (pct < 75) {
    return "That is in the Critical band — impairment comparable to roughly 24 hours of " +
      "continuous wakefulness. A fatigue call here is strongly indicated.";
  }
  if (pct < 80) {
    return "That is in the High band — comparable to about a 0.05 blood alcohol " +
      "concentration, past the 0.04 limit FAR 91.17 sets for alcohol.";
  }
  if (pct < 85) return "That is in the Elevated band, at or near the 0.04 impairment equivalent.";
  if (pct < 90) return "That is in the Monitor band — noticeable slowing, worth tightening the crosscheck.";
  return "That stays in the Normal band throughout.";
}

// ── Recommendations ─────────────────────────────────────────────────────────

/** Ranked by this trip's own drivers, not a generic sleep-hygiene list. */
export function recommendations(trace) {
  const recs = [];
  const outputs = trace.outputs ?? {};
  const rests = trace.rest_periods ?? [];

  const longest = maxBy(rests, (r) => r.layover_length_hours || 0);
  if (longest && (longest.layover_length_hours || 0) >= 14) {
    recs.push(
      `Protect the ${pyStr(longest.station)} layover — at ${hm(longest.layover_length_hours ?? null)} it is the one ` +
        "real chance to reset, and the rest of the trip depends on it.",
    );
  }

  const shortest = minBy(rests, (r) => r.total_effective_sleep_hours || 99);
  if (shortest && (shortest.total_effective_sleep_hours || 99) < 6.5) {
    recs.push(
      `Lights out fast at ${pyStr(shortest.station)} — it models to only ` +
        `${pyFmt(shortest.total_effective_sleep_hours || 0, 1)} h of effective sleep, so every ` +
        "minute of delay comes straight off the total.",
    );
  }

  if (nightArrivals(trace).length) {
    recs.push(
      "Caffeine early in the night duties and none within six hours of your next sleep " +
        "opportunity — late caffeine buys alertness now by taking it from the layover.",
    );
  }

  if (rests.filter((r) => r.sleep_events && r.sleep_events.length).some((r) => r.sleep_events[0].is_daytime)) {
    recs.push(
      "Sunglasses on the morning arrivals and a dark room afterward — daytime sleep is " +
        `modeled at ${pyFmt(MODEL_PARAMS.daytime_sleep_efficiency * 100, 0)}% efficiency, and light ` +
        "exposure is the main reason it is that low.",
    );
  }

  if (outputs.riskiest_leg) {
    recs.push(
      `Treat ${outputs.riskiest_leg} as the leg that needs the most margin — it is the lowest point of the trip ` +
        "while actually flying.",
    );
  }

  if (!(trace.meta ?? {}).pilot_reported_actuals) {
    recs.push(
      "Connect a wearable or enter what you actually slept — every sleep figure above is " +
        "modeled, and real data usually moves the numbers in both directions.",
    );
  }
  return recs.slice(0, 5);
}

// ── Worth knowing ───────────────────────────────────────────────────────────

export function watchItems(trace) {
  const items = [];
  const near = nearFloor(trace);
  if (near.length) {
    items.push(
      `${near.length} layover${near.length === 1 ? "" : "s"} sit at or near the contractual floor and ` +
        `${near.length === 1 ? "is" : "are"} reducible — if that happens, the estimates above move down, not sideways.`,
    );
  }

  const longDuties = (trace.duty_periods ?? [])
    .filter((d) => ((d.scheduled_duty ?? {}).scheduled_hours ?? 0) >= 11);
  if (longDuties.length) {
    items.push(
      `Duty day${longDuties.length === 1 ? "" : "s"} ${longDuties.map((d) => String(d.day_index)).join(", ")} ` +
        "already exceed 11 hours as scheduled, leaving little room before an " +
        "extension pushes into a lower band.",
    );
  }

  const delayed = (trace.duty_periods ?? [])
    .filter((d) => (d.scheduled_duty ?? {}).actual_hours !== null && (d.scheduled_duty ?? {}).actual_hours !== undefined);
  if (delayed.length) {
    items.push(
      `Logged delays extended duty day${delayed.length === 1 ? "" : "s"} ` +
        `${delayed.map((d) => String(d.day_index)).join(", ")} — the estimates above already include them.`,
    );
  }

  const conflicts = (trace.missing_data ?? []).filter((m) => ["time_conflict", "cut_off"].includes(m.kind));
  if (conflicts.length) {
    items.push(
      `${conflicts.length} item${conflicts.length === 1 ? "" : "s"} in the schedule could not be read cleanly — ` +
        "check the transcript before relying on the numbers.",
    );
  }

  items.push(
    "A fatigue call remains a normal professional tool. Contractual minimum rest is a " +
      "scheduling floor, not a fitness guarantee.",
  );
  return items;
}

// ── Formal safety report ────────────────────────────────────────────────────

/** Objective, science-based fitness-for-duty write-up. Facts, physiology, conclusion. */
export function safetyReport(trace, factors = null, rescheduled = null, revisionsApplied = null) {
  factors = factors ?? [];
  rescheduled = rescheduled ?? [];
  revisionsApplied = revisionsApplied ?? [];
  const outputs = trace.outputs ?? {};
  const pairing = trace.pairing ?? {};
  const meta = trace.meta ?? {};
  const tripMin = outputs.trip_min_effectiveness_pct;
  const scored = duties(trace);

  const lines = [
    "PROPOSED FATIGUE SAFETY REPORT — DRAFT FOR PILOT REVIEW",
    `Pairing ${pyStr(pairing.pairing_id)} · ${pyStr(meta.domicile)} ${pyStr(meta.fleet)} · ` +
      `${pyStr(pairing.duty_days)} duty periods · TAFB ${hm(pairing.tafb_hours ?? null)}`,
    "",
    "1. PURPOSE",
    "This report documents an objective fatigue assessment of the referenced pairing using a " +
      "SAFTE-style biomathematical approximation. It is offered as decision support for a " +
      "fitness-for-duty determination. It is not a grievance, a schedule dispute, or a " +
      "contractual claim.",
    "",
    "2. SCHEDULE FACTS",
  ];

  lines.push(`• ${pyStr(pairing.duty_days)} duty periods over ${hm(pairing.tafb_hours ?? null)} with ` +
    `${pyStr(pairing.legs_count)} legs and ${pyStr(pairing.landings_count)} landings.`);

  const short = shortRests(trace);
  if (short.length) {
    lines.push(
      `• ${short.length} layover${short.length === 1 ? "" : "s"} (` +
        `${short.map((r) => `${pyStr(r.station)} ${hm(r.layover_length_hours ?? null)}`).join(", ")}) yield an ` +
        `estimated ${hm(Math.max(...short.map((r) => r.total_effective_sleep_hours || 0)))} of realistic sleep ` +
        "or less once transportation, meals, and pre-duty preparation are subtracted from the rest period.",
    );
  }

  const longDuties = (trace.duty_periods ?? [])
    .filter((d) => ((d.scheduled_duty ?? {}).scheduled_hours ?? 0) >= 10);
  if (longDuties.length) {
    lines.push(`• Duty periods of ${longDuties.map((d) => hm(d.scheduled_duty.scheduled_hours)).join(", ")} as scheduled.`);
  }

  const all = trace.duty_periods ?? [];
  const last = all.length ? all[all.length - 1] : null;
  if (last) {
    lines.push(`• The final duty period concludes at approximately ${localClock(last.release)} local at ` +
      `${last.legs[last.legs.length - 1].arr_station}.`);
  }

  for (const floor of nearFloor(trace)) {
    lines.push(
      `• The ${pyStr(floor.station)} layover of ${hm(floor.length_hours ?? null)} sits at or near the ` +
        `${hm(floor.contract_floor_hours ?? null)} contractual floor and is reducible to ` +
        `${hm(floor.reducible_to_hours ?? null)}.`,
    );
  }

  if (rescheduled.length) {
    lines.push(`• Subsequent schedule revision: ${rescheduled.join("; ").toLowerCase()}.`);
  }

  const delays = revisionsApplied.filter((r) => r.delay_minutes);
  if (delays.length) lines.push(`• Logged delays: ${delays.map(delayPhrase).join("; ")}.`);

  lines.push(
    "",
    "3. PHYSIOLOGICAL BASIS",
    "• Sleep opportunity is materially shorter than layover duration once transportation, " +
      `meals, and pre-duty preparation are accounted for (${CITATIONS.sleep_opportunity}).`,
    "• Consecutive nights of truncated sleep produce cumulative performance degradation that " +
      `is not offset by effort or motivation (${CITATIONS.cumulative}).`,
    "• Sustained wakefulness of approximately 17-19 hours produces psychomotor impairment " +
      `comparable to a 0.05% blood alcohol concentration (${CITATIONS.bac}).`,
    `• Operations during or adjacent to the window of circadian low (${MODEL_PARAMS.wocl_body_clock_start}-` +
      `${MODEL_PARAMS.wocl_body_clock_end} body-clock time) occur at reduced alertness independent of prior ` +
      `rest quality (${CITATIONS.wocl}).`,
    "",
    "4. ASSESSMENT",
  );

  const worstBand = scored.length ? minBy(scored, (d) => d.effectiveness.min_pct).effectiveness.band : "";
  const bandName = BAND_LABELS[worstBand || ""] ?? "—";
  lines.push(
    `Modeled effectiveness reaches a minimum of approximately ${pyFloatStr(tripMin)}% (${bandName} band) at ` +
      `${getOr(outputs, "risk_label", "the trip minimum")}. Impairment in this range is comparable to ` +
      `${bacPhrase(trace)}.`,
  );
  lines.push(`Contributing factors: ${getOr(outputs, "riskiest_drivers", "not computed.")}`);
  const conditions = conditionsText(factors, revisionsApplied);
  if (conditions.length) {
    // Quantified exactly one way — as workload in the spec's Combined Capacity metric — and the
    // document says which figures moved. Effectiveness itself is never altered by them.
    lines.push(
      `The pilot reports the following conditions: ${conditions.join("; ")}. These are incorporated as workload ` +
        "in the Combined Capacity metric (SAFTE-FAST Combined Capacity white paper) and do not " +
        `alter the effectiveness estimate itself: ${capacitySummary(trace)}.`,
    );
  }
  if (meta.pilot_reported_actuals) {
    lines.push("Sleep figures incorporate measured sleep data rather than modeled defaults.");
  }

  lines.push(
    "",
    "5. STATEMENT",
    `Based on the schedule characteristics and modeling above, ${rescheduled.length
      ? "continued operation of the revised assignment" : "continued operation"} is predicted to occur at a ` +
      "performance level inconsistent with an appropriate margin of safety. This determination " +
      "reflects the pilot-in-command's responsibility to assess fitness for duty, and is " +
      "independent of the assignment's regulatory or contractual legality.",
    "",
    "6. LIMITATIONS",
    "This assessment is a biomathematical approximation intended for decision support, not " +
      `validated SAFTE-FAST output. Sleep was ${meta.pilot_reported_actuals
        ? "taken from measured data where available" : "modeled from schedule structure, not measured"}. ` +
      "Actual sleep obtained and evolving operational conditions may change the results. " +
      "Contractual questions are appropriately directed to the union; this report asserts no " +
      "contract interpretation.",
  );

  const unresolved = (trace.missing_data ?? []).filter((m) => ["time_conflict", "cut_off"].includes(m.kind));
  if (unresolved.length) {
    lines.push(
      `Note: ${unresolved.length} schedule item(s) could not be read cleanly from the source screen and were ` +
        "excluded rather than estimated.",
    );
  }
  return lines.join("\n");
}

function conditionsText(factors, revisionsApplied) {
  const out = [];
  if (factors.length) out.push(`across the trip: ${factors.join(", ").toLowerCase()}`);
  for (const record of revisionsApplied) {
    if (record.factors && record.factors.length) {
      out.push(`day ${record.day_index}: ${record.factors.join(", ").toLowerCase()}`);
    }
  }
  return out;
}

function capacitySummary(trace) {
  const parts = [];
  for (const duty of trace.duty_periods ?? []) {
    const block = duty.effectiveness ?? {};
    if (block.workload_norm === null || block.workload_norm === undefined) continue;
    parts.push(`day ${duty.day_index} combined capacity ${pyFloatStr(block.combined_capacity)}% ` +
      `(effectiveness ${pyFloatStr(block.min_pct)}%, reservoir ${pyFloatStr(block.reservoir_pct)}%, ` +
      `workload ${pyFloatStr(block.workload_norm)}/100)`);
  }
  return parts.length ? parts.join("; ") : "not computed";
}

function delayPhrase(record) {
  let text = `day ${record.day_index} +${record.delay_minutes} min from ${record.from_flight || "the first leg"}`;
  if (record.layover_after_station) {
    text += `, ${record.layover_after_station} layover cut to ${hm(record.layover_after_hours ?? null)}`;
  }
  return text;
}

function bacPhrase(trace) {
  const scored = duties(trace);
  if (!scored.length) return "an unquantified level";
  const worst = minBy(scored, (d) => d.effectiveness.min_pct).effectiveness;
  const equivalent = worst.bac_equivalent;
  if (!equivalent || equivalent === "negligible") return "negligible impairment";
  return `a blood alcohol concentration of roughly ${equivalent.replace(/~/g, "").trim()}`;
}

/** Everything the report screen needs, in one object. */
export function buildReport(trace, factors = null, rescheduled = null, revisionsApplied = null) {
  return {
    narrative: narrative(trace),
    recommendations: recommendations(trace),
    watch: watchItems(trace),
    safety_report: safetyReport(trace, factors, rescheduled, revisionsApplied),
    revisions: revisionsApplied ?? [],
  };
}
