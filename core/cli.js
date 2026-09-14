/**
 * cli.js — headless Python/JavaScript differential.
 *
 * Runs every golden through the JavaScript core — parser, scorer, report — and diffs each stage
 * against the frozen Python output. Exits non-zero on any difference. This is the acceptance test
 * for the port and the check CI runs; static/diff.html is the same run with a table.
 *
 * Two hosts, no build step:
 *   node static/core/cli.js          (CI; any machine with Node)
 *   jsc -m static/core/cli.js        (the JavaScriptCore shell inside macOS — no install needed)
 * Run from the repository root. tools/check_port.py finds a runtime and does exactly this.
 */

import { runDifferential, short } from "./differential.js?v=24";

const host = await (async () => {
  if (typeof readFile === "function" && typeof print === "function") {
    return { read: (p) => readFile(p), out: (s) => print(s), name: "jsc" };
  }
  const fs = await import("node:fs");
  return { read: (p) => fs.readFileSync(p, "utf8"), out: (s) => console.log(s), name: "node" };
})();

const result = await runDifferential({
  readText: (path) => host.read(path),
  readJson: (path) => JSON.parse(host.read(path)),
});

const lines = [];
for (const row of result.rows) {
  const isData = row.kind === "data";
  const status = isData
    ? (row.differences.length ? `${row.differences.length} host` : "agree")
    : (row.differences.length ? `${row.differences.length} DIFF` : "match");
  lines.push(`${row.label.padEnd(46)} ${status.padStart(8)}  ${String(row.compared).padStart(6)} fields`);
  for (const d of row.differences.slice(0, isData ? 3 : 8)) {
    lines.push(`    ${d.path}`);
    lines.push(`        py: ${short(d.expected)}`);
    lines.push(`        js: ${short(d.actual)}`);
  }
}
host.out(lines.join("\n"));
host.out("");
for (const note of result.notes) host.out(`NOTE: ${note}`);
host.out("");

if (result.failures) {
  host.out(`PORT FAIL: ${result.failures} stage(s) differ from Python ` +
    `(${result.compared} fields compared, host ${host.name})`);
  if (host.name === "node") process.exitCode = 1;
  throw new Error("differential failed");
}
host.out(`PORT OK: every stage matches Python — ${result.goldens} goldens, ` +
  `${result.compared} fields compared (host ${host.name})`);
