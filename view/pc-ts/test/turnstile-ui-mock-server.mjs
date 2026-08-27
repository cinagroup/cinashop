import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const host = "127.0.0.1";
const port = Number(process.env.CINASHOP_TURNSTILE_MOCK_PORT ?? "4180");
const challenges = new Map();

function json(response, data, status = 200) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(body);
}

function envelope(response, data, message = "ok") {
  json(response, { status: 200, msg: message, data });
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8 * 1_024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function challengeHtml(key) {
  const safeKey = JSON.stringify(key).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全验证测试夹具</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:#f7f8fa;font-family:system-ui;color:#1f2937}
main{box-sizing:border-box;width:min(88vw,340px);padding:28px;text-align:center;background:#fff;border-radius:16px;box-shadow:0 12px 28px rgba(15,23,42,.08)}
button{border:0;border-radius:10px;padding:12px 20px;background:#2563eb;color:#fff;font-size:15px}p{color:#64748b;line-height:1.6}
</style></head><body><main><h1>本地安全验证</h1><p id="status">此页只用于验证客户端对话框和服务端状态复核。</p>
<button id="complete" type="button">完成模拟安全验证</button></main><script>
const key=${safeKey}; document.getElementById("complete").addEventListener("click",async()=>{
  const response=await fetch("/api/verify_code/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,turnstile_token:"local-ui-fixture"})});
  const body=await response.json(); if(body.status!==200) throw new Error(body.msg||"验证失败");
  document.getElementById("status").textContent="验证完成，正在返回登录页。";
  window.parent.postMessage({type:"cinashop:turnstile:complete",key},"*");
});
</script></body></html>`;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/verify_code") {
      const body = await readJson(request);
      if (!/^1\d{10}$/.test(String(body.phone ?? ""))) throw new Error("手机号格式错误");
      const key = randomUUID();
      challenges.set(key, { phone: body.phone, type: body.type, verified: false });
      envelope(response, {
        key,
        expire_time: 5,
        site_key: "local-fixture",
        action: "sms_send",
        challenge_url: `http://${host}:${port}/challenge?key=${encodeURIComponent(key)}`,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/challenge") {
      const key = url.searchParams.get("key") ?? "";
      if (!challenges.has(key)) {
        response.writeHead(404).end("invalid challenge");
        return;
      }
      const body = challengeHtml(key);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/verify_code/complete") {
      const body = await readJson(request);
      const challenge = challenges.get(String(body.key ?? ""));
      if (!challenge) throw new Error("挑战不存在");
      challenge.verified = true;
      envelope(response, { verified: true, expires_in: 300 }, "人机验证完成");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/verify_code/status") {
      const challenge = challenges.get(url.searchParams.get("key") ?? "");
      envelope(response, { verified: challenge?.verified === true, expires_in: 300 });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/register/verify") {
      const body = await readJson(request);
      const challenge = challenges.get(String(body.key ?? ""));
      if (
        !challenge?.verified ||
        challenge.phone !== body.phone ||
        challenge.type !== body.type
      ) throw new Error("挑战绑定不匹配");
      challenges.delete(String(body.key));
      envelope(response, { queued: true, expires_in: 300 }, "验证码任务已提交");
      return;
    }
    json(response, { status: 404, msg: "not found", data: null }, 404);
  } catch (error) {
    json(response, {
      status: 400,
      msg: error instanceof Error ? error.message : "request failed",
      data: null,
    });
  }
});

server.listen(port, host, () => {
  console.log(`turnstile UI mock listening on http://${host}:${port}`);
});
