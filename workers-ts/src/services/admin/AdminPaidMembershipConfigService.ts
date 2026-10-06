import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig, systemLog } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';
import { PAID_MEMBERSHIP_CONFIG_KEYS, paidMembershipConfigHash, parseAdminPaidMembershipConfigInput,
  type PaidMembershipConfigDto, type PaidMembershipConfigResult } from './AdminPaidMembershipConfigInput';

type Winner = { menuName: string; id: number; sort: number; value: string };
type JournalToken = { actor: number; path: string; payload: string } | null;
const LOG_TYPE = 'paid_membership_config';
const JOURNAL = /^v1;p=([a-f0-9]{64});b=([a-f0-9]{64});a=([a-f0-9]{64})$/;

async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}

/** Only the two switches from the legacy paid-membership settings tab. Plans,
 * rights, account eligibility, expiry dates and payment snapshots are separate. */
export class AdminPaidMembershipConfigService {
  constructor(private readonly container: Container, private readonly env: Pick<SystemConfigEnv, 'CONFIG_KV'>) {}

  private async winners(tx: DbClient): Promise<Map<string, Winner>> {
    const rows = await tx.selectDistinctOn([systemConfig.menuName], { menuName: systemConfig.menuName,
      id: systemConfig.id, sort: systemConfig.sort, value: systemConfig.value }).from(systemConfig)
      .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...PAID_MEMBERSHIP_CONFIG_KEYS])))
      .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id));
    return new Map(rows.map(row => [row.menuName, row]));
  }
  private async journal(tx: DbClient): Promise<JournalToken> {
    const [last] = await tx.select({ actor: systemLog.adminId, path: systemLog.path, action: systemLog.action })
      .from(systemLog).where(eq(systemLog.type, LOG_TYPE)).orderBy(desc(systemLog.id)).limit(1);
    if (!last) return null;
    const match = JOURNAL.exec(last.action);
    if (!match) throw new ValidateException('付费会员配置审计摘要无效，无法确认版本');
    return { actor: last.actor, path: last.path, payload: match[1] };
  }
  private async revision(tx: DbClient, rows: Map<string, Winner>, token?: JournalToken) {
    return paidMembershipConfigHash({ domain: 'paid-membership-config-v1', journal: token === undefined ? await this.journal(tx) : token,
      values: PAID_MEMBERSHIP_CONFIG_KEYS.map(key => {
        const row = rows.get(key);
        return { key, exists: Boolean(row), id: row?.id ?? null, sort: row?.sort ?? null, rawValue: row?.value ?? null };
      }) });
  }

  async get(): Promise<PaidMembershipConfigDto> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const rows = await this.winners(tx);
      const settings: PaidMembershipConfigDto['settings'] = { member_card_status: null, svip_price_status: null };
      const raw_values: PaidMembershipConfigDto['raw_values'] = { member_card_status: null, svip_price_status: null };
      const issues: PaidMembershipConfigDto['issues'] = [];
      for (const key of PAID_MEMBERSHIP_CONFIG_KEYS) {
        const raw = rows.get(key)?.value;
        raw_values[key] = raw ?? null;
        if (raw === '0' || raw === '1') settings[key] = raw === '1' ? 1 : 0;
        else {
          const state = raw === undefined ? '配置缺失' : raw.trim() === '' ? '已存配置为空' : '历史值不是规范整数0或1';
          const detail = key === 'member_card_status'
            ? '现有开通、计价和个人中心对缺失或异常值的解释并不统一'
            : '该开关参与实际付费会员计价；计价入口对缺失或空值与异常值的处理不同';
          issues.push({ key, message: `${state}；${detail}，请核对原值并明确选择后保存` });
        }
      }
      return { settings, raw_values, missing_keys: PAID_MEMBERSHIP_CONFIG_KEYS.filter(key => !rows.has(key)),
        issues, revision: await this.revision(tx, rows) };
    });
  }

  async save(value: unknown, actor: { id: number }): Promise<PaidMembershipConfigResult> {
    const input = parseAdminPaidMembershipConfigInput(value), actorId = actor?.id;
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || actorId > 2147483647) throw new ValidateException('管理员身份无效');
    const payload = await paidMembershipConfigHash({ domain: 'paid-membership-config-save-v1', input });
    const path = `/config/paid-membership/request/${input.request_id}`;
    const revision = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await deadlines(tx);
      // First business lock, shared with ordinary-level and legacy batch writers.
      // It guards missing rows and priority changes as well as UUID serialization.
      await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE ROW EXCLUSIVE MODE`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.adminId, actorId), eq(systemLog.type, LOG_TYPE), eq(systemLog.path, path)))
        .orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const match = JOURNAL.exec(logs[0].action);
        if (logs.length !== 1 || !match || match[1] !== payload || match[2] !== input.revision) throw new ValidateException('请求标识已用于不同的付费会员配置');
        return match[3];
      }
      const beforeRows = await this.winners(tx), before = await this.revision(tx, beforeRows);
      if (before !== input.revision) throw new ValidateException('付费会员配置已变化，请重新读取并确认');
      for (const key of PAID_MEMBERSHIP_CONFIG_KEYS) {
        const raw = String(input[key]), winner = beforeRows.get(key);
        if (winner) await tx.update(systemConfig).set({ value: raw }).where(eq(systemConfig.id, winner.id));
        else await tx.insert(systemConfig).values({ menuName: key, value: raw, info: key, isStore: 0, type: 'text', inputType: 'input' });
      }
      const afterRows = await this.winners(tx);
      if (PAID_MEMBERSHIP_CONFIG_KEYS.some(key => afterRows.get(key)?.value !== String(input[key]))) throw new Error('付费会员配置回读不一致');
      const after = await this.revision(tx, afterRows, { actor: actorId, path, payload });
      const [clock] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
      if (typeof clock?.now !== 'number' || !Number.isSafeInteger(clock.now) || clock.now <= 0) throw new Error('数据库时间无效');
      // 203 ASCII characters, no raw configuration or customer/payment data.
      await tx.insert(systemLog).values({ adminId: actorId, type: LOG_TYPE, path, method: 'POST',
        action: `v1;p=${payload};b=${before};a=${after}`, addTime: clock.now });
      return after;
    });
    // This reports completion of these deletions, not instantaneous global KV
    // coherence: an older cache-miss reader may still finish its own cache fill.
    const results = await Promise.allSettled(PAID_MEMBERSHIP_CONFIG_KEYS.map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete(`cfg_${key}`))));
    return { committed: true, revision, request_id: input.request_id,
      cache_status: results.every(result => result.status === 'fulfilled') ? 'cleared' : 'pending' };
  }
}
