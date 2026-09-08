import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiCombinationSelection } from '@/api/combination';
import { apiCartAdd } from '@/api/order';
import { RequestError } from '@/utils/request';
import { combinationId as parseId, combinationOpen, combinationCartInput, combinationCheckoutQuery,
  combinationGroup, combinationGroupOpen, type CombinationSelection, type CombinationGroup } from '../../../common/combinationPurchase';

export function useCombinationPurchase() {
  const auth = useAuthStore(), combinationId = ref(0), selectedGroup = ref(0), visible = ref(false);
  const detail = shallowRef<CombinationSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1);
  const loading = ref(false), buying = ref(false), navigating = ref(false), error = ref(''), prepared = ref<number | null>(null), clock = ref(Date.now());
  let generation = 0, navigationRevision = 0, pageRevision = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined;
  let loginSelection: { id: number; unique: string; quantity: number; pinkId: number } | null = null;
  const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
  const open = computed(() => !!detail.value && combinationOpen(detail.value, clock.value));
  const groups = computed(() => detail.value ? [...detail.value.groups,
    ...(detail.value.requested_group && !detail.value.groups.some(g => g.id === detail.value!.requested_group!.id) ? [detail.value.requested_group] : [])] : []);
  const groupAvailable = (group: CombinationGroup) => combinationGroupOpen(group, clock.value);
  const selectedGroupAvailable = computed(() => {
    if (!selectedGroup.value) return true;
    const group = detail.value && combinationGroup(detail.value, selectedGroup.value);
    return !!group && groupAvailable(group);
  });
  const locked = computed(() => buying.value || navigating.value || prepared.value !== null);
  const canBuy = computed(() => visible.value && !loading.value && !buying.value && !navigating.value && (prepared.value !== null ||
    open.value && selectedGroupAvailable.value && !!selectedSku.value && typeof quantity.value === 'number' &&
    Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
  function reset() {
    generation++; navigationRevision++; navigating.value = false;
    detail.value = null; selected.value = ''; quantity.value = 1; prepared.value = null; loading.value = false;
  }
  function choose(key: string) {
    if (!visible.value || locked.value || loading.value || !detail.value?.skus.some(sku => sku.unique === key && sku.max_quantity > 0)) return;
    selected.value = key; quantity.value = 1; error.value = '';
  }
  function chooseGroup(id: number) {
    if (!visible.value || locked.value || loading.value || !detail.value) return;
    if (id !== 0) { const group = combinationGroup(detail.value, id); if (!group || !groupAvailable(group)) return; }
    selectedGroup.value = id; error.value = '';
  }
  async function discardGroup() {
    if (!visible.value || locked.value || loading.value) return;
    selectedGroup.value = 0; loginSelection = null; await load();
  }
  async function load() {
    if (!visible.value || !combinationId.value || disposed || navigating.value || prepared.value !== null) return;
    const current = ++generation;
    detail.value = null; selected.value = ''; quantity.value = 1; error.value = ''; loading.value = true;
    try {
      const result = await apiCombinationSelection(combinationId.value, selectedGroup.value);
      if (current !== generation || !visible.value || disposed) return;
      detail.value = result;
      const resume = loginSelection; loginSelection = null;
      if (resume?.id === result.combination_id && resume.pinkId === selectedGroup.value) {
        const sku = result.skus.find(sku => sku.unique === resume.unique && sku.max_quantity > 0);
        if (sku) {
          selected.value = sku.unique; quantity.value = resume.quantity;
          if (resume.quantity > sku.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
        } else error.value = '原规格已失效，请重新选择';
      }
      if (!selectedGroupAvailable.value) error.value = '原指定团已不可参加，请明确重新选择';
    } catch (e) { if (current === generation && visible.value) error.value = e instanceof Error ? e.message : '拼团规格加载失败'; }
    finally { if (current === generation && visible.value) loading.value = false; }
  }
  function navigate(url: string, onFailure: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== generation || revision !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false; onFailure();
    };
    // Native success may precede onHide; keep the gate until the lifecycle reset.
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function goCheckout(id: number) {
    const query = combinationCheckoutQuery(id, combinationId.value, selectedGroup.value);
    const encoded = Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    navigate(`/pages/order/confirm?${encoded}`, () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; });
  }
  async function purchase() {
    if (!canBuy.value) return;
    if (!auth.isLoggedIn) {
      loginSelection = { id: combinationId.value, unique: selected.value, quantity: Number(quantity.value), pinkId: selectedGroup.value };
      navigate('/pages/auth/login', () => { loginSelection = null; error.value = '登录页面打开失败，请重试'; }); return;
    }
    const current = generation, page = pageRevision;
    if (prepared.value !== null) { goCheckout(prepared.value); return; }
    if (!detail.value) return;
    const identityVersion = auth.sessionVersion;
    const submitted = { id: combinationId.value, unique: selected.value, quantity: Number(quantity.value), pinkId: selectedGroup.value };
    buying.value = true; error.value = '';
    try {
      const input = combinationCartInput(detail.value, submitted.unique, submitted.quantity, submitted.pinkId);
      const result = await apiCartAdd(input);
      if (current !== generation || !visible.value || disposed) return;
      if (!Number.isSafeInteger(result.id) || result.id < 1) throw new Error('购买记录响应无效，请刷新活动');
      prepared.value = result.id; goCheckout(result.id);
    } catch (e) {
      if (e instanceof RequestError && e.status !== undefined && [410000, 410001, 410002].includes(e.status) &&
        !disposed && page === pageRevision && !auth.isLoggedIn && auth.sessionVersion === identityVersion + 1 && combinationId.value === submitted.id) {
        loginSelection = submitted;
      }
      if (current === generation && visible.value) {
        detail.value = null; selected.value = '';
        error.value = e instanceof Error ? e.message : '加购失败，请刷新活动重新确认';
      }
    } finally { buying.value = false; }
  }
  function suspend() { visible.value = false; reset(); if (timer) { clearInterval(timer); timer = undefined; } }
  watch(() => auth.sessionVersion, () => {
    if (visible.value) loginSelection = null;
    reset(); error.value = '登录状态已变化，请刷新活动';
  }, { flush: 'sync' });
  onLoad(query => {
    reset(); pageRevision++; loginSelection = null; combinationId.value = 0; selectedGroup.value = 0;
    // This historical URL carries a pink record, not an activity. Until its
    // status contract is restored, never accidentally purchase a same-ID activity.
    if (query?.pinkRecordId !== undefined) { error.value = '旧拼团状态链接尚未迁移，请从拼团列表重新选择活动'; return; }
    try {
      const id = parseId(query?.id), pinkId = query?.pinkId === undefined || query.pinkId === '0' ? 0 : parseId(query.pinkId);
      combinationId.value = id; selectedGroup.value = pinkId; error.value = '';
    } catch { error.value = '拼团活动或团长标识无效，请返回活动列表'; }
  });
  onShow(() => {
    if (disposed) return;
    visible.value = true; clock.value = Date.now();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { clock.value = Date.now(); }, 1000); void load();
  });
  onHide(suspend);
  onUnload(() => { disposed = true; pageRevision++; loginSelection = null; suspend(); });
  return { combinationId, selectedGroup, groups, groupAvailable, selectedGroupAvailable, visible, detail, selected, quantity,
    loading, buying, navigating, error, prepared, selectedSku, open, locked, canBuy, choose, chooseGroup, discardGroup, load, purchase };
}
