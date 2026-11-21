// התראות לטלפון (Web Push): עובד באייפון כשהצ'אט נשמר במסך הבית
import fs from "node:fs";
import path from "node:path";
import * as webpush from "web-push";
import { DATA_DIR } from "./store.js";

const KEYS_FILE = path.join(DATA_DIR, "vapid.json");
const SUBS_FILE = path.join(DATA_DIR, "push-subs.json");

const keys = (() => {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch {
    const k = webpush.generateVAPIDKeys();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(k), { mode: 0o600 });
    return k;
  }
})();
webpush.setVapidDetails("mailto:yakovphone.service@gmail.com", keys.publicKey, keys.privateKey);

let subs = (() => {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch {
    return [];
  }
})();
const saveSubs = () => fs.writeFileSync(SUBS_FILE, JSON.stringify(subs), { mode: 0o600 });

export const publicKey = keys.publicKey;
export const hasSubscribers = () => subs.length > 0;

export function addSubscription(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return false;
  subs = subs.filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  saveSubs();
  return true;
}

export async function sendPush(body, url) {
  const payload = JSON.stringify({ title: "היועץ", body: body.replace(/\*/g, "").slice(0, 180), url });
  const dead = [];
  await Promise.all(
    subs.map((s) =>
      webpush.sendNotification(s, payload, { TTL: 24 * 3600 }).catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint); // המנוי בוטל
      })
    )
  );
  if (dead.length) {
    subs = subs.filter((s) => !dead.includes(s.endpoint));
    saveSubs();
  }
}
