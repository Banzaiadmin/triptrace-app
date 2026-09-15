/*
 * card.js — the one-page summary as a picture, sized for a phone and meant to be sent by text.
 *
 * Drawn straight onto a canvas with the 2D API rather than rasterised from the DOM: a DOM
 * snapshot depends on fonts, layout and a foreignObject path Safari is unreliable about, and a
 * card that comes out blank on the one platform pilots use is worse than none. Every number here
 * is read from the summary model; nothing is computed.
 */

const W = 1080, PAD = 64;
const NAVY = "#1B2A4E", RED = "#A6252F", INK = "#22304A", SUB = "#5C6675", HAIR = "#E3E6EC", CARD = "#F6F7F9";
const BAND = { green: "#17A673", yellow: "#C08A00", orange: "#D9700F", red: "#C6303B", purple: "#7A4FD0" };
const bandHex = (b) => BAND[b] ?? INK;

export function summaryCard(model) {
  const H = 1920;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const font = (px, weight = 400) => { g.font = `${weight} ${px}px -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif`; };
  const text = (s, x, y, { px = 28, weight = 400, color = INK, align = "left", max = W - PAD * 2 } = {}) => {
    font(px, weight); g.fillStyle = color; g.textAlign = align; g.textBaseline = "alphabetic";
    g.fillText(String(s ?? ""), x, y, max);
  };
  const wrap = (s, x, y, width, { px = 26, weight = 400, color = INK, lh = 1.4, maxLines = 4 } = {}) => {
    font(px, weight); g.fillStyle = color; g.textAlign = "left";
    const words = String(s ?? "").split(/\s+/); let line = "", lines = 0;
    for (const w of words) {
      const probe = line ? `${line} ${w}` : w;
      if (g.measureText(probe).width > width && line) {
        g.fillText(line, x, y); y += px * lh; line = w; lines += 1;
        if (lines >= maxLines - 1) { line += "…"; break; }
      } else line = probe;
    }
    if (line) { g.fillText(line, x, y); y += px * lh; }
    return y;
  };
  const rrect = (x, y, w, h, r, fill) => {
    g.fillStyle = fill; g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
  };

  // Paper.
  g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, W, H);

  // Masthead.
  g.fillStyle = NAVY; g.fillRect(0, 0, W, 190);
  text("TRIP", PAD, 84, { px: 30, weight: 800, color: "#FFFFFF" });
  font(30, 800); const tw = g.measureText("TRIP").width;
  text("TRACE", PAD + tw, 84, { px: 30, weight: 800, color: "#FF8A93" });
  text("SAFETY RISK SUMMARY", W - PAD, 84, { px: 22, weight: 700, color: "#C9D2E6", align: "right" });
  text(model.title, PAD, 150, { px: 40, weight: 700, color: "#FFFFFF" });

  let y = 240;
  y = wrap(model.subtitle, PAD, y, W - PAD * 2, { px: 26, color: SUB, maxLines: 2 });
  y += 10;

  // Tiles.
  const tiles = model.tiles.slice(0, 5);
  const tw2 = (W - PAD * 2 - 16 * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const x = PAD + i * (tw2 + 16);
    rrect(x, y, tw2, 120, 18, t.alert ? "#FBECEC" : CARD);
    text(t.value, x + tw2 / 2, y + 62, { px: 34, weight: 700, color: t.band ? bandHex(t.band) : (t.alert ? RED : INK), align: "center", max: tw2 - 16 });
    text(t.label, x + tw2 / 2, y + 98, { px: 18, color: SUB, align: "center", max: tw2 - 16 });
  });
  y += 160;

  // Assessment.
  const h = model.headline;
  if (h) {
    rrect(PAD, y, W - PAD * 2, 150, 20, CARD);
    g.fillStyle = bandHex(h.band); g.fillRect(PAD, y + 20, 8, 110);
    text("CURRENT SAFETY ASSESSMENT", PAD + 30, y + 46, { px: 18, weight: 700, color: SUB });
    text(`Trip minimum ${Math.round(h.minPct)}%  ·  ${h.bandLabel}`, PAD + 30, y + 96, { px: 36, weight: 700, color: bandHex(h.band) });
    text(`${h.where}${h.at ? ` · ${h.at}` : ""}`, PAD + 30, y + 132, { px: 22, color: SUB, max: W - PAD * 2 - 60 });
    y += 180;
  }

  // Duty rows.
  text("DUTY BY DUTY", PAD, y + 8, { px: 18, weight: 700, color: SUB });
  y += 28;
  const cols = [PAD, PAD + 90, W - PAD - 330, W - PAD - 220, W - PAD - 110, W - PAD];
  ["", "Sequence", "Start", "Low", "End", ""].forEach((label, i) => {
    if (label) text(label, cols[i] + (i >= 2 ? 50 : 0), y + 22, { px: 17, weight: 700, color: SUB, align: i >= 2 ? "center" : "left" });
  });
  y += 36;
  for (const d of model.duties.slice(0, 8)) {
    g.fillStyle = HAIR; g.fillRect(PAD, y, W - PAD * 2, 2);
    y += 34;
    text(`D${d.day}`, cols[0], y, { px: 26, weight: 750 });
    text(d.sequence, cols[1], y, { px: 24, max: cols[2] - cols[1] - 20 });
    const chip = (val, band, cx) => {
      if (val === null || val === undefined) return;
      const w = 92; rrect(cx + 50 - w / 2, y - 26, w, 38, 19, `${bandHex(band)}22`);
      text(`${Math.round(val)}%`, cx + 50, y + 1, { px: 24, weight: 700, color: bandHex(band), align: "center" });
    };
    chip(d.startPct, d.startBand, cols[2]); chip(d.minPct, d.band, cols[3]); chip(d.endPct, d.endBand, cols[4]);
    y += 18;
  }
  y += 30;

  // Riskiest.
  const r = model.riskiest;
  if (r) {
    rrect(PAD, y, W - PAD * 2, 176, 20, CARD);
    g.fillStyle = bandHex(r.band); g.fillRect(PAD, y + 20, 8, 136);
    text(`MOST RISKY${r.remaining ? " REMAINING" : ""} DUTY`, PAD + 30, y + 46, { px: 18, weight: 700, color: SUB });
    text(`D${r.day}  ${r.route}  ·  ${r.minPct}% ${r.bandLabel}`, PAD + 30, y + 92, { px: 30, weight: 700, color: bandHex(r.band), max: W - PAD * 2 - 60 });
    let yy = y + 128;
    for (const b of r.bullets.slice(0, 2)) yy = wrap(`• ${b}`, PAD + 30, yy, W - PAD * 2 - 60, { px: 21, color: INK, maxLines: 1 });
    y += 206;
  }

  // What helps.
  text("WHAT HELPS", PAD, y + 8, { px: 18, weight: 700, color: SUB });
  y += 44;
  for (const rec of model.recommendations.slice(0, 3)) {
    y = wrap(`• ${rec}`, PAD, y, W - PAD * 2, { px: 23, color: INK, maxLines: 2 }) + 8;
  }

  // Footer.
  g.fillStyle = HAIR; g.fillRect(PAD, H - 120, W - PAD * 2, 2);
  wrap(model.prepared, PAD, H - 82, W - PAD * 2, { px: 19, color: SUB, maxLines: 1 });
  wrap("Decision support for professional flight crews — not validated software, and not legal or contractual advice. The fatigue call is the pilot's authority.",
    PAD, H - 50, W - PAD * 2, { px: 19, color: SUB, maxLines: 2 });

  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}
