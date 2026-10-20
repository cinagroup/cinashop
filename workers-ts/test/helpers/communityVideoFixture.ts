import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { financePostgres } from "./financePostgres";
import { createContainerFromDb } from "@/lib/di";
import type { Env } from "@/env";
import { user, systemAttachment, systemAttachmentCategory, systemConfig, community, communityUser,
  communityTopic, communityRelevance, communityComment, userRelation, storeProduct, storeProductLog } from "@/models/schema";
import { createToken, md5 } from "@/utils/jwt";
import { advanceRateWindows, type RateLimitPolicy, type RateWindow } from "@/services/out/OutRateLimitPolicy";

export async function communityVideoFixture() {
  const f = await financePostgres([user, systemAttachment, systemAttachmentCategory, systemConfig, community,
    communityUser, communityTopic, communityRelevance, communityComment, userRelation, storeProduct, storeProductLog]);
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const counts = new Map<string, number>(), cache = new Map<string, string>();
  const rateStates = new Map<string, Record<string, RateWindow>>();
  let afterPut: (() => Promise<void>) | undefined;
  const bucket = {
    put: vi.fn(async (key: string, body: BodyInit, options?: R2PutOptions) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, type: (options?.httpMetadata as R2HTTPMetadata)?.contentType ?? "" });
      await afterPut?.();
      return { key, size: bytes.length };
    }),
    get: vi.fn(async (key: string, options?: R2GetOptions) => {
      const value = objects.get(key); if (!value) return null;
      let range = options?.range as R2Range | Headers | undefined;
      const size = value.bytes.length;
      if (range instanceof Headers) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.get("range") ?? "");
        if (!match) throw Error("Invalid fixture range");
        range = match[1] ? { offset: Number(match[1]), ...(match[2] ? { length: Number(match[2]) - Number(match[1]) + 1 } : {}) }
          : { suffix: Number(match[2]) };
      }
      let start = 0, length = size;
      if (range) {
        start = "suffix" in range ? Math.max(0, size - range.suffix) : range.offset ?? 0;
        length = Math.min(size - start, "suffix" in range ? range.suffix : range.length ?? size - start);
      }
      return { key, size, body: value.bytes.slice(start, start + length), ...(range ? { range: { offset: start, length } } : {}),
        httpMetadata: { contentType: value.type }, httpEtag: '"synthetic-video-r2"',
        writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", value.type) };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  };
  const env = {
    APP_KEY: "owned-community-video-fixture", NODE_ENV: "test", UPSTASH_REDIS_URL: "", UPSTASH_REDIS_TOKEN: "",
    ASSETS_BUCKET: bucket, ORDER_QUEUE: { send: vi.fn(async () => {}) },
    TOKEN_BUCKET: { getByName: vi.fn((name: string) => ({
      consumeRateLimit: async (policies: RateLimitPolicy[], seconds: number) => {
        const previous = rateStates.get(name) ?? {};
        if (counts.has(name)) previous.upload = { count: counts.get(name)!, resetAt: previous.upload?.resetAt ?? Date.now() + seconds * 1000 };
        const next = advanceRateWindows(previous, policies, Date.now(), seconds);
        rateStates.set(name, next.windows); counts.set(name, next.windows.upload.count); return next.decision;
      },
    })) },
    CONFIG_KV: { get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); }, delete: async (key: string) => { cache.delete(key); } },
  } as unknown as Env;
  const password = "synthetic-video-password";
  await f.db.insert(user).values([11, 22].map(uid => ({ uid, account: `video-${uid}`, nickname: `视频作者${uid}`, pwd: password, status: 1 })));
  await f.db.insert(communityTopic).values({ id: 9, name: "本地视频", status: 1, isDel: 0 });
  const token = (await createToken(11, "api", md5(password), env.APP_KEY)).token;
  const otherToken = (await createToken(22, "api", md5(password), env.APP_KEY)).token;
  const mp4 = new Uint8Array(await readFile(resolve(import.meta.dirname, "../fixtures/community-video.mp4")));
  const container = createContainerFromDb(f.db);
  return { ...f, env, token, otherToken, container, objects, counts, cache, bucket, mp4,
    file: () => new File([mp4], "community-video.mp4", { type: "video/mp4" }),
    onPut: (callback?: () => Promise<void>) => { afterPut = callback; },
  };
}
