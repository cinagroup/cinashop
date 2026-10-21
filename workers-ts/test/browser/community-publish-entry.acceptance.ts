import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import { communityPublishEntryBrowserFixture } from "../helpers/communityPublishEntryBrowserFixture";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(),
  createContainer: () => { if (!wiring.container) throw Error("Missing owned publish-entry SQL"); return wiring.container; },
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
    expect(length).toBeLessThan(128_000); chunks.push(value); }
  return Buffer.concat(chunks);
}

it("actual raw publish/author/social bridges, topic full publisher, owned PNG upload and exact reviewed/unknown saves", async () => {
  const f = await communityPublishEntryBrowserFixture(), app = createApp();
  const root = resolve(import.meta.dirname, "../../../view/uniapp-ts/dist/build/h5");
  const origin = "http://127.0.0.1:40763", control = "/__community_publish_entry/" + randomUUID();
  const prefix = "/tmp/cinashop-community-publish-entry-browser-";
  const instructions = [
    ["rawPlatform", "外层旧用户id=0：实际桥到workspace?author_id=0，显示入口验收平台，不能显示本人编辑控件"],
    ["rawSelf", "外层旧用户无id：桥到自己的主页，显示入口原始图集及编辑控件"],
    ["rawOther", "外层旧用户id=22：桥到另一作者，不能显示自己的待审图集或编辑控件"],
    ["rawFollow", "外层旧关注type=0：实际桥到people?tab=follow，选中关注"],
    ["rawFriends", "外层旧关注type=1：实际桥到people?tab=friend，选中好友"],
    ["rawFans", "外层旧关注type=2：实际桥到people?tab=fans，选中粉丝"],
    ["rawCreate", "外层旧创建无参数：完整publisher打开、空标题/内容、图片/视频/话题/商品都可用；不提交"],
    ["rawSeed", "外层旧创建topic_id=9：完整publisher已种下入口话题九，结束选择后稍后发布"],
    ["rawEditPriority", "外层旧创建id=原图集&topic_id=10：编辑ID优先，原话题九/原照片/商品111恢复，不添加话题十；取消编辑"],
    ["topic", "外层话题九：可见实际去发布按钮；尚未打开发布器"],
    ["topicPublisher", "点产品去发布：真实navigate到workspace?publish=1&topic_id=9，共享完整publisher及原话题已选；点完成选择"],
    ["photoUploaded", "产品添加照片，真实chooser选ready.chooser_png：实际PNG上传且预览160px，不用业务API桥"],
    ["topicsSelected", "产品选择话题，保留九并另选入口话题十，完成选择：共2个话题"],
    ["productSelected", "产品添加商品，在已购列表选已购好物111后完成；填标题入口验收新图文，内容入口照片商品多话题"],
    ["createdPending", "产品发布一次：新帖待审、本人详情可见，未新增浏览；正常成功反馈与待审状态可见"],
    ["editLoaded", "外层旧编辑原图集：readonly state装载，不增浏览；外层关闭审核开关一次（fixture控制及真实KV失效）"],
    ["editedPublic", "改标题入口修订图集、内容原图集编辑转公开，保留原照片/话题九/商品111，提交修改一次：公开详情只记一次浏览"],
    ["unknownReady", "外层旧创建topic_id=10，完成选择，填标题入口未知新帖、内容已提交503不重发"],
    ["unknownCommitted", "产品发布一次：SQL已提交但只替换503回执，显示发布结果未确认，发布按钮禁用"],
    ["unknownBlocked", "观察锁定并可尝试点击禁用发布：POST仍只有该新建一次；照片/话题/商品同样锁定"],
    ["unknownEnded", "点结束本次发布并刷新帖子：关闭草稿，列表含入口未知新帖，不自动重发POST、不自动开详情"],
    ["ownerDraft", "外层旧创建topic_id=9，完成选择，填标题账号11未提交草稿、内容跨账号不能保留；不提交"],
    ["ownerOtherEdit", "外层换账号22打开原图集编辑：state可读公共帖但产品拒绝编辑，不能带出账号11草稿/媒体/关联"],
    ["ownerFresh", "外层账号22旧创建topic_id=10：完成选择后标题/内容空白，无账号11照片/商品/草稿"],
    ["invalidRaw", "外层旧创建重复id=1&id=2：原始查询被拒绝，不进入publisher、不发社区业务API；全局统计脚本仍可只读加载"],
    ["finished", "外层再次账号22旧创建topic_id=10并完成选择；每次checkpoint前点375尺寸控件，检查26阶段/4业务写/1配置/1公开浏览"],
  ] as const;
  const stages = instructions.map(([name]) => name);
  const routes = {
    platform: { uid: 11, route: "/pages/discover/discoverUser/index?id=0", label: "旧用户：平台0" },
    self: { uid: 11, route: "/pages/discover/discoverUser/index", label: "旧用户：本人" },
    other: { uid: 11, route: "/pages/discover/discoverUser/index?id=22", label: "旧用户：作者22" },
    follow: { uid: 11, route: "/pages/discover/discoverFollow/index?type=0", label: "旧关注0" },
    friends: { uid: 11, route: "/pages/discover/discoverFollow/index?type=1", label: "旧好友1" },
    fans: { uid: 11, route: "/pages/discover/discoverFollow/index?type=2", label: "旧粉丝2" },
    create: { uid: 11, route: "/pages/discover/discoverCreate/index", label: "旧创建：空白" },
    seed: { uid: 11, route: "/pages/discover/discoverCreate/index?topic_id=9", label: "旧创建：原话题9" },
    priority: { uid: 11, route: `/pages/discover/discoverCreate/index?id=${f.gallery.id}&topic_id=10`, label: "旧编辑：ID优先原话题" },
    edit: { uid: 11, route: `/pages/discover/discoverCreate/index?id=${f.gallery.id}`, label: "旧编辑：原图集" },
    topic: { uid: 11, route: "/pages/discover/discoverTopic/index?id=9", label: "话题9：点产品去发布" },
    unknown: { uid: 11, route: "/pages/discover/discoverCreate/index?topic_id=10", label: "旧创建：503新帖" },
    otherEdit: { uid: 22, route: `/pages/discover/discoverCreate/index?id=${f.gallery.id}`, label: "账号22：不能编辑11帖子" },
    otherCreate: { uid: 22, route: "/pages/discover/discoverCreate/index?topic_id=10", label: "账号22：新草稿" },
    invalid: { uid: 22, route: "/pages/discover/discoverCreate/index?id=1&id=2", label: "非法原始重复ID" },
  };
  const plans = [
    { kind: "upload", actor: 11 },
    { kind: "create", actor: 11, title: "入口验收新图文", content: "入口照片商品多话题", topics: [9, 10], products: [111], media: "uploaded", verify: 0 },
    { kind: "update", actor: 11, id: f.gallery.id, title: "入口修订图集", content: "原图集编辑转公开", topics: [9], products: [111], media: "original", verify: 1 },
    { kind: "create", actor: 11, title: "入口未知新帖", content: "已提交503不重发", topics: [10], products: [], media: "none", verify: 1, lost: true },
  ];
  const writeCounts = [0,0,0,0,0,0,0,0,0,0,0,1,1,1,2,2,3,3,4,4,4,4,4,4,4,4];
  const detailCounts = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,2,2,2,2,2,2,2,2,2];
  const traces: Row[] = [], evidence: Row[] = [], configReceipts: Row[] = [], staticPaths = new Set<string>();
  let uploadedUrl = "", createdId = 0, unknownId = 0, done!: () => void, fail!: (reason: Error) => void, finished = false;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External provider forbidden in owned publish-entry acceptance"));
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
        state[name] = (await f.db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`)).map(row => row.row);
      }
      state.__sequences = await f.db.execute(sql`SELECT sequencename AS name, last_value::text AS last FROM pg_sequences
        WHERE schemaname = current_schema() ORDER BY sequencename`);
      return sorted(state);
    }
    const objectState = () => [...f.objects].map(([key, value]) => ({ key, type: value.type, size: value.bytes.length,
      sha256: createHash("sha256").update(value.bytes).digest("hex") })).sort((a, b) => a.key.localeCompare(b.key));
    const initial = await snapshot(); let expected = initial;
    expect(initial.__sequences).toHaveLength(14);
    const initialObjects = objectState(), initialPuts = f.bucket.put.mock.calls.length, initialDeletes = f.bucket.delete.mock.calls.length;
    const byId = (state: Snapshot, table: string, id: number) => state[table].find(row => row.id === id)!;
    const relations = (state: Snapshot, id: number, type: string) => state.community_relevance.filter(row => row.left_id === id && row.type === type);
    function advance(wanted: Snapshot, name: string, count: number): number[] {
      const seq = wanted.__sequences.find(row => row.name === name); expect(seq).toBeDefined();
      const previous = seq!.last === null ? 0 : Number(seq!.last), ids = Array.from({ length: count }, (_, i) => previous + i + 1);
      if (count) wanted.__sequences = wanted.__sequences.map(row => row.name === name ? { ...row, last: String(previous + count) } : row);
      return ids;
    }
    function unchanged(before: Snapshot, after: Snapshot) { expect(after).toEqual(before); }
    function checkUpload(before: Snapshot, after: Snapshot, payload: Row, file: File, start: number, end: number) {
      const wanted = structuredClone(before), [id] = advance(wanted, "system_attachment_att_id_seq", 1);
      expect(payload.att_id).toBe(id); expect(payload.url).toBe(`/api/assets/${id}`); expect(payload.src).toContain(payload.url + "?");
      expect(payload.type).toBe("image/png"); expect(payload.size).toBe(f.png.length);
      const row = after.system_attachment.find(item => item.att_id === id)!;
      expect(row).toBeDefined(); expect(row.time).toBeGreaterThanOrEqual(start); expect(row.time).toBeLessThanOrEqual(end);
      expect(row.name).toMatch(/^attachments\/user\/11\/\d{4}\/\d{2}\/[a-f0-9-]+\.png$/u);
      expect(row.att_size.trimEnd()).toBe(String(f.png.length)); expect(row.att_type.trimEnd()).toBe("image/png");
      expect(row).toEqual({ att_id: id, type: 3, file_type: 1, relation_id: 11, name: row.name, att_dir: payload.url, satt_dir: payload.url,
        att_size: row.att_size, att_type: row.att_type, pid: 0, time: row.time, image_type: 8, module_type: 3,
        real_name: file.name, scan_token: "" });
      wanted.system_attachment.push(row); expect(after).toEqual(sorted(wanted)); uploadedUrl = payload.url;
      expect(f.bucket.put.mock.calls).toHaveLength(initialPuts + 1); expect(f.bucket.delete.mock.calls).toHaveLength(initialDeletes);
      const nextObjects = objectState(); expect(nextObjects.filter(item => item.key !== row.name)).toEqual(initialObjects);
      expect(nextObjects.find(item => item.key === row.name)).toEqual({ key: row.name, type: "image/png", size: f.png.length,
        sha256: createHash("sha256").update(f.png).digest("hex") });
      return { kind: "owned-png-upload", attachment_id: id, owner: { type: 3, relation_id: 11, module_type: 3 }, sequence_delta: 1,
        r2_put_delta: 1, r2_delete_delta: 0, png_sha256: createHash("sha256").update(f.png).digest("hex") };
    }
    function checkSave(before: Snapshot, after: Snapshot, plan: Row, input: Row, payload: Row, start: number, end: number) {
      const wanted = structuredClone(before), edit = plan.kind === "update";
      const id = edit ? plan.id : advance(wanted, "community_id_seq", 1)[0];
      expect(payload).toEqual({ id });
      const media = plan.media === "uploaded" ? uploadedUrl : plan.media === "original" ? f.image.url : "";
      expect(input).toEqual({ title: plan.title, content: plan.content, content_type: 1,
        ...(media ? { image: media, slider_image: [media] } : {}), ...(edit ? { video_url: "" } : {}),
        topic_id: plan.topics, ...(plan.products.length || edit ? { product_id: plan.products } : {}) });
      const row = byId(after, "community", id), old = edit ? byId(before, "community", id) : undefined;
      expect(row).toBeDefined(); expect(row.verify_time).toBe(plan.verify ? row.verify_time : 0);
      if (plan.verify) { expect(row.verify_time).toBeGreaterThanOrEqual(start); expect(row.verify_time).toBeLessThanOrEqual(end); }
      if (!edit) { expect(row.add_time).toBeGreaterThanOrEqual(start); expect(row.add_time).toBeLessThanOrEqual(end); }
      const fields = { content_type: 1, title: plan.title, content: plan.content, image: media, video_url: "", slider_image: JSON.stringify(media ? [media] : []),
        topic_id: JSON.stringify(plan.topics), product_id: JSON.stringify(plan.products), status: 1, is_verify: plan.verify, refusal: "", verify_time: row.verify_time };
      expect(row).toEqual(edit ? { ...old, ...fields } : { id, type: 2, relation_id: plan.actor, ...fields, like_num: 0, collect_num: 0,
        play_num: 0, comment_num: 0, share_num: 0, star: 1, is_recommend: 0, sort: 0, is_del: 0, add_time: row.add_time });
      const oldTopicIds = relations(before, id, "community_topic").map(item => item.right_id);
      wanted.community = edit ? wanted.community.map(item => item.id === id ? row : item) : [...wanted.community, row];
      const removed = wanted.community_relevance.filter(item => item.left_id === id && ["community_topic", "community_product"].includes(item.type));
      wanted.community_relevance = wanted.community_relevance.filter(item => !removed.some(value => value.id === item.id));
      const requested = [...plan.topics.map((right_id: number) => ({ left_id: id, right_id, type: "community_topic" })),
        ...plan.products.map((right_id: number) => ({ left_id: id, right_id, type: "community_product" }))];
      const ids = advance(wanted, "community_relevance_id_seq", requested.length);
      wanted.community_relevance.push(...requested.map((item, i) => ({ id: ids[i], ...item })));
      const publicCount = wanted.community.filter(item => item.type === 2 && item.relation_id === plan.actor && item.status === 1 && item.is_verify === 1 && !item.is_del).length;
      const profiles = wanted.community_user.filter(item => item.type === 2 && item.relation_id === plan.actor && !item.is_del); expect(profiles).toHaveLength(1);
      wanted.community_user = wanted.community_user.map(item => profiles.some(profile => profile.id === item.id) ? { ...item, community_num: publicCount } : item);
      const touched = new Set<number>([...oldTopicIds, ...plan.topics]);
      wanted.community_topic = wanted.community_topic.map(item => !touched.has(item.id) ? item : { ...item, use_num: new Set(wanted.community_relevance
        .filter(edge => edge.type === "community_topic" && edge.right_id === item.id && wanted.community.some(post => post.id === edge.left_id && !post.is_del))
        .map(edge => edge.left_id)).size });
      expect(after).toEqual(sorted(wanted));
      if (!edit && !plan.lost) createdId = id; if (plan.lost) unknownId = id;
      return { kind: edit ? "owner-edit" : "new-post", post_id: id, actor: plan.actor, is_verify: plan.verify,
        public_author_count: publicCount, exact_author_profile_ids: profiles.map(item => item.id), topic_ids: plan.topics, product_ids: plan.products,
        removed_relation_ids: removed.map(item => item.id), inserted_relation_ids: ids, post_sequence_delta: edit ? 0 : 1,
        relation_sequence_delta: ids.length, topic_use_num_includes_unreviewed: true };
    }
    function checkDetail(before: Snapshot, after: Snapshot, id: number, actor: number, data: Row) {
      const row = byId(before, "community", id), index = traces.filter(item => item.detail).length;
      expect(id).toBe(index === 0 ? createdId : f.gallery.id); expect(actor).toBe(11); expect(index).toBeLessThan(2);
      if (row.is_verify !== 1) { expect(row.type).toBe(2); expect(row.relation_id).toBe(actor); unchanged(before, after);
        return { kind: "owner-private-detail", post_id: id, browse_delta: 0, sequence_delta: 0 }; }
      const wanted = structuredClone(before); wanted.community = wanted.community.map(item => item.id === id ? { ...item, play_num: item.play_num + 1 } : item);
      expect(relations(before, actor, "community_browse").filter(item => item.right_id === id)).toHaveLength(0);
      const [relationId] = advance(wanted, "community_relevance_id_seq", 1);
      wanted.community_relevance.push({ id: relationId, left_id: actor, right_id: id, type: "community_browse" });
      expect(data.playNum).toBe(row.play_num + 1); expect(after).toEqual(sorted(wanted));
      return { kind: "public-detail-visit", post_id: id, browse_delta: 1, inserted_browse_relation_id: relationId, sequence_delta: 1 };
    }
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const body = await bytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
        const method = req.method ?? "GET", write = method !== "GET" || /^\/api\/community\/share\//u.test(url.pathname);
        const detail = /^\/api\/community\/detail\/(\d+)$/u.exec(url.pathname);
        const viewer = headers.get("Authori-zation") === `Bearer ${f.token}` ? 11 : headers.get("Authori-zation") === `Bearer ${f.otherToken}` ? 22 : 0;
        const plan = plans[traces.filter(row => row.write).length];
        let file: File | undefined, input: Row | undefined;
        if (write) {
          expect(plan).toBeDefined(); expect(method).toBe("POST"); expect(viewer).toBe(plan.actor);
          expect(url.pathname).toBe(plan.kind === "upload" ? "/api/upload/image" : plan.kind === "update" ? `/api/community/community_update/${f.gallery.id}` : "/api/community_save");
          if (plan.kind === "upload") {
            const form = await new Request(url.href, { method, headers, body }).formData();
            expect([...form.keys()].sort()).toEqual(["file", "pid"]); expect(form.get("pid")).toBe("0");
            expect(form.get("file")).toBeInstanceOf(File); file = form.get("file") as File;
            expect(file.type).toBe("image/png"); expect(new Uint8Array(await file.arrayBuffer())).toEqual(f.png);
          } else input = JSON.parse(body.toString());
        }
        const before = await snapshot(); expect(before).toEqual(expected);
        const objectsBefore = objectState(), putsBefore = f.bucket.put.mock.calls.length, deletesBefore = f.bucket.delete.mock.calls.length;
        const configCacheBefore = f.cache.get("cfg_community_verify") ?? null, start = Math.floor(Date.now() / 1000), waits: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method, headers, ...(body.length ? { body } : {}) }), f.env,
          { waitUntil: value => { waits.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(waits); const raw = Buffer.from(await response.arrayBuffer()), end = Math.floor(Date.now() / 1000);
        const payload = response.headers.get("Content-Type")?.includes("application/json") ? JSON.parse(raw.toString()) : undefined;
        expect([200, 206]).toContain(response.status); if (payload) expect(payload.status, payload.msg).toBe(200);
        if (detail || /^\/api\/community\/state\//u.test(url.pathname)) expect(response.headers.get("Cache-Control")).toBe("no-store");
        const after = await snapshot(), receipt = write
          ? plan.kind === "upload" ? checkUpload(before, after, payload.data, file!, start, end) : checkSave(before, after, plan, input!, payload.data, start, end)
          : detail ? checkDetail(before, after, Number(detail[1]), viewer, payload.data) : (unchanged(before, after), undefined);
        expected = after;
        if (!write || plan.kind !== "upload") {
          expect(objectState()).toEqual(objectsBefore); expect(f.bucket.put.mock.calls).toHaveLength(putsBefore); expect(f.bucket.delete.mock.calls).toHaveLength(deletesBefore);
        }
        if (write && plan.kind !== "upload") expect(f.cache.get("cfg_community_verify")).toBe(plan.verify ? "0" : "1");
        expect(after.community_user.filter(row => f.protectedProfileIds.includes(row.id))).toEqual(initial.community_user.filter(row => f.protectedProfileIds.includes(row.id)));
        expect(after.community.filter(row => f.protectedPostIds.includes(row.id))).toEqual(initial.community.filter(row => f.protectedPostIds.includes(row.id)));
        traces.push({ method, path: url.pathname, query: url.search, viewer, write, detail: Boolean(detail), status: response.status,
          browserStatus: write && "lost" in plan && plan.lost ? 503 : response.status, ...(write ? { plan, ...(input ? { input } : {}) } : {}),
          ...(payload?.data?.id ? { returned: { id: payload.data.id, title: payload.data.title, is_verify: payload.data.is_verify, playNum: payload.data.playNum } } : {}),
          ...(receipt ? { allowed_mutation: receipt } : {}), config_cache: { before: configCacheBefore, after: f.cache.get("cfg_community_verify") ?? null },
          snapshot: { tables: tables.length, sequences: before.__sequences.length, before_sha256: digest(before), after_sha256: digest(after),
            read_unchanged: !write && !detail } });
        if (write && "lost" in plan && plan.lost) return json(res, { status: 503, msg: "本地验收：帖子已提交，但响应丢失" }, 503);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function review(req: IncomingMessage, res: ServerResponse) {
      return serial(async () => {
        expect((await bytes(req)).toString()).toBe(""); expect(configReceipts).toHaveLength(0);
        expect(traces.filter(row => row.write)).toHaveLength(2); expect(evidence.at(-1)?.stage).toBe("editLoaded");
        const before = await snapshot(); expect(before).toEqual(expected); const wanted = structuredClone(before);
        const row = before.system_config.find(item => item.menu_name === "community_verify")!; expect(row.value).toBe("1");
        const cacheBefore = f.cache.get("cfg_community_verify"); expect(cacheBefore).toBe("1");
        await f.db.update(systemConfig).set({ value: "0" }).where(eq(systemConfig.menuName, "community_verify"));
        await f.env.CONFIG_KV.delete("cfg_community_verify"); expect(f.cache.has("cfg_community_verify")).toBe(false);
        wanted.system_config = wanted.system_config.map(item => item.id === row.id ? { ...item, value: "0" } : item);
        const after = await snapshot(); expect(after).toEqual(sorted(wanted)); expected = after;
        configReceipts.push({ key: "community_verify", source: "fixture-only explicit review control", before: "1", after: "0",
          cache_key: "cfg_community_verify", cached_before: cacheBefore, cached_after_invalidation: null,
          before_sha256: digest(before), after_sha256: digest(after), sequence_delta: 0 });
        json(res, { changed: "community_verify", value: "0", cache_invalidated: true });
      });
    }
    async function checkpoint(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString()), index = evidence.length;
        expect(stage).toBe(stages[index]); expect(data.width).toBe(375); expect(data.scrollWidth).toBeLessThanOrEqual(376);
        const current = await snapshot(); expect(current).toEqual(expected);
        expect(traces.filter(row => row.write)).toHaveLength(writeCounts[index]); expect(traces.filter(row => row.detail)).toHaveLength(detailCounts[index]);
        if (stage !== "invalidRaw") expect(data.theme.style).toContain("--view-theme:");
        const publisher = (edit = false) => { expect(data.publishPanels).toBe(1); expect(data.publishText).toContain(edit ? "编辑帖子" : data.relationPanel ? data.relationPanel : "发布帖子"); };
        const original = () => { expect(data.title).toBe("入口原始图集"); expect(data.content).toBe("编辑入口保留原照片与关联");
          expect(data.selectedTopics).toEqual(["移除话题：入口话题九"]); expect(data.selectedProducts).toEqual(["移除商品：已购好物111"]);
          expect(data.photoCount).toBe(1); expect(data.photos[0].width).toBe(160); };
        const seeded = (name: string) => expect([...data.chosen, ...data.selectedTopics].some((text: string) => text.includes(name))).toBe(true);
        if (stage === "rawPlatform") { expect(data.href).toContain("/pages/discover/workspace?author_id=0"); expect(data.text).toContain("入口验收平台"); expect(data.text).toContain("入口平台作品"); expect(data.text).not.toContain("编辑简介"); }
        if (stage === "rawSelf") { expect(data.href).toMatch(/\/pages\/discover\/workspace\?author_id=(self|11)/u); expect(data.text).toContain("入口原始图集"); expect(data.text).toContain("编辑简介"); }
        if (stage === "rawOther") { expect(data.href).toContain("/pages/discover/workspace?author_id=22"); expect(data.text).toContain("视频作者22"); expect(data.text).not.toContain("编辑简介"); expect(data.text).not.toContain("入口原始图集"); }
        if (["rawFollow", "rawFriends", "rawFans"].includes(stage)) {
          const tab = stage === "rawFollow" ? "follow" : stage === "rawFriends" ? "friend" : "fans";
          expect(data.href).toContain(`/pages/discover/people?tab=${tab}`); expect(data.activePeopleTab).toBe(tab === "follow" ? "关注" : tab === "friend" ? "好友" : "粉丝"); expect(data.people).toEqual(["视频作者22"]);
        }
        if (stage === "rawCreate") { publisher(); expect(data.href).toContain("/pages/discover/workspace?publish=1"); expect(data.title).toBe(""); expect(data.content).toBe("");
          for (const label of ["添加照片", "选择视频", "选择话题（0/5）", "添加商品（0/5）"]) expect(data.buttons).toContain(label); }
        if (["rawSeed", "topicPublisher"].includes(stage)) { publisher(); expect(data.href).toContain("/pages/discover/workspace?publish=1&topic_id=9"); seeded("入口话题九"); }
        if (stage === "rawEditPriority") { publisher(true); expect(data.href).toContain(`/pages/discover/workspace?publish=1&edit_id=${f.gallery.id}`); expect(data.href).not.toContain("topic_id="); original(); }
        if (stage === "topic") { expect(data.href).toContain("/pages/discover/discoverTopic/index?id=9"); expect(data.buttons.includes("去发布") || data.text.includes("去发布")).toBe(true); expect(data.publishPanels).toBe(0); }
        if (stage === "photoUploaded") { publisher(); expect(uploadedUrl).toMatch(/^\/api\/assets\/\d+$/u); expect(data.photoCount).toBe(1); expect(data.photos[0].width).toBe(160); }
        if (["topicsSelected", "productSelected"].includes(stage)) { publisher(); expect(data.selectedTopics).toEqual(["移除话题：入口话题九", "移除话题：入口话题十"]); }
        if (stage === "productSelected") { expect(data.selectedProducts).toEqual(["移除商品：已购好物111"]); expect(data.title).toBe("入口验收新图文"); expect(data.content).toBe("入口照片商品多话题"); }
        if (stage === "createdPending") { expect(data.publishPanels).toBe(0); expect(data.detailTitles).toEqual(["入口验收新图文"]); expect(data.detailText).toContain("正在审核，仅自己可见"); expect(byId(current,"community",createdId)).toMatchObject({ is_verify: 0, play_num: 0 }); }
        if (stage === "editLoaded") { publisher(true); original(); const segment = traces.slice(evidence.at(-1)?.trace_count ?? 0);
          expect(segment.filter(row => row.path === `/api/community/state/${f.gallery.id}`)).toHaveLength(1); expect(segment.some(row => row.detail || row.write)).toBe(false); }
        if (stage === "editedPublic") { expect(configReceipts).toHaveLength(1); expect(data.detailTitles).toEqual(["入口修订图集"]); expect(data.detailText).toContain("已公开"); expect(byId(current,"community",f.gallery.id)).toMatchObject({ is_verify: 1, play_num: 1 }); }
        if (stage === "unknownReady") { publisher(); expect(data.title).toBe("入口未知新帖"); expect(data.content).toBe("已提交503不重发"); seeded("入口话题十"); }
        if (["unknownCommitted", "unknownBlocked"].includes(stage)) { publisher(); expect(data.publishText).toContain("发布结果未确认"); expect(data.submitDisabled).toBe(true);
          const lockedControls = data.publishControls.filter((item: Row) => ["添加照片", "选择视频", "选择话题（1/5）", "添加商品（0/5）"].includes(item.text));
          expect(lockedControls).toHaveLength(4); for (const row of lockedControls) expect(row.disabled).toBe(true);
          expect(unknownId).toBeGreaterThan(0); expect(traces.filter(row => row.path === "/api/community_save" && row.input?.title === "入口未知新帖")).toHaveLength(1); }
        if (stage === "unknownEnded") { expect(data.publishPanels).toBe(0); expect(data.detailTitles).toEqual([]); expect(data.text).toContain("入口未知新帖"); }
        if (stage === "ownerDraft") { publisher(); expect(data.title).toBe("账号11未提交草稿"); expect(data.content).toBe("跨账号不能保留"); }
        if (stage === "ownerOtherEdit") { publisher(true); expect(data.publishText).toMatch(/只能编辑自己的帖子|原帖加载失败/u); expect(data.submitDisabled).toBe(true);
          expect(data.title).toBe(""); expect(data.content).toBe(""); expect(data.photoCount).toBe(0); expect(data.selectedTopics).toEqual([]); expect(data.selectedProducts).toEqual([]); }
        if (["ownerFresh", "finished"].includes(stage)) { publisher(); expect(data.title).toBe(""); expect(data.content).toBe(""); expect(data.photoCount).toBe(0);
          expect(data.selectedTopics).toEqual(["移除话题：入口话题十"]); expect(data.selectedProducts).toEqual([]); expect(data.text).not.toContain("账号11未提交草稿"); }
        if (stage === "invalidRaw") { expect(data.publishPanels).toBe(0); expect(data.text).toMatch(/无效|重复|错误/u);
          const segment = traces.slice(evidence.at(-1)?.trace_count ?? 0);
          expect(segment.every(row => row.path === "/api/get_script" && row.method === "GET" && row.snapshot.read_unchanged)).toBe(true); }
        evidence.push({ stage, ...data, writes: writeCounts[index], detail_reads: detailCounts[index], public_browse_writes: traces.filter(row => row.allowed_mutation?.browse_delta === 1).length,
          trace_count: traces.length, database_sha256: digest(current) });
        if (stage === "finished") {
          expect(configReceipts).toHaveLength(1); expect(traces.filter(row => row.browserStatus === 503)).toHaveLength(1); expect(external).not.toHaveBeenCalled();
          expect(traces.filter(row => row.allowed_mutation?.browse_delta === 1)).toHaveLength(1);
          expect(f.bucket.put.mock.calls).toHaveLength(initialPuts + 1); expect(f.bucket.delete.mock.calls).toHaveLength(initialDeletes);
          finished = true; await writeFile(prefix + "evidence.json", JSON.stringify({ evidence, traces, tables, sequence_count: initial.__sequences.length,
            initial_sha256: digest(initial), final_sha256: digest(current), initial_posts: initial.community, final_posts: current.community,
            initial_profiles: initial.community_user, final_profiles: current.community_user, writes: plans, configuration_receipts: configReceipts,
            created_id: createdId, unknown_id: unknownId, upload_reference: uploadedUrl, protected_profile_ids: f.protectedProfileIds,
            protected_post_ids: f.protectedPostIds, providerCalls: 0, memory_r2: { initial: initialObjects, final: objectState(), puts_delta: 1, deletes_delta: 0 }, static_paths: [...staticPaths].sort(),
            authority: "Actual H5/createApp/JWT and owned local PG16; real PNG chooser/multipart upload; memory R2, synthetic session/history/routes/navigation chrome; one committed save receipt replaced with503",
            limitations: "No production ACL/FK/index proof, no actual login or remote R2/device/provider proof; account controls reload the iframe, late live-owner/unmount races belong to runtime tests; no SQL READ ONLY claim",
          }, null, 2) + "\n"); done();
        }
        json(res, { checked: evidence.map(row => row.stage), finished });
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>社区完整发布入口后台验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:850px;border:1px solid #ddd}pre{max-height:65px;overflow:auto}details{max-width:900px}</style>
<h1>实际 H5 完整发布入口</h1>${Object.entries(routes).map(([key, value]) => `<button data-route="${key}">${value.label}</button>`).join("")}
<button data-viewport="375">375像素内容区</button><button id="review-off">关闭审核开关（仅fixture配置）</button>
<details><summary>26阶段产品操作说明</summary><ol>${instructions.map(([stage, hint]) => `<li>${stage}：${hint}</li>`).join("")}</ol></details>
${stages.map(stage => `<button data-stage="${stage}">${stage}</button>`).join("")}<pre id="result"></pre>
<iframe title="实际完整发布页面" allow="clipboard-write; clipboard-read"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};let requestedRoute='';
for(const button of document.querySelectorAll('[data-route]'))button.onclick=()=>{const r=routes[button.dataset.route];requestedRoute=r.route;
localStorage.setItem('uni_token',JSON.stringify({type:'string',data:r.uid===11?actor:other}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:r.uid}));
frame.src='/?community_publish_entry_session='+r.uid+'-'+Date.now()+'#'+r.route;};
// Explicit outer viewport sizing only. The browser driver must click it before
// EACH checkpoint because route/list/publisher transitions can remove scrollbars.
document.querySelector('[data-viewport]').onclick=()=>{const d=frame.contentDocument;frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
document.getElementById('review-off').onclick=async()=>{const response=await fetch('${control}/review-off',{method:'POST'});document.getElementById('result').textContent=JSON.stringify(await response.json());};
const visible=e=>{for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;};
const txt=e=>(e?.textContent??'').trim().replace(/\\s+/g,' ');
const disabled=b=>!b||b.disabled===true||b.hasAttribute('disabled')||b.classList.contains('uni-button-disabled')||b.getAttribute('aria-disabled')==='true';
const buttons=e=>[...e.querySelectorAll('uni-button,button')].filter(visible);
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,host=d.querySelector('.theme-page'),pub=[...d.querySelectorAll('.publish-sheet')].find(visible),detail=[...d.querySelectorAll('.detail-sheet')].find(visible);
const controls=pub?buttons(pub):[],submit=controls.find(e=>['发布','提交修改','处理中…'].includes(txt(e)));
const data={href:frame.contentWindow.location.href,requestedRoute,width:d.documentElement.clientWidth,innerWidth:frame.contentWindow.innerWidth,scrollWidth:d.documentElement.scrollWidth,text:txt(d.body),
publishPanels:[...d.querySelectorAll('.publish-sheet')].filter(visible).length,publishText:txt(pub),relationPanel:txt(pub?.querySelector('.relation-panel .sheet-title')),
title:pub?.querySelector('input')?.value??'',content:pub?.querySelector('textarea')?.value??'',submitDisabled:disabled(submit),
publishControls:controls.map(e=>({text:txt(e),disabled:disabled(e)})),buttons:buttons(d).map(txt),
selectedTopics:controls.map(txt).filter(t=>t.startsWith('移除话题：')),selectedProducts:controls.map(txt).filter(t=>t.startsWith('移除商品：')),
chosen:controls.filter(e=>e.classList.contains('chosen')).map(txt),photoCount:pub?.querySelectorAll('.photo-item').length??0,
photos:[...(pub?.querySelectorAll('.photo-item img')??[])].map(e=>({width:e.naturalWidth,height:e.naturalHeight,src:e.getAttribute('src')})),
detailTitles:[...d.querySelectorAll('.detail-sheet .detail-title')].filter(visible).map(txt),detailText:txt(detail),
activePeopleTab:txt(d.querySelector('.people-page .tab.active')),people:[...d.querySelectorAll('.person-name')].filter(visible).map(txt),
theme:{className:host?.className??'',style:host?.getAttribute('style')??''}};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host) return send(res, "Owned loopback only", 403);
      const url = new URL(req.url ?? "/", origin), path = url.pathname;
      if (path === control && req.method === "GET") return send(res, shell());
      if (path === control + "/review-off" && req.method === "POST") return review(req, res);
      if (path.startsWith(control + "/") && req.method === "POST") return checkpoint(req, res, url);
      const chrome: Row = { "/api/site_config": { site_name: "社区发布入口验收", site_logo: "", record_No: "", ico_path: "" },
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
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(40763, "127.0.0.1", yes); });
      const ready = { url: origin + control, stages: instructions, routes, width: 375, require_size_control_before_each_checkpoint: true,
        chooser_png: f.chooserPath, chooser_png_sha256: createHash("sha256").update(f.png).digest("hex"), gallery_id: f.gallery.id,
        expected_business_writes: plans, expected_detail_reads: 2, expected_public_browse_writes: 1, expected_configuration_changes: 1,
        controls: "外层只提供synthetic session/route、review配置和375内容区/checkpoint。点击产品添加照片后用真实文件chooser选择PNG；禁止通过API桥替代业务DOM操作。" };
      await writeFile(prefix + "ready.json", JSON.stringify(ready, null, 2) + "\n");
      process.stdout.write("COMMUNITY_PUBLISH_ENTRY_BROWSER_READY " + JSON.stringify(ready) + "\n");
      deadline = setTimeout(() => fail(Error("Browser completion absent within owned eight-minute window")), 8 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 9 * 60_000);
