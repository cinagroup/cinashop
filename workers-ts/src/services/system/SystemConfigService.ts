/**
 * 系统配置 Service
 *
 * 对应 PHP crmeb/services/SystemConfigService.php + sys_config() 助手。
 * 读 eb_system_config 表的 value 字段。
 *
 * 带缓存: KV 存 30 分钟 (对应 PHP SystemConfigService::EXPIRE_TIME = 30天,
 * Workers 环境配置变更频率低, KV 缓存 30 分钟足够; 变更后通过 cacheDelete 失效)。
 */
import type { Container } from "@/lib/di";
import { normalizeConfigScalar } from "@/utils/config";

const CACHE_TTL = 30 * 60; // 30 分钟

/** Narrow binding contract used by config readers and integration harnesses. */
export interface SystemConfigEnv {
  CONFIG_KV: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

export class SystemConfigService {
  constructor(
    private readonly container: Container,
    private readonly env: SystemConfigEnv,
  ) {}

  /**
   * 取单个配置 (对应 sys_config('record_No'))
   * 优先读 KV 缓存, 未命中读 DB 并回填。
   */
  async get(menuName: string): Promise<string> {
    const cacheKey = `cfg_${menuName}`;

    // KV 命中
    const cached = await this.env.CONFIG_KV.get(cacheKey);
    if (cached !== null) return normalizeConfigScalar(cached);

    // 未命中 → 读 DB
    const value = normalizeConfigScalar(await this.container.systemConfigDao.getValue(menuName));

    // 回填 KV
    await this.env.CONFIG_KV.put(cacheKey, value, { expirationTtl: CACHE_TTL });
    return value;
  }

  /** 批量取 (一次 DB 往返, 比逐个 get 快) */
  async getMany(menuNames: string[]): Promise<Record<string, string>> {
    if (menuNames.length === 0) return {};
    const out: Record<string, string> = {};

    // 先批量查 KV (KV 不支持批量 get, 循环; 但 KV 读便宜)
    const miss: string[] = [];
    for (const name of menuNames) {
      const cached = await this.env.CONFIG_KV.get(`cfg_${name}`);
      if (cached !== null) {
        out[name] = normalizeConfigScalar(cached);
      } else {
        miss.push(name);
      }
    }

    if (miss.length > 0) {
      const values = await this.container.systemConfigDao.getValues(miss);
      for (const name of miss) {
        const v = normalizeConfigScalar(values[name]);
        out[name] = v;
        await this.env.CONFIG_KV.put(`cfg_${name}`, v, { expirationTtl: CACHE_TTL });
      }
    }
    return out;
  }

  /** 失效单个配置缓存 (后台修改配置后调用) */
  async invalidate(menuName: string): Promise<void> {
    await this.env.CONFIG_KV.delete(`cfg_${menuName}`);
  }
}
