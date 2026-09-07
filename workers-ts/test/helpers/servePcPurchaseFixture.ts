/** Explicit local-only QA server: disposable in-memory cart tables, real cart
 * controllers/services/DAOs, synthetic login. Orders/providers are forbidden. */
import { createServer } from "node:http";
import { Hono } from "hono";
import { financePostgres } from "./financePostgres";
import { pcDetailFixture, pcFixtureResponse, pcGalleryImages } from "./pcProductDetailFixture";
import { createContainerFromDb } from "../../src/lib/di";
import { storeCart, storeProduct, storeProductAttrValue } from "../../src/models/schema";
import { cartAdd, cartList } from "../../src/controllers/api/v1/OrderController";
import type { AppVariables, Env } from "../../src/env";

if (process.env.TEST_FINANCE_POSTGRES_URL) throw new Error("Browser fixture requires in-memory PGlite only");
const fixture = await financePostgres([storeProduct, storeProductAttrValue, storeCart]);
const container = createContainerFromDb(fixture.db);
const skuRows = [
  { unique: "qared001", suk: "红色,大号", price: "19.90", stock: 8 },
  { unique: "qablue01", suk: "蓝色,小号", price: "29.90", stock: 2 },
  { unique: "qawhit01", suk: "白色,大号", price: "39.90", stock: 0 },
  { unique: "qaretry1", suk: "失败重试样本", price: "49.90", stock: 4 },
].map((sku, i) => ({ ...sku, id: i + 1, productId: 70, type: 0, otPrice: "59.90", vipPrice: "9.90", image: "/api/qa/image.svg" }));
await fixture.db.insert(storeProduct).values({ id: 70, storeName: "本地交易合同测试", stock: 100,
  price: "19.90", otPrice: "59.90", isShow: 1, isVerify: 1, isDel: 0, image: "/api/qa/image.svg" });
await fixture.db.insert(storeProductAttrValue).values(skuRows);
const token = `local.${Buffer.from(JSON.stringify({ jti: { id: 11 } })).toString("base64")}.not-a-real-token`;
let retryFailed = false;
let cartWrites = 0;
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
app.use("*", async (c, next) => { c.set("container", container); c.set("uid", c.req.header("Authorization") === `Bearer ${token}` ? 11 : 0); await next(); });
app.post("/api/login", async (c) => {
  const body = await c.req.json();
  return c.json(body.account === "local-qa" && body.password === "local-qa"
    ? { status: 200, data: { token, exp_time: 9999999999 }, msg: "Synthetic local login" }
    : { status: 400, msg: "Only the public local-qa fixture account is allowed" });
});
app.post("/api/cart/add", async (c) => {
  const parsed = await c.req.raw.clone().json();
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  cartWrites++;
  console.log(JSON.stringify({ event: "LOCAL_CART_REQUEST", count: cartWrites, unique: body.unique, quantity: body.cartNum, direct: body.new }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (body.unique === "qaretry1" && !retryFailed) {
    retryFailed = true;
    return c.json({ status: 400, msg: "模拟库存校验失败，请重试" });
  }
  return cartAdd(c);
});
app.get("/api/cart/list", cartList);
app.get("/api/cart/count", (c) => c.json({ status: 200, data: { count: 0 }, msg: "fixture" }));
app.get("/api/qa/cart-state", async (c) => c.json({ requests: cartWrites, rows: await fixture.db.select().from(storeCart) }));
app.get("/api/qa/image.svg", () => new Response(decodeURIComponent(pcGalleryImages[0].split(",").slice(1).join(",")), { headers: { "Content-Type": "image/svg+xml" } }));
app.get("/api/product/detail/70", (c) => c.json({ status: 200, msg: "fixture", data: {
  ...pcDetailFixture, storeName: "本地交易合同测试", sliderImage: pcGalleryImages, spec_type: 1,
  attr_value: skuRows.map((sku) => ({ ...sku, ot_price: sku.otPrice, vip_price: sku.vipPrice })),
} }));
app.post("/api/order/first_order_quote", (c) => c.json({ status: 200, data: { eligible: false, firstOrderPrice: "0.00" }, msg: "Synthetic quote only" }));
app.get("/api/address/list", (c) => c.json({ status: 200, data: [], msg: "No real addresses" }));
app.get("/api/store/list", (c) => c.json({ status: 200, data: [], msg: "No real stores" }));
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
    const response = await app.request(`http://127.0.0.1:5218${req.url}`, {
      method: req.method, headers: { "Content-Type": "application/json", Authorization: String(req.headers["authori-zation"] ?? req.headers.authorization ?? "") },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    res.writeHead(response.status, { "Content-Type": response.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store" }).end(await response.text());
  } catch (error) { console.error("LOCAL_QA_ERROR", error); res.writeHead(500).end(); }
});
server.listen(5218, "127.0.0.1", () => console.log("PC_PURCHASE_FIXTURE 127.0.0.1:5218; PGlite only; no orders/providers; local-qa/local-qa"));
process.once("SIGINT", () => { server.close(() => { void fixture.close().then(() => process.exit(0)); }); });
