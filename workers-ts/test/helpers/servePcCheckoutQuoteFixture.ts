/** Explicitly run local browser harness. Real SQL-backed quotes; synthetic auth,
 * delayed/failed responses and capture-only create requests. Never production. */
import { createServer } from "node:http";
import { createPcCheckoutQuoteFixture } from "./pcCheckoutQuoteFixture";
import { pcFixtureResponse, pcGalleryImages } from "./pcProductDetailFixture";
import { cartList } from "../../src/controllers/api/v1/OrderController";
import { storeCart, storeProduct, storeProductAttrValue, userAddress, systemStore } from "../../src/models/schema";

if (process.env.TEST_FINANCE_POSTGRES_URL) throw new Error("Browser quote fixture requires in-memory PGlite only");
const fixture = await createPcCheckoutQuoteFixture();
await fixture.db.insert(storeProduct).values({ id: 71, storeName: "慢表单隔离样本", stock: 8, price: "10.00", isShow: 1, isVerify: 1, isVip: 1,
  freight: 3, tempId: 10, systemFormId: 77, image: "/api/qa/image.svg" });
await fixture.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, type: 0, unique: "qaform01", suk: "慢表单规格", stock: 8, price: "10.00", vipPrice: "9.00" });
await fixture.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: "qaform01", cartNum: 1, isNew: 1, status: 1 });
const token = `local.${Buffer.from(JSON.stringify({ jti: { id: 11 } })).toString("base64")}.not-a-real-token`;
const app = fixture.app;
let failedAddress = false;
let quoteRequests = 0;
const requests: Array<{ id: number; path: string; body: unknown; outcome?: string }> = [];
const creates: Array<{ key: string; body: unknown }> = [];
app.post("/api/login", async (c) => {
  const body = await c.req.json();
  return c.json(body.account === "local-qa" && body.password === "local-qa"
    ? { status: 200, data: { token, exp_time: 9999999999 }, msg: "Synthetic login only" }
    : { status: 400, msg: "Use public local-qa/local-qa fixture credentials" });
});
app.get("/api/cart/list", cartList);
app.get("/api/cart/count", (c) => c.json({ status: 200, data: { count: 0 } }));
app.get("/api/address/list", async (c) => c.json({ status: 200, data: (await fixture.db.select().from(userAddress)).map((row) => ({
  id: row.id, uid: row.uid, real_name: row.realName, phone: row.phone, province: row.province, city: row.city, district: row.district,
  detail: row.detail, is_default: row.isDefault, add_time: row.addTime,
})) }));
app.get("/api/store/list", async (c) => c.json({ status: 200, data: (await fixture.db.select().from(systemStore)).map((row) => ({
  ...row, detailed_address: row.detailedAddress, day_time: "仅本地验收",
})) }));
app.get("/api/order/system_form/77", async (c) => {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return c.json({ status: 200, data: { id: 77, name: "延迟加载的补充信息", value: [
    { id: 1, name: "texts", value: "", titleConfig: { value: "本地测试留言" }, tipConfig: { value: "请输入本地测试留言" } },
  ] } });
});
app.post("/api/order/create/:key", async (c) => {
  creates.push({ key: c.req.param("key"), body: await c.req.json() });
  return c.json({ status: 400, msg: creates.length === 1 ? "模拟下单响应失败（没有创建订单）" : "模拟重试已记录（仍未创建订单）" });
});
app.get("/api/qa/state", async (c) => c.json({ requests, creates, snapshot: await fixture.snapshot() }));
app.get("/api/qa/image.svg", () => new Response(decodeURIComponent(pcGalleryImages[0].split(",").slice(1).join(",")), { headers: { "Content-Type": "image/svg+xml" } }));
app.all("*", (c) => {
  const result = pcFixtureResponse(c.req.method, c.req.url);
  return c.json(result, result.status === 200 ? 200 : 405);
});
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 4096) { res.writeHead(413).end(); return; }
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1:5218").pathname;
    const isQuote = path === "/api/order/confirm" || path.startsWith("/api/order/computed/");
    const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
    const event = isQuote ? { id: ++quoteRequests, path, body: payload, outcome: "pending" } : null;
    if (event) {
      requests.push(event);
      // Delay the response after the real calculation so rapid changes exercise out-of-order delivery.
      console.log(JSON.stringify({ event: "LOCAL_QUOTE_REQUEST", ...event }));
    }
    const authorized = String(req.headers["authori-zation"] ?? "") === `Bearer ${token}`;
    let response = await app.request(`http://127.0.0.1:5218${req.url}`, {
      method: req.method, headers: { "Content-Type": "application/json", "x-fixture-user": authorized ? "11" : "" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    }, fixture.env);
    if (event) {
      await new Promise((resolve) => setTimeout(resolve, payload.addressId === 12 ? 1600 : 250));
      if (path.startsWith("/api/order/computed/") && payload.addressId === 12 && !failedAddress) {
        failedAddress = true;
        response = Response.json({ status: 400, msg: "模拟报价失败，请重新获取报价" });
        event.outcome = "simulated-failure";
      } else event.outcome = "response-delivered";
    }
    res.writeHead(response.status, { "Content-Type": response.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store" }).end(await response.text());
  } catch (error) { console.error("LOCAL_QUOTE_QA_ERROR", error); res.writeHead(500).end(); }
});
server.listen(5218, "127.0.0.1", () => console.log("PC_QUOTE_FIXTURE 127.0.0.1:5218; PGlite only; local-qa/local-qa; create capture only"));
process.once("SIGINT", () => { server.close(() => { void fixture.close().then(() => process.exit(0)); }); });
