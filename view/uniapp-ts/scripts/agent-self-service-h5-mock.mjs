/** Synthetic, loopback-only GET fixture for the FE-003C rendered H5 audit. */
import http from "node:http";

const promoter = { user: { id: 7, uid: 11, nickname: "Alice", real_name: "Alice Chen",
  phone: "13800138000", status: 2, add_time: "2024-09-24 06:40:00",
  status_time: "2024-09-24 07:40:00", refusal_reason: "请核对姓名" },
  agreement: { content: "<p>分销说明</p>" } };
const division = { id: 9, uid: 11, divisionName: "青山代理商", name: "Alice", phone: "13800138000",
  divisionInvite: 123456, images: ["/assets/one"], status: 2,
  addTime: 1727160000, statusTime: 1727163600, refusalReason: "请补充资质" };
const staff = { list: [{ uid: 33, avatar: "", nickname: "Test Staff", phone: "13800138033",
  spreadTime: 0, divisionPercent: 10, payCount: 0, orderCount: 2, numberCount: "0" }],
  count: 1, page: 1, limit: 20, brokerage: "0" };
const responses = new Map([
  ["/api/user/promoter/apply/info", promoter],
  ["/api/division/agent/apply/info", division],
  ["/api/agreement/2", { member_explain: { type: 2, status: 1, content: "<p>代理商协议</p>" } }],
  ["/api/division/agent/staff_list", staff],
]);
http.createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1:9191").pathname;
  console.log(request.method, path);
  const data = request.method === "GET" ? responses.get(path) : undefined;
  response.writeHead(data === undefined ? 404 : 200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ status: data === undefined ? 404 : 200,
    msg: data === undefined ? "fixture has no write response" : "ok", data: data ?? null }));
}).listen(9191, "127.0.0.1", () => console.log("FE003C_MOCK_READY 127.0.0.1:9191"));
