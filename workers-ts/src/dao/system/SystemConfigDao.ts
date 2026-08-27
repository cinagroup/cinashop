/**
 * SystemConfigDao
 *
 * 对应 PHP app/dao/system/SystemConfigDao.php。
 * 主要功能: 按 menu_name 取 value (对应 sys_config() 助手)。
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { systemConfig } from "@/models/schema/system";

export class SystemConfigDao extends BaseDao<typeof systemConfig> {
  constructor(db: DB) {
    super(db, systemConfig, {});
  }

  /**
   * 取单个配置值 (对应 PHP sys_config('record_No'))
   * is_store=0 表示总后台配置 (商城前台读这个)。
   *
   * 返回空字符串而非 null, 与 PHP 默认值行为一致。
   */
  async getValue(menuName: string, isStore = 0): Promise<string> {
    const rows = await (this.db
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, isStore)))
      // 历史版本曾重复插入默认配置。优先业务 sort，再取最新记录，避免
      // PostgreSQL 在重复键上以不确定的物理顺序返回示例值。
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id))
      .limit(1) as Promise<{ value: string }[]>);
    return rows[0]?.value ?? "";
  }

  /** 批量取多个配置 (减少往返, 给 service 层批量读用) */
  async getValues(menuNames: string[], isStore = 0): Promise<Record<string, string>> {
    if (menuNames.length === 0) return {};
    const rows = await (this.db
      .select({ menuName: systemConfig.menuName, value: systemConfig.value })
      .from(systemConfig)
      .where(and(inArray(systemConfig.menuName, menuNames), eq(systemConfig.isStore, isStore)))
      // 下面的归并由后者覆盖前者；因此高 sort / 新 id 与 getValue 一致。
      .orderBy(asc(systemConfig.sort), asc(systemConfig.id)) as Promise<
      { menuName: string; value: string }[]
    >);
    const set = new Set(menuNames);
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (set.has(r.menuName)) out[r.menuName] = r.value;
    }
    return out;
  }
}
