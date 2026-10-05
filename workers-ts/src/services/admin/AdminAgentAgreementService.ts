import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { agreement, systemLog } from '@/models/schema';
import { sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { HttpApiException, ValidateException } from '@/utils/errors';

const AGREEMENT_TYPE = 2;
const MAX_CONTENT_LENGTH = 200_000;
const CONFLICT_MESSAGE = '分销说明已变更，请重新读取后再保存';

export interface AgentAgreementActor { id: number; name: string; ip: string }

interface AgreementRow {
  id: number;
  type: number;
  title: string;
  content: string | null;
  sort: number;
  status: number;
  add_time: number;
  revision: string;
}

function conflict(): never { throw new HttpApiException(CONFLICT_MESSAGE, 409, 409); }

function selectAgreement(db: DbClient) {
  return db.select({
    id: agreement.id, type: agreement.type, title: agreement.title,
    content: agreement.content, sort: agreement.sort, status: agreement.status,
    add_time: agreement.addTime, revision: sql<string>`xmin::text`,
  }).from(agreement).where(eq(agreement.type, AGREEMENT_TYPE)).limit(1);
}

function present(row: AgreementRow): AgreementRow {
  return {
    ...row,
    title: row.title || '分销说明',
    // Imported WangEditor HTML is untrusted. Keep the database record and CAS
    // revision intact, but never hydrate raw markup into the Admin editor.
    content: sanitizePublishedArticleHtml(row.content ?? ''),
  };
}

function normalizeInput(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !['content', 'status', 'revision'].includes(key))) {
    throw new ValidateException('分销说明请求字段无效');
  }
  if (typeof body.content !== 'string' || body.content.length > MAX_CONTENT_LENGTH) {
    throw new ValidateException('分销说明内容格式或长度错误');
  }
  const content = sanitizePublishedArticleHtml(body.content);
  if (!content.trim() || content.length > MAX_CONTENT_LENGTH) {
    throw new ValidateException('请填写有效的分销说明内容');
  }
  const status = body.status === 0 || body.status === '0' ? 0
    : body.status === 1 || body.status === '1' ? 1 : null;
  if (status === null) throw new ValidateException('分销说明状态错误');
  if (typeof body.revision !== 'string' || !/^(?:absent|[0-9]{1,20})$/.test(body.revision)) {
    throw new ValidateException('分销说明版本错误，请重新读取');
  }
  return { content, status, revision: body.revision };
}

/** Isolated Admin editor for agreement.type=2; member agreement remains type=1. */
export class AdminAgentAgreementService {
  constructor(private readonly container: Container) {}

  async read(): Promise<AgreementRow | []> {
    const [row] = await selectAgreement(this.container.db);
    return row ? present(row) : [];
  }

  async save(id: number, body: Record<string, unknown>, actor: AgentAgreementActor): Promise<AgreementRow> {
    if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) {
      throw new ValidateException('分销说明 ID 错误');
    }
    if (!Number.isSafeInteger(actor.id) || actor.id <= 0) {
      throw new ValidateException('管理员身份缺失');
    }
    const input = normalizeInput(body);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SELECT set_config('lock_timeout','2000ms',true),
        set_config('statement_timeout','5000ms',true),
        set_config('idle_in_transaction_session_timeout','5000ms',true)`);
      const [current] = await selectAgreement(tx).for('update');
      let savedId: number;
      if (current) {
        if (id !== current.id || input.revision !== current.revision) conflict();
        const [updated] = await tx.update(agreement)
          .set({ content: input.content, status: input.status, addTime: now })
          .where(and(eq(agreement.id, id), eq(agreement.type, AGREEMENT_TYPE),
            sql`xmin::text = ${input.revision}`))
          .returning({ id: agreement.id });
        if (!updated) conflict();
        savedId = updated.id;
      } else {
        if (id !== 0 || input.revision !== 'absent') conflict();
        const [inserted] = await tx.insert(agreement)
          .values({ type: AGREEMENT_TYPE, title: '分销说明', content: input.content,
            status: input.status, addTime: now })
          .onConflictDoNothing({ target: agreement.type })
          .returning({ id: agreement.id });
        if (!inserted) conflict();
        savedId = inserted.id;
      }
      await tx.insert(systemLog).values({ adminId: actor.id, adminName: actor.name.slice(0, 64),
        path: '/adminapi/agent/set_agent_agreement/:id', page: '/agent/agreement', method: 'POST',
        action: `agent_agreement.save;id=${savedId};status=${input.status};length=${input.content.length}`,
        ip: actor.ip.slice(0, 45), type: 'agent_agreement', addTime: now });
      const [saved] = await selectAgreement(tx);
      if (!saved || saved.id !== savedId) conflict();
      return present(saved);
    });
  }
}
