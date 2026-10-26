import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createSignRequests, moveSignMonth, signDate, type SignRequests, type SignConfig, type SignStatus, type SignCalendar, type SignRecord } from '@/api/signCentre';
import { RequestError } from '@/utils/request';

/** An unresolved write survives page disposal. Only subsequent reads reconcile it. */
export function useSignCentre() {
  const auth = useAuthStore(), visible = ref(false), config = ref<SignConfig | null>(null), status = ref<SignStatus | null>(null);
  const calendar = ref<SignCalendar | null>(null), recent = ref<SignRecord[]>([]), points = ref<number | null>(null);
  const loading = ref(false), writing = ref(false), loaded = ref(false), error = ref(''), notice = ref(''), pendingDay = ref('');
  const retryDay = ref('');
  const reminderVersion = ref(0);
  const calendarOpen = ref(false), calendarLoading = ref(false), calendarError = ref('');
  const scopes = new Set<SignRequests>(); let epoch = 0, calendarEpoch = 0, disposed = false;
  const loggedIn = computed(() => auth.isLoggedIn && auth.uid > 0);
  const active = (id: number) => !disposed && visible.value && loggedIn.value && id === epoch;
  const blocked = computed(() => !visible.value || !loggedIn.value || loading.value || writing.value || !loaded.value || !!error.value || !!pendingDay.value);
  const canSign = computed(() => !blocked.value && status.value?.enabled === true && status.value.signedToday === false);
  const canRetry = computed(() => !disposed && visible.value && loggedIn.value && !loading.value && !writing.value && loaded.value && !error.value
    && !!pendingDay.value && retryDay.value === pendingDay.value && calendar.value?.today === pendingDay.value && status.value?.enabled === true && status.value.signedToday === false);
  const buttonText = computed(() => writing.value ? '正在处理…' : loading.value ? '加载中…' : pendingDay.value ? '请先核对签到结果'
    : error.value ? '请重新加载' : status.value?.enabled === false ? '签到未开启' : status.value?.signedToday ? '今日已签到' : '立即签到');
  const key = () => `cinashop_sign_pending_v1_${auth.uid}`;
  function storedDay() {
    const value: unknown = uni.getStorageSync(key());
    if (value === '' || value === undefined || value === null) return '';
    return signDate(value);
  }
  function remember(day: string) { uni.setStorageSync(key(), signDate(day)); pendingDay.value = day; }
  function forget() { uni.removeStorageSync(key()); pendingDay.value = ''; }
  function scope(id = epoch) { const s = createSignRequests(() => active(id)); scopes.add(s); return s; }
  function release(s: SignRequests) { scopes.delete(s); s.abort(); }
  function invalidate() { epoch++; calendarEpoch++; for (const s of scopes) s.abort(); scopes.clear(); }
  function clear() {
    invalidate(); config.value = null; status.value = null; calendar.value = null; recent.value = []; points.value = null;
    loaded.value = false; loading.value = false; writing.value = false; error.value = ''; notice.value = ''; pendingDay.value = ''; retryDay.value = '';
    calendarOpen.value = false; calendarLoading.value = false; calendarError.value = '';
  }
  async function load() {
    if (!visible.value || disposed || writing.value) return;
    if (!loggedIn.value) { clear(); return; }
    invalidate(); const id = epoch, s = scope(id);
    loaded.value = false; loading.value = true; error.value = ''; calendarError.value = ''; retryDay.value = '';
    config.value = null; status.value = null; calendar.value = null; recent.value = []; points.value = null;
    try {
      pendingDay.value = storedDay();
      const [c, st, cal, rows, wallet] = await Promise.all([s.config(), s.status(), s.calendar(), s.recent(), s.points()]);
      if (!s.active()) return;
      // Separate endpoints have no shared snapshot. Never resolve contradictions by guessing.
      if (c.checkSign !== st.signedToday || cal.checkSign !== st.signedToday || c.cumulativeSignDays !== st.cumulativeDays
        || cal.cumulativeSignDays !== st.cumulativeDays || (c.signStatus !== 0) !== st.enabled) throw Error('签到状态正在变化，请重新加载');
      const day = pendingDay.value;
      if (day) {
        const previous = day.slice(0, 7) === cal.month ? cal : await s.calendar(day.slice(0, 7));
        if (!s.active()) return;
        const signed = previous.signList[Number(day.slice(8)) - 1]?.is_sign === true;
        if (signed) { forget(); notice.value = `${day} 已有签到记录，已核对当天状态。`; }
        else if (day < cal.today) {
          forget(); notice.value = `${day} 暂未查到签到记录，原请求结果仍未确认；可单独签到今日。`;
        } else {
          retryDay.value = day;
          notice.value = `${day} 原请求结果未确认，暂未查到签到记录。${st.enabled ? '可手动重新尝试今日签到。' : '请稍后刷新核对。'}`;
        }
      }
      config.value = c; status.value = st; calendar.value = cal; recent.value = rows; points.value = wallet; loaded.value = true;
    } catch (e) { if (active(id)) error.value = e instanceof Error ? e.message : '签到加载失败，请重试'; }
    finally { if (active(id)) loading.value = false; release(s); }
  }
  async function signAction(retry: boolean) {
    if (retry ? !canRetry.value : !canSign.value) return;
    const previousDay = pendingDay.value;
    const id = epoch, s = scope(id); writing.value = true; notice.value = '';
    let submitted = false, refresh = false;
    try {
      // Capture a fresh Shanghai day before the write, including a page left open over midnight.
      const [cal, st] = await Promise.all([s.calendar(), s.status()]);
      if (!s.active()) return;
      // Retrying yesterday is never authority to submit today's separate sign.
      if (retry && cal.today !== previousDay) { refresh = true; return; }
      if (cal.checkSign !== st.signedToday) throw Error('签到状态正在变化，请刷新核对');
      if (!st.enabled || st.signedToday) { refresh = true; return; }
      remember(cal.today); submitted = true;
      const award = await s.sign();
      if (!s.active()) return;
      forget();
      notice.value = `签到成功，获得 ${award.point} 积分${award.exp > 0 ? `、${award.exp} 经验` : ''}`;
      uni.showToast({ title: '签到成功', icon: 'success' }); refresh = true;
    } catch (e) {
      if (!s.active()) return;
      if (submitted) {
        if (!retry && e instanceof RequestError && e.status === 400 && (e.httpStatus ?? 200) < 500) {
          forget(); notice.value = e.message; // Definitive business rejection, including another device signing first.
        } else notice.value = '签到结果未确认，可能已经生效，正在读取记录核对。';
        refresh = true;
      } else notice.value = e instanceof Error ? e.message : '签到状态读取失败，请刷新重试';
    } finally {
      if (active(id)) { writing.value = false; release(s); if (refresh) await load(); }
      else release(s);
    }
  }
  function doSign() { return signAction(false); }
  function retryUnknown() { return signAction(true); }
  async function setRemind(enabled: boolean) {
    if (typeof enabled !== 'boolean' || blocked.value || config.value?.signRemindSwitch !== 1 || enabled === (config.value.signRemindStatus === 1)) return;
    const id = epoch, s = scope(id); writing.value = true; notice.value = '';
    try {
      await s.remind(enabled);
      if (!s.active()) return;
      const c = await s.config();
      if (!s.active()) return;
      if (c.signRemindStatus !== Number(enabled)) throw Error('提醒设置已变化，请刷新核对');
      config.value = c; notice.value = enabled ? '已保存签到提醒偏好' : '已关闭签到提醒';
    } catch {
      if (!s.active()) return;
      notice.value = '提醒设置结果未确认，已重新读取；请核对开关状态。';
      try { const c = await s.config(); if (s.active()) config.value = c; }
      catch { if (s.active()) error.value = '提醒设置读取失败，请刷新后再操作'; }
    } finally { if (active(id)) { writing.value = false; reminderVersion.value++; } release(s); }
  }
  async function showCalendar() {
    if (!loaded.value || loading.value || writing.value || !visible.value) return;
    calendarOpen.value = true;
    if (calendar.value) await loadCalendar(calendar.value.month);
  }
  function closeCalendar() { calendarOpen.value = false; calendarEpoch++; calendarLoading.value = false; }
  async function loadCalendar(month: string) {
    if (!calendarOpen.value || !visible.value || !loggedIn.value || writing.value) return;
    const request = ++calendarEpoch, id = epoch, s = scope(id); calendarLoading.value = true; calendarError.value = '';
    try { const result = await s.calendar(month); if (s.active() && request === calendarEpoch && calendarOpen.value) calendar.value = result; }
    catch (e) { if (s.active() && request === calendarEpoch) calendarError.value = e instanceof Error ? e.message : '日历读取失败'; }
    finally { if (active(id) && request === calendarEpoch) calendarLoading.value = false; release(s); }
  }
  async function changeMonth(delta: number) {
    if (calendarLoading.value || !calendar.value) return;
    try { await loadCalendar(moveSignMonth(calendar.value.month, delta)); } catch { calendarError.value = '可查看 1970 年至 2037 年的日历'; }
  }
  function history() { if (visible.value && loggedIn.value && !writing.value) uni.navigateTo({ url: '/pages/user/signRecords' }); }
  function login() { if (visible.value && !loggedIn.value) uni.navigateTo({ url: '/pages/auth/login' }); }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { clear(); }, { flush: 'sync' });
  onShow(() => { visible.value = true; void load(); });
  onHide(() => { visible.value = false; clear(); });
  onUnload(() => { disposed = true; visible.value = false; clear(); });
  return { config, status, calendar, recent, points, loading, writing, loaded, error, notice, pendingDay, loggedIn, blocked, canSign, canRetry, buttonText,
    reminderVersion, calendarOpen, calendarLoading, calendarError, load, doSign, retryUnknown, setRemind, showCalendar, closeCalendar, loadCalendar, changeMonth, history, login };
}
