// וידאו AI אמיתי (אנשים שזזים, מצלמה, סאונד) עם Gemini Omni Flash של גוגל. בתשלום: כ-0.07 דולר לשנייה ב-720p.
// עובד עם מפתח נפרד (video_key) מפרויקט גוגל שהחיוב בו פעיל, כדי שהמוח החינמי של היועצת יישאר בחינם.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const OMNI_MODEL = process.env.OMNI_MODEL || "gemini-omni-1.2-flash";
export const USD_PER_SECOND = 0.07; // 720p, לפי דף המחירים של גוגל (נובמבר 2026)
const KEY_FILE = path.join(DATA_DIR, "video_key");
const USAGE_FILE = path.join(DATA_DIR, "video_usage.json");

export const getVideoKey = () => process.env.VIDEO_API_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, "utf8").trim() : "");

// ---------- תקציב חודשי: לא עוברים את הסכום שהבעלים קבע ----------
function usage() {
  const month = new Date().toISOString().slice(0, 7);
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (u.month === month) return u;
  } catch {}
  return { month, usd: 0, videos: 0, budget: undefined };
}
export function videoBudget() {
  const u = usage();
  let budget = 10;
  try { budget = Number(JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")).budget) || 10; } catch {}
  return { spent: Math.round(u.usd * 100) / 100, videos: u.videos, budget, left: Math.max(0, budget - u.usd) };
}
export function setVideoBudget(usd) {
  const u = usage();
  u.budget = Math.max(1, Math.min(200, Number(usd) || 10));
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u));
}
export function chargeUsage(usd) {
  const u = usage();
  const b = videoBudget().budget;
  u.usd += usd;
  u.budget = b;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u));
}
function addUsage(usd) {
  const u = usage();
  const b = videoBudget().budget;
  u.usd += usd;
  u.videos += 1;
  u.budget = b;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u));
}

async function api(pathname, { method = "GET", body, timeout = 60_000, raw = false } = {}) {
  const r = await fetch(`${BASE}/${pathname}`, {
    method,
    headers: { "x-goog-api-key": getVideoKey(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (raw) {
    if (!r.ok) throw new Error(`הורדת הסרטון נכשלה (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `שגיאה ${r.status}`;
    if (r.status === 403 || /billing|paid tier|not available/i.test(msg)) throw new Error(`גוגל לא מאפשר וידאו במפתח הזה: צריך חיוב פעיל בפרויקט (${msg.slice(0, 120)})`);
    if (r.status === 429) throw new Error("גוגל עמוס או שנגמרה המכסה. נסה שוב בעוד כמה דקות");
    throw new Error(msg.slice(0, 200));
  }
  return data;
}

// מחפש את הסרטון בתשובה: או data (base64) או uri (קובץ אצל גוגל)
function findVideo(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.output_video && (obj.output_video.uri || obj.output_video.data)) return obj.output_video;
  if ((obj.type === "video" || String(obj.mime_type || "").startsWith("video/")) && (obj.uri || obj.data)) return obj;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const f = findVideo(v);
    if (f) return f;
  }
  return null;
}

/**
 * יוצר קליפ וידאו. מחזיר Buffer של MP4.
 * @param {{prompt:string, aspect?:"9:16"|"16:9", seconds?:number, images?:{mime:string,data:string}[]}} o
 */
export async function generateClip(o) {
  if (!getVideoKey()) throw new Error("אין מפתח וידאו. צריך להדביק אותו בעמוד ההגדרות של היועצת, בכרטיס 🎬 וידאו AI");
  const seconds = Math.max(3, Math.min(15, Math.round(o.seconds || 15)));
  const cost = seconds * USD_PER_SECOND;
  const b = videoBudget();
  if (cost > b.left) throw new Error(`התקציב החודשי לסרטונים נגמר (${b.spent} מתוך ${b.budget} דולר). אפשר להגדיל אותו בעמוד ההגדרות`);
  const input = o.images?.length
    ? [...o.images.slice(0, 6).map((im) => ({ type: "image", data: im.data, mime_type: im.mime })), { type: "text", text: o.prompt }]
    : o.prompt;
  const res = await api("interactions", {
    method: "POST",
    timeout: 8 * 60_000,
    body: {
      model: OMNI_MODEL,
      input,
      response_format: { type: "video", aspect_ratio: o.aspect || "9:16", duration: `${seconds}s`, resolution: "720p", delivery: "uri" },
      store: true, // חובה כשהסרטון חוזר כקישור (delivery: uri)
      background: false,
      stream: false,
    },
  });
  addUsage(cost); // גוגל מחייב גם אם ההורדה נכשלת אחר כך
  const v = findVideo(res);
  if (!v) throw new Error(`גוגל לא החזיר סרטון${res?.status ? ` (${res.status})` : ""}. ייתכן שהבקשה נחסמה בסינון התוכן`);
  if (v.data) return Buffer.from(v.data, "base64");
  // URI: מחכים שהקובץ יהיה מוכן ומורידים
  const id = String(v.uri).split("files/").pop().split(/[/?:]/)[0];
  for (let i = 0; i < 120; i++) {
    const f = await api(`files/${id}`);
    if (f.state === "ACTIVE") break;
    if (f.state === "FAILED") throw new Error("גוגל לא הצליח לסיים את הסרטון");
    await new Promise((r) => setTimeout(r, 5000));
  }
  return api(`files/${id}:download?alt=media`, { raw: true, timeout: 5 * 60_000 });
}

// ---------- תמונות (Nano Banana 2 של גוגל): תצוגה מקדימה של מראה הדמות, לפני שמשלמים על סרטון ----------
export const IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-3.1-flash-image";
export const USD_PER_IMAGE = 0.067; // 1K, לפי דף המחירים של גוגל (נובמבר 2026)

/** יוצר תמונה אחת. refs: תמונות רפרנס (base64). מחזיר { buf, mime } */
export async function generateImage(prompt, { refs = [], aspect = "9:16" } = {}) {
  if (!getVideoKey()) throw new Error("אין מפתח של גוגל בתשלום");
  const b = videoBudget();
  if (USD_PER_IMAGE > b.left) throw new Error(`התקציב החודשי נגמר (${b.spent} מתוך ${b.budget} דולר)`);
  const parts = [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data } })), { text: prompt }];
  const res = await api(`models/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    timeout: 120_000,
    body: { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect, imageSize: "1K" } } },
  });
  chargeUsage(USD_PER_IMAGE);
  const img = (res.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!img) throw new Error(`גוגל לא החזיר תמונה (${res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason || "לא ידוע"})`);
  return { buf: Buffer.from(img.inlineData.data, "base64"), mime: img.inlineData.mimeType || "image/png" };
}

// ---------- קריינות של גוגל (Gemini TTS): הרבה קולות, תומך בעברית ----------
export const TTS_MODEL = process.env.TTS_MODEL || "gemini-3.8-flash-tts";
// תפריט קולות: השם אצל גוגל והתיאור בעברית
export const VOICE_MENU = [
  { id: "Sulafat", label: "אישה, חמה ונעימה" },
  { id: "Kore", label: "אישה, בטוחה ותקיפה" },
  { id: "Leda", label: "אישה, צעירה ורעננה" },
  { id: "Aoede", label: "אישה, קלילה ומשוחררת" },
  { id: "Achernar", label: "אישה, רכה ושקטה" },
  { id: "Pulcherrima", label: "אישה, נמרצת וישירה" },
  { id: "Gacrux", label: "אישה, בוגרת ומנוסה" },
  { id: "Charon", label: "גבר, מקצועי ומסביר" },
  { id: "Puck", label: "גבר, אנרגטי ושמח" },
  { id: "Fenrir", label: "גבר, נלהב ומתלהב" },
  { id: "Algenib", label: "גבר, עמוק ומחוספס" },
  { id: "Achird", label: "גבר, חברי וזורם" },
  { id: "Sadaltager", label: "גבר, בוגר ואמין" },
  { id: "Orus", label: "גבר, תקיף וסמכותי" },
];

/** קריינות בקול של גוגל. מחזיר WAV */
export async function geminiSpeech(text, voice, style = "") {
  if (!getVideoKey()) throw new Error("אין מפתח של גוגל בתשלום לקולות של גוגל");
  const res = await api("interactions", {
    method: "POST",
    timeout: 90_000,
    body: {
      model: TTS_MODEL,
      input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: `Native Israeli Hebrew speaker, natural Israeli accent. Speak slowly and calmly, at a relaxed pace, with natural pauses between sentences, like a warm TV commercial voice-over. ${style}`.trim() }] }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
      store: false,
    },
  });
  chargeUsage(0.002);
  const audio = (function find(o) {
    if (!o || typeof o !== "object") return null;
    if ((o.type === "audio" || String(o.mime_type || "").startsWith("audio/")) && o.data) return o;
    for (const v of Array.isArray(o) ? o : Object.values(o)) {
      const f = find(v);
      if (f) return f;
    }
    return null;
  })(res);
  if (!audio) throw new Error("גוגל לא החזיר קול");
  return { buf: Buffer.from(audio.data, "base64"), mime: audio.mime_type || "audio/wav" };
}
