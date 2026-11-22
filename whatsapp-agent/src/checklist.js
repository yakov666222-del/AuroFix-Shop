// רשימת הפתיחה של המעבדה: מה צריך לסגור לפני ובזמן הפתיחה.
// היועץ בונה כל סעיף יחד עם הבעלים, שומר את התוצאה, ומציק עד שהכל סגור.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const FILE = path.join(DATA_DIR, "checklist.json");

const DEFAULTS = [
  { id: "status", title: "סטטוס העסק ופתיחת תיק (עוסק זעיר/פטור/מורשה, מס הכנסה, מע\"מ, ביטוח לאומי)" },
  { id: "budget", title: "תקציב פתיחה: כל העלויות (פתיחת תיק, רו\"ח, ביטוח, ציוד, מלאי ראשוני, תוכנות, שיווק) - חד פעמי וחודשי" },
  { id: "hours", title: "שעות פתיחה" },
  { id: "address", title: "כתובת המעבדה (או איסוף/שירות עד הבית)" },
  { id: "phone", title: "טלפון/ווטסאפ עסקי ללקוחות" },
  { id: "prices", title: "מחירון תיקונים (מסכים, סוללות, שקעים, גב, נזקי מים) על בסיס סקר שוק ועלויות" },
  { id: "warranty", title: "מדיניות אחריות (כמה זמן, על מה, מה לא מכוסה) בניסוח כתוב" },
  { id: "bank", title: "חשבון בנק נפרד לעסק" },
  { id: "receipts", title: "הפקת קבלות/חשבוניות (תוכנה או אפליקציה)" },
  { id: "insurance", title: "ביטוח לעסק (צד ג', מכשירי לקוחות)" },
  { id: "license", title: "בדיקה אם צריך רישיון עסק / היתר" },
  { id: "google", title: "נוכחות אונליין: פרופיל עסק בגוגל ובמפות" },
  { id: "stock_min", title: "כמות מינימום במלאי לפריטים הנפוצים" },
];

export const checklist = (() => {
  let saved = [];
  try {
    saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {}
  const byId = Object.fromEntries(saved.map((x) => [x.id, x]));
  return DEFAULTS.map((d) => ({ status: "open", value: "", ...d, ...(byId[d.id] || {}), title: d.title }));
})();

const save = () => fs.writeFileSync(FILE, JSON.stringify(checklist, null, 2));
export const openItems = () => checklist.filter((x) => x.status === "open" || x.status === "in_progress");

const ICON = { open: "⬜", in_progress: "🟡", done: "✅", skip: "➖" };

export function checklistBlock() {
  const lines = checklist.map((x) => `${ICON[x.status]} [${x.id}] ${x.title}${x.value ? ` → ${x.value}` : ""}`);
  return `רשימת הפתיחה של המעבדה (${checklist.length - openItems().length}/${checklist.length} סגורים):\n${lines.join("\n")}`;
}

export function updateItem({ item_id, status, value }) {
  const item = checklist.find((x) => x.id === item_id);
  if (!item) return `אין סעיף כזה. הסעיפים: ${checklist.map((x) => x.id).join(", ")}`;
  if (status) item.status = status;
  if (value) item.value = value;
  item.updated = new Date().toISOString();
  save();
  const left = openItems().length;
  return `עודכן. נשארו ${left} סעיפים פתוחים.${left ? ` הבא בתור: ${openItems()[0].title}` : " הכל סגור! 🎉"}`;
}

export const CHECKLIST_TOOL = {
  name: "update_checklist",
  description:
    "מעדכן סעיף ברשימת הפתיחה של המעבדה. כשהבעלים החליט משהו (שעות, כתובת, מחירון, אחריות וכו'), שמור את ההחלטה ב-value וסמן done. כשמתחילים לעבוד על סעיף, סמן in_progress. skip רק אם הבעלים אמר במפורש שזה לא רלוונטי.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      item_id: { type: "string", enum: DEFAULTS.map((d) => d.id) },
      status: { type: "string", enum: ["open", "in_progress", "done", "skip"] },
      value: { type: "string", description: "ההחלטה/המידע שנקבע (למשל השעות עצמן, או המחירון המלא)" },
    },
    required: ["item_id", "status", "value"],
    additionalProperties: false,
  },
};
