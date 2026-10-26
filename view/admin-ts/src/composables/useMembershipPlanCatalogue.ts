import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiMembershipPlans, apiSaveMembershipPlan, apiSetMembershipPlanStatus, type MembershipPlan } from '@/api/membership';
import { useMembershipPlanOwner } from './useMembershipPlanOwner';

const PAGE_SIZE = 20;
const emptyForm = () => ({ id: 0, type: 'month' as MembershipPlan['type'], title: '', vip_day: 30,
  price: '0.00', pre_price: '0.00', is_label: 0, sort: 0 });

/** Validate the read envelope without narrowing imported plan types or status values. */
export function membershipPlanPage(value: unknown, page: number): { list: MembershipPlan[]; count: number } {
  if (!value || typeof value !== 'object') throw new Error('会员套餐数据格式错误');
  const data = value as { list?: unknown; count?: unknown };
  if (!Number.isSafeInteger(data.count) || Number(data.count) < 0 || !Array.isArray(data.list)) throw new Error('会员套餐数据格式错误');
  const count = Number(data.count), ids = new Set<number>();
  const expected = Math.max(0, Math.min(PAGE_SIZE, count - (page - 1) * PAGE_SIZE));
  if (data.list.length !== expected) throw new Error('会员套餐目录已变化，请刷新');
  for (const row of data.list) {
    if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)
      || !['type', 'title', 'price', 'pre_price'].every(key => typeof row[key] === 'string')
      || !['vip_day', 'sort', 'is_del', 'is_label', 'add_time'].every(key => Number.isSafeInteger(row[key]))) {
      throw new Error('会员套餐数据格式错误');
    }
    ids.add(row.id);
  }
  return { list: data.list as MembershipPlan[], count };
}

export function useMembershipPlanCatalogue() {
  const owner = useMembershipPlanOwner();
  const plans = ref<MembershipPlan[]>([]), planPage = ref(1), planCount = ref(0), planError = ref('');
  const planLoading = ref(false), planSaving = ref(false), statusSavingId = ref(0), planDialog = ref(false);
  const planForm = reactive(emptyForm());
  const canViewPlans = owner.canView, canManagePlans = owner.canManage;
  const planBusy = computed(() => planLoading.value || planSaving.value || statusSavingId.value > 0);
  const activePlanCount = computed(() => plans.value.filter(row => row.is_del === 0).length);
  let mounted = false, generation = 0, controller: AbortController | undefined, editor = 0, editorOwner = '', editorId = 0;
  const current = (stamp: string) => mounted && owner.current(stamp);
  function reset() {
    generation++; controller?.abort(); controller = undefined; editor++; editorOwner = ''; editorId = 0;
    plans.value = []; planCount.value = 0; planPage.value = 1; planError.value = '';
    planLoading.value = false; planSaving.value = false; statusSavingId.value = 0; planDialog.value = false;
    Object.assign(planForm, emptyForm());
  }

  async function loadPlans(page = planPage.value): Promise<boolean> {
    if (!mounted || !owner.has() || !Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE)) return false;
    const stamp = owner.stamp(), ticket = ++generation;
    controller?.abort(); const abort = new AbortController(); controller = abort;
    planLoading.value = true; planError.value = '';
    const valid = () => ticket === generation && current(stamp);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('会员套餐读取超时，请重试')); abort.abort(); }, 12_000);
    });
    const read = async (target: number) => membershipPlanPage(await Promise.race([
      apiMembershipPlans({ page: target, limit: PAGE_SIZE, include_deleted: 1 }, abort.signal), deadline,
    ]), target);
    try {
      let adoptedPage = page, result = await read(page);
      if (!valid() || abort.signal.aborted) return false;
      const lastPage = Math.max(1, Math.ceil(result.count / PAGE_SIZE));
      if (page > lastPage) {
        adoptedPage = lastPage; result = await read(lastPage);
        if (adoptedPage > Math.max(1, Math.ceil(result.count / PAGE_SIZE))) throw new Error('会员套餐目录已变化，请刷新');
      }
      if (!valid() || abort.signal.aborted) return false;
      plans.value = result.list; planCount.value = result.count; planPage.value = adoptedPage;
      return true;
    } catch (error) {
      if (valid()) planError.value = error instanceof Error ? error.message : '会员套餐加载失败';
      return false;
    } finally {
      clearTimeout(timer);
      if (valid()) { planLoading.value = false; if (controller === abort) controller = undefined; }
    }
  }

  const writable = () => owner.has('paid_membership.manage') && !planBusy.value;
  function openPlan(row?: MembershipPlan) {
    if (!writable() || row && !plans.value.includes(row)) return;
    editor++; editorOwner = owner.stamp(); editorId = row?.id ?? 0;
    Object.assign(planForm, row ? { id: row.id, type: row.type, title: row.title, vip_day: row.vip_day,
      price: row.price, pre_price: row.pre_price, is_label: row.is_label, sort: row.sort } : emptyForm());
    planDialog.value = true;
  }
  async function savePlan() {
    if (!planDialog.value || !writable() || !current(editorOwner) || planForm.id !== editorId) return;
    if (!planForm.title.trim()) { ElMessage.warning('请填写套餐名称'); return; }
    const stamp = editorOwner, revision = editor, id = editorId, page = planPage.value;
    const payload = { ...planForm, vip_day: planForm.type === 'ever' ? -1 : planForm.vip_day,
      price: planForm.type === 'free' ? '0.00' : planForm.price, pre_price: planForm.type === 'free' ? '0.00' : planForm.pre_price };
    planSaving.value = true;
    try {
      const result = await apiSaveMembershipPlan(id, payload);
      if (!current(stamp) || revision !== editor || !owner.has('paid_membership.manage')) return;
      if (!Number.isSafeInteger(result.id) || result.id <= 0 || id > 0 && result.id !== id) throw new Error('套餐保存响应异常，请刷新核对');
      planDialog.value = false; ElMessage.success('会员套餐已保存');
      await loadPlans(page);
    } catch (error) {
      if (current(stamp) && revision === editor) ElMessage.error(error instanceof Error ? error.message : '保存结果未确认，请刷新核对');
    } finally { if (current(stamp) && revision === editor) planSaving.value = false; }
  }
  async function togglePlan(row: MembershipPlan, enabled: string | number | boolean) {
    if (!writable() || !plans.value.includes(row) || typeof enabled !== 'boolean') return;
    const stamp = owner.stamp(), id = row.id, target = enabled ? 0 : 1;
    if (row.is_del === target) return;
    statusSavingId.value = id;
    try {
      const result = await apiSetMembershipPlanStatus(id, target);
      if (!current(stamp) || !owner.has('paid_membership.manage')) return;
      if (result.id !== id) throw new Error('套餐状态响应异常，请刷新核对');
      row.is_del = target;
      ElMessage.success(target ? '套餐已停用' : '套餐已启用');
    } catch (error) {
      if (current(stamp)) ElMessage.error(error instanceof Error ? error.message : '状态操作未确认，请刷新核对');
    } finally {
      if (current(stamp)) {
        await loadPlans(planPage.value);
        if (current(stamp)) statusSavingId.value = 0;
      }
    }
  }
  watch(owner.identity, () => { reset(); if (mounted && owner.has()) void loadPlans(1); });
  onMounted(() => { mounted = true; if (owner.has()) void loadPlans(1); });
  onBeforeUnmount(() => { mounted = false; reset(); });
  return { plans, planPage, planCount, planError, planLoading, planSaving, statusSavingId, planDialog, planForm,
    canViewPlans, canManagePlans, planBusy, activePlanCount, loadPlans, openPlan, savePlan, togglePlan };
}
