// בדיקת מנוע Gemini עם תשובות מדומות
process.env.DATA_DIR = "/tmp/wa-gem-test-" + Date.now();
process.env.GEMINI_API_KEY = "AIza-test";
const genai = await import("@google/genai");
const calls = [];
let n = 0;
const fakeGen = async function (params) {
  calls.push(structuredClone(params));
  n++;
  const fc = (name, args) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args, id: "c" + n } }] } }], functionCalls: [{ name, args, id: "c" + n }] });
  if (params.config?.tools?.[0]?.googleSearch) return { text: "התקרה לעוסק זעיר ב-2026 היא 122,833 ₪", candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://www.gov.il/x", title: "רשות המסים" } }] } }] };
  if (n === 1) return fc("web_search", { query: "תקרת עוסק זעיר 2026" });
  if (n === 3) return fc("remember", { topic: "שלב", fact: "עוסק זעיר" });
  return { text: "נכון לעכשיו (2026) התקרה היא כ-122,833 ₪. רוצה שנבדוק כמה הכנסת השנה?", candidates: [{ content: { role: "model", parts: [{ text: "..." }] } }] };
};
process.env.GEMINI_MODEL = "gemini-test"; (await import("../src/gemini.js")).__setTestClient({ models: { generateContent: fakeGen } }, "AIza-test");
const { runAgent, provider } = await import("../src/agent.js");
const { memory } = await import("../src/store.js");
console.log("provider:", provider());
const reply = await runAgent("owner", "me", "מה התקרה לעוסק זעיר?", [], { sendText: async () => {}, notifyOwner: async () => {}, chatJid: "me" });
console.log("reply:\n" + reply);
console.log("memory:", memory);
console.log("models used:", calls.map((c) => c.model));
console.log("decls:", calls[0].config.tools[0].functionDeclarations.map((d) => d.name).join(","));
console.log("last request contents roles:", calls.at(-1).contents.map((c) => c.role).join(","));
process.exit(0);
