// Explicitly launched QA helper. Never imports a database client or proxies a request.
import { createServer } from "node:http";
import { pcFixtureResponse } from "./pcProductDetailFixture";

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const result = pcFixtureResponse(req.method ?? "", req.url ?? "/");
  res.writeHead(result.status).end(JSON.stringify(result));
});
server.listen(5218, "127.0.0.1", () => console.log("PC_DETAIL_FIXTURE http://127.0.0.1:5218 (GET only; no upstream)"));
