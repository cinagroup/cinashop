import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { community, communityRelevance, communityUser, communityComment } from "@/models/schema";
import { communityAuthorFixture } from "../helpers/communityAuthorFixture";
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
it("actual H5 author workspace, gallery/video edits, unknown result recovery, exact deletion and viewer isolation", async () => {
  const f = await communityAuthorFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40751", control = "/__community_author/" + randomUUID();
  const stages = ["entry", "author", "liked", "description", "gallery", "uncertain", "recovered", "kept", "deleted", "other", "followed", "finished"];
  const traces: Row[] = [], evidence: Row[] = [];
  let loseVideoReply = true;
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
        const write = req.method !== "GET";
        expect(!write || ["/api/community/update_desc", `/api/community/community_update/${f.gallery.id}`, `/api/community/community_update/${f.clip.id}`, `/api/community_delete/${f.removable.id}`, "/api/community/set_interest/11"].includes(url.pathname)).toBe(true);
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method: req.method, headers,
          ...(body.length ? { body } : {}) }), f.env,
          { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer());
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status);
        if (payload) expect(payload.status, payload.msg).toBe(200);
        const lost = loseVideoReply && url.pathname === `/api/community/community_update/${f.clip.id}`;
        if (lost) loseVideoReply = false;
        traces.push({ method: req.method, path: url.pathname, query: url.search, status: response.status, browserStatus: lost ? 503 : response.status,
          ...(write && body.length ? { input: JSON.parse(body.toString()) } : {}),
          ...(url.pathname.startsWith("/api/assets/") ? { bytes: raw.length, contentRange: response.headers.get("Content-Range") } : {}) });
        if (lost) return json(res, { status: 503, msg: "Owned test: committed edit reply lost" }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        expect(stage).toBe(stages[evidence.length]);
        expect(data.scrollWidth).toBeLessThanOrEqual(data.width + 1);
        const posts = await f.db.select().from(community), relations = await f.db.select().from(communityRelevance);
        const users = await f.db.select().from(communityUser), comments = await f.db.select().from(communityComment);
        expect(posts).toHaveLength(5);
        if (stage === "entry") { expect(data.text).toContain("我的主页"); expect(data.text).not.toContain("管理员私有同号记录"); }
        if (stage === "author") {
          expect(data.href).toContain("/pages/discover/workspace?author_id=11");
          for (const title of ["我的图集", "我的视频", "可以删除的分享", "请补充视频说明"]) expect(data.text).toContain(title);
          expect(data.text).not.toContain("管理员私有同号记录");
        }
        if (stage === "liked") { expect(data.text).toContain("另一位作者的公开帖子"); expect(data.text).not.toContain("我的视频"); }
        if (stage === "description") { expect(users.find(row => row.type === 2 && row.relationId === 11)?.description).toBe("分享喜欢的日常"); expect(data.text).toContain("分享喜欢的日常"); }
        if (stage === "gallery") {
          expect(posts.find(row => row.id === f.gallery.id)).toMatchObject({ title: "图集修订", content: "已修改图文", image: f.image.url, sliderImage: JSON.stringify([f.image.url]), isVerify: 0 });
          expect(relations.filter(row => row.leftId === f.gallery.id && ["community_topic", "community_product"].includes(row.type))).toEqual([]);
          expect(data.images.some((row: Row) => row.width === 160)).toBe(true);
        }
        if (["uncertain", "recovered", "kept", "deleted", "other", "followed", "finished"].includes(stage)) {
          expect(posts.find(row => row.id === f.clip.id)).toMatchObject({ title: "视频修订", content: "已补充视频说明", image: f.image.url, videoUrl: f.video.url, isVerify: 0, refusal: "" });
          expect(traces.filter(row => row.path === `/api/community/community_update/${f.clip.id}`)).toHaveLength(1);
          if (stage === "uncertain") { expect(data.text).toContain("结果未确认"); expect(data.text).toContain("结束本次编辑并刷新作品"); }
          if (stage === "recovered") { expect(data.text).toContain("视频修订"); expect(data.text).not.toContain("结果未确认"); }
          const deleted = ["deleted", "other", "followed", "finished"].includes(stage);
          expect(posts.find(row => row.id === f.removable.id)?.isDel).toBe(deleted ? 1 : 0);
          expect(comments.find(row => row.id === f.comment.id)?.isDel).toBe(deleted ? 1 : 0);
          expect(traces.filter(row => row.path === `/api/community_delete/${f.removable.id}`)).toHaveLength(deleted ? 1 : 0);
        }
        if (["other", "followed", "finished"].includes(stage)) {
          for (const secret of ["图集修订", "视频修订", "管理员私有同号记录", "编辑简介"]) expect(data.text).not.toContain(secret);
          expect(data.text).toContain("暂无内容");
        }
        if (["followed", "finished"].includes(stage)) {
          expect(relations.filter(row => row.leftId === 22 && row.rightId === 11 && row.type === "community_interest")).toHaveLength(1);
          expect(data.text).toContain("已关注");
        }
        evidence.push({ stage, ...data });
        if (stage === "finished") {
          expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile("/tmp/cinashop-community-author-browser-evidence.json", JSON.stringify({
            evidence, traces, posts: posts.map(row => ({ id: row.id, isDel: row.isDel, contentType: row.contentType, isVerify: row.isVerify, videoUrl: row.videoUrl, image: row.image, sliderImage: row.sliderImage })),
            relations: relations.map(row => ({ type: row.type, post: row.leftId, id: row.rightId })),
            providerCalls: 0, authority: "Actual createApp/JWT and owned native PG16 ORM schema; seeded source histories and navigation chrome are synthetic",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区作者后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:850px;border:1px solid #ddd}pre{max-height:48px;overflow:auto}</style>
<h1>实际 H5 作者主页与帖子管理</h1><button id="start">打开社区</button><button id="other">切换另一账号看作者</button>
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}
<pre id="result"></pre><iframe title="实际社区页面"></iframe><script>
const frame=document.querySelector('iframe');
document.getElementById('start').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.src='/#/pages/discover/index';};
document.getElementById('other').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.otherToken)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:22}));frame.src='/#/pages/discover/workspace?author_id=11';};
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,data={href:frame.contentWindow.location.href,text:d.body.textContent,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,videos:[...d.querySelectorAll('video')].map(v=>({width:v.videoWidth,duration:v.duration,time:v.currentTime,poster:v.poster,error:v.error?.code??null})),images:[...d.querySelectorAll('img')].filter(i=>i.src.includes('/api/assets/')).map(i=>({width:i.naturalWidth,height:i.naturalHeight})),publishDisabled:[...d.querySelectorAll('uni-button,button')].find(b=>b.textContent.trim()==='发布')?.getAttribute('disabled')!==null};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path.startsWith(control + "/") && req.method === "POST") return action(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区作者验收", site_logo: "", record_No: "", ico_path: "" },
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
      process.stdout.write("COMMUNITY_AUTHOR_BROWSER_READY " + JSON.stringify({ url: origin + control }) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent")), 20 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
