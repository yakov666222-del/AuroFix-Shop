// חיבור לווטסאפ הרשמי של Meta (WhatsApp Cloud API).
// ליועץ יש מספר ווטסאפ משלו, והבעלים כותב לו כמו לכל איש קשר.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./store.js";

const GRAPH = process.env.GRAPH_BASE || `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v23.0"}`;
const FILE = path.join(DATA_DIR, "meta.json");

// { token, phoneNumberId, ownerPhone, appSecret, verifyToken }
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

async function graph(pathname, opts = {}) {
  const res = await fetch(`${GRAPH}/${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
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
      if (e.code === 131047) throw new Error("ווטסאפ לא מאפשר לשלוח לו הודעה כי הוא לא כתב למספר של היועץ ב-24 השעות האחרונות.");
      throw e;
    }
  }
}

export async function markRead(messageId) {
  await graph(`${cfg.phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => {});
}

export async function downloadImage(mediaId) {
  const meta = await graph(mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30000) });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4.5 * 1024 * 1024) return null;
  const type = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(meta.mime_type) ? meta.mime_type : "image/jpeg";
  return { media_type: type, data: buf.toString("base64") };
}

// אימות שההודעה באמת הגיעה מ-Meta (אם הוגדר App Secret)
export function validSignature(rawBody, header) {
  if (!cfg.appSecret) return true;
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", cfg.appSecret).update(rawBody).digest("hex");
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// מחלץ את ההודעות מגוף ה-webhook
export function extractMessages(body) {
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
