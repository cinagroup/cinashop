import { describe, expect, it } from 'vitest';
import { ADMIN_LEGACY_PRODUCT_FIELDS, readAdminLegacyProductBody } from '@/services/admin/AdminLegacyProductInput';
import { prepareProductEditorCopySave, prepareProductEditorSave, productEditorOperationId } from '@/services/admin/AdminProductEditorReceipt';
import { editorProduct } from './helpers/adminProductEditor';
import { legacySaveActor } from './helpers/adminLegacyProductSave';

const operation = '785c158f-05d6-428b-a7e6-fba5fc5843fd';
describe('complete editor request identity and bounded projection', () => {
  it('accepts the independently authored full59 contract and binds the raw request to actor, target and key', () => {
    const actor = legacySaveActor(), product = editorProduct(), envelope = { operation_id: operation, product };
    expect(Object.keys(product).sort()).toEqual([...ADMIN_LEGACY_PRODUCT_FIELDS].sort());
    const original = prepareProductEditorSave(envelope, 0, actor, 'local-test-key');
    expect(original.product).toBe(product); expect(original.intent.requestHash).toMatch(/^[a-f0-9]{64}$/);
    const reordered = Object.fromEntries(Object.entries(product).reverse());
    expect(prepareProductEditorSave({ product: reordered, operation_id: operation }, 0, actor, 'local-test-key').intent).toEqual(original.intent);
    for (const changed of [
      prepareProductEditorSave(envelope, 1, actor, 'local-test-key'),
      prepareProductEditorSave(envelope, 0, { ...actor, id: 2 }, 'local-test-key'),
      prepareProductEditorSave(envelope, 0, actor, 'other-local-key'),
      prepareProductEditorSave({ ...envelope, product: editorProduct({ store_name: 'changed' }) }, 0, actor, 'local-test-key'),
    ]) expect(changed.intent.requestHash).not.toBe(original.intent.requestHash);
  });
  it('refuses unknown, missing and trusted import context fields before any SQL', () => {
    const actor = legacySaveActor();
    const missing = editorProduct(); delete missing.attrs;
    for (const product of [missing, editorProduct({ relation_id: 2 }), editorProduct({ type: 1 }), editorProduct({ soure_link: 'https://source.local' }), editorProduct({ tao_words: 'token' })])
      expect(() => prepareProductEditorSave({ operation_id: operation, product }, 0, actor, 'local-test-key')).toThrow();
    expect(() => prepareProductEditorSave({ operation_id: operation, product: editorProduct(), extra: 1 }, 0, actor, 'local-test-key')).toThrow();
    for (const key of [operation.toUpperCase(), 'x', operation.replace('-4', '-3')]) expect(() => productEditorOperationId(key)).toThrow();
  });
  it('bounds direct cyclic inputs and rejects duplicate JSON keys at the actual reader', async () => {
    const product = editorProduct(); product.custom_form = product;
    expect(() => prepareProductEditorSave({ operation_id: operation, product }, 0, legacySaveActor(), 'local-test-key')).toThrow('有限JSON');
    await expect(readAdminLegacyProductBody(new Request('https://editor.local', { method: 'POST', body: '{"operation_id":"a","operation_id":"b"}' }))).rejects.toThrow();
  });
  it('binds trusted copy intent to source/snapshot and refuses raw identity or delivery material', () => {
    const actor = legacySaveActor(), token = 'a'.repeat(64), product = editorProduct();
    product.attrs = (product.attrs as object[]).map(row=>({...row,disk_info:'',virtual_list:[]}));
    const envelope = {operation_id:operation,copy_token:token,product};
    const copy = prepareProductEditorCopySave(envelope,17,actor,'local-test-key');
    expect(copy.intent.copy).toEqual({sourceId:17,token}); expect(copy.intent.requestedId).toBe(0);
    const ordinary = prepareProductEditorSave({operation_id:operation,product},0,actor,'local-test-key');
    for(const changed of [ordinary,prepareProductEditorCopySave(envelope,18,actor,'local-test-key'),
      prepareProductEditorCopySave({...envelope,copy_token:'b'.repeat(64)},17,actor,'local-test-key')])
      expect(changed.intent.requestHash).not.toBe(copy.intent.requestHash);
    for(const attrs of [{unique:'old-id'},{id:1},{disk_info:'fixed content'},{virtual_list:[{card_no:'do not copy'}]}])
      expect(()=>prepareProductEditorCopySave({...envelope,product:{...product,attrs:[{...(product.attrs as object[])[0],...attrs}]}},17,actor,'local-test-key')).toThrow('复制不能携带');
    expect(()=>prepareProductEditorCopySave({...envelope,product:{...product,product_type:1}},17,actor,'local-test-key')).toThrow('卡密库存');
    expect(()=>prepareProductEditorCopySave({...envelope,product:{...product,product_type:'1'}},17,actor,'local-test-key')).toThrow('数字枚举');
    expect(()=>prepareProductEditorCopySave(envelope,0,actor,'local-test-key')).toThrow('来源ID');
    expect(()=>prepareProductEditorSave(envelope,0,actor,'local-test-key')).toThrow();
  });
});
