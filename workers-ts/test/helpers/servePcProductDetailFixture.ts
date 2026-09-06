// Explicitly launched QA helper. Never imports a database client or proxies a request.
import { createServer } from "node:http";
import { pcDetailFixture } from "./pcProductDetailFixture";

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const path = new URL(req.url ?? "/", "http://127.0.0.1:5218").pathname;
  let data: unknown;
  if (req.method !== "GET") {
    res.writeHead(405).end(JSON.stringify({ status: 405, msg: "Read-only QA fixture" }));
    return;
  }
  if (/^\/api\/product\/detail\/(70|71)$/.test(path)) {
    data = { ...pcDetailFixture, id: path.endsWith("71") ? 71 : 70,
      isPresaleProduct: path.endsWith("71") ? 1 : 0 };
  } else if (path === "/api/site_config") {
    data = { site_name: "CinaShop 本地验收", record_No: "", site_logo: "/logo.png", ico_path: "" };
  } else if (path === "/api/share") {
    data = { img: "", title: "CinaShop 本地验收", synopsis: "仅使用模拟数据" };
  } else if (/^\/api\/reply\/config\/(70|71)$/.test(path)) {
    data = { total: 0, avgScore: "0.0", goodRate: 100, picsCount: 0 };
  } else if (/^\/api\/(reply\/list|store_discounts\/list)\/(70|71)$/.test(path)) {
    data = [];
  } else {
    res.writeHead(404).end(JSON.stringify({ status: 404, msg: "Fixture route not allowed" }));
    return;
  }
  res.end(JSON.stringify({ status: 200, msg: "ok", data }));
});
server.listen(5218, "127.0.0.1", () => console.log("PC_DETAIL_FIXTURE http://127.0.0.1:5218 (GET only; no upstream)"));
