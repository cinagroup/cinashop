/** Production Supplier SKU batch UI plus real App/JWT and independent PG16.
 * Native tests separately prove actual Customer order creation. This host
 * captures actual HTTP/DB evidence; CUA supplies the visible interaction proof. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import { storeProductRule, systemAttachmentCategory, systemAttachment, systemRole } from '@/models/schema';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { supplierSkuBatchFixture } from '../helpers/supplierSkuBatch';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned SKU batch writer'); return wiring.container;
} }));
type Row = Record<string, any>;
type StateRows = Record<string, Array<{ row: Row }>>;
type Held = { phase: 'route' | 'session'; index: number; deliver: () => void; destroyed: () => boolean };
it('applies seven fields to two physical SKUs then one exact dimension intersection, saves and rereads while preserving identities and rejecting late image responses across route and session changes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierSkuBatchFixture(), app = createApp(), control = '/__supplier_sku_batch_fixture/' + randomUUID(), dialect = new PgDialect();
  const extras = [storeProductRule, systemAttachmentCategory];
  for (const table of extras) {
    const definition = getTableConfig(table), columns = definition.columns.map(column => {
      const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`;
    });
    await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  }
  // Browser-only display metadata and the existing attachment-read capability;
  // no frozen native helper or production permission definition is changed.
  await f.db.update(systemRole).set({ rules:'supplier.product.view,supplier.product.manage,supplier.attachment.view' }).where(eq(systemRole.id,21));
  await f.db.update(systemAttachment).set({realName:'本机批量图片'}).where(eq(systemAttachment.attId,31));
  const snapshot = async (): Promise<StateRows> => {
    const state = { ...await f.snapshot() } as StateRows;
    for (const table of extras) {
      const name=getTableConfig(table).name;
      state[name]=await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`) as unknown as StateRows[string];
    }
    return state;
  };
  const baseline=await snapshot(), initialSequences=await f.sequences(), paths:Row[]=[], held:Held[]=[], releaseAttempts:Row[]=[], checkpoints:Row[]=[];
  const committed:StateRows[]=[], committedSequences:Array<Awaited<ReturnType<typeof f.sequences>>>=[];
  const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?'':null,put:async()=>{},delete:async()=>{}}} as unknown as Env;
  let origin='',chain=Promise.resolve(),armHold=false,heldCount=0,sessionChanges=0,finished=false,outbound=0,role:unknown;
  let finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
  const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
  const product=(state:StateRows)=>state.store_product.find(item=>item.row.id===80)!.row;
  const writes=()=>paths.filter(row=>row.method==='POST');
  // These snapshots use to_jsonb, whose numeric columns decode as JSON numbers;
  // the ordinary editor API independently returns its mature decimal strings.
  const expectedSku=(row:Row,stage:number):Row=>row.product_id!==80||row.is_retired===1?row:{...row,
    ...(row.suk.startsWith('红,')?{image:'/api/assets/31',settle_price:7.65,stock:20,bar_code:'BATCH-BARCODE',code:'BATCH-CODE',
      weight:1.2,volume:0.35,sum_stock:row.sum_stock+20-row.stock}:{}),...(stage===2&&row.suk==='蓝,M'?{code:'BLUE-M-SECOND'}:{})};
  function assertSaved(state:StateRows,stage:number) {
    expect(product(state)).toEqual({...product(baseline),stock:56,settle_price:7.65,is_show:0,is_verify:0});
    const actual=[...state.store_product_attr_value].sort((a,b)=>a.row.id-b.row.id);
    expect(actual).toEqual(baseline.store_product_attr_value.map(entry=>({row:expectedSku(entry.row,stage)})).sort((a,b)=>a.row.id-b.row.id));
    const allowed=new Set(['store_product','store_product_attr','store_product_attr_result','store_product_attr_value','store_product_relation','store_product_description','store_product_stock_record','store_cart']);
    for(const name of Object.keys(baseline))if(!allowed.has(name))expect(state[name],name).toEqual(baseline[name]);
    for(const name of allowed)expect(state[name].filter(item=>(name==='store_product'?item.row.id:item.row.product_id)!==80),name)
      .toEqual(baseline[name].filter(item=>(name==='store_product'?item.row.id:item.row.product_id)!==80));
    expect(state.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1))
      .toEqual(baseline.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1));
    const beforeLedgers=new Set(baseline.store_product_stock_record.map(entry=>entry.row.id));
    expect(state.store_product_stock_record.filter(entry=>beforeLedgers.has(entry.row.id))).toEqual(baseline.store_product_stock_record);
    expect(state.store_product_stock_record.filter(entry=>!beforeLedgers.has(entry.row.id)).map(entry=>({unique:entry.row.unique,number:entry.row.number,pm:entry.row.pm,cost_price:entry.row.cost_price})).sort((a,b)=>a.unique.localeCompare(b.unique)))
      .toEqual([{unique:'sbtred01',number:17,pm:1,cost_price:4.03},{unique:'sbtred02',number:15,pm:1,cost_price:5.03}]);
  }
  const state=()=>({finished,heldCount,sessionChanges,releaseAttempts,checkpoints,paths,role,outbound,
    tables:Object.keys(baseline).length,sequences:initialSequences.length,saves:writes().length,
    local_object_reads:f.objectReads,customer_checkout_in_browser:false});
  function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8') {
    if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
  }
  const server=createServer((req,res)=>{void(async()=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
    const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
    if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Supplier SKU批量PG16本机验收</title><h1>多SKU批量填充与真实保存回读</h1><p>仅本机合成商品；生产Supplier界面、真实JWT与独立LOGIN，不创建顾客订单。完整步骤见控制页下方。</p>
      <button id="enter">进入商品编辑</button><button id="before_save">核对首次未保存草稿</button><button id="skip">核对0与空值未保存</button><button id="second_draft">核对第二次未保存</button><button id="hold">扣留下一图片目录</button><button id="other">切换只读合成账号</button><button id="restore">恢复管理合成账号</button><button id="release">释放已扣留目录</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button>
      <ol><li>编辑80：批量规格颜色选红，尺码留空，匹配2/4；结算7.65、库存20、条码BATCH-BARCODE、编号BATCH-CODE、重量1.2、体积0.35；选择批量图片→本机批量图片→使用所选图片；应用到匹配SKU。核对首次未保存草稿，再保存商品。</li><li>重新进入并查看表格；批量数值填0、文本留空，应用应提示不会修改。核对0与空值未保存。</li><li>颜色改蓝、尺码选M，编号BLUE-M-SECOND，其余空或0。应用仅蓝M；清空批量填写后匹配恢复4/4、表格蓝M编号仍保留。核对第二次未保存，再保存商品并重新进入回读。</li><li>扣留下一图片目录→编辑页选择批量图片→关闭弹窗并返回商品列表→释放。再进入编辑，扣留下一图片目录→选择批量图片→控制页切只读再恢复→释放；旧编辑页应失效，重新进入后无迟到选择。</li><li>读取验收状态，完成并关闭夹具。</li></ol><pre></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
      function session(manager=true){localStorage.setItem('supplier-token',manager?tokens.manager:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manager?21:22,supplier_id:7,supplier_name:'本机SKU批量供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manager?['supplier.product.view','supplier.product.manage','supplier.attachment.view']:['supplier.product.view']));}
      document.getElementById('enter').onclick=()=>{session();location.href='/products/80/edit';};
      for(const action of ['before_save','skip','second_draft','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(false);if(action==='restore')session();};</script>`);
    if(path.startsWith(control+'/')) {
      expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
      const action=path.slice(control.length+1);
      if(['before_save','skip','second_draft'].includes(action)) {
        const count=action==='before_save'?0:1;expect(writes()).toHaveLength(count);
        expect(await snapshot()).toEqual(count?committed[0]:baseline);expect(await f.sequences()).toEqual(count?committedSequences[0]:initialSequences);
        if(!checkpoints.some(row=>row.action===action))checkpoints.push({action,saves:count,database_unchanged:true});
      }
      if(action==='hold'){expect(writes()).toHaveLength(2);expect(heldCount).toBeLessThan(2);expect(held).toHaveLength(0);expect(armHold).toBe(false);armHold=true;}
      if(action==='other'){expect(heldCount).toBe(2);expect(held).toHaveLength(1);expect(sessionChanges).toBe(0);sessionChanges++;}
      if(action==='restore'){expect(sessionChanges).toBe(1);sessionChanges++;}
      if(action==='release') {
        expect(held).toHaveLength(1);const item=held.shift()!;
        if(item.phase==='route'){expect(sessionChanges).toBe(0);expect(paths.slice(item.index).some(row=>row.path==='/supplierapi/product/product/list')).toBe(true);}
        else expect(sessionChanges).toBe(2);
        const destroyed=item.destroyed();releaseAttempts.push({phase:item.phase,socket_destroyed:destroyed});expect(destroyed).toBe(true);item.deliver();
      }
      if(action==='finish') {
        expect(writes()).toHaveLength(2);expect(checkpoints.map(row=>row.action)).toEqual(['before_save','skip','second_draft']);
        expect(heldCount).toBe(2);expect(held).toHaveLength(0);expect(armHold).toBe(false);expect(sessionChanges).toBe(2);expect(outbound).toBe(0);
        expect(releaseAttempts).toEqual([{phase:'route',socket_destroyed:true},{phase:'session',socket_destroyed:true}]);
        expect(paths.some(row=>row.path==='/api/get_script'&&row.status===200)).toBe(true);
        expect(paths.some(row=>row.path==='/supplierapi/file/file'&&row.images?.includes(31))).toBe(true);
        expect(paths.some(row=>row.path==='/api/assets/31'&&row.status===200)).toBe(true);
        const reads=paths.filter(row=>row.path==='/supplierapi/product/product/80'&&row.method==='GET');
        expect(reads.some(row=>row.saved_stage===1)).toBe(true);expect(reads.at(-1)?.saved_stage).toBe(2);
        const after=await snapshot();assertSaved(after,2);
        const sequences=await f.sequences(),mutableSequences=new Set(['store_product_attr_id_seq','store_product_attr_result_id_seq','store_product_relation_id_seq','store_product_stock_record_id_seq']);
        expect(sequences.filter(item=>!mutableSequences.has(item.name))).toEqual(initialSequences.filter(item=>!mutableSequences.has(item.name)));
        finished=true;await writeFile('/tmp/cinashop-supplier-sku-batch-browser-result.json',JSON.stringify({...state(),baseline,final:after,initial_sequences:initialSequences,final_sequences:sequences},null,2)+'\n');
      }
      send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
    }
    if(path.startsWith('/supplierapi/')||path==='/api/get_script'||path.startsWith('/api/assets/')) {
      expect(method==='GET'||method==='POST'&&path==='/supplierapi/product/product/80',method+' '+path).toBe(true);
      const asset=/^\/api\/assets\/31$/.test(path);
      expect(asset||['/api/get_script','/supplierapi/product/category/tree','/supplierapi/product/product/get_rule','/supplierapi/product/product_label',
        '/supplierapi/product/product/list','/supplierapi/product/product/80','/supplierapi/product/brand/cascader_list/2','/supplierapi/product/all_ensure',
        '/supplierapi/product/all_specs','/supplierapi/form/all_system_form','/supplierapi/form/info/71','/supplierapi/file/file','/supplierapi/file/category'].includes(path),method+' '+path).toBe(true);
      let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
      let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},hold:Held['phase']|undefined;
      try {
        const before=await snapshot(),sequences=await f.sequences();let input:Row|undefined;
        if(method==='POST'){const chunks:Buffer[]=[];let total=0;for await(const part of req){const chunk=Buffer.from(part);total+=chunk.length;expect(total).toBeLessThan(1024*1024);chunks.push(chunk);}input=JSON.parse(Buffer.concat(chunks).toString());}
        const response=await app.request(path+url.search,{method,headers:{...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})},env);
        bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);
        const envelope=path.startsWith('/supplierapi/')?JSON.parse(bytes.toString()):undefined;
        const entry:Row={path,method,status,envelope:envelope?.status,...(input?{body:input}:{})};
        expect(status,method+' '+path).toBe(200);if(envelope)expect(envelope.status,method+' '+path).toBe(200);
        if(method==='GET') {
          expect(await snapshot()).toEqual(before);expect(await f.sequences()).toEqual(sequences);
          if(path.endsWith('/80')) {
            expect(envelope.data).not.toHaveProperty('custom_form');expect(bytes.toString()).not.toContain('UNCHANGED-CUSTOMER-ANSWER');
            expect(envelope.data.attrs.map((row:Row)=>row.id)).toEqual([8001,8002,8003,8004]);expect(envelope.data.retired_attrs).toHaveLength(1);
            entry.saved_stage=writes().length;entry.skus=envelope.data.attrs;
            if(entry.saved_stage>0)assertSaved(await snapshot(),entry.saved_stage);
          }
          if(path==='/supplierapi/file/file'){entry.images=envelope.data.list.map((row:Row)=>row.att_id);expect(entry.images.every((id:number)=>id===31)).toBe(true);
            if(armHold){armHold=false;heldCount++;hold=heldCount===1?'route':'session';}}
        } else {
          const stage=writes().length+1;expect(stage).toBeLessThanOrEqual(2);expect(envelope.data).toMatchObject({id:80,is_show:0,is_verify:0});
          expect(input!.product_type).toBe(0);expect(input!.spec_type).toBe(1);expect(input!.attrs).toHaveLength(4);
          for(const key of ['system_form_id','system_form_selection','custom_form','system_form_data','specs_id','specs','specs_selection','ensure_id','ensure_selection','brand_id','brand_selection','brand_com','auto_on_time','auto_off_time','store_label_id','label_id'])expect(input).not.toHaveProperty(key);
          const after=await snapshot();assertSaved(after,stage);committed.push(after);committedSequences.push(await f.sequences());
        }
        paths.push(entry);
      } finally {release();}
      const deliver=()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}};
      if(hold)held.push({phase:hold,index:paths.length,deliver,destroyed:()=>res.destroyed});else deliver();return;
    }
    if(path==='/favicon.ico')return send(res,'',204);
    if(path.startsWith('/owned-media/'))return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="12" y="84">OWNED SKU IMAGE</text></svg>',200,'image/svg+xml');
    const target=resolve(root,'.'+path),candidate=target.startsWith(root+sep)?target:'';
    try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
    send(res,await readFile(resolve(root,'index.html')));
  })().catch(cause=>{fail(cause instanceof Error?cause:Error(String(cause)));if(!res.headersSent)send(res,'Owned SKU batch acceptance assertion failed',500);else res.destroy();});});
  const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Owned SKU batch fixture forbids backend provider fetch');});
  try {await f.withWriter(async writer=>{
    await f.exec(`GRANT SELECT ON public.store_product_rule,public.system_attachment_category,public.store_product_label TO "${writer.role}"`);wiring.container=writer.container;
    const [rights]=await writer.db.execute(sql`SELECT current_user AS role,current_user=session_user AS independent,
      has_column_privilege(current_user,'public.system_attachment','att_id','UPDATE') AS attachment_lock,
      has_column_privilege(current_user,'public.system_attachment','real_name','UPDATE') AS attachment_edit,
      has_table_privilege(current_user,'public.system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
    role=rights;expect(rights).toMatchObject({independent:true,attachment_lock:true,attachment_edit:false,answers_access:false});
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned SKU batch origin');origin=`http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_SKU_BATCH_BROWSER_READY '+JSON.stringify({control:origin+control,editor:origin+'/products/80/edit',products:origin+'/products'})+'\n');
    deadline=setTimeout(()=>fail(Error('Supplier SKU batch Browser finish not received')),15*60_000);await completion;
    process.stdout.write('SUPPLIER_SKU_BATCH_BROWSER_RESULT '+JSON.stringify(state())+'\n');
  });}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},16*60_000);
