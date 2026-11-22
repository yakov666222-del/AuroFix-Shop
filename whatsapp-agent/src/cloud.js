// חיבור לווטסאפ הרשמי: ישירות דרך Meta (WhatsApp Cloud API) או דרך Kapso (שמתווכת מול Meta).
// ליועץ יש מספר ווטסאפ משלו, והבעלים כותב לו כמו לכל איש קשר.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./store.js";

const META_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v23.0"}`;
const KAPSO_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";
const FILE = path.join(DATA_DIR, "meta.json");

// { provider: "meta"|"kapso", token, phoneNumberId, ownerPhone, appSecret, verifyToken }
// ב-Kapso: token = מפתח ה-API של Kapso, appSecret = ה-webhook secret
export const cfg = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
})();
if (!cfg.verifyToken) {
  cfg.verifyToken = crypto.randomBytes(12).toString("hex");
  saveCfg();
}
export function saveCfg() {
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
export const cloudEnabled = () => Boolean(cfg.token && cfg.phoneNumberId && cfg.ownerPhone);

export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "972" + d.slice(1);
  return d;
}

export const isKapso = () => cfg.provider === "kapso";
const base = () => process.env.GRAPH_BASE || (isKapso() ? KAPSO_BASE : META_BASE);
const authHeaders = () => (isKapso() ? { "X-API-Key": cfg.token } : { Authorization: `Bearer ${cfg.token}` });

async function graph(pathname, opts = {}) {
  const res = await fetch(`${base()}/${pathname}`, {
    ...opts,
    headers: { ...authHeaders(), "Content-Type": "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error || {};
    const err = new Error(e.message || `שגיאה ${res.status} מווטסאפ`);
    err.code = e.code;
    throw err;
  }
  return data;
}

// שליחת טקסט (מפצלים הודעות ארוכות, המגבלה היא 4096 תווים)
export async function cloudSend(toPhone, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const body of chunks) {
    try {
      await graph(`${cfg.phoneNumberId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messaging_product: "whatsapp", to: normPhone(toPhone), type: "text", text: { body } }),
      });
    } catch (e) {
      // 131047: עברו 24 שעות מאז שהנמען כתב, ווטסאפ לא מאפשר להתחיל שיחה בלי תבנית מאושרת
      if (e.code === 131047) {
        const err = new Error("ווטסאפ לא מאפשר לשלוח לו הודעה כי הוא לא כתב למספר של היועץ ב-24 השעות האחרונות.");
        err.windowClosed = true;
        throw err;
      }
      throw e;
    }
  }
}

// התראה דרך תבנית מאושרת: עובדת גם כשעברו 24 שעות מההודעה האחרונה של הבעלים.
// בפרמטר של תבנית אסור ירידת שורה או רצף של רווחים, אז מכווצים את הטקסט.
export const ALERT_TEMPLATE = process.env.ALERT_TEMPLATE || "advisor_alert";
export async function cloudSendTemplate(toPhone, text) {
  let param = String(text)
    .replace(/\*/g, "")
    .replace(/\s*\n+\s*/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (param.length > 900) param = param.slice(0, 897) + "...";
  await graph(`${cfg.phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normPhone(toPhone),
      type: "template",
      template: { name: ALERT_TEMPLATE, language: { code: "he" }, components: [{ type: "body", parameters: [{ type: "text", text: param }] }] },
    }),
  });
}

export async function markRead(messageId) {
  await graph(`${cfg.phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => {});
}

export async function downloadImage(mediaId, directUrl) {
  let url = directUrl;
  let mime = "image/jpeg";
  if (!url) {
    const meta = await graph(mediaId);
    url = meta.url;
    mime = meta.mime_type || mime;
  }
  const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  mime = res.headers.get("content-type")?.split(";")[0] || mime;
  const meta = { mime_type: mime };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4.5 * 1024 * 1024) return null;
  const type = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(meta.mime_type) ? meta.mime_type : "image/jpeg";
  return { media_type: type, data: buf.toString("base64") };
}

// אימות שההודעה באמת הגיעה מ-Meta (אם הוגדר App Secret)
export function validSignature(rawBody, headers) {
  if (!cfg.appSecret) return true;
  const expected = crypto.createHmac("sha256", cfg.appSecret).update(rawBody).digest("hex");
  let got;
  if (isKapso()) {
    got = String(headers["x-webhook-signature"] || "");
  } else {
    const header = String(headers["x-hub-signature-256"] || "");
    if (!header.startsWith("sha256=")) return false;
    got = header.slice(7);
  }
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// מחלץ את ההודעות מגוף ה-webhook
export function extractMessages(body) {
  if (isKapso()) return extractKapso(body);
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== cfg.phoneNumberId) continue;
      for (const m of v.messages ?? []) out.push(m);
    }
  }
  return out;
}

// Kapso שולחת פורמט משלה (v2). ממירים לצורה של Meta כדי שאותו קוד יטפל בשניהם
function extractKapso(body) {
  const items = body?.batch && Array.isArray(body.data) ? body.data : [body];
  const out = [];
  for (const it of items) {
    const m = it?.message;
    if (!m || m.kapso?.direction === "outbound") continue;
    if (it.phone_number_id && cfg.phoneNumberId && String(it.phone_number_id) !== String(cfg.phoneNumberId)) continue;
    const from = m.from || it.conversation?.phone_number || "";
    const msg = { id: m.id, from, timestamp: m.timestamp, type: m.type };
    if (m.type === "text") msg.text = { body: m.text?.body || m.kapso?.content || "" };
    if (m.type === "image") msg.image = { id: m.image?.id, caption: m.image?.caption || "", url: m.kapso?.media_url };
    if (m.type === "audio") msg.audio = {};
    out.push(msg);
  }
  return out;
}
