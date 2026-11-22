// חיבור למערכת המעבדה (AuroFix) שרצה על אותו שרת: מלאי, תיקונים ותשלומים.
// כל שינוי במלאי עובר דרך "הצעה" שהבעלים חייב לאשר ב"כן" לפני ביצוע (ראה index.js).
const LAB = (process.env.LAB_API_URL || "").replace(/\/$/, "");
export const labEnabled = Boolean(LAB);

// אם שרת המעבדה ישן, פנייה לכתובת הציבורית שלו מעירה אותו
const WAKE = process.env.LAB_WAKE_URL || "";
async function wakeLab() {
  if (!WAKE) return;
  await fetch(WAKE, { redirect: "manual", signal: AbortSignal.timeout(20000) }).catch(() => {});
}

async function api(path, opts = {}) {
  if (!LAB) throw new Error("החיבור למערכת המעבדה לא מוגדר.");
  const call = () =>
    fetch(LAB + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
  let res;
  try {
    res = await call();
  } catch {
    // לא עונה: כנראה ישן. מעירים ומנסים שוב כמה פעמים
    await wakeLab();
    for (let i = 0; i < 5 && !res; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await call().catch(() => null);
    }
    if (!res) throw new Error("מערכת המעבדה לא עונה כרגע.");
  }
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

// הזמנות שכבר יצאו לספק ועוד לא הגיעו (המסך "הזמנות ממתינות" במערכת המעבדה)
export async function pendingOrders() {
  return api("/api/pending_orders").catch(() => []);
}
const sameItem = (i, o) => (i.sku && o.sku && norm(i.sku) === norm(o.sku)) || norm(i.name) === norm(o.name);
export const recommendedQty = (i) => (i.reorder_qty > 0 ? i.reorder_qty : Math.max(i.min * 2 - i.qty, 1));

// הבעלים סורק ברקוד כשהסחורה מגיעה, והכמות נכנסת למלאי ישר מהסריקה (בלי "התקבל" על ההזמנה).
// לכן הזמנה שהיועץ פתח נסגרת לבד כשהמלאי עלה: הפריט חזר מעל המינימום, או שנוספה הכמות שהוזמנה.
const ADVISOR_NOTE = "הוזמן דרך היועץ";
async function closeArrivedOrders(items, orders) {
  const open = [];
  for (const o of orders) {
    const i = items.find((x) => sameItem(x, o));
    const before = Number(/במלאי כשהוזמן: (-?\d+)/.exec(o.notes || "")?.[1]);
    const arrived =
      i && String(o.notes || "").startsWith(ADVISOR_NOTE) &&
      ((i.min > 0 && i.qty > i.min) || (Number.isFinite(before) && i.qty >= before + Number(o.qty_ordered || 0)));
    if (arrived) await api(`/api/pending_orders/${encodeURIComponent(o.id)}`, { method: "DELETE" }).catch(() => open.push(o));
    else open.push(o);
  }
  return open;
}

// חוסרים: מה מתחת למינימום, ומה מזה כבר הוזמן
export async function shortageData() {
  const items = await api("/api/inventory");
  const orders = await closeArrivedOrders(items, await pendingOrders());
  const low = items.filter((i) => i.min > 0 && i.qty <= i.min);
  const withOrder = low.map((i) => ({ item: i, qty: recommendedQty(i), order: orders.find((o) => sameItem(i, o)) }));
  return {
    items,
    toOrder: withOrder.filter((x) => !x.order),
    ordered: withOrder.filter((x) => x.order),
  };
}

export const shortageLine = ({ item: i, qty }) =>
  `• ${i.name}: יש ${i.qty}, מינימום ${i.min}. להזמין ${qty}${i.cost ? ` (≈${money(qty * i.cost)})` : ""}${i.supplier ? ` מ-${i.supplier}` : ""}`;
export const orderTotal = (list) => money(list.reduce((s, x) => s + x.qty * (Number(x.item.cost) || 0), 0));

// סימון "הוזמן": יוצר הזמנה ממתינה במערכת המעבדה. כשמסמנים שם "התקבל", הכמות נכנסת למלאי.
export async function markOrdered(itemId, qty, note) {
  const i = await getItem(itemId);
  const { ordered } = await shortageData();
  const existing = ordered.find((x) => x.item.id === i.id);
  if (existing) return `${i.name} כבר מסומן כהוזמן (${existing.order.qty_ordered} יח'), לא יצרתי הזמנה כפולה.`;
  const amount = qty > 0 ? qty : i.min > 0 ? recommendedQty(i) : 1;
  await api("/api/pending_orders", {
    method: "POST",
    body: JSON.stringify({
      name: i.name,
      sku: i.sku || "",
      cat: i.cat || "",
      loc: i.loc || "",
      qty_ordered: amount,
      cost: i.cost || 0,
      price: i.price || 0,
      min: i.min || 0,
      reorder_qty: i.reorder_qty || 0,
      supplier: i.supplier || "",
      notes: `${ADVISOR_NOTE}${note ? `: ${note}` : ""} (במלאי כשהוזמן: ${i.qty})`,
    }),
  });
  return `✅ ${i.name}: סומן כהוזמן, ${amount} יח'${i.cost ? ` (≈${money(amount * i.cost)})` : ""}. מופיע ב"הזמנות ממתינות" במערכת. כשהסחורה מגיעה, פשוט סרוק אותה כרגיל וההזמנה תיסגר לבד.`;
}

export async function shortages() {
  const { items, toOrder, ordered } = await shortageData();
  const zero = items.filter((i) => !(i.min > 0) && i.qty <= 0);
  let out = toOrder.length
    ? `מתחת למינימום ועוד לא הוזמן:\n${toOrder.map(shortageLine).join("\n")}\nסה"כ להזמנה ≈ ${orderTotal(toOrder)}`
    : "אין פריטים מתחת למינימום שעוד לא הוזמנו.";
  if (ordered.length)
    out += `\n\n🛒 כבר הוזמן ומחכה להגעה:\n${ordered.map((x) => `• ${x.item.name}: ${x.order.qty_ordered} יח'`).join("\n")}`;
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
