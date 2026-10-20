import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "@/lib/di";
import { community, systemAttachment, user } from "@/models/schema";
import { AttachmentService, userAttachmentScope } from "@/services/system/AttachmentService";
import { CommunityService } from "@/services/community/CommunityService";
import { communityVideoFixture } from "./helpers/communityVideoFixture";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native community image admission", () => {
  let f: Awaited<ReturnType<typeof communityVideoFixture>>, reference: string, id: number;
  beforeAll(async () => {
    f = await communityVideoFixture();
    const bytes = new Uint8Array(await readFile(resolve(import.meta.dirname, "fixtures/community-teal.png")));
    const media = await new AttachmentService(f.container, f.env).uploadImage(userAttachmentScope(11), new File([bytes], "teal.png", { type: "image/png" }), 0);
    reference = media.url; id = media.att_id;
  }, 30000);
  afterAll(async () => { await f?.close(); });
  it("rechecks ownership after waiting on an actual image row lock and rolls back publication", async () => {
    await withFinancePeers(f.db, async ([changing, publishing]) => {
      await changing.exec(`BEGIN; UPDATE system_attachment SET relation_id=22 WHERE att_id=${id}`);
      try {
        const work = outcome(new CommunityService(createContainerFromDb(publishing.db), f.env.APP_KEY).create(11,
          { title: "", content: "等待中的图集", contentType: 1, sliderImage: [reference] }, 1));
        await waitForFinanceBlock(f.db, publishing.pid, changing.pid); await changing.exec("COMMIT");
        const result = await work; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toContain("不属于");
      } finally { await changing.exec("ROLLBACK"); }
    });
    expect(await f.db.select().from(community)).toEqual([]);
    await f.db.update(systemAttachment).set({ relationId: 11 }).where(eq(systemAttachment.attId, id));
  });
  it("rechecks a concurrently disabled account before accepting private images", async () => {
    await withFinancePeers(f.db, async ([changing, publishing]) => {
      await changing.exec('BEGIN; UPDATE "user" SET status=0 WHERE uid=11');
      try {
        const work = outcome(new CommunityService(createContainerFromDb(publishing.db), f.env.APP_KEY).create(11,
          { title: "", content: "停用中的图集", contentType: 1, sliderImage: [reference] }, 1));
        await waitForFinanceBlock(f.db, publishing.pid, changing.pid); await changing.exec("COMMIT");
        const result = await work; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toContain("用户状态");
      } finally { await changing.exec("ROLLBACK"); }
    });
    expect(await f.db.select().from(community)).toEqual([]);
    await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 11));
  });
});
