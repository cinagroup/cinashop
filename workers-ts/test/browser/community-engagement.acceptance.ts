import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { communityEngagementBrowserFixture } from "../helpers/communityEngagementBrowserFixture";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned engagement SQL"); return wiring.container; },
}));
type Row = Record<string, any>;
type Snapshot = Record<string, Row[]>;
const stable = (value: unknown): string => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
const sorted = (value: Snapshot): Snapshot => Object.fromEntries(Object.entries(value)
  .map(([name, rows]) => [name, rows.slice().sort((a, b) => stable(a).localeCompare(stable(b)))]));
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); length += value.length;
    expect(length).toBeLessThan(64_000); chunks.push(value); }
  return Buffer.concat(chunks);
}

it("actual H5 post engagement, lost committed receipts, share clipboard and every community surface with exact native receipts", async () => {
  const f = await communityEngagementBrowserFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40762", control = "/__community_engagement/" + randomUUID();
  const instructions = [
    ["mainLoaded", "外层账号11主列表：主帖点赞7/分享9，未点赞；无需打开详情"],
    ["cardLiked", "主卡片点赞一次：取消点赞8；没有打开详情"],
    ["detailLoaded", "点主帖标题：详情取消点赞8，真实详情浏览一次"],
    ["detailUnliked", "详情取消点赞：点赞7，背后卡片同步"],
    ["detailRefreshed", "详情刷新互动状态：只读state，浏览量不增加"],
    ["shareOpened", "详情分享：打开面板，先state核对，不记录分享"],
    ["copied", "面板复制帖子链接：真实剪贴板成功才计分享10；CUA另读剪贴板保存规范URL"],
    ["unknownLike", "关闭分享；详情点赞一次：已提交但503，出现互动结果未确认，禁止重复"],
    ["likeReopened", "关详情再点同一主帖：仍显示未确认；新增正常详情访问，不重放点赞"],
    ["likeReconciled", "点详情刷新互动状态：取消点赞8，解除未确认；本次state不增浏览"],
    ["unknownShare", "详情分享再复制：真实复制成功、分享已提交503，显示分享结果未确认；CUA再读URL"],
    ["shareReopened", "关闭分享和详情，重开主帖再开分享：复制仍被锁，未重放分享"],
    ["shareReconciled", "面板刷新互动状态：分享11，解除锁；本次state不增浏览"],
    ["otherPost", "关闭分享和详情，打开互动验收次帖：取消点赞4，分享6，没有主帖未知状态"],
    ["likedMembership", "外层账号11工作台，产品点击赞过：主帖和次帖都在"],
    ["likedRemoved", "赞过列表的次帖取消点赞一次：次帖自动移出，主帖仍在"],
    ["topicCard", "外层话题9：主卡片取消点赞一次，变点赞7；尚无新详情访问"],
    ["topicDetail", "话题卡片点主帖标题：详情点赞7，真实浏览一次"],
    ["searchCard", "外层搜索主帖：在卡片点赞一次，变取消点赞8"],
    ["searchDetail", "搜索结果点主帖标题：详情取消点赞8，真实浏览一次"],
    ["videoIndex", "外层无id视频index：首视频真实访问一次；视频点赞变取消点赞3"],
    ["videoState", "视频刷新互动状态：浏览量不增"],
    ["videoApp", "外层app视频显式id入口：真实访问一次；取消点赞回2"],
    ["oldBridge", "外层旧discoverDetails原始链接含spid11：实际注册页重定向workspace并打开主帖"],
    ["canonical", "外层规范workspace?id=主帖&spid=11：打开主帖，来源参数保留，本人来源不绑定推荐"],
    ["account22", "外层账号22主列表：主帖先未赞；产品卡片点赞一次，变取消点赞9"],
    ["account22Detail", "账号22打开主帖：取消点赞9，分享11，无账号11未知标记"],
    ["account11", "外层回账号11主列表：自己仍已赞，显示取消点赞9；次帖已取消"],
    ["finished", "375像素最终检查：29阶段/11次互动写入/11次精确详情浏览/外部provider零调用"],
  ] as const;
  const stages = instructions.map(([name]) => name);
  const plans = [
    { kind: "like", id: f.mainId, actor: 11, status: 1 }, { kind: "like", id: f.mainId, actor: 11, status: 0 },
    { kind: "share", id: f.mainId, actor: 11 }, { kind: "like", id: f.mainId, actor: 11, status: 1, lost: true },
    { kind: "share", id: f.mainId, actor: 11, lost: true }, { kind: "like", id: f.otherId, actor: 11, status: 0 },
    { kind: "like", id: f.mainId, actor: 11, status: 0 }, { kind: "like", id: f.mainId, actor: 11, status: 1 },
    { kind: "like", id: f.videoId, actor: 11, status: 1 }, { kind: "like", id: f.videoId, actor: 11, status: 0 },
    { kind: "like", id: f.mainId, actor: 22, status: 1 },
  ];
  const visitPlans = [f.mainId, f.mainId, f.mainId, f.otherId, f.mainId, f.mainId, f.videoId, f.videoId, f.mainId, f.mainId, f.mainId];
  const writeCounts = [0,1,1,2,2,2,3,4,4,4,5,5,5,5,5,6,7,7,8,8,9,9,10,10,10,11,11,11,11];
  const visitCounts = [0,0,1,1,1,1,1,1,2,2,2,3,3,4,4,4,4,5,5,6,7,7,8,9,10,10,11,11,11];
  const routes = {
    start: { uid: 11, route: "/pages/discover/index", label: "账号11主列表" },
    other: { uid: 22, route: "/pages/discover/index", label: "账号22主列表" },
    workspace: { uid: 11, route: "/pages/discover/workspace?author_id=self", label: "账号11工作台" },
    topic: { uid: 11, route: "/pages/discover/discoverTopic/index?id=9", label: "话题9" },
    search: { uid: 11, route: "/pages/discover/discoverSearch/index?keyword=" + encodeURIComponent("互动验收主帖"), label: "搜索主帖" },
    video: { uid: 11, route: "/pages/discover/discoverVideo/index", label: "无id首视频index" },
    app: { uid: 11, route: `/pages/discover/discoverVideo/app?id=${f.videoId}`, label: "视频app显式id" },
    old: { uid: 11, route: `/pages/discover/discoverDetails/index?id=${f.mainId}&spid=11`, label: "旧discoverDetails桥接" },
    canonical: { uid: 11, route: `/pages/discover/workspace?id=${f.mainId}&spid=11`, label: "规范含spid主帖" },
  };
  const traces: Row[] = [], evidence: Row[] = [], staticPaths = new Set<string>();
  let done!: () => void, fail!: (reason: Error) => void, finished = false;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External provider forbidden in owned engagement acceptance"));
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = "text/html") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(value);
  };
  const json = (res: ServerResponse, value: unknown, status = 200) => send(res, JSON.stringify(value), status, "application/json");
  let pending = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = pending.then(work); pending = next.then(() => {}, () => {}); return next;
  }
  try {
    wiring.container = f.container;
    const tables = (await f.db.select({ name: sql<string>`tablename` }).from(sql`pg_catalog.pg_tables`)
      .where(sql`schemaname = current_schema()`).orderBy(sql`tablename`)).map(row => row.name);
    expect(tables).toHaveLength(14);
    async function snapshot(): Promise<Snapshot> {
      const state: Snapshot = {};
      for (const name of tables) {
        expect(name).toMatch(/^[a-z_][a-z0-9_]*$/u);
        const rows = await f.db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`);
        state[name] = rows.map(row => row.row);
      }
      state.__sequences = await f.db.execute(sql`SELECT sequencename AS name, last_value::text AS last FROM pg_sequences
        WHERE schemaname = current_schema() ORDER BY sequencename`);
      return sorted(state);
    }
    const initial = await snapshot(); let expected = initial;
    const storage = { puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
      sha256: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, sha256: digest([...value.bytes]) }))) };
    const byId = (state: Snapshot, table: string, id: number) => state[table].find(row => row.id === id)!;
    const edges = (state: Snapshot, kind: string, actor: number, id: number) => state.community_relevance
      .filter(row => row.type === kind && row.left_id === actor && row.right_id === id);
    function advance(wanted: Snapshot, id: number) {
      const seq = wanted.__sequences.find(row => row.name === "community_relevance_id_seq")!;
      expect(seq).toBeDefined(); expect(id).toBe(seq.last === null ? 1 : Number(seq.last) + 1);
      wanted.__sequences = wanted.__sequences.map(row => row.name === seq.name ? { ...row, last: String(id) } : row);
    }
    function mutation(before: Snapshot, after: Snapshot, plan: Row, data: Row) {
      const wanted = structuredClone(before), post = byId(before, "community", plan.id);
      expect(post).toMatchObject({ status: 1, is_verify: 1, is_del: 0 });
      if (plan.kind === "share") {
        wanted.community = wanted.community.map(row => row.id === plan.id ? { ...row, share_num: row.share_num + 1 } : row);
        expect(data).toEqual({ shareNum: post.share_num + 1 });
        expect(after).toEqual(sorted(wanted)); return { kind: "share", post_id: plan.id, share_num_delta: 1, sequence_delta: 0 };
      }
      const old = edges(before, "community_like", plan.actor, plan.id), next = edges(after, "community_like", plan.actor, plan.id);
      expect(old).toHaveLength(plan.status ? 0 : 1); expect(next).toHaveLength(plan.status ? 1 : 0);
      if (plan.status) {
        expect(next[0]).toEqual({ id: next[0].id, left_id: plan.actor, right_id: plan.id, type: "community_like" });
        advance(wanted, next[0].id); wanted.community_relevance.push(next[0]);
      } else wanted.community_relevance = wanted.community_relevance.filter(row => row.id !== old[0].id);
      const delta = plan.status ? 1 : -1;
      wanted.community = wanted.community.map(row => row.id === plan.id ? { ...row, like_num: Math.max(0, row.like_num + delta) } : row);
      const changedProfiles = before.community_user.filter(row => row.type === post.type && row.relation_id === post.relation_id && row.is_del === 0);
      expect(changedProfiles).toHaveLength(1);
      wanted.community_user = wanted.community_user.map(row => changedProfiles.some(profile => profile.id === row.id)
        ? { ...row, like_num: Math.max(0, row.like_num + delta) } : row);
      expect(data).toEqual({ likeNum: Math.max(0, post.like_num + delta), status: plan.status }); expect(after).toEqual(sorted(wanted));
      return { kind: "like", post_id: plan.id, actor: plan.actor, desired_status: plan.status, like_num_delta: delta,
        exact_author_profile_ids: changedProfiles.map(row => row.id), inserted_relation_id: plan.status ? next[0].id : null,
        removed_relation_id: plan.status ? null : old[0].id, sequence_delta: plan.status ? 1 : 0 };
    }
    function browse(before: Snapshot, after: Snapshot, id: number, viewer: number, data: Row) {
      const wanted = structuredClone(before), post = byId(before, "community", id);
      expect(post).toMatchObject({ status: 1, is_verify: 1, is_del: 0 });
      wanted.community = wanted.community.map(row => row.id === id ? { ...row, play_num: row.play_num + 1 } : row);
      const old = edges(before, "community_browse", viewer, id), next = edges(after, "community_browse", viewer, id);
      if (viewer && !old.length) {
        expect(next).toHaveLength(1); expect(next[0]).toEqual({ id: next[0].id, left_id: viewer, right_id: id, type: "community_browse" });
        advance(wanted, next[0].id); wanted.community_relevance.push(next[0]);
      } else expect(next).toEqual(old);
      expect(data.playNum).toBe(post.play_num + 1); expect(after).toEqual(sorted(wanted));
      return { kind: "detail-visit", post_id: id, viewer, play_num_delta: 1,
        inserted_browse_relation_id: viewer && !old.length ? next[0].id : null, sequence_delta: viewer && !old.length ? 1 : 0 };
    }
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const body = await bytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const method = req.method ?? "GET", share = /^\/api\/community\/share\/\d+$/u.test(url.pathname);
        const write = method !== "GET" || share, detail = /^\/api\/community\/detail\/(\d+)$/u.exec(url.pathname);
        const viewer = headers.get("Authori-zation") === `Bearer ${f.token}` ? 11 : headers.get("Authori-zation") === `Bearer ${f.otherToken}` ? 22 : 0;
        const input = body.length ? JSON.parse(body.toString()) : undefined, plan = plans[traces.filter(row => row.write).length];
        if (write) {
          expect(plan).toBeDefined(); expect(viewer).toBe(plan.actor);
          expect(method).toBe(plan.kind === "share" ? "GET" : "POST");
          expect(url.pathname).toBe(`/api/community/${plan.kind}/${plan.id}`);
          expect(input).toEqual(plan.kind === "share" ? undefined : { status: plan.status });
        }
        if (detail) {
          const index = traces.filter(row => row.visit).length;
          expect(Number(detail[1])).toBe(visitPlans[index]); expect(viewer).toBe(index === 10 ? 22 : 11);
        }
        const before = await snapshot(); expect(before).toEqual(expected);
        const waits: Promise<unknown>[] = [], response = await app.fetch(new Request(url.href, { method, headers,
          ...(body.length ? { body } : {}) }), f.env, { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits); const raw = Buffer.from(await response.arrayBuffer());
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status); if (payload) expect(payload.status, payload.msg).toBe(200);
        if (detail || share || /^\/api\/community\/state\//u.test(url.pathname)) expect(response.headers.get("Cache-Control")).toBe("no-store");
        const after = await snapshot(), receipt = write ? mutation(before, after, plan, payload.data)
          : detail ? browse(before, after, Number(detail[1]), viewer, payload.data) : (expect(after).toEqual(before), undefined);
        expected = after;
        expect(after.community_user.filter(row => f.protectedProfileIds.includes(row.id))).toEqual(initial.community_user.filter(row => f.protectedProfileIds.includes(row.id)));
        expect(after.community.filter(row => f.protectedPostIds.includes(row.id))).toEqual(initial.community.filter(row => f.protectedPostIds.includes(row.id)));
        traces.push({ method, path: url.pathname, query: url.search, viewer, write, visit: Boolean(detail), status: response.status,
          browserStatus: write && plan.lost ? 503 : response.status, ...(write ? { plan, input } : {}),
          ...(url.pathname === "/api/community/like_list" ? { liked_ids: payload.data.list.map((row: Row) => row.id) } : {}),
          ...(payload?.data?.id ? { returned: { id: payload.data.id, likeNum: payload.data.likeNum, isLike: payload.data.isLike,
            shareNum: payload.data.shareNum, playNum: payload.data.playNum, site_url: payload.data.site_url } } : {}),
          ...(receipt ? { allowed_mutation: receipt } : {}),
          snapshot: { tables: tables.length, sequences: before.__sequences.length, before_sha256: digest(before), after_sha256: digest(after),
            read_unchanged: !write && !detail } });
        if (write && plan.lost) return json(res, { status: 503, msg: "本地验收：" + (plan.kind === "share" ? "分享" : "点赞") + "已提交但回执丢失，请刷新互动状态核对" }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function checkpoint(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        const index = evidence.length; expect(stage).toBe(stages[index]); expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(376);
        const current = await snapshot(); expect(current).toEqual(expected);
        expect(traces.filter(row => row.write)).toHaveLength(writeCounts[index]); expect(traces.filter(row => row.visit)).toHaveLength(visitCounts[index]);
        expect(data.actions.length).toBeGreaterThan(0); expect(data.theme.style).toContain("--view-theme:");
        const actor = ["account22", "account22Detail"].includes(stage) ? 22 : 11;
        for (const action of data.actions) {
          const row = byId(current, "community", action.id); expect(row).toBeDefined();
          if (!action.unknown) {
            expect(action.like).toBe(`${edges(current, "community_like", actor, action.id).length ? "取消点赞" : "点赞"} ${row.like_num}`);
            expect(action.share).toBe(`分享 ${row.share_num}`);
          } else {
            expect(action.likeDisabled).toBe(true);
            // Only the readonly panel entry is enabled; its write controls remain locked.
            expect(action.shareDisabled).toBe(false); expect(action.refreshDisabled).toBe(false);
          }
        }
        const hasAction = (id: number, scope: string) => data.actions.some((row: Row) => row.id === id && row.scope === scope);
        const hasDetail = (title: string) => expect(data.detailTitles).toEqual([title]);
        if (["mainLoaded", "cardLiked", "account22", "account11", "finished"].includes(stage)) {
          expect(data.href).toContain("/pages/discover/index"); expect(data.detailTitles).toEqual([]); expect(hasAction(f.mainId, "card")).toBe(true);
        }
        if (["detailLoaded", "detailUnliked", "detailRefreshed", "shareOpened", "copied", "unknownLike", "likeReopened", "likeReconciled",
          "unknownShare", "shareReopened", "shareReconciled", "topicDetail", "searchDetail", "oldBridge", "canonical", "account22Detail"].includes(stage)) hasDetail("互动验收主帖");
        if (stage === "otherPost") { hasDetail("互动验收次帖"); expect(data.actions.every((row: Row) => row.id !== f.otherId || !row.unknown)).toBe(true); }
        const unknown = ["unknownLike", "likeReopened", "unknownShare", "shareReopened"].includes(stage);
        if (unknown) {
          const affected = data.actions.filter((row: Row) => row.id === f.mainId); expect(affected.length).toBeGreaterThan(0);
          expect(affected.every((row: Row) => row.unknown)).toBe(true);
        }
        else expect(data.actions.some((row: Row) => row.unknown)).toBe(false);
        if (["shareOpened", "copied", "unknownShare", "shareReopened", "shareReconciled"].includes(stage)) {
          expect(data.sharePanels).toBe(1); expect(data.shareTitle).toContain("互动验收主帖");
          expect(data.copyDisabled).toBe(["unknownShare", "shareReopened"].includes(stage));
        } else expect(data.sharePanels).toBe(0);
        if (stage === "copied") expect(data.shareText).toContain("帖子链接已复制，分享意图已记录");
        if (["unknownShare", "shareReopened"].includes(stage)) expect(data.shareText).toContain("分享结果未确认");
        if (["detailRefreshed", "likeReconciled", "shareReconciled", "videoState"].includes(stage)) {
          const segment = traces.slice(evidence.at(-1)?.trace_count ?? 0);
          const states = segment.filter(row => row.path === `/api/community/state/${stage === "videoState" ? f.videoId : f.mainId}`);
          expect(states).toHaveLength(1); expect(states[0].snapshot.read_unchanged).toBe(true);
          expect(segment.some(row => row.write || row.visit)).toBe(false);
        }
        if (stage === "likedMembership" || stage === "likedRemoved") {
          expect(data.href).toContain("/pages/discover/workspace?author_id=self"); expect(data.chosenTab).toBe("赞过");
          expect(data.cardTitles).toEqual(stage === "likedMembership" ? ["互动验收次帖", "互动验收主帖"] : ["互动验收主帖"]);
          const last = traces.filter(row => row.path === "/api/community/like_list").at(-1)!;
          expect(last.liked_ids).toEqual(stage === "likedMembership" ? [f.otherId, f.mainId] : [f.mainId]);
        }
        if (stage === "topicCard" || stage === "topicDetail") { expect(data.href).toContain("/pages/discover/discoverTopic/index?id=9"); expect(hasAction(f.mainId, "card")).toBe(true); }
        if (stage === "searchCard" || stage === "searchDetail") { expect(data.href).toContain("/pages/discover/discoverSearch/index?keyword="); expect(data.cardTitles).toEqual(["互动验收主帖"]); }
        if (["videoIndex", "videoState", "videoApp"].includes(stage)) {
          expect(data.href).toContain(stage === "videoApp" ? `/pages/discover/discoverVideo/app?id=${f.videoId}` : "/pages/discover/discoverVideo/index");
          if (stage !== "videoApp") expect(new URL(data.href).hash).not.toContain("?id=");
          expect(data.videoTitle).toBe("互动验收视频"); expect(hasAction(f.videoId, "video")).toBe(true); expect(data.detailTitles).toEqual([]);
        }
        if (stage === "oldBridge" || stage === "canonical") {
          expect(data.requestedRoute).toBe(stage === "oldBridge" ? routes.old.route : routes.canonical.route);
          expect(data.href).toContain(`/pages/discover/workspace?id=${f.mainId}&spid=11`);
        }
        evidence.push({ stage, ...data, writes: writeCounts[index], detail_visits: visitCounts[index], trace_count: traces.length, database_sha256: digest(current) });
        if (stage === "finished") {
          expect(external).not.toHaveBeenCalled(); expect(traces.filter(row => row.browserStatus === 503)).toHaveLength(2);
          expect(f.bucket.put.mock.calls).toHaveLength(storage.puts); expect(f.bucket.delete.mock.calls).toHaveLength(storage.deletes);
          expect(digest([...f.objects].map(([key, value]) => ({ key, type: value.type, sha256: digest([...value.bytes]) })))).toBe(storage.sha256);
          finished = true;
          await writeFile("/tmp/cinashop-community-engagement-browser-evidence.json", JSON.stringify({ evidence, traces, tables,
            sequence_count: initial.__sequences.length, initial_sha256: digest(initial), final_sha256: digest(current),
            initial_posts: initial.community, final_posts: current.community, initial_profiles: initial.community_user, final_profiles: current.community_user,
            protected_profile_ids: f.protectedProfileIds, protected_post_ids: f.protectedPostIds, writes: plans, detail_visit_plan: visitPlans,
            providerCalls: 0, memory_r2_unchanged: storage, static_paths: [...staticPaths].sort(),
            clipboard: { expected_url: `${origin}/#/pages/discover/workspace?id=${f.mainId}&spid=11`,
              implementation: "actual H5 uni.setClipboardData without stub; independent CUA clipboard.readText must be saved separately" },
            authority: "Actual H5/createApp/JWT, process-owned native PG16 and memory R2; synthetic history/session/routes/chrome; only two committed interaction receipts replaced with503",
            limitations: "No production ACL/index/FK proof, no MP/App provider proof, no foreign referral binding proof (self-spid only); delayed/unmount races belong to separate runtime tests",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区帖子互动后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:850px;border:1px solid #ddd}pre{max-height:65px;overflow:auto}details{max-width:820px}</style>
<h1>实际 H5 帖子互动</h1>${Object.entries(routes).map(([key, value]) => `<button data-route="${key}">${value.label}</button>`).join("")}<button data-viewport="375">375像素内容区</button>
<details><summary>29阶段操作说明</summary><ol>${instructions.map(([stage, hint]) => `<li>${stage}：${hint}</li>`).join("")}</ol></details>
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}<pre id="result"></pre>
<iframe title="实际社区互动页面" allow="clipboard-write; clipboard-read"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};let requestedRoute='';
for(const button of document.querySelectorAll('[data-route]'))button.onclick=()=>{const r=routes[button.dataset.route];requestedRoute=r.route;
localStorage.setItem('uni_token',JSON.stringify({type:'string',data:r.uid===11?actor:other}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:r.uid}));
frame.src='/?community_engagement_session='+r.uid+'-'+Date.now()+'#'+r.route;};
// Size the actual layout content, excluding a desktop browser's native scrollbar.
// This changes only the outer fixture iframe, never product CSS or overflow.
document.querySelector('[data-viewport]').onclick=()=>{const d=frame.contentDocument;
frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
const visible=e=>{for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;};
const disabled=b=>!b||b.disabled===true||b.hasAttribute('disabled')||b.classList.contains('uni-button-disabled')||b.getAttribute('aria-disabled')==='true';
const txt=e=>(e?.textContent??'').trim().replace(/\\s+/g,' ');
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,host=d.querySelector('.theme-page'),panel=d.querySelector('.community-share-panel');
const data={href:frame.contentWindow.location.href,requestedRoute,width:d.documentElement.clientWidth,innerWidth:frame.contentWindow.innerWidth,scrollWidth:d.documentElement.scrollWidth,
actions:[...d.querySelectorAll('.community-post-actions')].filter(visible).map(e=>({id:Number(e.getAttribute('data-post-id')),scope:e.closest('.detail-sheet')?'detail':e.closest('.video-feature')?'video':'card',
like:txt(e.querySelector('.post-like')),share:txt(e.querySelector('.post-share')),unknown:txt(e).includes('互动结果未确认'),likeDisabled:disabled(e.querySelector('.post-like')),shareDisabled:disabled(e.querySelector('.post-share')),refreshDisabled:disabled(e.querySelector('.post-state-refresh')),text:txt(e)})),
detailTitles:[...d.querySelectorAll('.detail-sheet .detail-title,.detail-sheet .video-title')].filter(visible).map(txt),
cardTitles:[...d.querySelectorAll('.post-card .post-title')].filter(visible).map(txt),videoTitle:txt(d.querySelector('.video-feature .video-title')),
chosenTab:txt(d.querySelector('.source-tabs .chosen')),sharePanels:[...d.querySelectorAll('.community-share-panel')].filter(visible).length,
shareTitle:txt(panel?.querySelector('.community-share-title')),shareText:txt(panel),copyDisabled:disabled(panel?.querySelector('.community-copy-share')),
theme:{className:host?.className??'',style:host?.getAttribute('style')??''}};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path.startsWith(control + "/") && req.method === "POST") return checkpoint(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区互动验收", site_logo: "", record_No: "", ico_path: "" },
        "/api/share": { title: "本地社区", synopsis: "", img: "" }, "/api/diy/get_suspended": { is_show: 0, button: [] },
        "/api/v2/diy/color_change/color_change": {}, "/api/v2/diy/product_detail": {} };
      if (req.method === "GET" && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: "Synthetic navigation chrome only" });
      if (path.startsWith("/api/")) return api(req, res, url);
      if (path === "/favicon.ico") return send(res, "", 204);
      const target = resolve(root, "." + decodeURIComponent(path));
      if (target !== root && !target.startsWith(root + sep)) return send(res, "Owned build only", 403);
      try { if (target !== root && (await stat(target)).isFile()) { staticPaths.add(path); return send(res, await readFile(target), 200,
        ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml" } as Row)[extname(target)] ?? "application/octet-stream"); } }
      catch { /* Actual H5 SPA entry. */ }
      send(res, await readFile(resolve(root, "index.html")));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error)));
      if (!res.headersSent) send(res, String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(40762, "127.0.0.1", yes); });
      const ready = { url: origin + control, stages: instructions, routes, mainId: f.mainId, otherId: f.otherId, videoId: f.videoId,
        width: 375, expected_business_writes: plans, expected_detail_visits: visitPlans,
        clipboard_expected_url: `${origin}/#/pages/discover/workspace?id=${f.mainId}&spid=11`,
        clipboard_required: "真实复制后由CUA clipboard.readText独立读取并保存；不能用预期URL或DOM替代实际剪贴板证据" };
      await writeFile("/tmp/cinashop-community-engagement-browser-ready.json", JSON.stringify(ready, null, 2) + "\n");
      process.stdout.write("COMMUNITY_ENGAGEMENT_BROWSER_READY " + JSON.stringify(ready) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent within owned eight-minute window")), 8 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 9 * 60_000);
