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
const uploads: Array<{ id: number; size: number; outcome: string }> = [];
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
  await new Promise((resolve) => setTimeout(resolve, 8000));
  return c.json({ status: 200, data: { id: 77, name: "延迟加载的补充信息", value: [
    { id: 1, name: "texts", value: "", titleConfig: { value: "测试邮箱" }, tipConfig: { value: "请输入测试邮箱" }, titleShow: { val: "1" }, valConfig: { tabVal: 3 } },
    { id: 2, name: "selects", value: "", titleConfig: { value: "交付偏好" }, titleShow: { val: true }, wordsConfig: { list: [{ val: "甲" }, { val: "乙" }] } },
    { id: 3, name: "uploadPicture", value: [], titleConfig: { value: "选填图片（仅本地临时接收）" }, titleShow: { val: "0" }, numConfig: { val: 1 } },
  ] } });
});
app.post("/api/order/create/:key", async (c) => {
  creates.push({ key: c.req.param("key"), body: await c.req.json() });
  // First: definitive rejection permits correction. Second: unknown outcome freezes the payload.
  // Third and later: a rejection cannot settle the earlier uncertain attempt. Still capture-only.
  if (creates.length === 2) return c.json({ status: 400, msg: "模拟未知下单结果（实际没有建单）" });
  return c.json({ status: 400, msg: "模拟服务端表单拒绝（实际没有建单）",
    data: { errorCode: "ORDER_FORM_REJECTED", orderKey: c.req.param("key") } });
});
app.post("/api/upload/image", async (c) => {
  if (c.get("uid") !== 11) return c.json({ status: 400, msg: "Local fixture login required" });
  const file = (await c.req.formData()).get("file");
  if (!(file instanceof File) || file.type !== "image/png" || file.size > 256000) return c.json({ status: 400, msg: "Only small local PNG fixtures are accepted" });
  const event = { id: uploads.length + 1, size: file.size, outcome: "pending" };
  uploads.push(event);
  await new Promise((resolve) => setTimeout(resolve, event.id === 3 ? 20000 : 8000));
  event.outcome = event.id === 2 ? "simulated-failure" : "response-delivered";
  // Capture metadata only, never write a file, R2 object or attachment row.
  return c.json(event.id === 2 ? { status: 400, msg: "模拟图片上传失败" }
    : { status: 200, data: { url: `/api/assets/${900 + event.id}`, src: `/api/assets/${900 + event.id}` } });
});
app.get("/api/qa/state", async (c) => c.json({ requests, creates, uploads, snapshot: await fixture.snapshot() }));
app.get("/api/qa/image.svg", () => new Response(decodeURIComponent(pcGalleryImages[0].split(",").slice(1).join(",")), { headers: { "Content-Type": "image/svg+xml" } }));
app.all("*", (c) => {
  const result = pcFixtureResponse(c.req.method, c.req.url);
  return c.json(result, result.status === 200 ? 200 : 405);
});
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of req) {
      received += Buffer.byteLength(chunk);
      if (received > 260000) { res.writeHead(413).end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const path = new URL(req.url ?? "/", "http://127.0.0.1:5218").pathname;
    const isQuote = path === "/api/order/confirm" || path.startsWith("/api/order/computed/");
    const payload = isQuote && body.length ? JSON.parse(body.toString("utf8")) as Record<string, unknown> : {};
    const event = isQuote ? { id: ++quoteRequests, path, body: payload, outcome: "pending" } : null;
    if (event) {
      requests.push(event);
      // Delay the response after the real calculation so rapid changes exercise out-of-order delivery.
      console.log(JSON.stringify({ event: "LOCAL_QUOTE_REQUEST", ...event }));
    }
    const authorized = String(req.headers["authori-zation"] ?? "") === `Bearer ${token}`;
    let response = await app.request(`http://127.0.0.1:5218${req.url}`, {
      method: req.method, headers: { "Content-Type": req.headers["content-type"] ?? "application/json", "x-fixture-user": authorized ? "11" : "" },
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
