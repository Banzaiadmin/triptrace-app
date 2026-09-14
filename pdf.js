/*
 * pdf.js — a small PDF writer, and the Fatigue Summary laid out with it.
 *
 * Dependency-free on purpose: the app ships as plain files with no build step and must work
 * offline, and a pilot's summary should not depend on a CDN being reachable at 3 a.m. in a hotel.
 * The writer covers exactly what the summary needs — Helvetica text, wrapped paragraphs, rules,
 * filled boxes, multi-page flow with a footer — using the base-14 fonts so nothing is embedded.
 *
 * Text is WinAnsi-encoded. The few characters the summary uses outside ASCII (en/em dashes,
 * bullets, middle dots, arrows) are mapped; anything else becomes "?" rather than corrupting the
 * file. This is presentation only: every figure comes from core/summary.js.
 */

// Helvetica and Helvetica-Bold advance widths (AFM, 1/1000 em) for the printable ASCII range,
// starting at code 32. Used only for line wrapping, so a slight overestimate is harmless.
const W_REG = [278,278,355,556,556,889,667,222,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,222,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,278,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Non-ASCII the summary uses -> WinAnsi byte.
const WINANSI = { "–": 0x96, "—": 0x97, "•": 0x95, "·": 0xB7, "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "…": 0x85, "°": 0xB0, "±": 0xB1, "×": 0xD7, "é": 0xE9 };
const REPLACE = { "≈": "~", "→": "->", "←": "<-", "≤": "<=", "≥": ">=", " ": " " };
const WIDTH_EXTRA = { 0x96: 556, 0x97: 1000, 0x95: 350, 0xB7: 278, 0x92: 222, 0x91: 222, 0x93: 333, 0x94: 333, 0x85: 1000, 0xB0: 400, 0xB1: 584, 0xD7: 584, 0xE9: 556 };

function encode(text) {
  const bytes = [];
  for (const ch of String(text).replace(/[≈→←≤≥ ]/g, (c) => REPLACE[c])) {
    const code = ch.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (WINANSI[ch] !== undefined) bytes.push(WINANSI[ch]);
    else bytes.push(0x3F);
  }
  return bytes;
}

function textWidth(text, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let width = 0;
  for (const code of encode(text)) {
    if (code >= 32 && code < 127) width += table[code - 32];
    else width += WIDTH_EXTRA[code] ?? 556;
  }
  return (width / 1000) * size;
}

function pdfString(bytes) {
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

const hex = (color) => {
  const n = parseInt(color.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => v.toFixed(3)).join(" ");
};

/** Letter portrait, points. */
export class PdfDocument {
  constructor({ margin = 48, footer = null } = {}) {
    this.width = 612;
    this.height = 792;
    this.margin = margin;
    this.footer = footer;
    this.pages = [];
    this.newPage();
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.height - this.margin;
    if (this.footer) this.footer(this, this.pages.length);
  }

  get bottom() { return this.margin + 30; }
  get innerWidth() { return this.width - 2 * this.margin; }

  ensure(height) {
    if (this.y - height < this.bottom) this.newPage();
  }

  rect(x, y, w, h, color) {
    this.ops.push(`${hex(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  rule(x1, y, x2, color = "#E3E6EC", width = 0.6) {
    this.ops.push(`${hex(color)} RG ${width} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
  }

  /** Draw one line of text at (x, baseline y). */
  text(str, x, y, { size = 10, bold = false, color = "#22304A" } = {}) {
    this.ops.push(`BT ${hex(color)} rg /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(encode(str))} Tj ET`);
  }

  wrap(str, width, size, bold) {
    const lines = [];
    for (const paragraph of String(str).split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (textWidth(candidate, size, bold) <= width || !line) line = candidate;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }

  /** Flow a paragraph down the page, paginating. */
  paragraph(str, { size = 10, bold = false, color = "#22304A", x = null, width = null, leading = null, after = 6 } = {}) {
    const left = x ?? this.margin;
    const w = width ?? (this.width - this.margin - left);
    const lh = leading ?? size * 1.38;
    for (const line of this.wrap(str, w, size, bold)) {
      this.ensure(lh);
      this.y -= lh;
      this.text(line, left, this.y, { size, bold, color });
    }
    this.y -= after;
  }

  heading(str, { size = 12.5, color = "#1B2A4E", before = 10 } = {}) {
    this.ensure(size * 2.4 + before);
    this.y -= before;
    this.paragraph(str, { size, bold: true, color, after: 4 });
    this.rule(this.margin, this.y, this.width - this.margin, "#E3E6EC");
    this.y -= 6;
  }

  /**
   * A filled panel with a title and pre-wrapped body lines, kept on one page when it fits (a
   * panel taller than a page flows). `lines` items are strings or {text, size, bold, color}.
   */
  panel(title, lines, { fill = "#F6F7F9", accent = "#1B2A4E", x = null, width = null, titleColor = null, titleSize = 10.5 } = {}) {
    const left = x ?? this.margin;
    const w = width ?? this.innerWidth;
    const pad = 12;
    const items = [];
    for (const item of lines) {
      const spec = typeof item === "string" ? { text: item } : item;
      const size = spec.size ?? 9;
      for (const l of this.wrap(spec.text, w - 2 * pad - 6, size, Boolean(spec.bold))) {
        items.push({ text: l, size, bold: Boolean(spec.bold), color: spec.color ?? "#22304A", lh: size * 1.38, gap: 0 });
      }
      items[items.length - 1].gap = spec.after ?? 3;
    }
    const titleH = titleSize * 1.5;
    const bodyH = items.reduce((sum, i) => sum + i.lh + i.gap, 0);
    const height = pad + titleH + bodyH + pad;
    if (height <= this.height - this.margin - this.bottom) this.ensure(height);
    const top = this.y;
    // Fill only what fits on this page; a flowed remainder is drawn plain.
    const fits = Math.min(height, top - this.bottom);
    this.rect(left, top - fits, w, fits, fill);
    this.rect(left, top - fits, 4, fits, accent);
    let y = top - pad - titleSize;
    this.text(title, left + pad + 6, y, { size: titleSize, bold: true, color: titleColor ?? accent });
    y -= titleH - titleSize + 2;
    for (const i of items) {
      if (y - i.lh < this.bottom) { this.newPage(); y = this.y; }
      y -= i.lh;
      this.text(i.text, left + pad + 6, y, { size: i.size, bold: i.bold, color: i.color });
      y -= i.gap;
    }
    this.y = Math.min(y - pad, top - fits) ;
    this.y -= 8;
  }

  space(h) { this.y -= h; }

  /** Serialize. Returns a Uint8Array. */
  build() {
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };
    const fontRegular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pagesId = objects.length + 1 + this.pages.length * 2;    // reserved: pages tree comes last
    const pageIds = [];
    for (const ops of this.pages) {
      const content = ops.join("\n");
      const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    }
    const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
    if (realPagesId !== pagesId) throw new Error("pdf: object numbering drifted");
    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const infoId = add(`<< /Producer (TripTrace) /Title (Fatigue Summary) >>`);

    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets = [];
    objects.forEach((body, index) => {
      offsets.push(out.length);
      out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    // Content is Latin-1 by construction (WinAnsi bytes and ASCII operators): one byte per char.
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xFF;
    return bytes;
  }
}

const BAND_COLORS = { green: "#34C759", yellow: "#FFCC00", orange: "#FF9500", red: "#FF3B30", purple: "#AF52DE" };
const BAND_FILL = { green: "#E8F8EC", yellow: "#FFF8DB", orange: "#FFF1E0", red: "#FFE9E7", purple: "#F4E9FA" };
const NAVY = "#1B2A4E";
const RED = "#A6252F";
const INK = "#22304A";
const SUB = "#5C6675";
const CARD = "#F6F7F9";
const RED_FILL = "#FBECEC";
const NAVY_FILL = "#EEF1F7";
const GREEN_FILL = "#EAF6EE";

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Lay out a summary model as a PDF. Returns a Uint8Array. */
export function summaryPdf(model) {
  const doc = new PdfDocument({
    margin: 48,
    footer: (d, page) => {
      d.text("TripTrace · SAFTE-style decision support — not validated biomathematical software, and not legal or contractual advice.",
        d.margin, d.margin - 6, { size: 7.5, color: SUB });
      d.text(`Page ${page}`, d.width - d.margin - 34, d.margin - 6, { size: 7.5, color: SUB });
    },
  });
  const m = doc.margin;
  const right = doc.width - m;
  const h = model.headline;

  // Masthead: dark band like the reference, wordmark, title.
  doc.rect(0, doc.height - 74, doc.width, 74, NAVY);
  doc.text("TRIP", m, doc.height - 26, { size: 10, bold: true, color: "#FFFFFF" });
  doc.text("TRACE", m + textWidth("TRIP", 10, true), doc.height - 26, { size: 10, bold: true, color: "#F2B8BD" });
  const eyebrow = `FATIGUE RISK SUMMARY${h && h.updated ? " — UPDATED" : ""}`;
  doc.text(eyebrow, right - textWidth(eyebrow, 9, true), doc.height - 26, { size: 9, bold: true, color: "#C9D1E3" });
  doc.text(model.title, m, doc.height - 48, { size: 18, bold: true, color: "#FFFFFF" });
  doc.text(model.subtitle, m, doc.height - 63, { size: 9, color: "#C9D1E3" });
  doc.y = doc.height - 74 - 10;
  doc.text(model.prepared, m, doc.y - 4, { size: 8, color: SUB });
  doc.y -= 16;

  // Tiles
  const gap = 8;
  const tileW = (doc.innerWidth - gap * (model.tiles.length - 1)) / model.tiles.length;
  const tileH = 46;
  model.tiles.forEach((t, i) => {
    const x = m + i * (tileW + gap);
    doc.rect(x, doc.y - tileH, tileW, tileH, t.alert ? RED_FILL : CARD);
    const color = t.band ? BAND_COLORS[t.band] : (t.alert ? RED : INK);
    const v = String(t.value);
    doc.text(v, x + (tileW - textWidth(v, 16, true)) / 2, doc.y - 22, { size: 16, bold: true, color });
    doc.text(t.label, x + (tileW - textWidth(t.label, 7.5, false)) / 2, doc.y - 37, { size: 7.5, color: SUB });
  });
  doc.y -= tileH + 12;

  // Operational events
  if (model.logged.length) {
    doc.panel("OPERATIONAL EVENTS LOGGED", [
      ...model.logged.map((l) => ({ text: `Day ${l.day}: ${l.text}${l.note ? ` — ${l.note}` : ""}`, size: 9.5 })),
      { text: "Delays are applied to the timeline (legs, release, and the layover that follows). Conditions are workload in the Combined Capacity figure and do not alter the effectiveness estimate.", size: 8, color: SUB },
    ], { fill: RED_FILL, accent: RED });
  }

  // Current assessment
  if (h) {
    doc.panel(`${h.updated ? "UPDATED CURRENT" : "CURRENT"} FATIGUE ASSESSMENT`, [
      { text: `Trip minimum effectiveness: ${Math.round(h.minPct)}% — ${h.bandLabel}`, size: 15, bold: true, color: BAND_COLORS[h.band] ?? INK, after: 4 },
      { text: `At ${h.where}${h.at ? ` (${h.at})` : ""}. ${cap(h.bac)}. ${h.fatigueCallIndicated ? "A fatigue call is professionally defensible at this level." : "Above the fatigue-call threshold."}`, size: 9.5 },
    ], { fill: BAND_FILL[h.band] ?? CARD, accent: BAND_COLORS[h.band] ?? NAVY, titleColor: INK });
  }

  // Duty table
  doc.heading("Duty-by-duty effectiveness");
  // Widths sum to the inner width (516 pt). "Where" the low point falls is in the riskiest-duty
  // panel and the assessment; the table keeps the layover so the row reads report -> release -> then.
  const cols = [
    ["Day", 28], ["Sequence", 98], ["Report → Release (local)", 148], ["Duty", 32], ["Ldg", 22],
    ["Start", 40], ["Low", 46], ["End", 40], ["Then", doc.innerWidth - 454],
  ];
  const drawHeader = () => {
    doc.ensure(16);
    let x = m;
    for (const [label, w] of cols) { doc.text(label, x, doc.y - 10, { size: 7.8, bold: true, color: SUB }); x += w; }
    doc.y -= 14;
    doc.rule(m, doc.y, right, "#C9CED8");
  };
  const pct = (x, base, value, band, bold = false) => {
    if (value === null || value === undefined) { doc.text("—", x, base, { size: 8.5 }); return; }
    doc.rect(x, base - 3, 7, 7, BAND_COLORS[band] ?? SUB);
    doc.text(`${value}%`, x + 10, base, { size: 8.5, bold });
  };
  drawHeader();
  for (const d of model.duties) {
    const seqLines = doc.wrap(d.sequence, cols[1][1] - 6, 8.5, false).slice(0, 3);
    const thenLines = doc.wrap(d.layover, cols[8][1] - 2, 8, false).slice(0, 3);
    const lines = Math.max(seqLines.length, thenLines.length, d.combined !== null ? 2 : 1);
    const rowH = 12 + (lines - 1) * 10 + 6;
    if (doc.y - rowH < doc.bottom) { doc.newPage(); drawHeader(); }
    const base = doc.y - 11;
    let x = m;
    const cell = (text, w, opts = {}) => { doc.text(text, x, base, { size: 8.5, ...opts }); x += w; };
    cell(`D${d.day}`, cols[0][1], { bold: true });
    seqLines.forEach((line, i) => doc.text(line, x, base - i * 10, { size: 8.5 }));
    x += cols[1][1];
    cell(`${d.report} → ${d.release}`, cols[2][1]);
    cell(d.actualDuty ?? d.duty, cols[3][1], d.actualDuty ? { color: RED, bold: true } : {});
    cell(String(d.landings), cols[4][1]);
    pct(x, base, d.startPct, d.startBand); x += cols[5][1];
    pct(x, base, d.minPct, d.band, true);
    if (d.combined !== null) doc.text(`CC ${d.combined}`, x + 10, base - 10, { size: 7.5, color: SUB });
    x += cols[6][1];
    pct(x, base, d.endPct, d.endBand); x += cols[7][1];
    thenLines.forEach((line, i) => doc.text(line, x, base - i * 10, { size: 8, color: SUB }));
    doc.y -= rowH;
    doc.rule(m, doc.y + 2, right);
  }
  doc.y -= 4;
  doc.paragraph("Report and release are solved from the printed Duty and L/O columns (not printed on the Trip Board). Start, low and end are the estimated effectiveness at report, at the minimum, and at release; bands: Normal >= 90, Monitor 85–90, Elevated 80–85, High 75–80, Critical < 75. A red duty length is the logged actual.",
    { size: 8, color: SUB });

  // Today + riskiest remaining
  const t = model.today;
  if (t.phase === "complete") {
    doc.panel("TRIP COMPLETE", [{ text: "Every duty period has been released. The panels below describe the trip as flown.", size: 9.5, color: SUB }], { fill: NAVY_FILL, accent: NAVY });
  } else {
    doc.panel(t.phase === "in progress" ? `TODAY — D${t.day} IN PROGRESS` : `NEXT UP — D${t.day} (${t.date})`, [
      ...(t.pickup ? [{ text: `Hotel pickup ${t.pickup}`, size: 9.5 }] : []),
      { text: `Report ${t.report} at ${t.reportStation}`, size: 9.5, bold: true },
      ...t.legs.map((l) => ({ text: l, size: 9 })),
      { text: `Release ${t.release} · duty ${t.duty}${t.actual ? " (actual)" : ""}`, size: 9.5 },
      { text: `Lowest ${t.lowest}`, size: 9.5 },
      { text: `Then ${t.layoverAfter}${t.recoveryTo ? ` → recovery to ${t.recoveryTo}` : ""}`, size: 9.5 },
    ], { fill: NAVY_FILL, accent: NAVY });
  }
  const r = model.riskiest;
  if (r) {
    doc.panel(`${r.remaining ? "MOST RISKY REMAINING DUTY" : "MOST RISKY DUTY"} — D${r.day} ${r.route}`, [
      { text: `${r.minPct}% — ${r.bandLabel}`, size: 14, bold: true, color: BAND_COLORS[r.band] ?? INK, after: 4 },
      ...r.bullets.map((b) => ({ text: `•  ${b}`, size: 9 })),
    ], { fill: BAND_FILL[r.band] ?? CARD, accent: BAND_COLORS[r.band] ?? RED, titleColor: INK });
  }
  const rec = model.recovery;
  if (rec) {
    doc.panel(`RECOVERY — ${rec.station} LAYOVER AFTER D${rec.afterDay} (${rec.layover})`, [
      { text: `Sleep opportunity ${rec.opportunityHours}: ${rec.window}`, size: 9.5, bold: true },
      { text: `Modeled effective sleep ${rec.effective}${rec.short ? " — short" : ""}`, size: 9.5, color: rec.short ? RED : INK },
      ...rec.blocks.map((b) => ({ text: b, size: 9, color: SUB })),
      ...model.recommendations.slice(0, 3).map((x) => ({ text: `•  ${x}`, size: 9 })),
    ], { fill: GREEN_FILL, accent: "#2F855A" });
  }

  // Facts, two columns
  doc.heading("Trip facts");
  const colW = doc.innerWidth / 2;
  const rows = Math.ceil(model.facts.length / 2);
  doc.ensure(rows * 14 + 8);
  for (let i = 0; i < model.facts.length; i += 1) {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const x = m + col * colW;
    const y = doc.y - 11 - row * 14;
    doc.text(model.facts[i][0], x, y, { size: 8.5, color: SUB });
    doc.text(model.facts[i][1], x + 108, y, { size: 9.5, bold: true, color: INK });
  }
  doc.y -= rows * 14 + 6;
  if (model.revised) doc.paragraph(`Schedule revision: ${model.revised}`, { size: 9.5, color: RED, bold: true });
  if (model.factors.length) doc.paragraph(`Conditions across the trip (counted as workload): ${model.factors.join(", ")}`, { size: 9.5, color: INK });

  doc.heading("How this trip is built");
  doc.paragraph(model.narrative, { size: 9.8 });

  // Sleep table
  if (model.sleep.length) {
    doc.heading("Sleep by layover");
    const scols = [["After", 42], ["Station", 52], ["Layover", 52], ["Opportunity", 68], ["Effective", 62], ["Modeled blocks", doc.innerWidth - 276]];
    const drawSleepHeader = () => {
      doc.ensure(16);
      let x = m;
      for (const [label, w] of scols) { doc.text(label, x, doc.y - 10, { size: 7.8, bold: true, color: SUB }); x += w; }
      doc.y -= 14;
      doc.rule(m, doc.y, right, "#C9CED8");
    };
    drawSleepHeader();
    for (const s of model.sleep) {
      const blockLines = s.blocks.length ? s.blocks : ["none modeled"];
      const rowH = 12 + (blockLines.length - 1) * 10 + 6;
      if (doc.y - rowH < doc.bottom) { doc.newPage(); drawSleepHeader(); }
      const base = doc.y - 11;
      let x = m;
      const cell = (text, w, opts = {}) => { doc.text(text, x, base, { size: 8.5, ...opts }); x += w; };
      cell(`D${s.afterDay}`, scols[0][1], { bold: true });
      cell(s.station, scols[1][1]);
      cell(s.layover, scols[2][1]);
      cell(s.opportunity, scols[3][1]);
      cell(s.effective, scols[4][1], { bold: true, color: s.short ? RED : INK });
      blockLines.forEach((line, i) => doc.text(line, x, base - i * 10, { size: 8.2, color: SUB }));
      doc.y -= rowH;
      doc.rule(m, doc.y + 2, right);
    }
    doc.y -= 4;
  }

  if (model.crossings.length) {
    doc.heading("Threshold crossings");
    for (const c of model.crossings) {
      doc.paragraph(`Duty day ${c.day} — ${c.bandLabel}. ${c.trigger}`, { size: 9.5, bold: true, after: 2 });
      doc.paragraph(`Worse if: ${c.worseIf}`, { size: 9, color: SUB, after: 2 });
      doc.paragraph(c.contractNote, { size: 9, color: SUB, after: 8 });
    }
  }

  doc.heading("What helps");
  for (const x of model.recommendations) doc.paragraph(`•  ${x}`, { size: 9.5, x: m + 4, after: 3 });

  doc.heading("Worth knowing");
  for (const w of model.watch) doc.paragraph(`•  ${w}`, { size: 9.5, x: m + 4, after: 3 });

  doc.heading("What the model cannot see");
  doc.paragraph("Every item here would change the result. It is part of the output, not a footnote to it.", { size: 8.5, color: SUB });
  for (const g of model.gaps) {
    doc.paragraph(`[${g.label}] ${g.detail}${g.wouldChange ? `  Would change: ${g.wouldChange}` : ""}`,
      { size: 9, color: g.severe ? RED : INK, after: 3 });
  }

  if (model.assessment) {
    doc.heading("Assessment");
    doc.paragraph(model.assessment, { size: 9.5 });
  }
  if (model.statement) {
    doc.heading("Statement");
    doc.paragraph(model.statement, { size: 9.5 });
  }

  doc.heading("Model notes");
  doc.paragraph(model.modelAssumptions, { size: 8.5, color: SUB });
  doc.paragraph(model.circadian, { size: 8.5, color: SUB });
  doc.paragraph(model.uncertainty, { size: 8.5, color: SUB });
  doc.paragraph(model.reminder, { size: 8.5, color: SUB });
  doc.paragraph(model.engine, { size: 8.5, color: SUB });

  return doc.build();
}
