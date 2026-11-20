// בדיקה בלי ווטסאפ ובלי API אמיתי: מדמה את Claude ובודק את לולאת הכלים
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/wa-agent-test";
const Anthropic = (await import("@anthropic-ai/sdk")).default;
const calls = [];
let step = 0;
Anthropic.Beta.Messages.prototype.create = async function (params) {
  calls.push(params);
  if (step++ === 0)
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "notify_owner", input: { summary: "רוצה מחיר למסך S24", urgent: false } }] };
  return { stop_reason: "end_turn", content: [{ type: "text", text: "העברתי ליעקב, הוא יחזור אליך בקרוב 🙏" }] };
};
const { runAgent } = await import("../src/agent.js");
const { runTool } = await import("../src/tools.js");
const { logMessage } = await import("../src/store.js");
const sent = [];
const ctx = { sendText: async (j, t) => sent.push([j, t]), notifyOwner: async (t) => sent.push(["owner", t]), chatJid: "972501112222@s.whatsapp.net", chatName: "משה" };
const reply = await runAgent("customer", ctx.chatJid, "כמה עולה מסך לS24?", [], ctx);
console.log("reply:", reply);
console.log("sent:", sent);
console.log("2nd request messages:", calls[1].messages.length, "tools:", calls[0].tools.map((t) => t.name), "betas:", calls[0].betas, "fallbacks:", calls[0].fallbacks);
logMessage("972501112222@s.whatsapp.net", "them", "שלום", { name: "משה", phone: "972501112222" });
console.log(await runTool("list_recent_chats", { limit: 5 }, ctx));
console.log(await runTool("send_whatsapp_message", { to: "משה", text: "הטלפון מוכן" }, ctx), sent.at(-1));
console.log(await runTool("send_whatsapp_message", { to: "050-333-4444", text: "היי" }, ctx), sent.at(-1));
console.log(await runTool("set_reminder", { at: new Date(Date.now() + 3600e3).toISOString(), text: "להזמין מסכים" }, ctx));
console.log(await runTool("list_reminders", {}, ctx));
setTimeout(() => process.exit(0), 500);
