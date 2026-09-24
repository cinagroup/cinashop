import { computed, ref, watch } from 'vue';
import { onHide, onReachBottom, onShow, onUnload } from '@dcloudio/uni-app';
import { useAdminSession } from '@/stores/adminSession';
import { useAssistedDraft } from '@/stores/assistedDraft';
import { apiAssistedLogin } from '@/api/assistedRecords';
import { apiAssistedBuyers, ASSISTED_SELECTION_PAGE_SIZE, type AssistedBuyer } from '@/api/assistedSelection';
import { offlineKey } from '@/utils/offlinePayment';

export function useAssistedBuyers() {
  const session = useAdminSession(), draft = useAssistedDraft(), visible = ref(false);
  const account = ref(''), password = ref(''), loginBusy = ref(false), loginError = ref('');
  const keyword = ref(''), items = ref<AssistedBuyer[]>([]), loading = ref(false), loaded = ref(false);
  const error = ref(''), selectionError = ref(''), selecting = ref(false), hasMore = ref(false), nextPage = ref(1);
  const canSelect = computed(() => session.authenticated && session.canAssist && session.permissions.includes('product.view'));
  const canRead = computed(() => canSelect.value && session.permissions.includes('user.view'));
  let generation = 0, applied = '';
  function reset() { generation++; items.value = []; loading.value = false; loaded.value = false; error.value = ''; hasMore.value = false; nextPage.value = 1; }
  const current = (epoch: number) => visible.value && generation === epoch;
  async function login() {
    if (!visible.value || loginBusy.value) return;
    const input = { account: account.value.trim(), password: password.value };
    if (!input.account || input.account.length > 64 || !input.password || input.password.length > 256) { loginError.value = '请输入有效的管理员账号和密码'; return; }
    session.clear(); const epoch = generation, version = session.version;
    loginBusy.value = true; loginError.value = ''; password.value = '';
    try {
      const value = await apiAssistedLogin(input.account, input.password);
      if (!current(epoch) || version !== session.version) return;
      session.install(value); draft.checkCheckout(); loginBusy.value = false; await load();
    } catch (e) { if (current(epoch) && version === session.version) loginError.value = message(e); }
    finally { if (current(epoch) && version === session.version) loginBusy.value = false; }
  }
  async function load(append = false) {
    if (!visible.value || !canRead.value || selecting.value) return;
    if (append && (loading.value || !hasMore.value)) return;
    if (!append) { reset(); applied = keyword.value.trim(); }
    const epoch = generation, page = nextPage.value;
    loading.value = true; error.value = '';
    try {
      const rows = await apiAssistedBuyers(page, applied);
      if (!current(epoch)) return;
      if (append && rows.some(row => items.value.some(old => old.uid === row.uid))) throw Error('用户列表已变化，请重新查询');
      items.value = append ? [...items.value, ...rows] : rows;
      loaded.value = true; nextPage.value = page + 1; hasMore.value = rows.length === ASSISTED_SELECTION_PAGE_SIZE && page < 10_000;
    } catch (e) { if (current(epoch)) error.value = message(e); }
    finally { if (current(epoch)) loading.value = false; }
  }
  async function select(uid: number) {
    if (!visible.value || !canSelect.value || selecting.value || draft.pending || draft.needsReview) return;
    if (draft.checkCheckout()) { selectionError.value = '请先恢复原代客订单结果'; return; }
    if (uid !== 0 && (!canRead.value || loading.value || error.value || !items.value.some(row => row.uid === uid && row.active))) return;
    const epoch = generation, version = session.version;
    selecting.value = true; selectionError.value = '';
    try {
      const guest = uid === 0 ? await offlineKey() : '';
      if (!current(epoch) || version !== session.version) return;
      draft.choose(uid, guest); navigateCart();
    } catch (e) { if (current(epoch) && version === session.version) { selectionError.value = message(e); selecting.value = false; } }
  }
  function openCart() {
    if (selecting.value) return;
    navigateCart();
  }
  function navigateCart() {
    if (!visible.value || !draft.current || !draft.scope) return;
    const epoch = generation; selecting.value = true;
    uni.navigateTo({ url: `/pages/behalf/goods_list/index?uid=${draft.scope.uid}`,
      fail: () => { if (current(epoch)) { selecting.value = false; selectionError.value = '页面打开失败，可点击继续当前购物车重试'; } } });
  }
  function logout() { session.clear(); account.value = ''; password.value = ''; loginBusy.value = false; loginError.value = '已清除本机管理员会话；未撤销服务器令牌。'; }
  function suspend() { visible.value = false; password.value = ''; keyword.value = ''; applied = ''; loginBusy.value = false; selecting.value = false; selectionError.value = ''; reset(); }
  watch(() => session.version, () => { reset(); keyword.value = ''; applied = ''; selecting.value = false; selectionError.value = ''; }, { flush: 'sync' });
  onShow(() => { session.ensureFresh(); visible.value = true; draft.checkCheckout(); void load(); }); onHide(suspend); onUnload(suspend);
  onReachBottom(() => { if (!error.value) void load(true); });
  return { session, draft, canRead, canSelect, account, password, loginBusy, loginError, keyword, items, loading, loaded,
    error, selectionError, selecting, hasMore, nextPage, login, logout, load, select, openCart };
}
function message(error: unknown) { return error instanceof Error ? error.message : '代客操作失败，请重试'; }
