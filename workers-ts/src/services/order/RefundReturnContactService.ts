import { and, eq } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { systemStore, systemSupplier } from "@/models/schema";
import { normalizeConfigScalar } from "@/utils/config";

export interface RefundReturnContact {
  source: "platform" | "store" | "supplier";
  name: string;
  phone: string;
  address: string;
}

interface RefundReturnScope {
  applyType: number;
  storeId: number;
  supplierId: number;
}

function bounded(value: unknown, maximum: number): string {
  return typeof value === "string" ? [...value.trim()].slice(0, maximum).join("") : "";
}

function joinedAddress(address: unknown, detail: unknown): string {
  return bounded(`${bounded(address, 255)}${bounded(detail, 255)}`, 500);
}

/** Resolve only the authenticated refund owner's intended return destination. */
export async function resolveRefundReturnContact(
  container: Container,
  scope: RefundReturnScope,
): Promise<RefundReturnContact> {
  if (scope.applyType === 3) {
    const rows = scope.storeId > 0
      ? await container.db
          .select({
            name: systemStore.name,
            phone: systemStore.phone,
            address: systemStore.address,
            detailedAddress: systemStore.detailedAddress,
          })
          .from(systemStore)
          .where(and(eq(systemStore.id, scope.storeId), eq(systemStore.isDel, 0)))
          .limit(1)
      : [];
    return {
      source: "store",
      name: bounded(rows[0]?.name, 100),
      phone: bounded(rows[0]?.phone, 32),
      address: joinedAddress(rows[0]?.address, rows[0]?.detailedAddress),
    };
  }

  if (scope.supplierId > 0) {
    const rows = await container.db
      .select({
        name: systemSupplier.supplierName,
        phone: systemSupplier.phone,
        address: systemSupplier.detailedAddress,
      })
      .from(systemSupplier)
      .where(and(
        eq(systemSupplier.id, scope.supplierId),
        eq(systemSupplier.isDel, 0),
      ))
      .limit(1);
    return {
      source: "supplier",
      name: bounded(rows[0]?.name, 100),
      phone: bounded(rows[0]?.phone, 32),
      address: bounded(rows[0]?.address, 500),
    };
  }

  const values = await container.systemConfigDao.getValues([
    "refund_name",
    "refund_phone",
    "refund_address",
  ]);
  return {
    source: "platform",
    name: bounded(normalizeConfigScalar(values.refund_name), 100),
    phone: bounded(normalizeConfigScalar(values.refund_phone), 32),
    address: bounded(normalizeConfigScalar(values.refund_address), 500),
  };
}
