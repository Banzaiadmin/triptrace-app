/**
 * parser.js — port of trip_board_parser.py. UPS Trip Board text -> TripTrace.
 *
 * Structure mirrors the Python module section for section so the two can be read side by side.
 * **Python is the reference implementation**: this file is correct when it reproduces the `parsed`
 * member of every golden in `goldens/`. Never change a rule here to make a diff pass — change the
 * Python, re-freeze, then port.
 *
 * Design rules, straight from TRIP_TRACE_SPEC.md:
 *   * Zulu is canonical. Every instant is stored as a UTC ISO-8601 string; `station_local` and
 *     `body_clock` are derived views computed from it, never parsed independently.
 *   * Printed beats computed. `Blk`, `Duty`, `L/O` and the footer totals are taken as
 *     authoritative. Report/release are not printed, so they are *solved* (see
 *     `solveDutyAllowances`) rather than assumed, and marked `source: "computed"`.
 *   * Nothing is silently guessed. Unknown stations, unreadable rows, and any cross-check that
 *     fails land in `missing_data[]` with the value left null.
 *
 * What this module does NOT do: model sleep or score effectiveness. `sleep_events` is left empty
 * and every `effectiveness` block null — those are the scorer's output.
 *
 * Timezones go through `./tz.js` only. If a runtime lacks IANA data, swap that adapter.
 */

import {
  AUGMENTATION_RULES,
  CONTRACT_REST_FLOORS,
  DEBRIEF_HOURS,
  DOMESTIC_COUNTRIES,
  MODEL_PARAMS,
  NEAR_FLOOR_MARGIN_HOURS,
  REPORT_ALLOWANCE_HOURS,
  SLEEP_OPPORTUNITY_SUBTRACTIONS,
  STATIONS,
} from "./constants.js?v=30";
import { deepCopy, hmFromMinutes, pyFmt, pyRepr, pyRound, splitLines, uniqueInOrder } from "./py.js?v=30";
import {
  HOUR,
  MINUTE,
  WEEKDAY_CODES,
  addDays,
  fmtLocal,
  fmtUtc,
  localParts,
  localToUtc,
  utcOffsetMinutes,
} from "./tz.js?v=30";

/** Raised only when the text contains no recognizable Trip Board rows at all. */
export class ParseError extends Error {}

// ── Parser-local constants (model constants come from constants.js) ─────────

// Python's weekday(): Monday=0 ... Sunday=6
const DOW_CODES = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

// Plausibility envelope for solved duty allowances, in minutes. Outside these the solve is treated
// as contradicted by the data and the spec 2C defaults are used instead (and the day is flagged).
const MIN_SOLVED_ALLOWANCE_MIN = 15;
const MAX_SOLVED_ALLOWANCE_MIN = 180;
const MAX_SOLVED_DEBRIEF_MIN = 60;

// Tolerance when cross-checking printed footer totals against the sum of printed rows.
const TOTALS_TOLERANCE_MIN = 1;

// Two-digit years on the Trip Board are 20xx.
const CENTURY = 2000;

const HEADER_RE =
  /Trip\s*Details\s*[-–]\s*(?<trip>[A-Z0-9?]+)\s*[-–]\s*(?<domicile>[A-Z]{3})\s+(?<fleet>[A-Z0-9/?]+)/i;

const LEG_RE = new RegExp(
  "^\\s*(?:(?<eqp>[A-Z]{1,4})\\s+)?" +
  "(?<date>\\d{1,2}/\\d{1,2}/\\d{2,4})\\s+" +
  "(?<pairing>[A-Z0-9]+)\\s+" +
  "(?<flt>[A-Z0-9]+)\\s+" +
  "(?<pos>[A-Z0-9/]+)\\s+" +
  "(?<dep>[A-Z]{3})\\s+" +
  "\\((?<dep_dow>[A-Z]{2})?(?<dep_lh>\\d{1,2})\\)\\s*(?<dep_z>\\d{1,2}:\\d{2})\\s+" +
  "(?<arr>[A-Z]{3})\\s+" +
  "\\((?<arr_dow>[A-Z]{2})?(?<arr_lh>\\d{1,2})\\)\\s*(?<arr_z>\\d{1,2}:\\d{2})\\s+" +
  "(?<blk>\\d{1,3}:\\d{2})\\s*$",
);

const SUMMARY_RE =
  /^\s*(?<blk>\d{1,3}:\d{2})\s+(?<duty>\d{1,3}:\d{2})\s+(?:(?<cr>\d{1,3}:\d{2}[A-Z]?)\s+)?(?<lo>\d{1,3}:\d{2})\s*$/;

const COLUMN_HEADER_RE = /Pairing.*Blk.*Duty/i;
const FOOTER_HINT_RE = /TAFB|Duty\s*Days|PDiem|Out\s*Credit/i;
const NOISE_RE = /^\s*(close|done|back|menu)\s*$/i;

const DEADHEAD_FLT_RE = /^(CML|DHD|DH)$/i;

// ── Station registry (stations.py) ──────────────────────────────────────────

function lookupStation(station, overrides) {
  const code = (station || "").trim().toUpperCase();
  if (overrides && code in overrides) return [overrides[code], "??"];
  return STATIONS[code] ?? null;
}

export function stationTz(station, overrides) {
  const hit = lookupStation(station, overrides);
  return hit ? hit[0] : null;
}

/** True/false for a known station, null when unknown (caller must flag, not guess). */
function isDomestic(station, overrides) {
  const hit = lookupStation(station, overrides);
  if (!hit || hit[1] === "??") return null;
  return DOMESTIC_COUNTRIES.includes(hit[1]);
}

// ── Small time helpers — durations are whole minutes to avoid float drift ───

/** '10:46' -> 646. null for '?' / unparseable. */
function hmToMinutes(text) {
  if (!text) return null;
  const m = /^(\d{1,3}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToHours(minutes) {
  return minutes === null ? null : pyRound(minutes / 60, 6);
}

function parseRowDate(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text.trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += CENTURY;
  return { year, month: Number(m[1]), day: Number(m[2]) };
}

const pad2 = (n) => String(n).padStart(2, "0");

// ── Row model ───────────────────────────────────────────────────────────────

/** One flight row, pre-timezone-resolution. */
class LegRow {
  constructor(groups, line) {
    this.line = line.trim();
    this.eqp = groups.eqp ?? null;
    this.date = parseRowDate(groups.date);
    this.pairing = groups.pairing;
    this.flight = groups.flt;
    this.position = groups.pos;
    this.depStation = groups.dep;
    this.arrStation = groups.arr;
    this.depDow = groups.dep_dow ?? null;
    this.arrDow = groups.arr_dow ?? null;
    this.depLocalHour = Number(groups.dep_lh);
    this.arrLocalHour = Number(groups.arr_lh);
    this.depZuluMin = hmToMinutes(groups.dep_z);
    this.arrZuluMin = hmToMinutes(groups.arr_z);
    this.blockMin = hmToMinutes(groups.blk);

    const commercial = DEADHEAD_FLT_RE.test(this.flight);
    this.isDeadhead = Boolean((this.eqp && this.eqp.toUpperCase() === "DH") || commercial);
    if (commercial) this.deadheadKind = "commercial";
    else if (this.isDeadhead) this.deadheadKind = "company";
    else this.deadheadKind = null;

    // Resolved later, once timezones are applied.
    this.depUtc = null;
    this.arrUtc = null;
  }
}

/** The indented totals line that closes a duty period. */
class SummaryRow {
  constructor(groups, line) {
    this.line = line.trim();
    this.blockMin = hmToMinutes(groups.blk);
    this.dutyMin = hmToMinutes(groups.duty);
    this.credit = groups.cr ?? null;
    this.layoverMin = hmToMinutes(groups.lo);
  }
}

/** Accumulates missing_data[] so nothing has to be guessed to keep parsing. */
class Collector {
  constructor() {
    this.items = [];
  }

  add(kind, detail, wouldChange = null) {
    this.items.push({ kind, detail, would_change: wouldChange });
  }
}

// ── Stage 1 — text to rows ──────────────────────────────────────────────────

/** Undo the spacing damage OCR does to `(SU15)19:54` and `8 / 3 / 26`. */
function normalize(line) {
  line = line.replace(/–/g, "-").replace(/—/g, "-");
  line = line.replace(/\)\s+(?=\d{1,2}:\d{2})/g, ")");      // `(SU15) 19:54` -> `(SU15)19:54`
  line = line.replace(/(?<=\d)\s*\/\s*(?=\d)/g, "/");        // `8 / 3 / 26`    -> `8/3/26`
  line = line.replace(/(?<=\d)\s*:\s*(?=\d{2})/g, ":");      // `19 : 54`       -> `19:54`
  return line.trimEnd();
}

/** Return { rows (ordered), info (footer/header fields) }. */
function scan(text, missing) {
  const rows = [];
  const info = {};
  const setDefault = (key, value) => { if (!(key in info)) info[key] = value; };

  for (const rawLine of splitLines(text)) {
    const line = normalize(rawLine);
    if (!line.trim()) continue;

    const header = HEADER_RE.exec(line);
    if (header) {
      setDefault("title", line.trim());
      setDefault("trip_number", header.groups.trip);
      setDefault("header_domicile", header.groups.domicile.toUpperCase());
      setDefault("header_fleet", header.groups.fleet);
      continue;
    }

    if (COLUMN_HEADER_RE.test(line) || NOISE_RE.test(line)) continue;

    const leg = LEG_RE.exec(line);
    if (leg) {
      rows.push(new LegRow(leg.groups, line));
      continue;
    }

    const summary = SUMMARY_RE.exec(line);
    if (summary) {
      rows.push(new SummaryRow(summary.groups, line));
      continue;
    }

    if (FOOTER_HINT_RE.test(line)) {
      Object.assign(info, parseFooter(line));
      continue;
    }

    missing.add(
      line.includes("?") ? "cut_off" : "ambiguous",
      `Unparsed Trip Board line: ${pyRepr(line.trim())}`,
      "Any leg, duty, or layover this line encodes is absent from the trace.",
    );
  }

  return { rows, info };
}

function parseFooter(line) {
  const out = {};
  const patterns = {
    footer_credit_min: /Credit:\s*(\d{1,4}:\d{2})/i,
    footer_block_min: /\bBlk:\s*(\d{1,4}:\d{2})/i,
    footer_tafb_min: /TAFB:\s*(\d{1,4}:\d{2})/i,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const m = pattern.exec(line);
    if (m) out[key] = hmToMinutes(m[1]);
  }
  const days = /Duty\s*Days:\s*(\d{1,2})/i.exec(line);
  if (days) out.footer_duty_days = Number(days[1]);
  return out;
}

/** A duty period is a run of leg rows terminated by its summary row. */
// A ground gap at least this long is a rest period, not a sit. See trip_board_parser.py.
const MIN_GAP_THAT_IS_REST_HOURS = Math.min(
  ...Object.values(CONTRACT_REST_FLOORS).map((f) => f.reducible_to),
);

/**
 * Split a run of legs wherever the clock says a rest period sits between them. A totals row the
 * reader loses silently welds two duty periods into one; the clock is the check the layout cannot
 * corrupt. Same reasoning, and the same worked example, as trip_board_parser.py.
 */
function splitOnRestSizedGaps(legs, missing) {
  const runs = [[legs[0]]];
  for (let i = 1; i < legs.length; i += 1) {
    const previous = legs[i - 1], leg = legs[i];
    const gapHours = (previous.arrUtc !== null && previous.arrUtc !== undefined
      && leg.depUtc !== null && leg.depUtc !== undefined)
      ? (leg.depUtc - previous.arrUtc) / HOUR : null;
    if (gapHours !== null && gapHours >= MIN_GAP_THAT_IS_REST_HOURS) {
      missing.add(
        "time_conflict",
        `${previous.flight} arrives ${fmtGap(previous.arrUtc)} and ${leg.flight} departs `
          + `${fmtGap(leg.depUtc)}, a gap of ${hmFromMinutes(Math.round(gapHours * 60))}. `
          + "That is a rest period, not a sit, so these were split into separate duty periods — "
          + "the totals row between them was not read.",
        "The printed Duty and L/O for the earlier duty period; report and release for it "
          + "fall back to spec 2C defaults.",
      );
      runs.push([leg]);
    } else {
      runs[runs.length - 1].push(leg);
    }
  }
  return runs;
}

const fmtGap = (ms) => {
  const d = new Date(ms);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${String(d.getUTCDate()).padStart(2, "0")} ${month} `
    + `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
};

function groupDutyPeriods(rows, missing) {
  const groups = [];
  let pending = [];
  for (const row of rows) {
    if (row instanceof LegRow) {
      pending.push(row);
    } else {
      if (!pending.length) {
        missing.add(
          "ambiguous",
          `Summary line ${pyRepr(row.line)} has no flight rows above it.`,
          "A duty period's Duty/L/O totals could not be attached to any legs.",
        );
        continue;
      }
      // The summary row belongs to the last run; anything split off ahead of it lost its own.
      const runs = splitOnRestSizedGaps(pending, missing);
      for (const run of runs.slice(0, -1)) groups.push({ legs: run, summary: null });
      groups.push({ legs: runs[runs.length - 1], summary: row });
      pending = [];
    }
  }
  if (pending.length) {
    const runs = splitOnRestSizedGaps(pending, missing);
    for (const run of runs.slice(0, -1)) groups.push({ legs: run, summary: null });
    pending = runs[runs.length - 1];
    missing.add(
      "cut_off",
      `${pending.length} flight row(s) after the last summary line — the duty totals row is missing ` +
        "(screenshot likely cut off).",
      "Duty length and layover for the final duty period; report/release fall back to " +
        "spec 2C defaults.",
    );
    groups.push({ legs: pending, summary: null });
  }
  return groups;
}

// ── Stage 2 — timezones and UTC resolution ──────────────────────────────────

/** Fill depUtc/arrUtc from the row date + Zulu clock, and cross-check the printed locals. */
function resolveTimes(legs, overrides, missing) {
  let previousArrival = null;

  for (const leg of legs) {
    if (leg.date === null || leg.depZuluMin === null || leg.arrZuluMin === null) {
      missing.add(
        "cut_off",
        `Row ${pyRepr(leg.line)} is missing its date or a Zulu time.`,
        "This leg is dropped from the trace; duty span and totals will be short.",
      );
      continue;
    }

    const { year, month, day } = leg.date;
    const base = Date.UTC(year, month - 1, day);
    // Python's datetime() refuses an impossible calendar date; Date.UTC would roll it over.
    const check = new Date(base);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new ParseError(`Row ${pyRepr(leg.line)} carries an impossible calendar date.`);
    }
    leg.depUtc = base + leg.depZuluMin * MINUTE;
    leg.arrUtc = base + leg.arrZuluMin * MINUTE;
    if (leg.arrUtc < leg.depUtc) leg.arrUtc += 24 * HOUR;       // arrival rolled past 0000Z

    if (previousArrival !== null && leg.depUtc < previousArrival) {
      missing.add(
        "time_conflict",
        `Leg ${leg.flight} departs ${fmtUtc(leg.depUtc)} before the previous leg arrives ${fmtUtc(previousArrival)}.`,
        "Duty span, and therefore report/release placement on the circadian timeline.",
      );
    }
    previousArrival = leg.arrUtc;

    crossCheckLocal(leg, leg.depStation, leg.depUtc, leg.depLocalHour, leg.depDow,
                    "departure", overrides, missing);
    crossCheckLocal(leg, leg.arrStation, leg.arrUtc, leg.arrLocalHour, leg.arrDow,
                    "arrival", overrides, missing);
  }
}

/**
 * Spec 2A: the `(L)` parenthetical is a cross-check on Zulu. Disagreement is never resolved by
 * guessing — it is recorded as a time_conflict.
 */
function crossCheckLocal(leg, station, utcMs, printedHour, printedDow, which, overrides, missing) {
  const tzName = stationTz(station, overrides);
  if (tzName === null) {
    missing.add(
      "ambiguous",
      `Station ${station} is not in the timezone table (leg ${leg.flight} ${which}).`,
      "station_local and body-clock placement for this leg; UTC is unaffected.",
    );
    return;
  }

  const local = localParts(tzName, utcMs);
  if (local.hour !== printedHour) {
    missing.add(
      "time_conflict",
      `Leg ${leg.flight} ${which} at ${station}: Zulu ${fmtUtc(utcMs)} converts to local hour ` +
        `${pad2(local.hour)}, but the screen prints (${pad2(printedHour)}).`,
      "The leg's true clock time, and every duty/WOCL overlap derived from it.",
    );
  }
  if (printedDow && (DOW_CODES[printedDow.toUpperCase()] ?? null) !== local.weekday) {
    missing.add(
      "time_conflict",
      `Leg ${leg.flight} ${which} at ${station}: Zulu ${fmtUtc(utcMs)} is local ` +
        `${WEEKDAY_CODES[local.weekday]}, but the screen prints (${printedDow.toUpperCase()}).`,
      "Which calendar day the leg falls on, and therefore the duty-day grouping.",
    );
  }
}

// ── Stage 3 — duty construction (solve, don't assume) ───────────────────────

function defaultAllowanceMin(originInDomicile, international) {
  let key;
  if (international) key = originInDomicile ? "international_in_domicile" : "international_away";
  else key = originInDomicile ? "domestic_in_domicile" : "domestic_away";
  return pyRound(REPORT_ALLOWANCE_HOURS[key] * 60, 0);
}

function defaultDebriefMin(international) {
  return pyRound(DEBRIEF_HOURS[international ? "international" : "domestic"] * 60, 0);
}

/**
 * Chain-solve [allowance, debrief, method] per duty day from printed Duty and L/O.
 *
 *   "solved"  — both ends came out of printed data;
 *   "partial" — the report allowance came from the printed L/O chain but Duty was not printed, so
 *               the debrief is a spec 2C default (a truncated screenshot does this to the last day);
 *   "default" — the spec 2C table, because printed data did not determine it.
 */
function solveDutyAllowances(spans, printedDuty, printedLayover, gaps, defaultAllowances,
                             defaultDebriefs, missing) {
  const count = spans.length;
  const result = [];
  let allowance = count ? defaultAllowances[0] : null;

  for (let day = 0; day < count; day += 1) {
    const span = spans[day];
    const duty = printedDuty[day];
    const total = span === null || duty === null ? null : duty - span;
    const chained = allowance !== null &&
      MIN_SOLVED_ALLOWANCE_MIN <= allowance && allowance <= MAX_SOLVED_ALLOWANCE_MIN;

    let a;
    let b;
    let method;
    if (total === null) {
      // No printed Duty for this day. The report allowance may still be pinned by the preceding
      // printed L/O — keep it rather than discarding printed evidence.
      if (chained) {
        [a, b, method] = [allowance, defaultDebriefs[day], "partial"];
      } else {
        [a, b] = fallbackSplit(null, defaultAllowances[day], defaultDebriefs[day]);
        method = "default";
      }
    } else if (allowance === null) {
      let ok;
      [a, b, ok] = fallbackSplit(total, defaultAllowances[day], defaultDebriefs[day]);
      method = "default";
      if (!ok) {
        missing.add(
          "time_conflict",
          `Duty day ${day + 1}: printed Duty leaves ${total} min for report+debrief, outside the ` +
            "plausible envelope.",
          "Report/release placement on the circadian timeline for this duty day.",
        );
      }
    } else {
      a = allowance;
      b = total - a;
      if (MIN_SOLVED_ALLOWANCE_MIN <= a && a <= MAX_SOLVED_ALLOWANCE_MIN && 0 <= b && b <= MAX_SOLVED_DEBRIEF_MIN) {
        method = "solved";
      } else {
        [a, b] = fallbackSplit(total, defaultAllowances[day], defaultDebriefs[day]);
        method = "default";
        missing.add(
          "time_conflict",
          `Duty day ${day + 1}: printed Duty and the preceding L/O imply a report allowance / ` +
            "debrief outside the plausible envelope; spec 2C defaults used instead.",
          "Report/release placement on the circadian timeline for this duty day.",
        );
      }
    }

    result.push([a, b, method]);

    // Carry the chain: debrief[d] + L/O[d] + allowance[d+1] == gap[d]
    if (day + 1 < count) {
      const gap = gaps[day];
      const layover = printedLayover[day];
      allowance = gap === null || layover === null ? null : gap - layover - b;
    }
  }

  return result;
}

/**
 * Split a printed report+debrief total using spec defaults, holding debrief steady where it fits
 * and absorbing the remainder into the report allowance.
 */
function fallbackSplit(total, defaultA, defaultB) {
  if (total === null) return [defaultA, defaultB, true];
  let b = Math.min(defaultB, Math.max(0, total));
  let a = total - b;
  if (a < MIN_SOLVED_ALLOWANCE_MIN) {
    a = Math.min(MIN_SOLVED_ALLOWANCE_MIN, Math.max(0, total));
    b = total - a;
  }
  if (a > MAX_SOLVED_ALLOWANCE_MIN) {
    a = MAX_SOLVED_ALLOWANCE_MIN;
    b = total - a;
  }
  const ok = a >= 0 && 0 <= b && b <= MAX_SOLVED_DEBRIEF_MIN && a + b === total;
  return [a, b, ok];
}

// ── Stage 4 — assembly ──────────────────────────────────────────────────────

/**
 * Parse a transcribed Trip Board into a schema-shaped TripTrace object (nulls pruned — the
 * schema's `confidence` and `source` enums have no null member).
 *
 * `domicile` defaults to the station in the screen title (`Trip Details - 2517 - SDF 757`), and
 * `domicileTz` to that station's zone. Pass either explicitly to override.
 */
export function parseTripBoard(text, {
  domicile = null,
  domicileTz = null,
  stationTzOverrides = null,
  generatedAt = null,
  notes = null,
} = {}) {
  const missing = new Collector();
  const { rows, info } = scan(text, missing);

  const legRows = rows.filter((r) => r instanceof LegRow);
  if (!legRows.length) {
    throw new ParseError(
      "No Trip Board flight rows recognized. Expected lines like " +
        "'8/4/26 25172 2941 CPT OAK (TU06)13:35 PHL (14)18:35 5:00'.",
    );
  }

  domicile = (domicile || info.header_domicile || "SDF").toUpperCase();
  domicileTz = domicileTz || stationTz(domicile, stationTzOverrides) || "America/New_York";
  try {
    utcOffsetMinutes(domicileTz, 0);                       // zoneinfo would raise here too
  } catch (error) {
    throw new ParseError(`Unknown domicile timezone ${pyRepr(domicileTz)}.`);
  }

  resolveTimes(legRows, stationTzOverrides, missing);
  let groups = groupDutyPeriods(rows, missing);
  groups = groups.filter((g) => g.legs.some((l) => l.depUtc !== null));
  if (!groups.length) {
    throw new ParseError("Flight rows were found but none carried a usable date and Zulu time.");
  }

  const pairingId = resolvePairingId(legRows, info, missing);

  // --- per-duty-day inputs for the allowance solve ---
  const spans = [];
  const printedDuty = [];
  const printedLayover = [];
  const defaultAllowances = [];
  const defaultDebriefs = [];

  for (const { legs, summary } of groups) {
    const timed = legs.filter((l) => l.depUtc !== null && l.arrUtc !== null);
    spans.push(timed.length
      ? Math.floor((timed[timed.length - 1].arrUtc - timed[0].depUtc) / MINUTE) : null);
    printedDuty.push(summary ? summary.dutyMin : null);
    printedLayover.push(summary ? summary.layoverMin : null);
    const intl = timed.some((l) => legIsInternational(l, stationTzOverrides));
    const origin = timed.length ? timed[0].depStation : "";
    defaultAllowances.push(defaultAllowanceMin(origin.toUpperCase() === domicile, intl));
    defaultDebriefs.push(defaultDebriefMin(intl));
  }

  const gaps = [];
  for (let index = 0; index < groups.length - 1; index += 1) {
    const thisTimed = groups[index].legs.filter((l) => l.arrUtc !== null);
    const nextTimed = groups[index + 1].legs.filter((l) => l.depUtc !== null);
    if (thisTimed.length && nextTimed.length) {
      gaps.push(Math.floor((nextTimed[0].depUtc - thisTimed[thisTimed.length - 1].arrUtc) / MINUTE));
    } else {
      gaps.push(null);
    }
  }

  const allowances = solveDutyAllowances(
    spans, printedDuty, printedLayover, gaps, defaultAllowances, defaultDebriefs, missing,
  );

  // --- build duty periods ---
  const dutyPeriods = [];
  const restPeriods = [];
  const allStations = [];

  groups.forEach(({ legs, summary }, index) => {
    const timed = legs.filter((l) => l.depUtc !== null && l.arrUtc !== null);
    const [allowanceMin, debriefMin, method] = allowances[index];
    const reportUtc = timed[0].depUtc - allowanceMin * MINUTE;
    const releaseUtc = timed[timed.length - 1].arrUtc + debriefMin * MINUTE;

    const builtLegs = [];
    legs.forEach((row, position) => {
      if (!(row.depUtc !== null && row.arrUtc !== null)) return;
      allStations.push(row.depStation, row.arrStation);
      const isLast = position === legs.length - 1;
      builtLegs.push(buildLeg(row, domicileTz, stationTzOverrides, missing,
                              summary && isLast ? summary.credit : null));
    });

    const circadian = buildCircadian(reportUtc, releaseUtc, domicileTz, index);

    let nextReport = null;
    if (index + 1 < groups.length) {
      const nextTimed = groups[index + 1].legs.filter((l) => l.depUtc !== null);
      if (nextTimed.length) nextReport = nextTimed[0].depUtc - allowances[index + 1][0] * MINUTE;
    }

    const layover = buildLayover(
      summary, timed.length ? timed[timed.length - 1].arrStation : null, domicile,
      stationTzOverrides, index === groups.length - 1, missing, releaseUtc, nextReport,
    );

    dutyPeriods.push({
      day_index: index + 1,
      report: clock(reportUtc, timed[0].depStation, domicileTz, stationTzOverrides, "computed"),
      release: clock(releaseUtc, timed[timed.length - 1].arrStation, domicileTz, stationTzOverrides, "computed"),
      legs: builtLegs,
      date_local: fmtLocal(stationTz(timed[0].depStation, stationTzOverrides) || domicileTz, reportUtc).slice(0, 10),
      scheduled_duty: {
        scheduled_hours: minutesToHours(summary ? summary.dutyMin : null),
        actual_hours: null,
        source: summary && summary.dutyMin !== null ? "printed" : "computed",
      },
      landings: legs.filter((l) => !l.isDeadhead && l.depUtc !== null).length,
      circadian,
      layover_after: layover,
      effectiveness: null,                                 // scorer output
      confidence: method === "solved" ? "high" : "medium",
    });

    if (layover !== null) {
      restPeriods.push(buildRestPeriod(index + 1, layover, releaseUtc, nextReport));
    }
  });

  const trace = {
    meta: {
      domicile,
      domicile_tz: domicileTz,
      operator: "UPS",
      fleet: String(info.header_fleet ?? "757/767"),
      operation: "night_cargo",
      generated_at: generatedAt || fmtUtc(Date.now()),
      source_screens: ["trip_board"],
      pilot_reported_actuals: false,
      notes: notes || defaultNotes(info),
    },
    pairing: buildPairing(pairingId, groups, dutyPeriods, info, allStations,
                          stationTzOverrides, domicileTz, missing),
    duty_periods: dutyPeriods,
    schema_version: "1.0",
    rest_periods: restPeriods,
    model_params: deepCopy(MODEL_PARAMS),
    outputs: null,                                         // scorer output
    missing_data: missing.items,
  };

  addStandingGaps(trace, missing);
  return prune(trace);
}

/** Prefer the Pairing column (it repeats on every row) over the screen title. */
function resolvePairingId(legRows, info, missing) {
  const values = [...new Set(legRows.map((r) => r.pairing).filter(Boolean))].sort();
  if (values.length > 1) {
    missing.add(
      "ambiguous",
      `Rows carry more than one pairing id: ${values.join(", ")}.`,
      "Which pairing this trace represents.",
    );
  }
  const pairingId = values.length ? values[0] : String(info.trip_number ?? "UNKNOWN");

  // The Trip Board title carries the pairing's leading digits ("2517" for pairing 25172) — a
  // display convention, not a disagreement. Only a title that is NOT a prefix is flagged.
  const titleId = info.trip_number;
  if (titleId && titleId !== pairingId && !pairingId.startsWith(titleId)) {
    missing.add(
      "ambiguous",
      `Screen title says trip ${titleId} but the Pairing column says ${pairingId}; the column value is used.`,
      "Nothing in the fatigue math — identification only.",
    );
  }
  return pairingId;
}

function legIsInternational(leg, overrides) {
  const dep = isDomestic(leg.depStation, overrides);
  const arr = isDomestic(leg.arrStation, overrides);
  // Unknown station: do not assume international (it would change augmentation and the rest
  // floor). The unknown station is already recorded by crossCheckLocal.
  if (dep === null || arr === null) return false;
  return !(dep && arr);
}

/**
 * The three-clock view. body_clock is the domicile-anchored view with zero drift — the scorer
 * owns drift (MODEL_PARAMS.body_clock_drift_cap_hours_per_day).
 */
function clock(utcMs, station, domicileTz, overrides, source) {
  const tzName = station ? stationTz(station, overrides) : null;
  return {
    utc: fmtUtc(utcMs),
    station_local: tzName ? fmtLocal(tzName, utcMs) : null,
    station_tz: tzName,
    body_clock: fmtLocal(domicileTz, utcMs),
    source,
  };
}

function buildLeg(row, domicileTz, overrides, missing, dutyCredit) {
  const intl = legIsInternational(row, overrides);
  const raw = {
    eqp: row.eqp,
    flight_printed: row.flight,
    deadhead: row.isDeadhead,
    printed_dep_local: `(${row.depDow || ""}${pad2(row.depLocalHour)})`,
    printed_arr_local: `(${row.arrDow || ""}${pad2(row.arrLocalHour)})`,
  };
  if (row.deadheadKind) raw.deadhead_kind = row.deadheadKind;
  if (dutyCredit) raw.duty_summary_cr = dutyCredit;      // pay credit — ignored for fatigue (spec 2A)

  if (row.blockMin === 0 && !row.isDeadhead) {
    missing.add(
      "ambiguous",
      `Leg ${row.flight} ${row.depStation}-${row.arrStation} prints 0:00 block but is not marked DH or CML.`,
      "Whether this leg counts as a landing and as flying time.",
    );
  }

  return {
    flight: row.flight,
    dep_station: row.depStation,
    arr_station: row.arrStation,
    dep: clock(row.depUtc, row.depStation, domicileTz, overrides, "printed"),
    arr: clock(row.arrUtc, row.arrStation, domicileTz, overrides, "printed"),
    position: row.position,
    block: { scheduled_hours: minutesToHours(row.blockMin), actual_hours: null, source: "printed" },
    is_international: intl,
    augmentation: buildAugmentation(row, intl),
    effectiveness: null,                                   // scorer output
    raw,
  };
}

/** Spec 2D applies to international flying only; deadheads carry no crew complement. */
function buildAugmentation(row, international) {
  if (!international || row.isDeadhead || row.blockMin === null) return null;
  const blockHours = row.blockMin / 60;
  for (const rule of AUGMENTATION_RULES) {
    if (blockHours <= rule.block_max) {
      const [low, high] = rule.bunk_target;
      return {
        crew_size: rule.crew,
        has_bunk: rule.bunk,
        bunk_window: null,                                 // placement in cruise is a scorer judgment
        bunk_target_hours: rule.bunk ? pyRound((low + high) / 2, 2) : null,
        bunk_quality_factor: rule.bunk ? MODEL_PARAMS.bunk_quality_factor : null,
        bunk_credit_hours: null,
      };
    }
  }
  return null;
}

/** WOCL is 0200-0600 *body-clock*; expressed here in UTC for the day it actually bears on. */
function buildCircadian(reportUtc, releaseUtc, domicileTz, dayIndex0) {
  const offsetHours = utcOffsetMinutes(domicileTz, reportUtc) / 60;
  const [startH, startM] = MODEL_PARAMS.wocl_body_clock_start.split(":").map(Number);
  const [endH, endM] = MODEL_PARAMS.wocl_body_clock_end.split(":").map(Number);

  let best = null;
  const bodyDate = localParts(domicileTz, reportUtc);
  for (const offsetDays of [0, 1]) {
    const day = addDays(bodyDate, offsetDays);
    const start = localToUtc(domicileTz, day.year, day.month, day.day, startH, startM);
    const end = localToUtc(domicileTz, day.year, day.month, day.day, endH, endM);
    const overlap = (Math.min(end, releaseUtc) - Math.max(start, reportUtc)) / 1000;
    const distance = overlap > 0 ? 0
      : Math.min(Math.abs(start - releaseUtc), Math.abs(reportUtc - end)) / 1000;
    const score = overlap > 0 ? overlap : -distance;
    if (best === null || score > best.score) best = { score, start, end };
  }

  return {
    body_clock_anchor_tz_offset_hours: offsetHours,
    anchor_basis: `domicile ${domicileTz}; parser applies zero drift — the scorer applies drift up to ` +
      `${pyFmt(MODEL_PARAMS.body_clock_drift_cap_hours_per_day, 1)} h/day toward the duty pattern`,
    drift_from_domicile_hours: 0.0,
    wocl_window: { start_utc: fmtUtc(best.start), end_utc: fmtUtc(best.end) },
    confidence: dayIndex0 === 0 ? "high" : "medium",
  };
}

function buildLayover(summary, station, domicile, overrides, isLastDay, missing,
                     releaseUtc = null, nextReportUtc = null) {
  let source = "printed";
  let lengthHours;
  if (summary === null || summary.layoverMin === null) {
    if (isLastDay) return null;
    // The L/O column is gone, but the clock is not — see trip_board_parser.py for why this matters.
    if (releaseUtc !== null && nextReportUtc !== null && nextReportUtc > releaseUtc) {
      lengthHours = (nextReportUtc - releaseUtc) / HOUR;
      source = "computed";
      missing.add(
        "ambiguous",
        `No L/O printed after the duty period ending at ${station || "?"}; the layover was taken `
          + `from the clock instead (${hmFromMinutes(Math.round(lengthHours * 60))} from release `
          + "to the next report).",
        "Nothing, unless the printed L/O differed from the scheduled gap.",
      );
    } else {
      missing.add(
        "cut_off",
        `No L/O printed after the duty period ending at ${station || "?"}.`,
        "Rest length and sleep opportunity for this layover.",
      );
      return null;
    }
  } else if (summary.layoverMin === 0) {
    return null;                                           // 0:00 L/O = end of trip
  } else {
    lengthHours = minutesToHours(summary.layoverMin);
  }
  const atDomicile = Boolean(station) && station.toUpperCase() === domicile.toUpperCase();
  const domestic = station ? isDomestic(station, overrides) : null;
  const international = domestic === false;

  let floorKey;
  if (atDomicile) floorKey = "domicile";
  else if (international) floorKey = "international";
  else floorKey = "domestic";
  const floor = CONTRACT_REST_FLOORS[floorKey];

  return {
    station,
    length_hours: lengthHours,
    source,
    is_domicile: atDomicile,
    is_international: international,
    contract_floor_hours: floor.min,
    at_or_near_floor: lengthHours <= floor.min + NEAR_FLOOR_MARGIN_HOURS,
    reducible: floor.reducible_to < floor.min,
    reducible_to_hours: floor.reducible_to,
    extension_exposure: null,                              // needs the scorer's duty-vs-soft-max view
  };
}

/**
 * Spec 3.1 subtractions only. Sleep *events* are the scorer's to model, so the list stays empty
 * here rather than being filled with plausible-looking blocks.
 */
function buildRestPeriod(afterDutyDay, layover, releaseUtc, nextReportUtc) {
  const transport = layover.is_international
    ? SLEEP_OPPORTUNITY_SUBTRACTIONS.transport_hours_intl
    : SLEEP_OPPORTUNITY_SUBTRACTIONS.transport_hours;
  // Schema `subtractions` allows exactly these four keys — transport_hours_intl is a lookup in
  // SLEEP_OPPORTUNITY_SUBTRACTIONS, not a schema field.
  const subtractions = {
    transport_hours: transport,
    wind_down_hours: SLEEP_OPPORTUNITY_SUBTRACTIONS.wind_down_hours,
    meal_hours: SLEEP_OPPORTUNITY_SUBTRACTIONS.meal_hours,
    pre_report_prep_hours: SLEEP_OPPORTUNITY_SUBTRACTIONS.pre_report_prep_hours,
  };

  const window = {
    start_utc: fmtUtc(releaseUtc + transport * HOUR),
    end_utc: nextReportUtc !== null
      ? fmtUtc(nextReportUtc - subtractions.pre_report_prep_hours * HOUR) : null,
  };
  let opportunity = null;
  if (layover.length_hours !== null) {
    // Same summation order as Python's sum() over the dict, so the double is identical.
    const total = 0 + subtractions.transport_hours + subtractions.wind_down_hours +
      subtractions.meal_hours + subtractions.pre_report_prep_hours;
    opportunity = pyRound(layover.length_hours - total, 2);
  }

  return {
    after_duty_day: afterDutyDay,
    station: layover.station,
    scheduled_rest: { scheduled_hours: layover.length_hours, actual_hours: null, source: "printed" },
    layover_length_hours: layover.length_hours,
    sleep_opportunity_window: window,
    sleep_opportunity_hours: opportunity,
    subtractions,
    sleep_events: [],
    total_effective_sleep_hours: null,
    assumptions:
      `Parser output: printed L/O minus the spec 3.1 subtractions (transport ${pyFmt(subtractions.transport_hours, 2)} h, ` +
      `wind-down ${pyFmt(subtractions.wind_down_hours, 2)} h, meal ${pyFmt(subtractions.meal_hours, 2)} h, ` +
      `pre-report prep ${pyFmt(subtractions.pre_report_prep_hours, 2)} h). No sleep events modeled and ` +
      "no efficiency applied — the scorer fills sleep_events. No pilot actuals.",
    confidence: "medium",
  };
}

function buildPairing(pairingId, groups, dutyPeriods, info, allStations, overrides, domicileTz, missing) {
  const legRows = groups.flatMap((g) => g.legs).filter((l) => l.depUtc !== null);
  const summedBlock = legRows.reduce((sum, l) => sum + (l.blockMin || 0), 0);
  const summaries = groups.map((g) => g.summary).filter(Boolean);
  const summedDuty = summaries.reduce((sum, s) => sum + (s.dutyMin || 0), 0);
  const summedLayover = summaries.reduce((sum, s) => sum + (s.layoverMin || 0), 0);

  const footerBlock = info.footer_block_min ?? null;
  const footerTafb = info.footer_tafb_min ?? null;
  const footerDays = info.footer_duty_days ?? null;

  if (footerBlock !== null && Math.abs(footerBlock - summedBlock) > TOTALS_TOLERANCE_MIN) {
    missing.add(
      "time_conflict",
      `Footer Blk ${hmFromMinutes(footerBlock)} does not match the sum of the printed leg blocks ${hmFromMinutes(summedBlock)}.`,
      "Total block time; a leg may have been misread or cut off.",
    );
  }
  if (footerTafb !== null && Math.abs(footerTafb - (summedDuty + summedLayover)) > TOTALS_TOLERANCE_MIN) {
    missing.add(
      "time_conflict",
      `Footer TAFB ${hmFromMinutes(footerTafb)} does not match the printed duty + layover total ${hmFromMinutes(summedDuty + summedLayover)}.`,
      "Trip length, and a hint that a duty or layover row was misread.",
    );
  }
  // The footer's "Duty Days" is not always a count of duty periods: on a pairing with a long
  // layover it counts calendar days away from base, so a 2-duty trip spanning Sat-Tue prints 4.
  // The arithmetic is the better witness — see the same comment in trip_board_parser.py.
  const tafbReconciles = footerTafb !== null
    && Math.abs(footerTafb - (summedDuty + summedLayover)) <= TOTALS_TOLERANCE_MIN;
  if (footerDays !== null && footerDays !== dutyPeriods.length && !tafbReconciles) {
    missing.add(
      "cut_off",
      `Footer says ${footerDays} duty days but ${dutyPeriods.length} were parsed — the screenshot is likely truncated.`,
      "Whole duty days are absent from the trace.",
    );
  }

  const offsets = [];
  for (const station of uniqueInOrder(allStations)) {
    const tzName = stationTz(station, overrides);
    if (tzName && legRows.length) offsets.push(utcOffsetMinutes(tzName, legRows[0].depUtc) / 60);
  }
  const zonesCrossed = offsets.length ? pyRound(Math.max(...offsets) - Math.min(...offsets), 0) : null;

  return {
    pairing_id: pairingId,
    tafb_hours: footerTafb !== null ? minutesToHours(footerTafb) : minutesToHours(summedDuty + summedLayover),
    total_block_hours: footerBlock !== null ? minutesToHours(footerBlock) : minutesToHours(summedBlock),
    total_duty_hours: summedDuty ? minutesToHours(summedDuty) : null,
    duty_days: footerDays !== null ? footerDays : dutyPeriods.length,
    legs_count: legRows.length,
    landings_count: legRows.filter((l) => !l.isDeadhead).length,
    timezones_crossed: zonesCrossed,
    circadian_drift_assessment:
      `Stations span ${zonesCrossed !== null ? `${zonesCrossed} h` : "an unknown range"} of UTC offset. ` +
      `Body clock is anchored to domicile ${domicileTz} with zero drift applied by the parser; the scorer ` +
      `applies drift toward the duty pattern (cap ${pyFmt(MODEL_PARAMS.body_clock_drift_cap_hours_per_day, 1)} h/day) ` +
      "and re-expresses WOCL per duty day.",
  };
}

function defaultNotes(info) {
  const title = info.title ?? "UPS Trip Board";
  return `Parsed from a Trip Board screenshot (${title}) by trip_board_parser. Times are scheduled, not ` +
    "actual. Report/release are computed (not printed on this screen) by solving the printed " +
    "Duty and L/O columns. Sleep and effectiveness are not modeled here.";
}

/** The Trip Board structurally cannot show these; spec 6 wants them surfaced every run. */
function addStandingGaps(trace, missing) {
  missing.add(
    "unknown_actual",
    "Trip Board shows scheduled times only — no actual block times, delays, or reroutes.",
    "Duty length, WOCL overlap, and where minimum effectiveness lands if legs run long.",
  );
  missing.add(
    "no_commute_info",
    `No commute to ${trace.meta.domicile} before duty day 1 was provided.`,
    "Pre-trip reservoir and day-1 starting effectiveness.",
  );
  const layoverStations = trace.duty_periods
    .filter((d) => d.layover_after && d.layover_after.station)
    .map((d) => d.layover_after.station);
  if (layoverStations.length) {
    missing.add(
      "no_hotel_info",
      `No hotel quality, room darkness, or transport detail for: ${uniqueInOrder(layoverStations).join(", ")}.`,
      "Daytime sleep efficiency (0.70-0.85), and every reservoir value downstream of it.",
    );
  }
}

// ── Schema-shaped output ────────────────────────────────────────────────────

/**
 * Drop null-valued keys. Not cosmetic: the schema's `confidence` and `source` $defs are string
 * enums with no null member. Required fields are never null in this parser's output.
 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== null && member !== undefined) out[key] = prune(member);
    }
    return out;
  }
  return value;
}
