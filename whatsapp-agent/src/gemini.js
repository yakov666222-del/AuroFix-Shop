// מנוע Gemini (מסלול חינמי של גוגל). אותם כלים ואותן הנחיות כמו ב-Claude.
import { GoogleGenAI } from "@google/genai";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import net from "node:net";

let ai = null;
let aiKey = null;
function client(apiKey) {
  if (!ai || aiKey !== apiKey) {
    ai = new GoogleGenAI({ apiKey });
    aiKey = apiKey;
    modelsCache = null;
  }
  return ai;
}

// מוצאים לבד אילו דגמים זמינים למפתח: קודם flash (מדויק), אחר כך flash-lite (גיבוי)
let modelsCache = null;
const ver = (n) => (n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0").split(".").map(Number);
const newer = (a, b) => { const [x, y] = [ver(a), ver(b)]; return (y[0] - x[0]) || ((y[1] ?? 0) - (x[1] ?? 0)); };
async function models(apiKey) {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (modelsCache) return modelsCache;
  const names = [];
  try {
    for await (const m of await client(apiKey).models.list()) {
      if ((m.supportedActions || []).includes("generateContent")) names.push(m.name.replace(/^models\//, ""));
    }
  } catch {}
  const plain = names.filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
  const lite = plain.filter((n) => n.endsWith("-lite")).sort(newer);
  const flash = plain.filter((n) => !n.endsWith("-lite")).sort(newer);
  // קודם flash (מדויק יותר עם נתונים ושמות), ו-flash-lite רק כגיבוי כשהמכסה נגמרת או שיש עומס
  modelsCache = [...flash.slice(0, 2), ...lite.slice(0, 2)];
  if (!modelsCache.length) modelsCache = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
  return modelsCache;
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { status: 504 })), ms))]);

// דגם שנגמרה לו המכסה (429) או שעמוס (503) מדלגים עליו לזמן מה, במקום לנסות אותו שוב בכל שלב
const blockedUntil = new Map();
// "חשיבה" מינימלית בדגמי Gemini 3 קלים: חוסכת הרבה זמן בפעולות פשוטות (בבדיקה: מ-9.7 שניות לחצי שנייה)
const thinkingFor = (model) => (/^gemini-3/.test(model) ? { thinkingLevel: /-lite$/.test(model) ? "minimal" : "low" } : null);
const noThinking = new Set(); // דגמים שלא מקבלים את ההגדרה

async function generate(apiKey, params) {
  let lastErr;
  let emptyReason = null;
  const all = await models(apiKey);
  const open = all.filter((m) => (blockedUntil.get(m) || 0) < Date.now());
  for (const model of open.length ? open : all) {
    try {
      const think = !noThinking.has(model) && thinkingFor(model);
      const config = think && !params.config?.thinkingConfig ? { ...params.config, thinkingConfig: think } : params.config;
      let res;
      try {
        res = await withTimeout(client(apiKey).models.generateContent({ model, ...params, config }), 30000);
      } catch (e) {
        if ((e?.status ?? e?.code) !== 400 || !think) throw e;
        noThinking.add(model); // הדגם לא תומך בהגדרת החשיבה: מנסים שוב בלעדיה
        res = await withTimeout(client(apiKey).models.generateContent({ model, ...params }), 30000);
      }
      // תשובה ריקה (בלי טקסט ובלי קריאה לכלי): מנסים את הדגם הבא במקום להחזיר כלום
      if (!(res.text || "").trim() && !res.functionCalls?.length) {
        const c = res.candidates?.[0];
        emptyReason = c?.finishReason || res.promptFeedback?.blockReason || "ללא סיבה";
        console.log(`⚠️ Gemini ${model} החזיר תשובה ריקה (${emptyReason}), מנסה דגם אחר`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const code = e?.status ?? e?.code;
      if (![404, 429, 500, 503, 504].includes(code)) throw e; // שגיאה אחרת: לא מנסים דגם אחר
      blockedUntil.set(model, Date.now() + (code === 429 || code === 404 ? 30 : 3) * 60_000);
      console.log(`⚠️ Gemini ${model} לא זמין (${code}), מנסה דגם אחר`);
    }
  }
  if (emptyReason && !lastErr) throw new Error(`Gemini החזיר תשובה ריקה מכל הדגמים (${emptyReason}). נסה לנסח אחרת.`);
  if ((lastErr?.status ?? lastErr?.code) === 429) {
    throw new Error("הגעתי למכסה החינמית של Gemini להיום. נסה שוב מאוחר יותר.");
  }
  throw new Error("Gemini עמוס כרגע. נסה שוב בעוד דקה.");
}

// חיפוש בגוגל כבקשה נפרדת, כך שאפשר לשלב אותו עם שאר הכלים
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "מחפש בגוגל מידע עדכני (חוקי מס, תקרות, מועדים, מחירים, חדשות) ומחזיר תשובה עם מקורות. נסח שאילתה ממוקדת, עדיף בעברית ועם השנה.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

// חיפוש דרך Tavily (שירות חיפוש לסוכני AI: 1,000 חיפושים בחודש בחינם, בלי כרטיס אשראי).
// משמש כשהחיפוש של גוגל דרך Gemini לא זמין במסלול החינמי. המפתח נשמר בעמוד ההגדרות של היועץ.
function tavilyKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  try { return fs.readFileSync(path.join(DATA_DIR, "tavily_key"), "utf8").trim() || null; } catch { return null; }
}

async function tavilySearch(query, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: 6, search_depth: "basic", include_answer: true }),
    });
    if (res.status === 401 || res.status === 403) throw new Error("מפתח החיפוש (Tavily) לא תקין");
    if (res.status === 429 || res.status === 432 || res.status === 433) throw new Error("נגמרה מכסת החיפושים החינמית של החודש (Tavily)");
    if (!res.ok) throw new Error(`שירות החיפוש החזיר שגיאה ${res.status}`);
    const d = await res.json();
    return { answer: d.answer || "", results: (d.results || []).map((r) => ({ url: r.url, title: r.title || r.url, snippet: String(r.content || "").slice(0, 500) })) };
  } finally { clearTimeout(t); }
}

// כשגוגל מחזיר "אין מכסה" לחיפוש, לא מנסים שוב 6 שעות (חוסך זמן ובקשות)
let groundingBlockedUntil = 0;

async function webSearch(apiKey, query) {
  if (Date.now() > groundingBlockedUntil) try {
    const res = await generate(apiKey, {
      contents: [{ role: "user", parts: [{ text: `חפש וענה בקצרה ובעובדות בלבד, עם מספרים ותאריכים מדויקים: ${query}` }] }],
      config: { tools: [{ googleSearch: {} }] },
    });
    const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const sources = [...new Map(chunks.filter((c) => c.web?.uri).map((c) => [c.web.uri, c.web.title || c.web.uri])).entries()]
      .slice(0, 6)
      .map(([uri, title]) => `${title}: ${uri}`);
    if (chunks.length) return { text: res.text || "לא נמצא מידע.", sources };
  } catch (e) {
    groundingBlockedUntil = Date.now() + 6 * 3600_000;
    console.log(`⚠️ חיפוש גוגל דרך Gemini לא זמין (${e.status ?? e.message}), עובר לחיפוש ב-Tavily`);
  }
  const key = tavilyKey();
  if (!key) {
    return {
      text: "אין כרגע חיבור לחיפוש באינטרנט: החיפוש של גוגל לא כלול במסלול החינמי של Gemini, ועוד לא הוגדר מפתח Tavily. אמור לבעלים שצריך להוסיף מפתח Tavily בעמוד ההגדרות של היועץ (חינמי). אל תמציא מידע במקום החיפוש. אם יש לך כתובת של דף, אפשר לקרוא אותו עם read_webpage.",
      sources: [],
    };
  }
  const { answer, results } = await tavilySearch(query, key);
  if (!results.length && !answer) return { text: "החיפוש לא מצא תוצאות. נסה ניסוח אחר.", sources: [] };
  return {
    text: (answer ? `תקציר: ${answer}\n\n` : "") +
      "תוצאות (לפרטים מלאים כמו מחירון, קרא את הדף עם read_webpage):\n" +
      results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n"),
    sources: results.slice(0, 6).map((r) => `${r.title}: ${r.url}`),
  };
}

// קריאת דף אינטרנט מלא (מחירונים, אתרי מתחרים, ספקים). רק כתובות ציבוריות:
// השרת יושב ברשת פנימית עם מערכת המעבדה, אז חוסמים כתובות פנימיות כדי שאף דף לא ינצל את זה.
const READ_PAGE_TOOL = {
  name: "read_webpage",
  description:
    "קורא את התוכן של דף אינטרנט ציבורי לפי כתובת (למשל מחירון של מעבדה מתחרה, דף מוצר של ספק, כתבה). השתמש אחרי web_search כשצריך את הפרטים המלאים מהדף.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "כתובת מלאה שמתחילה ב-https://" } },
    required: ["url"],
  },
};

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error("אפשר לקרוא רק כתובות http/https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("זו כתובת פנימית, לא קורא אותה");
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const body = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { title, body };
}

async function readWebpage(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new Error("כתובת לא תקינה"); }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(u, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; YakovPhoneAdvisor/1.0)", "Accept-Language": "he,en;q=0.8" } });
    } finally { clearTimeout(t); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      u = new URL(res.headers.get("location"), u);
      continue;
    }
    if (!res.ok) throw new Error(`האתר החזיר שגיאה ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!/text\/|html|json|xml/.test(type)) throw new Error(`זה לא דף טקסט (${type || "סוג לא ידוע"})`);
    const raw = (await res.text()).slice(0, 1_500_000);
    const { title, body } = /html/.test(type) ? htmlToText(raw) : { title: "", body: raw };
    const max = 12000;
    return `כתובת: ${u.href}\n${title ? `כותרת: ${title}\n` : ""}${body.slice(0, max)}${body.length > max ? "\n[...הדף ארוך, קוצר]" : ""}`;
  }
  throw new Error("יותר מדי הפניות");
}

/** תמלול הודעה קולית בעברית. audio = { mime, data(base64) } */
export async function transcribeAudio(apiKey, audio) {
  const res = await generate(apiKey, {
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: audio.mime.includes("ogg") ? "audio/ogg" : audio.mime, data: audio.data } },
        { text: "תמלל את ההקלטה מילה במילה, בשפה שבה היא נאמרה (בדרך כלל עברית). החזר רק את התמלול, בלי הקדמה ובלי הערות. אם לא שומעים דיבור, החזר בדיוק: [שקט]" },
      ],
    }],
  });
  return (res.text || "").trim();
}

/**
 * לולאת שיחה עם Gemini.
 * @returns {{ text: string, sources: string[] }}
 */
export async function runGemini({ apiKey, system, tools, history, text, images, runTool, withSearch }) {
  const allTools = withSearch ? [WEB_SEARCH_TOOL, READ_PAGE_TOOL, ...tools] : tools;
  const functionDeclarations = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.input_schema,
  }));

  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    {
      role: "user",
      parts: [...images.map((img) => ({ inlineData: { mimeType: img.media_type, data: img.data } })), { text }],
    },
  ];

  const sources = [];
  for (let step = 0; step < 18; step++) { // סקר שוק צריך כמה חיפושים וקריאות דפים
    const res = await generate(apiKey, {
      contents,
      config: { systemInstruction: system, tools: [{ functionDeclarations }] },
    });

    const calls = res.functionCalls ?? [];
    if (!calls.length) return { text: (res.text || "").trim(), sources };

    // מחזירים את תשובת המודל כמו שהיא (כולל חתימות חשיבה), ואז את תוצאות הכלים
    contents.push(res.candidates[0].content);
    const parts = [];
    for (const call of calls) {
      let result;
      try {
        if (call.name === "web_search" && withSearch) {
          const r = await webSearch(apiKey, call.args?.query || "");
          sources.push(...r.sources);
          result = r.text + (r.sources.length ? `\nמקורות:\n${r.sources.join("\n")}` : "");
        } else if (call.name === "read_webpage" && withSearch) {
          result = await readWebpage(call.args?.url || "");
          sources.push(`דף: ${call.args?.url}`);
        } else {
          result = await runTool(call.name, call.args ?? {});
        }
      } catch (e) {
        result = `שגיאה: ${e.message || e}`;
      }
      parts.push({ functionResponse: { name: call.name, id: call.id, response: { result } } });
    }
    contents.push({ role: "user", parts });
  }
  return { text: "⚠️ נתקעתי בלולאה של פעולות ולא הגעתי לתשובה. נסה לנסח את הבקשה בצורה פשוטה יותר.", sources };
}

// לבדיקות בלבד: החלפת הלקוח בלקוח מדומה
export const __test = { readWebpage, privateIp, htmlToText, tavilySearch, webSearch };

export function __setTestClient(fake, apiKey) {
  ai = fake;
  aiKey = apiKey;
}
