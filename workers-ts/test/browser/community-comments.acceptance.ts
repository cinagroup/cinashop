import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { communityCommentsBrowserFixture } from "../helpers/communityCommentsBrowserFixture";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned comment SQL"); return wiring.container; },
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
    expect(size).toBeLessThan(64_000); chunks.push(value); }
  return Buffer.concat(chunks);
}

it("actual H5 complete comment threads across main, workspace, search and both video routes with exact native receipts", async () => {
  const f = await communityCommentsBrowserFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40761", control = "/__community_comments/" + randomUUID();
  const instructions = [
    ["roots", "账号11打开主帖，确认前10根、两个本人隐藏根及平台作者"],
    ["rootError", "更多评论，真实第2页回执503，保留前10根"],
    ["rootRecovered", "重试评论，原第2页恢复，13根已显示"],
    ["replyError", "展开分页回复根，更多回复，第2页503且保留前10子回复"],
    ["replyRecovered", "重试回复，原第2页恢复，12子回复全部显示"],
    ["rootReply", "回复分页回复根，输入根回复验收并发送"],
    ["childReply", "再展开分页回复根，回复分页子回复2001，输入子回复验收并发送"],
    ["liked", "给分页回复根点赞一次"], ["unliked", "给同一根取消点赞一次"],
    ["deleteIntent", "请求删除级联删除根，确认行内删除提示出现，零写入"],
    ["kept", "点击保留评论，删除提示消失，零写入"],
    ["hiddenChildDeleted", "展开本人隐藏根，删除本人隐藏子回复并确认"],
    ["hiddenRootDeleted", "删除本人隐藏根并确认"],
    ["cascadeDeleted", "删除级联删除根并确认，两个孩子及其点赞关系精确级联"],
    ["pending", "外层启用待审，产品输入待审验收并发送，显示等待审核"],
    ["unknown", "外层恢复直接发布，产品输入唯一未知验收并发送，提交后503且锁定"],
    ["reopened", "关闭详情后再次打开评论验收主帖，仍须主动刷新且无重放"],
    ["reconciled", "点击刷新评论核对结果，唯一未知验收恰好一条"],
    ["otherPost", "关闭主帖，打开评论验收次帖，仅有次帖独立评论"],
    ["otherAccount", "外层切换账号22，打开主帖，可见其他账号隐藏根而看不到账号11隐藏根"],
    ["workspace", "外层账号11工作台，打开主帖，同一个完整评论组件"],
    ["search", "外层账号11搜索，点击主帖，真实detail及完整评论组件"],
    ["videoIndex", "外层视频index，点击查看视频评论，可见视频入口评论"],
    ["videoApp", "外层视频app，点击查看视频评论，可见同一视频入口评论"],
    ["finished", "375像素下保存最终检查；所有25阶段、9次写入与配置收据完成"],
  ] as const;
  const stages = instructions.map(([stage]) => stage);
  const plans: Row[] = [
    { kind: "create", target: 1011, content: "根回复验收", verify: 1 },
    { kind: "create", target: 2001, content: "子回复验收", verify: 1 },
    { kind: "like", target: 1011, status: 1 }, { kind: "like", target: 1011, status: 0 },
    { kind: "delete", target: 2101 }, { kind: "delete", target: 1010 }, { kind: "delete", target: 1008 },
    { kind: "create", target: 0, content: "待审验收", verify: 0 },
    { kind: "create", target: 0, content: "唯一未知验收", verify: 1 },
  ];
  const stageWriteCounts = [0, 0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
  const traces: Row[] = [], evidence: Row[] = [], controls: Row[] = [];
  let loseRoot = true, loseReply = true, loseCreate = true, finished = false;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External provider forbidden in owned comment acceptance"));
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
    expect(tables).toContain("community_comment"); expect(tables).toContain("community_relevance");
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
    const protectedIds = new Set(f.protectedCommentIds);
    const byId = (state: Snapshot, table: string, id: number) => state[table].find(row => row.id === id)!;
    const publicComment = (row: Row) => row.is_del === 0 && row.is_show === 1 && row.is_verify === 1;
    function counts(wanted: Snapshot, rootIds: number[]) {
      wanted.community = wanted.community.map(row => row.id === f.mainId ? { ...row,
        comment_num: wanted.community_comment.filter(comment => comment.community_id === f.mainId && publicComment(comment)).length } : row);
      wanted.community_comment = wanted.community_comment.map(row => rootIds.includes(row.id) ? { ...row,
        comment_num: wanted.community_comment.filter(child => child.reply_id === row.id && publicComment(child)).length } : row);
    }
    function advance(wanted: Snapshot, name: string, id: number) {
      const sequence = wanted.__sequences.find(row => row.name === `${name}_id_seq`);
      expect(sequence).toBeDefined(); expect(Number.isSafeInteger(Number(sequence!.last))).toBe(true);
      expect(id).toBe(Number(sequence!.last) + 1);
      wanted.__sequences = wanted.__sequences.map(row => row.name === sequence!.name ? { ...row, last: String(id) } : row);
    }
    function likeRelations(state: Snapshot, target: number, actor: number) {
      return state.community_relevance.filter(row => row.type === "community_comment_like" && row.left_id === actor && row.right_id === target);
    }
    function checkMutation(before: Snapshot, after: Snapshot, plan: Row, data: Row, started: number, ended: number) {
      const wanted = structuredClone(before);
      let changedComments: number[] = [], removedRelations: number[] = [], insertedRelations: number[] = [];
      if (plan.kind === "create") {
        const added = after.community_comment.filter(row => !before.community_comment.some(old => old.id === row.id));
        expect(added).toHaveLength(1); const row = added[0], target = plan.target ? byId(before, "community_comment", plan.target) : undefined;
        expect(row.add_time).toBeGreaterThanOrEqual(started); expect(row.add_time).toBeLessThanOrEqual(ended);
        const rootId = target ? target.is_reply === 1 ? target.id : target.reply_id : 0;
        const parent = rootId ? byId(before, "community_comment", rootId) : undefined;
        expect(row).toEqual({ id: row.id, type: 2, uid: 11, reply_id: rootId, reply_uid: parent?.uid ?? 0,
          comment_reply_id: target?.is_reply === 0 ? target.id : 0,
          comment_reply_uid: target?.is_reply === 0 ? target.uid : 0,
          community_id: f.mainId, nickname: "", avatar: "", comment_num: 0, like_num: 0,
          content: plan.content, ip: "", city: "", is_verify: plan.verify, is_show: 1,
          is_reply: target ? 0 : 1, is_del: 0, update_time: 0, add_time: row.add_time });
        advance(wanted, "community_comment", row.id); wanted.community_comment.push(row); counts(wanted, rootId ? [rootId] : []);
        expect(data).toEqual({ id: row.id, is_verify: plan.verify,
          post_comment_num: byId(wanted, "community", f.mainId).comment_num });
        changedComments = [row.id, ...(rootId ? [rootId] : [])];
      } else if (plan.kind === "like") {
        const row = byId(before, "community_comment", plan.target), old = likeRelations(before, plan.target, 11), next = likeRelations(after, plan.target, 11);
        expect(old).toHaveLength(plan.status ? 0 : 1); expect(next).toHaveLength(plan.status ? 1 : 0);
        if (plan.status) {
          expect(next[0]).toEqual({ id: next[0].id, left_id: 11, right_id: plan.target, type: "community_comment_like" });
          advance(wanted, "community_relevance", next[0].id); wanted.community_relevance.push(next[0]); insertedRelations = [next[0].id];
        } else { wanted.community_relevance = wanted.community_relevance.filter(edge => edge.id !== old[0].id); removedRelations = [old[0].id]; }
        wanted.community_comment = wanted.community_comment.map(comment => comment.id === plan.target
          ? { ...comment, like_num: row.like_num + (plan.status ? 1 : -1) } : comment);
        expect(data).toEqual({ likeNum: row.like_num + (plan.status ? 1 : -1), status: plan.status }); changedComments = [plan.target];
      } else {
        expect(data).toBeNull(); const row = byId(before, "community_comment", plan.target);
        expect(row.type).toBe(2); expect(row.uid).toBe(11);
        changedComments = before.community_comment.filter(comment => comment.is_del === 0
          && (comment.id === row.id || row.is_reply === 1 && comment.reply_id === row.id)).map(comment => comment.id);
        wanted.community_comment = wanted.community_comment.map(comment => changedComments.includes(comment.id) ? { ...comment, is_show: 0, is_del: 1 } : comment);
        removedRelations = before.community_relevance.filter(edge => edge.type === "community_comment_like" && changedComments.includes(edge.right_id)).map(edge => edge.id);
        wanted.community_relevance = wanted.community_relevance.filter(edge => !removedRelations.includes(edge.id));
        counts(wanted, [row.is_reply === 1 ? row.id : row.reply_id]);
      }
      expect(after).toEqual(sorted(wanted));
      return { changed_comment_ids: changedComments, removed_relation_ids: removedRelations, inserted_relation_ids: insertedRelations,
        post_comment_num: byId(after, "community", f.mainId).comment_num,
        changed_comments: after.community_comment.filter(row => changedComments.includes(row.id)) };
    }
    function checkBrowse(before: Snapshot, after: Snapshot, postId: number, viewer: number) {
      const wanted = structuredClone(before), post = byId(before, "community", postId);
      expect(post.status).toBe(1); expect(post.is_verify).toBe(1); expect(post.is_del).toBe(0);
      wanted.community = wanted.community.map(row => row.id === postId ? { ...row, play_num: row.play_num + 1 } : row);
      const old = before.community_relevance.filter(row => row.type === "community_browse" && row.left_id === viewer && row.right_id === postId);
      const next = after.community_relevance.filter(row => row.type === "community_browse" && row.left_id === viewer && row.right_id === postId);
      if (viewer && !old.length) {
        expect(next).toHaveLength(1); expect(next[0]).toEqual({ id: next[0].id, type: "community_browse", left_id: viewer, right_id: postId });
        advance(wanted, "community_relevance", next[0].id); wanted.community_relevance.push(next[0]);
      } else expect(next).toEqual(old);
      expect(after).toEqual(sorted(wanted));
      return { post_id: postId, play_num_delta: 1, inserted_browse_relation: viewer && !old.length ? next[0].id : null };
    }
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const body = await bytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const method = req.method ?? "GET", write = method !== "GET";
        const token = headers.get("Authori-zation"), viewer = token === `Bearer ${f.token}` ? 11 : token === `Bearer ${f.otherToken}` ? 22 : 0;
        const input = body.length ? JSON.parse(body.toString()) : undefined;
        const plan = plans[traces.filter(row => row.write).length];
        if (write) {
          expect(plan).toBeDefined(); expect(viewer).toBe(11);
          expect(method).toBe(plan.kind === "delete" ? "DELETE" : "POST");
          expect(url.pathname).toBe(plan.kind === "create" ? "/api/community/comment/save" : plan.kind === "like"
            ? `/api/community/comment_like/${plan.target}` : `/api/community/comment_delete/${plan.target}`);
          if (plan.kind === "delete") expect(input === undefined || stable(input) === "{}").toBe(true);
          else expect(input).toEqual(plan.kind === "create" ? { community_id: f.mainId, content: plan.content, comment_reply_id: plan.target }
            : { status: plan.status });
        }
        const before = await snapshot(); expect(before).toEqual(expected);
        const started = Math.floor(Date.now() / 1000), waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method, headers, ...(body.length ? { body } : {}) }), f.env,
          { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits); const ended = Math.floor(Date.now() / 1000);
        const raw = Buffer.from(await response.arrayBuffer());
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status); if (payload) expect(payload.status, payload.msg).toBe(200);
        const after = await snapshot(), detail = /^\/api\/community\/detail\/(\d+)$/.exec(url.pathname);
        const receipt = write ? checkMutation(before, after, plan, payload.data, started, ended)
          : detail ? checkBrowse(before, after, Number(detail[1]), viewer) : (expect(after).toEqual(before), undefined);
        expected = after;
        expect(after.community_comment.filter(row => protectedIds.has(row.id))).toEqual(initial.community_comment.filter(row => protectedIds.has(row.id)));
        const commentList = method === "GET" && url.pathname === "/api/community/comment/list";
        if (commentList) {
          expect([11, 22]).toContain(viewer); expect(payload.data.list).toBeInstanceOf(Array);
          for (const row of payload.data.list) {
            expect(row.communityId).toBe(Number(url.searchParams.get("community_id")));
            expect(row.isVerify).toBe(1); expect(row.isDel).toBe(0);
            expect(row.isShow === 1 || row.type === 2 && row.uid === viewer).toBe(true);
            expect(row.content).not.toContain("异型隐藏旁观"); expect(row.content).not.toContain("预存待审旁观");
          }
        }
        const mainPage = commentList && viewer === 11 && url.searchParams.get("community_id") === String(f.mainId);
        const lostRoot = loseRoot && mainPage && url.searchParams.get("reply_id") === "0" && url.searchParams.get("page") === "2";
        const lostReply = loseReply && mainPage && url.searchParams.get("reply_id") === "1011" && url.searchParams.get("page") === "2";
        const lostCreate = loseCreate && write && plan.kind === "create" && plan.content === "唯一未知验收";
        if (lostRoot) { loseRoot = false; expect(payload.data.list.map((row: Row) => row.id)).toEqual([1003, 1002, 1001]); }
        if (lostReply) { loseReply = false; expect(payload.data.list.map((row: Row) => row.id)).toEqual([2011, 2012]); }
        if (lostCreate) loseCreate = false;
        traces.push({ method, write, viewer, path: url.pathname, query: url.search, status: response.status,
          browserStatus: lostRoot || lostReply || lostCreate ? 503 : response.status, ...(write ? { plan, input } : {}),
          ...(commentList ? { comment_ids: payload.data.list.map((row: Row) => row.id), count: payload.data.count,
            post_comment_num: payload.data.post_comment_num } : {}),
          ...(receipt ? { allowed_mutation: receipt } : {}), snapshot: { tables: tables.length, sequences: before.__sequences.length,
            before_sha256: digest(before), after_sha256: digest(after), read_unchanged: !write && !detail } });
        if (lostRoot || lostReply || lostCreate) return json(res, { status: 503,
          msg: lostRoot ? "本地验收：评论第二页回执失败，请重试" : lostReply ? "本地验收：回复第二页回执失败，请重试" : "本地验收：评论已提交但回执丢失" }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function setting(req: IncomingMessage, res: ServerResponse) {
      return serial(async () => {
        const input = JSON.parse((await bytes(req)).toString()), next = stages[evidence.length];
        expect(next).toBe(input.value === 1 ? "pending" : "unknown");
        expect(input).toEqual({ value: controls.length === 0 ? 1 : 0 }); expect(controls.length).toBeLessThan(2);
        const before = await snapshot(); expect(before).toEqual(expected);
        const setting = before.system_config.filter(row => row.menu_name === "community_comment_verify"); expect(setting).toHaveLength(1);
        await f.db.update(systemConfig).set({ value: String(input.value) }).where(eq(systemConfig.id, setting[0].id));
        await new SystemConfigService(f.container, f.env).invalidate("community_comment_verify");
        expect(await f.env.CONFIG_KV.get("cfg_community_comment_verify")).toBeNull();
        const after = await snapshot(), wanted = structuredClone(before);
        wanted.system_config = wanted.system_config.map(row => row.id === setting[0].id ? { ...row, value: String(input.value) } : row);
        expect(after).toEqual(sorted(wanted)); expected = after;
        controls.push({ kind: "fixture-setting-only", key: "community_comment_verify", value: input.value,
          before_sha256: digest(before), after_sha256: digest(after), exact_setting_id: setting[0].id,
          all_other_rows_and_sequences_unchanged: true, actual_service_kv_key_invalidated: "cfg_community_comment_verify" });
        json(res, { settings: controls.map(row => row.value), nextStage: next });
      });
    }
    const commentReads = () => traces.filter(row => row.method === "GET" && ["/api/community/config", "/api/community/comment/list"].includes(row.path));
    async function checkpoint(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        expect(stage).toBe(stages[evidence.length]); expect(data.scrollWidth).toBeLessThanOrEqual(data.width + 1);
        expect(data.theme.style).toContain("--view-theme:"); expect(data.panels).toBe(1);
        const current = await snapshot(); expect(current).toEqual(expected);
        const writes = traces.filter(row => row.write); expect(writes).toHaveLength(stageWriteCounts[evidence.length]);
        const roots = data.rows.filter((row: Row) => !row.reply).map((row: Row) => row.content);
        const replies = data.rows.filter((row: Row) => row.reply).map((row: Row) => row.content);
        for (const hidden of ["异型隐藏旁观", "预存待审旁观"]) expect(data.commentsText).not.toContain(hidden);
        const rootsPage2 = traces.filter(row => row.path === "/api/community/comment/list" && row.query.includes("community_id=" + f.mainId)
          && new URLSearchParams(row.query).get("reply_id") === "0" && new URLSearchParams(row.query).get("page") === "2");
        const repliesPage2 = traces.filter(row => row.path === "/api/community/comment/list" && new URLSearchParams(row.query).get("reply_id") === "1011"
          && new URLSearchParams(row.query).get("page") === "2");
        if (stage === "roots" || stage === "rootError") {
          expect(roots).toEqual(f.initialRootContents); expect(data.commentsText).toContain("该评论已隐藏，仅你可见");
          expect(data.commentsText).toContain("验收平台"); expect(data.commentsText).not.toContain("第一页之外根");
          expect(rootsPage2).toHaveLength(stage === "roots" ? 0 : 1);
          if (stage === "rootError") { expect(data.commentsText).toContain("评论第二页回执失败"); expect(data.commentsText).toContain("重试评论"); }
        }
        if (stage === "rootRecovered") {
          expect(roots).toEqual([...f.initialRootContents, "主帖根1003", "主帖根1002", "第一页之外根"]);
          expect(rootsPage2).toHaveLength(2); expect(rootsPage2.map(row => row.browserStatus)).toEqual([503, 200]);
          expect(rootsPage2.map(row => row.query)).toEqual([rootsPage2[0].query, rootsPage2[0].query]);
          expect(data.commentsText).not.toContain("评论第二页回执失败");
        }
        if (stage === "replyError" || stage === "replyRecovered") {
          expect(replies).toEqual(Array.from({ length: stage === "replyError" ? 10 : 12 }, (_, i) => `分页子回复${2001 + i}`));
          expect(repliesPage2).toHaveLength(stage === "replyError" ? 1 : 2);
          if (stage === "replyError") { expect(data.commentsText).toContain("回复第二页回执失败"); expect(data.commentsText).toContain("重试回复"); }
          else { expect(repliesPage2.map(row => row.browserStatus)).toEqual([503, 200]);
            expect(repliesPage2.map(row => row.query)).toEqual([repliesPage2[0].query, repliesPage2[0].query]);
            expect(data.commentsText).toContain("回复已全部显示"); }
        }
        if (stage === "rootReply" || stage === "childReply") {
          expect(data.commentsText).toContain("评论成功"); expect(data.input).toBe("");
          expect(byId(current, "community_comment", 1011).comment_num).toBe(stage === "rootReply" ? 13 : 14);
          expect(byId(current, "community", f.mainId).comment_num).toBe(stage === "rootReply" ? 26 : 27);
        }
        if (stage === "liked" || stage === "unliked") {
          const row = data.rows.find((row: Row) => row.content === "分页回复根");
          expect(row.like).toBe(stage === "liked" ? "取消点赞 1" : "点赞 0");
        }
        if (stage === "deleteIntent") { expect(data.commentsText).toContain("删除这条评论及其全部回复？");
          expect(data.commentsText).toContain("保留评论"); expect(data.commentsText).toContain("确认删除评论"); }
        if (stage === "kept") { expect(data.commentsText).not.toContain("删除这条评论及其全部回复？"); expect(roots).toContain("级联删除根"); }
        if (["hiddenChildDeleted", "hiddenRootDeleted", "cascadeDeleted"].includes(stage)) expect(data.commentsText).toContain("评论已删除");
        if (stage === "hiddenChildDeleted") { expect(byId(current, "community_comment", 2101).is_del).toBe(1); expect(roots).toContain("本人隐藏根"); }
        if (stage === "hiddenRootDeleted") { expect(byId(current, "community_comment", 1010).is_del).toBe(1); expect(roots).not.toContain("本人隐藏根"); }
        if (stage === "cascadeDeleted") {
          for (const id of [1008, 2201, 2202]) expect(byId(current, "community_comment", id).is_del).toBe(1);
          expect(current.community_relevance.some(row => row.id === 5000 || row.id === 5001)).toBe(false);
          expect(byId(current, "community", f.mainId).comment_num).toBe(24);
        }
        if (stage === "pending") {
          expect(controls.map(row => row.value)).toEqual([1]); expect(data.commentsText).toContain("等待审核");
          expect(roots).not.toContain("待审验收"); expect(current.community_comment.filter(row => row.content === "待审验收")).toHaveLength(1);
          expect(current.community_comment.find(row => row.content === "待审验收")?.is_verify).toBe(0);
          expect(byId(current, "community", f.mainId).comment_num).toBe(24);
        }
        if (stage === "unknown" || stage === "reopened") {
          expect(controls.map(row => row.value)).toEqual([1, 0]); expect(data.commentsText).toContain("操作结果未确认");
          expect(data.rows).toEqual([]); expect(data.input).toBe(""); expect(data.refreshDisabled).toBe(false);
          expect(current.community_comment.filter(row => row.content === "唯一未知验收")).toHaveLength(1);
          if (stage === "reopened") expect(commentReads()).toHaveLength(evidence.find(row => row.stage === "unknown")!.comment_reads);
        }
        if (stage === "reconciled") {
          expect(roots.filter((content: string) => content === "唯一未知验收")).toHaveLength(1);
          expect(data.commentsText).toContain("已刷新，请核对评论结果"); expect(data.commentsText).not.toContain("操作结果未确认");
          expect(byId(current, "community", f.mainId).comment_num).toBe(25);
        }
        if (stage === "otherPost") { expect(roots).toEqual(["次帖独立评论"]); expect(data.commentsText).not.toContain("唯一未知验收"); }
        if (stage === "otherAccount") {
          expect(roots).toContain("其他账号隐藏根"); expect(roots).not.toContain("本人隐藏保留根");
          expect(data.commentsText).not.toContain("本人隐藏保留子回复");
          expect(traces.some(row => row.viewer === 22 && row.path === "/api/community/comment/list" && row.comment_ids.includes(1100))).toBe(true);
        }
        if (stage === "workspace" || stage === "search") {
          expect(data.href).toContain(stage === "workspace" ? "/pages/discover/workspace?author_id=self" : "/pages/discover/discoverSearch/index");
          expect(roots).toContain("本人隐藏保留根"); expect(roots).toContain("唯一未知验收"); expect(data.commentsText).not.toContain("次帖独立评论");
        }
        if (["videoIndex", "videoApp", "finished"].includes(stage)) {
          expect(data.href).toContain(stage === "videoIndex" ? "/pages/discover/discoverVideo/index" : "/pages/discover/discoverVideo/app");
          expect(roots).toEqual(["视频入口评论"]); expect(data.commentsText).not.toContain("唯一未知验收");
        }
        evidence.push({ stage, ...data, database_sha256: digest(current), writes: writes.length, comment_reads: commentReads().length });
        if (stage === "finished") {
          expect(loseRoot).toBe(false); expect(loseReply).toBe(false); expect(loseCreate).toBe(false);
          expect(controls.map(row => row.value)).toEqual([1, 0]); expect(external).not.toHaveBeenCalled();
          expect(current.community_comment.filter(row => row.content === "唯一未知验收")).toHaveLength(1);
          expect(current.community_comment.filter(row => protectedIds.has(row.id))).toEqual(initial.community_comment.filter(row => protectedIds.has(row.id)));
          finished = true;
          await writeFile("/tmp/cinashop-community-comments-browser-evidence.json", JSON.stringify({ evidence, traces, controls, tables,
            sequence_count: initial.__sequences.length, initial_sha256: digest(initial), final_sha256: digest(current),
            initial_comments: initial.community_comment, final_comments: current.community_comment,
            protected_comment_ids: [...protectedIds], writes: plans, providerCalls: 0,
            authority: "Actual H5/createApp/JWT, owned native PG16 and memory R2; synthetic histories/navigation chrome, two lost read receipts and one lost committed create receipt only",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区评论后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:850px;border:1px solid #ddd}pre{max-height:64px;overflow:auto}details{max-width:780px}</style>
<h1>实际 H5 评论与回复</h1><button id="start">账号11打开主列表</button><button id="other">切换账号22主列表</button>
<button id="workspace">账号11工作台</button><button id="search">账号11搜索主帖</button>
<button id="video-index">视频index</button><button id="video-app">视频app</button>
<button id="pending">启用待审</button><button id="direct">恢复直接发布</button><button id="narrow">375像素</button>
<details><summary>25阶段操作说明</summary><ol>${instructions.map(([stage, hint]) => `<li>${stage}：${hint}</li>`).join("")}</ol></details>
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}
<pre id="result"></pre><iframe title="实际社区评论页面"></iframe><script>
const frame=document.querySelector('iframe');
const session=(token,uid,route)=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}));frame.src='/?community_comments_session='+uid+'-'+Date.now()+'#'+route;};
const actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};
document.getElementById('start').onclick=()=>session(actor,11,'/pages/discover/index');
document.getElementById('other').onclick=()=>session(other,22,'/pages/discover/index');
document.getElementById('workspace').onclick=()=>session(actor,11,'/pages/discover/workspace?author_id=self');
document.getElementById('search').onclick=()=>session(actor,11,'/pages/discover/discoverSearch/index?keyword='+encodeURIComponent('评论验收主帖'));
document.getElementById('video-index').onclick=()=>session(actor,11,'/pages/discover/discoverVideo/index?id=${f.videoId}');
document.getElementById('video-app').onclick=()=>session(actor,11,'/pages/discover/discoverVideo/app?id=${f.videoId}');
document.getElementById('narrow').onclick=()=>{frame.style.width='375px';};
for(const [id,value] of [['pending',1],['direct',0]])document.getElementById(id).onclick=async()=>{const response=await fetch('${control}/setting',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value})});document.getElementById('result').textContent=JSON.stringify(await response.json());};
const disabled=b=>!b||b.disabled===true||b.hasAttribute('disabled')||b.classList.contains('uni-button-disabled')||b.getAttribute('aria-disabled')==='true';
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,host=d.querySelector('.theme-page'),panel=d.querySelector('.community-comments'),data={href:frame.contentWindow.location.href,text:d.body.textContent,commentsText:panel?.textContent??'',panels:d.querySelectorAll('.community-comments').length,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,
rows:[...d.querySelectorAll('.community-comments .comment-row')].map(row=>({content:row.querySelector('.comment-content')?.textContent.trim()??'',author:row.querySelector('.comment-author')?.textContent.trim()??'',target:row.querySelector('.comment-target')?.textContent.trim()??'',reply:row.classList.contains('comment-reply'),hidden:!!row.querySelector('.comment-hidden'),like:row.querySelector('.comment-like')?.textContent.trim().replace(/\\s+/g,' ')??''})),
input:panel?.querySelector('textarea')?.value??'',refreshDisabled:disabled(panel?.querySelector('.comments-refresh')),theme:{className:host?.className??'',style:host?.getAttribute('style')??''}};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path === control + "/setting" && req.method === "POST") return setting(req, res);
      if (path.startsWith(control + "/") && req.method === "POST") return checkpoint(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区评论验收", site_logo: "", record_No: "", ico_path: "" },
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
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(40761, "127.0.0.1", yes); });
      process.stdout.write("COMMUNITY_COMMENTS_BROWSER_READY " + JSON.stringify({ url: origin + control, stages: instructions,
        mainPost: "评论验收主帖", mainId: f.mainId, otherPost: "评论验收次帖", otherId: f.otherId, videoId: f.videoId,
        rootPageSize: 10, rootCount: 13, replyPageSize: 10, replyCount: 12, expectedBusinessWrites: plans }) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent")), 20 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
