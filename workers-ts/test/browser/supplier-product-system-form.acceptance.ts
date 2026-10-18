/** Production Supplier form binding UI, actual App/JWT and owned PG16.
 * Customer checkout is independently covered by the native file, never claimed
 * by this browser fixture. No answer collection or order creation occurs here. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import { storeProduct, storeProductRule, systemFormData } from '@/models/schema';
import { loadActiveOrderSystemForm } from '@/services/order/OrderSystemFormService';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { supplierProductSystemFormsFixture } from '../helpers/supplierProductSystemForms';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned system form writer'); return wiring.container;
} }));
type StateRows = Record<string, Array<{ row: Record<string, any> }>>;
type Held = { phase: 'route' | 'session'; index: number; deliver: () => void; destroyed: () => boolean };
it('selects and previews real system forms, saves and rereads twice, closes under one injected catalog failure and rejects route/session late responses without editing historical answers', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierProductSystemFormsFixture(), app = createApp(), control = '/__supplier_product_system_form_fixture/' + randomUUID();
  const dialect = new PgDialect(), definition = getTableConfig(storeProductRule), columns = definition.columns.map(column => {
    const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
    return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
  });
  await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  await f.db.insert(systemFormData).values({ id: 900, uid: 999, systemFormId: '71', type: 1, relationId: 900, value: '[{"value":"OWNED-PRIVATE-HISTORICAL-ANSWER"}]' });
  const snapshot = async (): Promise<StateRows> => ({ ...await f.snapshot(), [definition.name]: await f.exec(`SELECT to_jsonb(t) AS row FROM public."${definition.name}" t ORDER BY to_jsonb(t)::text`) as unknown as StateRows[string] });
  const baseline = await snapshot(), initialSequences = await f.sequences(), paths: any[] = [], held: Held[] = [], releaseAttempts: any[] = [], bindingChecks: any[] = [];
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  let origin = '', chain = Promise.resolve(), armHold = false, heldCount = 0, sessionChanges = 0, failCatalog = false, catalogFailures = 0, finished = false, outbound = 0, role: unknown;
  let finish!: () => void, fail!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const product = (state: StateRows) => state.store_product.find(item => item.row.id === 80)!.row;
  const state = () => ({ finished, catalogFailures, heldCount, sessionChanges, releaseAttempts, paths, role, bindingChecks, outbound,
    tables: Object.keys(baseline).length, sequences: initialSequences.length, customer_checkout_in_browser: false });
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (res.destroyed) return; res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Supplier留言PG16本机验收</title><h1>商品自定义留言编辑与回读</h1><p>仅本机合成商品；真实Supplier选择保存与预览，不创建顾客订单，不改历史答案。</p><button id="enter">进入商品编辑</button><button id="fail_catalog">让下次留言目录失败</button><button id="hold">扣留下一留言目录</button><button id="other">切换只读合成账号</button><button id="restore">恢复管理合成账号</button><button id="release">释放已扣留目录</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
      function session(manager=true){localStorage.setItem('supplier-token',manager?tokens.manager:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manager?21:22,supplier_id:7,supplier_name:'本机留言供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manager?['supplier.product.view','supplier.product.manage']:['supplier.product.view']));}
      document.getElementById('enter').onclick=()=>{session();location.href='/products/80/edit';};
      for(const action of ['fail_catalog','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(false);if(action==='restore')session();};</script>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await chain;
      if (path.endsWith('/fail_catalog')) { expect(catalogFailures).toBe(0); expect(paths.filter(row => row.method === 'POST')).toHaveLength(2); expect(failCatalog).toBe(false); failCatalog = true; }
      if (path.endsWith('/hold')) { expect(paths.filter(row => row.method === 'POST')).toHaveLength(3); expect(heldCount).toBeLessThan(2); expect(held).toHaveLength(0); expect(armHold).toBe(false); armHold = true; }
      if (path.endsWith('/other')) { expect(heldCount).toBe(2); expect(held).toHaveLength(1); expect(sessionChanges).toBe(0); sessionChanges++; }
      if (path.endsWith('/restore')) { expect(sessionChanges).toBe(1); sessionChanges++; }
      if (path.endsWith('/release')) {
        expect(held).toHaveLength(1); const item = held.shift()!;
        if (item.phase === 'route') { expect(sessionChanges).toBe(0); expect(paths.slice(item.index).some(row => row.method === 'GET' && row.path === '/supplierapi/product/product/list')).toBe(true); }
        else expect(sessionChanges).toBe(2);
        const destroyed = item.destroyed(); releaseAttempts.push({ phase: item.phase, socket_destroyed: destroyed }); expect(destroyed).toBe(true); item.deliver();
      }
      if (path.endsWith('/finish')) {
        expect(catalogFailures).toBe(1); expect(failCatalog).toBe(false); expect(heldCount).toBe(2); expect(armHold).toBe(false); expect(held).toHaveLength(0); expect(sessionChanges).toBe(2); expect(outbound).toBe(0);
        expect(releaseAttempts).toEqual([{phase:'route',socket_destroyed:true},{phase:'session',socket_destroyed:true}]);
        const writes = paths.filter(row => row.method === 'POST'); expect(writes).toHaveLength(3); expect(writes.map(row => row.body.system_form_id)).toEqual([401,71,0]);
        for (const row of writes) for (const key of ['system_form_selection','custom_form','system_form_data','specs_id','specs','specs_selection','ensure_id','ensure_selection','brand_id','brand_selection','brand_com','auto_on_time','auto_off_time','store_label_id','label_id']) expect(row.body).not.toHaveProperty(key);
        expect(paths.some(row => row.path === '/api/get_script' && row.status === 200)).toBe(true);
        const edits = paths.filter(row => row.method === 'GET' && row.path === '/supplierapi/product/product/80');
        for (const id of [401,71]) expect(edits.some(row => row.binding.system_form_id === id && row.binding.system_form_selection.available)).toBe(true);
        expect(edits.at(-1).binding).toEqual({system_form_id:0,system_form_selection:{system_form_id:0,available:true}});
        const previews = paths.filter(row => row.preview);
        expect(previews.some(row => row.preview.id === 401 && row.preview.value[0].titleConfig.value === '收件补充信息' && row.preview.value[0].titleShow.val === true)).toBe(true);
        expect(previews.some(row => row.preview.id === 71 && row.preview.value[0].titleConfig.value === '原有必填项目' && row.preview.value[0].titleShow.val === true)).toBe(true);
        expect(bindingChecks).toEqual([{system_form_id:401,definition_id:401},{system_form_id:71,definition_id:71},{system_form_id:0,definition_id:null}]);
        const after = await snapshot(), sequences = await f.sequences();
        expect(product(after)).toEqual({...product(baseline),system_form_id:0,is_show:0,is_verify:0});
        const allowed = new Set(['store_product','store_product_attr','store_product_attr_result','store_product_attr_value','store_product_relation','store_product_description','store_product_stock_record','store_cart']);
        for (const name of Object.keys(baseline)) if (!allowed.has(name)) expect(after[name],name).toEqual(baseline[name]);
        for (const name of allowed) expect(after[name].filter(item=>(name==='store_product'?item.row.id:item.row.product_id)!==80),name).toEqual(baseline[name].filter(item=>(name==='store_product'?item.row.id:item.row.product_id)!==80));
        expect(after.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1)).toEqual(baseline.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1));
        expect(after.system_form_data).toEqual(baseline.system_form_data); expect(product(after).custom_form).toBe(product(baseline).custom_form);
        const mutableSequences = new Set(['store_product_attr_id_seq','store_product_attr_result_id_seq','store_product_attr_value_id_seq','store_product_relation_id_seq','store_product_stock_record_id_seq']);
        expect(sequences.filter(item=>!mutableSequences.has(item.name))).toEqual(initialSequences.filter(item=>!mutableSequences.has(item.name)));
        finished = true; await writeFile('/tmp/cinashop-supplier-product-system-form-browser-result.json',JSON.stringify({...state(),baseline,final:after,initial_sequences:initialSequences,final_sequences:sequences},null,2)+'\n');
      }
      send(res,JSON.stringify(state()),200,'application/json'); if(finished)finish(); return;
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(method==='GET'||method==='POST'&&path==='/supplierapi/product/product/80',method+' '+path).toBe(true);
      const info = /^\/supplierapi\/form\/info\/(?:71|401)$/.test(path);
      expect(info||['/api/get_script','/supplierapi/product/category/tree','/supplierapi/product/product/get_rule','/supplierapi/product/product_label','/supplierapi/product/product/list','/supplierapi/product/product/80','/supplierapi/product/brand/cascader_list/2','/supplierapi/product/all_ensure','/supplierapi/product/all_specs','/supplierapi/form/all_system_form'].includes(path),method+' '+path).toBe(true);
      let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
      let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},hold:Held['phase']|undefined;
      try {
        const before=await snapshot(),sequences=await f.sequences();let input:Record<string,unknown>|undefined;
        if(method==='POST'){const chunks:Buffer[]=[];let total=0;for await(const part of req){const chunk=Buffer.from(part);total+=chunk.length;expect(total).toBeLessThan(1024*1024);chunks.push(chunk);}input=JSON.parse(Buffer.concat(chunks).toString());}
        const injected=path==='/supplierapi/form/all_system_form'&&failCatalog;
        if(injected){failCatalog=false;catalogFailures++;status=503;bytes=Buffer.from(JSON.stringify({status:503,msg:'本机验收主动注入留言目录暂不可用',data:null}));headers={'Content-Type':'application/json','Cache-Control':'private, no-store'};}
        else {const response=await app.request(path+url.search,{method,headers:{...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})},env);bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);}
        const envelope=path.startsWith('/supplierapi/')?JSON.parse(bytes.toString()):undefined;
        if (method==='GET'&&path.endsWith('/80')) { expect(envelope.data).not.toHaveProperty('custom_form'); expect(bytes.toString()).not.toContain('OWNED-PRIVATE-HISTORICAL-ANSWER'); }
        paths.push({path,method,status,envelope:envelope?.status,...(injected?{injected_fault:true}:{}),...(input?{body:input}:{}),
          ...(path.endsWith('/80')&&method==='GET'?{binding:{system_form_id:envelope?.data.system_form_id,system_form_selection:envelope?.data.system_form_selection}}:{}),
          ...(info?{preview:{id:envelope.data.info.id,name:envelope.data.info.name,value:envelope.data.info.value}}:{})});
        expect(status,method+' '+path).toBe(injected?503:200);if(envelope)expect(envelope.status).toBe(injected?503:200);
        if(method==='GET'){
          expect(await snapshot()).toEqual(before);expect(await f.sequences()).toEqual(sequences);
          if(path==='/supplierapi/form/all_system_form'&&armHold){armHold=false;heldCount++;hold=heldCount===1?'route':'session';}
        } else {
          expect(envelope.data).toMatchObject({id:80,is_show:0,is_verify:0});const after=await snapshot();expect(product(after)).toEqual({...product(before),system_form_id:input!.system_form_id,is_show:0,is_verify:0});
          const [actual]=await f.db.select().from(storeProduct).where(eq(storeProduct.id,80));if(!actual)throw Error('Missing actual persisted system form product');
          const checkBefore=await snapshot(),checkSequences=await f.sequences(),selected=actual.systemFormId>0?await loadActiveOrderSystemForm(f.db,actual.systemFormId):undefined;
          bindingChecks.push({system_form_id:actual.systemFormId,definition_id:selected?.id??null});expect(await snapshot()).toEqual(checkBefore);expect(await f.sequences()).toEqual(checkSequences);
          expect(after.system_form).toEqual(baseline.system_form);expect(after.system_form_data).toEqual(baseline.system_form_data);
          expect(after.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1)).toEqual(baseline.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1));
        }
      } finally {release();}
      const deliver=()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}};if(hold)held.push({phase:hold,index:paths.length,deliver,destroyed:()=>res.destroyed});else deliver();return;
    }
    if(path==='/favicon.ico')return send(res,'',204);
    if(path==='/owned-media/schedule.png')return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="15" y="84">OWNED SYSTEM FORM</text></svg>',200,'image/svg+xml');
    const target=resolve(root,'.'+path),candidate=target.startsWith(root+sep)?target:'';
    try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}send(res,await readFile(resolve(root,'index.html')));
  })().catch(cause=>{fail(cause instanceof Error?cause:Error(String(cause)));if(!res.headersSent)send(res,'Owned system form acceptance assertion failed',500);else res.destroy();});});
  const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Owned system form fixture forbids backend provider fetch');});
  try {await f.withWriter(async writer=>{
    await f.exec(`GRANT SELECT ON public.store_product_rule,public.store_product_label TO "${writer.role}"`);wiring.container=writer.container;
    const [rights]=await writer.db.execute(sql`SELECT current_user AS role,has_table_privilege(current_user,'public.system_form','SELECT') AS template_select,
      has_column_privilege(current_user,'public.system_form','id','UPDATE') AS template_lock,has_column_privilege(current_user,'public.system_form','value','UPDATE') AS template_edit,
      has_table_privilege(current_user,'public.system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);role=rights;expect(rights).toMatchObject({template_select:true,template_lock:true,template_edit:false,answers_access:false});
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned system form origin');origin=`http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_SYSTEM_FORM_BROWSER_READY '+JSON.stringify({control:origin+control,editor:origin+'/products/80/edit',products:origin+'/products'})+'\n');
    deadline=setTimeout(()=>fail(Error('Supplier system form Browser finish not received')),15*60_000);await completion;process.stdout.write('SUPPLIER_SYSTEM_FORM_BROWSER_RESULT '+JSON.stringify(state())+'\n');
  });}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},16*60_000);
