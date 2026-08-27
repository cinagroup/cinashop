import { and, eq, gte, or } from "drizzle-orm";
import { type Container, withTx } from "@/lib/di";
import { legacyCache } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

const MAX_CACHE_DOCUMENT_BYTES = 512 * 1024;
const MAX_CACHE_TTL_SECONDS = 366 * 24 * 60 * 60;

export interface DatabaseCacheWrite {
  key: string;
  value: unknown;
  ttlSeconds?: number;
}

function validKey(key: string): boolean {
  return key.length > 0
    && key.length <= 32
    && key.trim() === key
    && !/[\u0000-\u001f\u007f]/.test(key);
}

function encode(value: unknown): string {
  let result: string;
  try {
    result = JSON.stringify(value);
  } catch {
    throw new ValidateException("缓存内容无法序列化");
  }
  if (result === undefined) throw new ValidateException("缓存内容无法序列化");
  if (new TextEncoder().encode(result).byteLength > MAX_CACHE_DOCUMENT_BYTES) {
    throw new ValidateException("缓存内容不能超过512 KiB");
  }
  return result;
}

/**
 * Read legacy DB-backed JSON documents without turning storefront reads into
 * cleanup writes. The PHP service deleted all expired rows before each read;
 * here expiry is enforced in the predicate and maintenance can purge later.
 */
export class DatabaseCacheService {
  constructor(private readonly container: Container) {}

  async get<T>(key: string, fallback: T, now = Math.floor(Date.now() / 1000)): Promise<T> {
    if (!validKey(key)) return fallback;
    const rows = await this.container.db
      .select({ result: legacyCache.result })
      .from(legacyCache)
      .where(
        and(
          eq(legacyCache.key, key),
          or(eq(legacyCache.expireTime, 0), gte(legacyCache.expireTime, now)),
        ),
      )
      .limit(1);
    const result = rows[0]?.result;
    if (!result) return fallback;
    try {
      return JSON.parse(result) as T;
    } catch {
      return fallback;
    }
  }

  /** Atomic insert-or-update matching PHP setDbCache without a check-then-write race. */
  async set(key: string, value: unknown, ttlSeconds = 0, now = Math.floor(Date.now() / 1000)) {
    await this.setMany([{ key, value, ttlSeconds }], now);
  }

  /** Replace multiple cache documents in one short transaction. */
  async setMany(entries: readonly DatabaseCacheWrite[], now = Math.floor(Date.now() / 1000)) {
    if (!Number.isSafeInteger(now) || now < 0) throw new ValidateException("缓存时间参数错误");
    const prepared = entries.map((entry) => {
      if (!validKey(entry.key)) throw new ValidateException("缓存键格式错误");
      const ttlSeconds = entry.ttlSeconds ?? 0;
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_CACHE_TTL_SECONDS) {
        throw new ValidateException("缓存有效期参数错误");
      }
      return {
        key: entry.key,
        result: encode(entry.value),
        expireTime: ttlSeconds ? now + ttlSeconds : 0,
        addTime: now,
      };
    }).sort((left, right) => left.key.localeCompare(right.key));
    if (!prepared.length) return;

    await withTx(this.container, async (tx) => {
      for (const row of prepared) {
        await tx
          .insert(legacyCache)
          .values(row)
          .onConflictDoUpdate({
            target: legacyCache.key,
            set: {
              result: row.result,
              expireTime: row.expireTime,
              addTime: row.addTime,
            },
          });
      }
    });
  }

  /** Explicit operator/user action only; reads never perform cleanup writes. */
  async remove(key: string): Promise<void> {
    if (!validKey(key)) throw new ValidateException("缓存键格式错误");
    await this.container.db.delete(legacyCache).where(eq(legacyCache.key, key));
  }
}
