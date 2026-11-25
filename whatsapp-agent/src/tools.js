// הכלים שהסוכן יכול להפעיל.
// ללקוחות יש רק כלי אחד (להעביר הודעה לבעלים) - כדי שאף לקוח לא יוכל
// "לשכנע" את הסוכן לשלוח הודעות בשמך. כל שאר הכלים זמינים רק לך.
import { chats, ledger, memory, reminders, saveLedger, saveMemory, saveReminders } from "./store.js";
import * as lab from "./lab.js";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import { renderAd, STYLES, SIZES } from "./creative.js";
import { makeVideo, recentOwnerMedia, VIDEO_SIZES, MUSIC, aiMinutes } from "./video.js";
import { generateClip, generateImage, getVideoKey, videoBudget, USD_PER_SECOND, USD_PER_IMAGE, VOICE_MENU } from "./omni.js";
import { cloudEnabled } from "./cloud.js";
import { CHECKLIST_TOOL, updateItem } from "./checklist.js";

// שינויי מלאי שממתינים לאישור הבעלים ("כן"). מבוצעים רק ב-index.js, לא על ידי המודל.
export const pendingChanges = [];
// רשימות שהקוד בונה מהמערכת ומצורפות לתשובה כמו שהן (כדי שהמודל לא ישכתב שמות ומספרים)
export const replyAppendix = [];
// תמונות שהיועצת עיצבה בתור הזה (מודעות). נשלחות לבעלים בווטסאפ אחרי התשובה
export const replyImages = [];
// שאלון בחירה שהיועצת הכינה: נשלח לבעלים שאלה אחרי שאלה עם כפתורים, ובסוף כל התשובות חוזרות אליה בהודעה אחת
export const quiz = { pending: null };
// שליחת מדיה לבעלים מחוץ לתשובה (סרטון שמוכן אחרי כמה דקות). index.js ממלא את זה
export const hooks = { sendMedia: null };
let videoBusy = false;
// תמונות רפרנס של המעבדה (מהסרטון של PowerAds שהבעלים שלח), בלי אנשים, כדי שהסרטונים יראו את המקום והלוגו
const REF_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "assets", "brand-refs");
const LAB_REFS = ["lab-logo-wall.jpg", "repair-bench-macro.jpg", "microscope-ringlight.jpg"];
// המראות האחרונים שהוצגו לבעלים (תמונה לכל מראה), כדי שהמראה שבחר יופיע בסרטון
let lastLooks = [];
// הדמות הקבועה שהבעלים אישר (נשמרת בדיסק ובזיכרון)
const LOOK_DIR = path.join(DATA_DIR, "characters");
function savedLook() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(LOOK_DIR, "current.json"), "utf8"));
    return fs.existsSync(meta.file) ? meta : null;
  } catch {
    return null;
  }
}
const LOOK_PROMPT = (desc) =>
  `Photorealistic vertical portrait photo, shot on a professional camera: ${desc}. The person stands inside the phone repair lab shown in the reference image, with the gold YakovPhone logo on the dark wall behind, warm gold lighting, natural relaxed pose, looking at the camera. Real skin texture, natural and authentic, not plastic. No text except the logo on the wall.`;
// מצב אמיתי של הסרטון שבעבודה, כדי שהיועצת תדווח מה באמת קורה ולא תנחש
const videoJob = { stage: "", at: 0, started: 0, cost: 0, error: "" };
const setStage = (stage, extra = {}) => Object.assign(videoJob, { stage, at: Date.now(), ...extra });

// ---------- בקרה על שינויים במערכת ----------
// כל שינוי נבדק מול המערכת אחרי הביצוע, נרשם ביומן, והבעלים מקבל את מה שבאמת נכנס (לא מה שהמודל אומר)
const FIELD_HE = { price: "מחיר", cost: "עלות", qty: "כמות", min: "מינימום", name: "שם", status: "סטטוס", total: "סה\"כ", labor: "עבודה", deposit: "מקדמה", notes: "הערות", supplier: "ספק", loc: "מיקום", sku: "מק\"ט", cat: "קטגוריה", qty_ordered: "כמות שהוזמנה", reorder_qty: "כמות להזמנה" };
const same = (a, b) => (a === b) || (a != null && b != null && (String(a).trim() === String(b).trim() || (a !== "" && b !== "" && !isNaN(a) && !isNaN(b) && Number(a) === Number(b))));
export function auditLog(entry) {
  try { fs.appendFileSync(path.join(DATA_DIR, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch {}
}
function changeReport(line) {
  // כל השינויים של אותה תשובה מתקבצים לבלוק אחד
  const i = replyAppendix.findIndex((x) => x.startsWith("🧾"));
  if (i >= 0) replyAppendix[i] += `\n${line}`;
  else replyAppendix.push(`🧾 מה נכנס למערכת (נבדק מול המערכת):\n${line}`);
}
async function verifiedAction(action, id, fields, summary) {
  const before = await lab.readRecord(action, id);
  let result;
  try {
    result = await lab.runAction(action, id, fields);
  } catch (e) {
    auditLog({ action, id, fields, summary, ok: false, error: e.message });
    changeReport(`❌ ${summary}: לא נכנס (${e.message})`);
    return { ok: false, error: e.message };
  }
  const newId = id || result?.id || result?.jobId;
  const after = await lab.readRecord(action, newId);
  const label = lab.recordLabel(after || before, newId);
  const diffs = [];
  const wrong = [];
  if (after) {
    for (const [k, v] of Object.entries(fields)) {
      if (k === "delta" || typeof v === "object") continue;
      if (!same(after[k], v)) wrong.push(`${FIELD_HE[k] || k}: ביקשתי ${v}, במערכת ${after[k] ?? "ריק"}`);
      else if (before && !same(before[k], after[k])) diffs.push(`${FIELD_HE[k] || k} ${before[k] ?? "ריק"} ← ${after[k]}`);
    }
  }
  const ok = wrong.length === 0;
  auditLog({ action, id: newId, fields, summary, ok, verified: Boolean(after), before: before && Object.fromEntries(Object.keys(fields).map((k) => [k, before[k]])), after: after && Object.fromEntries(Object.keys(fields).map((k) => [k, after[k]])) });
  if (!ok) changeReport(`⚠️ ${label}: ${wrong.join("; ")}`);
  else if (diffs.length) changeReport(`✅ ${label}: ${diffs.join(", ")}`);
  else if (!after) changeReport(`✅ ${summary} (בוצע, אין דרך לקרוא את הרשומה לבדיקה)`);
  else changeReport(`✅ ${label}: ${/^create/.test(action) ? "נוצר" : "בלי שינוי (כבר היה ככה)"}`);
  return { ok, wrong, verified: Boolean(after) };
}

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
    name: "show_inventory_list",
    description:
      "מצרף לתשובה רשימת פריטים אמיתית מהמערכת (שם מדויק, כמות, עלות, מחיר נוכחי), בנויה על ידי הקוד ולא על ידיך. חובה להשתמש בזה בכל פעם שמציגים לבעלים יותר מפריט אחד מהמלאי (\"כל המסכים\", \"מחירון\", \"מה יש לי\"). אפשר להוסיף מחיר מוצע לכל פריט לפי id. כשמבקשים מחירים מוצעים: קרא פעם אחת בלי מחירים כדי לקבל את ה-id, ואז שוב עם מחיר לכל id (הקריאה השנייה מחליפה את הראשונה). אחרי הקריאה אל תכתוב את הרשימה בעצמך.",
    strict: true,
    input_schema: strict({
      query: { type: "string", description: "מה לחפש, למשל 'מסך', 'סוללה', 'מסך jk', 'אינסל'" },
      suggested_prices_json: { type: "string", description: "מחיר מכירה מוצע לפי id, למשל {\"inv-123\":350}. {} אם אין" },
    }),
  },
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
      "משנה כמות במלאי מיד (delta שלילי = השתמשתי/מכרתי, חיובי = הגיעה הזמנה). קודם מצא את הפריט עם search_inventory כדי לקבל id. אחרי הביצוע כתוב בשורה אחת מה עשית.",
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
    name: "lab_read",
    description:
      "קורא כל דבר ממערכת המעבדה. resource אחד מ: " +
      Object.entries(lab.READ_RESOURCES).map(([k, v]) => `${k.replace("*", "")} (${v}${k.endsWith("*") ? ", צריך id" : ""})`).join("; ") +
      ". query מסנן לפי טקסט (שם לקוח, דגם, טלפון). קריאה לא משנה כלום, אפשר בלי לשאול.",
    strict: true,
    input_schema: strict({
      resource: { type: "string", enum: Object.keys(lab.READ_RESOURCES).map((k) => k.replace("*", "")) },
      id: { type: "string", description: "מזהה, או ריק" },
      query: { type: "string", description: "טקסט לסינון, או ריק" },
    }),
  },
  {
    name: "propose_lab_action",
    description:
      "מבצע פעולה במערכת המעבדה. יצירה ועדכון מתבצעים מיד, בלי לשאול. רק מחיקה (delete_*, remove_repair_part) ממתינה ל'כן' של הבעלים. פעולות: " +
      Object.entries(lab.ACTIONS).map(([k, v]) => `${k}: ${v.d}`).join("; ") +
      ". fields הוא JSON עם השדות לשינוי בלבד. בעדכון ומחיקה קרא קודם עם lab_read כדי לקבל id נכון. אחרי ביצוע, כתוב בשורה אחת מה נעשה.",
    strict: true,
    input_schema: strict({
      action: { type: "string", enum: Object.keys(lab.ACTIONS) },
      id: { type: "string", description: "מזהה הרשומה (תיקון/פריט/הזמנה/תשלום/עובד/משמרת), או ריק ביצירה" },
      fields_json: { type: "string", description: "אובייקט JSON עם השדות, למשל {\"status\":\"ready\"}. {} אם אין" },
      summary: { type: "string", description: "תיאור קצר בעברית של מה שיקרה, לבעלים" },
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

const CREATIVE_TOOLS = [
  {
    name: "make_ad_image",
    description:
      "מעצב תמונת מודעה לעסק (פוסט, סטורי או מודעה ממומנת) עם טקסט בעברית, ושולח אותה לבעלים בווטסאפ. את הטקסטים כותבת את: כותרת קצרה וחזקה (עד 8 מילים), משפט תועלת, מחיר או הצעה, וקריאה לפעולה. סגנונות: tech (כהה עם זוהר ירוק, כמו סוכני AI), brand (צבעי YakovPhone, כחול כהה וזהב), sale (מבצע אדום-צהוב בולט), clean (לבן ונקי). גדלים: square (פוסט פייסבוק/אינסטגרם), story (סטורי/סטטוס/טיקטוק), wide (מודעה ממומנת בפייסבוק). אפשר לקרוא כמה פעמים כדי לתת כמה גרסאות.",
    strict: true,
    input_schema: strict({
      headline: { type: "string", description: "כותרת ראשית, עד 8 מילים" },
      sub: { type: "string", description: "משפט תועלת אחד או שניים. ריק אם אין" },
      price: { type: "string", description: "מחיר או הצעה, למשל 'מ-199 ₪' או 'אבחון חינם'. ריק אם אין" },
      cta: { type: "string", description: "קריאה לפעולה קצרה, למשל 'שלחו הודעה בווטסאפ'" },
      badge: { type: "string", description: "תגית קטנה מעל הכותרת, למשל 'מבצע השבוע'. ריק אם אין" },
      phone: { type: "string", description: "טלפון להצגה במודעה. ריק אם הבעלים לא נתן" },
      style: { type: "string", enum: Object.keys(STYLES) },
      size: { type: "string", enum: Object.keys(SIZES) },
    }),
  },
];

const choiceOption = strict({
  title: { type: "string", description: "האפשרות, עד 24 תווים" },
  description: { type: "string", description: "הסבר קצר עד 70 תווים, או ריק" },
});
const VIDEO_TOOLS = [
  {
    name: "design_look",
    description: "עיצוב דמות לסרטונים לפי מה שהבעלים מתאר: יוצר תמונה אחת של הדמות במעבדה של YakovPhone ושולח לו. כשהוא מבקש שינוי ('שיער כהה יותר', 'חולצה שחורה'), קראי שוב עם edit_previous=true והשינוי בלבד: אותה דמות בדיוק, רק עם השינוי. כ-0.07 דולר לתמונה. כשהוא מאשר, קראי ל-save_look.",
    strict: true,
    input_schema: strict({
      prompt: { type: "string", description: "באנגלית. בפעם הראשונה: תיאור מלא של הדמות (גיל, פנים, שיער, צבע עיניים, לבוש, תכשיטים, הבעה, מראה ישראלי טבעי). בעריכה: רק מה לשנות" },
      edit_previous: { type: "boolean", description: "true כדי לשנות את התמונה האחרונה ששלחת (אותה דמות), false לדמות חדשה" },
    }),
  },
  {
    name: "save_look",
    description: "שומר את הדמות האחרונה ששלחת (מ-design_look או preview_looks) כדמות הקבועה לסרטונים, אחרי שהבעלים אישר אותה.",
    strict: true,
    input_schema: strict({
      look_number: { type: "integer", description: "1 לדמות מ-design_look. ב-preview_looks: מספר המראה שבחר" },
      name: { type: "string", description: "שם קצר לדמות, למשל 'הדוגמנית שלנו'" },
    }),
  },
  {
    name: "preview_looks",
    description: "יוצר ושולח לבעלים בווטסאפ תמונות ממוספרות של מראות אפשריים לדמות בסרטון (במעבדה של YakovPhone), כדי שיבחר מראה לפי מספר לפני שמשלמים על סרטון. כ-0.07 דולר לתמונה. 4-6 מראות שונים.",
    strict: true,
    input_schema: strict({
      looks: {
        type: "array",
        description: "4-6 מראות שונים זה מזה",
        items: strict({
          title: { type: "string", description: "תיאור קצר בעברית, למשל 'צעירה, שיער בהיר ארוך'" },
          prompt: { type: "string", description: "תיאור מפורט באנגלית של האדם: גיל, שיער, פנים, לבוש, מראה ישראלי ים תיכוני טבעי" },
        }),
      },
    }),
  },
  {
    name: "preview_voices",
    description: `שולח לבעלים בווטסאפ תפריט קולות: לכל קול הודעה עם מספר ותיאור ואחריה הודעה קולית לדוגמה עם המשפט שאת כותבת. הקולות: ${VOICE_MENU.map((v, i) => `${i + 1}=${v.id} (${v.label})`).join(", ")}, ${VOICE_MENU.length + 1}=הילה (Microsoft, אישה), ${VOICE_MENU.length + 2}=אברי (Microsoft, גבר). כמעט בחינם.`,
    strict: true,
    input_schema: strict({
      text: { type: "string", description: "משפט הדגמה קצר בעברית, מתוך התסריט. שם העסק: יעקב פון" },
      gender: { type: "string", enum: ["all", "female", "male"], description: "אילו קולות לשלוח: כולם, רק נשים או רק גברים (לפי הדמות שנבחרה)" },
    }),
  },
  {
    name: "video_status",
    description: "בודק באיזה שלב באמת נמצא הסרטון שבעבודה (אצל גוגל, בעריכה, נשלח, נכשל). חובה להשתמש בזה לפני שעונים לבעלים על שאלה כמו 'מה עם הסרטון' או 'לא קיבלתי'. אסור לכתוב שסרטון נשלח בלי שהכלי הזה אמר שהוא נשלח.",
    strict: true,
    input_schema: strict({}),
  },
  {
    name: "ask_choices",
    description:
      "שולח לבעלים בווטסאפ שאלון בחירה: שאלה אחרי שאלה, כל אחת עם כפתורים או רשימה לבחירה (עד 10 אפשרויות). כשהוא מסיים, כל התשובות חוזרות אלייך בהודעה אחת. השתמשי בזה לפני סרטון (קונספט, סגנון, מי מופיע, קול, מוזיקה, פורמט, אורך) או בכל מקום שבו בחירה מהירה עדיפה על הקלדה. הבעלים יכול גם להקליד תשובה משלו.",
    strict: true,
    input_schema: strict({
      intro: { type: "string", description: "משפט פתיחה קצר לפני השאלה הראשונה" },
      questions: {
        type: "array",
        description: "1 עד 7 שאלות, לפי הסדר",
        items: strict({
          question: { type: "string", description: "השאלה, קצרה" },
          options: { type: "array", description: "2 עד 10 אפשרויות", items: choiceOption },
        }),
      },
    }),
  },
  {
    name: "make_video",
    description:
      "יוצר סרטון שיווקי (MP4) ושולח אותו לבעלים בווטסאפ. כל סצנה היא מסך עם כותרת שנכנסת באנימציה, משפט, מחיר וכפתור, עם קריינות בעברית, מוזיקת רקע ומעברים. רקע: omni (הכי איכותי: וידאו AI אמיתי של גוגל בתשלום, אנשים שזזים, מצלמה וסאונד, כ-1 דולר לסרטון של 15 שניות. נוצר לפי video_prompt, ועליו הכתוביות בעברית וכרטיס הסיום עם הלוגו), ai (סרטון קולנועי כמו של סוכנויות AI: לכל סצנה תמונה ריאליסטית שנוצרת לפי image_prompt, למשל דוגמנית עם טלפון שבור, טכנאי במעבדה, צילום מקרו של תיקון; כתוביות למטה עם שורה בזהב, וכרטיס סיום עם הלוגו של YakovPhone וכפתור), photo (קולנועי עם התמונות האחרונות שהבעלים שלח), clip (קולנועי על הסרטון האחרון שהבעלים צילם), graphic (אנימציה גרפית בלי צילומים). קריינות: female (הילה), male (אברי), none. מוזיקה: calm, energetic, none. גדלים: story (סטורי/ריל/טיקטוק/סטטוס), square (פוסט), wide (יוטיוב/פייסבוק). 3 עד 6 סצנות, כל אחת 2-5 שניות.",
    strict: true,
    input_schema: strict({
      scenes: {
        type: "array",
        description: "הסצנות לפי הסדר. הראשונה: וו שעוצר גלילה. האחרונה: קריאה לפעולה (cta)",
        items: strict({
          headline: { type: "string", description: "כותרת הסצנה, עד 6 מילים" },
          sub: { type: "string", description: "משפט קצר, או ריק" },
          price: { type: "string", description: "מחיר או הצעה, או ריק" },
          cta: { type: "string", description: "כפתור קריאה לפעולה, בדרך כלל רק בסצנה האחרונה, אחרת ריק" },
          badge: { type: "string", description: "תגית קטנה, או ריק" },
          voice_text: { type: "string", description: "מה הקריינית אומרת בסצנה (משפט אחד או שניים, טבעי). ריק = קוראת את הכותרת והמשפט" },
          image_prompt: { type: "string", description: "רק ברקע ai: תיאור התמונה באנגלית, מפורט (מי, מה עושה, איפה, תאורה). אם יש דמות, חזרי על אותו תיאור דמות בכל הסצנות (למשל 'young woman with long wavy blonde hair, white shirt'). בלי טקסט בתמונה. אחרת ריק" },
          seconds: { type: "number", description: "משך מינימלי בשניות (2-5). הקריינות מאריכה לפי הצורך" },
        }),
      },
      style: { type: "string", enum: Object.keys(STYLES) },
      size: { type: "string", enum: Object.keys(VIDEO_SIZES) },
      voice: { type: "string", description: `הקריין: "g:<שם>" לקול של גוגל (${VOICE_MENU.map((v) => v.id).join(", ")}), "female" (הילה), "male" (אברי), "native" (רק הסאונד המקורי של וידאו ה-AI), "none"` },
      music: { type: "string", enum: MUSIC },
      background: { type: "string", enum: ["omni", "ai", "photo", "clip", "graphic"] },
      phone: { type: "string", description: "טלפון לסצנה האחרונה, רק אם הבעלים נתן. אחרת ריק" },
      video_prompt: { type: "string", description: "רק ברקע omni: תיאור מפורט באנגלית של כל הקליפ (15 שניות) לפי זמנים, למשל '[0-5s] ... [5-10s] ... [10-15s] ...'. מי הדמות (מראה מדויק), מה קורה, מצלמה, תאורה, ומה נשמע (מוזיקה, אווירה, בלי דיבור או דיבור בעברית). התזמון תואם לסצנות (חוץ מכרטיס הסיום). אחרת ריק" },
      use_my_photos: { type: "boolean", description: "רק ברקע omni: להשתמש בתמונות האחרונות שהבעלים שלח (למשל המעבדה שלו) כרפרנס, כדי שהסרטון יראה את המקום האמיתי" },
      look_number: { type: "integer", description: "רק ברקע omni: מספר המראה שהבעלים בחר מ-preview_looks (1-6), או 1 לדמות מ-design_look שעוד לא נשמרה. 0 = הדמות השמורה (save_look) אם יש, אחרת בלי רפרנס" },
      use_lab_refs: { type: "boolean", description: "רק ברקע omni: להשתמש בתמונות הרפרנס של המעבדה של YakovPhone (קיר עם הלוגו בזהב, שולחן עבודה עם מנורת טבעת ומיקרוסקופ, תאורה חמה). כמעט תמיד true, חוץ מסרטון שכולו ברחוב או בבית" },
      caption: { type: "string", description: "טקסט קצר שיצורף לסרטון בווטסאפ" },
    }),
  },
];

export const OWNER_TOOLS = [
  ...CREATIVE_TOOLS,
  ...VIDEO_TOOLS,
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

    case "make_ad_image": {
      if (!String(input.headline || "").trim()) return "חסרה כותרת למודעה.";
      if (replyImages.length >= 4) return "כבר עוצבו 4 תמונות בתשובה הזו. אם צריך עוד, הבעלים יבקש.";
      const png = renderAd(input);
      const dir = path.join(DATA_DIR, "creatives");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `ad-${Date.now()}-${input.style}-${input.size}.png`);
      fs.writeFileSync(file, png);
      replyImages.push({ png, caption: `${input.headline}${input.price ? ` | ${input.price}` : ""}` });
      return `התמונה עוצבה (${input.style}, ${input.size}) ותישלח לבעלים בווטסאפ מיד אחרי התשובה שלך. אל תתאר אותה באריכות, רק שורה אחת על הרעיון, ואם יש, את טקסט הפוסט שילווה אותה.`;
    }

    case "ask_choices": {
      if (!cloudEnabled()) return "אין חיבור לווטסאפ הרשמי, אז אי אפשר לשלוח כפתורים. כתבי את השאלות בתשובה כרשימה ממוספרת עם אפשרויות ממוספרות, והבעלים יענה במספרים.";
      if (quiz.pending?.fresh) return "השאלון כבר מוכן ויישלח מיד אחרי התשובה.";
      const questions = (input.questions || [])
        .slice(0, 7)
        .map((q) => ({
          question: String(q.question || "").trim(),
          options: (q.options || []).slice(0, 10).map((o) => (typeof o === "string" ? { title: o, description: "" } : { title: String(o.title || "").trim(), description: String(o.description || "").trim() })).filter((o) => o.title),
        }))
        .filter((q) => q.question && q.options.length >= 2);
      if (!questions.length) return "לא נמצאו שאלות תקינות (צריך שאלה ולפחות 2 אפשרויות).";
      quiz.pending = { intro: String(input.intro || ""), questions, answers: [], step: 0, at: Date.now(), fresh: true, sent: false };
      return `השאלון (${questions.length} שאלות) יישלח לבעלים בווטסאפ עם כפתורים מיד אחרי התשובה שלך. בתשובה עצמה כתבי רק משפט קצר, בלי לחזור על השאלות. כשהוא יסיים תקבלי את כל התשובות בהודעה אחת, ואז תמשיכי (למשל make_video).`;
    }

    case "design_look": {
      if (!getVideoKey()) return "אין מפתח של גוגל בתשלום, אז אי אפשר ליצור תמונות.";
      if (!hooks.sendMedia) return "אין חיבור לווטסאפ הרשמי.";
      const b = videoBudget();
      if (USD_PER_IMAGE > b.left) return `לא נשאר תקציב לתמונות (${b.spent} מתוך ${b.budget} דולר).`;
      const prev = input.edit_previous ? lastLooks[0] || savedLook() : null;
      const labRef = path.join(REF_DIR, "lab-logo-wall.jpg");
      const refs = [];
      if (prev?.file && fs.existsSync(prev.file)) refs.push({ mime: prev.mime, data: fs.readFileSync(prev.file).toString("base64") });
      if (fs.existsSync(labRef)) refs.push({ mime: "image/jpeg", data: fs.readFileSync(labRef).toString("base64") });
      const fullPrompt = prev
        ? `Edit the first reference image: keep exactly the same person (same face, identity and proportions), the same lab background and the same photo style, and change only this: ${input.prompt}. Photorealistic, natural.`
        : LOOK_PROMPT(input.prompt);
      const img = await generateImage(fullPrompt, { refs });
      const dir = path.join(DATA_DIR, "creatives");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `design-${Date.now()}.${img.mime.includes("png") ? "png" : "jpg"}`);
      fs.writeFileSync(file, img.buf);
      const desc = prev ? `${prev.prompt}; changed: ${input.prompt}` : input.prompt;
      lastLooks = [{ title: "הדמות שעיצבת", prompt: desc, file, mime: img.mime }];
      await hooks.sendMedia({ kind: "image", buf: img.buf, mime: img.mime, caption: prev ? "✏️ אחרי השינוי" : "👤 הדמות" });
      const nb = videoBudget();
      return `התמונה נשלחה לבעלים (כ-${USD_PER_IMAGE} דולר, החודש ${nb.spent} מתוך ${nb.budget}). שאלי בקצרה: לשנות משהו (שיער, פנים, לבוש, גיל, הבעה) או לשמור את הדמות? שינוי = design_look עם edit_previous=true. אישור = save_look עם look_number=1.`;
    }

    case "save_look": {
      const l = lastLooks[(input.look_number || 1) - 1];
      if (!l?.file || !fs.existsSync(l.file)) return "אין תמונת דמות לשמור. צרי קודם עם design_look או preview_looks.";
      fs.mkdirSync(LOOK_DIR, { recursive: true });
      const file = path.join(LOOK_DIR, `${Date.now()}${path.extname(l.file)}`);
      fs.copyFileSync(l.file, file);
      const meta = { title: input.name || l.title, prompt: l.prompt, file, mime: l.mime };
      fs.writeFileSync(path.join(LOOK_DIR, "current.json"), JSON.stringify(meta));
      memory["דמות לסרטונים"] = `${meta.title}: ${meta.prompt}. נשמרה תמונה, ובסרטון היא תופיע אוטומטית (look_number=0)`;
      saveMemory();
      return `הדמות "${meta.title}" נשמרה והיא הדמות הקבועה לסרטונים. בסרטונים הבאים אל תשאלי על דמות או מראה, אלא אם הבעלים ביקש דמות אחרת.`;
    }

    case "preview_looks": {
      if (!getVideoKey()) return "אין מפתח של גוגל בתשלום, אז אי אפשר ליצור תמונות. תארי את המראות במילים בשאלון.";
      if (!hooks.sendMedia) return "אין חיבור לווטסאפ הרשמי.";
      const looks = (input.looks || []).slice(0, 6);
      if (looks.length < 2) return "צריך לפחות 2 מראות.";
      const b = videoBudget();
      if (looks.length * USD_PER_IMAGE > b.left) return `לא נשאר מספיק תקציב לתמונות (${b.spent} מתוך ${b.budget} דולר).`;
      const refPath = path.join(REF_DIR, "lab-logo-wall.jpg");
      const refs = fs.existsSync(refPath) ? [{ mime: "image/jpeg", data: fs.readFileSync(refPath).toString("base64") }] : [];
      const dir = path.join(DATA_DIR, "creatives");
      fs.mkdirSync(dir, { recursive: true });
      const results = await Promise.all(
        looks.map(async (l, i) => {
          try {
            const img = await generateImage(
              `Photorealistic vertical portrait photo, shot on a professional camera: ${l.prompt}. The person stands inside the phone repair lab shown in the reference image, with the gold YakovPhone logo on the dark wall behind, warm gold lighting, natural relaxed pose, slight smile, looking at the camera. Real skin texture, natural and authentic, not plastic. No text except the logo on the wall.`,
              { refs }
            );
            const file = path.join(dir, `look-${Date.now()}-${i + 1}.${img.mime.includes("png") ? "png" : "jpg"}`);
            fs.writeFileSync(file, img.buf);
            return { ...l, file, mime: img.mime, buf: img.buf };
          } catch (e) {
            return { ...l, error: e.message };
          }
        })
      );
      lastLooks = results.map((r) => ({ title: r.title, prompt: r.prompt, file: r.file || "", mime: r.mime || "" }));
      let sent = 0;
      for (const [i, r] of results.entries()) {
        if (!r.buf) continue;
        await hooks.sendMedia({ kind: "image", buf: r.buf, mime: r.mime, caption: `${i + 1}. ${r.title}` }).then(() => sent++).catch(() => {});
      }
      const failed = results.filter((r) => r.error);
      const nb = videoBudget();
      return `נשלחו לבעלים ${sent} תמונות ממוספרות${failed.length ? ` (${failed.length} לא נוצרו: ${failed[0].error})` : ""}. עלות: כ-${(results.length * USD_PER_IMAGE).toFixed(2)} דולר, החודש ${nb.spent} מתוך ${nb.budget}. המראות: ${results.map((r, i) => `${i + 1}=${r.title}`).join(", ")}. עכשיו שאלי אותו איזה מספר (ask_choices עם האפשרויות "1. ..." עד "${results.length}. ..."), ובסרטון העבירי look_number.`;
    }

    case "preview_voices": {
      if (!hooks.sendVoiceMenu) return "אין חיבור לווטסאפ הרשמי.";
      // הודעה אחת בווטסאפ עם תפריט: לחיצה על קול שולחת את ההקלטה שלו, ו"זה הקול" שומר אותו
      await hooks.sendVoiceMenu();
      return `נשלחה לבעלים הודעה אחת עם תפריט קולות בתוך ווטסאפ (${VOICE_MENU.length + 2} קולות). כשהוא לוחץ "בחר", הקול נשמר בזיכרון בנושא "קול מועדף לסרטונים" עם ערך voice מוכן. אם הוא כותב מספר במקום, המספרים: ${VOICE_MENU.map((v, i) => `${i + 1}="g:${v.id}"`).join(", ")}, ${VOICE_MENU.length + 1}="female" (הילה), ${VOICE_MENU.length + 2}="male" (אברי). יש גם "native": הדמות מדברת בעצמה בסרטון.`;
    }

    case "video_status": {
      if (!videoJob.stage) return "אין סרטון בעבודה כרגע, ולא נוצר סרטון מאז ההפעלה האחרונה של היועצת.";
      const ago = (t) => `לפני ${Math.max(0, Math.round((Date.now() - t) / 60000))} דקות`;
      return `מצב הסרטון: ${videoJob.stage} (עודכן ${ago(videoJob.at)}, התחיל ${ago(videoJob.started)})${videoJob.error ? `. הסיבה: ${videoJob.error}` : ""}. דווחי לבעלים בדיוק את זה, בלי להוסיף.`;
    }

    case "make_video": {
      if (replyImages.some((x) => x.kind === "video")) return "סרטון כבר נוצר בתשובה הזו ויישלח לבעלים.";
      let photos = [];
      let clip = "";
      if (input.background === "photo") {
        photos = recentOwnerMedia("photo");
        if (!photos.length) return "אין תמונות מהבעלים מ-48 השעות האחרונות. בקשי ממנו לשלוח 1-6 תמונות (של המעבדה, של מכשירים או שלו), ואז תיצרי את הסרטון. או הציעי רקע גרפי.";
      }
      if (input.background === "clip") {
        clip = recentOwnerMedia("clip", 1)[0] || "";
        if (!clip) return "אין סרטון מהבעלים מ-48 השעות האחרונות. בקשי ממנו לצלם ולשלוח סרטון קצר (5-30 שניות), למשל הוא במעבדה מתקן מכשיר, ואז תיצרי את הסרטון. או הציעי רקע גרפי.";
      }
      const t0 = Date.now();
      if (input.background === "omni") {
        if (!getVideoKey()) return "אין עדיין מפתח לווידאו AI בתשלום. אמרי לבעלים שצריך להדביק את המפתח בעמוד ההגדרות, בכרטיס 🎬 וידאו AI (יש שם הוראות). בינתיים הציעי סרטון מהצילומים שלו.";
        if (videoBusy) return "כבר נוצר סרטון ברגעים אלה. אמרי לבעלים שיחכה לו.";
        if (!hooks.sendMedia) return "אין חיבור לווטסאפ הרשמי, אז אי אפשר לשלוח סרטון.";
        if (!String(input.video_prompt || "").trim()) return "חסר video_prompt: תיאור הקליפ באנגלית לפי זמנים.";
        const b = videoBudget();
        const cost = 15 * USD_PER_SECOND;
        if (cost > b.left) return `התקציב החודשי לסרטוני AI נגמר (${b.spent} מתוך ${b.budget} דולר, ${b.videos} סרטונים). אמרי לבעלים שאפשר להגדיל אותו בעמוד ההגדרות.`;
        videoBusy = true;
        setStage("נשלח לגוגל ליצירת הווידאו (לוקח 1-4 דקות)", { started: Date.now(), cost, error: "" });
        const scenes = input.scenes || [];
        const body = scenes.filter((x, i) => !(i === scenes.length - 1 && x.cta));
        const per = body.length ? 15 / body.length : 5;
        const timed = scenes.map((x, i) => (body.includes(x) ? { ...x, seconds: Math.max(Number(x.seconds) || 0, per) } : x));
        (async () => {
          try {
            const images = input.use_my_photos ? recentOwnerMedia("photo", 3).map((p) => ({ mime: /\.png$/.test(p) ? "image/png" : "image/jpeg", data: fs.readFileSync(p).toString("base64") })) : [];
            let refNote = "";
            const look = input.look_number > 0 ? lastLooks[input.look_number - 1] : savedLook();
            if (look && fs.existsSync(look.file)) {
              images.unshift({ mime: look.mime, data: fs.readFileSync(look.file).toString("base64") });
              refNote += `\nThe main character must look exactly like the person in the first reference image (${look.prompt}).`;
            }
            if (input.use_lab_refs !== false) {
              for (const f of LAB_REFS) {
                const p = path.join(REF_DIR, f);
                if (images.length < 6 && fs.existsSync(p)) images.push({ mime: "image/jpeg", data: fs.readFileSync(p).toString("base64") });
              }
              refNote += "\nThe other reference images show the real YakovPhone repair lab: a dark modern interior, the gold YakovPhone phone-and-lightning logo on the wall, a work bench with a ring light and a microscope, warm gold lighting. Every lab shot must take place in exactly this lab, with this logo and this look.";
            }
            const prompt = `${input.video_prompt}${refNote}\nNobody says the business name out loud.\nPhotorealistic, natural real people and real places, shot on a professional cinema camera, smooth camera movement. Do not show any on-screen text, subtitles, captions or logos.`;
            const clipBuf = await generateClip({ prompt, aspect: input.size === "wide" ? "16:9" : "9:16", seconds: 15, images });
            const dir = path.join(DATA_DIR, "creatives");
            fs.mkdirSync(dir, { recursive: true });
            const clipFile = path.join(dir, `omni-${Date.now()}.mp4`);
            fs.writeFileSync(clipFile, clipBuf);
            setStage("הווידאו התקבל מגוגל. עכשיו מוסיפה כתוביות, קריינות וכרטיס סיום (כדקה)");
            const voice = input.voice === "native" ? "none" : input.voice;
            const { mp4, seconds } = await makeVideo({ ...input, scenes: timed, voice, background: "clip", clip: clipFile, clipAudio: true, music: input.voice === "native" ? "none" : input.music });
            if (mp4.length > 15.5 * 1024 * 1024) throw new Error("הסרטון יצא גדול מדי לווטסאפ");
            fs.writeFileSync(path.join(dir, `video-${Date.now()}-omni-${input.size}.mp4`), mp4);
            const nb = videoBudget();
            setStage("שולחת את הסרטון לווטסאפ");
            await hooks.sendMedia({ kind: "video", buf: mp4, caption: `${input.caption || "🎬 הסרטון מוכן"}\n(עלות: כ-${cost.toFixed(2)} דולר. החודש: ${nb.spent} מתוך ${nb.budget} דולר)` });
            setStage("✅ הסרטון נשלח לבעלים בווטסאפ");
            console.log(`🎬 סרטון Omni נוצר ונשלח: ${seconds} שניות, ${Math.round((Date.now() - t0) / 1000)} שניות עבודה`);
          } catch (e) {
            console.log(`⚠️ סרטון Omni נכשל: ${e.message}`);
            setStage("❌ נכשל", { error: e.message });
            await ctx.notifyOwner?.(`⚠️ לא הצלחתי לסיים את הסרטון: ${e.message}`).catch(() => {});
          } finally {
            videoBusy = false;
          }
        })();
        return `הבקשה נשלחה לגוגל. הסרטון עוד לא קיים ועוד לא נשלח: אמרי לבעלים "התחלתי ליצור" ולא "שלחתי". כדי לדעת מה המצב בהמשך, השתמשי ב-video_status. התחלתי ליצור סרטון AI אמיתי אצל גוגל (עלות כ-${cost.toFixed(2)} דולר, נשארו ${(b.left - cost).toFixed(2)} דולר בתקציב החודש). זה לוקח בערך 2-5 דקות, והסרטון יגיע לבעלים בווטסאפ. אמרי לו את זה במשפט אחד, ותני כבר עכשיו את הטקסט לפוסט עם 5 האשטגים.`;
      }
      if (input.background === "ai") {
        // תמונות AI בחינם לוקחות כמה דקות: הסרטון נוצר ברקע ונשלח לבעלים כשהוא מוכן
        if (videoBusy) return "כבר נוצר סרטון ברגעים אלה. אמרי לבעלים שיחכה לו, ושאחריו אפשר להכין עוד אחד.";
        if (!hooks.sendMedia) return "אין חיבור לווטסאפ הרשמי, אז אי אפשר לשלוח סרטון. הציעי רקע graphic.";
        videoBusy = true;
        const mins = aiMinutes(input.scenes || []) + 1;
        (async () => {
          try {
            const { mp4, seconds } = await makeVideo({ ...input, photos, clip });
            if (mp4.length > 15.5 * 1024 * 1024) throw new Error("הסרטון יצא גדול מדי לווטסאפ");
            const dir = path.join(DATA_DIR, "creatives");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `video-${Date.now()}-ai-${input.size}.mp4`), mp4);
            await hooks.sendMedia({ kind: "video", buf: mp4, caption: input.caption || "🎬 הסרטון מוכן" });
            console.log(`🎬 סרטון AI נוצר ונשלח: ${seconds} שניות, ${Math.round((Date.now() - t0) / 1000)} שניות עבודה`);
          } catch (e) {
            console.log(`⚠️ סרטון AI נכשל: ${e.message}`);
            await ctx.notifyOwner?.(`⚠️ לא הצלחתי לסיים את הסרטון (${e.message}). אפשר לבקש שוב, או סרטון עם רקע גרפי שיוצא מיד.`).catch(() => {});
          } finally {
            videoBusy = false;
          }
        })();
        return `התחלתי ליצור את הסרטון. התמונות הריאליסטיות נוצרות בשירות חינמי שמרשה תמונה אחת כל 45 שניות, אז הסרטון יגיע לבעלים בווטסאפ בעוד כ-${mins} דקות. אמרי לו את זה במשפט אחד, ותני כבר עכשיו את הטקסט לפוסט עם 5 האשטגים.`;
      }
      const { mp4, seconds } = await makeVideo({ ...input, photos, clip });
      if (mp4.length > 15.5 * 1024 * 1024) return "הסרטון יצא גדול מדי לווטסאפ. נסי פחות סצנות או גודל square.";
      const dir = path.join(DATA_DIR, "creatives");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `video-${Date.now()}-${input.style}-${input.size}.mp4`), mp4);
      replyImages.push({ kind: "video", buf: mp4, caption: input.caption || input.scenes?.[0]?.headline || "" });
      console.log(`🎬 סרטון נוצר: ${seconds} שניות, ${input.style}/${input.size}/${input.voice}/${input.music}/${input.background}, ${Math.round((Date.now() - t0) / 1000)} שניות רינדור`);
      return `הסרטון נוצר (${seconds} שניות) ויישלח לבעלים בווטסאפ מיד אחרי התשובה שלך. בתשובה: שורה אחת על הסרטון, טקסט לפוסט עם 5 האשטגים, ושאלה אם לשנות משהו (קול, מוזיקה, סגנון, טקסט).`;
    }

    case "show_inventory_list": {
      const items = await lab.findItems(input.query);
      if (!items.length) return `לא נמצאו פריטים שמתאימים ל"${input.query}". אמור לבעלים שלא נמצא.`;
      let prices = {};
      try { prices = JSON.parse(input.suggested_prices_json || "{}") || {}; } catch {}
      const r = (n) => `${Math.round(Number(n) || 0)} ₪`;
      const lines = items.map((i, n) => {
        const sug = prices[i.id];
        const warn = Number(i.price) > 0 && Number(i.price) < Number(i.cost) ? " ⚠️ מחיר מתחת לעלות" : "";
        return `${n + 1}. ${i.name} | כמות: ${i.qty} | עלות: ${r(i.cost)} | מחיר עכשיו: ${r(i.price)}${sug ? ` | מוצע: ${r(sug)}` : ""}${warn}`;
      });
      // קריאה חוזרת (למשל קודם בלי מחירים ואז עם מחירים) מחליפה את הרשימה הקודמת ולא מוסיפה עוד אחת
      for (let i = replyAppendix.length - 1; i >= 0; i--) if (replyAppendix[i].startsWith("📋")) replyAppendix.splice(i, 1);
      replyAppendix.push(`📋 מהמערכת (${items.length} פריטים):\n${lines.join("\n")}`);
      const priced = Object.keys(prices).filter((id) => items.some((i) => i.id === id)).length;
      const unknown = Object.keys(prices).filter((id) => !items.some((i) => i.id === id));
      return `הרשימה (${items.length} פריטים, ${priced} עם מחיר מוצע) תצורף לתשובה שלך אוטומטית, בדיוק כמו במערכת. אל תכתוב אותה ואל תמנה פריטים בעצמך. כתוב רק משפט אחד או שניים.${priced === 0 ? " אם הבעלים ביקש מחירים מוצעים, קרא לכלי שוב עכשיו עם suggested_prices_json לכל id מהרשימה למטה, ואל תטען שהצעת מחירים לפני שעשית את זה." : ""}${unknown.length ? ` שים לב: המזהים ${unknown.join(", ")} לא נמצאו ברשימה ולא הוצגו.` : ""}\nלשימושך (לא להעתיק): ${items.map((i) => `${i.id}=${i.name}`).join("; ")}`;
    }

    case "search_inventory":
      return lab.searchInventory(input.query);

    case "inventory_shortages":
      return lab.shortages();

    case "mark_ordered":
      return lab.markOrdered(input.item_id, input.qty, input.note);

    case "lab_read":
      return lab.labRead(input.resource, input.id, input.query);

    case "propose_lab_action": {
      if (!lab.ACTIONS[input.action]) return "פעולה לא מוכרת.";
      if (lab.NEEDS_ID(input.action) && !input.id) return "חסר id. קרא קודם עם lab_read.";
      let fields;
      try {
        fields = JSON.parse(input.fields_json || "{}");
        if (typeof fields !== "object" || Array.isArray(fields) || fields === null) throw 0;
      } catch {
        return "fields_json לא תקין. צריך אובייקט JSON.";
      }
      // מחיקה לא הפיכה, אז רק היא מחכה לאישור. כל השאר מתבצע מיד
      if (lab.NEEDS_CONFIRM(input.action)) {
        pendingChanges.push({ ts: Date.now(), kind: "action", action: input.action, id: input.id, fields, summary: input.summary });
        return `זו מחיקה, אז היא ממתינה לאישור: ${input.summary}. שאל את הבעלים בשורה אחת אם למחוק ("כן" / "לא").`;
      }
      const v = await verifiedAction(input.action, input.id, fields, input.summary);
      if (v.error) return `לא הצלחתי: ${v.error}. ספר לבעלים בשורה אחת.`;
      if (!v.ok) return `בוצע, אבל הבדיקה מול המערכת מצאה הבדל: ${v.wrong.join("; ")}. ספר לבעלים בדיוק את זה ואל תגיד שהכל תקין.`;
      return `בוצע ונבדק מול המערכת: ${input.summary}. דוח מה נכנס בפועל מצורף אוטומטית לתשובה, אל תפרט אותו שוב. כתוב לבעלים שורה אחת לכל היותר.`;
    }

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
      const r = await lab.adjustInventory(item.id, input.delta, input.reason);
      const check = await lab.getItem(item.id).catch(() => null);
      const ok = !check || Number(check.qty) === after;
      auditLog({ action: "adjust_inventory", id: item.id, fields: { delta: input.delta }, summary: input.reason, ok, before: { qty: item.qty }, after: { qty: check?.qty ?? r?.qty } });
      changeReport(ok ? `✅ ${item.name}: כמות ${item.qty} ← ${check?.qty ?? r?.qty ?? after}` : `⚠️ ${item.name}: ציפיתי לכמות ${after}, במערכת ${check.qty}`);
      return `בוצע: ${item.name} ${input.delta > 0 ? "+" : ""}${input.delta}, עכשיו במלאי ${r?.qty ?? after}. כתוב לבעלים בשורה אחת שזה בוצע.`;
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
