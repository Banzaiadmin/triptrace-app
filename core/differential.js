/**
 * differential.js — compare the JavaScript core against the frozen Python goldens, stage by stage.
 *
 * Shared by the headless runner (cli.js — what CI and tools/check_port.py run) and the browser
 * harness (static/diff.html) so both report the same verdict from the same rules. Python is the
 * reference: a difference means the port is wrong, never the golden.
 */

import { parseTripBoard } from "./parser.js?v=27";
import { scoreTrace } from "./scorer.js?v=27";
import { buildReport } from "./report.js?v=27";
import { applyRevisions, workloadPoints } from "./revisions.js?v=27";
import { pyRound, pyFmt, pyRepr, pyFloatStr } from "./py.js?v=27";
import { fmtLocal, fmtUtc, localToUtc, parseUtc, utcOffsetMinutes, localParts } from "./tz.js?v=27";
import {
  WearableError, coverageSummary, detectAndNormalize, importSleep, matchToRestPeriods, toActualSleep,
} from "./wearables.js?v=27";

/**
 * Floats round-trip through two languages' math libraries; the last bit can differ. Anything the
 * app displays is rounded well above this, so equality at 1e-9 is equality for every purpose that
 * matters — but it is a tolerance, and it is stated rather than hidden.
 */
export const EPSILON = 1e-9;

/** @returns {{differences: Array<{path, expected, actual}>, compared: number}} */
export function diffValues(actual, expected, { deferred = () => false, epsilon = EPSILON } = {}) {
  const out = [];
  let compared = 0;

  const walk = (a, e, path) => {
    if (deferred(path)) return;

    if (e === null || e === undefined || typeof e === "string" || typeof e === "boolean") {
      compared += 1;
      if (a !== e) out.push({ path, expected: e, actual: a });
      return;
    }

    if (typeof e === "number") {
      compared += 1;
      if (typeof a !== "number" || Math.abs(a - e) > epsilon) out.push({ path, expected: e, actual: a });
      return;
    }

    if (Array.isArray(e)) {
      if (!Array.isArray(a)) {
        out.push({ path, expected: `array(${e.length})`, actual: typeof a });
        return;
      }
      if (a.length !== e.length) out.push({ path: `${path}.length`, expected: e.length, actual: a.length });
      for (let i = 0; i < Math.min(a.length, e.length); i += 1) walk(a[i], e[i], `${path}[${i}]`);
      return;
    }

    if (typeof a !== "object" || a === null) {
      out.push({ path, expected: "object", actual: String(a) });
      return;
    }
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    for (const key of [...keys].sort()) {
      const child = path ? `${path}.${key}` : key;
      if (deferred(child)) continue;
      if (!(key in e)) out.push({ path: child, expected: "(absent)", actual: JSON.stringify(a[key]) });
      else if (!(key in a)) out.push({ path: child, expected: JSON.stringify(e[key]), actual: "(absent)" });
      else walk(a[key], e[key], child);
    }
  };

  walk(actual, expected, "");
  return { differences: out, compared };
}

/** Compact one-line rendering of a value for a diff table. */
export function short(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

/**
 * Run every check. `readText(path)` / `readJson(path)` resolve paths relative to the repository
 * root (`goldens/…`, `samples/…`, `corpus/…`) and may be sync or async.
 *
 * @returns {Promise<{rows: Array<{label, differences, compared}>, failures: number, compared: number, goldens: number}>}
 */
export async function runDifferential({ readText, readJson }) {
  const rows = [];
  let failures = 0;
  let compared = 0;
  const record = (label, differences, count) => {
    rows.push({ label, differences, compared: count });
    compared += count;
    if (differences.length) failures += 1;
  };
  const threw = (label, expected, error) =>
    record(label, [{ path: "(threw)", expected, actual: error.message }], 0);

  // 1. Python parity helpers, against vectors Python generated.
  {
    const vectors = await readJson("goldens/round_vectors.json");
    const bad = vectors.filter((v) => pyRound(v.value, v.digits) !== v.expected)
      .map((v) => ({ path: `round(${v.value}, ${v.digits})`, expected: v.expected, actual: pyRound(v.value, v.digits) }));
    record("pyRound vs Python round()", bad, vectors.length);
  }
  {
    const vectors = await readJson("goldens/format_vectors.json");
    const bad = [];
    for (const v of vectors) {
      let actual;
      if (v.kind === "fmt") actual = pyFmt(v.value, v.digits, { sign: Boolean(v.sign) });
      else if (v.kind === "float_str") actual = pyFloatStr(v.value);
      else if (v.kind === "repr") actual = pyRepr(v.value);
      if (actual !== v.expected) bad.push({ path: `${v.kind}(${JSON.stringify(v.value)})`, expected: v.expected, actual });
    }
    record("pyFmt / pyFloatStr / pyRepr vs Python", bad, vectors.length);
  }
  {
    // Two things can differ here and they mean different things. The ADAPTER can be wrong — a
    // fold or gap handled unlike zoneinfo — and that is a port bug. Or the HOST'S TIMEZONE DATA
    // can differ from the database Python froze the vectors with: tz rules change (this project
    // first saw it when tzdata 2026c moved British Columbia to permanent UTC-7 and a browser with
    // older ICU data still had Vancouver falling back). That is not a port bug, and it cannot be
    // fixed in code — but it must be visible, because a phone with stale data would place a leg
    // an hour off. (The parser's printed-local-hour cross-check is the safety net for that case.)
    //
    // So: where the host agrees with the vectors on the offset in play, the adapter must
    // reproduce Python exactly. Where it does not, the disagreement is reported as host data.
    const vectors = await readJson("goldens/tz_vectors.json");
    const bad = [];
    const data = [];
    for (const v of vectors.utc_to_local) {
      const ms = parseUtc(v.utc);
      const offset = utcOffsetMinutes(v.tz, ms);
      if (offset !== v.offset_min) {
        data.push({ path: `${v.tz} ${v.utc} offset`, expected: v.offset_min, actual: offset });
        continue;
      }
      const local = fmtLocal(v.tz, ms);
      const weekday = localParts(v.tz, ms).weekday;
      if (local !== v.local) bad.push({ path: `${v.tz} ${v.utc} local`, expected: v.local, actual: local });
      if (weekday !== v.weekday) bad.push({ path: `${v.tz} ${v.utc} weekday`, expected: v.weekday, actual: weekday });
    }
    // A zone whose offsets the host disputes at any pinned instant is a data disagreement for its
    // wall-time vectors too (a wall time in a gap resolves to an instant whose offset differs from
    // the implied one by construction, so per-vector offset checks cannot classify these).
    const disputedZones = new Set(data.map((d) => d.path.split(" ")[0]));
    for (const v of vectors.local_to_utc) {
      const [y, m, d, hh, mm] = v.wall;
      if (disputedZones.has(v.tz)) {
        data.push({ path: `${v.tz} wall ${v.wall.join("-")}`, expected: v.utc, actual: "(zone disputed)" });
        continue;
      }
      const utc = fmtUtc(localToUtc(v.tz, y, m, d, hh, mm));
      if (utc !== v.utc) bad.push({ path: `${v.tz} wall ${v.wall.join("-")}`, expected: v.utc, actual: utc });
    }
    record("tz adapter vs zoneinfo", bad,
           vectors.utc_to_local.length * 3 + vectors.local_to_utc.length - data.length);
    const zones = [...disputedZones];
    rows.push({
      label: `host tz data vs tzdata ${vectors.tzdata_version ?? "?"} (informational)`,
      differences: data,
      compared: data.length,
      kind: "data",
      note: data.length
        ? `This host's timezone database disagrees with the vectors' tzdata ${vectors.tzdata_version ?? "?"} ` +
          `in ${zones.length} zone(s): ${zones.join(", ")}. Not a port defect — but a device with ` +
          "this data would place legs in those zones an hour off; the parser's local-hour cross-check " +
          "flags that as a time_conflict rather than accepting it."
        : `This host's timezone database agrees with tzdata ${vectors.tzdata_version ?? "?"} on every vector.`,
    });
  }

  // 2. Wearables: every adapter, envelope, timestamp form and failure, then layover matching.
  {
    const vectors = await readJson("goldens/wearable_vectors.json");
    const bad = [];
    let count = 0;
    for (const v of vectors.normalize) {
      let actual;
      try {
        actual = importSleep(v.payload, v.vendor);
      } catch (error) {
        if (!(error instanceof WearableError)) throw error;
        actual = { error: error.message };
      }
      const expected = "error" in v ? { error: v.error } : v.expected;
      const r = diffValues(actual, expected);
      count += r.compared;
      for (const d of r.differences) bad.push({ ...d, path: `${v.id}: ${d.path}` });
    }
    record("wearables · normalize", bad, count);

    const traceGolden = await readJson(`goldens/${vectors.trace_case}.json`);
    const matchBad = [];
    let matchCount = 0;
    for (const v of vectors.matching) {
      const { sessions } = detectAndNormalize(v.payload, "generic");
      const matched = matchToRestPeriods(traceGolden.parsed, sessions);
      const actual = {
        sessions: matched.map((s) => s.toDict()),
        actual_sleep: toActualSleep(matched),
        coverage: coverageSummary(traceGolden.parsed, matched),
      };
      const r = diffValues(actual, v.expected);
      matchCount += r.compared;
      for (const d of r.differences) matchBad.push({ ...d, path: `${v.id}: ${d.path}` });
    }
    record("wearables · layover matching", matchBad, matchCount);
  }

  // 3. Every golden: parser, scorer in isolation, then the end-to-end path the app runs.
  const sampleFiles = new Set((await readJson("samples/index.json")).map((entry) => entry.file));
  const ids = await readJson("goldens/index.json");
  for (const id of ids) {
    const golden = await readJson(`goldens/${id}.json`);
    const inputs = golden.inputs;
    const board = await readText(`${sampleFiles.has(`${id}.txt`) ? "samples" : "corpus"}/${id}.txt`);

    const revisions = inputs.revisions ?? [];
    const scoreOptions = {
      actualSleep: inputs.actual_sleep,
      workload: inputs.workload && Object.keys(inputs.workload).length ? inputs.workload : null,
    };

    let parsed = null;
    try {
      parsed = parseTripBoard(board, { generatedAt: inputs.generated_at });
      const r = diffValues(parsed, golden.parsed);
      record(`${id} · parser`, r.differences, r.compared);
    } catch (error) {
      threw(`${id} · parser`, "a parsed trace", error);
    }

    // Revisions in isolation (Python's parse in), only where the case carries any.
    if (revisions.length) {
      try {
        const { trace: revised, applied } = applyRevisions(golden.parsed, revisions);
        const r = diffValues(revised, golden.revised);
        record(`${id} · revisions`, r.differences, r.compared);
        const ra = diffValues(applied, golden.revisions_applied);
        record(`${id} · revisions applied`, ra.differences, ra.compared);
        const dayIndexes = revised.duty_periods.map((d) => d.day_index);
        const rw = diffValues(workloadPoints(dayIndexes, revisions, inputs.factors), inputs.workload);
        record(`${id} · workload points`, rw.differences, rw.compared);
      } catch (error) {
        threw(`${id} · revisions`, "a revised trace", error);
      }
    }

    // Python's revised trace in, so a parser or revision bug cannot mask a scorer bug.
    try {
      const scored = scoreTrace(golden.revised, scoreOptions);
      const r = diffValues(scored, golden.trace);
      record(`${id} · scorer (from Python parse)`, r.differences, r.compared);
    } catch (error) {
      threw(`${id} · scorer (from Python parse)`, "a scored trace", error);
    }

    if (parsed) {
      try {
        const { trace: revised, applied } = applyRevisions(parsed, revisions);
        const scored = scoreTrace(revised, scoreOptions);
        const r = diffValues(scored, golden.trace);
        record(`${id} · scorer (end to end)`, r.differences, r.compared);
        const report = buildReport(scored, inputs.factors, inputs.rescheduled, applied);
        const rr = diffValues(report, golden.report);
        record(`${id} · report`, rr.differences, rr.compared);
      } catch (error) {
        threw(`${id} · end to end`, "a report", error);
      }
    }
  }

  return {
    rows,
    failures,
    compared,
    goldens: ids.length,
    notes: rows.filter((r) => r.kind === "data").map((r) => r.note),
  };
}
