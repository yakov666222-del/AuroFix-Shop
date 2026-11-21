// חיבור למערכת המעבדה (AuroFix) שרצה על אותו שרת: מלאי, תיקונים ותשלומים.
// כל שינוי במלאי עובר דרך "הצעה" שהבעלים חייב לאשר ב"כן" לפני ביצוע (ראה index.js).
const LAB = (process.env.LAB_API_URL || "").replace(/\/$/, "");
export const labEnabled = Boolean(LAB);

async function api(path, opts = {}) {
  if (!LAB) throw new Error("החיבור למערכת המעבדה לא מוגדר.");
  const res = await fetch(LAB + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`מערכת המעבדה החזירה שגיאה ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[\s\-_/]+/g, " ").trim();
const money = (n) => `${Math.round(Number(n) || 0).toLocaleString("he-IL")} ₪`;

function itemLine(i) {
  const low = i.min > 0 && i.qty <= i.min ? " ⚠️ מתחת למינימום" : "";
  return `• ${i.name} | במלאי: ${i.qty}${i.min ? ` (מינימום ${i.min})` : ""}${low} | עלות ${money(i.cost)} | מחיר ללקוח ${money(i.price)}${
    i.cat ? ` | ${i.cat}` : ""
  }${i.supplier ? ` | ספק: ${i.supplier}` : ""} | id=${i.id}`;
}

export async function searchInventory(query) {
  const items = await api("/api/inventory");
  const words = norm(query).split(" ").filter(Boolean);
  const hits = items.filter((i) => {
    const hay = norm(`${i.name} ${i.sku} ${i.cat} ${i.supplier} ${i.notes}`);
    return words.every((w) => hay.includes(w));
  });
  if (!hits.length) {
    // אין התאמה מלאה - מחזירים התאמות חלקיות כדי שהסוכן יוכל לשאול "התכוונת ל...?"
    const partial = items.filter((i) => words.some((w) => norm(`${i.name} ${i.sku} ${i.cat}`).includes(w))).slice(0, 10);
    return partial.length
      ? `לא נמצאה התאמה מדויקת ל"${query}". פריטים דומים:\n${partial.map(itemLine).join("\n")}`
      : `לא נמצא שום פריט שמתאים ל"${query}" במלאי (${items.length} פריטים במערכת).`;
  }
  return hits.slice(0, 15).map(itemLine).join("\n");
}

export async function shortages() {
  const items = await api("/api/inventory");
  const low = items.filter((i) => i.min > 0 && i.qty <= i.min);
  const zero = items.filter((i) => !(i.min > 0) && i.qty <= 0);
  const lines = low.map((i) => {
    const order = i.reorder_qty > 0 ? i.reorder_qty : Math.max(i.min * 2 - i.qty, 1);
    return `• ${i.name}: יש ${i.qty}, מינימום ${i.min}. להזמין ${order}${i.cost ? ` (≈${money(order * i.cost)})` : ""}${
      i.supplier ? ` מ-${i.supplier}` : ""
    }`;
  });
  let out = lines.length ? `מתחת למינימום:\n${lines.join("\n")}` : "אין פריטים מתחת לכמות המינימום.";
  if (zero.length) out += `\n\nנגמרו (בלי מינימום מוגדר):\n${zero.slice(0, 20).map((i) => `• ${i.name}`).join("\n")}`;
  const noMin = items.filter((i) => !(i.min > 0)).length;
  if (noMin) out += `\n\n(ל-${noMin} מתוך ${items.length} פריטים לא מוגדרת כמות מינימום, אז אי אפשר לדעת מתי הם "חסרים".)`;
  return out;
}

export async function getItem(id) {
  return api(`/api/inventory/${encodeURIComponent(id)}`);
}

export async function adjustInventory(id, delta, reason) {
  return api(`/api/inventory/${encodeURIComponent(id)}/adjust`, {
    method: "PATCH",
    body: JSON.stringify({ delta, reason: "WHATSAPP_ADVISOR", notes: reason || "" }),
  });
}

const STATUS = {
  received: "התקבל",
  diagnosing: "באבחון",
  in_progress: "בתיקון",
  ready: "מוכן לאיסוף",
  delivered: "נמסר",
  returned_no_repair: "הוחזר בלי תיקון",
};
const PAY = { unpaid: "לא שולם", partial: "שולם חלקית", paid: "שולם" };

export async function findRepairs(query) {
  const repairs = await api("/api/repairs");
  const q = norm(query);
  const open = q === "" || q === "פתוחים" || q === "open";
  const list = open
    ? repairs.filter((r) => !["delivered", "returned_no_repair"].includes(r.status))
    : repairs.filter((r) => norm(`${r.jobId} ${r.client} ${r.device} ${r.desc}`).includes(q));
  if (!list.length) return open ? "אין תיקונים פתוחים." : `לא נמצא תיקון שמתאים ל"${query}".`;
  return list
    .slice(0, 15)
    .map(
      (r) =>
        `• תיקון #${r.jobId} | ${r.client || "ללא שם"} | ${r.device || ""} | ${r.desc || ""} | סטטוס: ${STATUS[r.status] || r.status} | סה"כ ${money(
          r.total
        )}, יתרה ${money(r.balance_due)} (${PAY[r.payment_status] || r.payment_status}) | נפתח ${String(r.createdAt).slice(0, 10)}${
          r.parts?.length ? ` | חלקים: ${r.parts.map((p) => `${p.name}×${p.qty}`).join(", ")}` : ""
        }`
    )
    .join("\n");
}

export async function labSummary() {
  const a = await api("/api/analytics");
  const s = a.stats || {};
  let out = `סיכום מערכת המעבדה:
• תיקונים: ${s.total_repairs} (התקבלו ${s.status_received}, באבחון ${s.status_diagnosing}, בתיקון ${s.status_in_progress}, מוכנים ${s.status_ready}, נמסרו ${s.status_delivered}, הוחזרו בלי תיקון ${s.status_returned_no_repair})
• לקוחות: ${s.total_customers}
• הכנסות שנרשמו: ${money(s.total_revenue)} | יתרות פתוחות: ${money(s.total_balance_due)}
• תשלום: לא שולם ${s.unpaid_count}, חלקי ${s.partial_count}, שולם ${s.paid_count}`;
  if (a.popularParts?.length) out += `\n• חלקים נפוצים: ${a.popularParts.slice(0, 5).map((p) => `${p.part_name} (${p.total_qty})`).join(", ")}`;
  return out;
}

// הכנסות מתשלומים שנרשמו במערכת המעבדה, לשנה מסוימת (לחישוב מחזור)
export async function labIncomeForYear(year) {
  const payments = await api("/api/payments");
  return payments
    .filter((p) => new Date(p.payment_date || p.created_at).getFullYear() === year)
    .reduce((sum, p) => sum + Number(p.total_received || 0), 0);
}
