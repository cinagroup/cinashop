/**
 * TokenBucket Durable Object
 *
 * 用于鉴权 token 的强一致存储。
 *
 * 为什么需要 DO 而不是只用 Upstash:
 *   - 单设备登录强制下线场景: 同一 uid 新 token 踢掉旧 token,
 *     需要"原子比较+替换", Upstash REST 跨网络做不到无竞态。
 *   - DO 单线程执行, blockConcurrencyWhile 天然互斥。
 *
 * sharding: 每个 uid 一个 DO 实例 (id = uid 字符串)。
 *
 * 注: M1 阶段 token bucket 主存 Upstash (与 PHP 兼容),
 *     DO 作为可选的"单设备登录"增强, 默认不启用。
 *     通过 SINGLE_DEVICE_LOGIN 配置开关。
 */
import { DurableObject } from "cloudflare:workers";

interface BucketState {
  token: string; // 当前有效 token
  tokenKey: string; // md5(token)
  exp: number; // 过期时间戳(秒)
}

export class TokenBucketDO extends DurableObject {
  /**
   * 注册 token。如果启用单设备登录且已有旧 token, 返回旧 tokenKey 让上层清除。
   *
   * @returns 被踢下线的旧 tokenKey (若有), 否则 null
   */
  async register(state: BucketState, forceKick: boolean): Promise<string | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const old = (await this.ctx.storage.get<BucketState>("current")) ?? null;
      await this.ctx.storage.put("current", state);
      // 设置过期 alarm (DO 不支持 TTL, 用 alarm 清理)
      await this.ctx.storage.setAlarm(state.exp * 1000);
      if (forceKick && old && old.tokenKey !== state.tokenKey) {
        return old.tokenKey;
      }
      return null;
    });
  }

  /** 校验当前 token 是否仍是有效的 (用于 auth 中间件二次确认) */
  async verify(tokenKey: string): Promise<boolean> {
    const cur = await this.ctx.storage.get<BucketState>("current");
    return cur?.tokenKey === tokenKey;
  }

  /** 主动注销 (用户登出 / 改密) */
  async revoke(): Promise<void> {
    await this.ctx.storage.delete("current");
  }

  /** alarm 触发时清理过期状态 */
  override async alarm(): Promise<void> {
    await this.ctx.storage.delete("current");
  }
}
