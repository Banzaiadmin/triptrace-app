/**
 * engine.js — the on-device analysis entry point.
 *
 * This is what the app calls when it has Trip Board text: parse, score, write the report, exactly
 * as api.py's text path does server-side, but here in the browser (and later in the native app).
 * It is the same pipeline the differential proves equal to Python on every golden, so a report
 * produced on the device and one produced by the service are the same report.
 *
 * What still needs the service: reading a screenshot (the vision call and its API key), and the
 * wearable importers. Everything else — every number a pilot reads — runs here, with no server,
 * and therefore works with no signal.
 */

import { ParseError, parseTripBoard } from "./parser.js?v=28";
import { ScoringError, scoreTrace } from "./scorer.js?v=28";
import { buildReport } from "./report.js?v=28";
import { applyRevisions, normalizeRevisions, workloadPoints } from "./revisions.js?v=28";
import { WORKLOAD } from "./constants.js?v=28";
import {
  VENDORS,
  WearableError,
  coverageSummary,
  detectAndNormalize,
  importSleep as normalizeSleepPayload,
  matchToRestPeriods,
  toActualSleep,
} from "./wearables.js?v=28";

export const ENGINE = "device";
export const WEARABLE_VENDORS = VENDORS;
/** The condition labels the workload table knows, for the UI's chips. */
export const CONDITIONS = Object.freeze(Object.keys(WORKLOAD.points));

/** Carriers the parser can read. Mirrors api.py; anything else is refused, never approximated. */
export const CARRIERS = Object.freeze([
  { id: "ups", name: "UPS", available: true },
  { id: "fdx", name: "FedEx", available: false },
  { id: "dal", name: "Delta", available: false },
  { id: "aal", name: "American", available: false },
  { id: "ual", name: "United", available: false },
  { id: "swa", name: "Southwest", available: false },
]);

/** A user-facing failure. `message` is written to be shown as-is. */
export class EngineError extends Error {}

export function requireSupportedCarrier(carrier) {
  const id = (carrier || "ups").toLowerCase();
  const entry = CARRIERS.find((c) => c.id === id);
  if (!entry || !entry.available) {
    const name = entry ? entry.name : carrier;
    throw new EngineError(
      `${name} schedules aren't readable yet — every carrier prints its board differently ` +
        "and each needs its own parser. UPS is the one that's live.",
    );
  }
}

/**
 * Analyze transcribed Trip Board text. Returns the same shape as POST /api/analyze so the UI
 * renders either without caring where the numbers came from.
 */
export function analyzeText(text, {
  carrier = "ups",
  actualSleep = [],
  factors = [],
  rescheduled = [],
  revisions = [],
  domicile = null,
  domicileTz = null,
  stationTzOverrides = null,
} = {}) {
  requireSupportedCarrier(carrier);

  let trace;
  try {
    trace = parseTripBoard(text, { domicile, domicileTz, stationTzOverrides });
  } catch (error) {
    if (error instanceof ParseError) throw new EngineError(error.message);
    throw error;
  }

  // What actually happened: delays change the timeline before anything is modeled; conditions
  // become workload. Same order as api.py's _finish.
  const clean = normalizeRevisions(revisions);
  const revised = applyRevisions(trace, clean);
  trace = revised.trace;
  const applied = revised.applied;
  const workload = workloadPoints((trace.duty_periods ?? []).map((d) => d.day_index), clean, factors);

  // Score if possible, degrade to the parsed trace otherwise — trip structure is still worth
  // reading without effectiveness numbers (same policy as api.py's _finish, step for step).
  let scored = false;
  let scoringError = null;
  let coverage = null;
  let sessions = [];
  if (actualSleep.length) {
    try {
      sessions = matchToRestPeriods(trace, detectAndNormalize(actualSleep, "generic").sessions);
      coverage = coverageSummary(trace, sessions);
    } catch (error) {
      if (!(error instanceof WearableError)) throw error;
      scoringError = `Sleep data ignored: ${error.message}`;
      sessions = [];
    }
  }
  try {
    trace = scoreTrace(trace, {
      actualSleep: sessions.length ? toActualSleep(sessions) : null,
      workload: Object.keys(workload).length ? workload : null,
    });
    scored = true;
  } catch (error) {
    if (!(error instanceof ScoringError)) throw error;
    scoringError = error.message;
  }

  return {
    trace,
    valid: null,                        // schema validation is the service's job; not claimed here
    schema_errors: [],
    transcript: text,
    transcription_model: null,
    scored,
    scoring_error: scoringError,
    sleep_coverage: coverage,
    report: scored ? buildReport(trace, factors, rescheduled, applied) : null,
    revisions_applied: applied,
    engine: ENGINE,
  };
}

/**
 * Normalize a wearable export into sleep sessions — the same object POST /api/sleep/import
 * returns. `payload` is the parsed JSON of the file the pilot chose.
 */
export function importSleep(payload, vendor = null) {
  try {
    return normalizeSleepPayload(payload, vendor);
  } catch (error) {
    if (error instanceof WearableError) throw new EngineError(error.message);
    throw error;
  }
}
