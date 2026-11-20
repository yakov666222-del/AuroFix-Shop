// שמירת נתונים בקבצי JSON פשוטים בתיקיית data/
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

const timers = {};
function save(name, value) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    const file = path.join(DATA_DIR, name);
    fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
    fs.renameSync(file + ".tmp", file);
  }, 300);
}

// ---------- הגדרות (ניתנות לשינוי מהווטסאפ דרך פקודות) ----------
const DEFAULT_SETTINGS = {
  autoReply: true, // האם הסוכן עונה ללקוחות
  replyInGroups: false, // האם לענות בקבוצות
  muted: {}, // jid -> true : צ'אטים שהסוכן לא עונה בהם
  pausedUntil: {}, // jid -> timestamp : השתלטות ידנית זמנית
};
export const settings = { ...DEFAULT_SETTINGS, ...load("settings.json", {}) };
export const saveSettings = () => save("settings.json", settings);

// ---------- יומן הודעות לכל צ'אט ----------
// chats[jid] = { name, phone, messages: [{ from: "them"|"me"|"bot", text, ts }] }
const MAX_LOG = 200;
export const chats = load("chats.json", {});

export function logMessage(jid, from, text, meta = {}) {
  const chat = (chats[jid] ??= { name: "", phone: "", messages: [] });
  if (meta.name && from === "them") chat.name = meta.name;
  if (meta.phone) chat.phone = meta.phone;
  chat.messages.push({ from, text, ts: Date.now() });
  if (chat.messages.length > MAX_LOG) chat.messages.splice(0, chat.messages.length - MAX_LOG);
  chat.lastTs = Date.now();
  save("chats.json", chats);
}

// ---------- היסטוריית שיחה עם Claude (טקסט בלבד) ----------
// convo[key] = [{ role, content: string }]
const MAX_TURNS = 40;
export const convo = load("convo.json", {});

export function getHistory(key) {
  return convo[key] ?? [];
}

export function appendHistory(key, userText, assistantText) {
  const h = (convo[key] ??= []);
  h.push({ role: "user", content: userText }, { role: "assistant", content: assistantText });
  if (h.length > MAX_TURNS) h.splice(0, h.length - MAX_TURNS);
  save("convo.json", convo);
}

export function clearHistory(key) {
  delete convo[key];
  save("convo.json", convo);
}

// ---------- תזכורות ----------
export const reminders = load("reminders.json", []); // [{ id, at, text }]
export const saveReminders = () => save("reminders.json", reminders);
