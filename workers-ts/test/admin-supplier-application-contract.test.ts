import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Env } from "@/env";
import { createContainerFromDb } from "@/lib/di";
import { systemAdmin, systemAttachment, systemMessage, systemNotification, systemSupplier, systemUserApply, user } from "@/models/schema";
import { SupplierApplicationService } from "@/services/supplier/SupplierApplicationService";
import { financePostgres } from "./helpers/financePostgres";

const shanghaiEpoch = (text: string) => Math.floor(Date.parse(`${text.replace(" ", "T")}+08:00`) / 1000);

describe("supplier application Admin contract", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: SupplierApplicationService;
  beforeEach(async () => {
    fixture = await financePostgres([systemAdmin, systemAttachment, systemMessage, systemNotification,
      systemSupplier, systemUserApply, user]);
    service = new SupplierApplicationService(createContainerFromDb(fixture.db), { APP_KEY: "supplier-application-test-key" } as Env);
    await fixture.db.insert(user).values([
      { uid: 8206, account: "applicant-8206", phone: "13800008206", status: 1 },
      { uid: 8188, account: "applicant-8188", phone: "13800008188", status: 1 },
    ]);
    await fixture.db.insert(systemUserApply).values([
      { id: 106, type: 2, uid: 8206, phone: "13800008206", systemName: "澄明家居", name: "林澄",
        images: "[]", mark: "资质待复核", status: 0, addTime: shanghaiEpoch("2026-09-28 00:00:00") },
      { id: 105, type: 2, uid: 8188, phone: "13800008188", systemName: "海岸选品", name: "周予安",
        images: "[]", failMsg: "营业执照模糊", status: 2, addTime: shanghaiEpoch("2026-09-27 23:59:59") },
      { id: 104, type: 1, uid: 8188, phone: "13800008188", systemName: "其他申请", name: "无关",
        images: "[]", addTime: shanghaiEpoch("2026-09-28 00:00:00") },
    ]);
    await fixture.db.insert(systemNotification).values({ mark: "supplier_verify_fail", isSystem: 1 });
  });
  afterEach(async () => { await fixture?.close(); });

  it("searches all seven legacy fields while keeping type and Shanghai second boundaries", async () => {
    for (const keyword of ["106", "8206", "澄明", "林澄", "13800008206", "资质待复核"]) {
      const result = await service.adminList({ keyword });
      expect(result.list.map((row) => row.id), keyword).toContain(106);
    }
    expect((await service.adminList({ keyword: "营业执照模糊" })).list.map((row) => row.id)).toEqual([105]);
    expect((await service.adminList({ status: "0" })).list.map((row) => row.id)).toEqual([106]);
    expect((await service.adminList({ start_time: "2026-09-28 00:00:00", end_time: "2026-09-28 00:00:00" }))
      .list.map((row) => row.id)).toEqual([106]);
    expect((await service.adminList({ start_time: "2026-09-27 23:59:59", end_time: "2026-09-27 23:59:59" }))
      .list.map((row) => row.id)).toEqual([105]);
    await expect(service.adminList({ start_time: "2026-09-28 00:00:00" })).rejects.toThrow("成对填写");
    await expect(service.adminList({ start_time: "2026-02-30 00:00:00", end_time: "2026-03-01 00:00:00" }))
      .rejects.toThrow("无效");
  });

  it("rejects stale review, mark and deletion without changing the application", async () => {
    const first = (await service.adminList({ status: "0" })).list[0];
    expect(first.version).toMatch(/^[0-9a-f]{64}$/);
    await service.mark(106, first.mark, first.version);
    const identical = await service.adminDetail(106);
    expect(identical.version).not.toBe(first.version);
    await service.mark(106, "新备注", identical.version);
    await expect(service.mark(106, "覆盖", first.version)).rejects.toThrow("申请已更新");
    await expect(service.review(106, { status: 2, fail_msg: "不符合要求", expected_version: first.version }))
      .rejects.toThrow("申请已更新");
    await expect(service.delete(106, first.version)).rejects.toThrow("申请已更新");
    const current = (await service.adminDetail(106));
    expect(current.mark).toBe("新备注");
    expect(current.status).toBe(0);
    expect(current.version).not.toBe(first.version);
    await service.review(106, { status: 2, fail_msg: "不符合要求<script>", expected_version: current.version });
    const reviewed = await service.adminDetail(106);
    expect(reviewed.status).toBe(2);
    const notices = await fixture.db.select().from(systemMessage);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: 8206, mark: "supplier_verify_fail", type: 1 });
    expect(notices[0].content).toContain("不符合要求");
    expect(notices[0].content).toContain("&lt;script&gt;");
    expect(notices[0].content).not.toContain("<script>");
    expect(notices[0].content).not.toContain("密码：");
    await expect(service.delete(106, current.version)).rejects.toThrow("申请已更新");
    await service.delete(106, reviewed.version);
    expect((await service.adminList({})).list.map((row) => row.id)).toEqual([105]);
    expect((await fixture.db.select().from(systemUserApply).where(eq(systemUserApply.id, 106)))[0].isDel).toBe(1);
  });
});
