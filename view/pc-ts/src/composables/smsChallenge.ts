import { readonly, ref } from "vue";
import {
  apiVerifyCode,
  apiVerifyCodeStatus,
  type SmsChallenge,
  type UserSmsType,
} from "@/api/auth";

const visible = ref(false);
const challenge = ref<SmsChallenge | null>(null);
let resolvePending: ((key: string) => void) | undefined;
let rejectPending: ((error: Error) => void) | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function clearPending(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  resolvePending = undefined;
  rejectPending = undefined;
  challenge.value = null;
  visible.value = false;
}

export const smsChallengeDialog = {
  visible: readonly(visible),
  challenge: readonly(challenge),
};

export async function requestSmsChallenge(phone: string, type: UserSmsType): Promise<string> {
  if (resolvePending || rejectPending) throw new Error("已有安全验证正在进行");
  const created = await apiVerifyCode(phone, type);
  challenge.value = created;
  visible.value = true;
  return new Promise<string>((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
    expiryTimer = setTimeout(() => {
      const rejectExpired = rejectPending;
      clearPending();
      rejectExpired?.(new Error("人机验证已过期，请重新获取"));
    }, Math.max(1, created.expire_time) * 60_000);
  });
}

export async function confirmSmsChallenge(key: string): Promise<void> {
  const current = challenge.value;
  if (!current || current.key !== key || !resolvePending) return;
  const result = await apiVerifyCodeStatus(key);
  if (!result.verified) throw new Error("人机验证尚未完成");
  const resolve = resolvePending;
  clearPending();
  resolve(key);
}

export function cancelSmsChallenge(message = "已取消人机验证"): void {
  if (!resolvePending && !rejectPending) {
    clearPending();
    return;
  }
  const reject = rejectPending;
  clearPending();
  reject?.(new Error(message));
}
