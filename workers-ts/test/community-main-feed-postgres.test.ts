import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { community, communityRelevance, communityTopic, communityUser, systemConfig, systemUserLevel, user, userFriends } from "@/models/schema";
import { CommunitySocialService } from "@/services/community/CommunitySocialService";
import { AttachmentService, userAttachmentScope } from "@/services/system/AttachmentService";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { communityVideoFixture } from "./helpers/communityVideoFixture";

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(), createContainer: () => {
  if (!wiring.container) throw Error("Missing owned main-feed SQL"); return wiring.container;
} }));
type Row = Record<string, any>;
const ids = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native main community feed and bounded typed recommendations", () => {
  let f: Awaited<ReturnType<typeof communityVideoFixture>>, tables: string[];
  const app = createApp();
  beforeAll(async () => {
    f = await communityVideoFixture([userFriends, systemUserLevel]); wiring.container = f.container;
    tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r => r.name);
    expect(tables).toHaveLength(14);
  }, 30_000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); });
  beforeEach(async () => {
    await f.reset(); f.cache.clear(); f.objects.clear(); f.counts.clear();
    for (const mock of Object.values(f.bucket)) mock.mockClear();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Main feed fixtures forbid provider I/O"));
    await f.db.insert(user).values([11,22,33,44,55,66,99].map(uid => ({ uid, account: `main-feed-${uid}`, pwd: "synthetic-video-password",
      nickname: `真实作者${uid}`, status: uid === 44 ? 0 : 1, isDel: uid === 55 ? 1 : 0 })));
    await f.db.insert(communityUser).values([
      { type: 0, relationId: 0, nickname: "平台", communityNum: 21, fansNum: 900, status: 1 },
      { type: 2, relationId: 11, communityNum: 1, followNum: 2, status: 1 },
      { type: 2, relationId: 22, communityNum: 21, fansNum: 50, status: 1 },
      { type: 2, relationId: 33, communityNum: 5, fansNum: 1000, status: 1 },
      { type: 2, relationId: 99, communityNum: 9, fansNum: 7, status: 1 },
      ...[44,55].map(relationId => ({ type: 2, relationId, communityNum: 9, fansNum: 99999, status: 1 })),
      ...[0,1,3].map(type => ({ type, relationId: 22, nickname: "异型同号", communityNum: 999, fansNum: 999999, status: 1 })),
    ]);
    await f.db.insert(systemConfig).values([{ menuName: "community_status", value: "1" }, { menuName: "station_open", value: "1" },
      { menuName: "site_name", value: '"主列表平台"' }, { menuName: "wap_login_logo", value: '""' }]);
    await f.db.insert(communityTopic).values([9,10].map(id => ({ id, name: `主列表话题${id}`, status: 1 })));
    const posts: Array<typeof community.$inferInsert> = [
      ...ids(1001,21).map((id,i) => ({ id, type: 2, relationId: 22, title: `关注主帖${i+1}`, content: "混合内容", contentType: i%2+1,
        status: 1, isVerify: 1, star: 100-i, addTime: 1000+i, likeNum: 900+i, playNum: 20+i })),
      ...ids(2001,21).map((id,i) => ({ id, type: 0, relationId: 0, title: `平台主帖${i+1}`, contentType: i%2+1,
        status: 1, isVerify: 1, star: 200-i, addTime: 2000+i })),
      ...ids(3001,5).map((id,i) => ({ id, type: 2, relationId: 33, title: `推荐预览${i+1}`, image: `https://media.example.test/${id}.jpg`,
        contentType: i%2+1, status: 1, isVerify: 1, star: 300-i, addTime: 3000+i })),
      ...[0,1,3].map((type,i) => ({ id: 4001+i, type, relationId: 22, title: "异型同号旁观", status: 1, isVerify: 1, star: 9999 })),
      ...[0,44,55,88].map((relationId,i) => ({ id: 4004+i, type: 2, relationId, title: "不可社交作者", status: 1, isVerify: 1, star: 9998 })),
      { id: 4101, type: 2, relationId: 22, title: "未审核", status: 1, isVerify: 0, star: 9999 },
      { id: 4102, type: 2, relationId: 22, title: "下架", status: 0, isVerify: 1, star: 9999 },
      { id: 4103, type: 2, relationId: 22, title: "删除", status: 1, isVerify: 1, isDel: 1, star: 9999 },
      { id: 4201, type: 2, relationId: 11, title: "本人待审", status: 1, isVerify: 0 },
    ];
    await f.db.insert(community).values(posts);
    await f.db.insert(communityRelevance).values([
      ...ids(1001,21).map(leftId => ({ leftId, rightId: 9, type: "community_topic" })),
      ...ids(2001,21).map(leftId => ({ leftId, rightId: 10, type: "community_topic" })),
      { leftId: 1001, rightId: 9, type: "community_topic" },
      ...[22,22,0,44,55,88].map(rightId => ({ leftId: 11, rightId, type: "community_interest" })),
      { leftId: 22, rightId: 33, type: "community_interest" },
    ]);
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function snapshot() {
    const out: Record<string, Row[]> = {};
    for (const name of tables) out[name] = (await f.db.execute<{ row: Row }>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`))
      .map(r => r.row).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out.__sequences = await f.db.execute(sql`SELECT sequencename AS name,last_value::text AS last FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`);
    expect(out.__sequences).toHaveLength(14); return out;
  }
  async function request(path: string, viewer: 0|11|22 = 11, method = "GET", body?: Row) {
    const response = await app.request(path, { method, headers: { "content-type": "application/json",
      ...(viewer ? { Authorization: `Bearer ${viewer===11?f.token:f.otherToken}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }, f.env);
    expect(response.status).toBe(200); return await response.json() as Row;
  }
  async function read(path: string, viewer: 0|11|22 = 11) {
    const before = await snapshot(), storage = { puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, objects: [...f.objects.keys()] };
    const body = await request(path,viewer); expect(await snapshot()).toEqual(before);
    expect({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, objects: [...f.objects.keys()] }).toEqual(storage);
    expect(body.status).toBe(200); return body.data as Row[];
  }
  const list = (query: string, viewer: 0|11|22 = 11) => read("/api/community/list?"+query,viewer);
  it("paginates the actual mixed followed author's 21 rows as 10/10/1 then empty, without duplicate topic or interest rows", async () => {
    for (let page=1;page<=4;page++) {
      const rows = await list(`page=${page}&limit=10&is_follow=1&author_type=2&relation_id=22&topic_id=9`);
      expect(rows.map(r=>r.id)).toEqual(ids(1001+(page-1)*10,Math.max(0,Math.min(10,21-(page-1)*10))));
      expect(rows.every(r=>r.is_follow===1)).toBe(true);
    }
  });
  it("fills pages only with canonical active followed identities, including platform zero, before OFFSET/LIMIT", async () => {
    const all=[...ids(2001,21),...ids(1001,21)];
    for (let page=1;page<=5;page++) expect((await list(`is_follow=1&page=${page}&limit=10`)).map(r=>r.id)).toEqual(all.slice((page-1)*10,page*10));
    expect((await list("is_follow=1&limit=100")).every(r=>r.is_follow===1)).toBe(true);
  });
  it("preserves unrelated public discover authors while projecting follow flags by canonical identity", async () => {
    const rows=await list("limit=100");expect(rows.slice(0,7).map(r=>r.id)).toEqual([4003,4002,4001,4007,4006,4005,4004]);
    for (const id of ids(4001,7)) expect(rows.find(r=>r.id===id)?.is_follow).toBe(0);
    expect(rows.find(r=>r.id===2001)?.is_follow).toBe(1);expect(rows.find(r=>r.id===1001)?.is_follow).toBe(1);
    expect(rows.some(r=>r.id===4201||r.id>=4101&&r.id<=4103)).toBe(false);
  });
  it("uses star/add_time/id default hot order rather than likes and retains the existing explicit latest sort", async () => {
    const base="author_type=2&relation_id=22&limit=100";
    expect((await list(base)).map(r=>r.id)).toEqual(ids(1001,21));
    expect((await list(base+"&order=1")).map(r=>r.id)).toEqual(ids(1001,21).reverse());
    await f.db.update(community).set({ star: 5, addTime: 10 }).where(and(eq(community.type,2),eq(community.relationId,22)));
    expect((await list(base)).map(r=>r.id)).toEqual(ids(1001,21).reverse());
  });
  it("has independent inline topic membership, mixed content and an empty exact full-page successor", async () => {
    expect((await list("topic_id=9&limit=100")).map(r=>r.id)).toEqual(ids(1001,21));
    const mixed=await list("is_follow=1&topic_id=9&limit=100");expect(new Set(mixed.map(r=>r.content_type))).toEqual(new Set([1,2]));
    await f.db.delete(community).where(eq(community.id,1021));
    expect((await list("is_follow=1&topic_id=9&page=2&limit=10")).map(r=>r.id)).toEqual(ids(1011,10));
    expect(await list("is_follow=1&topic_id=9&page=3&limit=10")).toEqual([]);
  });
  it("returns guest following empty without protected helper calls and isolates another viewer's graph", async () => {
    expect(await list("is_follow=1",0)).toEqual([]);
    expect((await list("is_follow=1&limit=100",22)).map(r=>r.id)).toEqual(ids(3001,5));
    const before=await snapshot();expect((await request("/api/community/recommend_list",0)).status).toBe(410000);expect(await snapshot()).toEqual(before);
  });
  it.each([44,55,88])("unavailable account %s cannot consume following page slots or acquire a positive follow DTO", async target => {
    expect(await list(`is_follow=1&relation_id=${target}&limit=1`)).toEqual([]);
    expect((await list(`relation_id=${target}&limit=1`))[0]?.is_follow).toBe(0);
  });
  it("retains readable disabled profiles and real accounts with no materialized profile without creating them", async () => {
    await f.db.update(communityUser).set({ status: 0 }).where(and(eq(communityUser.type,2),eq(communityUser.relationId,22)));
    await f.db.insert(community).values({ id: 5001, type: 2, relationId: 66, title: "未建资料真实作者", status: 1, isVerify: 1, star: 999 });
    await f.db.insert(communityRelevance).values({ leftId: 11, rightId: 66, type: "community_interest" });
    expect((await list("is_follow=1&relation_id=22&limit=1"))[0].id).toBe(1001);
    expect((await list("is_follow=1&relation_id=66"))[0]).toMatchObject({ id: 5001, is_follow: 1, author: "真实作者66" });
    expect(await f.db.select().from(communityUser).where(eq(communityUser.relationId,66))).toEqual([]);
  });
  it("does not manufacture platform identity from a type2/zero collision when the canonical platform profile is absent", async () => {
    await f.db.delete(communityUser).where(and(eq(communityUser.type,0),eq(communityUser.relationId,0)));
    await f.db.insert(communityUser).values({ type: 2, relationId: 0, communityNum: 99 });
    expect(await list("is_follow=1&author_type=0&relation_id=0")).toEqual([]);
    expect((await list("author_type=0&relation_id=0&limit=1"))[0].is_follow).toBe(0);
  });
  it("keeps original typed owner preview separate from the public following feed even with a dirty self edge", async () => {
    await f.db.insert(communityRelevance).values({ leftId: 11,rightId:11,type:"community_interest" });
    expect((await list("author_type=2&relation_id=11")).map(r=>r.id)).toEqual([4201]);
    expect(await list("author_type=2&relation_id=11&is_follow=1")).toEqual([]);
  });
  it("projects three typed public recommendation teasers per author without visits, with canonical pagination and an empty array for no posts", async () => {
    const people=await read("/api/community/recommend_list?limit=100");
    expect(people.map(r=>r.relation_id)).toEqual([33,99]);
    expect(people[0].community).toEqual(ids(3001,3).map((id,i)=>({ id,type:2,relation_id:33,content_type:i%2+1,title:`推荐预览${i+1}`,image:`https://media.example.test/${id}.jpg` })));
    expect(people[1].community).toEqual([]);
    expect((await read("/api/community/recommend_list?page=1&limit=1"))[0].relation_id).toBe(33);
    expect((await read("/api/community/recommend_list?page=2&limit=1"))[0].relation_id).toBe(99);
    expect(await read("/api/community/recommend_list?page=3&limit=1")).toEqual([]);
  });
  it("recommendation teasers never include same-number virtual/store/platform, hidden, deleted, or unreviewed posts", async () => {
    await f.db.insert(community).values([
      ...[0,1,3].map((type,i)=>({ id:5100+i,type,relationId:33,title:"不属于真实作者",status:1,isVerify:1,star:9999 })),
      { id:5110,type:2,relationId:33,title:"待审",status:1,isVerify:0,star:9999 },
      { id:5111,type:2,relationId:33,title:"下架",status:0,isVerify:1,star:9999 },
      { id:5112,type:2,relationId:33,title:"已删除",status:1,isVerify:1,isDel:1,star:9999 },
    ]);
    expect((await read("/api/community/recommend_list")).find(r=>r.relation_id===33)?.community.map((r:Row)=>r.id)).toEqual(ids(3001,3));
  });
  it("supports platform-zero previews through its canonical author only", async () => {
    await f.db.delete(communityRelevance).where(and(eq(communityRelevance.leftId,11),eq(communityRelevance.rightId,0),eq(communityRelevance.type,"community_interest")));
    await f.db.insert(community).values({ id:5201,type:2,relationId:0,title:"错误零号",status:1,isVerify:1,star:9999 });
    const platform=(await read("/api/community/recommend_list")).find(r=>r.relation_id===0)!;
    expect(platform.type).toBe(0);expect(platform.community.map((r:Row)=>r.id)).toEqual(ids(2001,3));
  });
  it("signs only the exact public author's owned private cover through the real controller and never exposes a dirty cross-owner reference", async () => {
    const png=new Uint8Array(await readFile(resolve(import.meta.dirname,"fixtures/community-teal.png")));
    const attachments=new AttachmentService(f.container,f.env);
    const other=await attachments.uploadImage(userAttachmentScope(22),new File([png],"other.png",{type:"image/png"}),0);
    const own=await attachments.uploadImage(userAttachmentScope(33),new File([png],"own.png",{type:"image/png"}),0);
    await f.db.update(community).set({ image:other.url }).where(eq(community.id,3001));
    await f.db.update(community).set({ image:own.url }).where(eq(community.id,3002));
    const previews=(await read("/api/community/recommend_list")).find(r=>r.relation_id===33)!.community;
    expect(previews[0].image).toBe("");expect(previews[1].image).toMatch(new RegExp("^"+own.url+"\\?expires=\\d+&signature="));
    expect(f.bucket.put).toHaveBeenCalledTimes(2);expect(f.bucket.delete).not.toHaveBeenCalled();
    const before=await snapshot(),response=await app.request(previews[1].image,{},f.env);expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);expect(await snapshot()).toEqual(before);
    await expect(new CommunitySocialService(f.container).recommendations(11,1,20)).rejects.toThrow("APP_KEY未配置");
  });
  it("refreshes membership after an explicit idempotent real follow with only exact profile/interest and sequence changes", async () => {
    const before=await snapshot();expect((await request("/api/community/set_interest/33",11,"POST",{status:1})).status).toBe(200);
    const after=await snapshot(),want=structuredClone(before),inserted=after.community_relevance.filter(r=>!before.community_relevance.some(old=>old.id===r.id));
    expect(inserted).toHaveLength(1);expect(inserted[0]).toEqual({ id:inserted[0].id,left_id:11,right_id:33,type:"community_interest" });
    want.community_relevance.push(inserted[0]);want.community_relevance.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    want.community_user=want.community_user.map(r=>r.type===2&&r.relation_id===11?{...r,follow_num:r.follow_num+1}:r.type===2&&r.relation_id===33?{...r,fans_num:r.fans_num+1}:r);
    const seq=want.__sequences.find(r=>r.name==="community_relevance_id_seq")!;expect(inserted[0].id).toBe(Number(seq.last)+1);seq.last=String(inserted[0].id);expect(after).toEqual(want);
    expect((await list("is_follow=1&page=1&limit=10")).slice(0,5).map(r=>r.id)).toEqual(ids(3001,5));
    expect((await read("/api/community/recommend_list")).some(r=>r.relation_id===33)).toBe(false);
    expect((await request("/api/community/set_interest/33",11,"POST",{status:1})).status).toBe(200);expect(await snapshot()).toEqual(after);
  });
});
