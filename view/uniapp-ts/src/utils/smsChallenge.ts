import {
  apiVerifyCode,
  apiVerifyCodeStatus,
  type SmsChallenge,
  type UserSmsType,
} from "@/api/auth";

interface PendingChallenge {
  challenge: SmsChallenge;
  createdAt: number;
  resolve: (key: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let pending: PendingChallenge | undefined;

function clearPending(): PendingChallenge | undefined {
  const current = pending;
  pending = undefined;
  if (current) clearTimeout(current.timer);
  return current;
}

export async function requestSmsChallenge(phone: string, type: UserSmsType): Promise<string> {
  if (pending) throw new Error("已有安全验证正在进行");
  const challenge = await apiVerifyCode(phone, type);
  return new Promise<string>((resolve, reject) => {
    const createdAt = Date.now();
    const timer = setTimeout(() => {
      const expired = clearPending();
      expired?.reject(new Error("人机验证已过期，请重新获取"));
    }, Math.max(1, challenge.expire_time) * 60_000);
    pending = { challenge, createdAt, resolve, reject, timer };
    uni.navigateTo({
      url: `/pages/auth/smsChallenge?key=${encodeURIComponent(challenge.key)}&url=${encodeURIComponent(challenge.challenge_url)}`,
      fail: (error) => {
        const failed = clearPending();
        failed?.reject(new Error(error.errMsg || "无法打开人机验证页面"));
      },
    });
  });
}

export async function confirmPendingSmsChallenge(key: string): Promise<boolean> {
  const current = pending;
  if (!current || current.challenge.key !== key) return false;
  const result = await apiVerifyCodeStatus(key);
  if (!result.verified) return false;
  const completed = clearPending();
  completed?.resolve(key);
  return true;
}

/** Call from the originating page's onShow after the WebView page closes. */
export async function resumePendingSmsChallenge(): Promise<void> {
  const current = pending;
  if (!current || Date.now() - current.createdAt < 500) return;
  try {
    if (await confirmPendingSmsChallenge(current.challenge.key)) return;
  } catch (error) {
    const failed = clearPending();
    failed?.reject(error instanceof Error ? error : new Error("人机验证状态确认失败"));
    return;
  }
  const cancelled = clearPending();
  cancelled?.reject(new Error("未完成人机验证"));
}
