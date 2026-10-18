/** Two production bundles, actual App/JWT/minimum LOGINs and one owned PG16.
 * Phone shells are explicit390x844 iframe viewports, not CDP/device emulation.
 * CUA supplies visible interaction; every accepted API read proves zero SQL writes. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import { storeProductRule, systemAttachmentCategory, systemDise, systemAttachment, systemRole, storeProductCategory } from '@/models/schema';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { cloneProductDetailDesign } from '../../../view/common/productDetailDesign';
import { supplierProductRecommendImageFixture } from '../helpers/supplierProductRecommendImage';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, moderator: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned recommendation Browser writer'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.moderator) throw Error('Missing owned recommendation Browser moderator'); return { container: wiring.moderator, close: async () => {} }; },
}));
type Row = Record<string, any>;
type StateRows = Record<string, Array<{ row: Row }>>;
type Held = { phase: 'route' | 'session'; index: number; deliver: () => void; destroyed: () => boolean };

it('selects cancels saves publishes and clears recommendation images through production Supplier and H5 category bundles with real review, bounded public taxonomy and route-session cancellation', async () => {
  const supplierRoot=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');
  const catalogRoot=resolve(import.meta.dirname,'../../../view/uniapp-ts/dist/build/h5');
  expect((await stat(resolve(supplierRoot,'index.html'))).isFile()).toBe(true);
  expect((await stat(resolve(catalogRoot,'index.html'))).isFile()).toBe(true);
  const f=await supplierProductRecommendImageFixture(),app=createApp(),dialect=new PgDialect();
  const control='/__supplier_recommend_image_fixture/'+randomUUID(),extras=[storeProductRule,systemAttachmentCategory,systemDise];
  for(const table of extras){const definition=getTableConfig(table),columns=definition.columns.map(column=>{
    const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
    return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
  });await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);}
  await f.db.insert(systemDise).values([
    {id:1001,templateName:'color_change',type:3,value:'3'},
    {id:1002,templateName:'category',type:3,value:'{"level":2,"index":1}'},
    {id:1003,templateName:'product_detail',type:3,value:JSON.stringify(cloneProductDetailDesign())},
  ]);
  await f.db.insert(storeProductCategory).values({id:100,type:0,relationId:0,level:0,pid:0,path:'',cateName:'本机平台分类'});
  await f.db.update(systemRole).set({rules:'supplier.product.view,supplier.product.manage,supplier.attachment.view'}).where(eq(systemRole.id,21));
  await f.db.update(systemAttachment).set({realName:'本机推荐图片'}).where(eq(systemAttachment.attId,31));
  const snapshot=async():Promise<StateRows>=>{const state={...await f.snapshot()}as StateRows;for(const table of extras){const name=getTableConfig(table).name;state[name]=await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)as unknown as StateRows[string];}return state;};
  const baseline=await snapshot(),initialSequences=await f.sequences();
  const paths:Row[]=[],actions:Row[]=[],checkpoints:Row[]=[],held:Held[]=[],releaseAttempts:Row[]=[],catalogEvidence:Row[]=[],invalidatedEvidence:Row[]=[];
  let supplierOrigin='',catalogOrigin='',chain=Promise.resolve(),finished=false,armHold=false,heldCount=0,sessionChanges=0,outbound=0,saves=0,approvals=0,classifications=0;
  let writer:Container,reader:Container;
  let finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
  const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
  const savedStates:StateRows[]=[],savedSequences:Array<Awaited<ReturnType<typeof f.sequences>>>=[],classifiedStates:StateRows[]=[],approvedStates:StateRows[]=[];
  const roles:Row={};
  const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>({cfg_system_statistics:'',cfg_navigation_open:'0',cfg_product_category_level:'2',cfg_product_video_status:'0'}as Record<string,string>)[key]??null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
  const product=(state:StateRows)=>state.store_product.find(item=>item.row.id===80)!.row;
  const state=()=>({finished,saves,approvals,classifications,heldCount,sessionChanges,checkpoints,releaseAttempts,catalogEvidence,invalidatedEvidence,actions,paths,roles,outbound,
    tables:Object.keys(baseline).length,sequences:initialSequences.length,local_object_reads:f.objectReads,
    phone_viewport:{width:390,height:844,mechanism:'same-origin iframe viewport; no CDP/device emulation'},customer_checkout_in_browser:false});
  async function serial<T>(work:()=>Promise<T>){const before=chain;let release!:()=>void;chain=new Promise<void>(done=>{release=done;});await before;try{return await work();}finally{release();}}
  function assertBusiness(actual:StateRows,reviewed:boolean,classified:boolean){
    const expected={...product(baseline),recommend_image:saves===1?'/api/assets/31':'',is_show:reviewed?1:0,is_verify:reviewed?1:0,
      cate_id:classified?'100':'11',...(approvals?{auto_on_time:0,refusal:''}:{})};
    expect(product(actual)).toEqual(expected);
    // The ordinary image author leaves every SKU, price, stock-ledger, order,
    // answer, description and hidden metadata row unchanged.
    const authored=new Set(['store_product','store_product_attr','store_product_attr_result','store_product_relation','system_log']);
    for(const name of Object.keys(baseline))if(!authored.has(name))expect(actual[name],name).toEqual(baseline[name]);
    expect(actual.store_product.filter(item=>item.row.id!==80)).toEqual(baseline.store_product.filter(item=>item.row.id!==80));
    for(const name of ['store_product_attr','store_product_attr_result','store_product_relation'])expect(actual[name].filter(item=>item.row.product_id!==80),name).toEqual(baseline[name].filter(item=>item.row.product_id!==80));
    const dimensions=(rows:StateRows)=>rows.store_product_attr.filter(item=>item.row.product_id===80).map(item=>{const {id,...row}=item.row;return row;}).sort((a,b)=>a.attr_name.localeCompare(b.attr_name));
    expect(dimensions(actual)).toEqual(dimensions(baseline));
    const originalResult=baseline.store_product_attr_result.filter(item=>item.row.product_id===80),savedResult=actual.store_product_attr_result.filter(item=>item.row.product_id===80);
    expect(originalResult).toHaveLength(1);expect(savedResult).toHaveLength(1);expect(savedResult[0].row.type).toBe(originalResult[0].row.type);
    const originalSnapshot=JSON.parse(originalResult[0].row.result),savedSnapshot=JSON.parse(savedResult[0].row.result);
    expect(savedSnapshot.attr).toEqual(originalSnapshot.attr);expect(savedSnapshot.value).toEqual(originalSnapshot.value.map((entry:Row)=>{const{id,...row}=entry;return row;}));
    expect(savedResult[0].row.change_time).toBeGreaterThanOrEqual(originalResult[0].row.change_time);
    expect(actual.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1)).toEqual(baseline.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type!==1));
    const categories=actual.store_product_relation.filter(item=>item.row.product_id===80&&item.row.type===1);
    expect(categories).toHaveLength(1);expect(categories[0].row).toMatchObject({product_id:80,type:1,relation_id:classified?100:11,relation_pid:0,status:0});
    const oldIds=new Set(baseline.system_log.map(item=>item.row.id));expect(actual.system_log.filter(item=>oldIds.has(item.row.id))).toEqual(baseline.system_log);
    const fresh=actual.system_log.filter(item=>!oldIds.has(item.row.id));expect(fresh).toHaveLength(approvals+classifications);
    expect(fresh.every(item=>item.row.admin_id===101&&['product_moderation','product'].includes(item.row.type))).toBe(true);
    expect(fresh.filter(item=>item.row.type==='product')).toHaveLength(classifications);expect(fresh.filter(item=>item.row.type==='product_moderation')).toHaveLength(approvals);
    expect(JSON.stringify(actual)).not.toContain('signature=');
  }
  function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
    if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
  }
  async function jsonBody(req:IncomingMessage):Promise<Row>{const chunks:Buffer[]=[];let total=0;for await(const part of req){const chunk=Buffer.from(part);total+=chunk.length;expect(total).toBeLessThan(1024*1024);chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
  async function dispatchApp(path:string,search:string,method:string,input:Row|undefined,authorization:string|undefined,surface:'supplier'|'catalog'|'admin'){
    wiring.container=surface==='supplier'?writer:reader;
    const response=await app.request(path+search,{method,headers:{...(authorization?{Authorization:authorization}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})},env);
    const bytes=Buffer.from(await response.arrayBuffer()),headers=Object.fromEntries(response.headers);
    const envelope=path.startsWith('/api/assets/')||path==='/api/get_script'?undefined:JSON.parse(bytes.toString());
    expect(response.status,method+' '+path).toBe(200);if(envelope)expect(envelope.status,method+' '+path).toBe(200);
    const entry:Row={path,search,method,status:response.status,surface,saves,approvals,classifications,envelope:envelope?.status,...(input?{body:input}:{})};
    return{bytes,headers,envelope,entry};
  }
  async function assertPendingPublicVisibility(operation:'before_platform_classification'|'before_admin_review'){
    const before=await snapshot(),sequences=await f.sequences();
    const result=await dispatchApp('/api/products','?ids=80','GET',undefined,undefined,'catalog');
    expect(result.envelope.data.list).toEqual([]);expect(await snapshot()).toEqual(before);expect(await f.sequences()).toEqual(sequences);
    paths.push({...result.entry,operation,products:result.envelope.data.list,sql_read_only:true});
  }
  const supplierReads=new Set(['/supplierapi/product/category/tree','/supplierapi/product/product/get_rule','/supplierapi/product/product_label',
    '/supplierapi/product/product/list','/supplierapi/product/product/80','/supplierapi/product/brand/cascader_list/2','/supplierapi/product/all_ensure',
    '/supplierapi/product/all_specs','/supplierapi/form/all_system_form','/supplierapi/form/info/71','/supplierapi/file/file','/supplierapi/file/category']);
  const catalogReads=new Set(['/api/get_script','/api/category','/api/products','/api/v2/diy/color_change/color_change','/api/v2/diy/product_detail','/api/diy/get_suspended']);
  async function api(req:IncomingMessage,res:ServerResponse,url:URL,surface:'supplier'|'catalog'){
    const path=url.pathname,method=req.method??'GET';expect(method==='GET'||surface==='supplier'&&method==='POST'&&path==='/supplierapi/product/product/80').toBe(true);
    expect(/^\/api\/assets\/31$/.test(path)||surface==='supplier'&&supplierReads.has(path)||catalogReads.has(path)).toBe(true);
    if(surface==='catalog'&&path==='/api/products'){
      expect(url.searchParams.getAll('cid')).toEqual(['100']);
      for(const key of ['sid','tid','ids'])expect(url.searchParams.has(key),`H5 category query excludes ${key}`).toBe(false);
    }
    let delivery!:()=>void;
    await serial(async()=>{
      const before=await snapshot(),sequences=await f.sequences(),input=method==='POST'?await jsonBody(req):undefined;
      const result=await dispatchApp(path,url.search,method,input,req.headers.authorization,surface);
      if(method==='GET'){
        expect(await snapshot()).toEqual(before);expect(await f.sequences()).toEqual(sequences);result.entry.sql_read_only=true;
        if(path==='/supplierapi/product/product/80'){
          expect(result.envelope.data.recommend_image).toBe(saves===1?'/api/assets/31':'');expect(result.envelope.data.attrs.map((row:Row)=>row.id)).toEqual([8001,8002,8003,8004]);
          expect(result.envelope.data.retired_attrs).toHaveLength(1);expect(result.envelope.data).not.toHaveProperty('custom_form');expect(result.bytes.toString()).not.toContain('UNCHANGED-CUSTOMER-ANSWER');
        }
        if(path==='/api/products'){
          const list=result.envelope.data.list;result.entry.products=list;
          if(approvals===saves&&saves>0&&classifications===saves){expect(list).toHaveLength(1);expect(list[0].id).toBe(80);expect(list[0].image).toBe(product(baseline).image);
            if(saves===1)expect(list[0].recommend_image).toMatch(/^\/api\/assets\/31\?expires=[1-9]\d*&signature=[A-Za-z0-9_-]{43}$/);else expect(list[0].recommend_image).toBe('');
          }else expect(list).toEqual([]);
        }
        if(path==='/supplierapi/file/file'){
          result.entry.images=result.envelope.data.list.map((row:Row)=>row.att_id);expect(result.entry.images.every((id:number)=>id===31)).toBe(true);
          if(armHold){armHold=false;heldCount++;const phase=heldCount===1?'route':'session';held.push({phase,index:paths.length+1,deliver:()=>{if(!res.destroyed){res.writeHead(200,result.headers);res.end(result.bytes);}},destroyed:()=>res.destroyed});delivery=()=>{};}
        }
      }else{
        expect(saves).toBeLessThan(2);expect(approvals).toBe(saves);expect(classifications).toBe(saves);
        expect(checkpoints.some(item=>item.action=== (saves===0?'before_save':'before_clear'))).toBe(true);
        expect(input!.recommend_image).toBe(saves===0?'/api/assets/31':'');expect(input!.cate_id).toEqual([11]);expect(input!.attrs).toHaveLength(4);
        for(const key of ['system_form_id','custom_form','system_form_data','specs_id','specs','ensure_id','brand_id','brand_com','auto_on_time','auto_off_time','store_label_id','label_id'])expect(input).not.toHaveProperty(key);
        saves++;assertBusiness(await snapshot(),false,false);savedStates.push(await snapshot());savedSequences.push(await f.sequences());
      }
      paths.push(result.entry);delivery??=()=>{if(!res.destroyed){res.writeHead(200,result.headers);res.end(result.bytes);}};
    });delivery();
  }
  function phoneHtml(kind:'supplier'|'catalog'){
    const frameUrl=kind==='supplier'?supplierOrigin+'/products/80/edit':catalogOrigin+'/#/pages/goods/cate';
    const title=kind==='supplier'?'Supplier 390×844 iframe 仿真':'H5 分类 390×844 iframe 仿真';
    const probe=kind==='catalog'?`const frame=document.querySelector('iframe'),win=frame.contentWindow,doc=frame.contentDocument,card=[...doc.querySelectorAll('.product-card')].find(node=>node.textContent.includes('本机SKU批量商品')),image=card?.querySelector('.product-image'),img=image?.querySelector('img'),box=card?.querySelector('.recommend-image'),rect=(box||image)?.getBoundingClientRect();const data={viewport:{width:win.innerWidth,height:win.innerHeight},layout:doc.querySelector('.cate-page')?.getAttribute('data-layout'),card:!!card,recommendation:!!box,width:rect?.width,height:rect?.height,src:img?.currentSrc||img?.src||image?.getAttribute('src')||'',loaded:!!img?.complete&&img.naturalWidth>0,documentWidth:doc.documentElement.scrollWidth};`:
      `const doc=document.querySelector('iframe').contentDocument,buttons=[...doc.querySelectorAll('button')].filter(node=>node.textContent.includes('保存并提交审核'));const data={saveButtons:buttons.length,allDisabled:buttons.length>0&&buttons.every(node=>node.disabled),identityAlert:doc.body.textContent.includes('登录身份或权限已改变')};`;
    return`<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>固定iframe CSS视口；不是设备仿真，不调用CDP。</p><button id="probe">${kind==='catalog'?'核对实际分类预览':'核对旧编辑页已失效'}</button><a href="${supplierOrigin+control}">返回控制页</a><pre></pre><iframe title="${title}" src="${frameUrl}" style="width:390px;height:844px;border:1px solid #999;display:block"></iframe><script>document.getElementById('probe').onclick=async()=>{${probe}const response=await fetch(${JSON.stringify(control+'/'+(kind==='catalog'?'catalog_evidence':'invalidated_evidence'))},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.querySelector('pre').textContent=await response.text();};</script>`;
  }
  async function controlAction(req:IncomingMessage,res:ServerResponse,url:URL,origin:string){
    expect(req.method).toBe('POST');expect(req.headers.origin).toBe(origin);const action=url.pathname.slice(control.length+1);
    await serial(async()=>{
      if(['cancel','before_save','before_clear'].includes(action)){
        const count=action==='before_clear'?1:0;expect(saves).toBe(count);expect(await snapshot()).toEqual(count?approvedStates[0]:baseline);
        if(count===0)expect(await f.sequences()).toEqual(initialSequences);
        if(!checkpoints.some(item=>item.action===action))checkpoints.push({action,saves:count,database_unchanged:true});
      }else if(action==='classify'){
        expect(saves).toBe(classifications+1);expect(approvals).toBe(classifications);expect(saves).toBeLessThanOrEqual(2);
        await assertPendingPublicVisibility('before_platform_classification');
        const result=await dispatchApp('/adminapi/product/batch_process','', 'POST',{type:1,ids:[80],data:{cate_id:[100]}},'Bearer '+f.adminToken,'admin');
        classifications++;paths.push({...result.entry,operation:'actual_admin_platform_classification'});assertBusiness(await snapshot(),false,true);classifiedStates.push(await snapshot());
      }else if(action==='approve'){
        expect(saves).toBe(approvals+1);expect(classifications).toBe(saves);
        await assertPendingPublicVisibility('before_admin_review');
        const result=await dispatchApp('/adminapi/product/product/set_verify/80','', 'POST',{is_verify:1,is_show:1,refusal:'',auto_on_time:''},'Bearer '+f.adminToken,'admin');
        approvals++;paths.push({...result.entry,operation:'actual_admin_review'});assertBusiness(await snapshot(),true,true);approvedStates.push(await snapshot());
      }else if(action==='catalog_evidence'){
        const evidence=await jsonBody(req);expect(saves).toBe(approvals);expect(saves).toBe(classifications);expect(saves===1||saves===2).toBe(true);
        expect(evidence.viewport).toEqual({width:390,height:844});expect(evidence.layout).toBe('2/1');expect(evidence.card).toBe(true);expect(evidence.loaded).toBe(true);expect(evidence.documentWidth).toBeLessThanOrEqual(391);
        expect(evidence.recommendation).toBe(saves===1);const source=new URL(evidence.src,catalogOrigin);expect(source.origin).toBe(catalogOrigin);expect(source.pathname).toBe(saves===1?'/api/assets/31':product(baseline).image);
        if(saves===1){expect(Math.abs(evidence.width/evidence.height-2.5)).toBeLessThan(0.03);expect(paths.some(item=>item.surface==='catalog'&&item.path==='/api/assets/31'&&item.status===200&&item.approvals===1)).toBe(true);}
        catalogEvidence.push({...evidence,stage:saves,viewport_mechanism:'actual same-origin iframe390x844'});
      }else if(action==='invalidated_evidence'){
        const evidence=await jsonBody(req);expect(sessionChanges).toBe(2);expect(evidence.saveButtons).toBeGreaterThan(0);expect(evidence.allDisabled).toBe(true);expect(evidence.identityAlert).toBe(true);invalidatedEvidence.push(evidence);
      }else if(action==='hold'){expect(saves).toBe(2);expect(approvals).toBe(2);expect(heldCount).toBeLessThan(2);expect(held).toHaveLength(0);expect(armHold).toBe(false);armHold=true;
      }else if(action==='other'){expect(heldCount).toBe(2);expect(held).toHaveLength(1);expect(sessionChanges).toBe(0);sessionChanges++;
      }else if(action==='restore'){expect(sessionChanges).toBe(1);sessionChanges++;
      }else if(action==='release'){
        expect(held).toHaveLength(1);const item=held.shift()!;if(item.phase==='route')expect(paths.slice(item.index).some(row=>row.path==='/supplierapi/product/product/list')).toBe(true);else expect(sessionChanges).toBe(2);
        const destroyed=item.destroyed();expect(destroyed).toBe(true);releaseAttempts.push({phase:item.phase,socket_destroyed:destroyed});item.deliver();
      }else if(action==='finish'){
        expect(saves).toBe(2);expect(approvals).toBe(2);expect(classifications).toBe(2);expect(checkpoints.map(item=>item.action)).toEqual(['cancel','before_save','before_clear']);
        expect(catalogEvidence.some(item=>item.stage===1)).toBe(true);expect(catalogEvidence.some(item=>item.stage===2)).toBe(true);expect(invalidatedEvidence.length).toBeGreaterThan(0);
        expect(heldCount).toBe(2);expect(held).toHaveLength(0);expect(armHold).toBe(false);expect(sessionChanges).toBe(2);expect(outbound).toBe(0);
        expect(releaseAttempts).toEqual([{phase:'route',socket_destroyed:true},{phase:'session',socket_destroyed:true}]);
        expect(paths.filter(item=>item.method==='POST'&&item.surface==='supplier')).toHaveLength(2);expect(paths.filter(item=>item.operation==='actual_admin_review')).toHaveLength(2);expect(paths.filter(item=>item.operation==='actual_admin_platform_classification')).toHaveLength(2);
        for(const stage of [1,2])for(const operation of ['before_platform_classification','before_admin_review'])expect(paths.filter(item=>item.operation===operation&&item.saves===stage&&item.approvals===stage-1&&item.sql_read_only&&item.products.length===0)).toHaveLength(1);
        expect(paths.some(item=>item.path==='/api/get_script'&&item.status===200)).toBe(true);
        const final=await snapshot();assertBusiness(final,true,true);const sequences=await f.sequences();const mutable=new Set(['store_product_attr_id_seq','store_product_attr_result_id_seq','store_product_relation_id_seq','system_log_id_seq']);
        expect(sequences.filter(item=>!mutable.has(item.name))).toEqual(initialSequences.filter(item=>!mutable.has(item.name)));
        finished=true;await writeFile('/tmp/cinashop-supplier-recommend-image-browser-result.json',JSON.stringify({...state(),baseline,final,initial_sequences:initialSequences,final_sequences:sequences,saved_states:savedStates,saved_sequences:savedSequences,classified_states:classifiedStates,approved_states:approvedStates},null,2)+'\n');
      }else expect(action).toBe('status');
      actions.push({action,saves,approvals,classifications});send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();
    });
  }
  function controlHtml(){return`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Supplier推荐图真实PG16验收</title><h1>商品推荐图作者、审核与分类消费</h1><p>实际生产bundle、App/JWT、独立LOGIN；仅本机合成数据。手机使用390×844 iframe视口，不调用CDP。</p>
    <button id="enter">进入商品编辑</button><button id="cancel">核对取消选图零写</button><button id="before_save">核对首次未保存草稿</button><button id="classify">实际Admin归入平台分类</button><button id="approve">实际Admin审核上架</button><button id="before_clear">核对清空未保存</button><button id="hold">扣留下一图片目录</button><button id="other">切换只读合成账号</button><button id="restore">恢复管理合成账号</button><button id="release">释放已扣留目录</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button>
    <p><a href="${supplierOrigin}/phone/supplier" target="_blank">Supplier手机iframe</a> · <a href="${catalogOrigin}/phone/catalog" target="_blank">分类手机iframe与实际预览核对</a> · <a href="${catalogOrigin}/#/pages/goods/cate" target="_blank">分类桌面页</a></p>
    <ol><li>进入编辑80，选择商品推荐图后取消；回控制页click“核对取消选图零写”，等待JSON。重新选本机推荐图片31，使用；click核对首次未保存草稿，等待JSON；保存并提交审核。</li>
    <li>保存后平台分类尚不可见；click实际Admin归入平台分类，再click实际Admin审核上架，分别等待JSON。打开分类手机iframe，待卡片图片加载后click核对实际分类预览，须收到stage1及5:2尺寸。</li>
    <li>重新进入Supplier编辑：Admin已将平台分类改为100，先清除商品分类并重新勾选本供应商分类11；清空商品推荐图。click核对清空未保存并等待JSON，然后保存。再次依序平台分类、审核；刷新分类手机iframe并核对stage2主图回退。</li>
    <li>扣留下一图片目录→编辑页选择商品推荐图→关闭弹窗并返回列表→释放。再次扣留→Supplier手机iframe选择图片→控制页切只读再恢复→释放；手机壳click核对旧编辑页已失效。</li><li>读取状态并完成关闭。每个控制按钮必须click并核实JSON成功，不能以按键是否发出代替回执。</li></ol><pre></pre><script>
    const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
    function session(manager=true){localStorage.setItem('supplier-token',manager?tokens.manager:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manager?21:22,supplier_id:7,supplier_name:'本机推荐图供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manager?['supplier.product.view','supplier.product.manage','supplier.attachment.view']:['supplier.product.view']));}
    document.getElementById('enter').onclick=()=>{session();location.href='/products/80/edit';};
    for(const action of ['cancel','before_save','classify','approve','before_clear','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(false);if(action==='restore')session();};</script>`;}
  function serverFor(surface:'supplier'|'catalog'){
    return createServer((req,res)=>{void(async()=>{
      const origin=surface==='supplier'?supplierOrigin:catalogOrigin;if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
      const url=new URL(req.url??'/',origin),path=url.pathname;
      if(path===control&&req.method==='GET')return send(res,controlHtml());
      if(path.startsWith(control+'/'))return controlAction(req,res,url,origin);
      if(path==='/phone/'+surface)return send(res,phoneHtml(surface));
      if(path.startsWith('/supplierapi/')||path.startsWith('/api/'))return api(req,res,url,surface);
      if(path==='/favicon.ico')return send(res,'',204);
      if(path.startsWith('/owned-media/'))return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="12" y="84">OWNED MAIN IMAGE</text></svg>',200,'image/svg+xml');
      const root=surface==='supplier'?supplierRoot:catalogRoot,target=resolve(root,'.'+path),candidate=target.startsWith(root+sep)?target:'';
      try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA entry */}
      send(res,await readFile(resolve(root,'index.html')));
    })().catch(cause=>{fail(cause instanceof Error?cause:Error(String(cause)));if(!res.headersSent)send(res,'Owned recommendation acceptance assertion failed',500);else res.destroy();});});
  }
  const supplierServer=serverFor('supplier'),catalogServer=serverFor('catalog');
  const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Owned recommendation fixture forbids backend provider fetch');});
  try{await f.withWriter(async supplier=>f.withPublicReader(async publicReader=>f.withModerator(async moderator=>{
    writer=supplier.container;reader=publicReader.container;wiring.moderator=moderator.container;
    await f.exec(`GRANT SELECT ON public.store_product_rule,public.system_attachment_category,public.store_product_label TO "${supplier.role}";
      GRANT SELECT ON public.system_dise TO "${publicReader.role}";
      GRANT SELECT ON public.store_product_category TO "${moderator.role}";
      GRANT UPDATE(id) ON public.store_product_category TO "${moderator.role}";
      GRANT UPDATE(cate_id) ON public.store_product TO "${moderator.role}";
      GRANT INSERT,DELETE ON public.store_product_relation TO "${moderator.role}";
      GRANT USAGE,SELECT ON SEQUENCE public.store_product_relation_id_seq TO "${moderator.role}"`);
    for(const[owner,runtime]of [['supplier',supplier],['public',publicReader],['moderator',moderator]]as const){const[rights]=await runtime.db.execute(sql`SELECT current_user AS role,current_user=session_user AS independent,
      has_column_privilege(current_user,'system_attachment','name','UPDATE') AS attachment_edit,
      has_column_privilege(current_user,'store_product','recommend_image','UPDATE') AS recommendation_edit,
      has_column_privilege(current_user,'store_product_attr_value','price','UPDATE') AS sku_edit,
      has_table_privilege(current_user,'system_admin','UPDATE') AND has_table_privilege(current_user,'system_role','UPDATE')
        AND has_table_privilege(current_user,'store_product_attr_value','UPDATE') AND has_table_privilege(current_user,'store_cart','UPDATE')
        AND has_table_privilege(current_user,'store_product_relation','UPDATE') AS required_table_barriers,
      has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS orders_access,
      has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);expect(rights).toMatchObject({independent:true,attachment_edit:false,orders_access:false,answers_access:false});
      expect(rights).toMatchObject(owner==='moderator'?{recommendation_edit:false,sku_edit:true,required_table_barriers:true}:owner==='public'?{recommendation_edit:false,sku_edit:false}:{recommendation_edit:true,sku_edit:true});roles[owner]=rights;}
    await new Promise<void>(yes=>supplierServer.listen(0,'127.0.0.1',yes));let address=supplierServer.address();if(!address||typeof address==='string')throw Error('Missing Supplier origin');supplierOrigin=`http://127.0.0.1:${address.port}`;
    await new Promise<void>(yes=>catalogServer.listen(0,'127.0.0.1',yes));address=catalogServer.address();if(!address||typeof address==='string')throw Error('Missing H5 origin');catalogOrigin=`http://127.0.0.1:${address.port}`;
    process.stdout.write('SUPPLIER_RECOMMEND_IMAGE_BROWSER_READY '+JSON.stringify({control:supplierOrigin+control,editor:supplierOrigin+'/products/80/edit',products:supplierOrigin+'/products',catalog:catalogOrigin+'/#/pages/goods/cate',phone_supplier:supplierOrigin+'/phone/supplier',phone_catalog:catalogOrigin+'/phone/catalog',iframe_viewport:{width:390,height:844},classification_note:'Two real Admin platform-category mutations are explicit prerequisites, separately counted from2 Supplier saves and2 reviews.'})+'\n');
    deadline=setTimeout(()=>fail(Error('Supplier recommendation Browser finish not received')),20*60_000);await completion;
    process.stdout.write('SUPPLIER_RECOMMEND_IMAGE_BROWSER_RESULT '+JSON.stringify(state())+'\n');
  })));}finally{
    if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;wiring.moderator=undefined;held.length=0;
    for(const server of [supplierServer,catalogServer]){server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));}
    await f.close();
  }
},21*60_000);
