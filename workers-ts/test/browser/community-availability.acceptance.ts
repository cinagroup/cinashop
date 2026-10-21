import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import { communityEngagementBrowserFixture } from "../helpers/communityEngagementBrowserFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(), createContainer: () => {
  if (!wiring.container) throw Error("Missing owned availability Browser SQL"); return wiring.container;
} }));
type Row = Record<string, any>; type Snapshot = Record<string, Row[]>;
const stable = (value: unknown): string => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
const sorted = (state: Snapshot): Snapshot => Object.fromEntries(Object.entries(state).map(([key, rows]) =>
  [key, rows.slice().sort((a, b) => stable(a).localeCompare(stable(b)))]));
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
async function bytes(req: IncomingMessage) { const chunks: Buffer[] = []; let length = 0;
  for await (const part of req) { const chunk = Buffer.from(part); length += chunk.length; expect(length).toBeLessThan(128_000); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
it("real background H5 community closure, unknown receipt, explicit state recovery and every entry family", async () => {
  const f = await communityEngagementBrowserFixture(), app = createApp(); wiring.container = f.container;
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5"), origin = "http://127.0.0.1:40765";
  const control = "/__community_availability/" + randomUUID(), prefix = "/tmp/cinashop-community-availability-browser-";
  const stages = ["openFeed", "unknownLike", "closedFeed", "reopenedUnknown", "reconciledLike", "stationClosed", "stationStillClosed", "stationReopened",
    "closedAuthor", "closedPeople", "closedTopic", "closedSearch", "closedVideo", "closedPublisher", "closedGuestPublish", "closedGuestEdit", "invalidRaw",
    "reopenedTopic", "deliberateDetail", "closedDetail", "detailRecovered", "finished"];
  const routes = {
    main: { uid: 11, route: "/pages/discover/workspace", label: "主列表账号11" },
    author: { uid: 11, route: "/pages/discover/workspace?author_id=22", label: "作者22" },
    people: { uid: 11, route: "/pages/discover/people?tab=follow", label: "关注列表" },
    topic: { uid: 11, route: "/pages/discover/discoverTopic/index?id=9", label: "话题九" },
    search: { uid: 11, route: "/pages/discover/discoverSearch/index", label: "搜索入口" },
    video: { uid: 11, route: `/pages/discover/discoverVideo/index?id=${f.videoId}`, label: "视频入口" },
    publisher: { uid: 11, route: "/pages/discover/discoverCreate/index?topic_id=9", label: "发布入口" },
    guestPublish: { uid: 0, route: "/pages/discover/workspace?publish=1", label: "游客发布" },
    guestEdit: { uid: 0, route: `/pages/discover/workspace?publish=1&edit_id=${f.gallery.id}`, label: "游客编辑" },
    invalid: { uid: 11, route: "/pages/discover/discoverCreate/index?id=1&id=2", label: "重复原始参数" },
    other: { uid: 22, route: "/pages/discover/workspace", label: "主列表账号22" },
  };
  const togglePlans = [
    ["unknownLike", "community_status", "0"], ["closedFeed", "community_status", "1"],
    ["reconciledLike", "station_open", "0"], ["stationStillClosed", "station_open", "1"],
    ["stationReopened", "community_status", "0"], ["invalidRaw", "community_status", "1"],
    ["deliberateDetail", "community_status", "0"], ["closedDetail", "community_status", "1"],
  ];
  const traces: Row[] = [], evidence: Row[] = [], configReceipts: Row[] = [], staticPaths = new Set<string>();
  let done!: () => void, fail!: (reason: Error) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Owned availability acceptance forbids providers"));
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = "text/html") => { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(value); };
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, "application/json");
  let pending = Promise.resolve(); function serial<T>(work: () => Promise<T>): Promise<T> { const next = pending.then(work); pending = next.then(() => {}, () => {}); return next; }
  try {
    await f.db.insert(systemConfig).values({ menuName: "station_open", value: "1" });
    const tables = (await f.db.select({ name: sql<string>`tablename` }).from(sql`pg_catalog.pg_tables`)
      .where(sql`schemaname=current_schema()`).orderBy(sql`tablename`)).map(row => row.name);
    async function snapshot(): Promise<Snapshot> {
      const state: Snapshot = {}; for (const name of tables) { expect(name).toMatch(/^[a-z_][a-z0-9_]*$/u);
        state[name] = (await f.db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`)).map(row => row.row); }
      state.__sequences = await f.db.execute(sql`SELECT sequencename AS name,last_value::text AS last FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`);
      return sorted(state);
    }
    const initial = await snapshot(); let expected = initial; expect(tables).toHaveLength(14); expect(initial.__sequences).toHaveLength(14);
    const storage = () => ({ objects: digest([...f.objects].map(([key, item]) => ({ key, type: item.type, bytes: [...item.bytes] }))),
      puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length });
    const initialStorage = storage();
    function advance(wanted: Snapshot, id: number) { const seq = wanted.__sequences.find(row => row.name === "community_relevance_id_seq")!;
      expect(id).toBe(seq.last === null ? 1 : Number(seq.last) + 1); seq.last = String(id); }
    function like(before: Snapshot, after: Snapshot, data: Row) {
      const wanted = structuredClone(before), post = before.community.find(row => row.id === f.mainId)!;
      const inserted = after.community_relevance.filter(row => row.type === "community_like" && row.left_id === 11 && row.right_id === f.mainId);
      expect(inserted).toHaveLength(1); expect(inserted[0]).toEqual({ id: inserted[0].id, left_id: 11, right_id: f.mainId, type: "community_like" });
      expect(before.community_relevance.some(row => row.type === "community_like" && row.left_id === 11 && row.right_id === f.mainId)).toBe(false);
      advance(wanted, inserted[0].id); wanted.community_relevance.push(inserted[0]);
      wanted.community = wanted.community.map(row => row.id === f.mainId ? { ...row, like_num: row.like_num + 1 } : row);
      const profiles = before.community_user.filter(row => row.type === post.type && row.relation_id === post.relation_id && !row.is_del); expect(profiles).toHaveLength(1);
      wanted.community_user = wanted.community_user.map(row => profiles.some(profile => profile.id === row.id) ? { ...row, like_num: row.like_num + 1 } : row);
      expect(data).toEqual({ likeNum: post.like_num + 1, status: 1 }); expect(after).toEqual(sorted(wanted));
      return { kind: "committed-like-with-503-receipt", post_id: f.mainId, author_profile_id: profiles[0].id, sequence_delta: 1 };
    }
    function browse(before: Snapshot, after: Snapshot, data: Row) {
      const wanted = structuredClone(before), post = before.community.find(row => row.id === f.mainId)!;
      const inserted = after.community_relevance.filter(row => row.type === "community_browse" && row.left_id === 11 && row.right_id === f.mainId);
      expect(inserted).toHaveLength(1); expect(inserted[0]).toEqual({ id: inserted[0].id, left_id: 11, right_id: f.mainId, type: "community_browse" });
      expect(before.community_relevance.some(row => row.type === "community_browse" && row.left_id === 11 && row.right_id === f.mainId)).toBe(false);
      advance(wanted, inserted[0].id); wanted.community_relevance.push(inserted[0]);
      wanted.community = wanted.community.map(row => row.id === f.mainId ? { ...row, play_num: row.play_num + 1 } : row);
      expect(data.id).toBe(f.mainId); expect(data.playNum).toBe(post.play_num + 1); expect(after).toEqual(sorted(wanted));
      return { kind: "one-deliberate-detail-visit", post_id: f.mainId, sequence_delta: 1 };
    }
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) { return serial(async () => {
      const body = await bytes(req), headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const method = req.method ?? "GET", likeIntent = method === "POST" && url.pathname === `/api/community/like/${f.mainId}`;
      const detail = /^\/api\/community\/detail\//u.test(url.pathname), write = method !== "GET" || /^\/api\/community\/share\//u.test(url.pathname);
      if (write) { expect(likeIntent).toBe(true); expect(JSON.parse(body.toString())).toEqual({ status: 1 }); expect(traces.filter(row => row.write)).toHaveLength(0); }
      const before = await snapshot(); expect(before).toEqual(expected); const waits: Promise<unknown>[] = [];
      const response = await app.fetch(new Request(url.href, { method, headers, ...(body.length ? { body } : {}) }), f.env,
        { waitUntil: work => { waits.push(work); }, passThroughOnException() {} } as ExecutionContext); await Promise.all(waits);
      const raw = Buffer.from(await response.arrayBuffer()), payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
      expect([200, 206]).toContain(response.status); const after = await snapshot(); let receipt: Row | undefined;
      if (likeIntent) { expect(payload.status).toBe(200); receipt = like(before, after, payload.data); }
      else if (detail && payload?.status === 200) { expect(url.pathname).toBe(`/api/community/detail/${f.mainId}`); expect(traces.some(row => row.receipt?.kind === "one-deliberate-detail-visit")).toBe(false); receipt = browse(before, after, payload.data); }
      else { expect(after).toEqual(before); if (payload) expect([200, 410010]).toContain(payload.status); }
      if (payload?.status === 410010) { expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(["社区暂未开放", "站点升级中，请稍候访问"]).toContain(payload.msg); }
      if (url.pathname === "/api/community/config") expect(response.headers.get("Cache-Control")).toBe("no-store");
      expected = after; expect(storage()).toEqual(initialStorage);
      traces.push({ path: url.pathname, query: url.search, method, write, detail, status: payload?.status ?? response.status, msg: payload?.msg,
        browser_status: likeIntent ? 503 : response.status, receipt, viewer: headers.get("Authori-zation") === `Bearer ${f.token}` ? 11 : headers.get("Authori-zation") === `Bearer ${f.otherToken}` ? 22 : 0,
        snapshot: { tables: tables.length, sequences: before.__sequences.length, before: digest(before), after: digest(after), unchanged: !receipt } });
      if (likeIntent) return json(res, { status: 503, msg: "本地验收：已点赞但回执丢失" }, 503);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
    }); }
    async function toggle(req: IncomingMessage, res: ServerResponse) { return serial(async () => {
      const input = JSON.parse((await bytes(req)).toString()), plan = togglePlans[configReceipts.length]; expect(plan).toBeDefined();
      expect(evidence.at(-1)?.stage).toBe(plan[0]); expect(input).toEqual({ key: plan[1], value: plan[2] });
      const before = await snapshot(); expect(before).toEqual(expected); const row = before.system_config.find(item => item.menu_name === input.key)!;
      const wanted = structuredClone(before); wanted.system_config = wanted.system_config.map(item => item.id === row.id ? { ...item, value: input.value } : item);
      await f.db.update(systemConfig).set({ value: input.value }).where(eq(systemConfig.id, row.id));
      // Deliberately retain a reverse stale cache value. The real gate and config
      // master flag must use fresh raw SQL instead of treating this as authority.
      f.cache.set("cfg_" + input.key, input.value === "0" ? "1" : "0");
      const after = await snapshot(); expect(after).toEqual(sorted(wanted)); expected = after;
      configReceipts.push({ key: input.key, before: row.value, after: input.value, stale_cache: f.cache.get("cfg_" + input.key), sequence_delta: 0, before_sha: digest(before), after_sha: digest(after) });
      json(res, { configurations: configReceipts.length, key: input.key, value: input.value });
    }); }
    async function checkpoint(req: IncomingMessage, res: ServerResponse, stage: string) { return serial(async () => {
      expect(stage).toBe(stages[evidence.length]); const data = JSON.parse((await bytes(req)).toString()); const current = await snapshot(); expect(current).toEqual(expected);
      expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(375); expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties/u);
      const actions = data.actions.find((item: Row) => item.id === String(f.mainId));
      const closed = stage.startsWith("closed") || ["stationClosed", "stationStillClosed"].includes(stage);
      if (closed) { expect(data.banner).toContain(stage.startsWith("station") ? "站点升级中，请稍候访问" : "社区暂未开放");
        expect(data.posts).toEqual([]); expect(data.detail).toBe(""); expect(data.publisher).toBe(""); expect(data.people).toEqual([]); expect(data.video).toBe("");
        expect(data.href).not.toContain("/pages/auth/login"); }
      if (["openFeed", "reopenedUnknown", "reconciledLike", "stationReopened", "finished"].includes(stage)) expect(data.posts).toContain("互动验收主帖");
      if (["unknownLike", "reopenedUnknown"].includes(stage)) { expect(actions?.unknown).toBe(true); expect(actions?.disabled).toBe(true); }
      if (["reconciledLike", "stationReopened"].includes(stage)) { expect(actions?.unknown).toBe(false); expect(actions?.disabled).toBe(false); expect(actions?.like).toContain("取消点赞 8"); }
      if (stage === "invalidRaw") { expect(data.text).toMatch(/无效|重复|错误/u); const segment = traces.slice(evidence.at(-1)?.traces ?? 0); expect(segment.every(row => row.path === "/api/get_script")).toBe(true); }
      if (stage === "reopenedTopic") { expect(data.posts).toContain("互动验收主帖"); expect(data.detail).toBe(""); }
      if (["deliberateDetail", "detailRecovered"].includes(stage)) expect(data.detail).toContain("互动验收主帖");
      const writes = traces.filter(row => row.write), visits = traces.filter(row => row.receipt?.kind === "one-deliberate-detail-visit");
      expect(writes).toHaveLength(evidence.length === 0 ? 0 : 1); expect(visits).toHaveLength(evidence.length < stages.indexOf("deliberateDetail") ? 0 : 1);
      if (stage === "detailRecovered") { const segment = traces.slice(evidence.at(-1)?.traces ?? 0); expect(segment.some(row => row.path === `/api/community/state/${f.mainId}`)).toBe(true); expect(segment.some(row => row.detail || row.write)).toBe(false); }
      if (stage === "finished") { expect(data.actions.find((item: Row) => item.id === String(f.mainId))?.like).toContain("点赞 8"); expect(traces.slice(evidence.at(-1)?.traces ?? 0).some(row => row.path === "/api/community/list" && row.viewer === 22)).toBe(true); }
      evidence.push({ stage, ...data, traces: traces.length, writes: writes.length, deliberate_visits: visits.length, database_sha: digest(current) });
      if (stage === "finished") { expect(configReceipts).toHaveLength(8); expect(external).not.toHaveBeenCalled(); expect(storage()).toEqual(initialStorage);
        await writeFile(prefix + "evidence.json", JSON.stringify({ evidence, traces, configReceipts, tables, sequences: initial.__sequences.length,
          initial_sha: digest(initial), final_sha: digest(current), initial_posts: initial.community, final_posts: current.community,
          initial_profiles: initial.community_user, final_profiles: current.community_user, storage: { initial: initialStorage, final: storage() }, providerCalls: 0,
          static_paths: [...staticPaths].sort(), authority: "Actual DOM H5/createApp/JWT/owned PG16; only route/session/viewport/configuration/checkpoint controls are synthetic; one real like committed before its503 receipt",
          limitations: "No production permissions, deployment, real login, remote KV/R2/provider or MP/App device claim; native tests separately prove in-flight admission and real Admin save/cache-refill behavior" }, null, 2) + "\n"); done(); }
      json(res, { checked: evidence.map(row => row.stage), finished: stage === "finished" });
    }); }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区关闭和恢复后台验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px;border:1px solid #ddd}pre{max-height:50px;overflow:auto}</style>
<h1>实际 H5 社区关闭与恢复</h1>${Object.entries(routes).map(([key, value]) => `<button data-route="${key}">${value.label}</button>`).join("")}
<button data-size>375像素内容区</button>${[["community_status", "0", "社区关闭"], ["community_status", "1", "社区开启"], ["station_open", "0", "站点关闭"], ["station_open", "1", "站点开启"]].map(([key, value, label]) => `<button data-key="${key}" data-value="${value}">${label}（仅fixture配置）</button>`).join("")}
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}<pre id="result"></pre><iframe title="实际社区页面"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const r=routes[b.dataset.route];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:r.uid===11?actor:r.uid===22?other:''}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:r.uid}));frame.src='/?availability_session='+r.uid+'-'+Date.now()+'#'+r.route;};
document.querySelector('[data-size]').onclick=()=>{const d=frame.contentDocument;frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
for(const b of document.querySelectorAll('[data-key]'))b.onclick=async()=>{const response=await fetch('${control}/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:b.dataset.key,value:b.dataset.value})});document.getElementById('result').textContent=JSON.stringify(await response.json());};
const visible=e=>{if(!e)return false;for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;};
const txt=e=>visible(e)?e.textContent.trim().replace(/\\s+/g,' '):'',disabled=e=>!e||e.disabled===true||e.hasAttribute('disabled')||e.classList.contains('uni-button-disabled');
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{const d=frame.contentDocument,all=s=>[...d.querySelectorAll(s)].filter(visible),text=all('body').map(txt).join(' '),data={href:frame.contentWindow.location.href,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text,banner:all('.community-availability').map(txt).join(' '),posts:all('.post-card .post-title').map(txt),detail:all('.detail-sheet').map(txt).join(' '),publisher:all('.publish-sheet').map(txt).join(' '),people:all('.person-name').map(txt),video:all('.video-feature').map(txt).join(' '),actions:all('.community-post-actions').map(e=>({id:e.dataset.postId,like:txt(e.querySelector('.post-like')),disabled:disabled(e.querySelector('.post-like')),unknown:txt(e).includes('互动结果未确认')}))};const response=await fetch('${control}/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path === control + "/toggle" && req.method === "POST") return toggle(req, res);
      if (path.startsWith(control + "/") && req.method === "POST") return checkpoint(req, res, path.slice(control.length + 1));
      const chrome: Row = { "/api/site_config": { site_name: "社区开关验收", site_logo: "", record_No: "", ico_path: "" },
        "/api/share": { title: "本地社区", synopsis: "", img: "" }, "/api/diy/get_suspended": { is_show: 0, button: [] },
        "/api/v2/diy/color_change/color_change": {}, "/api/v2/diy/product_detail": {} };
      if (req.method === "GET" && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: "Synthetic navigation chrome only" });
      if (path.startsWith("/api/")) return api(req, res, url);
      if (path === "/favicon.ico") return send(res, "", 204);
      const target = resolve(root, "." + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, "Owned build only", 403);
      try { if (target !== root && (await stat(target)).isFile()) { staticPaths.add(path); return send(res, await readFile(target), 200,
        ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" } as Row)[extname(target)] ?? "application/octet-stream"); } } catch { /* Actual SPA entry. */ }
      send(res, await readFile(resolve(root, "index.html")));
    })().catch(reason => { fail(reason instanceof Error ? reason : Error(String(reason))); if (!res.headersSent) send(res, String(reason), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try { await new Promise<void>((yes, no) => { server.once("error", no); server.listen(40765, "127.0.0.1", yes); });
      const ready = { url: origin + control, stages, routes, main_id: f.mainId, video_id: f.videoId, width: 375, business_writes: 1, deliberate_detail_visits: 1,
        fixture_configuration_changes: 8, controls: "Only synthetic routes/sessions,375 content size,stale-KV configuration toggles and checkpoints. All business intent must use actual product DOM; no API bridge." };
      await writeFile(prefix + "ready.json", JSON.stringify(ready, null, 2) + "\n"); process.stdout.write("COMMUNITY_AVAILABILITY_BROWSER_READY " + JSON.stringify(ready) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent within owned eight-minute window")), 8 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 9 * 60_000);
