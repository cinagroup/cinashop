import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { systemConfig, systemUserLevel, user, userLevel, userSign } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { configFlag } from '@/services/activity/StoreNewcomerService';
import { parseConfigInteger } from '@/utils/config';
import { ValidateException } from '@/utils/errors';

export interface UserLevelOverviewCard {
  id: number;
  name: string;
  grade: number;
  discount: string;
  exp_num: number;
  lack_exp_num: string;
  color: string;
  icon: string;
  image: string;
  is_forever: number;
}

export interface UserLevelOverview {
  actor_uid: number;
  enabled: boolean;
  /** Stored activation state; previewing a card never changes it. */
  level_active: boolean;
  preview_only: boolean;
  current_level_id: number;
  current_grade: number | null;
  exp: string;
  levels: UserLevelOverviewCard[];
  task: { sign_count: number; sign: string; order: string; invite: string; sign_enabled: boolean };
}

// Match the existing DIY catalogue's full capacity. Two independently bound
// slots per card remain within ProductAssetPolicy's 10000-reference capacity.
export const MAX_OVERVIEW_LEVELS = 1000;
const CONFIG_KEYS = ['member_func_status', 'sign_status', 'sign_in_switch',
  'sign_give_exp', 'order_give_exp', 'invite_user_exp'] as const;

function experience(value: string): bigint {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(value);
  if (!match) throw new ValidateException('会员经验值格式错误');
  const units = BigInt(match[2]!) * 100n + BigInt(match[3]!);
  return match[1] ? -units : units;
}

/** PHP more() JSON-decodes scalar configuration, uses '' for missing/null,
 * and the page displays a falsey task amount as0. Seed10/1/25 are not defaults. */
function taskAmount(raw: string | undefined): string {
  let value = raw ?? '';
  try {
    const decoded: unknown = JSON.parse(value);
    if (decoded === null || decoded === false) value = '';
    else if (typeof decoded === 'string' || typeof decoded === 'number') value = String(decoded);
    else throw new ValidateException('会员经验配置格式错误');
  } catch (error) {
    if (error instanceof ValidateException) throw error;
    // Unquoted legacy scalar text is also present in the current database.
  }
  value = value.trim();
  if (value.length > 64 || value !== '' && !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new ValidateException('会员经验配置格式错误');
  }
  return value;
}

/** Called inside UserLevelService's single repeatable-read/read-only snapshot.
 * Authority is persisted platform definitions and this account's actual grant;
 * neither a requested ID nor a copied media ticket grants another owner access. */
export async function readUserLevelOverview(container: Container, uid: number): Promise<UserLevelOverview> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new ValidateException('用户身份无效');
  const [account] = await container.db.select({ uid: user.uid, exp: user.exp, level: user.level, levelStatus: user.levelStatus })
    .from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
  if (!account) throw new ValidateException('请重新登录');
  const exp = account.exp, expCents = experience(exp);
  const rows = await container.db.select({ name: systemConfig.menuName, value: systemConfig.value }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...CONFIG_KEYS])))
    .orderBy(asc(systemConfig.sort), asc(systemConfig.id));
  const config: Record<string, string> = {};
  for (const row of rows) config[row.name] = row.value;
  const enabled = configFlag(config.member_func_status);
  const levelActive = account.levelStatus === 1;
  const signStatus = Object.hasOwn(config, 'sign_status') ? parseConfigInteger(config.sign_status, 0)
    : parseConfigInteger(config.sign_in_switch, 0);
  const result: UserLevelOverview = { actor_uid: uid, enabled, level_active: levelActive,
    preview_only: false, current_level_id: 0, current_grade: null, exp, levels: [],
    task: { sign_count: 0, sign: taskAmount(config.sign_give_exp), order: taskAmount(config.order_give_exp),
      invite: taskAmount(config.invite_user_exp), sign_enabled: enabled && signStatus !== 0 } };
  if (!enabled) return result;
  const definitions = await container.db.select().from(systemUserLevel)
    .where(and(eq(systemUserLevel.isShow, 1), eq(systemUserLevel.isDel, 0)))
    .orderBy(asc(systemUserLevel.grade), asc(systemUserLevel.id));
  if (definitions.length > MAX_OVERVIEW_LEVELS) throw new ValidateException('会员等级超过完整概览容量');
  const grants = account.level > 0 && levelActive ? await container.db.select({ id: userLevel.id }).from(userLevel)
    .where(and(eq(userLevel.uid, uid), eq(userLevel.levelId, account.level), eq(userLevel.status, 1), eq(userLevel.isDel, 0))).limit(1) : [];
  const current = grants.length ? definitions.find(row => row.id === account.level) : undefined;
  result.current_level_id = current?.id ?? 0;
  result.current_grade = current?.grade ?? null;
  result.preview_only = !current && definitions.length > 0;
  const displayGrade = current?.grade ?? definitions[0]?.grade;
  const [stats] = await container.db.select({ total: sql<number>`COUNT(*)::int` }).from(userSign).where(eq(userSign.uid, uid));
  result.task.sign_count = stats?.total ?? 0;
  // image/icon are exactly two slots per persisted visible definition. A
  // platform-only tuple deliberately cannot authorize supplier or user media.
  const references = await publicProductPictures(container.db, definitions.flatMap(row => [
    { image: row.icon, type: 0, relationId: 0 }, { image: row.image, type: 0, relationId: 0 },
  ]));
  result.levels = definitions.map((row, index) => {
    if (!/^-?\d+\.\d{2}$/.test(row.discount)) throw new ValidateException('会员折扣格式错误');
    const remaining = BigInt(row.expNum) * 100n - expCents;
    // PHP bcsub(...,scale0) truncates toward0, after its lower-grade/exp guards.
    const gap = (displayGrade !== undefined && row.grade < displayGrade || remaining <= 0n) ? 0n : remaining / 100n;
    return { id: row.id, name: row.name, grade: row.grade, discount: row.discount,
      exp_num: row.expNum, lack_exp_num: gap.toString(), color: row.color,
      icon: references[index * 2]!, image: references[index * 2 + 1]!, is_forever: row.isForever };
  });
  return result;
}

/** The transaction has ended before any short-lived signature is generated. */
export async function renderUserLevelOverview(appKey: string | undefined, overview: UserLevelOverview): Promise<UserLevelOverview> {
  const references = overview.levels.flatMap(row => [row.icon, row.image]);
  const images = await renderProductPictures(appKey, references);
  return { ...overview, levels: overview.levels.map((row, index) => ({ ...row,
    icon: images[index * 2]!, image: images[index * 2 + 1]! })) };
}
