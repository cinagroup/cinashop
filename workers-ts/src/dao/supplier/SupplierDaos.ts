import { and, eq } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { systemSupplier } from "@/models/schema";

export class SystemSupplierDao extends BaseDao<typeof systemSupplier> {
  constructor(db: DB) {
    super(db, systemSupplier, {
      adminId: (value) => eq(systemSupplier.adminId, Number(value)),
      isShow: (value) => eq(systemSupplier.isShow, Number(value)),
      isDel: (value) => eq(systemSupplier.isDel, Number(value)),
    });
  }

  async findActiveByRelation(supplierId: number, adminId: number) {
    const rows = await this.db
      .select()
      .from(systemSupplier)
      .where(
        and(
          eq(systemSupplier.id, supplierId),
          eq(systemSupplier.adminId, adminId),
          eq(systemSupplier.isShow, 1),
          eq(systemSupplier.isDel, 0),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
