import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { RequestError } from '@/utils/request';
import { createCustomerCashierImageRequests, CUSTOMER_CASHIER_IMAGES_BASE as base, type CustomerCashierImageRequests } from '@/api/customerWorkCashierImages';
import { customerWorkSha256Bytes } from '../../../common/customerWorkIntent';
import { canReadCustomerCashierAppImage, readCustomerCashierAppImage } from '@/utils/customerCashierAppImageFile';
import { cashierIntentHash, cashierUuid, customerWorkCanonicalJson, customerWorkRequestKey,
  customerCashierPending, isCustomerCashierIntent, parseCustomerCashierReceipt } from '@/utils/customerWorkCashier';
import { customerCashierImagePending, retainCustomerCashierImageStage, releaseCustomerCashierImageStages,
  isCustomerCashierFormContext, isCustomerCashierImageStage, customerCashierImageFieldId, customerCashierImageId,
  parseCustomerCashierSessionReceipt, parseCustomerCashierImageReceipt, parseCustomerCashierPreviews, MAX_CASHIER_IMAGE_BYTES } from '@/utils/customerWorkCashierImages';
import type { CustomerCashierInput, CustomerCashierCreationIntent, CustomerCashierReceipt } from '@/types/customerWorkCashier';
import type { CustomerCashierFormContext, CustomerCashierFormSession, CustomerCashierFormImage,
  CustomerCashierSessionIntent, CustomerCashierImageIntent, CustomerCashierImageStageIntent } from '@/types/customerWorkCashierImages';
import type { CustomerWorkController } from './useCustomerWork';

import type { CustomerCashierCapabilityController } from './useCustomerCashierCapabilities';

const confirm = (title: string, content: string) => new Promise<boolean>(resolve => uni.showModal({ title, content, success: r => resolve(r.confirm), fail: () => resolve(false) }));
const copy = <T>(value: T): T => JSON.parse(customerWorkCanonicalJson(value));
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function mime(bytes: Uint8Array): CustomerCashierFormImage['mime'] {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return 'image/png';
  const head = String.fromCharCode(...bytes.slice(0, 12));
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8,12) === 'WEBP') return 'image/webp';
  throw Error('请选择 JPEG、PNG、WebP 或 GIF 图片');
}
/** Read only the file selected by the native chooser. Temp paths never enter durable storage. */
export async function readCustomerCashierImageFile(path: string): Promise<{ sha256: string; size: number }> {
  let bytes: Uint8Array;
  if (typeof window !== 'undefined' && typeof window.fetch === 'function' && path.startsWith('blob:')) {
    const url = new URL(path); assert(url.origin === window.location.origin, '请选择本机图片');
    const response = await window.fetch(path); assert(response.ok, '无法读取所选图片');
    const blob = await response.blob(); assert(blob.size > 0 && blob.size <= MAX_CASHIER_IMAGE_BYTES, '图片需为 10 MiB 以内的有效文件');
    bytes = new Uint8Array(await blob.arrayBuffer());
  } else if (canReadCustomerCashierAppImage()) {
    bytes = await readCustomerCashierAppImage(path, MAX_CASHIER_IMAGE_BYTES);
  } else {
    assert(typeof uni.getFileInfo === 'function', '当前设备无法核对所选图片大小，请更换设备');
    const info = await new Promise<{size:number}>((resolve, reject) => uni.getFileInfo({filePath:path,
      success:result=>resolve(result),fail:result=>reject(Error(result.errMsg||'无法核对所选图片大小'))}));
    assert(Number.isSafeInteger(info.size) && info.size > 0 && info.size <= MAX_CASHIER_IMAGE_BYTES, '图片需为 10 MiB 以内的有效文件');
    const fs = uni.getFileSystemManager?.(); assert(fs && typeof fs.readFile === 'function', '当前设备无法读取所选图片，请更换设备');
    const data = await new Promise<ArrayBuffer>((resolve, reject) => fs.readFile({ filePath: path,
      success: result => result.data instanceof ArrayBuffer ? resolve(result.data) : reject(Error('图片读取结果不是原始文件')),
      fail: result => reject(Error(result.errMsg || '无法读取所选图片')),
    }));
    bytes = new Uint8Array(data);
    assert(bytes.length === info.size, '所选图片读取时发生变化，请重新选择');
  }
  assert(bytes.length > 0 && bytes.length <= MAX_CASHIER_IMAGE_BYTES, '图片需为 10 MiB 以内的有效文件'); mime(bytes);
  let sha256: string;
  if (globalThis.crypto?.subtle) {
    const input = new ArrayBuffer(bytes.byteLength); new Uint8Array(input).set(bytes);
    sha256 = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input))).map(n => n.toString(16).padStart(2,'0')).join('');
  } else sha256 = customerWorkSha256Bytes(bytes);
  return { sha256, size: bytes.length };
}

export function useCustomerCashierImages(manager: CustomerWorkController, domain: CustomerCashierCapabilityController) {
  const busy = ref(false), error = ref(''), pending = ref<CustomerCashierImageStageIntent[]>([]);
  const sessionIntent = ref<CustomerCashierSessionIntent | null>(null), session = ref<CustomerCashierFormSession | null>(null);
  const images = ref<Record<string, CustomerCashierFormImage>>({}), previews = ref<Record<string, string>>({});
  const checkedImages = ref<Record<string, boolean>>({});
  const requests = new Set<CustomerCashierImageRequests>(); let busyOwner: CustomerCashierImageRequests | null = null; let epoch = 0, disposed = false;
  const current = () => !disposed && manager.current() && manager.auth.isLoggedIn;
  const lease = () => manager.suspendLeaseActive();
  const parentKey = computed(() => sessionIntent.value?.request_key ?? '');
  const recoveredImages = computed(() => {
    const fields: Record<string, string[]> = {};
    for (const image of Object.values(images.value)) if (image.state === 'stored' && image.reference && image.session_key === parentKey.value) {
      (fields[image.field_id] ??= []).push(image.reference);
    }
    return fields;
  });
  const outstanding = computed(() => pending.value.some(v => v.kind === 'image' && v.body.session_key === parentKey.value && images.value[v.request_key]?.state !== 'stored'));
  function refreshPending() { if (!current()) { pending.value = []; return; }
    try { pending.value = customerCashierImagePending().filter(v => v.actor_uid === manager.auth.uid); }
    catch (failure) { pending.value = []; error.value = failure instanceof Error ? failure.message : '请保留原图片编号核对'; }
  }
  function clear() { epoch++; busyOwner = null; for (const r of requests) r.abort(); requests.clear(); busy.value = false; error.value = ''; session.value = null; sessionIntent.value = null; images.value = {}; checkedImages.value = {}; previews.value = {}; pending.value = []; }
  function scope(fenced = false) { const version = epoch, fence = fenced ? manager.fence() : () => true, capability = fenced ? domain.fence() : () => true;
    const r = createCustomerCashierImageRequests(() => current() && epoch === version && fence() && capability()); requests.add(r); return r; }
  function beginBusy(r: CustomerCashierImageRequests) { busyOwner = r; busy.value = true; }
  function finishBusy(r: CustomerCashierImageRequests) { if (busyOwner === r) { busyOwner = null; busy.value = false; } }
  function close(r: CustomerCashierImageRequests) { r.abort(); requests.delete(r); }
  function known(intent: CustomerCashierImageStageIntent) {
    assert(current() && intent.actor_uid === manager.auth.uid && isCustomerCashierImageStage(intent)
      && customerCashierImagePending().some(v => v.request_key === intent.request_key && customerWorkCanonicalJson(v) === customerWorkCanonicalJson(intent)), '本机原图片内容或当前账号已变化');
  }
  function writable(intent: CustomerCashierSessionIntent) {
    known(intent); const context = domain.authority();
    assert(context?.data.capabilities.cashier_second_card === true && domain.imagesReady.value && context.scope_key === intent.body.scope_key
      && context.principal.service_id === intent.service_id, '原图片经营资格已变化，只能核对原编号或取消创建前准备');
  }
  function failed(r: CustomerCashierImageRequests, failure: unknown) {
    if (!r.active()) return; error.value = failure instanceof Error ? failure.message : '图片结果未确认，请查询原编号'; refreshPending();
    if (failure instanceof RequestError && (failure.httpStatus === 403 || [410000,410001,410002].includes(Number(failure.status)))) manager.invalidate(Error('当前图片收银资格已变化，请保留原编号核对'));
  }
  function invalid(message: string): never { manager.invalidate(Error(message)); throw Error(message); }
  function acceptSession(value: unknown, intent: CustomerCashierSessionIntent) {
    let response; try { response = parseCustomerCashierSessionReceipt(value, intent); } catch { invalid('原图片准备回执无法核对'); }
    sessionIntent.value = intent; session.value = response.receipt; previews.value = {};
    if (response.receipt?.state === 'cancelled' || response.receipt?.state === 'consumed') {
      if (response.receipt.state === 'consumed') {
        const financial = customerCashierPending().find(v => v.kind === 'creation' && v.request_key === intent.request_key);
        if (financial && financial.request_hash !== response.receipt.frozen_request_hash) invalid('原图片消费与下单内容不匹配');
      }
      const keys = customerCashierImagePending().filter(v => v.actor_uid === intent.actor_uid && (v.request_key === intent.request_key || v.kind === 'image' && v.body.session_key === intent.request_key)).map(v => v.request_key);
      releaseCustomerCashierImageStages(keys); refreshPending();
    }
    return response;
  }
  async function querySession(r: CustomerCashierImageRequests, intent: CustomerCashierSessionIntent) {
    known(intent); const raw = await r.request(`${base}/form-sessions/${intent.request_key}`);
    assert(r.active(), '原图片账号或页面已变化'); known(intent); return acceptSession(raw, intent);
  }
  async function queryImage(r: CustomerCashierImageRequests, intent: CustomerCashierImageIntent) {
    known(intent); const raw = await r.request(`${base}/form-images/${intent.request_key}`); assert(r.active(), '原图片账号或页面已变化'); known(intent);
    let response; try { response = parseCustomerCashierImageReceipt(raw, intent, session.value ?? undefined); } catch { invalid('原图片保存回执无法核对'); }
    checkedImages.value = { ...checkedImages.value, [intent.request_key]: true };
    if (response.receipt) images.value = { ...images.value, [intent.request_key]: response.receipt };
    else { const next = { ...images.value }, old = next[intent.request_key]; delete next[intent.request_key]; images.value = next;
      if (old?.reference) { const urls = { ...previews.value }; delete urls[old.reference]; previews.value = urls; } }
    return response;
  }
  async function ensureSession(contextValue: CustomerCashierFormContext): Promise<CustomerCashierFormSession | null> {
    if (!current() || busy.value) return null; const r = scope(true); beginBusy(r); error.value = '';
    try {
      const context = copy(contextValue); assert(isCustomerCashierFormContext(context), '图片购买人与选品无效'); refreshPending();
      let intent = pending.value.find((v): v is CustomerCashierSessionIntent => v.kind === 'session' && customerWorkCanonicalJson(v.body) === customerWorkCanonicalJson(context));
      if (!intent) {
        assert(!pending.value.length, '还有原图片准备未核对，请先查询或取消');
        assert(!customerCashierPending().some(v => v.actor_uid === r.owner.uid), '还有原下单或付款请求，请先核对');
        const permission = domain.authority(); assert(permission?.data.capabilities.cashier_second_card === true
          && domain.imagesReady.value
          && permission.scope_key === context.scope_key, '当前经营账号不能准备图片');
        intent = { version: 'customer-cashier-image-pending-v1', kind: 'session', actor_uid: r.owner.uid,
          service_id: permission.principal.service_id, request_key: await customerWorkRequestKey(), request_hash: cashierIntentHash(context), created_at: Math.floor(Date.now()/1000), body: context };
        assert(r.active(), '页面或账号已变化'); retainCustomerCashierImageStage(intent); refreshPending();
      }
      writable(intent); let receipt = await querySession(r, intent);
      if (!receipt.receipt) {
        writable(intent); assert(r.active(), '原图片能力已变化，请重新读取');
        const raw = await r.request(`${base}/form-sessions`, 'POST', context as unknown as Record<string, unknown>, intent.request_key);
        assert(r.active(), '原图片准备页面已变化'); known(intent); acceptSession(raw, intent); receipt = await querySession(r, intent);
      }
      assert(receipt.receipt?.state === 'active', '原图片准备已取消或已冻结，请查询原下单编号');
      for (const image of customerCashierImagePending().filter((v): v is CustomerCashierImageIntent => v.kind === 'image' && v.actor_uid === intent!.actor_uid && v.body.session_key === intent!.request_key)) await queryImage(r, image);
      return session.value;
    } catch (failure) { failed(r, failure); return null; } finally { finishBusy(r); close(r); }
  }
  async function visibleAfterChoice(version: number, owner: { uid: number; token: string; version: number }) {
    const end = Date.now() + 2000;
    while (!current()) {
      assert(!disposed && epoch === version && lease() && manager.auth.uid === owner.uid && manager.auth.token === owner.token && manager.auth.sessionVersion === owner.version && Date.now() < end, '选图后页面或账号已变化，请核对原图片准备');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async function upload(path: string, index: number): Promise<{ url: string; src?: string }> {
    assert(!busy.value, '图片正在处理，请等待'); const version = epoch;
    const owner = { uid: manager.auth.uid, token: manager.auth.token, version: manager.auth.sessionVersion };
    await visibleAfterChoice(version, owner);
    assert(!busy.value, '图片正在处理，请等待');
    const r = scope(true); beginBusy(r); error.value = '';
    try {
      const intent = sessionIntent.value, original = session.value; assert(intent && original?.state === 'active', '请先核对真实图片准备'); writable(intent);
      assert(!outstanding.value, '原图片结果未确认，请先查询原图片编号');
      const field = original.system_form.value[index]; assert(field, '原图片字段不存在'); const fieldId = customerCashierImageFieldId(field, index);
      const file = await readCustomerCashierImageFile(path); assert(r.active(), '文件读取期间页面或账号已变化'); writable(intent);
      const metadata = { version: 'customer-cashier-form-image-v1' as const, scope_key: intent.body.scope_key, session_key: intent.request_key, field_id: fieldId, ...file };
      const image: CustomerCashierImageIntent = { version: 'customer-cashier-image-pending-v1', kind: 'image', actor_uid: r.owner.uid, service_id: intent.service_id,
        request_key: await customerWorkRequestKey(), request_hash: cashierIntentHash(metadata), created_at: Math.floor(Date.now()/1000), body: metadata };
      assert(r.active(), '原图片页面已变化'); writable(intent); retainCustomerCashierImageStage(image); refreshPending();
      const raw = await r.upload(`${base}/form-sessions/${intent.request_key}/images`, path, metadata, image.request_key); assert(r.active(), '原图片账号已变化');
      try { parseCustomerCashierImageReceipt(raw, image, original); } catch { invalid('原上传响应与图片内容不匹配'); }
      const result = await queryImage(r, image); assert(result.receipt?.state === 'stored' && result.receipt.reference, '原图片尚未核对保存，请查询原编号');
      await previewsFor(r, [result.receipt.reference]); return { url: result.receipt.reference, src: previews.value[result.receipt.reference] };
    } catch (failure) { failed(r, failure); throw failure; } finally { finishBusy(r); close(r); }
  }
  async function previewsFor(r: CustomerCashierImageRequests, references: string[]) {
    const intent = sessionIntent.value; assert(intent && session.value && session.value.state !== 'cancelled', '请先核对原图片准备');
    const raw = await r.request(`${base}/form-sessions/${intent.request_key}/previews`, 'POST', { references }); assert(r.active(), '原图片预览页面已变化');
    try { previews.value = { ...previews.value, ...parseCustomerCashierPreviews(raw, intent.actor_uid, intent.request_key, references) }; }
    catch { invalid('原图片预览与保存引用不匹配'); }
  }
  function canResumeUpload(intent: CustomerCashierImageIntent): boolean {
    try { if (busy.value || !checkedImages.value[intent.request_key] || images.value[intent.request_key]?.state === 'stored'
      || session.value?.state !== 'active' || sessionIntent.value?.request_key !== intent.body.session_key) return false;
      writable(sessionIntent.value); known(intent); return true; } catch { return false; }
  }
  async function resumeUpload(intent: CustomerCashierImageIntent, path: string): Promise<{ url: string; src?: string }> {
    assert(!busy.value, '图片正在处理，请等待'); const version = epoch;
    const owner = { uid: manager.auth.uid, token: manager.auth.token, version: manager.auth.sessionVersion };
    await visibleAfterChoice(version, owner);
    assert(!busy.value, '图片正在处理，请等待');
    const r = scope(true); beginBusy(r); error.value = '';
    try {
      const parent = sessionIntent.value; assert(parent && parent.request_key === intent.body.session_key, '请先核对原图片准备');
      const original = await querySession(r, parent); assert(original.receipt?.state === 'active', '原图片准备已取消或冻结');
      let receipt = await queryImage(r, intent);
      if (receipt.receipt?.state !== 'stored') {
        writable(parent); const file = await readCustomerCashierImageFile(path); assert(r.active(), '原图片读取页面已变化'); known(intent);
        assert(file.sha256 === intent.body.sha256 && file.size === intent.body.size, '所选图片与原文件不同，请重选原图片或取消创建前准备');
        writable(parent); const raw = await r.upload(`${base}/form-sessions/${parent.request_key}/images`, path, intent.body, intent.request_key);
        assert(r.active(), '原图片恢复页面已变化');
        try { parseCustomerCashierImageReceipt(raw, intent, original.receipt); } catch { invalid('恢复图片响应与原内容不匹配'); }
        receipt = await queryImage(r, intent);
      }
      assert(receipt.receipt?.state === 'stored' && receipt.receipt.reference, '原图片尚未核对保存，请保留原编号');
      await previewsFor(r, [receipt.receipt.reference]); return { url: receipt.receipt.reference, src: previews.value[receipt.receipt.reference] };
    } catch (failure) { failed(r, failure); throw failure; } finally { finishBusy(r); close(r); }
  }
  async function refreshPreviews(references?: string[]) {
    if (!current() || busy.value) return; const r = scope(); beginBusy(r);
    try { const refs = references ?? Object.values(images.value).flatMap(v => v.state === 'stored' && v.reference ? [v.reference] : []);
      if (refs.length) await previewsFor(r, [...new Set(refs)]); } catch (failure) { failed(r, failure); } finally { finishBusy(r); close(r); }
  }
  async function check(intent: CustomerCashierImageStageIntent) {
    if (!current() || busy.value) return; const r = scope(); beginBusy(r); error.value = '';
    try { if (intent.kind === 'session') {
      const result = await querySession(r, intent);
      if (result.receipt && result.receipt.state !== 'cancelled' && result.receipt.state !== 'consumed') for (const image of customerCashierImagePending().filter((v): v is CustomerCashierImageIntent => v.kind === 'image' && v.actor_uid === intent.actor_uid && v.body.session_key === intent.request_key)) await queryImage(r, image);
    } else {
      const parent = customerCashierImagePending().find((v): v is CustomerCashierSessionIntent => v.kind === 'session' && v.actor_uid === intent.actor_uid && v.request_key === intent.body.session_key);
      assert(parent, '原图片准备内容需要核对'); await querySession(r, parent);
      if (session.value?.state !== 'cancelled' && session.value?.state !== 'consumed') await queryImage(r, intent);
    }
    } catch (failure) { failed(r, failure); } finally { finishBusy(r); close(r); }
  }
  async function cancelSession() {
    if (!current() || busy.value || !sessionIntent.value) return; const r = scope(); beginBusy(r);
    try { const intent = sessionIntent.value; const receipt = await querySession(r, intent);
      assert(receipt.receipt?.state === 'active', '原准备未确认或已冻结，不能取消下单原意图');
      assert(!customerCashierPending().some(v => v.kind === 'creation' && v.request_key === intent.request_key), '原下单内容已保存，不能取消图片准备');
      if (!await confirm('取消创建前图片准备', '尚未冻结下单内容。确认取消这份图片准备后，其图片不能再用于创建；原上传结果仍保留为记录。') || !r.active()) return;
      known(intent); const raw = await r.request(`${base}/form-sessions/${intent.request_key}/cancel`, 'POST', { version: 'customer-cashier-form-session-v1', scope_key: intent.body.scope_key }, intent.request_key);
      assert(r.active(), '原取消页面已变化'); const result = acceptSession(raw, intent); assert(result.receipt?.state === 'cancelled', '原取消结果尚未确认，请查询原编号');
      images.value = {}; previews.value = {}; error.value = '创建前图片准备已取消，可以重新选择。';
    } catch (failure) { failed(r, failure); } finally { finishBusy(r); close(r); }
  }
  async function assertReadyForFreeze(body: CustomerCashierInput, key: string) {
    assert(!busy.value && cashierUuid(key), '图片尚未完成核对'); const intent = sessionIntent.value, original = session.value;
    assert(intent && original?.state === 'active' && intent.request_key === key, '原图片准备不可用于本次下单'); writable(intent);
    const context: CustomerCashierFormContext = { version: 'customer-cashier-form-session-v1', scope_key: body.scope_key, buyer_uid: body.buyer_uid,
      tourist_key: body.tourist_key, product_id: body.product_id, sku_unique: body.sku_unique, quantity: body.quantity };
    assert(customerWorkCanonicalJson(context) === customerWorkCanonicalJson(intent.body), '原图片购买人与选品已变化，请取消创建前准备');
    const r = scope(true);
    try {
      const verified = await querySession(r, intent); assert(verified.receipt?.state === 'active', '原图片准备已取消或冻结');
      for (const image of customerCashierImagePending().filter((v): v is CustomerCashierImageIntent => v.kind === 'image' && v.actor_uid === intent.actor_uid && v.body.session_key === key)) {
        const result = await queryImage(r, image); assert(result.receipt?.state === 'stored', '还有未确认的原图片，请先查询或取消创建前准备');
      }
      assert(Array.isArray(body.custom_form), '原图片答案无效');
      for (const [index, component] of original.system_form.value.entries()) if (component.name === 'uploadPicture') {
        const answer = (body.custom_form as { id?: unknown; name?: unknown; value?: unknown }[]).find((v, i) => v?.name === component.name && (component.id === undefined ? i === index : v.id === component.id));
        assert(answer && Array.isArray(answer.value) && answer.value.every(v => customerCashierImageId(v)), '图片答案必须使用已核对的原上传引用');
        const fieldId = customerCashierImageFieldId(component, index);
        assert(answer.value.every(reference => Object.values(images.value).some(image => image.session_key === key && image.state === 'stored' && image.field_id === fieldId && image.reference === reference)), '图片答案属于其他字段或准备');
      }
      writable(intent); assert(r.active(), '原图片下单页面已变化');
    } finally { close(r); }
  }
  /** Always read durable storage before a new financial intent, even after a UI refresh. */
  function assertCanPrepare(key?: string) {
    assert(current(), '请在原账号可见页面核对收银');
    const stages = customerCashierImagePending().filter(v => v.actor_uid === manager.auth.uid);
    if (!stages.length) { assert(key === undefined, '原图片准备记录缺失，请保留原编号核对'); return; }
    assert(key && cashierUuid(key) && stages.some(v => v.kind === 'session' && v.request_key === key)
      && stages.every(v => v.kind === 'session' ? v.request_key === key : v.body.session_key === key)
      && sessionIntent.value?.request_key === key && session.value?.state === 'active', '还有原图片准备待核对，不能换新收银编号');
  }
  function markFinancialIntent(intent: CustomerCashierCreationIntent) {
    assert(isCustomerCashierIntent(intent) && intent.kind === 'creation' && intent.request_key === parentKey.value
      && customerCashierPending().some(v => customerWorkCanonicalJson(v) === customerWorkCanonicalJson(intent)), '完整下单内容尚未持久保存');
  }
  /** Financial tombstones release local stages only; original server session/images remain facts. */
  function releaseAbandonedIntent(intent: CustomerCashierCreationIntent, value: CustomerCashierReceipt) {
    assert(current() && manager.auth.uid === intent.actor_uid && isCustomerCashierIntent(intent)
      && customerCashierPending().some(v => customerWorkCanonicalJson(v) === customerWorkCanonicalJson(intent)), '完整原下单内容尚未核对');
    const proof = parseCustomerCashierReceipt(value, intent); assert(proof.abandonment && proof.receipt === null, '原下单永久放弃事实尚未核对');
    const stages = customerCashierImagePending().filter(v => v.actor_uid === intent.actor_uid
      && (v.kind === 'session' ? v.request_key === intent.request_key : v.body.session_key === intent.request_key));
    const parent = stages.find(v => v.kind === 'session');
    if (stages.length) assert(parent?.kind === 'session' && parent.service_id === intent.service_id
      && customerWorkCanonicalJson(parent.body) === customerWorkCanonicalJson({ version: 'customer-cashier-form-session-v1', scope_key: intent.body.scope_key,
        buyer_uid: intent.body.buyer_uid, tourist_key: intent.body.tourist_key, product_id: intent.body.product_id, sku_unique: intent.body.sku_unique, quantity: intent.body.quantity })
      && stages.every(v => v.service_id === intent.service_id), '原图片准备与永久放弃内容不匹配');
    releaseCustomerCashierImageStages(stages.map(v => v.request_key)); refreshPending();
    if (sessionIntent.value?.request_key === intent.request_key) { sessionIntent.value = null; session.value = null; images.value = {}; checkedImages.value = {}; previews.value = {}; }
  }
  onShow(refreshPending);
  onHide(() => { if (lease()) { previews.value = {}; return; } clear(); });
  onUnload(() => { disposed = true; clear(); });
  watch(() => [manager.auth.uid, manager.auth.token, manager.auth.sessionVersion], () => { clear(); refreshPending(); }, { flush: 'sync' });
  watch(() => manager.context.value, (next, prior) => {
    if (prior && (!next || prior.scope_key !== next.scope_key || prior.principal.service_id !== next.principal.service_id || prior.consistency_key !== next.consistency_key)) { clear(); refreshPending(); }
    if (next) refreshPending();
  }, { flush: 'sync' });
  return { busy, error, pending, session, sessionIntent, images, checkedImages, previews, parentKey, recoveredImages, outstanding, current,
    refreshPending, clear, ensureSession, upload, canResumeUpload, resumeUpload, check, cancelSession, refreshPreviews, assertCanPrepare, assertReadyForFreeze, markFinancialIntent, releaseAbandonedIntent };
}
