// בדיקת פענוח ההוראות של קיצור האייפון. זמן קבוע: יום שני 23/11/2026 14:00 שעון ישראל
process.env.TZ_NAME = "Asia/Jerusalem";
process.env.LAB_PUBLIC_URL = "https://lab.example";
const { handleShortcut } = await import("../src/shortcut.js");
const now = new Date("2026-11-23T12:00:00Z");
const cases = [
  ["פתח וואטסאפ", { action: "open_url", url: "whatsapp://" }],
  ["תפתח את הוויז", { action: "open_url", url: "waze://" }],
  ["פתח את מערכת המעבדה", { action: "open_url", url: "https://lab.example" }],
  ["תפתח את היועץ", { action: "open_url", url: "https://adv.example/chat?key=k" }],
  ["פתח מחשבון", { action: "run_shortcut", shortcut: "פתח מחשבון" }],
  ["הפעל קיצור סגירת יום", { action: "run_shortcut", shortcut: "סגירת יום", url: "shortcuts://run-shortcut?name=%D7%A1%D7%92%D7%99%D7%A8%D7%AA%20%D7%99%D7%95%D7%9D" }],
  ["תזכיר לי מחר ב-10 להתקשר למשה", { action: "reminder", title: "להתקשר למשה", due: "2026-11-24T10:00:00+02:00" }],
  ["תזכיר לי בעוד שעה לבדוק את הסוללה", { action: "reminder", title: "לבדוק את הסוללה", due: "2026-11-23T15:00:00+02:00" }],
  ["תזכיר לי שצריך להזמין מסכים", { action: "reminder", title: "צריך להזמין מסכים", due: "" }],
  ["תזכיר לי ב-5 לאסוף את הילדים", { action: "reminder", title: "לאסוף את הילדים", due: "2026-11-23T17:00:00+02:00" }],
  ["תזכיר לי ביום חמישי בבוקר לשלם לספק", { action: "reminder", title: "לשלם לספק", due: "2026-11-26T09:00:00+02:00" }],
  ["קבע פגישה עם רואה החשבון מחרתיים בשעה 11 וחצי", { action: "event", title: "פגישה עם רואה החשבון", start: "2026-11-25T11:30:00+02:00", end: "2026-11-25T12:30:00+02:00" }],
  ["תוסיף ליומן ספק מסכים ב-1/12 ב-16:00 לחצי שעה", { action: "event", title: "ספק מסכים", start: "2026-12-01T16:00:00+02:00", end: "2026-12-01T16:30:00+02:00" }],
  ["קבע פגישה", { action: "say" }],
  ["כמה מסכים של אייפון 13 יש במלאי?", { action: "say", speak: "יועץ: כמה מסכים של אייפון 13 יש במלאי" }],
];
let fail = 0;
for (const [txt, exp] of cases) {
  const got = await handleShortcut(txt, { now, origin: "https://adv.example", key: "k", ask: async (t) => "יועץ: " + t });
  const ok = Object.entries(exp).every(([k, v]) => got[k] === v);
  if (!ok) fail++;
  console.log(ok ? "✅" : "❌", txt, ok ? "" : JSON.stringify(got));
}
// שעון קיץ: 1/7 צריך +03:00
const summer = await handleShortcut("תזכיר לי מחר ב-9 בבוקר משהו", { now: new Date("2026-07-01T06:00:00Z") });
console.log(summer.due === "2026-07-02T09:00:00+03:00" ? "✅" : (fail++, "❌"), "שעון קיץ", summer.due);
console.log(fail ? `נכשלו ${fail}` : "הכל עבר");
process.exit(fail ? 1 : 0);
