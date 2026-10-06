import { afterEach, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createContainerFromDb } from "@/lib/di";
import { systemAdmin, systemLog, systemRole, systemSupplier } from "@/models/schema";
import { SupplierAdminService, type SupplierAdminInput } from "@/services/supplier/SupplierAdminService";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>;
const actor = { id: 100, name: "供应商主管理员", ip: "127.0.0.1" };
const service = () => new SupplierAdminService(createContainerFromDb(fixture.db));
const input = (account: string, phone: string, password?: string): SupplierAdminInput => ({
  account, realName: "仓库管理员", phone, roles: [20], status: 1, headPic: "",
  ...(password ? { password } : {}),
});

beforeEach(async () => {
  fixture = await financePostgres([systemSupplier, systemAdmin, systemRole, systemLog]);
  await fixture.db.insert(systemSupplier).values({ id: 1, adminId: 100,
    supplierName: "甲供应商", isShow: 1 });
  await fixture.db.insert(systemAdmin).values({ id: 100, account: "primary-owner",
    adminType: 4, relationId: 1, level: 0, status: 1, isDel: 0 });
  await fixture.db.insert(systemRole).values({ id: 20, type: 4, relationId: 1,
    roleName: "仓库", rules: "supplier.order.view", status: 1 });
}, 30_000);
afterEach(async () => { await fixture?.close(); });

it("uses the same case-insensitive account namespace for child creation and rename", async () => {
  const created = await service().create(1, actor,
    input("Warehouse-User", "13800138001", "A-strong-password-2026"));
  await expect(service().create(1, actor,
    input("warehouse-user", "13800138002", "A-strong-password-2026")))
    .rejects.toThrow("管理员账号已存在");
  await fixture.db.insert(systemAdmin).values({ id: 101, account: "platform-named",
    adminType: 1, relationId: 0, level: 1, status: 1, isDel: 0 });
  await expect(service().update(1, actor, created.id,
    input("PLATFORM-NAMED", "13800138001"))).rejects.toThrow("管理员账号已存在");
  expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.id)))[0].account)
    .toBe("Warehouse-User");
});

it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)(
  "waits for the shared account allocator lock before creating a child account on native PostgreSQL",
  async () => {
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const holder = fixture.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(505607, 0)`);
      ready();
      await held;
    });
    await locked;
    const attempt = service().create(1, actor,
      input("waiting-child", "13800138003", "A-strong-password-2026"));
    try {
      let waiting = 0;
      const deadline = Date.now() + 1_200;
      while (Date.now() < deadline) {
        const rows = await fixture.db.execute(sql<{ waiting: number }>`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 505607 AND objid = 0
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND granted = false
        `);
        waiting = Number(rows[0]?.waiting ?? 0);
        if (waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBeGreaterThan(0);
      expect((await fixture.db.select().from(systemAdmin))).toHaveLength(1);
    } finally {
      release();
      await holder;
    }
    const created = await attempt;
    expect(created.id).toBeGreaterThan(0);
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, created.id)))[0].account)
      .toBe("waiting-child");
  },
  30_000,
);
