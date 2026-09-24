import { computed, ref, watch } from 'vue';
import { onHide, onReachBottom, onShow, onUnload } from '@dcloudio/uni-app';
import { useAdminSession } from '@/stores/adminSession';
import { apiAssistedLogin, apiAssistedPaidStatus, apiAssistedRecords, type AssistedRecord } from '@/api/assistedRecords';
import { validAssistedOrderNo } from '@/api/assistedDetail';

export function useAssistedRecords() {
  const session = useAdminSession(), visible = ref(false);
  const account = ref(''), password = ref(''), loginBusy = ref(false), loginError = ref('');
  const keyword = ref(''), status = ref(''), items = ref<AssistedRecord[]>([]);
  const loading = ref(false), loaded = ref(false), error = ref(''), hasMore = ref(false), nextCursor = ref<string | null>('');
  const checking = ref(''), paymentNote = ref('');
  const canRead = computed(() => session.authenticated && session.canAssist);
  let generation = 0, applied = { keyword: '', status: '' };
  const filtersDirty = computed(() => loaded.value && (keyword.value.trim() !== applied.keyword || status.value !== applied.status));
  function reset() {
    generation++; items.value = []; loaded.value = false; loading.value = false; error.value = '';
    hasMore.value = false; nextCursor.value = ''; checking.value = ''; paymentNote.value = '';
  }
  const current = (epoch: number) => visible.value && epoch === generation && canRead.value;
  async function login() {
    if (!visible.value || loginBusy.value) return;
    const input = { account: account.value.trim(), password: password.value };
    if (!input.account || input.account.length > 64 || !input.password || input.password.length > 256) {
      loginError.value = '请输入有效的管理员账号和密码'; return;
    }
    session.clear(); const epoch = generation, version = session.version;
    loginBusy.value = true; loginError.value = ''; password.value = '';
    try {
      const result = await apiAssistedLogin(input.account, input.password);
      if (!visible.value || epoch !== generation || version !== session.version) return;
      session.install(result); loginBusy.value = false;
      if (session.canAssist) await load();
    } catch (e) {
      if (visible.value && epoch === generation && version === session.version) loginError.value = e instanceof Error ? e.message : '管理员登录失败';
    } finally { if (visible.value && epoch === generation && version === session.version) loginBusy.value = false; }
  }
  async function load(append = false) {
    if (!visible.value || !canRead.value) return;
    if (append && (loading.value || !hasMore.value || !!checking.value || filtersDirty.value)) return;
    if (!append) { reset(); applied = { keyword: keyword.value.trim(), status: status.value }; }
    const epoch = generation, cursor = nextCursor.value ?? '';
    loading.value = true; error.value = '';
    try {
      const page = await apiAssistedRecords(cursor, applied.keyword, applied.status), rows = page.items;
      if (!current(epoch)) return;
      if (append && rows.some(row => items.value.some(old => row.id === old.id || row.orderNo === old.orderNo))) throw Error('订单列表已变化，请重新查询');
      items.value = append ? [...items.value, ...rows] : rows;
      loaded.value = true; nextCursor.value = page.nextCursor; hasMore.value = page.hasMore;
    } catch (e) { if (current(epoch)) error.value = e instanceof Error ? e.message : '订单记录加载失败'; }
    finally { if (current(epoch)) loading.value = false; }
  }
  async function checkPayment(orderNo: string) {
    if (!visible.value || !canRead.value || loading.value || error.value || checking.value || !items.value.some(row => row.orderNo === orderNo)) return;
    const epoch = generation; checking.value = orderNo; paymentNote.value = '';
    try {
      const paid = await apiAssistedPaidStatus(orderNo);
      if (!current(epoch)) return;
      // The status endpoint, not a URL or a prior view, is the payment authority.
      paymentNote.value = `${orderNo}：服务器${paid ? '已确认付款' : '尚未确认付款'}。刷新列表查看最新履约状态。`;
    } catch (e) { if (current(epoch)) paymentNote.value = e instanceof Error ? e.message : '付款状态未确认，请重试'; }
    finally { if (current(epoch)) checking.value = ''; }
  }
  function goDetail(orderNo: string) {
    if (!visible.value || !canRead.value || loading.value || error.value || checking.value || !validAssistedOrderNo(orderNo)
      || !items.value.some(row => row.orderNo === orderNo && row.root)) return;
    uni.navigateTo({ url: `/pages/behalf/order_detail/index?orderId=${encodeURIComponent(orderNo)}` });
  }
  function goCashier(orderNo: string) {
    if (!visible.value || !canRead.value || loading.value || error.value || checking.value || !validAssistedOrderNo(orderNo)
      || !items.value.some(row => row.orderNo === orderNo && row.root && !row.paid)) return;
    uni.navigateTo({ url: `/pages/behalf/cashier/index?orderId=${encodeURIComponent(orderNo)}` });
  }
  function logout() {
    session.clear(); account.value = ''; password.value = ''; loginBusy.value = false;
    loginError.value = '已清除本机管理员会话；服务器令牌撤销未执行。';
  }
  function suspend() { visible.value = false; password.value = ''; loginBusy.value = false; reset(); }
  watch(() => session.version, () => reset(), { flush: 'sync' });
  onShow(() => { session.ensureFresh(); visible.value = true; void load(); }); onHide(suspend); onUnload(suspend);
  onReachBottom(() => { if (!error.value && hasMore.value && !filtersDirty.value) void load(true); });
  return { session, canRead, account, password, loginBusy, loginError, keyword, status, items,
    loading, loaded, error, hasMore, nextCursor, filtersDirty, checking, paymentNote, login, logout, load, checkPayment, goDetail, goCashier };
}
