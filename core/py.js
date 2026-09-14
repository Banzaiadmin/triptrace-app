/**
 * py.js — the places where JavaScript and Python disagree, named and pinned.
 *
 * The port is correct when it reproduces `goldens/` byte for byte, and almost every divergence
 * between the two languages that can reach a pilot's screen is a formatting or rounding rule
 * rather than model logic. They are collected here so each one is written once, tested against
 * vectors Python generated, and never re-derived inline.
 *
 * Python is the reference implementation. If one of these helpers disagrees with Python, the helper
 * is wrong — never the golden.
 */

/**
 * Python's round() is round-half-to-even over the double's TRUE decimal expansion; JavaScript's
 * Math.round is round-half-up. They disagree on exact .5 cases — round(2.5) is 2 in Python and 3
 * in JS — and effectiveness values are rounded to one decimal, so ties are reachable.
 *
 * Read the double's own decimal expansion rather than scaling by a power of ten. Scaling was the
 * first attempt and it was wrong in a way the differential harness caught on the real pairings:
 * 8.5 * 0.95 is 8.074999999999999289… in binary, which Python correctly rounds DOWN to 8.07 — but
 * multiplying by 100 first lands on exactly 807.5, manufacturing a tie that then rounded up to
 * 8.08. toFixed with generous precision exposes the true expansion, so "above, below, or exactly
 * at the midpoint" is answered on the same digits Python sees.
 */
export function pyRound(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const negative = value < 0;
  const abs = Math.abs(value);

  const exact = abs.toFixed(Math.min(100, digits + 20));
  const point = exact.indexOf(".");
  const allDigits = exact.slice(0, point) + exact.slice(point + 1);
  const keep = point + digits;
  const head = allDigits.slice(0, keep) || "0";
  const tail = allDigits.slice(keep);

  let carry;
  if (tail[0] > "5") carry = 1n;
  else if (tail[0] < "5") carry = 0n;
  else if (/[1-9]/.test(tail.slice(1))) carry = 1n;               // above the midpoint
  else carry = Number(head[head.length - 1]) % 2 === 0 ? 0n : 1n;  // exact tie -> half to even

  const result = Number(BigInt(head) + carry) / Math.pow(10, digits);
  // -0 would serialize as "-0.0" and mismatch Python's "0.0".
  return negative && result !== 0 ? -result : result;
}

/**
 * Python's `"%.Nf" % value` (and `"%+.Nf"` with `sign`). C-style: half-to-even on the exact binary
 * value, and a negative number that rounds to zero keeps its minus sign ("%.1f" % -0.04 is "-0.0").
 */
export function pyFmt(value, digits, { sign = false } = {}) {
  const negative = value < 0 || Object.is(value, -0);
  const body = pyRound(Math.abs(value), digits).toFixed(digits);
  return (negative ? "-" : sign ? "+" : "") + body;
}

/**
 * Python's str() of a float. JSON cannot tell 70.0 from 70, so callers say which fields Python
 * holds as floats; str() of an int is just String(). Both languages use shortest round-trip repr
 * in the ranges this model produces (0–100 percent, tens of hours).
 */
export function pyFloatStr(value) {
  if (value === null || value === undefined) return "None";
  if (Object.is(value, -0)) return "-0.0";
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  const abs = Math.abs(value);
  // Python's repr switches to exponent form below 1e-4 and at 1e16; JavaScript's thresholds differ
  // (1e-7 and 1e21). Both use the shortest round-trip digits, so only the layout needs mapping.
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split("e");
    const sign = exponent[0] === "-" ? "-" : "+";
    return `${mantissa}e${sign}${exponent.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Python's str() for the non-float values that reach a "%s". */
export function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/**
 * Python's repr() of a str, as used by "%r". Single quotes unless the text contains a single quote
 * and no double quote; backslash, the quote, and control characters escaped; printable non-ASCII
 * left as-is (Python 3 behaviour).
 */
export function pyRepr(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** Python's `"%d:%02d" % divmod(minutes, 60)`. */
export function hmFromMinutes(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** report.py / scorer.py `_hm(hours)`: `int(round(hours * 60))` then H:MM, "—" for None. */
export function hmFromHours(hours) {
  if (hours === null || hours === undefined) return "—";
  return hmFromMinutes(pyRound(hours * 60, 0));
}

/** Python's min()/max() with a key return the FIRST extreme on a tie; strict comparisons match. */
export function minBy(items, key) {
  return items.length
    ? items.reduce((best, item) => (key(item) < key(best) ? item : best))
    : undefined;
}
export function maxBy(items, key) {
  return items.length
    ? items.reduce((best, item) => (key(item) > key(best) ? item : best))
    : undefined;
}

/**
 * Deep copy the way scorer.py does it — `json.loads(json.dumps(trace))` — rather than
 * structuredClone, which keeps `undefined` members that JSON would drop and is absent from some
 * runtimes (the JavaScriptCore shell used for the headless differential, for one).
 */
export function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Python's `dict.fromkeys(items)`: unique, first-seen order. */
export function uniqueInOrder(items) {
  return [...new Set(items)];
}

/**
 * Python's str.splitlines(): every line boundary the Unicode standard recognises, and no trailing
 * empty element for a final newline.
 */
export function splitLines(text) {
  const lines = text.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
