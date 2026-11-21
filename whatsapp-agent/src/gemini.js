// מנוע Gemini (מסלול חינמי של גוגל). אותם כלים ואותן הנחיות כמו ב-Claude.
import { GoogleGenAI } from "@google/genai";

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

// מוצאים לבד אילו דגמים זמינים למפתח: קודם flash-lite (מהיר), אחר כך flash (חכם יותר)
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
  modelsCache = [...lite.slice(0, 2), ...flash.slice(0, 2)];
  if (!modelsCache.length) modelsCache = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
  return modelsCache;
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { status: 504 })), ms))]);

async function generate(apiKey, params) {
  let lastErr;
  for (const model of await models(apiKey)) {
    try {
      return await withTimeout(client(apiKey).models.generateContent({ model, ...params }), 45000);
    } catch (e) {
      lastErr = e;
      const code = e?.status ?? e?.code;
      if (![404, 429, 500, 503, 504].includes(code)) throw e; // שגיאה אחרת: לא מנסים דגם אחר
      console.log(`⚠️ Gemini ${model} לא זמין (${code}), מנסה דגם אחר`);
    }
  }
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

async function webSearch(apiKey, query) {
  const res = await generate(apiKey, {
    contents: [{ role: "user", parts: [{ text: `חפש וענה בקצרה ובעובדות בלבד, עם מספרים ותאריכים מדויקים: ${query}` }] }],
    config: { tools: [{ googleSearch: {} }] },
  });
  const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources = [...new Map(chunks.filter((c) => c.web?.uri).map((c) => [c.web.uri, c.web.title || c.web.uri])).entries()]
    .slice(0, 4)
    .map(([uri, title]) => `${title}: ${uri}`);
  return { text: res.text || "לא נמצא מידע.", sources };
}

/**
 * לולאת שיחה עם Gemini.
 * @returns {{ text: string, sources: string[] }}
 */
export async function runGemini({ apiKey, system, tools, history, text, images, runTool, withSearch }) {
  const allTools = withSearch ? [WEB_SEARCH_TOOL, ...tools] : tools;
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
  for (let step = 0; step < 10; step++) {
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
  return { text: "", sources };
}

// לבדיקות בלבד: החלפת הלקוח בלקוח מדומה
export function __setTestClient(fake, apiKey) {
  ai = fake;
  aiKey = apiKey;
}
