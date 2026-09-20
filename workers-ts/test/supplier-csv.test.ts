import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

let runtime: { downloadLegacyExport: (manifest: unknown) => void }, blob: Blob | undefined, clicks = 0;
beforeAll(async()=>{ const code=await transform(readFileSync('../view/supplier-ts/src/utils/legacy-export.ts','utf8'),{loader:'ts',format:'esm'});
  runtime=await import(`data:text/javascript;base64,${Buffer.from(code.code).toString('base64')}`); });
beforeEach(()=>{
  blob=undefined;clicks=0;
  vi.spyOn(URL,'createObjectURL').mockImplementation(value=>{blob=value;return 'blob:isolated';});
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.stubGlobal('window',{setTimeout:(fn:()=>void)=>{fn();return 1;}});
  vi.stubGlobal('document',{body:{appendChild(){}},createElement:()=>({style:{},click(){clicks++;},remove(){}})});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const manifest=(changes={})=>({header:['订单号','备注'],filekey:['order_id','remark'],export:[{order_id:'LOCAL-25',remark:'本地测试'}],filename:'本地导出',bounded:true,has_more:false,...changes});
it('downloads one BOM CSV with quoted commas and multiline text',async()=>{
  runtime.downloadLegacyExport(manifest({export:[{order_id:'LOCAL-25',remark:'comma, "quote"\nnext'}]}));
  expect(clicks).toBe(1);expect(await blob!.text()).toContain('"comma, ""quote""\nnext"');
  expect(Array.from(new Uint8Array(await blob!.arrayBuffer())).slice(0,3)).toEqual([239,187,191]);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:isolated');
});
it('rejects a truncated page instead of silently downloading it as a complete export',()=>{
  expect(()=>runtime.downloadLegacyExport(manifest({has_more:true}))).toThrow();expect(clicks).toBe(0);expect(blob).toBeUndefined();
});
it.each([null,{header:undefined}, {bounded:false}, {filekey:['order_id','order_id']}, {export:[{order_id:'LOCAL-25',remark:{value:'not a cell'}}]},
  {export:[{order_id:'LOCAL-25',remark:Infinity}]}, {filekey:['order_id','__proto__']}, {export:Array.from({length:1001},()=>({}))}])('rejects invalid manifests before creating a download: case %#',change=>{
  expect(()=>runtime.downloadLegacyExport(change===null?null:manifest(change))).toThrow();expect(clicks).toBe(0);expect(blob).toBeUndefined();
});
it.each(['\u000b=1+1','\u0085@SUM(A1:A2)','\uFEFF+1+1','  -1+1'])('neutralizes formula prefixes behind whitespace/control characters: %s',async value=>{
  runtime.downloadLegacyExport(manifest({export:[{order_id:'LOCAL-25',remark:value}]}));expect(await blob!.text()).toContain(`"'${value}"`);
});
it('supports a valid header-only result',async()=>{
  runtime.downloadLegacyExport(manifest({export:[]}));expect(clicks).toBe(1);expect(await blob!.text()).toBe('"订单号","备注"');
});
