import { and, desc, eq } from "drizzle-orm";
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
  status: 1;
  add_time: number;
}

export function publicAgreementType(value: unknown): PublicAgreementType {
  if (value === 1 || value === "1") return 1;
  if (value === 2 || value === "2") return 2;
  throw new ValidateException("协议类型不支持");
}

/** Public read of the same visible agreement used by the paid membership home. */
export async function readVisibleAgreement(
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
    .where(and(eq(agreement.type, type), eq(agreement.status, 1)))
    .orderBy(desc(agreement.sort), desc(agreement.id))
    .limit(1);
  const row = rows[0];
  // A missing or disabled document is PHP's empty-array member_explain value.
  if (!row || row.type !== type || row.status !== 1) return [];
  return { ...row, type, status: 1 };
}
