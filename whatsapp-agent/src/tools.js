// הכלים שהסוכן יכול להפעיל.
// ללקוחות יש רק כלי אחד (להעביר הודעה לבעלים) - כדי שאף לקוח לא יוכל
// "לשכנע" את הסוכן לשלוח הודעות בשמך. כל שאר הכלים זמינים רק לך.
import { chats, ledger, memory, reminders, saveLedger, saveMemory, saveReminders } from "./store.js";
import * as lab from "./lab.js";
import { CHECKLIST_TOOL, updateItem } from "./checklist.js";

// שינויי מלאי שממתינים לאישור הבעלים ("כן"). מבוצעים רק ב-index.js, לא על ידי המודל.
export const pendingChanges = [];

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

const LEDGER_TOOLS = [
  {
    name: "record_transaction",
    description:
      "רושם הכנסה או הוצאה של העסק ביומן (כשהבעלים מדווח למשל 'קיבלתי 300 על תיקון מסך' או 'קניתי חלקים ב-500'). לפני הרישום אשר בשורה אחת מה הבנת.",
    strict: true,
    input_schema: strict({
      type: { type: "string", enum: ["income", "expense"] },
      amount: { type: "number", description: "סכום בשקלים" },
      desc: { type: "string", description: "תיאור קצר" },
      date: { type: "string", description: "תאריך YYYY-MM-DD (היום אם לא נאמר אחרת)" },
    }),
  },
  {
    name: "ledger_summary",
    description:
      "סיכום הכנסות והוצאות לשנה: מה שדווח בווטסאפ + תשלומים שנרשמו במערכת המעבדה. השתמש כדי לעקוב אחרי המחזור השנתי מול תקרת העוסק הזעיר/פטור.",
    strict: true,
    input_schema: strict({ year: { type: "integer" } }),
  },
  {
    name: "delete_transaction",
    description: "מוחק רישום מהיומן לפי מזהה (אם נרשם בטעות).",
    strict: true,
    input_schema: strict({ id: { type: "string" } }),
  },
];

const LAB_TOOLS = [
  {
    name: "search_inventory",
    description: "מחפש פריט במלאי של מערכת המעבדה (לפי שם, דגם, מק\"ט או קטגוריה) ומחזיר כמות, מינימום, עלות, מחיר ומזהה (id).",
    strict: true,
    input_schema: strict({ query: { type: "string", description: "למשל 'מסך אייפון 12' או 'סוללה 11 פרו'" } }),
  },
  {
    name: "inventory_shortages",
    description: "מה חסר: פריטים מתחת לכמות המינימום, עם כמות מומלצת להזמנה ועלות משוערת.",
    strict: true,
    input_schema: strict({}),
  },
  {
    name: "propose_inventory_change",
    description:
      "מציע שינוי כמות במלאי (delta שלילי = השתמשתי/מכרתי, חיובי = הגיעה הזמנה). השינוי לא מתבצע עד שהבעלים עונה 'כן'. קודם מצא את הפריט עם search_inventory כדי לקבל id. אחרי ההצעה, שאל את הבעלים בשורה אחת אם לאשר.",
    strict: true,
    input_schema: strict({
      item_id: { type: "string" },
      delta: { type: "integer" },
      reason: { type: "string", description: "למשל 'שימוש בתיקון' או 'הגיעה הזמנה מספק'" },
    }),
  },
  {
    name: "mark_ordered",
    description:
      "מסמן פריט חסר כ'הוזמן' (הבעלים הזמין אותו מספק): יוצר הזמנה ממתינה במערכת המעבדה, כך שהוא מפסיק להופיע כחוסר. כשההזמנה מגיעה, מסמנים במערכת 'התקבל' והכמות נכנסת למלאי. qty=0 = הכמות המומלצת. כשהבעלים אומר 'הזמנתי הכל', קרא לכלי פעם אחת לכל פריט ברשימת החוסרים האחרונה.",
    strict: true,
    input_schema: strict({
      item_id: { type: "string" },
      qty: { type: "integer", description: "כמה הוזמן. 0 = הכמות המומלצת" },
      note: { type: "string", description: "ספק, מחיר, מועד הגעה צפוי וכו'. ריק אם אין" },
    }),
  },
  {
    name: "find_repairs",
    description: "מחפש תיקונים במערכת המעבדה לפי שם לקוח, דגם, תיאור או מספר תיקון. query ריק או 'פתוחים' מחזיר את כל התיקונים הפתוחים.",
    strict: true,
    input_schema: strict({ query: { type: "string" } }),
  },
  {
    name: "lab_summary",
    description: "סיכום כללי ממערכת המעבדה: תיקונים לפי סטטוס, לקוחות, הכנסות, יתרות פתוחות, חלקים נפוצים.",
    strict: true,
    input_schema: strict({}),
  },
];

export const OWNER_TOOLS = [
  {
    name: "remember",
    description:
      "שומר בזיכרון הקבוע פרט חשוב על הבעלים או העסק (סטטוס עוסק, מחזור, יעדים, החלטות, אנשי קשר, העדפות). אם הנושא כבר קיים, המידע מתעדכן.",
    strict: true,
    input_schema: strict({
      topic: { type: "string", description: "נושא קצר, למשל 'סטטוס העסק' או 'מחזור 2026'" },
      fact: { type: "string", description: "המידע לשמירה" },
    }),
  },
  {
    name: "forget",
    description: "מוחק נושא מהזיכרון הקבוע.",
    strict: true,
    input_schema: strict({ topic: { type: "string" } }),
  },
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
  ...LEDGER_TOOLS,
  CHECKLIST_TOOL,
  ...(lab.labEnabled ? LAB_TOOLS : [])
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

    case "remember":
      memory[input.topic] = input.fact;
      saveMemory();
      return "נשמר.";

    case "forget":
      if (!(input.topic in memory)) return "הנושא לא נמצא בזיכרון.";
      delete memory[input.topic];
      saveMemory();
      return "נמחק.";

    case "update_checklist":
      return updateItem(input);

    case "record_transaction": {
      if (!(input.amount > 0)) return "הסכום חייב להיות חיובי.";
      const id = Math.random().toString(36).slice(2, 7);
      ledger.push({ id, type: input.type, amount: input.amount, desc: input.desc, date: input.date });
      saveLedger();
      return `נרשם (${id}).`;
    }

    case "delete_transaction": {
      const i = ledger.findIndex((t) => t.id === input.id);
      if (i < 0) return "לא נמצא רישום כזה.";
      ledger.splice(i, 1);
      saveLedger();
      return "נמחק.";
    }

    case "ledger_summary": {
      const y = String(input.year);
      const rows = ledger.filter((t) => String(t.date).startsWith(y));
      const sum = (type) => rows.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0);
      const inc = sum("income");
      const exp = sum("expense");
      let labIncome = null;
      if (lab.labEnabled) labIncome = await lab.labIncomeForYear(input.year).catch(() => null);
      const recent = rows.slice(-10).map((t) => `${t.date} ${t.type === "income" ? "➕" : "➖"} ${t.amount} ₪ ${t.desc} (${t.id})`);
      return `שנת ${y}:
הכנסות שדווחו בווטסאפ: ${inc} ₪ | הוצאות שדווחו: ${exp} ₪ | רווח לפי היומן: ${inc - exp} ₪${
        labIncome !== null ? `\nתשלומים שנרשמו במערכת המעבדה: ${Math.round(labIncome)} ₪ (ייתכן שחלקם כבר דווחו גם בווטסאפ, אל תספור פעמיים)` : ""
      }
רישומים אחרונים:\n${recent.join("\n") || "אין"}`;
    }

    case "search_inventory":
      return lab.searchInventory(input.query);

    case "inventory_shortages":
      return lab.shortages();

    case "mark_ordered":
      return lab.markOrdered(input.item_id, input.qty, input.note);

    case "find_repairs":
      return lab.findRepairs(input.query);

    case "lab_summary":
      return lab.labSummary();

    case "propose_inventory_change": {
      const item = await lab.getItem(input.item_id).catch(() => null);
      if (!item) return "הפריט לא נמצא. חפש קודם עם search_inventory.";
      if (!Number.isInteger(input.delta) || input.delta === 0) return "שינוי לא תקין.";
      const after = item.qty + input.delta;
      if (after < 0) return `לא הגיוני: יש במלאי רק ${item.qty} יחידות של ${item.name}. שאל את הבעלים.`;
      if (Math.abs(input.delta) > 50) return "כמות חריגה מאוד. ודא עם הבעלים את המספר לפני שמציעים.";
      const existing = pendingChanges.findIndex((c) => c.id === item.id);
      if (existing >= 0) pendingChanges.splice(existing, 1);
      pendingChanges.push({ ts: Date.now(), id: item.id, name: item.name, delta: input.delta, before: item.qty, after, reason: input.reason });
      return `ההצעה נשמרה וממתינה לאישור: ${item.name} ${input.delta > 0 ? "+" : ""}${input.delta} (מ-${item.qty} ל-${after}). עכשיו שאל את הבעלים בשורה אחת אם לאשר. הוא עונה "כן" או "לא".`;
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
