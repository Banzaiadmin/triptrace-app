/**
 * sleep-language.js — plain language about sleep, read into structured sleep.
 *
 * A direct port of `sleep_language.py`; read that module's docstring for the reasoning, including
 * why a clock interval is discounted and a stated duration is not, and why an unreadable phrase
 * returns null instead of a guess. Python is the reference implementation: this file is correct
 * when it reproduces `goldens/sleep_language_vectors.json`, which the differential checks.
 *
 * The tables live in constants.js, generated from Python. Nothing numeric is retyped here.
 */

import { SLEEP_LANGUAGE as L } from "./constants.js?v=34";
import { pyRound } from "./py.js?v=34";

const HOUR_UNIT = "(?:h|hr|hrs|hour|hours)";

const DASHES = /[‐-―−]/g;
const HALF = /½/g;
const SPACES = /\s+/g;
const AND_A_HALF = /\b(\d{1,2}) and a half\b/g;

// The separator is captured: a four-digit block with no separator is military time.
const CLOCK_RANGE = new RegExp(
  "\\b(\\d{1,2})([:.])?(\\d{2})?\\s*(am|pm)?\\s*(?:-|to|until|til|till|thru|through)\\s*" +
  "(\\d{1,2})([:.])?(\\d{2})?\\s*(am|pm)?",
);
const COLON_DURATION = new RegExp("\\b(\\d{1,2}):(\\d{2})\\s*(?:of\\s+sleep|" + HOUR_UNIT + ")\\b");
const DECIMAL_DURATION = new RegExp("\\b(\\d{1,2}(?:\\.\\d+)?)\\s*" + HOUR_UNIT + "\\b");
const RANGE_DURATION = new RegExp(
  "\\b(\\d{1,2}(?:\\.\\d+)?)\\s*-\\s*(\\d{1,2}(?:\\.\\d+)?)\\s*" + HOUR_UNIT + "\\b",
);
const BARE_AFTER_SLEPT = /\bslept\s+(\d{1,2}(?:\.\d+)?)\b(?![\s]*[:.]?\d)/;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function normalize(text) {
  let out = String(text).toLowerCase().trim().replace(DASHES, "-").replace(HALF, ".5");
  out = out.replace(/’/g, "'").replace(/didn't/g, "didnt").replace(/couldn't/g, "couldnt");
  for (const [word, value] of Object.entries(L.vague_counts)) out = out.split(word).join(String(value));
  for (const [word, value] of Object.entries(L.word_numbers)) {
    out = out.replace(new RegExp("\\b" + word + "\\b", "g"), String(value));
  }
  out = out.replace(AND_A_HALF, (_m, n) => String(Number(n) + 0.5));
  return out.replace(SPACES, " ").trim();
}

/** Python's `_meridiem`. "0600" is military time and is taken literally; see the Python docstring. */
function meridiem(hour, separator, minutes, marker, evening) {
  if (marker === "am") return hour === 12 ? 0 : hour;
  if (marker === "pm") return hour === 12 ? hour : hour + 12;
  if (hour > 12) return hour;
  if ((separator === undefined || separator === null) && minutes !== undefined && minutes !== null) return hour;
  if (evening) return hour >= 5 && hour <= 11 ? hour + 12 : hour;
  return hour;
}

const pad = (n) => String(n).padStart(2, "0");

function readClockRange(text) {
  const match = CLOCK_RANGE.exec(text);
  if (!match) return null;
  const tail = text.slice(match.index + match[0].length).replace(/^\s+/, "");
  if (new RegExp("^" + HOUR_UNIT + "\\b").test(tail)) return null;   // "5-6 hours" is a duration

  const literalStart = Number(match[1]);
  const startMin = Number(match[3] ?? 0);
  const literalEnd = Number(match[5]);
  const endMin = Number(match[7] ?? 0);
  if (literalStart > 23 || literalEnd > 23 || startMin > 59 || endMin > 59) return null;

  const spanOf = (startHour, endHour) => {
    if (startHour > 23 || endHour > 23) return null;
    const minutes = ((((endHour * 60 + endMin) - (startHour * 60 + startMin)) % 1440) + 1440) % 1440;
    if (minutes === 0 || minutes / 60 > L.max_credible_sleep_hours) return null;
    return minutes / 60;
  };

  let startHour = meridiem(literalStart, match[2], match[3], match[4], true);
  let endHour = meridiem(literalEnd, match[6], match[7], match[8], false);
  let hours = spanOf(startHour, endHour);

  // "6:30 to 14:00" is a daytime layover, not 18:30 to 14:00. Fall back to the literal hours once.
  if (hours === null && match[4] === undefined && match[8] === undefined) {
    startHour = literalStart;
    endHour = literalEnd;
    hours = spanOf(startHour, endHour);
  }
  if (hours === null) return null;
  return { start: `${pad(startHour)}:${pad(startMin)}`, end: `${pad(endHour)}:${pad(endMin)}`, hours };
}

/** @returns {{hours: number, impreciseForm: boolean}|null} */
function readDuration(text) {
  let match = RANGE_DURATION.exec(text);
  if (match) return { hours: Math.min(Number(match[1]), Number(match[2])), impreciseForm: true };
  match = COLON_DURATION.exec(text);
  if (match) return { hours: Number(match[1]) + Number(match[2]) / 60, impreciseForm: false };
  match = DECIMAL_DURATION.exec(text);
  if (match) return { hours: Number(match[1]), impreciseForm: false };
  match = BARE_AFTER_SLEPT.exec(text);
  if (match) return { hours: Number(match[1]), impreciseForm: true };
  return null;
}

/** Longest phrase wins, so "not good" is never read as "good". */
function readQuality(text) {
  let best = null;
  for (const [word, pair] of Object.entries(L.quality_words)) {
    if (new RegExp("\\b" + escapeRe(word) + "\\b").test(text) && (best === null || word.length > best.word.length)) {
      best = { word, hours: pair[0], efficiency: pair[1] };
    }
  }
  return best;
}

const hm = (hours) => {
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
};

/**
 * Read one plain-language phrase. `null` is a real answer — surface the phrase back to the pilot
 * and record it in missing_data[]; never substitute a guess.
 *
 * @param {string} text
 * @returns {{hours: number, efficiency: number, interpretation: string, confidence: string,
 *            quality: string|null, fragmented: boolean, approximate: boolean,
 *            start_hhmm: string|null, end_hhmm: string|null, source_text: string}|null}
 */
export function readSleepPhrase(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const source = text.trim();
  const normalized = normalize(source);
  if (!normalized) return null;

  const quality = readQuality(normalized);
  const fragmented = L.fragmentation_words.some((word) => normalized.includes(word));
  const lower = source.toLowerCase();
  let hedged = L.hedge_words.some((word) => normalized.includes(word))
    || Object.keys(L.vague_counts).some((word) => lower.includes(word));

  const clock = readClockRange(normalized);
  const read = clock ? null : readDuration(normalized);
  if (read !== null && read !== undefined && read.impreciseForm) hedged = true;

  let hours;
  let efficiency;
  let interpretation;
  let confidence;
  let startHhmm = null;
  let endHhmm = null;

  if (clock !== null) {
    ({ hours } = clock);
    startHhmm = clock.start;
    endHhmm = clock.end;
    efficiency = L.assumed_efficiency_from_interval;
    interpretation = `${clock.start} to ${clock.end} local, ${hm(hours)} in bed`;
    confidence = "high";
  } else if (read !== null) {
    ({ hours } = read);
    efficiency = L.nocturnal_sleep_efficiency;
    interpretation = `${hm(hours)} of sleep`;
    confidence = hedged ? "medium" : "high";
  } else if (quality !== null) {
    ({ hours } = quality);
    efficiency = L.nocturnal_sleep_efficiency;
    interpretation = `${hm(hours)} of sleep, from "${quality.word}"`;
    confidence = "low";
  } else {
    return null;
  }

  if (hours > L.max_credible_sleep_hours) return null;

  if (quality !== null) {
    efficiency = Math.min(efficiency, quality.efficiency);
    if (clock !== null || read !== null) interpretation += `, ${quality.word}`;
  }
  if (fragmented) {
    efficiency = Math.min(efficiency, L.fragmentation_efficiency);
    if (!interpretation.includes("broken")) interpretation += ", broken";
  }

  return {
    hours: pyRound(hours, 3),
    efficiency: pyRound(efficiency, 3),
    interpretation,
    confidence,
    quality: quality ? quality.word : null,
    fragmented,
    approximate: hedged,
    start_hhmm: startHhmm,
    end_hhmm: endHhmm,
    source_text: source,
  };
}
