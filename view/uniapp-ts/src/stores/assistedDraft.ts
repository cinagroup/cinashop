import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useAdminSession } from './adminSession';
import type { AssistedCartScope } from '@/api/assistedSelection';
import { assistedJournal } from '@/utils/assistedIntent';

/** Only IDs and mutation recovery state cross pages, never customer profile
 * PII or shopper credentials. A reload intentionally requires reselection. */
export const useAssistedDraft = defineStore('assisted-draft', () => {
  const admin = useAdminSession(), scope = ref<AssistedCartScope | null>(null), version = ref(0);
  const pending = ref(false), needsReview = ref(false);
  const checkoutLock = ref(false);
  const current = computed(() => !!scope.value && scope.value.adminId === admin.id && admin.authenticated);
  function clear() { version.value++; scope.value = null; pending.value = false; needsReview.value = false; checkoutLock.value = false; }
  function checkCheckout() {
    if (!admin.authenticated) return false;
    try { checkoutLock.value = !!assistedJournal().read(admin.id); }
    catch { checkoutLock.value = true; }
    return checkoutLock.value;
  }
  function choose(uid: number, touristUid = '') {
    if (!admin.authenticated || !admin.canAssist || !admin.permissions.includes('product.view')) throw Error('请先登录具备代客及商品查看权限的管理员');
    if (uid > 0 && !admin.permissions.includes('user.view')) throw Error('当前管理员没有会员查看权限');
    if (checkCheckout()) throw Error('请先恢复本机原代客订单，确认结果后再开始新购物车');
    if (pending.value || needsReview.value) throw Error('请先返回原购物车核对未确认的操作');
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647 || (uid === 0 ? !/^[A-Za-z0-9_-]{1,50}$/.test(touristUid) : touristUid !== '')) throw Error('买家标识无效');
    version.value++; scope.value = { adminId: admin.id, uid, touristUid };
  }
  watch(() => admin.version, clear, { flush: 'sync' });
  return { scope, version, current, pending, needsReview, checkoutLock, checkCheckout, choose, clear };
});
