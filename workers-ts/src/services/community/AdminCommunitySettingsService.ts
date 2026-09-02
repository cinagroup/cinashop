import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { systemLog } from "@/models/schema/admin";
import { systemConfig } from "@/models/schema/system";
import { ValidateException } from "@/utils/errors";

export const COMMUNITY_SETTING_KEYS = [
  "community_status",
  "community_verify",
  "community_video_verify",
  "community_comment_status",
  "community_comment_add",
  "community_comment_verify",
] as const;

export type CommunitySettingKey = (typeof COMMUNITY_SETTING_KEYS)[number];
export type CommunitySettings = Record<CommunitySettingKey, 0 | 1>;

export interface CommunitySettingsActor {
  id: number;
  name: string;
  ip: string;
}

export interface CommunitySettingsSnapshot {
  settings: CommunitySettings;
  missing_keys: CommunitySettingKey[];
  duplicate_keys: CommunitySettingKey[];
}

interface ConfigRow {
  id: number;
  menuName: string;
  value: string;
  sort: number;
}

const DEFAULT_SETTINGS: CommunitySettings = {
  community_status: 1,
  community_verify: 1,
  community_video_verify: 1,
  community_comment_status: 1,
  community_comment_add: 1,
  community_comment_verify: 0,
};

const SETTING_META: Record<CommunitySettingKey, { info: string; desc: string; sort: number }> = {
  community_status: { info: "社区功能", desc: "关闭后用户端不展示社区入口", sort: 60 },
  community_verify: { info: "社区内容审核", desc: "用户发布的图文内容需要后台审核", sort: 50 },
  community_video_verify: { info: "社区视频审核", desc: "用户发布的视频内容需要后台审核", sort: 40 },
  community_comment_status: { info: "社区评论功能", desc: "允许用户查看社区评论", sort: 30 },
  community_comment_add: { info: "社区发表评论", desc: "允许用户发布社区评论", sort: 20 },
  community_comment_verify: { info: "社区评论审核", desc: "用户发布的评论需要后台审核", sort: 10 },
};

function normalizeStoredFlag(value: string): 0 | 1 {
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Legacy rows may contain an unquoted scalar.
  }
  return parsed === true || parsed === 1 || parsed === "1" || parsed === "true" ? 1 : 0;
}

function normalizeInputFlag(value: unknown, key: CommunitySettingKey): 0 | 1 {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new ValidateException(`配置 ${key} 只能为 0 或 1`);
}

export function normalizeCommunitySettingsInput(input: Record<string, unknown>): CommunitySettings {
  const wrapped = Object.hasOwn(input, "settings");
  if (wrapped && Object.keys(input).some((key) => key !== "settings")) {
    throw new ValidateException("社区设置请求包含未知字段");
  }
  const raw = wrapped ? input.settings : input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidateException("社区设置格式错误");
  }
  const source = raw as Record<string, unknown>;
  const allowed = new Set<string>(COMMUNITY_SETTING_KEYS);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidateException(`未知社区配置: ${unknown.join(", ")}`);
  const missing = COMMUNITY_SETTING_KEYS.filter((key) => !Object.hasOwn(source, key));
  if (missing.length) throw new ValidateException(`缺少社区配置: ${missing.join(", ")}`);
  return Object.fromEntries(
    COMMUNITY_SETTING_KEYS.map((key) => [key, normalizeInputFlag(source[key], key)]),
  ) as CommunitySettings;
}

function snapshotFromRows(rows: ConfigRow[]): CommunitySettingsSnapshot {
  const grouped = new Map<CommunitySettingKey, ConfigRow[]>();
  for (const key of COMMUNITY_SETTING_KEYS) grouped.set(key, []);
  for (const row of rows) {
    if ((COMMUNITY_SETTING_KEYS as readonly string[]).includes(row.menuName)) {
      grouped.get(row.menuName as CommunitySettingKey)!.push(row);
    }
  }
  const missingKeys: CommunitySettingKey[] = [];
  const duplicateKeys: CommunitySettingKey[] = [];
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of COMMUNITY_SETTING_KEYS) {
    const candidates = grouped.get(key)!;
    if (!candidates.length) missingKeys.push(key);
    if (candidates.length > 1) duplicateKeys.push(key);
    if (candidates[0]) settings[key] = normalizeStoredFlag(candidates[0].value);
  }
  return { settings, missing_keys: missingKeys, duplicate_keys: duplicateKeys };
}

async function readRows(db: DbClient, lock = false): Promise<ConfigRow[]> {
  const query = db
    .select({ id: systemConfig.id, menuName: systemConfig.menuName, value: systemConfig.value, sort: systemConfig.sort })
    .from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...COMMUNITY_SETTING_KEYS])))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id));
  return lock ? query.for("update") : query;
}

export class AdminCommunitySettingsService {
  constructor(
    private readonly container: Container,
    private readonly env: Pick<Env, "CONFIG_KV">,
  ) {}

  async read(): Promise<CommunitySettingsSnapshot> {
    return snapshotFromRows(await readRows(this.container.db));
  }

  async save(
    rawInput: Record<string, unknown>,
    actor: CommunitySettingsActor,
  ): Promise<CommunitySettingsSnapshot & { verified: true }> {
    const input = normalizeCommunitySettingsInput(rawInput);
    const snapshot = await withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-community-settings'))`);
      const current = await readRows(tx, true);
      const before = snapshotFromRows(current);
      if (before.duplicate_keys.length) {
        throw new ValidateException(`配置 ${before.duplicate_keys.join(", ")} 存在重复历史记录，请先清理`);
      }

      const byKey = new Map(current.map((row) => [row.menuName as CommunitySettingKey, row]));
      for (const key of COMMUNITY_SETTING_KEYS) {
        const existing = byKey.get(key);
        const value = JSON.stringify(input[key]);
        if (existing) {
          await tx.update(systemConfig).set({ value }).where(eq(systemConfig.id, existing.id));
        } else {
          const meta = SETTING_META[key];
          await tx.insert(systemConfig).values({
            isStore: 0,
            menuName: key,
            type: "radio",
            inputType: "radio",
            parameter: "1=开启,0=关闭",
            value,
            info: meta.info,
            desc: meta.desc,
            sort: meta.sort,
            status: 1,
          });
        }
      }

      const verified = snapshotFromRows(await readRows(tx));
      if (verified.missing_keys.length || verified.duplicate_keys.length
        || COMMUNITY_SETTING_KEYS.some((key) => verified.settings[key] !== input[key])) {
        throw new Error("community_settings_readback_mismatch");
      }
      await tx.insert(systemLog).values({
        adminId: actor.id,
        adminName: actor.name.slice(0, 64),
        path: "/adminapi/community/settings",
        page: "/community",
        method: "POST",
        action: `community.settings.update;enabled=${COMMUNITY_SETTING_KEYS.filter((key) => input[key] === 1).length}`,
        ip: actor.ip.slice(0, 45),
        type: "community",
        addTime: Math.floor(Date.now() / 1_000),
      });
      return verified;
    });

    await Promise.all(COMMUNITY_SETTING_KEYS.map((key) => this.env.CONFIG_KV.delete(`cfg_${key}`)));
    return { ...snapshot, verified: true };
  }
}
