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
import { OPENING, getApiKey, runAgent } from "./agent.js";
import * as lab from "./lab.js";
import { DATA_DIR, appendHistory, chats, clearHistory, convo, logMessage, memory, reminders, saveReminders, saveSettings, settings } from "./store.js";
import { findChat, pendingChanges, phoneToJid } from "./tools.js";

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
let latestQr = null;
let pairingCode = null;
let pairPhone = null; // מספר שביקשו עבורו קוד חיבור
let pairingSock = null; // החיבור שיצר את הקוד (קוד תקף רק בחיבור שיצר אותו)
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
      clearHistory(selfJid);
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
    reply = "בוטל, לא שיניתי כלום במלאי.";
  } else {
    const lines = [];
    for (const c of changes) {
      try {
        const r = await lab.adjustInventory(c.id, c.delta, c.reason);
        lines.push(`✅ ${c.name}: ${c.delta > 0 ? "+" : ""}${c.delta}, עכשיו במלאי ${r.qty}`);
      } catch (e) {
        lines.push(`⚠️ ${c.name}: לא הצלחתי לעדכן (${e.message})`);
      }
    }
    reply = `עודכן במלאי:\n${lines.join("\n")}`;
  }
  appendHistory(selfJid, text, reply, 120); // כדי שהמלווה יידע מה קרה
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
    "[הודעה אוטומטית, לא מהבעלים] תכין לי סיכום פתיחת שבוע קצר: מה חסר במלאי, תיקונים פתוחים, מצב המחזור השנתי מול התקרה, ותזכורות או מועדי דיווח שמתקרבים. בסוף, צעד אחד שכדאי לעשות השבוע.";
  try {
    const reply = await runAgent("owner", selfJid, prompt, [], { sendText, notifyOwner, chatJid: selfJid });
    if (reply) await sendText(selfJid, `☀️ *סיכום שבועי*\n${reply}`);
  } catch (e) {
    logger.error(e, "weekly summary failed");
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
      if (isAudio && !text) {
        return void (await sendText(selfJid, "🎤 עדיין אין לי אפשרות לשמוע הודעות קוליות. אפשר להקליד, או להשתמש בהכתבה של המקלדת (המיקרופון במקלדת)."));
      }
      if (!text && !hasImage) return;
      const confirm = pendingChanges.length ? await handleConfirmation(text) : null;
      if (confirm) return void (await sendText(selfJid, confirm));
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
  maybeWeeklySummary();
}, 20_000);

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

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
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
      retries = 0;
      latestQr = null;
      pairingCode = null;
      pairPhone = null;
      selfJid = jidNormalizedUser(sock.user.id);
      selfJids = new Set([selfJid, sock.user.lid && jidNormalizedUser(sock.user.lid)].filter(Boolean));
      console.log(`✅ מחובר כ-${selfJid}`);
      if (!convo[selfJid]?.length) {
        await notifyOwner(`✅ מחובר!\n\n${OPENING}`).catch(() => {});
        appendHistory(selfJid, "(התחברתי עכשיו)", OPENING, 120);
      } else {
        await notifyOwner("✅ חזרתי לפעול. אפשר להמשיך מאיפה שעצרנו.").catch(() => {});
      }
    }
    if (connection === "close") {
      connected = false;
      pairingCode = null; // הקוד הישן כבר לא תקף. בחיבור הבא ייווצר חדש
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
    const secret = process.env.QR_PAGE_KEY;
    const url = new URL(req.url, "http://x");
    if (secret && url.searchParams.get("key") !== secret) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("אין גישה");
    }
    const self = `?key=${encodeURIComponent(secret || "")}`;
    const back = (msg) => {
      res.writeHead(303, { Location: `/${self}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}` });
      res.end();
    };

    if (req.method === "POST" && url.pathname === "/apikey") {
      const k = (await readBody(req)).get("apikey")?.trim() || "";
      if (k.startsWith("sk-ant-")) fs.writeFileSync(path.join(DATA_DIR, "anthropic_key"), k, { mode: 0o600 });
      // מפתחות של גוגל מתחילים ב-AIza (פורמט ישן) או ב-AQ. (פורמט חדש)
      else if (/^[A-Za-z0-9._\-]{30,}$/.test(k)) fs.writeFileSync(path.join(DATA_DIR, "gemini_key"), k, { mode: 0o600 });
      else return back("זה לא נראה כמו מפתח. ודא שהעתקת את כולו, בלי רווחים (לחץ Copy key)");
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

    // שלב 2: חיבור לווטסאפ
    if (connected) {
      body += `<div class="card"><h2>✅ הכל מחובר!</h2><p>פתח בווטסאפ את הצ'אט עם <b>עצמך</b> (חפש את השם שלך, או "אני (הודעה לעצמי)") וכתוב שם כל שאלה.</p></div>`;
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

console.log(`🤖 סוכן ווטסאפ של ${OWNER_NAME} עולה...`);
connect();
