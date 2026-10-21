import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { communityPeopleBrowserFixture } from "../helpers/communityPeopleBrowserFixture";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned social SQL"); return wiring.container; },
}));
type Row = Record<string, any>;
type Snapshot = Record<string, Row[]>;
function stable(value: unknown): string {
  const result = JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
  if (typeof result !== "string") throw Error("Missing owned snapshot value");
  return result;
}
const sorted = (snapshot: Snapshot): Snapshot => Object.fromEntries(Object.entries(snapshot)
  .map(([name, rows]) => [name, rows.slice().sort((a, b) => stable(a).localeCompare(stable(b)))]));
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length;
    expect(size).toBeLessThan(64000); chunks.push(value); }
  return Buffer.concat(chunks);
}

it("actual H5 social lists, exact pagination recovery, inline follow intent, unknown write reconciliation and viewer isolation", async () => {
  const f = await communityPeopleBrowserFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40751", control = "/__community_people/" + randomUUID();
  const stages = ["friends", "paginationError", "paginationRecovered", "follow", "kept", "unfollowed", "fans", "mutual",
    "recommend", "uncertain", "reconciled", "platformRemoved", "author", "other", "finished"];
  const expectedWrites = [
    { target: 22, status: 0 }, { target: 22, status: 1 }, { target: 0, status: 1 }, { target: 0, status: 0 },
  ];
  const stageWriteCounts = [0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4];
  const traces: Row[] = [], evidence: Row[] = [];
  let losePageReply = true, losePlatformReply = true, finished = false;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External provider not allowed in owned social test"));
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
    const tables = (await f.db.select({ name: sql<string>`tablename` }).from(sql`pg_catalog.pg_tables`)
      .where(sql`schemaname = current_schema()`).orderBy(sql`tablename`)).map(row => row.name);
    expect(tables).toContain("community_user"); expect(tables).toContain("community_relevance");
    async function snapshot(): Promise<Snapshot> {
      const result: Snapshot = {};
      for (const name of tables) {
        expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
        const rows = await f.db.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`);
        result[name] = Array.from(rows as unknown as Iterable<{ row: Row }>).map(value => value.row);
      }
      result.__sequences = await f.db.select({ name: sql<string>`sequencename`, last: sql<string | null>`last_value::text` })
        .from(sql`pg_catalog.pg_sequences`).where(sql`schemaname = current_schema()`).orderBy(sql`sequencename`);
      return sorted(result);
    }
    const initial = await snapshot(); let expected = initial;
    const canonical = (rows: Row[], uid: number) => rows.find(row => row.type === (uid === 0 ? 0 : 2) && row.relation_id === uid && row.is_del === 0)!;
    const spectatorIds = new Set(f.spectators.map(row => row.id));
    async function checkWrite(before: Snapshot, after: Snapshot, target: number, status: number) {
      const actor = canonical(before.community_user, 11), author = canonical(before.community_user, target);
      expect(actor).toBeDefined(); expect(author).toBeDefined();
      const old = before.community_relevance.filter(row => row.left_id === 11 && row.right_id === target && row.type === "community_interest");
      const next = after.community_relevance.filter(row => row.left_id === 11 && row.right_id === target && row.type === "community_interest");
      expect(old).toHaveLength(status === 1 ? 0 : 1); expect(next).toHaveLength(status === 1 ? 1 : 0);
      const wanted = structuredClone(before), delta = status === 1 ? 1 : -1;
      wanted.community_user = wanted.community_user.map(row => row.id === actor.id ? { ...row, follow_num: row.follow_num + delta }
        : row.id === author.id ? { ...row, fans_num: row.fans_num + delta } : row);
      if (status === 1) {
        expect(Number.isSafeInteger(next[0].id) && next[0].id > 0).toBe(true);
        expect(next[0]).toEqual({ id: next[0].id, left_id: 11, right_id: target, type: "community_interest" });
        const sequence = before.__sequences.find(row => row.name === "community_relevance_id_seq");
        expect(sequence).toBeDefined(); expect(Number.isSafeInteger(Number(sequence!.last))).toBe(true);
        expect(next[0].id).toBe(Number(sequence!.last) + 1);
        wanted.__sequences = wanted.__sequences.map(row => row.name === sequence!.name ? { ...row, last: String(Number(row.last) + 1) } : row);
        wanted.community_relevance.push(next[0]);
      } else wanted.community_relevance = wanted.community_relevance.filter(row => row.id !== old[0].id);
      expect(after).toEqual(sorted(wanted));
    }
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const body = await bytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const method = req.method ?? "GET", write = method !== "GET";
        const token = headers.get("Authori-zation"), viewer = token === `Bearer ${f.token}` ? 11 : token === `Bearer ${f.otherToken}` ? 22 : 0;
        const input = body.length ? JSON.parse(body.toString()) : undefined;
        const plan = expectedWrites[traces.filter(row => row.method !== "GET").length];
        if (write) {
          expect(plan).toBeDefined(); expect(method).toBe("POST"); expect(viewer).toBe(11);
          expect(url.pathname).toBe(`/api/community/set_interest/${plan.target}`);
          expect(input).toEqual({ status: plan.status });
        }
        const before = await snapshot(); expect(before).toEqual(expected);
        const waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method, headers, ...(body.length ? { body } : {}) }), f.env,
          { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits);
        const raw = Buffer.from(await response.arrayBuffer());
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status);
        if (payload) expect(payload.status, payload.msg).toBe(200);
        const after = await snapshot();
        if (write) { await checkWrite(before, after, plan.target, plan.status); expected = after; }
        else expect(after).toEqual(before);
        expect(after.community_user.filter(row => spectatorIds.has(row.id))).toEqual(initial.community_user.filter(row => spectatorIds.has(row.id)));
        const social = /^\/api\/community\/(?:user_friend|recommend_list|follow_list\/(?:follow|fans))$/.test(url.pathname);
        const authors = social ? payload?.data : undefined;
        if (social) {
          expect([11, 22]).toContain(viewer); expect(Array.isArray(authors)).toBe(true);
          for (const row of authors) {
            expect(row.type === 0 && row.relation_id === 0 || row.type === 2 && row.relation_id > 0).toBe(true);
            expect(row.author).not.toContain("异型旁观");
          }
        }
        const lostRead = losePageReply && method === "GET" && viewer === 11 && url.pathname === "/api/community/user_friend"
          && url.searchParams.get("page") === "2";
        const lostWrite = losePlatformReply && write && plan.target === 0 && plan.status === 1;
        if (lostRead) { losePageReply = false; expect(authors.map((row: Row) => row.relation_id)).toEqual([101, 22]); }
        if (lostWrite) losePlatformReply = false;
        traces.push({ method, viewer, path: url.pathname, query: url.search, status: response.status,
          browserStatus: lostRead || lostWrite ? 503 : response.status, ...(write ? { input } : {}),
          ...(social ? { authors: authors.map((row: Row) => ({ id: row.id, type: row.type, relation_id: row.relation_id, author: row.author,
            status: row.status, fans_num: row.fans_num, is_follow: row.is_follow, is_fans: row.is_fans })) } : {}),
          snapshot: { tables: tables.length, sequences: before.__sequences.length, before_sha256: digest(before), after_sha256: digest(after), read_unchanged: !write } });
        if (lostRead || lostWrite) return json(res, { status: 503,
          msg: lostRead ? "本地验收：第二页读取回执失败，请重试" : "本地验收：关注已提交但回执丢失" }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        expect(stage).toBe(stages[evidence.length]); expect(data.scrollWidth).toBeLessThanOrEqual(data.width + 1);
        const current = await snapshot(); expect(current).toEqual(expected);
        const writes = traces.filter(row => row.method !== "GET"); expect(writes).toHaveLength(stageWriteCounts[evidence.length]);
        const names = data.cards.map((card: Row) => card.name);
        for (const spectator of f.spectators) expect(data.text).not.toContain(spectator.nickname);
        expect(data.theme.style).toContain("--view-theme:");
        const pages = traces.filter(row => row.path === "/api/community/user_friend" && row.query.includes("page=2"));
        if (stage === "friends") {
          expect(data.href).toContain("/pages/discover/people?type=1"); expect(data.activeTab).toBe("好友");
          expect(names).toEqual(f.firstPageNames); expect(data.text).not.toContain("好友作者101"); expect(pages).toHaveLength(0);
        }
        if (stage === "paginationError") {
          expect(pages).toHaveLength(1); expect(pages[0].browserStatus).toBe(503);
          expect(data.text).toContain("第二页读取回执失败"); expect(data.text).toContain("重试加载");
          expect(names).toEqual(f.firstPageNames);
        }
        if (stage === "paginationRecovered") {
          expect(pages).toHaveLength(2); expect(pages[1].browserStatus).toBe(200);
          expect(pages.map(row => Object.fromEntries(new URLSearchParams(row.query)))).toEqual([
            { page: "2", limit: "20" }, { page: "2", limit: "20" },
          ]);
          expect(names).toEqual(f.allFriendNames); expect(new Set(names).size).toBe(22);
          expect(data.text).not.toContain("第二页读取回执失败"); expect(data.text).toContain("没有更多了");
        }
        if (stage === "follow" || stage === "kept") {
          expect(data.activeTab).toBe("关注"); expect(names).toEqual([f.authorName, "好友作者101"]);
          expect(data.cards[0].follow).toBe("互相关注"); expect(data.cards[0].confirming).toBe(stage === "follow");
          expect(data.cards[1].follow).toBe("已关注");
          expect(traces.some(row => row.path.endsWith("/follow_list/follow") && row.authors.some((author: Row) => author.relation_id === 101 && author.status === 0))).toBe(true);
        }
        if (stage === "unfollowed") { expect(data.activeTab).toBe("关注"); expect(names).toEqual(["好友作者101"]); }
        if (stage === "fans" || stage === "mutual") {
          expect(data.activeTab).toBe("粉丝"); expect(names).toEqual([f.authorName]);
          expect(data.cards[0].follow).toBe(stage === "fans" ? "回关" : "互相关注");
        }
        if (stage === "recommend") {
          expect(data.activeTab).toBe("推荐"); expect(names[0]).toBe(f.platformName);
          expect(data.cards[0].follow).toBe("关注"); expect(names).not.toContain("好友作者101"); expect(names).not.toContain(f.authorName);
        }
        if (stage === "uncertain") {
          expect(names).toEqual([]); expect(data.text).toContain("操作结果未确认"); expect(data.tabs.every((tab: Row) => tab.disabled)).toBe(true);
          expect(data.refreshDisabled).toBe(false);
        }
        if (stage === "reconciled") {
          expect(data.activeTab).toBe("推荐"); expect(names).not.toContain(f.platformName); expect(names).not.toContain("好友作者101");
          expect(data.text).toContain("已刷新，请核对关注状态"); expect(data.text).not.toContain("操作结果未确认");
          expect(writes.filter(row => row.path === "/api/community/set_interest/0")).toHaveLength(1);
        }
        if (stage === "platformRemoved") {
          expect(data.activeTab).toBe("关注"); expect(names).toEqual([f.authorName, "好友作者101"]);
          expect(writes.filter(row => row.path === "/api/community/set_interest/0").map(row => row.input.status)).toEqual([1, 0]);
        }
        if (stage === "author") {
          expect(data.href).toContain("/pages/discover/workspace?author_id=22"); expect(data.text).toContain("另一位作者的公开帖子");
          for (const secret of ["我的图集", "我的视频", "管理员私有同号记录", "编辑简介"]) expect(data.text).not.toContain(secret);
        }
        if (stage === "other" || stage === "finished") {
          expect(data.href).toContain("/pages/discover/people?type=2"); expect(data.activeTab).toBe("粉丝");
          expect(names).toEqual([f.actorName]); expect(data.cards[0].follow).toBe("互相关注");
          for (const uid of f.friendIds) expect(names).not.toContain(`好友作者${uid}`);
          expect(traces.some(row => row.viewer === 22 && row.path.endsWith("/follow_list/fans") && row.authors.length === 1 && row.authors[0].relation_id === 11)).toBe(true);
        }
        evidence.push({ stage, ...data, database_sha256: digest(current), writes: writes.length });
        if (stage === "finished") {
          expect(losePageReply).toBe(false); expect(losePlatformReply).toBe(false); expect(external).not.toHaveBeenCalled();
          expect(current.community_relevance.filter(row => row.type === "community_interest").map(row => [row.left_id, row.right_id]).sort())
            .toEqual([[11, 101], [11, 22], [22, 11]].sort());
          expect(current.community_user).toEqual(initial.community_user);
          finished = true;
          await writeFile("/tmp/cinashop-community-people-browser-evidence.json", JSON.stringify({ evidence, traces,
            tables, initial_sha256: digest(initial), final_sha256: digest(current), spectator_ids: [...spectatorIds],
            initial_profiles: initial.community_user, final_profiles: current.community_user,
            writes: expectedWrites, providerCalls: 0,
            authority: "Actual H5/createApp/JWT and owned native PG16; synthetic social histories, memory R2, navigation chrome and two lost replies only",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区好友后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:850px;border:1px solid #ddd}pre{max-height:48px;overflow:auto}</style>
<h1>实际 H5 好友、关注、粉丝与推荐</h1><button id="start">账号11打开好友</button><button id="other">切换账号22看粉丝</button>
<button id="narrow">375像素</button><button id="wide">390像素</button>
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}
<pre id="result"></pre><iframe title="实际社区好友页面"></iframe><script>
const frame=document.querySelector('iframe');
const session=(token,uid,query)=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}));frame.src='/?community_people_session='+uid+'-'+Date.now()+'#/pages/discover/people?type='+query;};
document.getElementById('start').onclick=()=>session(${JSON.stringify(f.token)},11,1);
document.getElementById('other').onclick=()=>session(${JSON.stringify(f.otherToken)},22,2);
document.getElementById('narrow').onclick=()=>{frame.style.width='375px';};document.getElementById('wide').onclick=()=>{frame.style.width='390px';};
const disabled=b=>b.disabled===true||b.hasAttribute('disabled')||b.classList.contains('uni-button-disabled')||b.getAttribute('aria-disabled')==='true';
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,host=d.querySelector('.theme-page'),data={href:frame.contentWindow.location.href,text:d.body.textContent,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,
activeTab:d.querySelector('.tab.active')?.textContent.trim()??'',tabs:[...d.querySelectorAll('.tab')].map(b=>({label:b.textContent.trim(),disabled:disabled(b)})),
cards:[...d.querySelectorAll('.person-entry')].map(row=>({name:row.querySelector('.person-name')?.textContent.trim(),stats:row.querySelector('.person-stats')?.textContent.trim(),follow:row.querySelector('.follow-button')?.textContent.trim(),confirming:!!row.querySelector('.unfollow-confirm')})),
refreshDisabled:[...d.querySelectorAll('.people-toolbar uni-button,.people-toolbar button')].filter(b=>b.textContent.trim()==='刷新列表').every(disabled),theme:{className:host?.className??'',style:host?.getAttribute('style')??''}};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path.startsWith(control + "/") && req.method === "POST") return action(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区好友验收", site_logo: "", record_No: "", ico_path: "" },
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
      process.stdout.write("COMMUNITY_PEOPLE_BROWSER_READY " + JSON.stringify({ url: origin + control, stages, firstPage: f.firstPageNames, secondPage: ["好友作者101", f.authorName] }) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent")), 20 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
