import { ref } from "vue";
import {
  assertCurrentWorkTarget,
  clearWorkContext,
  currentWorkContext,
  ensureWorkContext,
  onWorkContextCleared,
} from "@/composables/workContext";
import { RequestError } from "@/utils/request";

export function useWorkAccess(kind: "client" | "group") {
  const token = ref("");
  const error = ref("");
  const connecting = ref(false);
  let version = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = onWorkContextCleared((oldToken) => {
    if (oldToken && token.value === oldToken) clear("企业微信会话已变化，请重新授权");
  });

  function clear(message = "") {
    version++;
    token.value = "";
    error.value = message;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  }

  async function connect(returnRoute: string, hint?: string) {
    const currentVersion = ++version;
    connecting.value = true;
    error.value = "";
    try {
      const context = await ensureWorkContext(kind, returnRoute, hint);
      if (version !== currentVersion) return "";
      token.value = context.token;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        if (version !== currentVersion) return;
        clearWorkContext(context.token);
        clear("企业微信授权已过期，请重新授权");
      }, Math.max(0, context.expiresAt - Date.now()));
      return context.token;
    } catch (cause) {
      if (version === currentVersion) {
        token.value = "";
        error.value = cause instanceof Error ? cause.message : "企业微信授权失败";
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimer = undefined;
      }
      return "";
    } finally {
      if (version === currentVersion) connecting.value = false;
    }
  }

  function readyToken(): string {
    const context = currentWorkContext(kind);
    if (!context || context.token !== token.value) {
      clear("企业微信授权已过期，请重新授权");
      return "";
    }
    return context.token;
  }

  async function verifiedToken(hint?: string, expectedToken?: string): Promise<string> {
    const current = readyToken();
    if (!current || (expectedToken && current !== expectedToken)) return "";
    if (hint === undefined) await assertCurrentWorkTarget(kind, current);
    return readyToken();
  }

  function readFailure(cause: unknown) {
    if (cause instanceof RequestError && (cause.httpStatus === 401 || cause.httpStatus === 403)) {
      clearWorkContext(token.value);
      clear("企业微信权限已变化，请重新授权");
    } else {
      error.value = cause instanceof Error ? cause.message : "读取失败，请重试";
    }
  }

  function dispose() { unsubscribe(); clear(); }

  return { token, error, connecting, connect, readyToken, verifiedToken, readFailure, dispose };
}
