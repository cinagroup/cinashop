import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import { withTx } from '@/lib/di';
import { user } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

const INDEX_NAME = 'user_bar_code_uq';
const MAX_CANDIDATES = 8;

function randomMemberBarcode(): string {
  // Sixteen digits keep this distinct from the twelve-digit order writeoff code.
  // Rejection sampling avoids modulo bias; the first digit is never zero.
  const digits: number[] = [];
  while (digits.length < 16) {
    const values = crypto.getRandomValues(new Uint8Array(24));
    for (const value of values) {
      if (value >= 250) continue;
      const digit = value % 10;
      if (digits.length === 0 && digit === 0) continue;
      digits.push(digit);
      if (digits.length === 16) break;
    }
  }
  return digits.join('');
}

function validExistingCode(code: string): boolean {
  // The legacy lookup accepts up to 32 characters, but interprets precisely
  // twelve digits as an order code before attempting a user-code lookup.
  return code.length > 0 && code.length <= 32 && code === code.trim()
    && code !== 'undefined' && !/[\u0000-\u001f\u007f]/u.test(code)
    && !/^\d{12}$/u.test(code);
}

function isIndexConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (record.code === '23505' && (record.constraint === INDEX_NAME || record.constraint_name === INDEX_NAME)) return true;
    current = record.cause;
  }
  return false;
}

async function requireInstalledIndex(tx: DbClient): Promise<void> {
  const [row] = await tx.select({ ready: sql<boolean>`EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
    JOIN pg_am am ON am.oid=c.relam
    WHERE c.oid=to_regclass(format('%I.%I', current_schema(), 'user_bar_code_uq'))
      AND i.indrelid=to_regclass(format('%I.%I', current_schema(), 'user'))
      AND c.relkind='i' AND am.amname='btree'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL AND i.indpred IS NOT NULL
      AND i.indkey[0]=(SELECT attnum FROM pg_attribute
        WHERE attrelid=i.indrelid AND attname='bar_code' AND NOT attisdropped)
      AND lower(replace(regexp_replace(pg_get_expr(i.indpred,i.indrelid,true),'[()[:space:]]','','g'),'"',''))
        = 'bar_code::text<>''''::text'
  )` }).from(sql`(VALUES (1)) AS index_probe(n)`);
  if (!row?.ready) throw new ValidateException('会员码唯一索引未就绪');
}

/** Assigns a stable user barcode only on an authenticated POST. GET userinfo stays read-only. */
export class MemberBarcodeService {
  constructor(private readonly container: Container, private readonly generate: () => string = randomMemberBarcode) {}

  async allocateOrRead(uid: number): Promise<string> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException('用户ID错误');
    for (let attempt = 0; attempt < MAX_CANDIDATES; attempt += 1) {
      try {
        const code = await withTx(this.container, async tx => {
          const [account] = await tx.select({ uid: user.uid, status: user.status,
            isDel: user.isDel, deleteTime: user.deleteTime, barCode: user.barCode })
            .from(user).where(eq(user.uid, uid)).limit(1).for('update');
          if (!account) throw new NotFoundException('用户不存在');
          if (account.status !== 1 || account.isDel !== 0 || account.deleteTime !== null) {
            throw new ValidateException('当前账号不可使用会员码');
          }
          await requireInstalledIndex(tx);
          if (account.barCode) {
            if (!validExistingCode(account.barCode)) throw new ValidateException('历史会员码无效，请联系管理员');
            const matches = await tx.select({ uid: user.uid }).from(user)
              .where(eq(user.barCode, account.barCode)).limit(2);
            if (matches.length !== 1 || matches[0]?.uid !== uid) {
              throw new ValidateException('历史会员码重复，请联系管理员');
            }
            return account.barCode;
          }
          const candidate = this.generate();
          if (!/^\d{16}$/u.test(candidate) || candidate[0] === '0') {
            throw new Error('Invalid member barcode generator output');
          }
          // Avoid a known collision without writing. The unique index closes
          // the race against another backend or the still-running PHP writer.
          const occupied = await tx.select({ uid: user.uid }).from(user)
            .where(eq(user.barCode, candidate)).limit(1);
          if (occupied.length) return null;
          const changed = await tx.update(user).set({ barCode: candidate }).where(and(
            eq(user.uid, uid), eq(user.barCode, ''), eq(user.status, 1),
            eq(user.isDel, 0), isNull(user.deleteTime),
          )).returning({ barCode: user.barCode });
          if (changed.length !== 1) throw new ValidateException('会员码分配时账号状态已变化');
          return changed[0]!.barCode;
        });
        if (code !== null) return code;
      } catch (error) {
        if (isIndexConflict(error)) continue;
        throw error;
      }
    }
    throw new ValidateException('会员码暂时不可用，请稍后重试');
  }
}
