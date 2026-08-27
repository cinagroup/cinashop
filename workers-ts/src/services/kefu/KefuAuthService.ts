import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { storeService } from "@/models/schema";
import { clearToken, setTokenBucket } from "@/utils/cache";
import { ApiErrorCode, ApiException, ValidateException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";

export interface KefuIdentity {
  id: number;
  uid: number;
  account: string;
  avatar: string;
  nickname: string;
  phone: string;
  online: number;
}

export type KefuAuthEnv = Pick<
  Env,
  "APP_KEY" | "UPSTASH_REDIS_URL" | "UPSTASH_REDIS_TOKEN"
>;

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidateException(`请输入${label}`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new ValidateException(`${label}不能超过${maximum}个字符`);
  }
  return normalized;
}

export function publicKefuIdentity(
  row: typeof storeService.$inferSelect,
): KefuIdentity {
  return {
    id: row.id,
    uid: row.uid,
    account: row.account,
    avatar: row.avatar,
    nickname: row.nickname,
    phone: row.phone,
    online: row.online,
  };
}

export class KefuAuthService {
  constructor(
    private readonly container: Container,
    private readonly env: KefuAuthEnv,
  ) {}

  async login(input: Record<string, unknown>) {
    const account = text(input.account, "账号", 64);
    const password = text(input.password, "密码", 128);
    const rows = await this.container.db
      .select()
      .from(storeService)
      .where(and(eq(storeService.account, account), eq(storeService.isDel, 0)))
      .limit(1);
    const kefu = rows[0];
    if (!kefu) throw new ValidateException("账号或密码错误");
    const hash = kefu.password.replace(/^\$2[by]\$/, "$2a$");
    const valid = await bcrypt.compare(password, hash).catch(() => false);
    if (!valid) {
      throw new ValidateException("账号或密码错误");
    }
    if (!kefu.status || !kefu.accountStatus) {
      throw new ValidateException("您已被禁止登录");
    }
    if (!Number.isSafeInteger(kefu.uid) || kefu.uid <= 0) {
      throw new ValidateException("客服账号未绑定有效用户");
    }

    const { token, exp } = await createToken(
      kefu.id,
      "kefu",
      md5(kefu.password),
      this.env.APP_KEY,
    );
    const stored = await setTokenBucket(
      md5(token),
      {
        uid: kefu.id,
        type: "kefu",
        token,
        exp: exp - Math.floor(Date.now() / 1000) + 60,
      },
      this.env,
    );
    if (!stored) {
      throw new ApiException("登录状态保存失败", ApiErrorCode.ERR_SAVE_TOKEN);
    }
    return {
      token,
      exp_time: exp,
      kefuInfo: publicKefuIdentity(kefu),
    };
  }

  async logout(token: string, kefuId: number) {
    await Promise.all([
      clearToken(md5(token), this.env),
      this.container.db
        .update(storeService)
        .set({ online: 0 })
        .where(eq(storeService.id, kefuId)),
    ]);
  }
}
