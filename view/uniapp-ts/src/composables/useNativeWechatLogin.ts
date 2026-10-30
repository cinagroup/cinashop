/** APP-PLUS only. The verifier and pending capability live in this page's
 * memory. SDK completion supplies a code; only the server supplies an identity. */
import { onUnmounted, ref, watch } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { apiRequestCode } from '@/api/auth';
import { apiNativeWechatAuthChallenge, apiNativeWechatAuthComplete, apiNativeWechatAuthPhone,
  type NativeWechatAuthenticated, type NativeWechatAuthChallenge } from '@/api/nativeWechatAuth';
import { useAuthStore } from '@/stores/auth';
import { requestSmsChallenge } from '@/utils/smsChallenge';
import { reserveNativeWechatAuthorize } from '@/utils/nativeWechatAuthorizeEntry';
import { NativeWechatAuthorizeError } from '@/utils/nativeWechatAuthorize';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const validTtl = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 900;
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function checkedChallenge(value: unknown, appId: string): NativeWechatAuthChallenge {
  if (!keys(value, ['state', 'verifier', 'appId', 'expiresIn']) || typeof value.state !== 'string' || !UUID.test(value.state)
    || typeof value.verifier !== 'string' || !/^[a-f0-9]{64}$/u.test(value.verifier) || value.appId !== appId || !validTtl(value.expiresIn))
    throw Error('微信登录响应无效');
  return value as unknown as NativeWechatAuthChallenge;
}
function checkedLogin(value: unknown): NativeWechatAuthenticated {
  if (!keys(value, ['token', 'exp_time', 'uid']) || typeof value.token !== 'string' || value.token.length > 16384
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value.token)
    || !Number.isSafeInteger(value.uid) || Number(value.uid) <= 0 || !Number.isSafeInteger(value.exp_time)
    || Number(value.exp_time) <= Math.floor(Date.now() / 1000)) throw Error('微信登录响应无效');
  return value as unknown as NativeWechatAuthenticated;
}

export function useNativeWechatLogin() {
  const nativeBusy = ref(false), nativePhoneRequired = ref(false), nativePhone = ref(''), nativeCaptcha = ref('');
  const nativeCodeSending = ref(false), nativeCountdown = ref(0);
  const auth = useAuthStore();
  type Phase = 'state' | 'services' | 'sdk' | 'complete' | 'phone' | 'sms' | 'phone-complete';
  interface Operation {
    owner: { uid: number; token: string; version: number };
    deadline: number; phase: Phase; verifier: string; key: string;
    lease: ReturnType<typeof reserveNativeWechatAuthorize>;
    waitForShow?: (valid: boolean) => void;
  }
  let active: Operation | undefined, visible = false, disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, countdownTimer: ReturnType<typeof setInterval> | undefined;
  let navigateTimer: ReturnType<typeof setTimeout> | undefined;
  const ownerCurrent = (op: Operation) => !disposed && auth.uid === op.owner.uid && auth.token === op.owner.token
    && auth.sessionVersion === op.owner.version;
  const current = (op: Operation) => active === op && ownerCurrent(op) && Date.now() <= op.deadline;
  const notice = (title: string) => { if (!disposed && visible) uni.showToast({ title, icon: 'none' }); };
  function retire() {
    const previous = active; active = undefined;
    if (expiryTimer) clearTimeout(expiryTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    expiryTimer = undefined; countdownTimer = undefined;
    nativeBusy.value = false; nativePhoneRequired.value = false; nativeCodeSending.value = false; nativeCountdown.value = 0;
    nativePhone.value = ''; nativeCaptcha.value = '';
    if (previous) {
      previous.verifier = ''; previous.key = ''; previous.lease.release();
      previous.waitForShow?.(false); previous.waitForShow = undefined;
    }
  }
  function setExpiry(op: Operation, seconds: number) {
    if (expiryTimer) clearTimeout(expiryTimer);
    op.deadline = Date.now() + seconds * 1000;
    expiryTimer = setTimeout(() => {
      if (active !== op) return;
      const show = ownerCurrent(op); retire(); if (show) notice('微信授权已过期，请重新发起登录');
    }, seconds * 1000 + 1);
  }
  function waitVisible(op: Operation): Promise<boolean> {
    if (!current(op)) return Promise.resolve(false);
    if (visible) return Promise.resolve(true);
    return new Promise(resolve => { op.waitForShow = resolve; });
  }
  function publishLogin(op: Operation, value: unknown) {
    if (!current(op) || !visible) return;
    const login = checkedLogin(value);
    retire(); auth.setLogin(login.token, login.uid);
    const issued = { token: auth.token, uid: auth.uid, version: auth.sessionVersion };
    uni.showToast({ title: '登录成功', icon: 'success' });
    if (navigateTimer) clearTimeout(navigateTimer);
    navigateTimer = setTimeout(() => {
      if (!disposed && visible && auth.token === issued.token && auth.uid === issued.uid && auth.sessionVersion === issued.version)
        uni.navigateBack();
    }, 800);
  }
  async function beginNativeLogin() {
    if (disposed || !visible || nativeBusy.value || active) return;
    let op: Operation | undefined;
    try {
      const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
      const lease = reserveNativeWechatAuthorize(() => op ? current(op) : !disposed && visible
        && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version);
      op = { owner, deadline: Date.now() + 900_000, phase: 'state', verifier: '', key: '', lease };
      active = op; nativeBusy.value = true; setExpiry(op, 900);
      const challenge = checkedChallenge(await apiNativeWechatAuthChallenge(), lease.appId);
      if (!current(op) || !visible) return;
      op.verifier = challenge.verifier; setExpiry(op, challenge.expiresIn); op.phase = 'services';
      const target = op;
      const authorization = await lease.authorize({ state: challenge.state, appId: challenge.appId }, () => { target.phase = 'sdk'; });
      // WeChat may background the App. Keep the code only in this live call,
      // and wait for its own view to return before making the completion POST.
      if (!await waitVisible(op) || !current(op)) return;
      op.phase = 'complete';
      const result = await apiNativeWechatAuthComplete(authorization.code, authorization.state, op.verifier);
      if (!current(op) || !visible) return;
      if (keys(result, ['need_phone', 'key', 'expiresIn']) && result.need_phone === true && typeof result.key === 'string'
        && UUID.test(result.key) && validTtl(result.expiresIn)) {
        op.key = result.key; op.phase = 'phone'; setExpiry(op, result.expiresIn);
        nativePhoneRequired.value = true; nativeBusy.value = false;
      } else publishLogin(op, result);
    } catch (error) {
      if (op ? current(op) : !disposed && visible) notice(error instanceof NativeWechatAuthorizeError
        ? error.message : '微信登录未完成，请重新发起授权');
    } finally {
      if (op && active === op && op.phase !== 'phone') retire();
    }
  }
  async function sendNativePhoneCode() {
    const op = active, phone = nativePhone.value;
    if (!op || !current(op) || !visible || op.phase !== 'phone' || nativeCodeSending.value || nativeCountdown.value) return;
    if (!/^1\d{10}$/u.test(phone)) { notice('请输入正确的手机号'); return; }
    nativeCodeSending.value = true; op.phase = 'sms';
    try {
      // This is the human challenge key, distinct from the native pending key.
      const smsKey = await requestSmsChallenge(phone, 'social_binding');
      if (!await waitVisible(op) || !current(op) || nativePhone.value !== phone) return;
      await apiRequestCode(phone, 'social_binding', smsKey);
      if (!await waitVisible(op) || !current(op) || nativePhone.value !== phone) return;
      notice('验证码任务已提交'); nativeCountdown.value = 60;
      countdownTimer = setInterval(() => {
        if (!current(op)) { retire(); return; }
        nativeCountdown.value = Math.max(0, nativeCountdown.value - 1);
        if (!nativeCountdown.value && countdownTimer) { clearInterval(countdownTimer); countdownTimer = undefined; }
      }, 1000);
    } catch { if (current(op)) notice('验证码发送未完成，请重试'); }
    finally { if (current(op)) { op.phase = 'phone'; nativeCodeSending.value = false; } }
  }
  async function completeNativePhoneLogin() {
    const op = active, phone = nativePhone.value, captcha = nativeCaptcha.value;
    if (!op || !current(op) || !visible || op.phase !== 'phone' || nativeBusy.value || nativeCodeSending.value) return;
    if (!/^1\d{10}$/u.test(phone) || !/^\d{6}$/u.test(captcha)) { notice('请输入正确的手机号和 6 位验证码'); return; }
    nativeBusy.value = true; op.phase = 'phone-complete';
    try {
      const result = await apiNativeWechatAuthPhone(op.key, op.verifier, phone, captcha);
      if (current(op) && visible && nativePhone.value === phone && nativeCaptcha.value === captcha) publishLogin(op, result);
    } catch { if (current(op)) notice('绑定未完成，请核对验证码或重新微信授权'); }
    finally { if (active === op) retire(); }
  }
  const cancelNativeLogin = () => retire();
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { if (active && !ownerCurrent(active)) retire(); }, { flush: 'sync' });
  onShow(() => { visible = true; const op = active; if (op) { if (!current(op)) retire(); else { op.waitForShow?.(true); op.waitForShow = undefined; } } });
  onHide(() => {
    visible = false; if (navigateTimer) clearTimeout(navigateTimer);
    if (active && !['sdk', 'phone', 'sms'].includes(active.phase)) retire();
  });
  const dispose = () => { disposed = true; visible = false; retire(); if (navigateTimer) clearTimeout(navigateTimer); };
  onUnload(dispose); onUnmounted(dispose);
  return { nativeBusy, nativePhoneRequired, nativePhone, nativeCaptcha, nativeCodeSending, nativeCountdown,
    beginNativeLogin, cancelNativeLogin, sendNativePhoneCode, completeNativePhoneLogin };
}
