// סרטונים שיווקיים לעסק (MP4) בלי תשלום: כל סצנה היא שקופית מעוצבת עם תנועה,
// טקסט שנכנס באנימציה, קריינות בעברית (קול אישה או גבר), מוזיקת רקע שנוצרת בקוד ומעברים בין סצנות.
// הרקע יכול להיות גרפי, תמונות שהבעלים שלח, או סרטון שהבעלים צילם (למשל הוא עצמו במעבדה).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { renderAd, renderCinematic } from "./creative.js";
import { narrationWav } from "./voice.js";
import { DATA_DIR } from "./store.js";

export const VIDEO_SIZES = { story: [720, 1280], square: [720, 720], wide: [1280, 720] };
export const MUSIC = ["none", "calm", "energetic"];
const FPS = 30;
const T = 0.45; // משך המעבר בין סצנות
const TRANSITIONS = ["smoothup", "slideleft", "circleopen", "fade", "wipeleft", "fadeblack"];

function ffmpeg(args, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("יצירת הסרטון לקחה יותר מדי זמן")); }, timeoutMs);
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg נכשל: ${err.slice(-400)}`));
    });
  });
}

// מוזיקת רקע שנוצרת מנוסחה (בלי זכויות יוצרים): calm = אקורדים רכים, energetic = אקורדים עם תוף בקצב 120
function musicExpr(kind) {
  const chords = [
    [220, 261.63, 329.63], // Am
    [174.61, 220, 261.63], // F
    [196, 261.63, 329.63], // C
    [196, 246.94, 293.66], // G
  ];
  const pick = (n) => `if(lt(mod(t,16),4),${chords[0][n]},if(lt(mod(t,16),8),${chords[1][n]},if(lt(mod(t,16),12),${chords[2][n]},${chords[3][n]})))`;
  const env = "min(1,mod(t,4)*4)*min(1,(4-mod(t,4))*4)";
  const pad = `${env}*(${[0, 1, 2].map((n) => `sin(2*PI*${pick(n)}*t)`).join("+")})`;
  if (kind === "calm") return `0.13*${pad}*(0.75+0.25*sin(2*PI*0.25*t))`;
  const m = "mod(t,0.5)";
  const kick = `0.55*sin(2*PI*(45*${m}+3.6*(1-exp(-25*${m}))))*exp(-9*${m})`;
  const hat = "0.05*(2*random(0)-1)*exp(-70*mod(t+0.25,0.5))";
  return `0.035*${pad}+${kick}+${hat}`;
}

// ---------- תמונות AI לסצנות (בחינם, שירות Pollinations, בלי מפתח) ----------
// סגנון קבוע: צילום ריאליסטי וקולנועי. אותו seed לכל הסצנות, כדי שהדמות והמראה יהיו עקביים ככל האפשר
const AI_LOOK = ", photorealistic commercial photography, cinematic lighting, shallow depth of field, 35mm, high detail, no text, no letters, no watermark";
// השירות החינמי מרשה תמונה אחת כל 45 שניות לכל שרת. לכן התמונות נוצרות אחת אחרי השנייה, עם המתנה ביניהן
let lastAiAt = 0;
const AI_GAP_MS = 46_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchAiImage(prompt, w, h, seed, file) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + AI_LOOK)}?width=${w}&height=${h}&nologo=true&model=flux&seed=${seed}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const gap = lastAiAt + AI_GAP_MS - Date.now();
    if (gap > 0) await wait(gap);
    lastAiAt = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      const type = r.headers.get("content-type") || "";
      if (r.ok && type.startsWith("image/")) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 5000) {
          fs.writeFileSync(file, buf);
          return file;
        }
      }
      // הגענו למגבלה: מחכים כמה שהשירות ביקש
      const retry = Number(r.headers.get("retry-after")) || 45;
      if (r.status === 402 || r.status === 429) lastAiAt = Date.now() + retry * 1000 - AI_GAP_MS + 1000;
    } catch {}
  }
  return null;
}
export const AI_MAX_IMAGES = 5;
// כמה זמן בערך ייקח ליצור את התמונות (בדקות), כדי להגיד לבעלים מראש
export const aiMinutes = (scenes) => Math.ceil((Math.min(AI_MAX_IMAGES, scenes.filter((s) => s.image_prompt).length) * AI_GAP_MS) / 60_000 + 0.5);
async function generateAiImages(scenes, W, H, tmp) {
  const seed = Math.floor(Math.random() * 1e6);
  const out = new Array(scenes.length).fill(null);
  const h = Math.round(H * 1.08); // קצת יותר גבוה, כי חותכים את התחתית (סימן המים)
  let made = 0;
  for (let i = 0; i < scenes.length; i++) {
    const prompt = scenes[i].image_prompt || "";
    if (!prompt || made >= AI_MAX_IMAGES) continue;
    out[i] = await fetchAiImage(prompt, W, h, seed, path.join(tmp, `ai${i}.jpg`));
    if (out[i]) made++;
    else console.log(`⚠️ תמונת AI לסצנה ${i + 1} לא נוצרה, משתמשים ברקע גרפי`);
  }
  // סצנות שלא קיבלו תמונה משלהן (מעל המכסה) משתמשות בתמונה של הסצנה הקודמת שיש לה
  for (let i = 0; i < scenes.length; i++) if (!out[i] && scenes[i].image_prompt) out[i] = out.slice(0, i).reverse().find(Boolean) || null;
  return out;
}

/**
 * יוצר סרטון. מחזיר { mp4: Buffer, seconds }
 * @param {{scenes:{headline:string, sub?:string, price?:string, cta?:string, badge?:string, voice_text?:string, seconds?:number}[],
 *   style?:string, size?:string, voice?:"female"|"male"|"none", music?:string, background?:"graphic"|"photo"|"clip",
 *   photos?:string[], clip?:string, phone?:string, brand?:string}} o
 */
export async function makeVideo(o) {
  const scenes = (o.scenes || []).filter((s) => String(s?.headline || "").trim()).slice(0, 8);
  if (!scenes.length) throw new Error("אין סצנות לסרטון");
  const [W, H] = VIDEO_SIZES[o.size] || VIDEO_SIZES.story;
  const bgMode = o.background || "graphic";
  if (bgMode === "photo" && !o.photos?.length) throw new Error("אין תמונות לרקע");
  if (bgMode === "clip" && !o.clip) throw new Error("אין סרטון לרקע");
  // קולנועי: תמונה מלאה עם כתוביות למטה וכרטיס סיום עם לוגו. גרפי: העיצוב הרגיל
  const cinematic = bgMode !== "graphic";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ad-video-"));
  try {
    // 1. קריינות ותמונות AI במקביל: הקריינות קובעת את האורך של כל סצנה
    const durs = [];
    const aiJobs = bgMode === "ai" ? generateAiImages(scenes, W, H, tmp) : Promise.resolve([]);
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      let wav = null;
      if (o.voice && o.voice !== "none") {
        const say = s.voice_text || [s.headline, s.sub].filter(Boolean).join(". ");
        wav = await narrationWav(say, o.voice).catch((e) => (console.log(`⚠️ קריינות לסצנה ${i + 1} נכשלה: ${e.message}`), null));
      }
      const spoken = wav ? (wav.length - 44) / 96000 : 0;
      if (wav) fs.writeFileSync(path.join(tmp, `v${i}.wav`), wav);
      const isEndClip = o.endClip && i === scenes.length - 1 && (s.cta || s.end);
      durs.push(Math.min(14, Math.max(isEndClip ? Number(o.endClipSeconds) || 4.9 : 0, Number(s.seconds) || 3, wav ? spoken + 0.9 : 0)));
    }
    const aiImages = await aiJobs;
    const total = durs.reduce((a, b) => a + b, 0) - (scenes.length - 1) * T;

    // 2. רקעים: גרפי (גדול יותר בשביל תנועת זום), כרטיס סיום, ו/או סרטון שמנורמל לגודל
    const big = [Math.round(W * 1.5), Math.round(H * 1.5)];
    const base = { style: o.style, phone: o.phone, brand: o.brand };
    fs.writeFileSync(path.join(tmp, "bg.png"), renderAd({ ...base, headline: "x", dims: big, layer: "bg" }));
    if (cinematic) {
      fs.writeFileSync(path.join(tmp, "endbg.png"), renderCinematic({ ...base, dims: big, layer: "endbg" }));
      fs.writeFileSync(path.join(tmp, "shade.png"), renderCinematic({ ...base, dims: [W, H], layer: "shade" }));
    }
    if (bgMode === "clip") {
      await ffmpeg(["-stream_loop", "-1", "-i", o.clip, "-t", String(total + 2), "-an",
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", path.join(tmp, "clip.mp4")]);
    }

    // 3. כל סצנה: רקע בתנועה + כותרת שנכנסת מלמטה + שאר הטקסט חצי שנייה אחריה
    let start = 0;
    const starts = [];
    for (let i = 0; i < scenes.length; i++) {
      const d = durs[i];
      const frames = Math.round(d * FPS);
      starts.push(start);
      const sc = scenes[i];
      const isLast = i === scenes.length - 1;
      const endCard = cinematic && isLast && (sc.cta || sc.end);
      // סיום מוכן מראש (הסיום המונפש עם הלוגו מהסרטון המקורי), רק בפורמט לאורך
      if (endCard && o.endClip && fs.existsSync(o.endClip) && H > W) {
        const clipLen = Number(o.endClipSeconds) || 4.9;
        await ffmpeg([
          "-i", o.endClip, "-an",
          "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=${Math.max(0, d - clipLen + 0.2).toFixed(2)}`,
          "-frames:v", String(frames), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), path.join(tmp, `s${i}.mp4`),
        ]);
        start += d - T;
        continue;
      }
      const phone = isLast ? o.phone : "";
      let la, lb;
      if (endCard) {
        la = renderCinematic({ ...base, ...sc, phone, dims: [W, H], layer: "enda" });
        lb = renderCinematic({ ...base, ...sc, phone, dims: [W, H], layer: "endb" });
      } else if (cinematic) {
        la = renderCinematic({ ...base, ...sc, dims: [W, H], layer: "a" });
        lb = renderCinematic({ ...base, ...sc, dims: [W, H], layer: "b" });
      } else {
        const layer = (l) => renderAd({ ...base, ...sc, phone, dims: [W, H], layer: l, center: true });
        la = layer("a");
        lb = layer("b");
      }
      fs.writeFileSync(path.join(tmp, `a${i}.png`), la);
      fs.writeFileSync(path.join(tmp, `b${i}.png`), lb);
      const zoom = i % 2 ? `1.12-0.12*on/${frames}` : `1+0.12*on/${frames}`;
      const zp = `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
      let bgIn;
      let bgF;
      if (bgMode === "clip" && !endCard) {
        bgIn = ["-ss", String(start), "-t", String(d), "-i", path.join(tmp, "clip.mp4")];
        bgF = `[0:v]setpts=PTS-STARTPTS,fps=${FPS}[bg]`;
      } else {
        let img = path.join(tmp, "bg.png");
        let crop = "";
        if (endCard) img = path.join(tmp, "endbg.png");
        else if (bgMode === "photo") img = o.photos[i % o.photos.length];
        else if (bgMode === "ai" && aiImages[i]) {
          img = aiImages[i];
          crop = "crop=iw:ih*0.93:0:0,"; // חותכים את הפס התחתון (סימן המים של שירות התמונות)
        }
        bgIn = ["-i", img];
        bgF = `[0:v]${crop}scale=${big[0]}:${big[1]}:force_original_aspect_ratio=increase,crop=${big[0]}:${big[1]},setsar=1,${zp}[bg]`;
      }
      const slide = Math.round(50 * (W / 720));
      const useShade = cinematic && !endCard;
      const filter = [
        bgF,
        ...(useShade ? [`[3:v]format=rgba[s]`, `[bg][s]overlay=0:0[bg2]`] : []),
        `[1:v]format=rgba,fade=t=in:st=0.2:d=0.5:alpha=1[a]`,
        `[2:v]format=rgba,fade=t=in:st=0.75:d=0.5:alpha=1[b]`,
        `[${useShade ? "bg2" : "bg"}][a]overlay=x=0:y='${slide}*max(0,min(1,1-(t-0.2)/0.5))':eval=frame[x]`,
        `[x][b]overlay=x=0:y='${slide}*max(0,min(1,1-(t-0.75)/0.5))':eval=frame,format=yuv420p[v]`,
      ].join(";");
      await ffmpeg([
        ...bgIn,
        "-loop", "1", "-framerate", String(FPS), "-t", String(d), "-i", path.join(tmp, `a${i}.png`),
        "-loop", "1", "-framerate", String(FPS), "-t", String(d), "-i", path.join(tmp, `b${i}.png`),
        ...(useShade ? ["-loop", "1", "-framerate", String(FPS), "-t", String(d), "-i", path.join(tmp, "shade.png")] : []),
        "-filter_complex", filter, "-map", "[v]", "-frames:v", String(frames),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-r", String(FPS), path.join(tmp, `s${i}.mp4`),
      ]);
      start += d - T;
    }

    // 4. חיבור הסצנות עם מעברים, ועליהן קריינות ומוזיקה
    const inputs = [];
    const f = [];
    scenes.forEach((_, i) => {
      inputs.push("-i", path.join(tmp, `s${i}.mp4`));
      f.push(`[${i}:v]settb=AVTB,fps=${FPS},format=yuv420p[v${i}]`);
    });
    let last = "v0";
    for (let i = 1; i < scenes.length; i++) {
      const tr = TRANSITIONS[(i - 1) % TRANSITIONS.length];
      f.push(`[${last}][v${i}]xfade=transition=${tr}:duration=${T}:offset=${starts[i].toFixed(3)}[x${i}]`);
      last = `x${i}`;
    }
    const audio = [];
    let idx = scenes.length;
    scenes.forEach((_, i) => {
      const wav = path.join(tmp, `v${i}.wav`);
      if (!fs.existsSync(wav)) return;
      inputs.push("-i", wav);
      const ms = Math.round((starts[i] + 0.3) * 1000);
      f.push(`[${idx}:a]adelay=${ms}:all=1[n${i}]`);
      audio.push(`[n${i}]`);
      idx++;
    });
    // הסאונד המקורי של הקליפ (בסרטון AI של גוגל: מוזיקה, אווירה ודיבור). עם קריינות שלנו הוא יורד ברקע
    if (o.clipAudio && o.clip) {
      const voiced = audio.length > 0;
      inputs.push("-i", o.clip);
      f.push(`[${idx}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${voiced ? 0.4 : 1},afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2[ca]`);
      audio.push("[ca]");
      idx++;
    }
    const music = MUSIC.includes(o.music) ? o.music : "none";
    if (music !== "none") {
      inputs.push("-f", "lavfi", "-t", String(total), "-i", `aevalsrc='${musicExpr(music)}':s=48000`);
      f.push(`[${idx}:a]volume=${audio.length ? 0.35 : 0.8},afade=t=in:d=0.6,afade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1.2[m]`);
      audio.push("[m]");
      idx++;
    }
    if (!audio.length) {
      inputs.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=mono");
      audio.push(`[${idx}:a]`);
    }
    f.push(`${audio.join("")}amix=inputs=${audio.length}:normalize=0:duration=longest,apad,atrim=0:${total.toFixed(3)},alimiter=limit=0.95[a]`);
    const out = path.join(tmp, "out.mp4");
    await ffmpeg([
      ...inputs,
      "-filter_complex", f.join(";"), "-map", `[${last}]`, "-map", "[a]",
      "-t", total.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", out,
    ]);
    return { mp4: fs.readFileSync(out), seconds: Math.round(total) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- תמונות וסרטונים שהבעלים שלח: נשמרים כדי לשמש רקע לסרטונים ---------
const MEDIA_DIR = path.join(DATA_DIR, "media");
const KEEP_HOURS = 48;

export function saveOwnerMedia(buf, kind, mime = "") {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = kind === "clip" ? (/quicktime/.test(mime) ? "mov" : /3gpp/.test(mime) ? "3gp" : "mp4") : /png/.test(mime) ? "png" : /webp/.test(mime) ? "webp" : "jpg";
  const file = path.join(MEDIA_DIR, `${kind}-${Date.now()}.${ext}`);
  fs.writeFileSync(file, buf);
  // ניקוי: מוחקים מה שישן מ-48 שעות
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    const p = path.join(MEDIA_DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > KEEP_HOURS * 3600_000) fs.rmSync(p); } catch {}
  }
  return file;
}

// הקבצים האחרונים מסוג מסוים (מהישן לחדש), רק מ-48 השעות האחרונות
export function recentOwnerMedia(kind, max = 6) {
  if (!fs.existsSync(MEDIA_DIR)) return [];
  return fs
    .readdirSync(MEDIA_DIR)
    .filter((f) => f.startsWith(`${kind}-`))
    .map((f) => ({ p: path.join(MEDIA_DIR, f), t: Number(f.split("-")[1].split(".")[0]) }))
    .filter((x) => Date.now() - x.t < KEEP_HOURS * 3600_000)
    .sort((a, b) => a.t - b.t)
    .slice(-max)
    .map((x) => x.p);
}
