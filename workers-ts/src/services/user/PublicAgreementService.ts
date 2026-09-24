import { desc, eq } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { agreement } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

/** The legacy agreement table has two public document types: member and agent. */
export type PublicAgreementType = 1 | 2;

export interface PublicAgreementRecord {
  id: number;
  type: PublicAgreementType;
  title: string;
  content: string | null;
  sort: number;
  status: number;
  add_time: number;
}

export function publicAgreementType(value: unknown): PublicAgreementType {
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  throw new ValidateException("协议类型不支持");
}

/** Legacy public endpoint returns the record for its type even when disabled. */
export async function readAgreementByType(
  container: Container,
  value: unknown,
): Promise<PublicAgreementRecord | []> {
  const type = publicAgreementType(value);
  const rows = await container.db
    .select({
      id: agreement.id,
      type: agreement.type,
      title: agreement.title,
      content: agreement.content,
      sort: agreement.sort,
      status: agreement.status,
      add_time: agreement.addTime,
    })
    .from(agreement)
    .where(eq(agreement.type, type))
    .orderBy(desc(agreement.sort), desc(agreement.id))
    .limit(1);
  const row = rows[0];
  if (!row || row.type !== type) return [];
  return { ...row, type };
}

/** The paid membership home hides disabled agreements after reading by type. */
export async function readVisibleAgreement(
  container: Container,
  value: unknown,
): Promise<PublicAgreementRecord | []> {
  const row = await readAgreementByType(container, value);
  return Array.isArray(row) || row.status !== 1 ? [] : row;
}
