// סוכן אישי לווטסאפ - חיבור לחשבון האישי שלך דרך סריקת QR (כמו WhatsApp Web)
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import { OPENING, getApiKey, getGeminiKey, runAgent } from "./agent.js";
import * as lab from "./lab.js";
import { DATA_DIR, appendHistory, chats, clearHistory, convo, logMessage, memory, reminders, saveReminders, saveSettings, settings } from "./store.js";
import { auditLog, findChat, pendingChanges, phoneToJid, replyAppendix } from "./tools.js";
import * as cloud from "./cloud.js";
import { CHAT_HTML, MANIFEST, SW_JS } from "./chat-page.js";
import { synthesize } from "./voice.js";
import { transcribeAudio } from "./gemini.js";
import * as push from "./push.js";
import { openItems } from "./checklist.js";
import { handleShortcut } from "./shortcut.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const TAKEOVER_MIN = Number(process.env.TAKEOVER_MINUTES || 60);
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_SECONDS || 6) * 1000;
const MAX_REPLIES_PER_HOUR = Number(process.env.MAX_REPLIES_PER_HOUR || 20);
const PORT = Number(process.env.PORT || 3000);
const OWNER_NAME = process.env.OWNER_NAME || "יעקב";

if (!getApiKey()) console.log("⚠️ עדיין אין מפתח (Gemini או Claude). אפשר להדביק אותו בעמוד ההגדרה.");

let sock;
let selfJids = new Set(); // המספר שלך (בפורמט טלפון ובפורמט LID)
let selfJid = null;
const OWNER_KEY = "owner"; // שיחה אחת עם היועץ, מכל ערוץ (ווטסאפ או צ'אט באתר)
let latestQr = null;
let pairingCode = null;
let pairPhone = null; // מספר שביקשו עבורו קוד חיבור
let pairingSock = null; // החיבור שיצר את הקוד (קוד תקף רק בחיבור שיצר אותו)
let registeredSince = null; // מתי הטלפון אישר את הקוד
let connected = false;
let retries = 0;
const startedAt = Math.floor(Date.now() / 1000);
const botSentIds = new Set(); // הודעות שהסוכן שלח (כדי להבדיל ממה שאתה כותב ידנית)
const replyLog = {}; // jid -> [timestamps]
const pending = {}; // jid -> { timer, texts: [], images: [] }

// ---------- שליחה ----------
async function sendText(jid, text) {
  if (cloud.cloudEnabled()) {
    // ווטסאפ רשמי: שולחים למספר (הבעלים או איש קשר)
    await cloud.cloudSend(jid.split("@")[0], text);
    logMessage(jid, "bot", text);
    return null;
  }
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  logMessage(jid, "bot", text);
  return sent;
}
// הודעות מהיועץ אליך (תזכורות, סיכום שבועי). אם אין ווטסאפ מחובר, הן מחכות בצ'אט באתר
const INBOX_FILE = path.join(DATA_DIR, "inbox.json");
const webInbox = (() => {
  try {
    return JSON.parse(fs.readFileSync(INBOX_FILE, "utf8"));
  } catch {
    return [];
  }
})();
const saveInbox = () => fs.writeFileSync(INBOX_FILE, JSON.stringify(webInbox.slice(-50)));
// הצ'אט שבו הבעלים באמת כותב ליועץ (בחשבונות חדשים זה לפעמים כתובת LID ולא המספר)
// בווטסאפ הרשמי (Kapso) שולחים תמיד למספר של הבעלים. כתובת ה-LID הישנה (מהחיבור הקודם) לא עובדת שם,
// ובגללה תזכורות והודעות יזומות נפלו בשקט לצ'אט באתר.
const ownerChat = () => (cloud.cloudEnabled() ? `${cloud.normPhone(cloud.cfg.ownerPhone)}@s.whatsapp.net` : settings.ownerChatJid || selfJid);
// buttons: כפתורי תשובה בווטסאפ (למשל "הזמנתי הכל"). בצ'אט באתר הם מופיעים כשורת "אפשר לענות"
async function notifyOwner(text, { buttons } = {}) {
  if (connected && selfJid) {
    try {
      if (buttons?.length && cloud.cloudEnabled()) {
        const to = ownerChat().split("@")[0];
        if (text.length > 1000) {
          await cloud.cloudSend(to, text);
          await cloud.cloudSendButtons(to, "מה הסטטוס?", buttons);
        } else await cloud.cloudSendButtons(to, text, buttons);
        logMessage(ownerChat(), "bot", text);
        return null;
      }
      return await sendText(ownerChat(), text);
    } catch (e) {
      // לא שותקים: רושמים למה ווטסאפ סירב, וההודעה עוברת לצ'אט באתר עם התראה לטלפון
      logger.error(e, "notifyOwner: WhatsApp send failed, falling back to web inbox");
    }
  }
  if (buttons?.length) text += `\n\nאפשר לענות: ${buttons.join(" / ")}`;
  webInbox.push({ id: Date.now() + Math.random(), text, ts: Date.now() });
  saveInbox();
  // התראה קופצת לטלפון
  await push.sendPush(text, `/chat?key=${encodeURIComponent(process.env.QR_PAGE_KEY || "")}`).catch(() => {});
}

// ---------- עזרים ----------
function messageText(m) {
  const msg = m.message || {};
  const inner = msg.ephemeralMessage?.message || msg.viewOnceMessageV2?.message || msg;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    ""
  );
}
const innerMsg = (m) => m.message?.ephemeralMessage?.message || m.message?.viewOnceMessageV2?.message || m.message || {};

function phoneOf(m) {
  const jid = m.key.remoteJid;
  if (jid.endsWith("@s.whatsapp.net")) return jid.split("@")[0];
  if (m.key.remoteJidAlt?.endsWith("@s.whatsapp.net")) return m.key.remoteJidAlt.split("@")[0];
  return "";
}

function isPaused(jid) {
  return (settings.pausedUntil[jid] ?? 0) > Date.now();
}

function overRateLimit(jid) {
  const hourAgo = Date.now() - 3600_000;
  replyLog[jid] = (replyLog[jid] || []).filter((t) => t > hourAgo);
  return replyLog[jid].length >= MAX_REPLIES_PER_HOUR;
}

// ---------- פקודות מהירות מהצ'אט "הודעה לעצמי" ----------
const HELP = () => `🤖 *המלווה העסקי של המעבדה*
פשוט כתוב לי כאן כל שאלה או בקשה, למשל:
• "אני בנקודת אפס, מאיפה מתחילים?"
• "מה ההבדל בין עוסק זעיר למורשה?"
• "השתמשתי בשני מסכים לאייפון 12"
• "מה חסר במלאי?"
• "איך אני מתמחר תיקון מסך?"
• "קיבלתי 350 על החלפת סוללה"
• "תזכיר לי ב-15 לחודש לשלם מקדמות"
• "שלח ל-0501234567 שהטלפון מוכן לאיסוף"
כל יום ראשון בבוקר תקבל ממני סיכום שבועי.
אפשר גם לשלוח צילום (קבלה, מסמך, מכתב מרשות המסים) ולשאול עליו.

פקודות מהירות:
!זיכרון - מה אני זוכר עליך
!אפס - התחלת שיחה חדשה (הזיכרון הקבוע נשאר)
!הפעל / !כבה - מענה אוטומטי ללקוחות (כרגע ${settings.autoReply ? "פועל" : "כבוי"})
!סטטוס - מצב הסוכן
!השתק <שם/מספר> / !בטל השתקה <שם/מספר>
!שחרר <שם/מספר> - החזרת צ'אט לסוכן אחרי שענית ידנית
!קבוצות - מענה בקבוצות
!עזרה`;

function resolveJid(arg) {
  return findChat(arg) || phoneToJid(arg);
}

async function handleCommand(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "!עזרה":
    case "!help":
      return HELP();
    case "!כבה":
    case "!off":
      settings.autoReply = false;
      saveSettings();
      return "⏸️ המענה האוטומטי ללקוחות כבוי. (אני עדיין כאן בשבילך)";
    case "!הפעל":
    case "!on":
      settings.autoReply = true;
      saveSettings();
      return "▶️ המענה האוטומטי ללקוחות פועל. אני אענה ללקוחות לפי business.md ואעדכן אותך כשצריך.";
    case "!קבוצות":
      settings.replyInGroups = !settings.replyInGroups;
      saveSettings();
      return settings.replyInGroups ? "מענה בקבוצות: פועל" : "מענה בקבוצות: כבוי";
    case "!סטטוס":
    case "!status": {
      const paused = Object.entries(settings.pausedUntil).filter(([, t]) => t > Date.now()).length;
      return `מענה אוטומטי: ${settings.autoReply ? "פועל ✅" : "כבוי ⏸️"}
קבוצות: ${settings.replyInGroups ? "כן" : "לא"}
מושתקים: ${Object.keys(settings.muted).length}
צ'אטים בהשתלטות ידנית: ${paused}
תזכורות פתוחות: ${reminders.length}`;
    }
    case "!השתק": {
      const jid = resolveJid(arg);
      if (!jid) return "לא מצאתי. כתוב שם או מספר.";
      settings.muted[jid] = true;
      saveSettings();
      return `🔇 הסוכן לא יענה ל-${chats[jid]?.name || jid.split("@")[0]}`;
    }
    case "!בטל": {
      const jid = resolveJid(arg.replace(/^השתקה\s*/, ""));
      if (!jid) return "לא מצאתי. כתוב: !בטל השתקה <שם/מספר>";
      delete settings.muted[jid];
      saveSettings();
      return `🔊 ההשתקה בוטלה ל-${chats[jid]?.name || jid.split("@")[0]}`;
    }
    case "!שחרר": {
      const jid = resolveJid(arg);
      if (!jid) return "לא מצאתי.";
      delete settings.pausedUntil[jid];
      saveSettings();
      return "✅ הסוכן חזר לטפל בצ'אט הזה.";
    }
    case "!אפס":
      clearHistory(OWNER_KEY);
      pendingChanges.splice(0);
      return "🧹 התחלנו שיחה חדשה. (מה שאני זוכר עליך ועל העסק נשאר, ראה !זיכרון)";
    case "!זיכרון": {
      const items = Object.entries(memory);
      return items.length ? `🧠 מה שאני זוכר:\n${items.map(([k, v]) => `• *${k}*: ${v}`).join("\n")}` : "🧠 עדיין לא שמרתי כלום. ספר לי על העסק שלך!";
    }
    default:
      return null; // לא פקודה - יעבור לסוכן
  }
}

// ---------- אישור שינויי מלאי ("כן" / "לא") ----------
const YES = /^\s*(כן|כן כן|מאשר|אשר|מאושר|יאללה|סבבה|בסדר|אוקיי|אוקי|ok|okay|yes|👍|✅)[\s!.]*$/i;
const NO = /^\s*(לא|בטל|ביטול|עזוב|no|cancel|❌|👎)[\s!.]*$/i;

async function handleConfirmation(text) {
  if (!YES.test(text) && !NO.test(text)) return null;
  const changes = pendingChanges.splice(0).filter((c) => Date.now() - c.ts < 30 * 60_000); // הצעות ישנות פגות
  if (!changes.length) return null;
  let reply;
  if (NO.test(text)) {
    reply = "בוטל, לא שיניתי כלום.";
  } else {
    const lines = [];
    for (const c of changes) {
      if (c.kind === "action") {
        try {
          await lab.runAction(c.action, c.id, c.fields);
          auditLog({ action: c.action, id: c.id, fields: c.fields, summary: c.summary, ok: true, confirmedByOwner: true });
          lines.push(`✅ ${c.summary}`);
        } catch (e) {
          lines.push(`⚠️ ${c.summary}: לא הצלחתי (${e.message})`);
        }
        continue;
      }
      try {
        const r = await lab.adjustInventory(c.id, c.delta, c.reason);
        lines.push(`✅ ${c.name}: ${c.delta > 0 ? "+" : ""}${c.delta}, עכשיו במלאי ${r.qty}`);
      } catch (e) {
        lines.push(`⚠️ ${c.name}: לא הצלחתי לעדכן (${e.message})`);
      }
    }
    reply = `בוצע:\n${lines.join("\n")}`;
  }
  appendHistory(OWNER_KEY, text, reply, 120); // כדי שהמלווה יידע מה קרה
  return reply;
}

// ---------- סיכום שבועי (יום ראשון בבוקר) ----------
function israelNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: process.env.TZ_NAME || "Asia/Jerusalem", weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { weekday: parts.weekday, hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

async function maybeWeeklySummary() {
  if (process.env.WEEKLY_SUMMARY === "false" || !getApiKey()) return;
  const now = israelNow();
  if (now.weekday !== "Sun" || now.hour < 9 || settings.lastWeekly === now.date) return;
  settings.lastWeekly = now.date;
  saveSettings();
  const prompt =
    "[הודעה אוטומטית, לא מהבעלים] תכין לי סיכום פתיחת שבוע קצר: מה חסר במלאי ומה כבר הוזמן, תיקונים פתוחים, מצב המחזור השנתי מול התקרה, תקציב הפתיחה (כמה שולם עד עכשיו, כמה צפוי, ועלויות חודשיות), ותזכורות או מועדי דיווח שמתקרבים. בסוף, צעד אחד שכדאי לעשות השבוע.";
  try {
    const reply = await runAgent("owner", OWNER_KEY, prompt, [], { sendText, notifyOwner, chatJid: selfJid || OWNER_KEY });
    if (reply) await notifyOwner(`☀️ *סיכום שבועי*\n${reply}`);
  } catch (e) {
    logger.error(e, "weekly summary failed");
  }
}

// ---------- נודניק: תזכורת לסעיף הבא ברשימת הפתיחה ----------
async function maybeNag() {
  if (process.env.NAG === "false" || !getApiKey() || !openItems().length) return;
  const now = israelNow();
  const slot = [10, 17].find((h) => now.hour === h);
  if (slot === undefined || ["Fri", "Sat"].includes(now.weekday)) return;
  const key = `${now.date}-${slot}`;
  if (settings.lastNag === key) return;
  settings.lastNag = key;
  saveSettings();
  const prompt =
    "[הודעה אוטומטית, לא מהבעלים] הגיע זמן הנודניק. כתוב לבעלים הודעה קצרה (2-4 שורות), חמה אבל נחושה, על הסעיף הפתוח הבא ברשימת הפתיחה: מה זה, למה זה חשוב, ושאלה אחת שמתחילה לסגור אותו עכשיו. אם זה המחירון, הצע להתחיל בסקר שוק על החלפת מסך/סוללה לדגם הכי נפוץ.";
  try {
    const reply = await runAgent("owner", OWNER_KEY, prompt, [], { sendText, notifyOwner, chatJid: selfJid || OWNER_KEY });
    if (reply) await notifyOwner(`📌 ${reply}`);
  } catch (e) {
    logger.error(e, "nag failed");
  }
}

// ---------- טיפול בהודעות ----------
async function collectImage(m) {
  const img = innerMsg(m).imageMessage;
  if (!img) return null;
  try {
    const buf = await downloadMediaMessage(m, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
    if (buf.length > 4.5 * 1024 * 1024) return null;
    const type = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(img.mimetype) ? img.mimetype : "image/jpeg";
    return { media_type: type, data: buf.toString("base64") };
  } catch (e) {
    logger.warn(e, "image download failed");
    return null;
  }
}

// ---------- הודעה ממך ליועץ (משותף לכל הערוצים) ----------
async function ownerReply(text, images, isVoice, { voice = false } = {}) {
  if (isVoice) return "🎤 עדיין אין לי אפשרות לשמוע הודעות קוליות. אפשר להקליד, או להשתמש בהכתבה של המקלדת (המיקרופון במקלדת).";
  text = text || "";
  if (!text && !images.length) return null;
  const confirm = pendingChanges.length ? await handleConfirmation(text) : null;
  if (confirm) return confirm;
  const quick = text.startsWith("!") ? await handleCommand(text) : null;
  if (quick) return quick;
  try {
    replyAppendix.length = 0;
    const reply = await runAgent("owner", OWNER_KEY, text, images, { sendText, notifyOwner, chatJid: selfJid || OWNER_KEY });
    // רשימות שהקוד בנה מהמערכת מצורפות כמו שהן. בהודעה קולית הן נשלחות כטקסט (אחרי "פרטים:")
    const extra = replyAppendix.splice(0).join("\n\n");
    if (!extra) return reply;
    appendHistory(OWNER_KEY, "[הרשימה שצורפה לתשובה הקודמת]", extra, 120);
    return voice ? `${reply}\nפרטים:\n${extra}` : `${reply}\n\n${extra}`;
  } catch (e) {
    logger.error(e);
    return `⚠️ שגיאה: ${e.message}`;
  }
}

async function handleOwner(text, images, isVoice, replyJid = selfJid) {
  const reply = await ownerReply(text, images, isVoice);
  if (reply) await sendText(replyJid, reply).catch((e) => logger.error(e, "send reply"));
}

// ---------- ווטסאפ רשמי: הודעות נכנסות מ-Meta ----------
const seenCloudIds = new Set();
async function onCloudMessage(m) {
  if (seenCloudIds.has(m.id)) return; // Meta לפעמים שולחת פעמיים
  seenCloudIds.add(m.id);
  if (seenCloudIds.size > 1000) seenCloudIds.clear();
  if (Number(m.timestamp) < startedAt - 300) return;
  if (cloud.normPhone(m.from) !== cloud.normPhone(cloud.cfg.ownerPhone)) {
    console.log("📩 הודעה ממספר אחר, לא עונים");
    return;
  }
  // "מקליד..." מיד, ומתחדש כל 20 שניות עד שהתשובה נשלחת, כדי שיהיה ברור שהיא עובדת על זה
  cloud.markRead(m.id, { typing: true });
  const typing = setInterval(() => cloud.markRead(m.id, { typing: true }), 20_000);
  try {
    await handleCloudOwnerMessage(m);
  } finally {
    clearInterval(typing);
  }
}

async function handleCloudOwnerMessage(m) {
  // מתי הבעלים כתב לאחרונה: ממנו נספרות 24 השעות שבהן מותר לשלוח לו בחינם
  settings.lastOwnerMsg = Number(m.timestamp) * 1000 || Date.now();
  saveSettings();
  if (m.type === "audio") return handleOwnerVoice(m);
  const text = m.text?.body || cloud.buttonText(m) || m.image?.caption || "";
  const images = m.type === "image" ? [await cloud.downloadImage(m.image.id, m.image.url).catch(() => null)].filter(Boolean) : [];
  await handleOwner(text, images, false);
}

// הודעה קולית מהבעלים: מתמללים, היועץ עונה, והתשובה חוזרת כהודעה קולית.
// אם בתשובה יש קישורים, טבלה או הרבה פרטים, שולחים גם את הטקסט כדי שיהיה אפשר לקרוא ולהעתיק.
async function handleOwnerVoice(m) {
  const to = ownerChat();
  let heard;
  try {
    const key = getGeminiKey();
    if (!key) throw new Error("אין מפתח Gemini לתמלול");
    const audio = await cloud.downloadAudio(m.audio?.id, m.audio?.url);
    heard = await transcribeAudio(key, audio);
  } catch (e) {
    logger.error(e, "voice transcription failed");
    return sendText(to, `🎤 לא הצלחתי לשמוע את ההודעה הקולית (${e.message}). נסה שוב או כתוב לי.`).catch(() => {});
  }
  if (!heard || heard === "[שקט]") return sendText(to, "🎤 לא שמעתי דיבור בהקלטה. נסה שוב?").catch(() => {});
  logMessage(to, "owner", `🎤 ${heard}`);
  const reply = await ownerReply(
    `${heard}\n\n(נשלח כהודעה קולית. התשובה שלך תוקרא לו בקול: דבר בעברית טבעית ובמשפטים קצרים, בלי טבלאות, בלי רשימות ארוכות ובלי אימוג'י. אם צריך פרטים, קישורים או טבלה, כתוב אותם בסוף אחרי שורה "פרטים:".)`,
    [],
    false,
    { voice: true }
  );
  if (!reply) return;
  const [spoken, ...rest] = reply.split(/\n\s*פרטים:\s*/);
  const details = rest.join("\n\n");
  const needsText = Boolean(details) || /https?:\/\/|\|/.test(reply) || reply.length > 900;
  try {
    const ogg = await synthesize(spoken || reply);
    await cloud.cloudSendVoice(to.split("@")[0], ogg);
    logMessage(to, "bot", `🔊 ${spoken || reply}`);
    if (needsText) await sendText(to, details ? `📝 ${details}` : reply);
  } catch (e) {
    logger.error(e, "voice reply failed, sending text");
    await sendText(to, reply).catch((err) => logger.error(err, "send reply"));
  }
}

async function onMessage(m) {
  const jid = m.key.remoteJid;
  if (!jid || isJidStatusBroadcast(jid) || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return;
  if (Number(m.messageTimestamp) < startedAt - 30) return; // לא לענות על הודעות ישנות בהפעלה

  const text = messageText(m);
  const inner = innerMsg(m);
  const hasImage = Boolean(inner.imageMessage);
  const isAudio = Boolean(inner.audioMessage);
  if (!text && !hasImage && !isAudio) return; // סטיקרים, תגובות וכו'

  const isSelfChat = selfJids.has(jidNormalizedUser(jid));

  // --- הודעות שלך ---
  if (m.key.fromMe) {
    if (botSentIds.has(m.key.id)) return; // הודעה שהסוכן עצמו שלח

    if (isSelfChat) {
      // אתה מדבר עם הסוכן
      const images = hasImage ? [await collectImage(m)].filter(Boolean) : [];
      if (settings.ownerChatJid !== jid) {
        settings.ownerChatJid = jid; // זוכרים לאן לשלוח תזכורות
        saveSettings();
        console.log("📍 נשמר הצ'אט של הבעלים");
      }
      await sock.sendPresenceUpdate("composing", jid).catch(() => {});
      await handleOwner(text, images, isAudio && !text, jid);
      return;
    }

    // ענית ידנית ללקוח -> הסוכן מפסיק לענות בצ'אט הזה לזמן מה
    logMessage(jid, "me", text || "[מדיה]");
    settings.pausedUntil[jid] = Date.now() + TAKEOVER_MIN * 60_000;
    saveSettings();
    return;
  }

  // --- הודעה נכנסת ממישהו אחר ---
  if (isSelfChat) return;
  const name = m.pushName || "";
  const isGroup = isJidGroup(jid);
  logMessage(jid, "them", (isGroup && name ? `${name}: ` : "") + (text || (hasImage ? "[תמונה]" : "[הודעה קולית]")), {
    name: isGroup ? undefined : name,
    phone: phoneOf(m),
  });

  if (!settings.autoReply || settings.muted[jid] || isPaused(jid)) return;
  if (isGroup && !settings.replyInGroups) return;

  // מחכים כמה שניות כדי לאסוף כמה הודעות רצופות לתשובה אחת
  const p = (pending[jid] ??= { texts: [], images: [], audio: false, name });
  if (text) p.texts.push(isGroup && name ? `${name}: ${text}` : text);
  if (isAudio) p.audio = true;
  if (hasImage) {
    const img = await collectImage(m);
    if (img) p.images.push(img);
  }
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(jid), DEBOUNCE_MS);
}

async function flush(jid) {
  const p = pending[jid];
  delete pending[jid];
  if (!p || isPaused(jid) || !settings.autoReply) return;
  if (overRateLimit(jid)) return;

  let text = p.texts.join("\n");
  if (p.audio) text += "\n(הלקוח שלח הודעה קולית שאי אפשר לשמוע - בקש בנימוס שיכתוב בטקסט)";
  const header = p.name ? `[הודעה מ-${p.name}]\n` : "";

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const reply = await runAgent("customer", jid, header + text, p.images.slice(0, 4), {
      sendText,
      notifyOwner,
      chatJid: jid,
      chatName: chats[jid]?.name,
    });
    await sock.sendPresenceUpdate("paused", jid);
    if (reply && !isPaused(jid)) {
      await sendText(jid, reply);
      (replyLog[jid] ??= []).push(Date.now());
    }
  } catch (e) {
    logger.error(e, "agent failed");
    await notifyOwner(`⚠️ הסוכן נכשל לענות ל-${chats[jid]?.name || jid.split("@")[0]}: ${e.message}`).catch(() => {});
  }
}

// ---------- תזכורות ----------
setInterval(async () => {
  const due = reminders.filter((r) => r.at <= Date.now());
  for (const r of due) {
    await notifyOwner(`⏰ תזכורת: ${r.text}`).catch(() => {});
    reminders.splice(reminders.indexOf(r), 1);
  }
  if (due.length) saveReminders();
  maybeWeeklySummary();
  maybeNag();
  maybeKeepWindow();
  maybeShortageAlert();
}, 20_000);

// התראת חוסרים במלאי: פעם ביום (א'-ו' ב-12:00), רק על מה שעוד לא הוזמן.
// אותה רשימה לא חוזרת כל יום: רק כשנוסף חוסר חדש, או אחרי יומיים בלי תגובה.
const SHORTAGE_BUTTONS = ["✅ הזמנתי הכל", "🛒 הזמנתי חלק", "⏰ תזכיר מחר"];
let shortageBusy = false;
async function maybeShortageAlert() {
  if (!lab.labEnabled || shortageBusy || process.env.SHORTAGE_ALERTS === "false") return;
  const now = israelNow();
  if (now.hour !== 12 || now.weekday === "Sat" || settings.lastShortageDay === now.date) return;
  shortageBusy = true;
  try {
    const { toOrder } = await lab.shortageData();
    settings.lastShortageDay = now.date;
    const key = toOrder.map((x) => x.item.id).sort().join(",");
    const prev = settings.lastShortageAlert || {};
    const isNew = toOrder.some((x) => !(prev.key || "").split(",").includes(x.item.id));
    const stale = Date.now() - (prev.ts || 0) > 2 * 24 * 3600_000;
    if (!toOrder.length || (!isNew && !stale)) return saveSettings();
    settings.lastShortageAlert = { key, ts: Date.now() };
    saveSettings();
    const text = `📦 *חסר במלאי*\n${toOrder.map(lab.shortageLine).join("\n")}\n\nסה"כ להזמנה ≈ ${lab.orderTotal(toOrder)}\nהזמנת?`;
    // נשמר בשיחה, כדי שהיועץ יידע על אילו פריטים מדובר כשתלחץ על כפתור
    appendHistory(OWNER_KEY, "[הודעה אוטומטית, לא מהבעלים] התראת חוסרים יומית", `${text}\n(מזהים: ${toOrder.map((x) => `${x.item.name}=${x.item.id}`).join(", ")})`);
    await notifyOwner(text, { buttons: SHORTAGE_BUTTONS });
  } catch (e) {
    logger.error(e, "shortage alert failed");
  } finally {
    shortageBusy = false;
  }
}

// ווטסאפ מרשה לשלוח לבעלים בחינם רק 24 שעות אחרי שהוא כתב.
// לפני שהחלון נסגר מבקשים ממנו תגובה קצרה, כדי שההתראות ימשיכו להגיע לווטסאפ בלי תבנית בתשלום.
async function maybeKeepWindow() {
  const last = settings.lastOwnerMsg;
  if (!cloud.cloudEnabled() || !last || settings.windowPing === last) return;
  const end = last + 24 * 3600_000;
  const left = end - Date.now();
  if (left < 15 * 60_000) return; // כבר מאוחר מדי לשלוח
  const { hour } = israelNow();
  if (hour < 9 || hour >= 22) return; // לא מעירים בלילה
  const closesTonight = hour >= 21 && left < 12 * 3600_000; // החלון ייסגר לפני 9 בבוקר
  if (left > 4 * 3600_000 && !closesTonight) return;
  settings.windowPing = last;
  saveSettings();
  await sendText(
    ownerChat(),
    "👋 עברו כמעט 24 שעות מאז שכתבת לי. ווטסאפ מרשה לי לשלוח לך הודעות רק אם כתבת לי ביממה האחרונה.\nשלח לי משהו קצר (אפילו 👍) כדי שהתזכורות וההתראות ימשיכו להגיע לכאן."
  ).catch((e) => logger.error(e, "window ping failed"));
}

// ---------- חיבור לווטסאפ ----------
async function connect() {
  // סוגרים חיבור קודם (אם יש) כדי שלא יהיו שני חיבורים במקביל
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch {}
  }
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, "auth"));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.macOS("Chrome"), // חיבור בקוד עובד רק כשהמכשיר מזוהה כדפדפן
    markOnlineOnConnect: false, // כדי שתמשיך לקבל התראות בטלפון
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr, isNewLogin }) => {
    if (isNewLogin) console.log("🎉 הטלפון אישר את החיבור (התחברות חדשה)");
    if (connection === "connecting") console.log("…מתחבר לווטסאפ");
    if (qr) {
      latestQr = qr;
      if (process.stdout.isTTY) {
        console.log("\n📱 סרוק את הקוד: ווטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר");
        qrcodeTerminal.generate(qr, { small: true });
        console.log(`(או פתח בדפדפן: http://localhost:${PORT})\n`);
      }
      // ביקשו חיבור בקוד: מבקשים קוד מהחיבור הנוכחי (כל חיבור חדש = קוד חדש)
      if (pairPhone && !pairingCode && !sock.authState.creds.registered) {
        try {
          const thisSock = sock;
          const code = await thisSock.requestPairingCode(pairPhone);
          if (thisSock === sock) {
            pairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
            pairingSock = thisSock;
            console.log("🔑 נוצר קוד חיבור חדש");
          }
        } catch (e) {
          console.log("⚠️ בקשת קוד חיבור נכשלה:", e.message);
        }
      }
    }
    if (connection === "open") {
      connected = true;
      registeredSince = null;
      retries = 0;
      latestQr = null;
      pairingCode = null;
      pairPhone = null;
      selfJid = jidNormalizedUser(sock.user.id);
      selfJids = new Set([selfJid, sock.user.lid && jidNormalizedUser(sock.user.lid)].filter(Boolean));
      console.log(`✅ מחובר כ-${selfJid}`);
      const lidJid = sock.user.lid && jidNormalizedUser(sock.user.lid);
      if (!settings.ownerChatJid && lidJid) {
        // לא ידוע עדיין איזה כתובת מציגה את הצ'אט "הודעה לעצמי": שולחים גם ל-LID
        sendText(lidJid, "👋 היועץ מחובר. כתוב לי כאן כל דבר.").catch(() => {});
      }
      if (!convo[OWNER_KEY]?.length) {
        await notifyOwner(`✅ מחובר!\n\n${OPENING}`).catch(() => {});
        appendHistory(OWNER_KEY, "(התחברתי עכשיו)", OPENING, 120);
      } else {
        await notifyOwner("✅ חזרתי לפעול. אפשר להמשיך מאיפה שעצרנו.").catch(() => {});
      }
    }
    if (connection === "close") {
      connected = false;
      // הקוד הישן כבר לא תקף. לא מבקשים קוד חדש לבד (כל בקשה שולחת התראה לטלפון)
      if (pairingCode) pairPhone = null;
      pairingCode = null;
      latestQr = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔌 החיבור נסגר (קוד ${code ?? "?"})`);
      if (code === DisconnectReason.restartRequired) {
        // קורה מיד אחרי חיבור מוצלח בקוד/QR: מתחברים מחדש מיד
        setTimeout(connect, 500);
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        console.log("🚪 התנתקת מהווטסאפ. מתחיל חיבור חדש...");
        fs.rmSync(path.join(DATA_DIR, "auth"), { recursive: true, force: true });
        pairingCode = null;
        setTimeout(connect, 2000);
        return;
      }
      // עוד לא מחובר (מחכה לקוד/QR): מתחברים מחדש מיד. מחובר שנפל: מחכים יותר ויותר
      const wait = sock?.authState?.creds?.registered ? Math.min(60, 3 * 2 ** retries++) : 2;
      console.log(`🔄 החיבור נותק, מתחבר מחדש בעוד ${wait} שניות...`);
      setTimeout(connect, wait * 1000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) onMessage(m).catch((e) => logger.error(e, "onMessage"));
  });
}

const PUBLIC_HTML = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YakovPhone - מעבדת תיקון טלפונים</title><meta name="description" content="YakovPhone - מעבדת תיקון טלפונים סלולריים">
<link rel="icon" href="/icon.svg"><style>body{margin:0;font-family:system-ui,sans-serif;background:#0d1311;color:#eef1ee;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}
img{width:120px;height:120px;border-radius:26px}h1{margin:18px 0 6px;color:#f2c45a}p{color:#b9c6bf;max-width:420px;line-height:1.6}</style></head>
<body><main><img src="/icon-512.png" alt="YakovPhone"><h1>YakovPhone</h1><p>מעבדת תיקון טלפונים סלולריים: מסכים, סוללות, שקעי טעינה ועוד.</p></main></body></html>`;

// ---------- עמוד הגדרה: מפתח Claude + חיבור לווטסאפ (בקוד או ב-QR) ----------
const page = (body) =>
  `<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>היועץ האישי</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px 16px;line-height:1.6;background:#f6f7f9;color:#111}
.card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 4px #0002;margin-bottom:16px}
input,button{font-size:18px;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #ccc;margin-top:8px}
button{background:#25d366;color:#fff;border:0;font-weight:bold}.code{font-size:34px;letter-spacing:4px;font-weight:bold;text-align:center;direction:ltr;background:#eefbf2;padding:12px;border-radius:10px}
ol{padding-inline-start:20px}small{color:#666}</style><body>${body}</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c).length > 10000 && req.destroy());
    req.on("end", () => resolve(new URLSearchParams(d)));
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    // בדיקת חיים לעבודה המתוזמנת (שומרת את השרת ער). בלי מידע רגיש
    if (url.pathname === "/webhook" && req.method === "GET") {
      // Meta מאמתת את הכתובת
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === cloud.cfg.verifyToken;
      res.writeHead(ok ? 200 : 403, { "Content-Type": "text/plain" });
      return res.end(ok ? url.searchParams.get("hub.challenge") || "" : "forbidden");
    }
    if (url.pathname === "/webhook" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      res.writeHead(200);
      res.end("ok"); // עונים מיד, ומטפלים ברקע
      if (!cloud.cloudEnabled() || !cloud.validSignature(raw, req.headers)) return;
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      for (const m of cloud.extractMessages(body)) onCloudMessage(m).catch((e) => logger.error(e, "cloud message"));
      return;
    }
    const icon = url.pathname.match(/^\/(icon-(180|192|512)\.png|icon\.svg)$/);
    if (icon) {
      res.writeHead(200, { "Content-Type": icon[1].endsWith(".svg") ? "image/svg+xml" : "image/png", "Cache-Control": "public, max-age=86400" });
      return res.end(fs.readFileSync(new URL(`../assets/${icon[1]}`, import.meta.url)));
    }
    if (url.pathname === "/manifest.json") {
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      return res.end(MANIFEST);
    }
    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/" });
      return res.end(SW_JS);
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(connected ? "ok connected" : "ok");
    }
    const secret = process.env.QR_PAGE_KEY;
    if (secret && url.searchParams.get("key") !== secret) {
      // דף ציבורי קטן של העסק (בשביל פרופיל הווטסאפ ומנועי חיפוש). בלי שום מידע פרטי
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(PUBLIC_HTML);
      }
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("אין גישה");
    }
    const self = `?key=${encodeURIComponent(secret || "")}`;
    const back = (msg) => {
      res.writeHead(303, { Location: `/${self}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}` });
      res.end();
    };

    // ---------- צ'אט באתר ----------
    if (url.pathname === "/chat" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(CHAT_HTML);
    }
    if (url.pathname === "/chat/history" && req.method === "GET") {
      const h = (convo[OWNER_KEY] ?? []).slice(-40).map((m) => ({ role: m.role, text: m.content }));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ history: h, opening: OPENING }));
    }
    if (url.pathname === "/chat/push-key" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ key: push.publicKey, subscribed: push.hasSubscribers() }));
    }
    if (url.pathname === "/chat/subscribe" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let ok = false;
      try {
        ok = push.addSubscription(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {}
      if (ok) push.sendPush("✅ ההתראות פועלות. מעכשיו אני יכול להציק לך 😉").catch(() => {});
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok }));
    }
    if (url.pathname === "/chat/inbox" && req.method === "GET") {
      const items = webInbox.splice(0);
      if (items.length) saveInbox();
      // מה שהגיע לתיבה נכנס גם להיסטוריה, כדי שהיועץ יידע שהוא שלח את זה
      for (const it of items) appendHistory(OWNER_KEY, "(הודעה אוטומטית)", it.text, 120);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ items }));
    }
    if (url.pathname === "/chat/send" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 8 * 1024 * 1024) break;
        chunks.push(c);
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      const images =
        body.image && /^image\/(jpeg|png|webp|gif)$/.test(body.image.media_type) && typeof body.image.data === "string"
          ? [{ media_type: body.image.media_type, data: body.image.data }]
          : [];
      const reply = (await ownerReply(String(body.text || "").slice(0, 4000), images, false)) || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ reply }));
    }
    // ---------- קיצור Apple Shortcuts ("עוזר יעקב"): הוראה בעברית -> פעולה באייפון ----------
    if (url.pathname === "/shortcut" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 64 * 1024) break;
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let text = "";
      try {
        text = String(JSON.parse(raw).text ?? "");
      } catch {
        text = new URLSearchParams(raw).get("text") || raw;
      }
      const proto = req.headers["x-forwarded-proto"] || "https";
      const origin = req.headers.host ? `${proto}://${req.headers.host}` : "";
      const out = await handleShortcut(text.slice(0, 2000), {
        origin,
        key: secret,
        ask: async (t) => (await ownerReply(t, [], false)) || "",
      }).catch((e) => ({ action: "say", speak: `⚠️ שגיאה: ${e.message}` }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify(out));
    }
    if (req.method === "POST" && url.pathname === "/apikey") {
      let k = (await readBody(req)).get("apikey")?.trim().replace(/^["'<]+|["'>]+$/g, "") || "";
      // מ-Tavily אפשר להדביק גם את "MCP link" (כתובת שהמפתח בתוכה): מוציאים ממנה את המפתח
      const tv = k.match(/tvly-[A-Za-z0-9_\-]{10,}/);
      if (tv) k = tv[0];
      if (/YOUR|API_KEY/i.test(k)) return back("זו דוגמה מההוראות של Tavily (tvly-YOUR_API_KEY), לא המפתח שלך. העתק את המפתח מכרטיס API Keys בראש הדף");
      if (k.startsWith("sk-ant-")) fs.writeFileSync(path.join(DATA_DIR, "anthropic_key"), k, { mode: 0o600 });
      // מפתח לחיפוש באינטרנט (Tavily)
      else if (/^tvly-[A-Za-z0-9_\-]{10,}$/.test(k)) fs.writeFileSync(path.join(DATA_DIR, "tavily_key"), k, { mode: 0o600 });
      // מפתחות של גוגל מתחילים ב-AIza (פורמט ישן) או ב-AQ. (פורמט חדש)
      else if (/^[A-Za-z0-9._\-]{30,}$/.test(k)) fs.writeFileSync(path.join(DATA_DIR, "gemini_key"), k, { mode: 0o600 });
      else return back("זה לא נראה כמו מפתח. ודא שהעתקת את כולו, בלי רווחים (לחץ Copy key)");
      return back();
    }
    if (req.method === "POST" && url.pathname === "/cloud") {
      const f = await readBody(req);
      const prov = f.get("provider");
      if (prov === "kapso" || prov === "meta") cloud.cfg.provider = prov;
      for (const [k, name] of [["token", "token"], ["phoneNumberId", "phone_number_id"], ["ownerPhone", "owner_phone"], ["appSecret", "app_secret"]]) {
        const v = (f.get(name) || "").trim();
        if (v) cloud.cfg[k] = k === "ownerPhone" ? cloud.normPhone(v) : v;
      }
      cloud.saveCfg();
      if (cloud.cloudEnabled()) {
        startCloudMode();
        await sendText(selfJid, `✅ מחובר!\n\n${OPENING}`).then(
          () => convo[OWNER_KEY]?.length || appendHistory(OWNER_KEY, "(התחברתי עכשיו)", OPENING, 120),
          (e) => console.log("⚠️ הודעת פתיחה לא נשלחה:", e.message)
        );
      }
      return res.writeHead(303, { Location: `/cloud${self}` }), res.end();
    }
    if (url.pathname === "/cloud") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const c = cloud.cfg;
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const st = cloud.cloudEnabled() ? "✅ מוגדר" : "עדיין לא מוגדר";
      return res.end(
        page(`<h1>📱 ווטסאפ רשמי</h1><div class="card"><p>מצב: <b>${st}</b></p>
<p><b>כתובת Callback (להעתיק ל-Meta):</b></p><div class="code" style="font-size:15px;letter-spacing:0">https://${host}/webhook</div>
<p><b>Verify token (להעתיק ל-Meta):</b></p><div class="code" style="font-size:15px;letter-spacing:0">${c.verifyToken}</div></div>
<div class="card"><form method="post" action="/cloud${self}">
<p>דרך החיבור</p><select name="provider" style="font-size:18px;width:100%;padding:10px;border-radius:10px">
<option value="kapso" ${c.provider === "kapso" ? "selected" : ""}>Kapso</option><option value="meta" ${c.provider === "meta" ? "selected" : ""}>Meta ישירות</option></select>
<p>${c.provider === "meta" ? "Access token" : "Kapso API key"} ${c.token ? "(נשמר ✓, אפשר להחליף)" : ""}</p><input name="token" autocomplete="off">
<p>Phone number ID ${c.phoneNumberId ? `(${c.phoneNumberId})` : ""}</p><input name="phone_number_id" inputmode="numeric" autocomplete="off">
<p>המספר שלך (שממנו תכתוב ליועץ) ${c.ownerPhone ? `(${c.ownerPhone})` : ""}</p><input name="owner_phone" type="tel" placeholder="0501234567">
<p>${c.provider === "meta" ? "App secret" : "Webhook secret"} (רשות, לאבטחה) ${c.appSecret ? "(נשמר ✓)" : ""}</p><input name="app_secret" autocomplete="off">
<button>שמור</button></form></div>`)
      );
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      if (connected) return back("כבר מחובר");
      console.log("♻️ איפוס החיבור לבקשת המשתמש");
      fs.rmSync(path.join(DATA_DIR, "auth"), { recursive: true, force: true });
      registeredSince = null;
      pairPhone = null;
      pairingCode = null;
      connect();
      return back();
    }
    if (req.method === "POST" && url.pathname === "/pair") {
      let phone = ((await readBody(req)).get("phone") || "").replace(/\D/g, "");
      if (phone.startsWith("0")) phone = "972" + phone.slice(1);
      if (phone.length < 11 || phone.length > 15) return back("מספר הטלפון לא נראה תקין. כתוב למשל 0501234567");
      pairPhone = phone;
      pairingCode = null;
      pairingSock = null;
      if (connected) return back("כבר מחובר");
      if (sock?.authState?.creds?.registered) return back("הטלפון כבר אישר קוד, החיבור בתהליך. אל תבקש קוד חדש.");
      // פותחים חיבור חדש ונקי. הקוד ייווצר בו תוך כמה שניות
      console.log("📞 התבקש קוד חיבור, פותח חיבור חדש");
      try {
        sock.end(new Error("pairing requested"));
      } catch {}
      return back();
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const msg = url.searchParams.get("msg");
    let body = `<h1>🤖 היועץ האישי שלך</h1>${msg ? `<div class="card" style="background:#fff3f3">⚠️ ${msg.replace(/</g, "&lt;")}</div>` : ""}`;

    // שלב 1: מפתח Claude
    if (!getApiKey()) {
      body += `<div class="card"><h2>שלב 1 מתוך 2: המפתח</h2>
<ol><li>פתח את <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> (כניסה עם גוגל)</li><li>לחץ <b>Create API key</b> והעתק</li><li>הדבק כאן:</li></ol>
<form method="post" action="/apikey${self}"><input name="apikey" placeholder="AQ... או AIza..." autocomplete="off" required><button>שמור</button></form>
<small>המפתח נשמר רק בשרת שלך. (אפשר גם מפתח של Claude שמתחיל ב-sk-ant-)</small></div>`;
      return res.end(page(body));
    }
    // חיפוש באינטרנט (לסקר שוק): מפתח Tavily חינמי
    {
      const hasTavily = Boolean(process.env.TAVILY_API_KEY || fs.existsSync(path.join(DATA_DIR, "tavily_key")));
      body += `<div class="card"><h2>🌐 חיפוש באינטרנט ${hasTavily ? "✅ מחובר" : "(לא מחובר)"}</h2>
${hasTavily ? "<p>היועץ יכול לחפש באינטרנט ולעשות סקר שוק. אפשר להחליף מפתח כאן:</p>" : `<p>כדי שהיועץ יוכל לחפש באינטרנט ולעשות סקר שוק, צריך מפתח חינמי של Tavily (1,000 חיפושים בחודש, בלי כרטיס אשראי).</p>
<ol><li>פתח את <a href="https://app.tavily.com" target="_blank">app.tavily.com</a> והירשם עם גוגל</li><li>בדף הראשי, בכרטיס <b>API Keys</b> למעלה, לחץ על סמל ההעתקה ליד המפתח (מתחיל ב-tvly-). גם <b>Copy MCP link</b> עובד</li><li>הדבק כאן:</li></ol>`}
<form method="post" action="/apikey${self}"><input name="apikey" placeholder="tvly-..." autocomplete="off" required><button>שמור</button></form></div>`;
    }

    // שלב 2: חיבור לווטסאפ
    if (connected) {
      body += `<div class="card"><h2>✅ הכל מחובר!</h2><p>פתח בווטסאפ את הצ'אט עם <b>עצמך</b> (חפש את השם שלך, או "אני (הודעה לעצמי)") וכתוב שם כל שאלה.</p></div>`;
      return res.end(page(body));
    }
    // הטלפון כבר אישר את הקוד, מחכים לסיום החיבור: לא נותנים קוד חדש
    if (sock?.authState?.creds?.registered) {
      registeredSince ??= Date.now();
      const stuck = Date.now() - registeredSince > 3 * 60_000;
      body += `<div class="card"><h2>⏳ מתחבר...</h2><p>הטלפון אישר את הקוד. עוד כמה שניות תקבל בווטסאפ הודעה "✅ מחובר!". <b>אל תבקש קוד חדש.</b></p>${
        stuck
          ? `<p>זה לוקח יותר מדי זמן.</p><form method="post" action="/reset${self}"><button style="background:#c0392b">התחל את החיבור מההתחלה</button></form>`
          : ""
      }</div><script>setTimeout(()=>location.reload(),5000)</script>`;
      return res.end(page(body));
    }
    if (pairingCode && pairingSock === sock) {
      body += `<div class="card"><h2>שלב 2 מתוך 2: הקלד את הקוד בווטסאפ</h2><div class="code">${pairingCode}</div>
<ol><li>פתח את <b>ווטסאפ</b></li><li><b>הגדרות</b> › <b>מכשירים מקושרים</b> › <b>קישור מכשיר</b></li><li>למטה לחץ <b>"קישור באמצעות מספר טלפון"</b></li><li>הקלד את הקוד שלמעלה, מהר (תוך דקה)</li></ol>
<small>הקוד מתחלף לפעמים. תמיד השתמש בקוד שמופיע כאן עכשיו. הדף מתעדכן לבד.</small>
<form method="post" action="/pair${self}"><input type="hidden" name="phone" value="${pairPhone}"><button style="background:#888">לא עובד? קבל קוד חדש</button></form></div>
<script>setTimeout(()=>location.reload(),10000)</script>`;
      return res.end(page(body));
    }
    if (pairPhone) {
      body += `<div class="card"><h2>מכין קוד...</h2><p>עוד כמה שניות.</p></div><script>setTimeout(()=>location.reload(),3000)</script>`;
      return res.end(page(body));
    }
    body += `<div class="card"><h2>שלב 2 מתוך 2: חיבור לווטסאפ</h2><p>הכנס את מספר הטלפון שיש עליו את הווטסאפ שלך:</p>
<form method="post" action="/pair${self}"><input name="phone" type="tel" placeholder="050-1234567" required><button>קבל קוד חיבור</button></form></div>`;
    if (latestQr)
      body += `<div class="card"><p><small>יש לך מחשב או טלפון נוסף? אפשר גם לסרוק:</small></p><img style="width:100%" src="${await QRCode.toDataURL(latestQr, { width: 320 })}"><small>הריבוע מתחלף כל כמה שניות. <a href="">רענן</a></small></div>`;
    else body += `<p><small>מתחבר לווטסאפ...</small></p><script>setTimeout(()=>location.reload(),3000)</script>`;
    res.end(page(body));
  })
  .listen(PORT, "0.0.0.0", () => console.log(`🌐 עמוד הגדרה: http://localhost:${PORT}`));

// ווטסאפ רשמי: אין חיבור לווטסאפ ווב, ההודעות מגיעות ל-/webhook
function startCloudMode() {
  try {
    sock?.ev.removeAllListeners();
    sock?.end(undefined);
  } catch {}
  sock = null;
  selfJid = `${cloud.cfg.ownerPhone}@s.whatsapp.net`;
  selfJids = new Set([selfJid]);
  connected = true;
  console.log("📱 מצב ווטסאפ רשמי (Meta) פעיל");
}

console.log(`🤖 סוכן ווטסאפ של ${OWNER_NAME} עולה...`);
if (cloud.cloudEnabled()) startCloudMode();
else if (process.env.WA_MODE !== "cloud") connect();
