// שרת מדומה של מערכת המעבדה לבדיקות
import http from "node:http";
const inv = [
  { id: "a1", name: "מסך אייפון 12", sku: "1", cat: "מסכים", cost: 150, price: 450, qty: 5, min: 2, reorder_qty: 0, supplier: "ספק א" },
  { id: "a2", name: "סוללה 11 פרו", sku: "2", cat: "סוללות", cost: 90, price: 350, qty: 1, min: 3, reorder_qty: 5, supplier: "" },
];
export function start(port) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      const j = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (u.pathname === "/api/inventory") return j(inv);
      let m = u.pathname.match(/^\/api\/inventory\/([^/]+)\/adjust$/);
      if (m && req.method === "PATCH") { const it = inv.find((i) => i.id === m[1]); it.qty += JSON.parse(body).delta; return j({ id: it.id, qty: it.qty }); }
      m = u.pathname.match(/^\/api\/inventory\/([^/]+)$/);
      if (m) { const it = inv.find((i) => i.id === decodeURIComponent(m[1])); if (!it) { res.writeHead(404); return res.end("nf"); } return j(it); }
      if (u.pathname === "/api/repairs") return j([{ jobId: "7", client: "נהוראי", device: "A34", desc: "מסך", status: "received", total: 400, balance_due: 400, payment_status: "unpaid", createdAt: "2026-08-20", parts: [] }]);
      if (u.pathname === "/api/payments") return j([{ total_received: "400", payment_date: "2026-03-01" }]);
      if (u.pathname === "/api/analytics") return j({ stats: { total_repairs: 6 }, popularParts: [] });
      res.writeHead(404); res.end();
    });
  }).listen(port);
}
