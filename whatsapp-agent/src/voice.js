// הודעות קוליות: הופכים את התשובה של היועץ לקול בעברית, בפורמט של הודעה קולית בווטסאפ (OGG/Opus).
// הקול: הקריינות של Microsoft (he-IL-HilaNeural, קול אישה), בלי מפתח ובלי תשלום. אם היא לא זמינה, הקריינות של Google Translate.
// ההמרה ל-OGG נעשית עם ffmpeg-static (קובץ ffmpeg שמגיע עם החבילה, בלי התקנה בשרת).
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const VOICE = process.env.TTS_VOICE || "he-IL-HilaNeural"; // קול אישה (הבעלים ביקש). קול גבר: he-IL-AvriNeural
const MAX_CHARS = 1800; // בערך שתי דקות דיבור

// מנקים את הטקסט לפני הקראה: בלי אימוג'י, בלי כוכביות של הדגשה, בלי קישורים ובלי טבלאות
export function speakable(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/🔗 מקורות:[\s\S]*$/u, "")
    .replace(/[*_~`#>|]/g, " ")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/₪/g, " שקל ")
    // שם העסק באותיות לועזיות יוצא עקום בקריינות: כותבים אותו כמו שאומרים
    .replace(/yakov\s*phone/gi, "יעקב פון")
    .replace(/יעקבפון/g, "יעקב פון")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_CHARS);
}

function collect(stream, ms) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const t = setTimeout(() => reject(new Error("הקריינות לא הגיבה בזמן")), ms);
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => { clearTimeout(t); resolve(Buffer.concat(chunks)); });
    stream.on("close", () => { clearTimeout(t); resolve(Buffer.concat(chunks)); });
    stream.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function edgeTTS(text, voice = VOICE) {
  const tts = new MsEdgeTTS();
  try {
    // OGG ישיר נחסם אצל Microsoft, לכן WebM עם Opus, ואז העברה ל-OGG בלי קידוד מחדש
    await tts.setMetadata(voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(text);
    const buf = await collect(audioStream, 60000);
    if (buf.length < 1000) throw new Error("הקריינות החזירה קובץ ריק");
    return { buf, ext: "webm" };
  } finally {
    try { tts.close(); } catch {}
  }
}

// גיבוי: Google Translate מקריא עד כ-200 תווים בכל בקשה, אז מחלקים למשפטים ומחברים את קובצי ה-MP3
async function googleTTS(text) {
  const parts = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if ((cur + " " + w).length > 180) { if (cur) parts.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) parts.push(cur);
  const bufs = [];
  for (const q of parts) {
    const r = await fetch(`https://translate.google.com/translate_tts?${new URLSearchParams({ ie: "UTF-8", tl: "iw", client: "tw-ob", q })}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`הקריינות של גוגל החזירה שגיאה ${r.status}`);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  return { buf: Buffer.concat(bufs), ext: "mp3" };
}

// ממיר כל קובץ קול ל-WAV (48kHz מונו), בשביל סרטונים. משך = (גודל - 44) / 96000 שניות
export function toWav(input, ext) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", ext, "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"]);
    const out = [];
    let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ההמרה של הקול לקחה יותר מדי זמן")); }, 30000);
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 1000) resolve(buf);
      else reject(new Error(`ההמרה של הקול נכשלה: ${err.slice(0, 200)}`));
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

// קריינות לסרטון: WAV בקול שנבחר (אישה: הילה, גבר: אברי)
export const VOICES = { female: "he-IL-HilaNeural", male: "he-IL-AvriNeural" };
export async function narrationWav(text, voice = "female") {
  const clean = speakable(text);
  if (!clean) return null;
  let audio;
  try {
    audio = await edgeTTS(clean, VOICES[voice] || VOICES.female);
  } catch (e) {
    console.log(`⚠️ הקריינות של Microsoft לא זמינה (${e.message}), עובר לגוגל`);
    audio = await googleTTS(clean);
  }
  return toWav(audio.buf, audio.ext);
}

function toOggOpus(input, ext) {
  return new Promise((resolve, reject) => {
    // WebM כבר ב-Opus: רק מעבירים לקופסה של OGG. MP3: מקודדים ל-Opus
    const codec = ext === "webm" ? ["-c:a", "copy"] : ["-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-ar", "48000"];
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", ext, "-i", "pipe:0", "-vn", ...codec, "-f", "ogg", "pipe:1"]);
    const out = [];
    let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ההמרה של הקול לקחה יותר מדי זמן")); }, 30000);
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 500) resolve(buf);
      else reject(new Error(`ההמרה של הקול נכשלה: ${err.slice(0, 200)}`));
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

/** מחזיר הודעה קולית (Buffer של OGG/Opus) מטקסט בעברית */
export async function synthesize(text) {
  const clean = speakable(text);
  if (!clean) throw new Error("אין טקסט להקראה");
  let audio;
  try {
    audio = await edgeTTS(clean);
  } catch (e) {
    console.log(`⚠️ הקריינות של Microsoft לא זמינה (${e.message}), עובר לגוגל`);
    audio = await googleTTS(clean);
  }
  return toOggOpus(audio.buf, audio.ext);
}

export const __test = { speakable, toOggOpus, googleTTS, edgeTTS };
