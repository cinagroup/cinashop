import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { community, communityRelevance } from "@/models/schema";
import { communityRelationsFixture } from "../helpers/communityRelationsFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned relation SQL"); return wiring.container; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length;
    expect(size).toBeLessThan(64000); chunks.push(value); }
  return Buffer.concat(chunks);
}
it("actual H5 topic and product selection, pagination, search, publication and topic navigation", async () => {
  const f = await communityRelationsFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40751", control = "/__community_relations/" + randomUUID();
  const stages = ["entry", "topics", "pay", "more", "search", "visit", "selected", "published", "topic", "finished"];
  const traces: Row[] = [], evidence: Row[] = [];
  let finished = false, done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External provider not allowed in owned relation test"));
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
        expect(!write || url.pathname === "/api/community_save").toBe(true);
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method: req.method, headers,
          ...(body.length ? { body } : {}) }), f.env,
          { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer());
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status);
        if (payload) expect(payload.status, payload.msg).toBe(200);
        traces.push({ method: req.method, path: url.pathname, query: url.search, status: response.status, browserStatus: response.status,
          ...(url.pathname === "/api/community_save" ? { input: JSON.parse(body.toString()) } : {}),
          ...(url.pathname.startsWith("/api/assets/") ? { bytes: raw.length, contentRange: response.headers.get("Content-Range") } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        expect(stage).toBe(stages[evidence.length]);
        expect(data.scrollWidth).toBeLessThanOrEqual(data.width + 1);
        const posts = await f.db.select().from(community), relations = await f.db.select().from(communityRelevance);
        if (stage === "entry") { expect(data.text).toContain("发布"); expect(posts).toHaveLength(0); }
        if (stage === "topics") { expect(data.text).toContain("已选 · 本地视频"); expect(data.text).toContain("已选 · 生活话题10"); }
        if (stage === "pay") { expect(data.text).toContain("已购好物111"); expect(data.text).not.toContain("已购好物101"); }
        if (stage === "more") expect(data.text).toContain("已选 · 已购好物101");
        if (stage === "search") { expect(data.text).toContain("已选 · 收藏茶杯"); expect(traces.some(row => row.path === "/api/community/product_list" && row.query.includes("keyword=" + encodeURIComponent("茶杯")))).toBe(true); }
        if (stage === "visit") expect(data.text).toContain("已选 · 浏览餐盘");
        if (stage === "selected") {
          expect(data.text).toContain("选择话题（2/5）"); expect(data.text).toContain("添加商品（3/5）");
          expect(data.text).not.toContain("移除商品：已购好物101"); expect(posts).toHaveLength(0);
        }
        if (["published", "topic", "finished"].includes(stage)) {
          expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ content: "后台验收：话题和商品关联", relationId: 11, isVerify: 0 });
          expect(relations.filter(row => row.type === "community_topic").map(row => row.rightId).sort()).toEqual([9,10].sort());
          expect(relations.filter(row => row.type === "community_product").map(row => row.rightId).sort()).toEqual([111,201,301]);
          const writes = traces.filter(row => row.path === "/api/community_save"); expect(writes).toHaveLength(1);
          expect(writes[0].input).toMatchObject({ topic_id: [9,10], product_id: [111,201,301] });
          if (stage === "published") { expect(data.text).toContain("相关商品 · 当前价格"); expect(data.text).toContain("收藏茶杯"); expect(data.text).toContain("浏览餐盘"); }
          else { expect(data.href).toContain("/pages/discover/discoverTopic/index?id=9"); expect(data.text).toContain("本地视频"); expect(data.text).not.toContain("后台验收：话题和商品关联"); }
        }
        evidence.push({ stage, ...data });
        if (stage === "finished") {
          expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile("/tmp/cinashop-community-relations-browser-evidence.json", JSON.stringify({
            evidence, traces, posts: posts.map(row => ({ id: row.id, contentType: row.contentType, isVerify: row.isVerify, videoUrl: row.videoUrl, image: row.image, sliderImage: row.sliderImage })),
            relations: relations.map(row => ({ type: row.type, post: row.leftId, id: row.rightId })),
            providerCalls: 0, authority: "Actual createApp/JWT and owned native PG16 ORM schema; seeded source histories and navigation chrome are synthetic",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区关联后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:850px;border:1px solid #ddd}pre{max-height:48px;overflow:auto}</style>
<h1>实际 H5 话题和商品关联</h1><button id="start">打开社区</button>
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}
<pre id="result"></pre><iframe title="实际社区页面"></iframe><script>
const frame=document.querySelector('iframe');
document.getElementById('start').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.src='/#/pages/discover/index';};
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,data={href:frame.contentWindow.location.href,text:d.body.textContent,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,videos:[...d.querySelectorAll('video')].map(v=>({width:v.videoWidth,duration:v.duration,time:v.currentTime,poster:v.poster,error:v.error?.code??null})),images:[...d.querySelectorAll('img')].filter(i=>i.src.includes('/api/assets/')).map(i=>({width:i.naturalWidth,height:i.naturalHeight})),publishDisabled:[...d.querySelectorAll('uni-button,button')].find(b=>b.textContent.trim()==='发布')?.getAttribute('disabled')!==null};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path.startsWith(control + "/") && req.method === "POST") return action(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区关联验收", site_logo: "", record_No: "", ico_path: "" },
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
      process.stdout.write("COMMUNITY_RELATIONS_BROWSER_READY " + JSON.stringify({ url: origin + control }) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent")), 20 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
