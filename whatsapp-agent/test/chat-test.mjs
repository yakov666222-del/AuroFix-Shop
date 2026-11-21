// בדיקת דף הצ'אט עם Gemini מדומה ומערכת מעבדה מדומה
process.env.DATA_DIR = "/tmp/wa-chat-" + Date.now();
process.env.PORT = "3874"; process.env.QR_PAGE_KEY = "k"; process.env.WA_MODE = "cloud";
process.env.GEMINI_API_KEY = "AIza-test-not-real-0000000000000000";
process.env.LAB_API_URL = "http://127.0.0.1:3881";
(await import("./lab-mock.mjs")).start(3881);
let n = 0;
(await import("../src/gemini.js")).__setTestClient({ models: { generateContent: async (p) => {
  n++;
  const last = p.contents.at(-1);
  if (last.role === "user" && last.parts[0]?.text?.includes("השתמשתי")) {
    return { functionCalls: [{ name: "propose_inventory_change", args: { item_id: "a1", delta: -2, reason: "שימוש" }, id: "x" }],
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "propose_inventory_change", args: { item_id: "a1", delta: -2, reason: "שימוש" } } }] } }] };
  }
  return { text: "מוריד 2 מסכי אייפון 12, נשארים 3. לאשר?", candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] };
} } }, "AIza-test-not-real-0000000000000000");
await import("../src/index.js");
await new Promise((r) => setTimeout(r, 800));
const B = "http://127.0.0.1:3874";
console.log("page:", (await fetch(B + "/chat?key=k")).status, "| no key:", (await fetch(B + "/chat")).status);
const send = async (text) => (await (await fetch(B + "/chat/send?key=k", { method: "POST", body: JSON.stringify({ text }) })).json()).reply;
console.log("1:", await send("השתמשתי בשני מסכים לאייפון 12"));
console.log("2:", await send("כן"));
console.log("3:", await send("!סטטוס"));
const { reminders } = await import("../src/store.js");
reminders.push({ id: "r1", at: Date.now() - 1, text: "להזמין מסכים" });
await new Promise((r) => setTimeout(r, 21000));
console.log("inbox:", JSON.stringify((await (await fetch(B + "/chat/inbox?key=k")).json()).items.map((i) => i.text)));
console.log("history len:", (await (await fetch(B + "/chat/history?key=k")).json()).history.length);
process.exit(0);
