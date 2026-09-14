/**
 * wearables.js — port of wearables.py. Normalize sleep data from wearables and attach it to the
 * right layover.
 *
 * Spec principle 6: actuals override everything. Everything converges on one session shape, and
 * the matching step — the part that actually earns its keep — is pure interval arithmetic against
 * the trip's rest periods in UTC. No timezone guessing, no matching on local dates.
 *
 * **Python is the reference implementation.** This file is correct when it reproduces
 * `goldens/wearable_vectors.json`, which Python generated from the same fixtures the Python test
 * suite uses. The adapters have never seen a live vendor payload in either language; treat the
 * first real one as a test case.
 */

import { MODEL_PARAMS } from "./constants.js?v=24";
import { pyRepr, pyRound, pyStr } from "./py.js?v=24";
import { fmtUtc } from "./tz.js?v=24";

const HOUR = 3_600_000;
const MINUTE = 60_000;

// Sleep an app records as "in bed" is not sleep. When a vendor gives a measured efficiency we use
// it; when it only gives an interval we apply this — the honest midpoint of a bed-time interval.
export const ASSUMED_EFFICIENCY_FROM_INTERVAL = 0.88;

// A session has to overlap a rest period by at least this much to be attributed to it.
export const MIN_OVERLAP_HOURS = 0.5;

export const VENDORS = Object.freeze(["whoop", "oura", "apple_health", "generic"]);

/** Raised when a payload cannot be interpreted. Message is user-facing. */
export class WearableError extends Error {}

export class SleepSession {
  constructor({ start, end, efficiency, vendor = "generic", kind = "hotel_core",
                externalId = null, notes = null }) {
    this.start = start;                 // epoch ms, UTC
    this.end = end;
    this.efficiency = efficiency;
    this.vendor = vendor;
    this.kind = kind;
    this.externalId = externalId;
    this.notes = notes;
    this.restIndex = null;              // filled by matchToRestPeriods
    this.station = null;
    this.overlapHours = 0.0;
  }

  get hours() {
    return (this.end - this.start) / HOUR;
  }

  get effectiveHours() {
    return pyRound(this.hours * this.efficiency, 2);
  }

  toDict() {
    return {
      start_utc: fmtUtc(this.start),
      end_utc: fmtUtc(this.end),
      hours: pyRound(this.hours, 2),
      efficiency: pyRound(this.efficiency, 3),
      effective_hours: this.effectiveHours,
      vendor: this.vendor,
      type: this.kind,
      rest_index: this.restIndex,
      station: this.station,
      overlap_hours: pyRound(this.overlapHours, 2),
      notes: this.notes,
    };
  }
}

// ── Time parsing — vendors are inconsistent about offsets, so normalize hard ─

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?(?:([+-])(\d{2}):(\d{2})(?::\d{2})?)?)?$/;

/** Accept ISO-8601 with Z, with a numeric offset, or naive (treated as UTC). Returns epoch ms. */
export function parseTime(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WearableError(`Missing or unreadable timestamp: ${pyReprAny(value)}`);
  }

  let text = value.trim().replace(/Z/g, "+00:00").replace(/z/g, "+00:00");
  text = text.replace(/(\.\d{3})\d+/g, "$1");                  // trim sub-millisecond precision
  text = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");         // +0400 -> +04:00
  if (text.includes(" ") && !text.includes("T")) text = text.replace(" ", "T");

  const m = ISO_RE.exec(text);
  if (!m) throw new WearableError(`Unrecognized timestamp ${pyRepr(value)}`);
  const [, y, mo, d, hh = "0", mi = "0", ss = "0", frac = "", sign, oh, om] = m;
  const millis = frac ? Number(frac.slice(0, 3)) : 0;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), millis);
  // Python's datetime() rejects an impossible date or clock; Date.UTC would roll it over.
  const check = new Date(wall);
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 ||
      check.getUTCDate() !== Number(d) || check.getUTCHours() !== Number(hh) ||
      check.getUTCMinutes() !== Number(mi) || check.getUTCSeconds() !== Number(ss)) {
    throw new WearableError(`Unrecognized timestamp ${pyRepr(value)}`);
  }
  const offsetMinutes = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
  return wall - offsetMinutes * MINUTE;
}

function pyReprAny(value) {
  if (typeof value === "string") return pyRepr(value);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** Vendors report efficiency as 0-1 or 0-100; accept either. null when absent or unusable. */
function percent(value) {
  // Python's float(): None, "", and containers raise (-> None); bools are 0/1; strings parse.
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (typeof value === "object") return null;
  const number = Number(value);
  if (Number.isNaN(number)) return null;
  if (number <= 0) return null;
  return Math.min(1.0, number > 1.0 ? number / 100 : number);
}

// ── Vendor adapters ─────────────────────────────────────────────────────────

/** Whoop v1 sleep collection: records with `start`, `end`, `score.sleep_efficiency_percentage`. */
export function normalizeWhoop(payload) {
  return records(payload).map((record) => {
    const score = record.score || {};
    const efficiency = percent(score.sleep_efficiency_percentage);
    return new SleepSession({
      start: parseTime(record.start),
      end: parseTime(record.end),
      efficiency: efficiency || ASSUMED_EFFICIENCY_FROM_INTERVAL,
      vendor: "whoop",
      kind: record.nap ? "nap" : "hotel_core",
      externalId: record.id !== null && record.id !== undefined ? String(record.id) : null,
      notes: efficiency ? null : "No efficiency in payload; interval assumption applied.",
    });
  });
}

/** Oura v2 sleep documents: `bedtime_start`, `bedtime_end`, `efficiency`. */
export function normalizeOura(payload) {
  return records(payload).map((record) => {
    let efficiency = percent(record.efficiency);
    // Oura also gives total_sleep_duration in seconds — a truer efficiency when both exist.
    const total = record.total_sleep_duration;
    const start = parseTime(record.bedtime_start);
    const end = parseTime(record.bedtime_end);
    if (total && (end - start) / 1000 > 0) efficiency = Math.min(1.0, Number(total) / ((end - start) / 1000));
    return new SleepSession({
      start, end,
      efficiency: efficiency || ASSUMED_EFFICIENCY_FROM_INTERVAL,
      vendor: "oura",
      kind: record.type === "late_nap" ? "nap" : "hotel_core",
      externalId: record.id !== null && record.id !== undefined ? String(record.id) : null,
    });
  });
}

/**
 * HealthKit sleep-analysis samples. One sample per stage, so contiguous asleep samples are merged
 * into sessions. `inBed` samples are dropped — time in bed is not sleep, and counting it would
 * inflate the reservoir, which is the one direction this tool must never err in.
 */
export function normalizeAppleHealth(payload) {
  const asleep = [];
  for (const record of records(payload)) {
    const value = pyStr(record.value || record.categoryValue || "");
    if (value.toLowerCase().replace(/_/g, "").includes("inbed")) continue;
    if (!value.toLowerCase().includes("asleep") && value) continue;
    asleep.push([
      parseTime(record.startDate || record.start),
      parseTime(record.endDate || record.end),
    ]);
  }

  // Python sorts the (start, end) tuples: by start, then end.
  asleep.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of asleep) {
    if (merged.length && start - merged[merged.length - 1][1] <= 45 * MINUTE) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
    } else {
      merged.push([start, end]);
    }
  }

  return merged.map(([start, end]) => new SleepSession({
    start, end,
    efficiency: MODEL_PARAMS.nocturnal_sleep_efficiency,
    vendor: "apple_health",
    notes: "Merged from HealthKit stage samples; in-bed time excluded.",
  }));
}

/** `[{start_utc|start|startDate, end_utc|end|endDate, efficiency?}]` — manual entry and CSV import. */
export function normalizeGeneric(payload) {
  return records(payload).map((record) => {
    const start = record.start_utc || record.start || record.startDate;
    const end = record.end_utc || record.end || record.endDate;
    return new SleepSession({
      start: parseTime(start),
      end: parseTime(end),
      efficiency: percent(record.efficiency) || ASSUMED_EFFICIENCY_FROM_INTERVAL,
      vendor: pyStr(record.vendor || "generic"),
      kind: pyStr(record.type || "hotel_core"),
      notes: record.notes ?? null,
    });
  });
}

const ADAPTERS = {
  whoop: normalizeWhoop,
  oura: normalizeOura,
  apple_health: normalizeAppleHealth,
  generic: normalizeGeneric,
};

const isDict = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Unwrap the usual envelopes: a bare list, {data: []}, {records: []}, {sleep: []}. */
function records(payload) {
  let candidates;
  if (Array.isArray(payload)) {
    candidates = payload;
  } else if (isDict(payload)) {
    candidates = null;
    for (const key of ["data", "records", "sleep", "sessions", "results"]) {
      if (Array.isArray(payload[key])) { candidates = payload[key]; break; }
    }
    if (candidates === null) candidates = [payload];
  } else {
    throw new WearableError("Expected a JSON array or object of sleep records.");
  }

  const found = candidates.filter(isDict);
  if (!found.length) throw new WearableError("No sleep records found in that payload.");
  return found;
}

/** Returns { vendor, sessions }. Sniffs the vendor from field names when not told. */
export function detectAndNormalize(payload, vendor = null) {
  if (vendor) {
    const key = vendor.trim().toLowerCase();
    if (!(key in ADAPTERS)) {
      throw new WearableError(`Unknown vendor ${pyRepr(vendor)}. Expected one of: ${VENDORS.join(", ")}`);
    }
    return { vendor: key, sessions: ADAPTERS[key](payload) };
  }

  const sample = records(payload)[0];
  let detected;
  if ("bedtime_start" in sample) detected = "oura";
  else if ("score" in sample && "start" in sample) detected = "whoop";
  else if ("startDate" in sample ||
           ("value" in sample && pyStr(sample.value ?? "").toLowerCase().includes("sleep"))) detected = "apple_health";
  else detected = "generic";

  const sessions = ADAPTERS[detected](payload);
  if (!sessions.length) {
    throw new WearableError(`Read the payload as ${detected} but found no usable sleep periods in it.`);
  }
  return { vendor: detected, sessions };
}

// ── The part that matters: attach sessions to the right layover ─────────────

/**
 * Assign each session to the rest period it overlaps most, by UTC interval. Windows are widened
 * to the layover itself: a pilot who slept through the pre-report prep window still slept.
 */
export function matchToRestPeriods(trace, sessions) {
  const windows = [];
  (trace.rest_periods ?? []).forEach((rest, index) => {
    const window = rest.sleep_opportunity_window ?? {};
    if (window.start_utc && window.end_utc) {
      windows.push({
        index,
        start: parseTime(window.start_utc) - 2 * HOUR,
        end: parseTime(window.end_utc) + 1 * HOUR,
        station: rest.station ?? null,
      });
    }
  });

  for (const session of sessions) {
    let bestIndex = null;
    let bestOverlap = 0.0;
    let bestStation = null;
    for (const w of windows) {
      const overlap = (Math.min(w.end, session.end) - Math.max(w.start, session.start)) / HOUR;
      if (overlap > bestOverlap) {
        bestIndex = w.index;
        bestOverlap = overlap;
        bestStation = w.station;
      }
    }
    if (bestOverlap >= MIN_OVERLAP_HOURS) {
      session.restIndex = bestIndex;
      session.station = bestStation;
      session.overlapHours = bestOverlap;
    }
  }
  return sessions;
}

/** Shape the sessions for `scoreTrace({ actualSleep })`. */
export function toActualSleep(sessions) {
  return sessions.map((s) => ({
    start_utc: fmtUtc(s.start),
    end_utc: fmtUtc(s.end),
    efficiency: s.efficiency,
    type: s.kind,
    source: "actual",
  }));
}

/** What the pilot needs to see: which layovers the watch covered, and which it didn't. */
export function coverageSummary(trace, sessions) {
  const rests = trace.rest_periods ?? [];
  const attached = new Set(sessions.filter((s) => s.restIndex !== null).map((s) => s.restIndex));
  const uncovered = rests
    .map((rest, index) => ({ index, rest }))
    .filter(({ index }) => !attached.has(index))
    .map(({ rest }) => ({ after_duty_day: rest.after_duty_day ?? null, station: rest.station ?? null }));
  return {
    sessions: sessions.length,
    matched: attached.size,
    rest_periods: rests.length,
    unmatched_sessions: sessions.filter((s) => s.restIndex === null).length,
    uncovered_layovers: uncovered,
    total_measured_hours: pyRound(sessions.reduce((sum, s) => sum + s.effectiveHours, 0), 2),
  };
}

/** The same object POST /api/sleep/import returns. */
export function importSleep(payload, vendor = null) {
  const { vendor: detected, sessions } = detectAndNormalize(payload, vendor);
  return {
    vendor: detected,
    sessions: sessions.map((s) => s.toDict()),
    total_hours: pyRound(sessions.reduce((sum, s) => sum + s.hours, 0), 2),
  };
}
