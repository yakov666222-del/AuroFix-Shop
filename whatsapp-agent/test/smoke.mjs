// בדיקה בלי ווטסאפ ובלי API אמיתי: מדמה את Claude ובודק את לולאת הכלים
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/wa-agent-test-" + Date.now();
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const calls = [];
const script = [
  // לקוח
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "notify_owner", input: { summary: "רוצה מחיר למסך S24", urgent: false } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "העברתי ליעקב, הוא יחזור אליך בקרוב 🙏" }] },
  // בעלים: שומר בזיכרון ועונה עם מקור
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "remember", input: { topic: "סטטוס העסק", fact: "עוסק זעיר, נפתח 2026" } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "כעוסק זעיר אתה פטור ממע״מ עד התקרה.", citations: [{ type: "web_search_result_location", url: "https://www.gov.il/example", title: "רשות המסים" }] }] },
];
Anthropic.Beta.Messages.prototype.create = async function (params) {
  calls.push(structuredClone(params));
  return script[calls.length - 1];
};
const { runAgent } = await import("../src/agent.js");
const { runTool } = await import("../src/tools.js");
const { memory } = await import("../src/store.js");
const sent = [];
const ctx = { sendText: async (j, t) => sent.push([j, t]), notifyOwner: async (t) => sent.push(["owner", t]), chatJid: "972501112222@s.whatsapp.net", chatName: "משה" };

console.log("customer reply:", await runAgent("customer", ctx.chatJid, "כמה עולה מסך לS24?", [], ctx));
console.log("notified:", sent);
console.log("customer tools:", calls[0].tools.map((t) => t.name));

const ownerReply = await runAgent("owner", "me@s.whatsapp.net", "אני עוסק זעיר, צריך לגבות מע״מ?", [], { ...ctx, chatJid: "me" });
console.log("owner reply:", ownerReply);
console.log("owner tools:", calls[2].tools.map((t) => t.name), "effort:", calls[2].output_config.effort);
console.log("memory now:", memory);
console.log("memory in next system:", calls[3].system[1].text);
console.log(await runTool("set_reminder", { at: new Date(Date.now() + 3600e3).toISOString(), text: "לשלם מקדמות" }, ctx));
setTimeout(() => process.exit(0), 500);
