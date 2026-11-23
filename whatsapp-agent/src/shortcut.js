// פענוח הוראות בעברית מקיצור Apple Shortcuts ("עוזר יעקב") לפעולה שהאייפון מבצע.
// הקיצור שולח טקסט, ומקבל JSON: { action, speak, ... }. פעולות:
//   open_url     { url }                      פתיחת אפליקציה (URL scheme) או מערכת
//   reminder     { title, due? }              תזכורת באפליקציית התזכורות
//   event        { title, start, end }        אירוע ביומן
//   run_shortcut { shortcut, url }             הפעלת קיצור קיים לפי שם (url = shortcuts://run-shortcut)
//   say          { }                          רק תשובה (מהיועץ)
// אין כאן פעולות רגישות: לא מחיקה, לא תשלום ולא שליחת הודעות. שאלות אחרות עוברות ליועץ.

const TZ = () => process.env.TZ_NAME || "Asia/Jerusalem";

// ---------- אפליקציות ----------
const APPS = [
  [["וואטסאפ", "ווטסאפ", "ווצאפ", "וטסאפ", "whatsapp"], "whatsapp://"],
  [["וויז", "ווייז", "waze"], "waze://"],
  [["מפות", "מפה", "maps"], "maps://"],
  [["טלפון", "חייגן", "phone"], "tel://"],
  [["הודעות", "מסרונים", "sms"], "sms://"],
  [["מייל", "דואר", "mail"], "message://"],
  [["ג'ימייל", "גימייל", "gmail"], "googlegmail://"],
  [["יומן", "לוח שנה", "calendar"], "calshow://"],
  [["תזכורות", "reminders"], "x-apple-reminderkit://"],
  [["פתקים", "notes"], "mobilenotes://"],
  [["תמונות", "גלריה", "photos"], "photos-redirect://"],
  [["שעון", "שעון מעורר", "מעורר", "clock"], "clock-alarm://"],
  [["מוזיקה", "music"], "music://"],
  [["ספוטיפיי", "spotify"], "spotify://"],
  [["יוטיוב", "youtube"], "youtube://"],
  [["אינסטגרם", "instagram"], "instagram://"],
  [["פייסבוק", "facebook"], "fb://"],
  [["טלגרם", "telegram"], "tg://"],
  [["כרום", "chrome"], "googlechrome://"],
  [["ספארי", "safari", "דפדפן"], "x-web-search://"],
  [["אפ סטור", "אפסטור", "app store"], "itms-apps://"],
  [["הגדרות", "settings"], "app-settings:"],
  [["קיצורים", "shortcuts"], "shortcuts://"],
  [["קבצים", "files"], "shareddocuments://"],
  [["נושן", "notion"], "notion://"],
];

// מערכות YakovPhone: כתובות מההגדרות של השרת
function systemUrl(name, origin, key) {
  if (/מעבדה|תיקונים|מלאי|אורופיקס|aurofix|מערכת|יעקבפון|yakovphone/i.test(name)) {
    const u = process.env.LAB_PUBLIC_URL || process.env.LAB_WAKE_URL || "";
    return u || null;
  }
  if (/יועץ|צ'אט|צאט/.test(name)) return origin ? `${origin}/chat?key=${encodeURIComponent(key || "")}` : null;
  return null;
}

// כל פעולה שיש לה url מבוצעת בקיצור ב"פתח כתובות URL" אחד
const runUrl = (name) => `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;

const strip = (s) =>
  String(s ?? "")
    .replace(/[֑-ׇ]/g, "") // ניקוד
    .replace(/[״"“”]/g, "")
    .replace(/[׳`’]/g, "'")
    .replace(/[.!?,؟]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const dropHe = (s) => s.replace(/^(את\s+)?/, "").replace(/^ה(?=\S{3,})/, "");

function findApp(name) {
  const n = name.toLowerCase().trim();
  for (const [aliases, url] of APPS) {
    for (const a of aliases) {
      if (n === a || n === "ה" + a || n.startsWith(a + " ") || n.startsWith("ה" + a + " ")) return url;
    }
  }
  return null;
}

// ---------- תאריכים ושעות (לפי שעון ישראל) ----------
const WEEKDAYS = { ראשון: 0, שני: 1, שלישי: 2, רביעי: 3, חמישי: 4, שישי: 5, שבת: 6 };
const HOUR_WORDS = {
  אחת: 1, שתיים: 2, שתים: 2, שלוש: 3, ארבע: 4, חמש: 5, שש: 6, שבע: 7, שמונה: 8, תשע: 9, עשר: 10,
  "אחת עשרה": 11, "שתים עשרה": 12, "שתיים עשרה": 12,
};

function wallNow(now, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd };
}

// שעון קיר בישראל -> מחרוזת ISO עם ההפרש הנכון (שעון חורף/קיץ)
function toIso({ y, m, d, h, min }, tz) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  const off = (date) => {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(date).find((x) => x.type === "timeZoneName").value;
    const mm = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    return mm ? (mm[1] === "-" ? -1 : 1) * (+mm[2] * 60 + +(mm[3] || 0)) : 0;
  };
  let o = off(guess);
  o = off(new Date(guess.getTime() - o * 60000));
  const pad = (n) => String(n).padStart(2, "0");
  const sign = o < 0 ? "-" : "+";
  const a = Math.abs(o);
  const n = new Date(Date.UTC(y, m - 1, d, h, min)); // מנרמל גלישה של יום/חודש
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}T${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const addDays = (w, n) => {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
};

// מחזיר { when: {y,m,d,h,min} | null, rest: הטקסט בלי ביטויי הזמן }
export function parseWhen(text, now = new Date(), tz = TZ()) {
  const base = wallNow(now, tz);
  let rest = ` ${text} `;
  let day = null; // {y,m,d}
  let time = null; // {h,min}
  const cut = (re) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(m[0], " ");
    return m;
  };

  // "בעוד ..." - זמן יחסי
  const units = { דקה: 1, דקות: 1, שעה: 60, שעות: 60, יום: 1440, ימים: 1440 };
  let m = cut(/\s(?:ב)?עוד\s+(חצי שעה|רבע שעה|שעתיים|יומיים|שעה|דקה|יום|(\d+)\s*(דקות|דקה|שעות|שעה|ימים|יום))(?=\s)/);
  if (m) {
    const mins = m[2] ? +m[2] * units[m[3]] : { "חצי שעה": 30, "רבע שעה": 15, שעתיים: 120, יומיים: 2880, שעה: 60, דקה: 1, יום: 1440 }[m[1]];
    const t = new Date(Date.UTC(base.y, base.m - 1, base.d, base.h, base.min + mins));
    return { when: { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes() }, rest: rest.replace(/\s+/g, " ").trim() };
  }

  if (cut(/\s(?:ה)?מחרתיים(?=\s)/)) day = addDays(base, 2);
  else if (cut(/\s(?:ל|ב)?מחר(?=\s)/)) day = addDays(base, 1);
  else if (cut(/\s(?:ל|ב)?היום(?=\s)/)) day = base;
  else if ((m = cut(/\s(?:ב|ל)(?:יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?:\s+הבא)?(?=\s)/))) {
    let diff = (WEEKDAYS[m[1]] - base.wd + 7) % 7;
    if (diff === 0) diff = 7;
    day = addDays(base, diff);
  } else if ((m = cut(/\s(?:ב|ל)?-?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s)/))) {
    let y = m[3] ? +m[3] : base.y;
    if (y < 100) y += 2000;
    day = { y, m: +m[2], d: +m[1] };
    if (!m[3] && (day.m < base.m || (day.m === base.m && day.d < base.d))) day.y += 1;
  }

  m = cut(/\s(?:ב|בשעה|בסביבות|ב-)\s*-?(\d{1,2})(?::(\d{2}))?(?:\s+ו?(חצי|רבע))?(?=\s)/) ||
    cut(new RegExp(`\\s(?:בשעה|ב)\\s*(${Object.keys(HOUR_WORDS).sort((a, b) => b.length - a.length).join("|")})(?:\\s+ו?(חצי|רבע))?(?=\\s)`));
  if (m) {
    const h = /^\d/.test(m[1]) ? +m[1] : HOUR_WORDS[m[1]];
    const extra = m[m.length - 1];
    const minPart = /^\d/.test(m[1]) && m[2] ? +m[2] : extra === "חצי" ? 30 : extra === "רבע" ? 15 : 0;
    if (h <= 23 && minPart <= 59) time = { h, min: minPart };
  }
  const pm = cut(/\s(?:אחר הצהריים|אחרי הצהריים|אחה"צ|אחהצ|בערב|בלילה)(?=\s)/);
  const am = cut(/\s(?:בבוקר)(?=\s)/);
  if (time && pm && time.h < 12) time.h += 12;
  if (!time && pm) time = { h: 18, min: 0 };
  if (!time && am) time = { h: 9, min: 0 };
  if (time && !pm && !am && !day && time.h >= 1 && time.h <= 7) time.h += 12; // "ב-5" בלי הקשר = 17:00
  if (am && time && time.h === 12) time.h = 0;

  if (!day && !time) return { when: null, rest: rest.replace(/\s+/g, " ").trim() };
  if (!day) {
    day = base;
    if (time.h * 60 + time.min <= base.h * 60 + base.min) day = addDays(base, 1); // השעה כבר עברה: מחר
  }
  if (!time) time = { h: 9, min: 0 };
  return { when: { y: day.y, m: day.m, d: day.d, ...time }, rest: rest.replace(/\s+/g, " ").trim() };
}

const cleanTitle = (s) =>
  strip(s)
    .replace(/^(?:לי\s+)?(?:ש(?=\S{3,}))?/, "")
    .trim();

const fmt = (iso) => {
  const [, mo, d, h, mi] = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return `${+d}/${+mo} בשעה ${h}:${mi}`;
};

// ---------- הפענוח הראשי ----------
// ask(text) נקרא רק אם ההוראה לא מוכרת (שאלה ליועץ). מחזיר מחרוזת תשובה.
export async function handleShortcut(rawText, { origin = "", key = "", now = new Date(), ask } = {}) {
  const text = strip(rawText);
  if (!text) return { action: "say", speak: "לא שמעתי הוראה. נסה שוב." };
  const tz = TZ();

  // הפעלת קיצור / אוטומציה לפי שם
  let m = text.match(/^(?:תפעיל|הפעל|תפעילי|הפעילי|תריץ|הרץ|תריצי)\s+(?:את\s+)?(?:ה)?(?:קיצור|אוטומציה)\s+(.+)$/);
  if (m) {
    const name = strip(m[1].replace(/^(?:בשם|של)\s+/, ""));
    return { action: "run_shortcut", shortcut: name, url: runUrl(name), speak: `מפעיל את "${name}"` };
  }

  // פתיחת אפליקציה או מערכת
  m = text.match(/^(?:תפתח|פתח|תפתחי|פתחי|תיכנס|תכנס|כנס|היכנס)\s+(?:ל|את\s+|אל\s+)?(.+)$/);
  if (m) {
    const target = dropHe(strip(m[1])).replace(/^(?:אפליקציית|אפליקציה|האפליקציה)\s+/, "");
    const sys = systemUrl(target, origin, key);
    if (sys) return { action: "open_url", url: sys, speak: `פותח את ${target}` };
    if (/מעבדה|תיקונים|מלאי|יועץ/.test(target))
      return { action: "say", speak: "הכתובת של המערכת עוד לא מוגדרת בשרת (LAB_PUBLIC_URL)." };
    const url = findApp(target);
    if (url) return { action: "open_url", url, speak: `פותח את ${target}` };
    // אפליקציה בלי קישור ידוע: מפעילים קיצור קטן בשם "פתח <שם>" שהבעלים יוצר פעם אחת
    return { action: "run_shortcut", shortcut: `פתח ${target}`, url: runUrl(`פתח ${target}`), speak: `פותח את ${target}` };
  }

  // תזכורת
  m = text.match(/^(?:תזכיר|תזכירי|הזכר|תזכורת|צור תזכורת|תוסיף תזכורת|תוסיפי תזכורת)\s*(?:לי)?\s*(.*)$/);
  if (m && m[1]) {
    const { when, rest } = parseWhen(m[1], now, tz);
    const title = cleanTitle(rest) || "תזכורת";
    const due = when ? toIso(when, tz) : "";
    return { action: "reminder", title, due, speak: due ? `קבעתי תזכורת: ${title}, ב-${fmt(due)}` : `הוספתי תזכורת: ${title}` };
  }

  // אירוע ביומן
  m = text.match(/^(?:תקבע|קבע|תקבעי|קבעי|תוסיף ליומן|הוסף ליומן|תוסיפי ליומן|תכניס ליומן|תרשום ביומן|רשום ביומן)\s*(?:לי)?\s*(.*)$/);
  if (m && m[1]) {
    const { when, rest } = parseWhen(m[1], now, tz);
    if (!when) return { action: "say", speak: "לא הבנתי מתי. נסה למשל: קבע פגישה עם רואה החשבון מחר ב-10." };
    const title = cleanTitle(rest).replace(/\s*(?:ל|למשך\s+)(?:חצי שעה|שעתיים|שעה|\d+\s*דקות)$/, "") || "פגישה";
    const durM = text.match(/(?:ל|למשך\s+)(חצי שעה|שעתיים|שעה|(\d+)\s*דקות)/);
    const mins = durM ? (durM[2] ? +durM[2] : { "חצי שעה": 30, שעתיים: 120, שעה: 60 }[durM[1]]) : 60;
    const start = toIso(when, tz);
    const e = new Date(Date.UTC(when.y, when.m - 1, when.d, when.h, when.min + mins));
    const end = toIso({ y: e.getUTCFullYear(), m: e.getUTCMonth() + 1, d: e.getUTCDate(), h: e.getUTCHours(), min: e.getUTCMinutes() }, tz);
    return { action: "event", title, start, end, speak: `קבעתי ביומן: ${title}, ב-${fmt(start)}` };
  }

  // כל השאר: שאלה ליועץ (תיקונים, מלאי, עסק, וכל שאלה אחרת)
  const reply = ask ? await ask(text) : "";
  return { action: "say", speak: String(reply || "אין תשובה כרגע.").slice(0, 3000) };
}
