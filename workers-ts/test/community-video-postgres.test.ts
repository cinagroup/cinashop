import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "@/lib/di";
import { systemAttachment, user } from "@/models/schema";
import { AttachmentService } from "@/services/system/AttachmentService";
import { communityVideoFixture } from "./helpers/communityVideoFixture";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("customer video native commit boundaries", () => {
  let f: Awaited<ReturnType<typeof communityVideoFixture>>;
  beforeAll(async () => { f = await communityVideoFixture(); }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  it("a concurrent account disable wins before metadata admission and only the new object is removed", async () => {
    const before = [...f.objects.keys()];
    await withFinancePeers(f.db, async ([disabling, uploading]) => {
      await disabling.exec("BEGIN; UPDATE \"user\" SET status=0 WHERE uid=11");
      try {
        const work = outcome(new AttachmentService(createContainerFromDb(uploading.db), f.env).uploadUserVideo(11, f.file()));
        await waitForFinanceBlock(f.db, uploading.pid, disabling.pid);
        await disabling.exec("COMMIT");
        const result = await work; expect(result.ok).toBe(false);
        if (!result.ok) expect(String(result.error)).toContain("用户状态");
      } finally { await disabling.exec("ROLLBACK"); }
    });
    expect([...f.objects.keys()]).toEqual(before);
    await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 11));
  });
  it("keeps a committed video object when the database commit acknowledgement is lost", async () => {
    const before = f.objects.size, original = f.db.transaction.bind(f.db);
    const lost = Object.assign(Error("synthetic lost COMMIT reply"), { code: "40003" });
    const transaction = vi.spyOn(f.db, "transaction").mockImplementation(async (...args) => {
      await original(...args); throw lost;
    });
    try { await expect(new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file())).rejects.toBe(lost); }
    finally { transaction.mockRestore(); }
    expect(f.objects.size).toBe(before + 1);
    const rows = await f.db.select().from(systemAttachment).where(eq(systemAttachment.relationId, 11));
    expect(rows).toHaveLength(1); expect(f.objects.has(rows[0].name)).toBe(true);
    expect(rows[0].attDir).toBe(`/api/assets/${rows[0].attId}`);
  });
  it("rolls back silently mutated ownership and removes the unreferenced object", async () => {
    const before = [...f.objects.keys()], rows = await f.db.select().from(systemAttachment);
    await f.exec(`CREATE FUNCTION video_owner_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.relation_id := 22; RETURN NEW; END; $$;
      CREATE TRIGGER video_owner_mutation BEFORE INSERT ON system_attachment
      FOR EACH ROW EXECUTE FUNCTION video_owner_mutation();`);
    try { await expect(new AttachmentService(f.container, f.env).uploadUserVideo(11, f.file())).rejects.toThrow("记录未完整保存"); }
    finally { await f.exec("DROP TRIGGER video_owner_mutation ON system_attachment; DROP FUNCTION video_owner_mutation();"); }
    expect([...f.objects.keys()]).toEqual(before);
    expect(await f.db.select().from(systemAttachment)).toEqual(rows);
  });
});
