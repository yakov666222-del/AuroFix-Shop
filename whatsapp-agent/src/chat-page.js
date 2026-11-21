// דף הצ'אט עם היועץ (נפתח מהטלפון, אפשר לשמור במסך הבית כמו אפליקציה)
export const CHAT_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="היועץ">
<meta name="theme-color" content="#1f7a5a">
<title>היועץ של YakovPhone</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>
  :root { --bg:#eef1ee; --surface:#fff; --fg:#1b2420; --muted:#62706a; --line:#d5dcd7; --accent:#1f7a5a; --accent-fg:#fff; --user:#d9f0e3; --bot:#fff; --warn:#9a5b00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1613; --surface:#17211c; --fg:#e7efe9; --muted:#93a39a; --line:#2a3832; --accent:#3fb88a; --accent-fg:#07130d; --user:#1d3a2d; --bot:#1a2520; --warn:#e0a64a; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
  .app { height: 100%; max-width: 720px; margin: 0 auto; display: flex; flex-direction: column;
         padding: env(safe-area-inset-top) max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left)); }
  header { padding: 12px 0 10px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  h1 { font-size: 1.1rem; margin: 0; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand img { border-radius: 10px; }
  .sub { color: var(--muted); font-size: .8rem; }
  #thread { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 0; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 86%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .bot { align-self: flex-start; background: var(--bot); border: 1px solid var(--line); border-top-right-radius: 4px; }
  .user { align-self: flex-end; background: var(--user); border-top-left-radius: 4px; }
  .note { align-self: center; color: var(--warn); font-size: .85rem; }
  .msg img { max-width: 180px; border-radius: 8px; display: block; margin-bottom: 4px; }
  .typing { color: var(--muted); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; padding-bottom: 8px; }
  .chips button { background: var(--surface); border: 1px solid var(--line); color: var(--fg); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: .85rem; }
  form { display: flex; gap: 6px; padding: 8px 0 calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); align-items: flex-end; }
  textarea { flex: 1; min-width: 0; resize: none; font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; max-height: 140px; }
  .btn { border: 0; border-radius: 12px; padding: 10px 14px; font: inherit; font-weight: 600; }
  .send { background: var(--accent); color: var(--accent-fg); }
  .attach { background: var(--surface); border: 1px solid var(--line); color: var(--fg); }
  .send:disabled { opacity: .5; }
  #preview { font-size: .8rem; color: var(--muted); padding-bottom: 4px; }

  /* מצב "חלק מהמערכת" (?embed=1): הצבעים, הגופן והצורות של מערכת YakovPhone */
  html.embed {
    --bg: transparent; --surface: hsl(222 30% 18%); --fg: hsl(40 30% 94%); --muted: hsl(220 15% 70%);
    --line: hsl(40 35% 30% / .55); --accent: hsl(41 62% 69%); --accent-fg: hsl(40 60% 8%);
    --user: hsl(41 62% 69%); --bot: hsl(222 30% 18%); --warn: hsl(41 80% 62%);
  }
  html.embed body { background: transparent; font-family: Heebo, "Segoe UI", system-ui, sans-serif; }
  html.embed header { display: none; }
  html.embed .app { padding: 0 14px; max-width: none; }
  html.embed #thread { padding-top: 16px; }
  html.embed .msg { border-radius: 16px; padding: 10px 14px; line-height: 1.6; }
  html.embed .bot { border-color: var(--line); border-top-right-radius: 6px; }
  html.embed .user { color: var(--accent-fg); border-top-left-radius: 6px; }
  html.embed .chips button { border-color: hsl(41 62% 69% / .45); background: transparent; border-radius: 999px; padding: 8px 14px; }
  html.embed form { border-top-color: var(--line); padding: 12px 0 14px; gap: 10px; align-items: stretch; }
  html.embed textarea { background: hsl(222 47% 8% / .6); border-color: hsl(41 62% 69% / .35); border-radius: 16px; padding: 12px 14px; min-height: 54px; }
  html.embed .send { border-radius: 16px; min-width: 56px; font-size: 0; position: relative; }
  html.embed .send::after { content: "➤"; font-size: 20px; display: inline-block; transform: scaleX(-1); }
  html.embed .attach { background: transparent; border-color: hsl(41 62% 69% / .35); border-radius: 16px; }
</style>
<script>if (/[?&]embed=1/.test(location.search)) document.documentElement.classList.add("embed");</script>
</head>
<body>
<div class="app">
  <header>
    <div class="brand"><img src="/icon.svg" alt="" width="40" height="40"><div><h1>היועץ של YakovPhone</h1><div class="sub">המלווה העסקי שלך</div></div></div>
    <button class="btn attach" id="bell" hidden>🔔 הפעל התראות</button>
  </header>
  <div id="thread" aria-live="polite"></div>
  <div class="chips" id="chips"></div>
  <div id="preview"></div>
  <form id="form">
    <label class="btn attach" for="file" title="צרף תמונה">📎</label>
    <input id="file" type="file" accept="image/*" hidden>
    <textarea id="input" rows="1" placeholder="כתוב הודעה..." aria-label="הודעה"></textarea>
    <button class="btn send" id="send" type="submit">שלח</button>
  </form>
</div>
<script>
const KEY = new URLSearchParams(location.search).get("key") || "";
const q = (p) => p + (p.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY);
const thread = document.getElementById("thread"), input = document.getElementById("input"), sendBtn = document.getElementById("send");
const chips = document.getElementById("chips"), fileIn = document.getElementById("file"), preview = document.getElementById("preview");
let image = null, busy = false;

function bubble(role, text, imgSrc) {
  const d = document.createElement("div");
  d.className = "msg " + role;
  if (imgSrc) { const i = document.createElement("img"); i.src = imgSrc; d.appendChild(i); }
  // *הדגשה* בסגנון ווטסאפ, בלי HTML מהשרת
  const parts = String(text || "").split(/(\\*[^*\\n]+\\*)/g);
  for (const p of parts) {
    if (/^\\*[^*\\n]+\\*$/.test(p)) { const b = document.createElement("b"); b.textContent = p.slice(1, -1); d.appendChild(b); }
    else d.appendChild(document.createTextNode(p));
  }
  thread.appendChild(d);
  thread.scrollTop = thread.scrollHeight;
  return d;
}

async function load() {
  try {
    const r = await fetch(q("/chat/history"));
    if (r.status === 403) { bubble("note", "אין גישה. פתח את הדף מהקישור המלא (עם key=...)."); return; }
    const { history, opening } = await r.json();
    const real = history.filter((m) => m.text && m.text !== "(התחברתי עכשיו)");
    if (!real.length) bubble("bot", opening);
    for (const m of history) {
      if (m.text === "(התחברתי עכשיו)" || m.text === "(הודעה אוטומטית)") continue;
      bubble(m.role === "user" ? "user" : "bot", m.text);
    }
    if (!real.length) showChips();
  } catch { bubble("note", "אין חיבור לשרת. נסה לרענן."); }
  pollInbox();
}

function showChips() {
  for (const s of ["אני בנקודת אפס, מאיפה מתחילים?", "מה חסר במלאי?", "מה התיקונים הפתוחים?", "איך אני מתמחר תיקון מסך?"]) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = s;
    b.onclick = () => send(s); chips.appendChild(b);
  }
}

async function pollInbox() {
  try {
    const r = await fetch(q("/chat/inbox"));
    if (r.ok) for (const it of (await r.json()).items) bubble("bot", it.text);
  } catch {}
}
setInterval(pollInbox, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollInbox(); });

fileIn.onchange = async () => {
  const f = fileIn.files[0]; if (!f) return;
  // מקטינים את התמונה כדי שתישלח מהר
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = bmp.width * scale; c.height = bmp.height * scale;
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85);
  image = { media_type: "image/jpeg", data: url.split(",")[1], url };
  preview.textContent = "📷 תמונה מצורפת (לחץ שלח)";
  fileIn.value = "";
};

async function send(text) {
  text = (text || "").trim();
  if ((!text && !image) || busy) return;
  busy = true; sendBtn.disabled = true; chips.innerHTML = "";
  const img = image; image = null; preview.textContent = "";
  bubble("user", text, img && img.url);
  const wait = bubble("bot typing", "חושב...");
  try {
    const r = await fetch(q("/chat/send"), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, image: img ? { media_type: img.media_type, data: img.data } : null }) });
    const { reply } = await r.json();
    wait.remove();
    bubble("bot", reply || "(אין תשובה, נסה לנסח שוב)");
  } catch {
    wait.remove(); bubble("note", "ההודעה לא נשלחה. בדוק אינטרנט ונסה שוב.");
  } finally { busy = false; sendBtn.disabled = false; }
}

// ---------- התראות לטלפון ----------
const bell = document.getElementById("bell");
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
async function setupPush() {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => null);
  if (!reg || !("PushManager" in window)) {
    if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) {
      bell.hidden = false; bell.textContent = "🔔 התראות";
      bell.onclick = () => bubble("note", "כדי לקבל התראות: שתף ← הוספה למסך הבית, ואז פתח את 'היועץ' מהאייקון ולחץ שוב על 🔔.");
    }
    return;
  }
  const existing = await reg.pushManager.getSubscription();
  if (existing && Notification.permission === "granted") return;
  bell.hidden = false;
  bell.onclick = async () => {
    try {
      if ((await Notification.requestPermission()) !== "granted") { bubble("note", "ההתראות לא אושרו. אפשר לאשר בהגדרות הטלפון."); return; }
      const { key } = await (await fetch(q("/chat/push-key"))).json();
      const pad = "=".repeat((4 - key.length % 4) % 4), raw = atob((key + pad).replace(/-/g, "+").replace(/_/g, "/"));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      const r = await fetch(q("/chat/subscribe"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
      if (r.ok) { bell.hidden = true; bubble("note", "✅ ההתראות הופעלו."); }
    } catch (e) { bubble("note", "לא הצלחתי להפעיל התראות: " + e.message); }
  };
}
setupPush();

document.getElementById("form").onsubmit = (e) => { e.preventDefault(); const t = input.value; input.value = ""; input.style.height = "auto"; send(t); };
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
load();
</script>
</body>
</html>`;

// מאפשר לשמור את הצ'אט במסך הבית כאפליקציה. בלי start_url: נפתח בכתובת שממנה הוסיפו (כולל המפתח)
export const MANIFEST = JSON.stringify({
  name: "היועץ - המלווה העסקי",
  short_name: "היועץ",
  display: "standalone",
  scope: "/",
  dir: "rtl",
  lang: "he",
  background_color: "#0d1311",
  theme_color: "#1f7a5a",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

// מקבל התראות מהשרת ומציג אותן
export const SW_JS = `
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: "היועץ", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "היועץ", { body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/" }, lang: "he", dir: "rtl" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow(e.notification.data.url || "/");
  }));
});
`;
