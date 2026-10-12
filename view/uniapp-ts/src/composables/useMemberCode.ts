import { computed, onScopeDispose, ref, watch } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import { apiMemberCode } from "@/api/memberCode";
import { useAuthStore } from "@/stores/auth";

export function useMemberCode() {
  const auth = useAuthStore();
  const code = ref("");
  const loading = ref(false);
  const error = ref("");
  const loggedIn = computed(() => auth.isLoggedIn && Number.isSafeInteger(auth.uid) && auth.uid > 0);
  let visible = false;
  let disposed = false;
  let generation = 0;

  function clearCode(): void {
    generation++;
    code.value = "";
    loading.value = false;
    error.value = "";
  }

  async function showCode(): Promise<void> {
    if (!visible || disposed || loading.value || code.value) return;
    if (!loggedIn.value) { error.value = "请先登录后显示会员核销码"; return; }
    const owner = { generation: ++generation, uid: auth.uid, token: auth.token, version: auth.sessionVersion };
    const current = () => visible && !disposed && loggedIn.value && generation === owner.generation
      && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version;
    loading.value = true;
    error.value = "";
    try {
      const result = await apiMemberCode();
      if (current()) code.value = result;
    } catch (cause) {
      if (current()) error.value = cause instanceof Error ? cause.message : "会员核销码读取失败，请重试";
    } finally {
      if (current()) loading.value = false;
    }
  }

  function drawFailed(failedCode: string): void {
    // A detached canvas from an earlier display must not erase a newer display.
    if (!visible || disposed || !code.value || failedCode !== code.value) return;
    clearCode();
    error.value = "会员核销码绘制失败，请重新显示";
  }

  function login(): void {
    if (!visible || disposed) return;
    clearCode();
    uni.navigateTo({ url: "/pages/auth/login" });
  }

  function suspend(): void { visible = false; clearCode(); }
  function dispose(): void { disposed = true; suspend(); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => {
    clearCode();
    if (visible && !disposed) error.value = loggedIn.value
      ? "登录状态已变化，请重新显示会员核销码" : "请先登录后显示会员核销码";
  }, { flush: "sync" });
  onShow(() => {
    if (disposed) return;
    clearCode();
    visible = true;
  });
  onHide(suspend);
  onUnload(dispose);
  onScopeDispose(dispose);

  return { code, loading, error, loggedIn, showCode, hideCode: clearCode, drawFailed, login };
}
