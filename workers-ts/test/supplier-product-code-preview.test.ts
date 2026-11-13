import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
afterEach(()=>vi.unstubAllGlobals());
it('the actual preview API persists product code intent and ignores read metadata during unrelated saves',async()=>{
  vi.stubGlobal('window',{location:{search:'?preview=1'}});
  const root=resolve(import.meta.dirname,'../../view/supplier-ts');
  const bundle=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:"export {previewMode,getProductDetail,saveProduct} from './src/api/supplier';"},alias:{'@':resolve(root,'src')},define:{'import.meta.env.DEV':'true','import.meta.env.VITE_API_BASE_URL':'"/supplierapi"'},bundle:true,write:false,platform:'browser',format:'esm'});
  const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  expect(api.previewMode).toBe(true);let detail=await api.getProductDetail(71);expect(detail.code_selection).toEqual({version:1,code:'',erp_open:false});
  await api.saveProduct(71,{...detail,code:' PREVIEW-ERP '});detail=await api.getProductDetail(71);expect(detail.code_selection.code).toBe('PREVIEW-ERP');expect(detail).not.toHaveProperty('code');
  await api.saveProduct(71,{...detail,store_name:'unrelated preview edit',code_selection:{version:1,code:'forged',erp_open:true}});detail=await api.getProductDetail(71);expect(detail.code_selection).toEqual({version:1,code:'PREVIEW-ERP',erp_open:false});
  await expect(api.saveProduct(71,{...detail,code:'x'.repeat(51)})).rejects.toThrow();expect((await api.getProductDetail(71)).code_selection.code).toBe('PREVIEW-ERP');
  await api.saveProduct(71,{...detail,code:''});expect((await api.getProductDetail(71)).code_selection.code).toBe('');
});

it('the actual preview copy inherits the source product code and replay keeps the original copy after source edits',async()=>{
  vi.stubGlobal('window',{location:{search:'?preview=1'}});
  const root=resolve(import.meta.dirname,'../../view/supplier-ts');
  const bundle=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:"export {getProductDetail,saveProduct} from './src/api/supplier';export {getProductCopySeed,saveProductCopy,productCopyPayload} from './src/api/productCopy';"},alias:{'@':resolve(root,'src')},define:{'import.meta.env.DEV':'true','import.meta.env.VITE_API_BASE_URL':'\"/supplierapi\"'},bundle:true,write:false,platform:'browser',format:'esm'});
  const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  let source=await api.getProductDetail(71);await api.saveProduct(71,{...source,code:'PREVIEW-SOURCE-CODE'});
  const seed=await api.getProductCopySeed(71,7),pending={actor_id:21,supplier_id:7,source_id:71,operation_id:crypto.randomUUID()},payload=api.productCopyPayload(seed.product);
  expect(payload).not.toHaveProperty('code');expect(payload).not.toHaveProperty('code_selection');const receipt=await api.saveProductCopy(pending,seed.copy,payload);expect((await api.getProductDetail(receipt.result.id)).code_selection.code).toBe('PREVIEW-SOURCE-CODE');
  source=await api.getProductDetail(71);await api.saveProduct(71,{...source,code:'SOURCE-AFTER-COPY'});expect(await api.saveProductCopy(pending,seed.copy,payload)).toEqual(receipt);expect((await api.getProductDetail(receipt.result.id)).code_selection.code).toBe('PREVIEW-SOURCE-CODE');
});
