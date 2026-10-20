import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { community, systemAttachment } from "@/models/schema";
import { communityVideoFixture } from "../helpers/communityVideoFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned video SQL"); return wiring.container; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length;
    expect(size).toBeLessThan(64000); chunks.push(value); }
  return Buffer.concat(chunks);
}
it("actual H5 file selection, private video upload, pending publication, playback and uncertain save", async () => {
  const f = await communityVideoFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40751", control = "/__community_video/" + randomUUID();
  const stages = ["entry", "uploaded", "published", "played", "unknown", "finished"];
  const traces: Row[] = [], evidence: Row[] = [];
  let loseReply = false, finished = false, done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External provider not allowed in owned video test"));
  const send = (res: ServerResponse, body: string | Buffer, status = 200, type = "text/html") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body);
  };
  const json = (res: ServerResponse, data: unknown, status = 200) => send(res, JSON.stringify(data), status, "application/json");
  let pendingApi = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = pendingApi.then(work); pendingApi = result.then(() => {}, () => {}); return result;
  }
  try {
    wiring.container = f.container;
    f.cache.set("cfg_community_video_verify", "1"); f.cache.set("cfg_community_verify", "1");
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const body = await bytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const write = req.method === "POST";
        expect(!write || ["/api/upload/video", "/api/community_save"].includes(url.pathname)).toBe(true);
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method: req.method, headers,
          ...(body.length ? { body } : {}) }), f.env,
          { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer());
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status);
        if (payload) expect(payload.status, payload.msg).toBe(200);
        const lost = loseReply && url.pathname === "/api/community_save";
        traces.push({ method: req.method, path: url.pathname, status: response.status, browserStatus: lost ? 503 : response.status,
          ...(url.pathname === "/api/community_save" ? { input: JSON.parse(body.toString()) } : {}),
          ...(url.pathname.startsWith("/api/assets/") ? { bytes: raw.length, contentRange: response.headers.get("Content-Range") } : {}) });
        if (lost) return json(res, { status: 503, msg: "Synthetic lost committed save reply" }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        if (stage === "lose-reply") { loseReply = true; return json(res, { armed: true }); }
        expect(stage).toBe(stages[evidence.length]);
        expect(data.scrollWidth).toBeLessThanOrEqual(data.width + 1);
        const posts = await f.db.select().from(community), attachments = await f.db.select().from(systemAttachment);
        if (stage === "entry") { expect(data.text).toContain("发布"); expect(posts).toHaveLength(0); }
        if (stage === "uploaded") {
          expect(attachments).toHaveLength(1); expect(posts).toHaveLength(0);
          expect(data.text).toContain("已上传"); expect(data.videos[0].width).toBe(160); expect(data.videos[0].duration).toBe(2);
        }
        if (stage === "published" || stage === "played") {
          expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ contentType: 2, relationId: 11, isVerify: 0,
            videoUrl: `/api/assets/${attachments[0].attId}`, content: "后台验收：真实上传后播放" });
          expect(data.text).toContain("后台验收"); expect(data.videos[0].width).toBe(160);
          if (stage === "played") expect(data.videos[0].time).toBeGreaterThan(0);
        }
        if (stage === "unknown" || stage === "finished") {
          expect(posts).toHaveLength(2); expect(attachments).toHaveLength(1);
          expect(traces.filter(row => row.path === "/api/community_save")).toHaveLength(2);
          if (stage === "finished") expect(data.text).not.toContain("发布帖子");
          if (stage === "unknown") { expect(data.text).toContain("勿重复发布"); expect(data.publishDisabled).toBe(true); }
        }
        evidence.push({ stage, ...data });
        if (stage === "finished") {
          expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile("/tmp/cinashop-community-video-browser-evidence.json", JSON.stringify({
            evidence, traces, posts: posts.map(row => ({ id: row.id, contentType: row.contentType, isVerify: row.isVerify, videoUrl: row.videoUrl })),
            attachments: attachments.map(row => ({ id: row.attId, owner: row.relationId, fileType: row.fileType })),
            providerCalls: 0, authority: "Actual createApp/JWT and owned native PG16 ORM schema; R2 byte storage and navigation chrome are synthetic",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区视频后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:850px;border:1px solid #ddd}pre{max-height:48px;overflow:auto}</style>
<h1>实际 H5 视频发布</h1><button id="start">打开社区</button>
${[...stages, "lose-reply"].map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}
<pre id="result"></pre><iframe title="实际社区页面"></iframe><script>
const frame=document.querySelector('iframe');
document.getElementById('start').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.src='/#/pages/discover/index';};
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,data={href:frame.contentWindow.location.href,text:d.body.textContent,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,videos:[...d.querySelectorAll('video')].map(v=>({width:v.videoWidth,duration:v.duration,time:v.currentTime,error:v.error?.code??null})),publishDisabled:[...d.querySelectorAll('uni-button,button')].find(b=>b.textContent.trim()==='发布')?.getAttribute('disabled')!==null};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path.startsWith(control + "/") && req.method === "POST") return action(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区视频验收", site_logo: "", record_No: "", ico_path: "" },
        "/api/share": { title: "本地社区", synopsis: "", img: "" }, "/api/diy/get_suspended": { is_show: 0, button: [] },
        "/api/v2/diy/color_change/color_change": {}, "/api/v2/diy/product_detail": {} };
      if (req.method === "GET" && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: "Synthetic navigation chrome only" });
      if (path.startsWith("/api/")) return api(req, res, url);
      if (path === "/favicon.ico") return send(res, "", 204);
      const target = resolve(root, "." + decodeURIComponent(path));
      if (target !== root && !target.startsWith(root + sep)) return send(res, "Owned build only", 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" } as Row)[extname(target)] ?? "application/octet-stream"); }
      catch { /* SPA entry */ }
      send(res, await readFile(resolve(root, "index.html")));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error)));
      if (!res.headersSent) send(res, String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(40751, "127.0.0.1", yes); });
      process.stdout.write("COMMUNITY_VIDEO_BROWSER_READY " + JSON.stringify({ url: origin + control }) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent")), 20 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
