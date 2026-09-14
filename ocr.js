/*
 * ocr.js — read a Trip Board screenshot on the device, with no API key.
 *
 * This is the path that lets anyone test the app without a service behind it. It is deliberately
 * shaped like the vision call: it turns pixels into the text a person could have typed, and hands
 * that transcript to the same parser. It does not compute anything about fatigue. Its mistakes —
 * and raw OCR makes more of them than a vision model — stay in the one place a pilot can see and
 * correct them: the transcript. The parser's cross-checks (printed local hour vs Zulu, footer totals
 * vs the rows) catch most misread digits as `time_conflict` rather than accepting them.
 *
 * Tesseract.js is loaded on first use from cdnjs and its worker/core/language data from jsdelivr
 * (about 4 MB, cached by the browser afterwards). The service worker does not cache it: the
 * screenshot path needs a connection the first time, and the app says so.
 */

const TESSERACT_VERSION = "7.0.0";
const SCRIPT_URL = `https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/${TESSERACT_VERSION}/tesseract.min.js`;

let loading = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract failed to initialize")));
      script.onerror = () => { loading = null; reject(new Error("Could not download the on-device reader (no connection?)")); };
      document.head.appendChild(script);
    });
  }
  return loading;
}

/**
 * Upscale and flatten the screenshot for recognition. Phone screenshots render the Trip Board in
 * a small face; Tesseract reads a 2× copy far more reliably, and a white background removes the
 * dark-mode case entirely.
 */
async function prepare(file) {
  const bitmap = await createImageBitmap(file);
  const scale = bitmap.width < 1800 ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width * scale;
  canvas.height = bitmap.height * scale;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  // Greyscale, and invert if the screenshot is dark-mode (mean luminance below mid-grey).
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = l;
    sum += l;
  }
  if (sum / (px.length / 4) < 128) {
    for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * @param {File|Blob} file the screenshot
 * @param {(message: string, progress?: number) => void} [onProgress]
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function transcribeOnDevice(file, onProgress = () => {}) {
  onProgress("Loading the on-device reader…");
  const Tesseract = await loadTesseract();
  const canvas = await prepare(file);

  const worker = await Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") onProgress("Reading the Trip Board…", m.progress);
      else if (m.status && m.status.includes("load")) onProgress("Loading the on-device reader…", m.progress);
    },
  });
  try {
    await worker.setParameters({
      // A single uniform block of text: the Trip Board is a table with one row per line.
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
    });
    const { data } = await worker.recognize(canvas);
    const text = cleanup(data.text ?? "");
    if (!text.trim()) throw new Error("The reader found no text in this image. Check that it shows the Trip Details table.");
    return { text, confidence: data.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}

/**
 * Undo the OCR confusions that recur on this specific screen. Everything here is a substitution a
 * person proofreading the transcript would make on sight; the parser's own normalizer handles the
 * spacing. Anything genuinely ambiguous is left alone so it lands in the transcript for the pilot.
 */
export function cleanup(text) {
  return text
    .split("\n")
    .map((line) => line
      .replace(/[|¦]/g, " ")                                   // table rules read as bars
      .replace(/[—–-]{2,}/g, "-")                              // "Trip Details —- 1120" -> "- 1120"
      .replace(/\)@/g, ")")                                    // "(TU01)@05:15" -> "(TU01)05:15"
      // The local-hour parenthetical: an optional day code and one or two digits. OCR turns the
      // O in MO into a zero, reads SU as "Sul", and drops a stray "u" or "@" in. Rebuild it from
      // whatever came back, validating the day code against the seven that exist.
      .replace(/\(([A-Za-z0-9@]*?)([0-9OoIl@]{1,2})\)/g, (_, head, hh) => `(${dayCode(head)}${digits(hh)})`)
      // 1O:46 / 10.46 -> 10:46, but money keeps its decimal point: "Prem: $0.00" is not a time.
      // Written with a capture rather than a lookbehind, which iOS Safari only learned in 16.4.
      .replace(/(\$?)\b([0-9OoIl@]{1,2})[:.]([0-9OoIl@]{2})\b/g, (whole, money, h, mm) =>
        (money ? whole : `${digits(h)}:${digits(mm)}`))
      .replace(/(\d)\s*\/\s*(\d)/g, "$1/$2")
      // A pairing id read as currency: "Trip Details - $5100" and "$51001" in the Pairing column.
      // Real money on this screen always carries cents, so the decimal keeps PDiem and Prem safe.
      .replace(/\$(\d{4,6})\b(?!\.\d)/g, "S$1")
      .replace(/\s+$/g, ""))
    .map(repairSummaryRow)
    // A Trip Board line is never one or two stray letters. "EE" is the Eqp column's header
    // bleeding through, and it lands in missing_data as an unparsed line if it survives.
    .filter((line) => line.trim().length && !/^[A-Za-z]{1,2}$/.test(line.trim()))
    .join("\n");
}

/**
 * Repair the duty-totals row, which is the one line with no words to anchor on.
 *
 * It prints Blk, Duty, Cr and L/O as bare times, so a dropped colon turns 5:44 into 544 and the
 * Cr suffix letter reads as punctuation ("4:29L" -> "4:29."). Either one makes the whole row
 * unparseable, and losing it costs a duty period its length and the layover that follows.
 *
 * The repair is deliberately confined to lines that are nothing but times and short digit runs:
 * a flight number is also three digits, so this must never run where a leg row could match.
 */
function repairSummaryRow(line) {
  const trimmed = line.trim();
  if (!trimmed) return line;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 3 || tokens.length > 5) return line;
  const timeish = /^\d{1,3}:\d{2}[A-Za-z.]?$/;
  const bareRun = /^\d{3,4}[A-Za-z.]?$/;
  if (!tokens.every((t) => timeish.test(t) || bareRun.test(t))) return line;
  if (tokens.filter((t) => timeish.test(t)).length < 2) return line;   // needs real times to anchor

  return tokens.map((t) => {
    const suffix = /[A-Za-z.]$/.test(t) ? t.slice(-1) : "";
    const body = suffix ? t.slice(0, -1) : t;
    const fixed = body.includes(":") ? body : `${body.slice(0, -2)}:${body.slice(-2)}`;
    // The Cr column's L/D/M suffix is what the period actually was; anything else is dropped.
    return suffix === "." ? `${fixed}L` : fixed + suffix;
  }).join(" ");
}

const DAY_CODES = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

/** "Sul" -> "SU", "M0" -> "MO", "TUu" -> "TU", "" -> "". Unknown text is left for the parser to flag. */
function dayCode(head) {
  if (!head) return "";
  const letters = head.toUpperCase()
    .replace(/0/g, "O").replace(/5/g, "S").replace(/7/g, "T").replace(/4/g, "A").replace(/[^A-Z]/g, "");
  const code = letters.slice(0, 2);
  return DAY_CODES.has(code) ? code : head;
}

const digits = (s) => s.replace(/[Oo@]/g, "0").replace(/[Il]/g, "1");
