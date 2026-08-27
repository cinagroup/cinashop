import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Container } from "../src/lib/di";
import { CommunityService } from "../src/services/community/CommunityService";
import { normalizeClientCommunityPostInput } from "../src/services/community/AdminCommunityService";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";

function selectRows(rows: unknown[]) {
  const limitResult = () => {
    const promise = Promise.resolve(rows);
    return {
      for: vi.fn().mockResolvedValue(rows),
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(limitResult) })),
    })),
  };
}

describe("community legacy moderation fields", () => {
  it("keeps public moderation gates while allowing only an owning user to preview", () => {
    const source = readFileSync("src/services/community/CommunityService.ts", "utf8");
    expect(source).toContain("const isPublic = item?.status === 1 && item.isVerify === 1");
    expect(source).toContain("!isPublic && (item.type !== 2 || item.relationId !== uid)");
    expect(source).toContain("item.type !== 2 || item.relationId !== uid");
    expect(source).toContain("eq(communityTable.isDel, 0)");
    expect(source).toMatch(/const playNum = isPublic[\s\S]+recordBrowse\(id, uid\)[\s\S]+: item\.playNum/);
  });

  it("normalizes bounded client posts without inheriting Admin-only required topics", () => {
    expect(normalizeClientCommunityPostInput({
      content_type: 1,
      title: "  我的更新 ",
      content: "正文",
      slider_image: ["cover.jpg", "cover.jpg"],
      topic_id: [],
      product_id: "7,8",
    }, 0)).toMatchObject({
      title: "我的更新",
      image: "cover.jpg",
      sliderImage: ["cover.jpg"],
      topicIds: [],
      productIds: [7, 8],
      isVerify: 0,
    });
    expect(() => normalizeClientCommunityPostInput({ content_type: 2, content: "视频" }, 1))
      .toThrow("视频内容必须填写视频地址");
    expect(() => normalizeClientCommunityPostInput({ title: "", content: "" }, 1))
      .toThrow("帖子内容不能为空");
  });

  it("delegates owned deletion to the locked moderation cascade", () => {
    const source = readFileSync("src/services/community/CommunityService.ts", "utf8");
    const lifecycle = readFileSync("src/services/community/AdminCommunityService.ts", "utf8");
    expect(source).toContain("deleteOwnedPost(id, uid)");
    expect(lifecycle).toContain("row.type !== 2 || row.relationId !== ownerUid");
    expect(lifecycle).toContain("await tx.update(communityComment).set({ isShow: 0, isDel: 1 })");
    expect(lifecycle).toContain("COMMUNITY_COMMENT_LIKE");
  });

  it("writes user comments as visible top-level rows under the post lock", () => {
    const source = readFileSync("src/services/community/CommunityService.ts", "utf8");
    const lifecycle = readFileSync("src/services/community/AdminCommunityService.ts", "utf8");
    expect(source).toContain("addUserComment(");
    expect(lifecycle).toContain("const post = await this.lockPost(tx, communityId)");
    expect(lifecycle).toMatch(/type: 2,[\s\S]*isVerify: 1,[\s\S]*isShow: 1,[\s\S]*isReply: 1/);
    expect(lifecycle).toContain("await this.syncCommentCounts(tx, communityId, [])");
  });

  it("preserves all three legacy auxiliary tables without forcing dirty relations unique", () => {
    const migration = readFileSync("migrations/0039_community_relationships.sql", "utf8");
    const tables = MIGRATION_TABLES.map((entry) => entry.table);

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "community_topic"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "community_relevance"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "community_user"');
    expect(migration).toContain('"cr_left_type_right"');
    expect(migration).toContain('"cr_right_type_left"');
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX[^;]+community_relevance/s);
    expect(tables).toEqual(
      expect.arrayContaining(["community_topic", "community_relevance", "community_user"]),
    );
  });

  it("makes an already-recorded like idempotent inside the relation lock", async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectRows([{ id: 9, type: 2, relationId: 42, likeNum: 7 }]),
        )
        .mockReturnValueOnce(selectRows([{ id: 100 }])),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const service = new CommunityService({
      db: {
        transaction: vi.fn(async (callback: (db: unknown) => Promise<unknown>) => callback(tx)),
      },
    } as unknown as Container);

    await expect(service.like(5, 9, 1)).resolves.toEqual({ likeNum: 7, status: 1 });
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("records a new like and updates post and author counters in one transaction", async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const postReturning = vi.fn().mockResolvedValue([{ likeNum: 3 }]);
    const authorWhere = vi.fn().mockResolvedValue(undefined);
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectRows([{ id: 9, type: 2, relationId: 42, likeNum: 2 }]),
        )
        .mockReturnValueOnce(selectRows([])),
      insert: vi.fn(() => ({ values: insertValues })),
      update: vi
        .fn()
        .mockReturnValueOnce({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ returning: postReturning })),
          })),
        })
        .mockReturnValueOnce({
          set: vi.fn(() => ({ where: authorWhere })),
        }),
    };
    const transaction = vi.fn(async (callback: (db: unknown) => Promise<unknown>) => callback(tx));
    const service = new CommunityService({ db: { transaction } } as unknown as Container);

    await expect(service.like(5, 9, 1)).resolves.toEqual({ likeNum: 3, status: 1 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith({
      leftId: 5,
      rightId: 9,
      type: "community_like",
    });
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(postReturning).toHaveBeenCalledOnce();
    expect(authorWhere).toHaveBeenCalledOnce();
  });

  it("keeps legacy route aliases while exposing the migrated topic endpoint", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/CommunityController.ts", "utf8");

    expect(routes).toContain('"/community/topic"');
    expect(routes).toContain('"/community/community_like/:id"');
    expect(routes).toContain('"/community/community_save"');
    for (const route of [
      '"/community/config"',
      '"/community/product_list"',
      '"/community/topic_count/:id"',
      '"/community/community_update/:id"',
      '"/community/like_list"',
      '"/community/elegant_list"',
      '"/community/share/:id"',
      '"/community/comment_like/:id"',
      '"/community/comment_delete/:id"',
    ]) expect(routes).toContain(route);
    expect(controller).toContain("topicIds: Array.isArray(body.topic_id)");
    expect(controller).toContain("productIds: Array.isArray(body.product_id)");
    expect(controller).toContain("community_comment_verify");
    expect(controller).toContain("comment_reply_id");
    expect(readFileSync("src/services/community/CommunityService.ts", "utf8"))
      .toContain("cr.right_id IN (${topicParameters})");
  });

  it("keeps the external and embedded client indexes byte-equivalent", () => {
    const migration = readFileSync("migrations/0089_community_client_indexes.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0096\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"cc_public_replies"');
    expect(migration).toContain('"spl_user_source_latest"');
    expect(migration).toContain('"ur_user_product_collect_latest"');
  });

  it("keeps production client writes inside an authenticated disposable-schema audit", () => {
    const scenario = readFileSync("test/integration/CommunityClientPostgresScenario.ts", "utf8");
    const worker = readFileSync("test/integration/CommunityClientAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/community-client-audit.wrangler.toml", "utf8");
    expect(scenario).toContain("codex_community_client_");
    expect(scenario).toContain("SET LOCAL search_path");
    expect(scenario).toContain("public_state_unchanged");
    expect(scenario).toContain("DROP SCHEMA");
    expect(scenario).not.toMatch(/insert\(.*public\./is);
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(worker).toContain("timingSafeEqual");
    expect(worker).toContain('\"/cleanup-schemas\"');
    expect(worker).toContain("business_rows_unchanged");
    expect(config).toContain('id = "9748c294e21c49a99579c9cef70102e0"');
  });
});
