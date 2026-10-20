import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainerFromDb } from "@/lib/di";
import { CommunityService } from "@/services/community/CommunityService";
import { community, communityRelevance } from "@/models/schema";
import { communityAuthorFixture } from "./helpers/communityAuthorFixture";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native author edit admission", () => {
  let f: Awaited<ReturnType<typeof communityAuthorFixture>>;
  beforeAll(async () => { f = await communityAuthorFixture(); }, 30000);
  afterAll(async () => { await f?.close(); });
  it.each(["is_del=1", "relation_id=22"])("rejects an edit after a locked post changes: %s", async change => {
    const id = change.startsWith("is_del") ? f.gallery.id : f.clip.id;
    const relations = await f.db.select().from(communityRelevance);
    await withFinancePeers(f.db, async ([changing, editing]) => {
      await changing.exec(`BEGIN; UPDATE community SET ${change} WHERE id=${id}`);
      try {
        const work = outcome(new CommunityService(createContainerFromDb(editing.db), f.env.APP_KEY).update(11, id, { content: "不得写入" }, 0));
        await waitForFinanceBlock(f.db, editing.pid, changing.pid); await changing.exec("COMMIT");
        expect((await work).ok).toBe(false);
      } finally { await changing.exec("ROLLBACK"); }
    });
    expect((await f.db.select().from(community)).find(r => r.id === id)?.content).not.toBe("不得写入");
    expect(await f.db.select().from(communityRelevance)).toEqual(relations);
  });
});
