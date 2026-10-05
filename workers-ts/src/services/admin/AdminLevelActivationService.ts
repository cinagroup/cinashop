import { and, asc, desc, eq, getTableColumns, ilike, inArray, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeCouponIssue, systemConfig, systemLog } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';
import { configFlag, parseConfigIds, parseLegacyWholeMoney } from '@/services/activity/StoreNewcomerService';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';
import { LEVEL_ACTIVATION_KEYS, levelActivationHash, levelActivationInteger, levelActivationObject,
  levelActivationText, levelActivationWhitelist, parseAdminLevelActivationCouponQuery, parseAdminLevelActivationInput, parseLevelActivationJson,
  type LevelActivationConfigDto, type LevelActivationCouponDto, type LevelActivationKey, type LevelActivationSaveResult,
  type LevelActivationSettings, type LevelFieldReference, type LevelProfileDefinition, type LevelProfileOption } from './AdminLevelActivationInput';

type Winner = { menuName: string; id: number; sort: number; value: string };
type Issue = typeof storeCouponIssue.$inferSelect & { rowVersion: string };
type Diagnostic = { key: string; message: string };
type JournalToken = { actor: number; path: string; payload: string } | null;
const DEPENDENCY = 'user_extend_info';
const KEYS = [...LEVEL_ACTIVATION_KEYS, DEPENDENCY];
const LOG_TYPE = 'level_activation_config';
const formats: Record<string, string> = { text: '文本', num: '数字', date: '日期', radio: '单选项', id: '身份证', mail: '邮箱', phone: '手机号', address: '地址' };
const standard: Record<string, string> = { real_name: 'text', sex: 'radio', birthday: 'date', card_id: 'id', address: 'address', mark: 'text' };
const defaults = [
  ['姓名', '请填写真实姓名', 'text', 'real_name'], ['性别', '请选择性别', 'radio', 'sex'],
  ['生日', '请选择出生日期', 'date', 'birthday'], ['身份证', '请填写身份证', 'id', 'card_id'],
  ['地址', '请填写地址', 'address', 'address'], ['备注', '请填写补充备注内容', 'text', 'mark'],
].map(([info, tip, format, param], index) => ({ info, tip, format, label: formats[format], param, single: '',
  singlearr: param === 'sex' ? ['男', '女', '保密'] : [], required: 0, use: 0, user_show: 0, sort: index + 1 }));
const message = (error: unknown) => error instanceof Error ? error.message : '配置定义无效';
const canonicalInteger = (raw: string | undefined) => raw !== undefined && /^(0|[1-9]\d*)$/.test(raw)
  && Number.isSafeInteger(Number(raw)) && Number(raw) <= 2147483647 ? Number(raw) : null;
const flag = (raw: string | undefined): 0 | 1 => configFlag(raw) ? 1 : 0;
const legacyBit = (value: unknown, fallback = 0): 0 | 1 => {
  if (value === undefined) return fallback as 0 | 1;
  if (value === 0 || value === '0' || value === false) return 0;
  if (value === 1 || value === '1' || value === true) return 1;
  throw new ValidateException('资料模板开关无效');
};
function profileDefinition(value: unknown): LevelProfileDefinition {
  const body = levelActivationObject(value);
  levelActivationWhitelist(body, ['info', 'tip', 'format', 'label', 'param', 'single', 'singlearr', 'required', 'use', 'user_show', 'sort']);
  const info = levelActivationText(body.info, '资料名称'), tip = levelActivationText(body.tip, '资料提示');
  const format = levelActivationText(body.format, '资料格式');
  if (!Object.hasOwn(formats, format)) throw new ValidateException('资料格式不受支持');
  const param = body.param === undefined ? '' : levelActivationText(body.param, '资料映射', 32, true);
  if (param && (!Object.hasOwn(standard, param) || standard[param] !== format)) throw new ValidateException('资料映射不受支持');
  if (body.single !== undefined && body.single !== '') throw new ValidateException('资料模板不能预填选项');
  const options = body.singlearr ?? [];
  if (!Array.isArray(options) || options.length > 32) throw new ValidateException('单选项须为至多32项数组');
  const singlearr = options.map(value => levelActivationText(value, '单选项'));
  if (new Set(singlearr).size !== singlearr.length || (format === 'radio' ? singlearr.length < 2 : singlearr.length !== 0)) throw new ValidateException('单选项数量或唯一性无效');
  if (param === 'sex' && JSON.stringify(singlearr) !== JSON.stringify(['男', '女', '保密'])) throw new ValidateException('性别选项须按男、女、保密排列');
  legacyBit(body.required);
  return { info, tip, format, label: body.label === undefined ? formats[format] : levelActivationText(body.label, '资料标签'),
    param, single: '', singlearr, use: legacyBit(body.use), user_show: legacyBit(body.user_show),
    sort: body.sort === undefined ? 0 : levelActivationInteger(body.sort, '资料排序') };
}
function configArray(raw: string | undefined, key: string, issues: Diagnostic[]): unknown[] | null {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '""') return [];
  try {
    const value = parseLevelActivationJson(raw);
    if (!Array.isArray(value)) throw new Error('须为数组');
    if (value.length > 64) throw new Error('超过64项，须明确修复');
    return value;
  } catch { issues.push({ key, message: '资料配置不是至多64项的有效数组，请明确修复' }); return null; }
}
async function profiles(values: Map<string, Winner>, issues: Diagnostic[]) {
  const baseRaw = values.get(DEPENDENCY)?.value;
  const baseArray = ['0', 'false', 'null'].includes(baseRaw?.trim() ?? '') ? [] : configArray(baseRaw, DEPENDENCY, issues);
  // PHP's falsey/empty basic template falls back to these six fixed definitions.
  const useDefault = baseArray !== null && baseArray.length === 0;
  const base = useDefault ? defaults : baseArray ?? [];
  const selected = configArray(values.get('level_extend_info')?.value, 'level_extend_info', issues);
  const options: LevelProfileOption[] = [], refs: LevelFieldReference[] = [];
  const make = async (raw: unknown, source: LevelProfileOption['source'], index: number) => {
    let definition: LevelProfileDefinition | null = null; const problems: string[] = [];
    try { definition = profileDefinition(raw); } catch (error) { problems.push(message(error)); }
    const field_key = await levelActivationHash(definition ? { domain: 'level-profile-v1', definition }
      : { domain: 'invalid-level-profile-v1', source, index, raw });
    return { field_key, source, definition, selectable: problems.length === 0, issues: problems, raw };
  };
  for (const [index, raw] of base.entries()) options.push(await make(raw, useDefault ? 'default' : 'base', index));
  // Duplicated names or mapped columns within the source have no unambiguous
  // identity. Both choices stay visible, but neither is eligible for a save.
  for (const option of options) if (option.definition && options.some(other => other !== option && other.definition
    && (other.definition.info === option.definition!.info || (option.definition!.param && other.definition.param === option.definition!.param)))) {
    option.selectable = false; option.issues.push('基础资料名称或映射重复');
  }
  // Exact duplicate source definitions have the same identity. Preserve their
  // ambiguity diagnostic, but expose each field_key only once to the client.
  const uniqueOptions = options.filter((option, index) => options.findIndex(other => other.field_key === option.field_key) === index);
  options.splice(0, options.length, ...uniqueOptions);
  for (const [index, raw] of (selected ?? []).entries()) {
    const candidate = await make(raw, 'selected_legacy', index);
    const existing = options.find(option => option.field_key === candidate.field_key);
    if (!existing) options.push(candidate);
    else if (candidate.selectable && candidate.definition && !existing.selectable) {
      // A later ambiguity in the basic library must not invalidate a safe,
      // already-selected definition. Other ambiguous source identities remain
      // unavailable; final template validation still forbids duplicate names
      // and nonempty params in the actual submitted selection.
      existing.source = 'selected_legacy'; existing.selectable = true;
      existing.issues.push('已选安全定义可保留；基础资料来源仍有歧义');
    }
    let required: 0 | 1 = 0;
    try { required = legacyBit(levelActivationObject(raw).required); } catch { /* invalid option already has a diagnostic */ }
    refs.push({ field_key: candidate.field_key, required });
  }
  for (const option of options) for (const problem of option.issues) issues.push({ key: option.source === 'selected_legacy' ? 'level_extend_info' : DEPENDENCY, message: problem });
  const repeatedSelection = new Set(refs.map(reference => reference.field_key)).size !== refs.length;
  if (repeatedSelection) issues.push({ key: 'level_extend_info', message: '历史激活资料包含重复定义，不能静默去重，请明确清空后重新选择' });
  return { options, refs: selected === null || repeatedSelection ? null : refs };
}
function storedCouponIds(raw: string | undefined, issues: Diagnostic[]): number[] | null {
  if (raw === undefined || normalizeConfigScalar(raw) === '' || normalizeConfigScalar(raw) === '0') return [];
  const normalized = normalizeConfigScalar(raw);
  let value: unknown;
  try { value = JSON.parse(normalized); } catch { value = normalized.split(','); }
  const list = Array.isArray(value) ? value : [value];
  const ids = list.map(value => (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) ? Number(value) : value);
  if (ids.length > 100 || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > 2147483647)
    || new Set(ids).size !== ids.length) {
    issues.push({ key: 'level_give_coupon', message: '历史赠券集合不能无损转为至多100个唯一发行ID，请明确修复' }); return null;
  }
  return (ids as number[]).sort((a, b) => a - b);
}
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function clock(tx: DbClient) {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  return levelActivationInteger(row?.now, '数据库时间', 1);
}
function couponProblems(row: Issue, now: number): string[] {
  const issues: string[] = [], at = now * 1000;
  if (row.isDel !== 0) issues.push('发行已删除');
  if (row.status !== 1) issues.push('发行未启用');
  if (row.receiveType !== 3) issues.push('不是赠送发行');
  if (row.isPermanent !== 1 && row.remainCount <= 0) issues.push('库存已用尽');
  if (!((!row.startTime && !row.endTime) || (row.startTime && row.endTime && row.startTime.getTime() <= at && row.endTime.getTime() >= at))) issues.push('不在完整领取窗口');
  if (!(row.day > 0 || (row.day === 0 && row.useEndTime && row.useEndTime.getTime() >= at))) issues.push('使用期限无效或已经结束');
  return issues;
}
const couponRevision = (row: Issue) => levelActivationHash({ domain: 'level-activation-coupon-v1', row });
async function couponDto(id: number, row: Issue | undefined, now: number): Promise<LevelActivationCouponDto> {
  if (!row) return { id, title: '', discount_type: 0, coupon_price: '', use_min_price: '', effective_pay_percent: null,
    scope_type: 0, category: 0, app_type: 0, status: 0, deleted: true, is_permanent: 0, remain_count: 0, receive_type: 0,
    start_time: null, end_time: null, use_start_time: null, use_end_time: null, valid_days: 0, revision: null, selectable: false, issues: ['发行不存在'] };
  const issues = couponProblems(row, now), date = (value: Date | null) => value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return { id, title: row.title || row.couponTitle, discount_type: row.type, coupon_price: row.couponPrice, use_min_price: row.useMinPrice,
    effective_pay_percent: row.type === 2 && Number.isFinite(Number(row.couponPrice)) ? Math.trunc(Number(row.couponPrice)) : null,
    scope_type: row.couponType, category: row.category, app_type: row.appType, status: row.status, deleted: row.isDel !== 0,
    is_permanent: row.isPermanent, remain_count: row.remainCount, receive_type: row.receiveType,
    start_time: date(row.startTime), end_time: date(row.endTime), use_start_time: date(row.useStartTime), use_end_time: date(row.useEndTime),
    valid_days: row.day, revision: await couponRevision(row), selectable: issues.length === 0, issues };
}

/** Nine-key administrative boundary. No balances, user activation flags, issued
 * ownership, ordinary level definitions or paid membership settings are written. */
export class AdminLevelActivationService {
  constructor(private readonly container: Container, private readonly env: Pick<SystemConfigEnv, 'CONFIG_KV'>) {}
  private async winners(tx: DbClient) {
    const rows = await tx.selectDistinctOn([systemConfig.menuName], { menuName: systemConfig.menuName, id: systemConfig.id,
      sort: systemConfig.sort, value: systemConfig.value }).from(systemConfig)
      .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, KEYS)))
      .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id));
    return new Map(rows.map(row => [row.menuName, row]));
  }
  private async journalToken(tx: DbClient): Promise<JournalToken> {
    const [last] = await tx.select({ actor: systemLog.adminId, path: systemLog.path, action: systemLog.action }).from(systemLog)
      .where(eq(systemLog.type, LOG_TYPE)).orderBy(desc(systemLog.id)).limit(1);
    if (!last) return null;
    const match = /^v1;p=([a-f0-9]{64});b=([a-f0-9]{64});a=([a-f0-9]{64})$/.exec(last.action);
    if (!match) throw new ValidateException('会员激活配置审计摘要无效，无法确认版本');
    return { actor: last.actor, path: last.path, payload: match[1] };
  }
  private async revision(tx: DbClient, values: Map<string, Winner>, token?: JournalToken) {
    return levelActivationHash({ domain: 'level-activation-config-v1', journal: token === undefined ? await this.journalToken(tx) : token, values: KEYS.map(key => {
      const row = values.get(key); return { key, exists: Boolean(row), id: row?.id ?? null, sort: row?.sort ?? null, rawValue: row?.value ?? null };
    }) });
  }
  private read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx); return run(tx);
    });
  }
  private async config(values: Map<string, Winner>) {
    const raw = (key: string) => values.get(key)?.value;
    const issues: Diagnostic[] = [];
    const profile = await profiles(values, issues);
    const integralRaw = raw('level_give_integral'), moneyRaw = raw('level_give_money');
    const integral = integralRaw === undefined || integralRaw === '' ? 0 : canonicalInteger(integralRaw);
    const money = moneyRaw === undefined || moneyRaw === '' ? '0' : /^(0|[1-9]\d{0,9})$/.test(moneyRaw) ? moneyRaw : null;
    if (integral === null) issues.push({ key: 'level_give_integral', message: '历史积分须明确规范为整数；实际消费直接parseInt原值' });
    if (money === null) issues.push({ key: 'level_give_money', message: '历史余额须明确规范为整元；实际消费先解码后截去小数' });
    const settings: LevelActivationSettings = {
      member_func_status: flag(raw('member_func_status')), level_activate_status: flag(raw('level_activate_status')),
      level_extend_info: profile.refs, level_integral_status: flag(raw('level_integral_status')), level_give_integral: integral,
      level_money_status: flag(raw('level_money_status')), level_give_money: money,
      level_coupon_status: flag(raw('level_coupon_status')), level_give_coupon: storedCouponIds(raw('level_give_coupon'), issues),
    };
    for (const key of ['member_func_status', 'level_activate_status', 'level_integral_status', 'level_money_status', 'level_coupon_status']) {
      if (raw(key) !== undefined && !['0', '1'].includes(raw(key)!)) issues.push({ key, message: '历史开关按当前消费解释显示，保存后规范为0或1' });
    }
    const interpretedIntegral = settings.level_integral_status ? Math.max(0, Number.parseInt(integralRaw || '0', 10) || 0) : 0;
    if (!Number.isFinite(interpretedIntegral)) issues.push({ key: 'level_give_integral', message: '历史积分消费解释超出有限数值范围，激活奖励无法提交' });
    const effective = { member_enabled: Boolean(settings.member_func_status), activation_required: Boolean(settings.level_activate_status),
      integral_enabled: Boolean(settings.level_integral_status), integral: Number.isFinite(interpretedIntegral) ? interpretedIntegral : null,
      money_enabled: Boolean(settings.level_money_status), money_units: String(settings.level_money_status ? parseLegacyWholeMoney(moneyRaw) : 0),
      coupon_enabled: Boolean(settings.level_coupon_status), coupon_ids: settings.level_coupon_status ? parseConfigIds(raw('level_give_coupon')) : [],
      gift_active: Boolean(settings.member_func_status && settings.level_activate_status && settings.level_coupon_status) };
    return { settings, effective, profile, issues };
  }
  async get(): Promise<LevelActivationConfigDto> {
    return this.read(async tx => {
      const values = await this.winners(tx), current = await this.config(values), now = await clock(tx);
      // Raw configuration is bounded by varchar(5000). Even malformed histories
      // are shown explicitly; selected identities never depend on the option page.
      const ids = current.settings.level_give_coupon ?? parseConfigIds(values.get('level_give_coupon')?.value).filter(id => id <= 2147483647).slice(0, 100);
      const rows = ids.length ? await tx.select({ ...getTableColumns(storeCouponIssue), rowVersion: sql<string>`xmin::text` })
        .from(storeCouponIssue).where(inArray(storeCouponIssue.id, ids)).orderBy(asc(storeCouponIssue.id)) : [];
      const byId = new Map(rows.map(row => [row.id, row]));
      return { settings: current.settings, effective: current.effective, revision: await this.revision(tx, values),
        missing_keys: LEVEL_ACTIVATION_KEYS.filter(key => !values.has(key)),
        raw_values: Object.fromEntries(LEVEL_ACTIVATION_KEYS.map(key => [key, values.get(key)?.value ?? null])) as Record<LevelActivationKey, string | null>,
        issues: current.issues, profile_options: current.profile.options,
        selected_coupons: await Promise.all(ids.map(id => couponDto(id, byId.get(id), now))),
        limits: { fields: 64, coupons: 100, config_value_characters: 5000,
          template_characters: values.has('level_extend_info') ? [...values.get('level_extend_info')!.value].length : 0,
          integral_max: 2147483647, money_max: '9999999999' } };
    });
  }
  async coupons(parameters: URLSearchParams): Promise<{ list: LevelActivationCouponDto[]; count: number; page: number; limit: number }> {
    const query = parseAdminLevelActivationCouponQuery(parameters);
    return this.read(async tx => {
      const now = await clock(tx), timestamp = new Date(now * 1000).toISOString();
      const keyword = `%${query.keyword.replace(/[\\%_]/gu, '\\$&')}%`;
      const id = /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? Number(query.keyword) : undefined;
      const predicate = and(eq(storeCouponIssue.status, 1), eq(storeCouponIssue.isDel, 0), eq(storeCouponIssue.receiveType, 3),
        sql`(${storeCouponIssue.isPermanent}=1 OR ${storeCouponIssue.remainCount}>0)`,
        sql`((${storeCouponIssue.startTime} IS NULL AND ${storeCouponIssue.endTime} IS NULL)
          OR (${storeCouponIssue.startTime}<=${timestamp} AND ${storeCouponIssue.endTime}>=${timestamp}))`,
        sql`(${storeCouponIssue.day}>0 OR (${storeCouponIssue.day}=0 AND ${storeCouponIssue.useEndTime}>=${timestamp}))`,
        query.keyword ? or(ilike(storeCouponIssue.title, keyword), ilike(storeCouponIssue.couponTitle, keyword), id ? eq(storeCouponIssue.id, id) : undefined) : undefined);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeCouponIssue).where(predicate);
      const rows = await tx.select({ ...getTableColumns(storeCouponIssue), rowVersion: sql<string>`xmin::text` }).from(storeCouponIssue)
        .where(predicate).orderBy(desc(storeCouponIssue.sort), desc(storeCouponIssue.id)).limit(query.limit).offset(query.offset);
      return { list: await Promise.all(rows.map(row => couponDto(row.id, row, now))), count: count.count, page: query.page, limit: query.limit };
    });
  }
  async save(value: unknown, actor: { id: number }): Promise<LevelActivationSaveResult> {
    const input = parseAdminLevelActivationInput(value), actorId = levelActivationInteger(actor?.id, '管理员ID', 1);
    const payload = await levelActivationHash({ domain: 'level-activation-save-v1', input });
    const path = `/config/level-activation/request/${input.request_id}`;
    const revision = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await deadlines(tx);
      // First business lock. This also serializes UUID lookup and missing-key
      // insertion with other Admin saves and the generic compatibility writer.
      await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE ROW EXCLUSIVE MODE`);
      const logs = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.adminId, actorId), eq(systemLog.type, LOG_TYPE), eq(systemLog.path, path))).orderBy(desc(systemLog.id)).limit(2);
      if (logs.length) {
        const match = /^v1;p=([a-f0-9]{64});b=([a-f0-9]{64});a=([a-f0-9]{64})$/.exec(logs[0].action);
        if (logs.length !== 1 || !match || match[1] !== payload || match[2] !== input.revision) throw new ValidateException('请求标识已用于不同的会员激活配置');
        return match[3];
      }
      const values = await this.winners(tx), before = await this.revision(tx, values);
      if (before !== input.revision) throw new ValidateException('会员激活配置或资料来源已变化，请重新读取并确认');
      const current = await this.config(values), selected = new Map(current.profile.options.map(option => [option.field_key, option]));
      const names = new Set<string>(), params = new Set<string>();
      const template = input.level_extend_info.map(reference => {
        const option = selected.get(reference.field_key);
        if (!option?.selectable || !option.definition) throw new ValidateException('所选资料定义无效或已变化，请明确移除或重新选择');
        const definition = option.definition;
        if (names.has(definition.info) || (definition.param && params.has(definition.param))) throw new ValidateException('激活资料名称或映射不能重复');
        names.add(definition.info); if (definition.param) params.add(definition.param);
        return { ...definition, required: reference.required };
      });
      const templateJson = JSON.stringify(template);
      if ([...templateJson].length > 5000) throw new ValidateException('激活资料完整JSON不能超过5000字符');
      const rows = input.level_give_coupon.length ? await tx.select({ ...getTableColumns(storeCouponIssue), rowVersion: sql<string>`xmin::text` })
        .from(storeCouponIssue).where(inArray(storeCouponIssue.id, input.level_give_coupon)).orderBy(asc(storeCouponIssue.id)).for('update') : [];
      const byId = new Map(rows.map(row => [row.id, row])), previousIds = current.settings.level_give_coupon ?? [];
      const effectiveChanged = Boolean(input.member_func_status && input.level_activate_status && input.level_coupon_status)
        && !current.effective.gift_active;
      const now = await clock(tx);
      for (const proof of input.coupon_revisions) {
        const row = byId.get(proof.id), actual = row ? await couponRevision(row) : null;
        if (actual !== proof.revision) throw new ValidateException(`发行${proof.id}已变化，请重新读取并确认`);
        if (!previousIds.includes(proof.id) || effectiveChanged) {
          if (!row || couponProblems(row, now).length) throw new ValidateException(`发行${proof.id}当前不能用于激活赠送`);
        }
      }
      const entries = LEVEL_ACTIVATION_KEYS.map(key => [key, key === 'level_extend_info' ? templateJson
        : key === 'level_give_money' ? input.level_give_money : JSON.stringify(input[key])] as const);
      for (const [key, raw] of entries) {
        const winner = values.get(key);
        if (winner) await tx.update(systemConfig).set({ value: raw }).where(eq(systemConfig.id, winner.id));
        else await tx.insert(systemConfig).values({ menuName: key, value: raw, info: key, isStore: 0, type: 'text', inputType: 'input' });
      }
      const afterValues = await this.winners(tx);
      if (entries.some(([key, raw]) => afterValues.get(key)?.value !== raw)) throw new Error('会员激活配置回读不一致');
      const after = await this.revision(tx, afterValues, { actor: actorId, path, payload });
      // 203 ASCII characters, below action varchar(255); no template, amount,
      // profile value or other customer data enters the administrative journal.
      await tx.insert(systemLog).values({ adminId: actorId, type: LOG_TYPE, path, method: 'POST',
        action: `v1;p=${payload};b=${before};a=${after}`, addTime: now });
      return after;
    });
    // SQL and audit have committed. Attempt every key even if a binding throws
    // synchronously; cache failure cannot be represented as a rolled-back save.
    const cleared = await Promise.allSettled(LEVEL_ACTIVATION_KEYS.map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete(`cfg_${key}`))));
    return { committed: true, revision, request_id: input.request_id,
      cache_status: cleared.every(result => result.status === 'fulfilled') ? 'cleared' : 'pending' };
  }
}
