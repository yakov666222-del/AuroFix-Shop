// קריאייטיב לעסק: תמונות מודעה מעוצבות (PNG) מתבנית, עם טקסט בעברית.
// בחינם וללא בינה מלאכותית לתמונה: התבנית מצוירת בקוד (SVG) ומומרת לתמונה עם resvg.
// הטקסטים (כותרת, תת כותרת, מחיר, קריאה לפעולה) נכתבים על ידי היועצת.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);
const FONT_DIR = path.dirname(require.resolve("@expo-google-fonts/heebo/package.json"));
const FONTS = ["Heebo_400Regular.ttf", "Heebo_700Bold.ttf", "Heebo_900Black.ttf"].map((f) => path.join(FONT_DIR, f)).filter((f) => fs.existsSync(f));

export const SIZES = {
  square: [1080, 1080], // פוסט פייסבוק/אינסטגרם
  story: [1080, 1920], // סטורי, סטטוס בווטסאפ, טיקטוק
  wide: [1200, 628], // מודעה ממומנת בפייסבוק
};

// סגנונות: tech דומה לסוכני ה-AI (כהה עם זוהר ירוק), brand בצבעי YakovPhone, sale מבצע בולט, clean נקי ובהיר
export const STYLES = {
  tech: { bg1: "#05080d", bg2: "#0d1b22", accent: "#22e3a1", text: "#ffffff", sub: "#a9c4cf", ctaText: "#05080d", glow: true },
  brand: { bg1: "#0e1526", bg2: "#1a2a44", accent: "#e2c892", text: "#f3efe6", sub: "#c9c2b0", ctaText: "#0e1526", glow: false },
  sale: { bg1: "#b3001b", bg2: "#ff3b30", accent: "#ffd60a", text: "#ffffff", sub: "#ffe7e5", ctaText: "#7a0010", glow: false },
  clean: { bg1: "#ffffff", bg2: "#eef3f7", accent: "#0a84ff", text: "#0b1320", sub: "#4a5868", ctaText: "#ffffff", glow: false },
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// סימן כיוון ימין-לשמאל בלתי נראה בתחילת ובסוף שורה בעברית: מונע מנקודות, פסיקים ו-₪ "לקפוץ" לצד הלא נכון
const RLM = "\u200F";
const he = (s) => esc(RLM + String(s ?? "").replace(/([.,!?:;)])(?=\s|$)/g, "$1" + RLM) + RLM);

// שבירת שורות לפי מספר תווים משוער לרוחב נתון
function wrap(text, maxChars, maxLines) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

/**
 * מצייר מודעה. מחזיר Buffer של PNG.
 * @param {{headline:string, sub?:string, price?:string, cta?:string, badge?:string, phone?:string, brand?:string, style?:string, size?:string}} o
 */
export function renderAd(o) {
  const [W, H] = SIZES[o.size] || SIZES.square;
  const st = STYLES[o.style] || STYLES.tech;
  const pad = Math.round(W * 0.08);
  const right = W - pad;
  const scale = W / 1080;
  const tall = H / W > 1.3;

  const wide = W / H > 1.5;
  // במודעה רחבה: טקסט בעמודה הימנית, מחיר וכפתור בעמודה השמאלית
  const colRight = right;
  const colW = wide ? Math.round((W - pad * 2) * 0.58) : W - pad * 2;
  const hSize = Math.round((tall ? 96 : wide ? 58 : 84) * scale);
  const hLines = wrap(o.headline, Math.floor(colW / (hSize * 0.52)), 3);
  const sSize = Math.round((wide ? 30 : 40) * scale);
  const sLines = wrap(o.sub, Math.floor(colW / (sSize * 0.5)), wide ? 2 : 3);

  let y = Math.round(H * (tall ? 0.3 : wide ? 0.2 : 0.27));
  const parts = [];
  if (o.badge) {
    const bw = Math.round((o.badge.length * 22 + 60) * scale);
    parts.push(`<rect x="${colRight - bw}" y="${y - 70 * scale}" width="${bw}" height="${56 * scale}" rx="${28 * scale}" fill="${st.accent}"/>`);
    parts.push(`<text x="${colRight - bw / 2}" y="${y - 31 * scale}" font-family="Heebo" font-weight="700" font-size="${30 * scale}" fill="${st.ctaText}" text-anchor="middle" direction="rtl">${he(o.badge)}</text>`);
    y += Math.round(30 * scale);
  }
  for (const line of hLines) {
    y += hSize;
    parts.push(`<text x="${colRight}" y="${y}" font-family="Heebo" font-weight="900" font-size="${hSize}" fill="${st.text}" text-anchor="end" direction="rtl">${he(line)}</text>`);
    y += Math.round(hSize * 0.18);
  }
  y += Math.round(20 * scale);
  for (const line of sLines) {
    y += sSize;
    parts.push(`<text x="${colRight}" y="${y}" font-family="Heebo" font-weight="400" font-size="${sSize}" fill="${st.sub}" text-anchor="end" direction="rtl">${he(line)}</text>`);
    y += Math.round(sSize * 0.35);
  }
  const ctaH = Math.round((wide ? 84 : 96) * scale);
  if (wide) {
    // עמודה שמאלית: מחיר, כפתור וטלפון, ממורכזים
    const cx = pad + Math.round((W - pad * 2) * 0.2);
    let ly = Math.round(H * 0.42);
    if (o.price) {
      parts.push(`<text x="${cx}" y="${ly}" font-family="Heebo" font-weight="900" font-size="${92 * scale}" fill="${st.accent}" text-anchor="middle" direction="rtl">${he(o.price)}</text>`);
      ly += Math.round(50 * scale);
    }
    if (o.cta) {
      const cw = Math.min(Math.round((W - pad * 2) * 0.38), Math.round((o.cta.length * 28 + 100) * scale));
      parts.push(`<rect x="${cx - cw / 2}" y="${ly}" width="${cw}" height="${ctaH}" rx="${ctaH / 2}" fill="${st.accent}"${st.glow ? ' filter="url(#glow)"' : ""}/>`);
      parts.push(`<text x="${cx}" y="${ly + ctaH * 0.64}" font-family="Heebo" font-weight="700" font-size="${38 * scale}" fill="${st.ctaText}" text-anchor="middle" direction="rtl">${he(o.cta)}</text>`);
      ly += ctaH;
    }
    if (o.phone) parts.push(`<text x="${cx}" y="${ly + 64 * scale}" font-family="Heebo" font-weight="700" font-size="${38 * scale}" fill="${st.text}" text-anchor="middle" direction="ltr">${esc(o.phone)}</text>`);
  } else {
    if (o.price) {
      y += Math.round(70 * scale);
      parts.push(`<text x="${right}" y="${y + 40 * scale}" font-family="Heebo" font-weight="900" font-size="${110 * scale}" fill="${st.accent}" text-anchor="end" direction="rtl">${he(o.price)}</text>`);
      y += Math.round(60 * scale);
    }
    // כפתור קריאה לפעולה + טלפון בתחתית
    const ctaY = H - pad - ctaH - (o.phone ? 70 * scale : 0);
    if (o.cta) {
      const cw = Math.min(W - pad * 2, Math.round((o.cta.length * 30 + 120) * scale));
      parts.push(`<rect x="${right - cw}" y="${ctaY}" width="${cw}" height="${ctaH}" rx="${ctaH / 2}" fill="${st.accent}"${st.glow ? ' filter="url(#glow)"' : ""}/>`);
      parts.push(`<text x="${right - cw / 2}" y="${ctaY + ctaH * 0.64}" font-family="Heebo" font-weight="700" font-size="${42 * scale}" fill="${st.ctaText}" text-anchor="middle" direction="rtl">${he(o.cta)}</text>`);
    }
    if (o.phone) {
      parts.push(`<text x="${right}" y="${H - pad}" font-family="Heebo" font-weight="700" font-size="${40 * scale}" fill="${st.text}" text-anchor="end" direction="ltr">${esc(o.phone)}</text>`);
    }
  }
  const brand = o.brand || "YakovPhone";
  parts.push(`<text x="${pad}" y="${pad + 30 * scale}" font-family="Heebo" font-weight="900" font-size="${36 * scale}" fill="${st.accent}" text-anchor="start" direction="ltr">${esc(brand)}</text>`);

  // רקע: מעבר צבע, ובסגנון tech גם גלי אור ירוקים כמו בסוכני ה-AI
  const deco = st.glow
    ? `<path d="M0 ${H * 0.78} C ${W * 0.3} ${H * 0.62}, ${W * 0.6} ${H * 0.95}, ${W} ${H * 0.7}" stroke="${st.accent}" stroke-width="${4 * scale}" fill="none" opacity="0.55" filter="url(#glow)"/>
       <path d="M0 ${H * 0.84} C ${W * 0.35} ${H * 0.7}, ${W * 0.65} ${H}, ${W} ${H * 0.78}" stroke="${st.accent}" stroke-width="${2 * scale}" fill="none" opacity="0.35"/>
       <circle cx="${W * 0.12}" cy="${H * 0.18}" r="${W * 0.32}" fill="${st.accent}" opacity="0.07"/>`
    : `<circle cx="${W * 0.08}" cy="${H * 0.9}" r="${W * 0.38}" fill="${st.accent}" opacity="0.12"/>
       <circle cx="${W * 0.95}" cy="${H * 0.05}" r="${W * 0.22}" fill="${st.accent}" opacity="0.1"/>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${st.bg1}"/><stop offset="1" stop-color="${st.bg2}"/></linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${8 * scale}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${deco}
  ${parts.join("\n  ")}
</svg>`;
  const r = new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Heebo" }, fitTo: { mode: "width", value: W } });
  return r.render().asPng();
}

export const __test = { wrap };
