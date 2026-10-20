import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainerFromDb } from "@/lib/di";
import { community, communityRelevance } from "@/models/schema";
import { CommunityService } from "@/services/community/CommunityService";
import { communityRelationsFixture } from "./helpers/communityRelationsFixture";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native community relation admission", () => {
  let f: Awaited<ReturnType<typeof communityRelationsFixture>>;
  beforeAll(async () => { f = await communityRelationsFixture(); }, 30000);
  afterAll(async () => { await f?.close(); });
  it.each([
    { mutation: "UPDATE store_product SET is_show=0 WHERE id=111", refs: { productIds: [111] }, error: "商品" },
    { mutation: "UPDATE community_topic SET status=0 WHERE id=9", refs: { topicIds: [9] }, error: "话题" },
  ])("rechecks a concurrent retirement after waiting on its actual row lock: $error", async ({ mutation, refs, error }) => {
    await withFinancePeers(f.db, async ([changing, publishing]) => {
      await changing.exec(`BEGIN; ${mutation}`);
      try {
        const work = outcome(new CommunityService(createContainerFromDb(publishing.db), f.env.APP_KEY).create(11,
          { title: "", content: "等待中的关联", contentType: 1, ...refs }, 1));
        await waitForFinanceBlock(f.db, publishing.pid, changing.pid); await changing.exec("COMMIT");
        const result = await work; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toContain(error);
      } finally { await changing.exec("ROLLBACK"); }
    });
    expect(await f.db.select().from(community)).toEqual([]);
    expect(await f.db.select().from(communityRelevance)).toEqual([]);
  });
});
