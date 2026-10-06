import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/env";
import { createContainerFromDb } from "@/lib/di";
import { systemAdmin, systemAttachment, systemMessage, systemNotification, systemSupplier, systemUserApply, user } from "@/models/schema";
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
import { SupplierApplicationService } from "@/services/supplier/SupplierApplicationService";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";
import { financePostgres } from "./helpers/financePostgres";

const legacyImage = "https://example.test/qualification.jpg";

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("supplier application row and applicant lock order on native PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  const env = { APP_KEY: "isolated-supplier-review-key" } as Env;
  beforeEach(async () => {
    fixture = await financePostgres([systemAdmin, systemAttachment, systemMessage, systemNotification,
      systemSupplier, systemUserApply, user]);
    await fixture.db.insert(user).values({ uid: 8206, account: "applicant-8206", phone: "13800008206", status: 1 });
    await fixture.db.insert(systemUserApply).values({ id: 106, type: 2, uid: 8206,
      phone: "13800008206", systemName: "澄明家居", name: "林澄", images: JSON.stringify([legacyImage]),
      addTime: 1_700_000_000 });
    vi.spyOn(SmsVerificationService.prototype, "verifySupplierCode").mockResolvedValue("13800008206");
    vi.spyOn(SmsVerificationService.prototype, "consumeSupplierCode").mockResolvedValue();
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.close(); }, 30_000);

  it("lets resubmission finish before a stale reviewer can lock the changed material", async () => {
    const current = await new SupplierApplicationService(createContainerFromDb(fixture.db), env).adminDetail(106);
    await withFinancePeers(fixture.db, async ([blocker, submitter, reviewer]) => {
      await blocker.exec("BEGIN; SELECT uid FROM \"user\" WHERE uid=8206 FOR UPDATE");
      try {
        const resubmit = outcome(new SupplierApplicationService(createContainerFromDb(submitter.db), env)
          .submit(8206, 106, { phone: "13800008206", system_name: "澄明家居更新", name: "林澄",
            images: [legacyImage], code: "test-code" }));
        await waitForFinanceBlock(fixture.db, submitter.pid, blocker.pid);
        const review = outcome(new SupplierApplicationService(createContainerFromDb(reviewer.db), env)
          .review(106, { status: 2, fail_msg: "材料无效", expected_version: current.version }));
        await waitForFinanceBlock(fixture.db, reviewer.pid, submitter.pid);
        await blocker.exec("COMMIT");
        const submitted = await resubmit;
        const reviewed = await review;
        expect(submitted.ok, submitted.ok ? "" : String(submitted.error)).toBe(true);
        expect(reviewed.ok).toBe(false);
        if (!reviewed.ok) expect(String(reviewed.error)).toContain("申请已更新");
      } finally { await blocker.exec("ROLLBACK"); }
    });
    const updated = await new SupplierApplicationService(createContainerFromDb(fixture.db), env).adminDetail(106);
    expect(updated.system_name).toBe("澄明家居更新");
    expect(updated.status).toBe(0);
  }, 30_000);
});
