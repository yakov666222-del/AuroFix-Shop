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
import { runAgent } from "./agent.js";
import { DATA_DIR, chats, clearHistory, logMessage, reminders, saveReminders, saveSettings, settings } from "./store.js";
import { findChat, phoneToJid } from "./tools.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const TAKEOVER_MIN = Number(process.env.TAKEOVER_MINUTES || 60);
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_SECONDS || 6) * 1000;
const MAX_REPLIES_PER_HOUR = Number(process.env.MAX_REPLIES_PER_HOUR || 20);
const PORT = Number(process.env.PORT || 3000);
const OWNER_NAME = process.env.OWNER_NAME || "יעקב";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ חסר ANTHROPIC_API_KEY בקובץ .env (ראה .env.example)");
  process.exit(1);
}

let sock;
let selfJids = new Set(); // המספר שלך (בפורמט טלפון ובפורמט LID)
let selfJid = null;
let latestQr = null;
let connected = false;
let retries = 0;
const startedAt = Math.floor(Date.now() / 1000);
const botSentIds = new Set(); // הודעות שהסוכן שלח (כדי להבדיל ממה שאתה כותב ידנית)
const replyLog = {}; // jid -> [timestamps]
const pending = {}; // jid -> { timer, texts: [], images: [] }

// ---------- שליחה ----------
async function sendText(jid, text) {
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  logMessage(jid, "bot", text);
  return sent;
}
const notifyOwner = (text) => sendText(selfJid, text);

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
const HELP = `🤖 *הסוכן האישי שלך*
פשוט כתוב לי כאן מה לעשות, למשל:
• "מי חיכה לתשובה היום?"
• "תסכם לי את הצ'אט עם משה"
• "שלח ל-0501234567 שהטלפון מוכן לאיסוף"
• "תזכיר לי מחר ב-9 להזמין מסכים"

פקודות מהירות:
!כבה / !הפעל - עצירה/הפעלה של מענה אוטומטי
!סטטוס - מצב הסוכן
!השתק <שם/מספר> - הסוכן לא יענה לאיש קשר הזה
!בטל השתקה <שם/מספר>
!שחרר <שם/מספר> - החזרת צ'אט לסוכן אחרי שענית ידנית
!קבוצות - הפעלה/כיבוי מענה בקבוצות
!אפס - מחיקת זיכרון השיחה שלי עם הסוכן
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
      return HELP;
    case "!כבה":
    case "!off":
      settings.autoReply = false;
      saveSettings();
      return "⏸️ המענה האוטומטי כבוי. (אני עדיין זמין לך כאן)";
    case "!הפעל":
    case "!on":
      settings.autoReply = true;
      saveSettings();
      return "▶️ המענה האוטומטי פועל.";
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
      clearHistory(selfJid);
      return "🧹 הזיכרון אופס.";
    default:
      return null; // לא פקודה - יעבור לסוכן
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
      if (!text && !hasImage) return;
      const quick = text.startsWith("!") ? await handleCommand(text) : null;
      if (quick) return void (await sendText(selfJid, quick));
      const images = hasImage ? [await collectImage(m)].filter(Boolean) : [];
      try {
        await sock.sendPresenceUpdate("composing", selfJid);
        const reply = await runAgent("owner", selfJid, text, images, { sendText, notifyOwner, chatJid: selfJid });
        if (reply) await sendText(selfJid, reply);
      } catch (e) {
        logger.error(e);
        await sendText(selfJid, `⚠️ שגיאה: ${e.message}`);
      }
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
  if (!connected) return;
  const due = reminders.filter((r) => r.at <= Date.now());
  for (const r of due) {
    await notifyOwner(`⏰ תזכורת: ${r.text}`).catch(() => {});
    reminders.splice(reminders.indexOf(r), 1);
  }
  if (due.length) saveReminders();
}, 20_000);

// ---------- חיבור לווטסאפ ----------
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, "auth"));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.macOS("Desktop"),
    markOnlineOnConnect: false, // כדי שתמשיך לקבל התראות בטלפון
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQr = qr;
      console.log("\n📱 סרוק את הקוד: ווטסאפ > הגדרות > מכשירים מקושרים > קישור מכשיר");
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`(או פתח בדפדפן: http://localhost:${PORT})\n`);
    }
    if (connection === "open") {
      connected = true;
      retries = 0;
      latestQr = null;
      selfJid = jidNormalizedUser(sock.user.id);
      selfJids = new Set([selfJid, sock.user.lid && jidNormalizedUser(sock.user.lid)].filter(Boolean));
      console.log(`✅ מחובר כ-${selfJid}`);
      await notifyOwner(`✅ הסוכן מחובר ופועל.\nכתוב !עזרה כדי לראות מה אפשר לעשות.`).catch(() => {});
    }
    if (connection === "close") {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("🚪 התנתקת מהווטסאפ. מחק את data/auth והפעל מחדש כדי לסרוק שוב.");
        process.exit(1);
      }
      const wait = Math.min(60, 3 * 2 ** retries++);
      console.log(`🔄 החיבור נותק, מתחבר מחדש בעוד ${wait} שניות...`);
      setTimeout(connect, wait * 1000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) onMessage(m).catch((e) => logger.error(e, "onMessage"));
  });
}

// ---------- עמוד קטן להצגת QR (שימושי כשמריצים על שרת) ----------
http
  .createServer(async (req, res) => {
    const key = process.env.QR_PAGE_KEY;
    if (key && !req.url.includes(`key=${key}`)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const body = connected
      ? `<h2>✅ הסוכן מחובר לווטסאפ</h2>`
      : latestQr
        ? `<h2>סרוק עם ווטסאפ</h2><p>הגדרות › מכשירים מקושרים › קישור מכשיר</p><img src="${await QRCode.toDataURL(latestQr, { width: 320 })}"><script>setTimeout(()=>location.reload(),15000)</script>`
        : `<h2>מתחבר...</h2><script>setTimeout(()=>location.reload(),3000)</script>`;
    res.end(`<!doctype html><html dir="rtl"><meta name="viewport" content="width=device-width"><title>WhatsApp Agent</title><body style="font-family:sans-serif;text-align:center;padding:24px">${body}</body></html>`);
  })
  .listen(PORT, () => console.log(`🌐 עמוד QR: http://localhost:${PORT}`));

console.log(`🤖 סוכן ווטסאפ של ${OWNER_NAME} עולה...`);
connect();
