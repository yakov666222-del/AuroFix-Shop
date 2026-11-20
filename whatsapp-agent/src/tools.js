// הכלים שהסוכן יכול להפעיל.
// ללקוחות יש רק כלי אחד (להעביר הודעה לבעלים) - כדי שאף לקוח לא יוכל
// "לשכנע" את הסוכן לשלוח הודעות בשמך. כל שאר הכלים זמינים רק לך.
import { chats, reminders, saveReminders } from "./store.js";

const strict = (props, required = Object.keys(props)) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

export const CUSTOMER_TOOLS = [
  {
    name: "notify_owner",
    description:
      "שולח הודעה פרטית לבעל העסק. השתמש כשהלקוח מבקש לדבר עם אדם, כשיש שאלה שאתה לא יודע לענות עליה (מחיר לא ידוע, סטטוס תיקון, תלונה), או כשנקבע תור/איסוף.",
    strict: true,
    input_schema: strict({
      summary: { type: "string", description: "סיכום קצר של מה הלקוח צריך" },
      urgent: { type: "boolean", description: "האם דחוף" },
    }),
  },
];

export const OWNER_TOOLS = [
  {
    name: "send_whatsapp_message",
    description:
      "שולח הודעת ווטסאפ בשם הבעלים. 'to' יכול להיות מספר טלפון (למשל 0501234567 או 972501234567) או שם איש קשר מהצ'אטים האחרונים. שלח רק כשהבעלים ביקש במפורש לשלוח.",
    strict: true,
    input_schema: strict({
      to: { type: "string" },
      text: { type: "string" },
    }),
  },
  {
    name: "list_recent_chats",
    description: "מחזיר רשימה של הצ'אטים האחרונים עם ההודעה האחרונה בכל אחד ומספר הודעות שלא נענו.",
    strict: true,
    input_schema: strict({ limit: { type: "integer", description: "כמה צ'אטים (ברירת מחדל 15)" } }),
  },
  {
    name: "read_chat",
    description: "קורא את ההודעות האחרונות בצ'אט מסוים (לפי שם או מספר).",
    strict: true,
    input_schema: strict({
      who: { type: "string" },
      limit: { type: "integer", description: "כמה הודעות (ברירת מחדל 30)" },
    }),
  },
  {
    name: "set_reminder",
    description:
      "קובע תזכורת שתישלח לבעלים בווטסאפ. 'at' בפורמט ISO 8601 עם אזור זמן (למשל 2026-11-21T09:00:00+02:00).",
    strict: true,
    input_schema: strict({ at: { type: "string" }, text: { type: "string" } }),
  },
  {
    name: "list_reminders",
    description: "מציג את התזכורות הפתוחות.",
    strict: true,
    input_schema: strict({}),
  },
  {
    name: "cancel_reminder",
    description: "מבטל תזכורת לפי מזהה.",
    strict: true,
    input_schema: strict({ id: { type: "string" } }),
  },
];

// ---------- עזרים ----------
export function phoneToJid(input) {
  let d = String(input).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0")) d = "972" + d.slice(1); // ברירת מחדל: ישראל
  return d + "@s.whatsapp.net";
}

export function findChat(who) {
  const q = String(who).trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const entries = Object.entries(chats).sort((a, b) => (b[1].lastTs ?? 0) - (a[1].lastTs ?? 0));
  for (const [jid, c] of entries) {
    if (digits.length >= 6) {
      const tail = digits.replace(/^0/, "");
      if ((c.phone || "").endsWith(tail) || jid.split("@")[0].endsWith(tail)) return jid;
    } else if (c.name && c.name.toLowerCase().includes(q)) {
      return jid;
    }
  }
  return null;
}

const fmt = (ts) =>
  new Date(ts).toLocaleString("he-IL", { timeZone: process.env.TZ_NAME || "Asia/Jerusalem" });

// ---------- הרצת כלי ----------
// ctx = { sendText(jid, text), notifyOwner(text), chatJid, chatName }
export async function runTool(name, input, ctx) {
  switch (name) {
    case "notify_owner": {
      const who = ctx.chatName || ctx.chatJid.split("@")[0];
      await ctx.notifyOwner(
        `${input.urgent ? "🔴 דחוף" : "🔔"} לקוח צריך אותך\n👤 ${who}\n📝 ${input.summary}`
      );
      return "ההודעה הועברה לבעלים.";
    }

    case "send_whatsapp_message": {
      const jid = findChat(input.to) || phoneToJid(input.to);
      if (!jid) return `לא מצאתי איש קשר בשם "${input.to}". בקש מספר טלפון.`;
      await ctx.sendText(jid, input.text);
      return `נשלח ל-${chats[jid]?.name || jid.split("@")[0]}.`;
    }

    case "list_recent_chats": {
      const list = Object.entries(chats)
        .sort((a, b) => (b[1].lastTs ?? 0) - (a[1].lastTs ?? 0))
        .slice(0, input.limit || 15)
        .map(([jid, c]) => {
          const last = c.messages.at(-1);
          let unanswered = 0;
          for (let i = c.messages.length - 1; i >= 0 && c.messages[i].from === "them"; i--) unanswered++;
          return `• ${c.name || "ללא שם"} (${c.phone || jid.split("@")[0]}) | ${fmt(last?.ts)} | ${
            unanswered ? `${unanswered} לא נענו | ` : ""
          }אחרונה: ${last?.text?.slice(0, 80) ?? ""}`;
        });
      return list.length ? list.join("\n") : "אין עדיין צ'אטים שמורים.";
    }

    case "read_chat": {
      const jid = findChat(input.who);
      if (!jid) return `לא מצאתי צ'אט עבור "${input.who}".`;
      const c = chats[jid];
      const label = { them: c.name || "הוא/היא", me: "אתה", bot: "הסוכן" };
      return c.messages
        .slice(-(input.limit || 30))
        .map((m) => `[${fmt(m.ts)}] ${label[m.from]}: ${m.text}`)
        .join("\n");
    }

    case "set_reminder": {
      const at = Date.parse(input.at);
      if (Number.isNaN(at)) return "פורמט זמן לא תקין.";
      if (at < Date.now()) return "הזמן הזה כבר עבר.";
      const id = Math.random().toString(36).slice(2, 7);
      reminders.push({ id, at, text: input.text });
      saveReminders();
      return `תזכורת ${id} נקבעה ל-${fmt(at)}.`;
    }

    case "list_reminders":
      return reminders.length
        ? reminders.map((r) => `${r.id}: ${fmt(r.at)} - ${r.text}`).join("\n")
        : "אין תזכורות פתוחות.";

    case "cancel_reminder": {
      const i = reminders.findIndex((r) => r.id === input.id);
      if (i < 0) return "לא נמצאה תזכורת כזו.";
      reminders.splice(i, 1);
      saveReminders();
      return "התזכורת בוטלה.";
    }

    default:
      throw new Error(`כלי לא מוכר: ${name}`);
  }
}
