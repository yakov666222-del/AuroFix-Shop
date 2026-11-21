// בדיקת ווטסאפ רשמי: שרת Meta מדומה + Gemini מדומה
import http from "node:http";
import { spawn } from "node:child_process";
const sent = [];
http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)).on("end", () => {
    if (req.method === "POST") sent.push(JSON.parse(b));
    res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
  });
}).listen(3871);
const env = { ...process.env, DATA_DIR: "/tmp/wa-cloud-" + Date.now(), PORT: "3872", QR_PAGE_KEY: "k", WA_MODE: "cloud", GRAPH_BASE: "http://127.0.0.1:3871", GEMINI_API_KEY: "AIza-test-not-real-0000000000000000" };
const p = spawn("node", ["src/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
const base = "http://127.0.0.1:3872";
// before config: page
console.log("cloud page:", (await (await fetch(base + "/cloud?key=k")).text()).match(/מצב: <b>([^<]*)/)[1]);
const vt = (await (await fetch(base + "/cloud?key=k")).text()).match(/Verify token[^]*?class="code"[^>]*>([0-9a-f]+)/)[1];
console.log("verify ok:", (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=123`)).status, await (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=123`)).text());
console.log("verify bad:", (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status);
await fetch(base + "/cloud?key=k", { method: "POST", body: new URLSearchParams({ token: "TKN", phone_number_id: "111", owner_phone: "0524308335" }), redirect: "manual" });
await sleep(500);
console.log("after config:", (await (await fetch(base + "/cloud?key=k")).text()).match(/מצב: <b>([^<]*)/)[1]);
console.log("opening sent to:", sent[0]?.to, "|", sent[0]?.text?.body.slice(0, 20));
const msg = (from, body, id) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "111" }, messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] } }] }] });
await fetch(base + "/webhook", { method: "POST", body: JSON.stringify(msg("972524308335", "!סטטוס", "m1")) });
await fetch(base + "/webhook", { method: "POST", body: JSON.stringify(msg("972524308335", "!סטטוס", "m1")) }); // duplicate
await fetch(base + "/webhook", { method: "POST", body: JSON.stringify(msg("972500000000", "היי", "m2")) }); // stranger
await sleep(800);
const texts = sent.filter((x) => x.type === "text");
console.log("text messages sent:", texts.length, "| last:", texts.at(-1)?.text.body.split("\n")[0]);
console.log("read receipts:", sent.filter((x) => x.status === "read").length);
console.log(log.split("\n").filter((l) => /מצב|הודעה ממספר|⚠️/.test(l)).join("\n"));
p.kill(); process.exit(0);
