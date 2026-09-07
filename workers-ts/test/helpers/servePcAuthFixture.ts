/** Local browser auth-recovery harness. Disposable SQL quotes; synthetic logins only; no real session/provider. */
import { createServer } from "node:http";
import { createPcCheckoutQuoteFixture } from "./pcCheckoutQuoteFixture";
import { pcDetailFixture, pcFixtureResponse, pcGalleryImages } from "./pcProductDetailFixture";
import { cartList } from "../../src/controllers/api/v1/OrderController";
import { userAddress, systemStore } from "../../src/models/schema";

if (process.env.TEST_FINANCE_POSTGRES_URL) throw new Error("Browser auth fixture requires in-memory PGlite only");
const fixture = await createPcCheckoutQuoteFixture();
const tokens = Object.fromEntries(["expired", "fresh", "new", "offline"].map((session) => [session,
  `local.${Buffer.from(JSON.stringify({ jti: { id: 11 }, session })).toString("base64")}.not-a-real-token`,
]));
const events: Array<{ path: string; session: string; outcome: string }> = [];
const app = fixture.app;
app.post("/api/login", async (c) => {
  const body = await c.req.json();
  const session = String(body.account ?? "").replace(/-qa$/, "");
  if (!Object.hasOwn(tokens, session) || body.password !== "local-qa") return c.json({ status: 400, msg: "Use expired-qa/fresh-qa/new-qa/offline-qa with local-qa password" });
  return c.json({ status: 200, data: { token: tokens[session], expires_time: 9999999999 } });
});
app.get("/api/logout", (c) => c.req.header("x-fixture-session") === "offline"
  ? c.json({ status: 503, msg: "模拟服务端撤销未确认" }, 503)
  : c.json({ status: 200, data: null }));
app.get("/api/product/detail/70", (c) => c.json({ status: 200, data: { ...pcDetailFixture, stock: 8,
  attr_value: [{ unique: "qared001", suk: "红色,大号", stock: 8, price: "10.00", vip_price: "9.00" }],
} }));
app.get("/api/cart/list", cartList);
app.get("/api/cart/count", (c) => c.json({ status: 200, data: { count: 0 } }));
app.get("/api/address/list", async (c) => c.json({ status: 200, data: (await fixture.db.select().from(userAddress)).map((row) => ({
  id: row.id, uid: row.uid, real_name: row.realName, phone: row.phone, province: row.province, city: row.city, district: row.district,
  detail: row.detail, is_default: row.isDefault, add_time: row.addTime,
})) }));
app.get("/api/store/list", async (c) => c.json({ status: 200, data: (await fixture.db.select().from(systemStore)).map((row) => ({
  ...row, detailed_address: row.detailedAddress, day_time: "仅本地验收",
})) }));
app.get("/api/qa/state", async (c) => c.json({ events, snapshot: await fixture.snapshot() }));
app.get("/api/qa/image.svg", () => new Response(decodeURIComponent(pcGalleryImages[0].split(",").slice(1).join(",")), { headers: { "Content-Type": "image/svg+xml" } }));
app.all("*", (c) => {
  const response = pcFixtureResponse(c.req.method, c.req.url);
  return c.json(response, response.status === 200 ? 200 : 405);
});
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 4096) { res.writeHead(413).end(); return; }
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1:5218").pathname;
    const bearer = String(req.headers["authori-zation"] ?? "");
    const session = Object.keys(tokens).find((name) => bearer === `Bearer ${tokens[name]}`) ?? "anonymous";
    const event = { path, session, outcome: "pending" };
    events.push(event);
    let response: Response;
    if (session === "expired" && path === "/api/cart/list") {
      event.outcome = "current-session-expired";
      response = Response.json({ status: 410001, msg: "模拟当前会话失效" });
    } else if (session === "fresh" && path === "/api/pc/get_appid") {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      event.outcome = "late-old-session-expired";
      response = Response.json({ status: 410002, msg: "模拟旧会话迟到失效" });
    } else {
      response = await app.request(`http://127.0.0.1:5218${req.url}`, {
        method: req.method, headers: { "Content-Type": "application/json", "x-fixture-user": session === "anonymous" ? "" : "11", "x-fixture-session": session },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      }, fixture.env);
      event.outcome = "response-delivered";
    }
    res.writeHead(response.status, { "Content-Type": response.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store" }).end(await response.text());
  } catch (error) { console.error("LOCAL_AUTH_QA_ERROR", error); res.writeHead(500).end(); }
});
server.listen(5218, "127.0.0.1", () => console.log("PC_AUTH_FIXTURE 127.0.0.1:5218; PGlite only; synthetic expired-qa/fresh-qa/new-qa/offline-qa; password local-qa"));
process.once("SIGINT", () => { server.close(() => { void fixture.close().then(() => process.exit(0)); }); });
