/** CUA-only actual built H5/registered Worker/JWT/owned PG16 acceptance.
 * Page-entry GET detection is measured as a business reconciliation, not a read.
 * QA account bootstrap and pre-baseline website QR generation are explicit setup.
 * No login-form, independent SQL LOGIN ACL, purchase, sign award or invite reward
 * acceptance is claimed. No production API response is replaced. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { and, eq, inArray, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { legacyCache, systemConfig, systemUserLevel, user, userBill, userLevel, userSign } from '@/models/schema';
import { AttachmentService, adminAttachmentScope } from '@/services/system/AttachmentService';
import { LegacyShareCodeService, parseLegacyShareInput } from '@/services/other/LegacyShareCodeService';
import { md5, verifyToken } from '@/utils/jwt';
import { advanceRateWindows, type RateLimitPolicy, type RateWindow } from '@/services/out/OutRateLimitPolicy';
import type { Env } from '@/env';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
  if(!wiring.container)throw Error('Missing owned member overview DB');return wiring.container;
}}));
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex'),digest=(value:unknown)=>hash(stableDiyState(value));
const plans=['current-mobile','next-card','last-card','refreshed','sign-task','sign-returned','order-task','order-returned',
  'invite-task','invite-returned','growth-task','growth-returned','preview','guest','restored','desktop'];
const originalPngs:Record<string,string>={
  'userVip1.png':'e6cc9ddae00eeddce75e13651d7e3c2a41139de36d47b6c59234960ea792a227',
  'userVip2.png':'4e14960268ef3afb1b1778996a604e8e48a0844d8871c2ba3e5659e2e6ec66ae',
  'userVip3.png':'07dc4f46b073cd07b33b1f8358dae13339365d473bf6fb6823dd11b72a6fd453',
  'userVip4.png':'9e84f07624cd2de36834acb19b1c740460541a2edbab1ca8811822800be57d87',
  'user-vip-qd.png':'36359ac217394c09181370327cbd16f910bf908775c8026d2181bf41a5be7e3d',
  'user-vip-gm.png':'8bbeac18d4d9c8c78fec53ebb2e5fabe23c183e569c19d889de5dfacaa978808',
  'user-vip-yq.png':'895cb1709d5b4f789ecf8e5df7007bc23f5f52e72b5958a94b8562ad3c332fbf',
};
async function files(dir:string):Promise<string[]>{return(await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?files(resolve(dir,e.name)):[resolve(dir,e.name)]))).flat().sort();}
async function body(req:IncomingMessage){let size=0;const chunks:Buffer[]=[];try{for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;expect(size).toBeLessThanOrEqual(524288);chunks.push(bytes);}}catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{bytes_consumed:size});}return Buffer.concat(chunks);}

it('built member overview uses real eligibility, platform media and read-only task destinations on owned PG16',async()=>{
  const f=await diyFooterBrowserFixture(),repository=resolve(import.meta.dirname,'../../..'),dist=resolve(repository,'view/uniapp-ts/dist/build/h5');
  const prefix='/tmp/cinashop-customer-level-overview-browser-',origin='http://127.0.0.1:40845',control='/__member/'+randomUUID();
  let server:ReturnType<typeof createServer>|undefined,timer:ReturnType<typeof setTimeout>|undefined,failure:unknown,failedDispatch:Row|null=null;
  const budgetControls:Row[]=[],traces:Row[]=[],evidence:Row[]=[],controls:Row[]=[],staticPaths:Row[]=[],snapshots:Record<string,DiyStateSnapshot>={};
  let expected:DiyStateSnapshot|undefined;
  try{
    // Browser-only missing tables are created from the actual ORM. Discover the
    // complete inventory afterwards, including the nonserial cache primary key.
    const dialect=new PgDialect(),additional:string[]=[];
    for(const table of [userLevel,legacyCache]){const definition=getTableConfig(table);if(f.tables.includes(definition.name))continue;
      const columns=definition.columns.map(column=>{const initial=column.default,initialSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;});
      await f.exec(`create table "${definition.name}" (${columns.join(', ')})`);additional.push(definition.name);
    }
    const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name);
    const sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r=>r.name);
    async function snapshot(){const value:DiyStateSnapshot={};for(const row of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))value[row.name]=row.rows;
      value.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(value);}
    const resources=()=>({puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length,
      objects:digest([...f.objects].map(([key,value])=>({key,type:value.type,bytes:[...value.bytes]}))),queue:vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length});
    const remember=(value:DiyStateSnapshot)=>{const id=digest(value);snapshots[id]??=structuredClone(value);return id;};
    const setupBefore=await snapshot(),setupResourcesBefore=resources();
    // Explicitly synthetic neutral RGBA32x32 fixture, not original PHP card art.
    // Transparent pixels preserve the real page's fallback colours; the two
    // independent platform uploads still exercise canonical ownership/signing.
    const neutralPng=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR4nO3BAQEAAACCIP+vbkhAAQAAAO8GECAAARlDNO4AAAAASUVORK5CYII=','base64')).buffer;
    const uploader=new AttachmentService(f.container,f.env),icon=await uploader.uploadImage(adminAttachmentScope(),new File([neutralPng],'level-card-neutral-transparent.png',{type:'image/png'}),0),background=await uploader.uploadImage(adminAttachmentScope(),new File([neutralPng],'level-background-neutral-transparent.png',{type:'image/png'}),0);
    await f.db.delete(userLevel);await f.db.delete(systemUserLevel);
    await f.db.insert(systemUserLevel).values(Array.from({length:6},(_,i)=>({id:7101+i,name:`原版等级${i+1}`,grade:i+1,expNum:i*100,
      discount:['100.00','95.25','90.00','85.00','80.00','75.00'][i],isShow:1,isDel:0,color:['#6b4a23','#5d667c','#8c6725','#4c7253','#7c4c71','#3a596e'][i],icon:icon.url,image:background.url,isForever:1})));
    // The real poster policy accepts this persisted platform-owned canonical
    // avatar; an arbitrary relative /static/logo.png has no controlled mapping.
    await f.db.update(user).set({level:0,levelStatus:1,exp:'150.75',nickname:'会员概览用户11',avatar:icon.url}).where(eq(user.uid,11));
    await f.db.update(user).set({level:0,levelStatus:0,exp:'50.25',nickname:'普通预览用户22'}).where(eq(user.uid,22));
    await f.db.delete(userSign);await f.db.insert(userSign).values([{uid:11,addTime:Math.floor(Date.now()/1000)-86400},{uid:11,addTime:Math.floor(Date.now()/1000)-172800}]);
    await f.db.delete(userBill);await f.db.insert(userBill).values({uid:11,category:'exp',type:'overview_history',status:1,title:'概览入口真实经验记录',number:'150.75',balance:'150.75',pm:1,addTime:Math.floor(Date.now()/1000)-86400});
    const settings={member_func_status:'1',level_activate_status:'0',sign_status:'1',sign_give_exp:'"10"',order_give_exp:'"1.25"',invite_user_exp:'"25"',
      sign_give_point:'0',sign_mode:'1',member_card_status:'0',site_name:'"本机会员概览"',site_url:'"https://owned-member.example"',spread_banner:JSON.stringify([icon.url]),share_qrcode:'0',routine_appId:'""',wechat_appid:'""'};
    await f.db.delete(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,Object.keys(settings))));
    await f.db.insert(systemConfig).values(Object.entries(settings).map(([menuName,value])=>({menuName,value,isStore:0,status:1})));
    f.env.PUBLIC_H5_ORIGIN='https://owned-member.example';f.cache.clear();wiring.container=f.container;
    // Infrastructure-only local guard: unlike the inherited upload-specific
    // fixture, preserve every real policy key (including legacy-share request).
    const rateStates=new Map<string,Record<string,RateWindow>>();
    f.env.TOKEN_BUCKET={getByName:(name:string)=>({consumeRateLimit:async(policies:RateLimitPolicy[],seconds:number)=>{
      const before=structuredClone(rateStates.get(name)??{}),at=Date.now(),next=advanceRateWindows(before,policies,at,seconds);
      rateStates.set(name,next.windows);budgetControls.push({name,policies,seconds,at_ms:at,before,after:structuredClone(next.windows),decision:next.decision,kind:'owned-local-rate-guard',production_DO_proof:false});
      return next.decision;
    }})} as unknown as Env['TOKEN_BUCKET'];
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Member Browser forbids external provider I/O'));
    // Real website QR generation writes its cache only before baseline. This is
    // neither a mocked response nor proof that a first-time QR GET is read-only.
    const tokenPayload=await verifyToken(f.token,f.env.APP_KEY);expect(tokenPayload).not.toBeNull();
    const [account]=await f.db.select({pwd:user.pwd}).from(user).where(eq(user.uid,11));
    const warmBefore=await snapshot(),warmResources=resources();
    const warmed=await new LegacyShareCodeService(f.container,f.env).code(parseLegacyShareInput('-1','11',new URLSearchParams()),
      {uid:11,authVersion:md5(account!.pwd),expiresAt:tokenPayload!.exp},false);
    const warmAfter=await snapshot();for(const name of Object.keys(warmBefore))if(name!=='cache')expect(warmAfter[name],name).toEqual(warmBefore[name]);
    expect(warmAfter.cache.length).toBeGreaterThan(warmBefore.cache.length);expect(resources()).toEqual(warmResources);
    const websiteQrSetup={kind:'owned-website-QR-prewarm',before:remember(warmBefore),after:remember(warmAfter),resources_before:warmResources,resources_after:resources(),result:warmed,
      limits:'Real LegacyShareCodeService cache generation, no official/mini provider configuration or network. Later navigation proves only an already-ready QR read.'};
    expected=await snapshot();const baseline=structuredClone(expected),resourceBaseline=resources();remember(setupBefore);remember(baseline);
    const app=createApp(),tokens=new Map([[11,f.token],[22,f.otherToken]]);
    const sources=async()=>{const names=[...(await Promise.all(['workers-ts/src','workers-ts/test/helpers','view/uniapp-ts/src','view/uniapp-ts/scripts','view/common'].map(name=>files(resolve(repository,name))))).flat(),
      ...['workers-ts/test/browser/customer-level-overview.acceptance.ts','workers-ts/vitest.customer-level-overview-browser.config.ts','workers-ts/test/user-level-overview-postgres.test.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json'].map(name=>resolve(repository,name))];
      return Promise.all([...new Set(names)].sort().map(async name=>{const bytes=await readFile(name);return{path:name.slice(repository.length+1),bytes:bytes.length,sha256:hash(bytes)};}));};
    const artifacts=async()=>Promise.all((await files(dist)).map(async name=>{const bytes=await readFile(name);return{path:name.slice(dist.length+1),bytes:bytes.length,sha256:hash(bytes)};}));
    const sourceBefore=await sources(),buildBefore=await artifacts();expect(buildBefore.length).toBeGreaterThan(100);
    let owner=11,pending=0,queue=Promise.resolve();const stage=()=>plans[evidence.length],serial=<T>(work:()=>Promise<T>)=>{const result=queue.then(work);queue=result.then(()=>{},()=>{});return result;};
    let finish!:()=>void,fail!:(error:Error)=>void;const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});completion.catch(()=>{});
    const persist=()=>writeFile(prefix+'progress.json',JSON.stringify({status:'running',plans,evidence,traces,controls,staticPaths,snapshots_by_sha256:snapshots,failed_dispatch:failedDispatch,budget_controls:budgetControls},null,2)+'\n',{mode:0o600});
    const send=(res:ServerResponse,raw:string|Buffer,status=200,type='text/html; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store',
      'Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'"});res.end(raw);};
    const json=(res:ServerResponse,value:unknown)=>send(res,JSON.stringify(value),200,'application/json');
    const allowed=['/api/site_config','/api/share','/api/get_open_adv','/api/get_script','/api/v2/diy/color_change/color_change','/api/diy/get_suspended','/api/diy/diy_version/0','/api/navigation',
      '/api/user/info','/api/user/level/info','/api/user/level/detection','/api/user/level/expList','/api/sign/config','/api/sign/status','/api/sign/calendar','/api/sign/list','/api/sign/user',
      '/api/category','/api/v2/diy/product_detail','/api/products','/api/cart/list','/api/cart/count','/api/cart/compute','/api/user/spread_info','/api/get_qrcode/-1/11'];
    function detectDelta(before:DiyStateSnapshot,after:DiyStateSnapshot,actor:number,started:number,completed:number){
      const account=before.user.find(row=>row.uid===actor);expect(account).toBeDefined();if(!account)throw Error('Missing detection actor snapshot');expect([11,22]).toContain(actor);
      const eligible=account.level_status===1?before.system_user_level.filter(row=>row.is_show===1&&row.is_del===0&&Number(row.exp_num)<=Number(account.exp)).sort((a,b)=>a.grade-b.grade||a.id-b.id):[];
      const sequence=before.__sequences.find(row=>row.name==='user_level_id_seq')!,prior=BigInt(sequence.last),missing=eligible.filter(level=>!before.user_level.some(row=>row.uid===actor&&row.level_id===level.id));
      for(const name of Object.keys(before))if(!['user','user_level','__sequences'].includes(name))expect(after[name],name).toEqual(before[name]);
      expect(after.user).toEqual(sortedDiyState({user:before.user.map(row=>row.uid===actor&&eligible.length?{...row,level:eligible.at(-1)!.id}:row)}).user);
      const added=after.user_level.filter(row=>!before.user_level.some(old=>old.id===row.id));expect(added).toHaveLength(missing.length);
      expect(after.user_level.filter(row=>before.user_level.some(old=>old.id===row.id))).toEqual(before.user_level);
      for(const [index,level] of missing.entries()){const row=added.find(row=>row.level_id===level.id);expect(row).toBeDefined();if(!row)throw Error('Missing detection inserted grant');const id=Number(prior+(sequence.called?1n:0n)+BigInt(index));
        expect(row).toEqual({id,uid:actor,level_id:level.id,grade:level.grade,valid_time:0,is_forever:level.is_forever,mer_id:0,status:1,mark:row.mark,remind:0,is_del:0,add_time:row.add_time,discount:Math.trunc(Number(level.discount))});
        expect(row.add_time).toBeGreaterThanOrEqual(Math.floor(started/1000));expect(row.add_time).toBeLessThanOrEqual(Math.floor(completed/1000)+eligible.length);
        expect(row.mark).toContain(`尊敬的用户${account.nickname}在`);expect(row.mark).toContain(`成为了${level.name}`);
      }
      const seqExpected=before.__sequences.map(row=>row.name==='user_level_id_seq'&&missing.length?{...row,last:String(prior+(sequence.called?BigInt(missing.length):BigInt(missing.length-1))),called:true}:row);
      expect(after.__sequences).toEqual(sortedDiyState({__sequences:seqExpected}).__sequences);
      return{kind:'detection-business-reconciliation',eligible_ids:eligible.map(row=>row.id),inserted_ids:added.map(row=>row.id),state_changed:digest(before)!==digest(after),physical_same_value_update_possible:eligible.length>0};
    }
    async function api(req:IncomingMessage,res:ServerResponse,url:URL){pending++;try{await serial(async()=>{
      const started=Date.now(),budgetStart=budgetControls.length,before=await snapshot(),beforeResources=resources();expect(before).toEqual(expected);expect(beforeResources).toEqual(resourceBaseline);
      const token=String(req.headers['authori-zation']??req.headers.authorization??'').replace(/^Bearer\s+/i,''),actor=[...tokens].find(([,value])=>value===token)?.[0]??0;
      const asset=/^\/api\/assets\/[1-9]\d*$/.test(url.pathname),qr=/^\/api\/share\/code\/image\/[a-f0-9]{24}\/wechat$/.test(url.pathname);
      expect(allowed.includes(url.pathname)||asset||qr,url.pathname).toBe(true);
      let bytes:Buffer;try{bytes=await body(req);}catch(error){const framing=req.rawHeaders.flatMap((name,i)=>i%2===0&&['content-length','transfer-encoding'].includes(name.toLowerCase())?[{name,value:req.rawHeaders[i+1]}]:[]);
        expect(req.method).toBe('GET');expect(req.aborted).toBe(true);expect(error).toMatchObject({code:'ECONNRESET',message:'aborted',bytes_consumed:0});expect(framing.length).toBeLessThanOrEqual(1);expect(framing.every(item=>item.name.toLowerCase()==='content-length'&&item.value==='0')).toBe(true);
        expect(await snapshot()).toEqual(before);expect(resources()).toEqual(beforeResources);controls.push({kind:'cancelled-before-dispatch',path:url.pathname,stage:stage(),issued_actor_hint:actor,worker_authenticated:false,bytes_consumed:0,dispatched:false,nonproof:true,before:remember(before),after:remember(before),resources_before:beforeResources,resources_after:resources(),framing});await persist();return;}
      if(url.pathname==='/api/sign/user'){expect(req.method).toBe('POST');expect(JSON.parse(bytes.toString())).toEqual({sign:1});expect(stage()).toBe('sign-task');expect(actor).toBe(11);}else{expect(req.method).toBe('GET');expect(bytes.length).toBe(0);}
      const headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      failedDispatch={path:url.pathname,query:url.search,method:req.method,stage:stage(),issued_actor_hint:actor,request_body_base64:Buffer.from(bytes).toString('base64'),request_body_sha256:hash(bytes),before:remember(before),resources_before:beforeResources};await persist();
      const response=await app.fetch(new Request(origin+url.pathname+url.search,{method:req.method,headers,...(bytes.length?{body:Uint8Array.from(bytes).buffer}: {})}),f.env),raw=Buffer.from(await response.arrayBuffer()),dto=response.headers.get('content-type')?.includes('json')?JSON.parse(raw.toString()):null,after=await snapshot(),completed=Date.now();
      Object.assign(failedDispatch,{worker_response:{http_status:response.status,headers:Object.fromEntries(response.headers),body:raw.toString(),body_base64:raw.toString('base64'),bytes:raw.length,sha256:hash(raw),dto},after:remember(after),resources_after:resources()});await persist();
      expect(response.status,url.pathname).toBe(200);if(dto)expect(dto.status,JSON.stringify(dto)).toBe(200);expect(resources()).toEqual(beforeResources);
      let classification:Row={kind:req.method==='POST'?'legacy-post-read':'read'};
      if(url.pathname==='/api/user/level/detection'){expect(actor).toBe(owner);expect(url.search).toBe('');expect(response.headers.get('cache-control')).toContain('no-store');expect(dto.data).toBe(true);classification=detectDelta(before,after,actor,started,completed);expected=after;}
      else expect(after).toEqual(before);
      if(url.pathname==='/api/user/level/info'){expect([...url.searchParams.entries()]).toEqual([['overview','1']]);expect(actor).toBe(owner);expect(dto.data.overview.actor_uid).toBe(actor);expect(dto.data.overview.levels).toHaveLength(6);expect(dto.data.overview.exp).toBe(actor===11?'150.75':'50.25');expect(dto.data.overview.current_level_id).toBe(actor===11?7102:0);expect(dto.data.overview.preview_only).toBe(actor===22);expect(response.headers.get('cache-control')).toContain('no-store');}
      if(asset){expect(url.searchParams.getAll('expires')).toHaveLength(1);expect(url.searchParams.getAll('signature')).toHaveLength(1);expect(url.searchParams.get('expires')).toMatch(/^[1-9]\d*$/);expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/);}
      const item={...failedDispatch,actor,synthetic:false,budget_control_indices:budgetControls.slice(budgetStart).map((_,index)=>budgetStart+index),request:{body_bytes:bytes.length,body_base64:Buffer.from(bytes).toString('base64'),sha256:hash(bytes),authorization_sha256:token?hash(token):null},classification,started_at_ms:started,completed_at_ms:completed,
        response_transport:{kind:'server-response-prepared',bytes:raw.length,sha256:hash(raw),received_proof:false}};traces.push(item);failedDispatch=null;await persist();
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(raw);
    });}finally{pending--;}}
    const last=(path:string,actor:number,at:number)=>[...traces].reverse().find(row=>row.path===path&&row.actor===actor&&row.completed_at_ms<=at);
    async function capture(name:string,data:Row){expect(name).toBe(stage());expect(pending).toBe(0);expect(data.active_page_count).toBe(1);expect(data.loading_texts).toEqual([]);expect(data.raw_document_images_preserved).toBe(true);expect(data.errors).toEqual([]);expect(data.statuses).toEqual([]);expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms??0));
      const width=name==='desktop'?1000:375;expect(data.frameWidth).toBe(width);expect(data.viewportWidth).toBe(width);expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);expect(data.clientWidth).toBeLessThanOrEqual(width);expect(width-data.clientWidth).toBeLessThanOrEqual(20);
      const route=name==='sign-task'?'/pages/user/sign':name==='order-task'?'/pages/goods/cate':name==='invite-task'?'/pages/user/spread':name==='growth-task'?'/pages/user/growthRecords':'/pages/user/level';expect(data.href).toBe(origin+'/__h5#'+route);expect(owner).toBe(name==='preview'?22:name==='guest'?0:11);
      const links:Row[]=[];const link=(row:Row|undefined)=>{expect(row).toBeDefined();links.push({index:traces.indexOf(row!),sha256:row!.worker_response.sha256});return row!.worker_response.dto?.data;};
      if(name==='guest'){expect(data.text).toContain('登录后查看会员等级');expect(data.buttons).toContain('去登录');expect(data.cards).toEqual([]);expect(data.current_images.some((image:Row)=>new URL(image.currentSrc||image.src,origin).pathname.startsWith('/api/assets/')||new URL(image.currentSrc||image.src,origin).pathname.startsWith('/static/php-level/'))).toBe(false);expect(traces.filter(row=>row.stage===name&&['/api/user/level/detection','/api/user/level/info'].includes(row.path))).toEqual([]);}
      else if(name==='sign-task'){expect(data.text).toContain('签到');const current=traces.filter(row=>row.stage===name);expect(current.some(row=>row.path==='/api/sign/user'&&row.method==='POST'&&row.actor===11)).toBe(true);for(const path of ['/api/sign/config','/api/sign/user'])link(current.find(row=>row.path===path));expect(data.cards).toEqual([]);}
      else if(name==='order-task'){const current=traces.filter(row=>row.stage===name);const category=link(current.find(row=>row.path==='/api/category')),style=link(current.find(row=>row.path==='/api/v2/diy/product_detail'));expect(category).toBeDefined();expect(style).toBeDefined();expect(data.cards).toEqual([]);expect(Array.isArray(category)).toBe(true);const names:string[]=[];const collect=(rows:Row[])=>{for(const item of rows){names.push(item.cate_name);if(Array.isArray(item.children))collect(item.children);}};collect(category);expect(names.some(value=>typeof value==='string'&&value!==''&&data.text.includes(value))).toBe(true);}
      else if(name==='invite-task'){expect(data.text).toContain('我的推广海报');expect(data.text).toContain('会员概览用户11');expect(data.text).toContain('模板 1');const current=traces.filter(row=>row.stage===name);for(const path of ['/api/user/spread_info','/api/get_qrcode/-1/11'])link(current.find(row=>row.path===path));expect(current.some(row=>/^\/api\/share\/code\/image\//.test(row.path))).toBe(true);expect(data.cards).toEqual([]);}
      else if(name==='growth-task'){const row=traces.find(row=>row.stage===name&&row.path==='/api/user/level/expList');const result=link(row);expect(result.count).toBe(1);expect(data.text).toContain('概览入口真实经验记录');expect(data.growth_ids).toEqual(result.list.map((entry:Row)=>entry.id));}
      else{
        const receipt=last('/api/user/level/info',owner,data.captured_at_ms),result=link(receipt),overview=result.overview;
        expect(data.owner).toBe(owner);expect(data.cards.map((row:Row)=>row.id)).toEqual(overview.levels.map((row:Row)=>row.id));expect(data.steps.map((row:Row)=>row.label)).toEqual(overview.levels.map((row:Row)=>'查看'+row.name));expect(data.steps).toHaveLength(6);
        const wanted=name==='next-card'?7103:['last-card','refreshed'].includes(name)?7106:owner===22?7101:7102;
        expect(data.selected_id).toBe(wanted);const card=data.cards.find((row:Row)=>row.id===wanted),source=overview.levels.find((row:Row)=>row.id===wanted);expect(card.name).toBe(source.name);expect(card.state).toBe(owner===22?'等级预览':wanted===7102?'当前等级':wanted<7102?'已解锁':'待解锁');
        // Independent decimal text oracle: hundredths of a percent become
        // thousandths of a Chinese 折; do not adopt the UI's formatter result.
        const [whole,fraction]=String(source.discount).split('.'),units=BigInt(whole)*100n+BigInt(fraction),tail=String(units%1000n).padStart(3,'0').replace(/0+$/u,'');
        const discount=String(units/1000n)+(tail?'.'+tail:'');expect(card.discount.replace(/\s+/gu,'')).toBe('商城购物可享'+discount+'折');
        const expectedProgress=source.exp_num<=0?(source.lack_exp_num==='0'?100:0):Math.max(0,Math.min(100,(source.exp_num-Number(source.lack_exp_num))*100/source.exp_num));
        expect(String(card.progress)).toMatch(/%$/u);expect(Number.parseFloat(card.progress)).toBeCloseTo(expectedProgress,8);
        const summary=source.lack_exp_num==='0'&&overview.current_grade!==null&&source.grade<=overview.current_grade?'您已经是尊贵的'+source.name+'会员':overview.exp+'成长值还差'+source.lack_exp_num;
        expect(card.growth_summary.replace(/\s+/gu,'')).toBe(summary);

        expect(data.privileges).toEqual(['购物折扣','专属徽章','经验累积','尊享客服']);expect(data.tasks.map((row:Row)=>row.kind)).toEqual(['sign','order','invite']);expect(data.text).toContain('已签到'+overview.task.sign_count+'天');expect(data.text).toContain('+1.25点经验/元');
        const imageUrl=(source:string)=>new URL(source,origin).href;expect(data.header_images.map((image:Row)=>image.currentSrc||image.src)).toContain(imageUrl(source.image));expect(card.images.map((image:Row)=>image.currentSrc||image.src)).toContain(imageUrl(source.icon));
        if(name==='refreshed')expect(receipt!.stage).toBe(name);if(name==='current-mobile')expect(traces.some(row=>row.stage===name&&row.path==='/api/user/level/detection'&&row.classification.inserted_ids.length===2)).toBe(true);
        if(name==='preview'){expect(data.text).toContain('当前为等级预览');expect(overview.current_level_id).toBe(0);expect(overview.level_active).toBe(false);}
        for(const file of Object.keys(originalPngs)){const path='/static/php-level/'+file;expect(data.current_images.some((image:Row)=>new URL(image.currentSrc||image.src,origin).pathname===path)).toBe(true);expect(staticPaths.some(row=>row.path===path&&row.sha256===originalPngs[file]&&row.status===200)).toBe(true);}
      }
      for(const image of data.images){expect(image.complete).toBe(true);expect(image.naturalWidth).toBeGreaterThan(0);const url=new URL(image.currentSrc||image.src,origin);expect(url.origin===origin||['data:','blob:'].includes(url.protocol)).toBe(true);
        if(url.pathname.startsWith('/api/assets/')){const t=traces.find(row=>row.path===url.pathname&&row.query===url.search&&row.worker_response.http_status===200&&row.completed_at_ms<=data.captured_at_ms);expect(t).toBeDefined();}}
      expect(await snapshot()).toEqual(expected);expect(resources()).toEqual(resourceBaseline);evidence.push({name,owner,...data,links,snapshot_sha256:remember(expected!)});await persist();
      if(evidence.length===plans.length){expect(await sources()).toEqual(sourceBefore);expect(await artifacts()).toEqual(buildBefore);expect(traces.filter(row=>row.classification.kind==='detection-business-reconciliation'&&row.classification.state_changed)).toHaveLength(1);expect(traces.some(row=>row.path==='/api/sign/integral')).toBe(false);finish();}
    }
    const shell=`<!doctype html><html><head><meta charset="utf-8"><title>会员等级概览真实验收</title><link rel="icon" href="data:,"></head><body><h1>会员等级概览真实验收</h1><p>QA账户、SQL和完整H5是真实本机夹具；仅等级检查可写user/user_level，不验签到/购物/邀请奖励。</p><button id="return">重开会员11（全新文档）</button><button id="preview">普通预览22</button><button id="guest">访客</button><button id="restore">恢复会员11</button><button id="wide">桌面宽度</button>${plans.map(name=>'<button data-phase="'+name+'">记录 '+name+'</button>').join('')}<pre id="result">待验收</pre><iframe title="真实会员等级H5" style="display:block;width:375px;height:1000px;border:1px solid #ddd"></iframe><script>
let frame=document.querySelector('iframe'),errors=[];const result=document.querySelector('#result');function wire(target){target.onload=event=>{const w=event.currentTarget?.contentWindow;if(!w)return;w.addEventListener('error',event=>errors.push(String(event.message)));w.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)))}}wire(frame);
async function open(uid){const r=await fetch(${JSON.stringify(control)}+'/owner?uid='+uid,{method:'POST'}),data=await r.json();if(uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:data.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}))}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid')}errors=[];const old=frame,fresh=old.cloneNode(false);fresh.removeAttribute('src');frame=fresh;wire(fresh);old.replaceWith(fresh);frame.src='/__h5#/pages/user/level'}
document.querySelector('#return').onclick=()=>open(11);document.querySelector('#preview').onclick=()=>open(22);document.querySelector('#guest').onclick=()=>open(0);document.querySelector('#restore').onclick=()=>open(11);document.querySelector('#wide').onclick=()=>frame.style.width='1000px';
for(const button of document.querySelectorAll('[data-phase]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,rendered=n=>{if(!n||n.getBoundingClientRect().width<=0||n.getBoundingClientRect().height<=0)return false;for(let a=n;a&&a.nodeType===1;a=a.parentElement){const style=w.getComputedStyle(a);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false}return true},shown=n=>{if(!rendered(n))return false;const r=n.getBoundingClientRect();return r.right>0&&r.left<w.innerWidth&&r.bottom>0&&r.top<w.innerHeight},pages=[...d.querySelectorAll('uni-page')].filter(shown),p=pages.at(-1)||d,txt=n=>(n?.textContent||'').trim(),images=n=>[...n.querySelectorAll('img')].map(i=>({src:i.src,currentSrc:i.currentSrc,complete:i.complete,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,className:i.className,parentClassName:i.parentElement?.className||'',viewport_visible:shown(i)})),rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
const cards=[...p.querySelectorAll('[data-member-level-id]')].map(row=>({id:Number(row.getAttribute('data-member-level-id')),selected:row.classList.contains('selected'),name:txt(row.querySelector('.level-name')),state:txt(row.querySelector('.level-state')),discount:txt(row.querySelector('.level-discount')),growth_summary:txt(row.querySelector('.growth-summary')),progress:row.querySelector('.level-progress>view, .level-progress>uni-view')?.style.width||'',rect:rect(row),images:images(row)}));const data={captured_at_ms:Date.now(),active_page_count:pages.length,raw_document_images_preserved:true,loading_texts:[...p.querySelectorAll('[role=\"status\"],.read-state,.empty,.loading,.ledger-state,.message')].filter(rendered).map(txt).filter(value=>/正在|加载中/u.test(value)),href:w.location.href,frameWidth:frame.clientWidth,viewportWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:p.innerText,errors:[...errors],statuses:[...p.querySelectorAll('[role="alert"],[role="status"]')].filter(shown).map(n=>n.innerText).filter(Boolean),images:images(d),current_images:images(p),owner:Number(p.querySelector('[data-level-owner]')?.getAttribute('data-level-owner')||0),cards,selected_id:cards.find(row=>row.selected)?.id||0,steps:[...p.querySelectorAll('.step')].map(row=>({label:row.getAttribute('aria-label'),text:txt(row),active:row.classList.contains('active'),rect:rect(row)})),privileges:[...p.querySelectorAll('.privilege')].map(txt),tasks:[...p.querySelectorAll('[data-level-task]')].map(row=>({kind:row.getAttribute('data-level-task'),text:txt(row)})),header_images:images(p.querySelector('.header-background')?.parentElement||d).filter(image=>image.className.includes('header-background')||image.parentClassName.includes('header-background')),growth_ids:[...p.querySelectorAll('[data-growth-record-id]')].map(row=>Number(row.getAttribute('data-growth-record-id'))),buttons:[...p.querySelectorAll('button,uni-button')].map(txt)};
const response=await fetch(${JSON.stringify(control)}+'/phase/'+button.dataset.phase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});result.textContent=await response.text()}catch(error){result.textContent=String(error)}finally{button.disabled=false}};open(11);
</script></body></html>`;
    server=createServer((req,res)=>{void(async()=>{
      expect(req.socket.remoteAddress).toBe('127.0.0.1');expect(req.headers.host).toBe('127.0.0.1:40845');const url=new URL(req.url??'/',origin);
      if(url.pathname.startsWith(control)){expect(req.method).toBe('POST');if(url.pathname===control+'/owner'){expect(pending).toBe(0);const uid=Number(url.searchParams.get('uid'));expect([0,11,22]).toContain(uid);owner=uid;controls.push({kind:'qa-session',uid,stage:stage(),nonproof:true});json(res,{token:tokens.get(uid)??''});return;}
        if(url.pathname.startsWith(control+'/phase/')){const data=JSON.parse((await body(req)).toString());await serial(async()=>{const name=url.pathname.slice((control+'/phase/').length);
          if(pending>0||data.active_page_count!==1||data.loading_texts?.length>0||data.current_images?.some((image:Row)=>!image.complete||image.naturalWidth<=0)||data.statuses?.some((value:string)=>/正在(?:读取|检查)/u.test(value))){controls.push({kind:'qa-not-ready',name,pending,at_ms:Date.now(),nonproof:true});await persist();json(res,{accepted:false,name,reason:'pending-read',pending,next:stage()});return;}
          await capture(name,data);json(res,{accepted:true,name,complete:evidence.length===plans.length,next:stage(),actual_dispatched:traces.length,detection_requests:traces.filter(row=>row.classification.kind==='detection-business-reconciliation').length});});return;}
        throw Error('Unknown member QA control');}
      if(url.pathname.startsWith('/api/')){await api(req,res,url);return;}expect(req.method).toBe('GET');if(url.pathname==='/'){send(res,shell);return;}if(url.pathname==='/favicon.ico'){send(res,'',204,'image/x-icon');return;}
      const decoded=decodeURIComponent(url.pathname),target=decoded==='/__h5'?resolve(dist,'index.html'):resolve(dist,'.'+decoded);expect(target.startsWith(dist+sep)).toBe(true);let raw=await readFile(target);if(target===resolve(dist,'index.html'))raw=Buffer.from(raw.toString().replace('<head>','<head><link rel="icon" href="data:,">'));
      const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.gif':'image/gif','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2'};
      staticPaths.push({path:decoded,file:target.slice(dist.length+1),bytes:raw.length,sha256:hash(raw),status:200,index_transform:target===resolve(dist,'index.html')?'insert-data-favicon-after-head':null});send(res,raw,200,types[extname(target)]??'application/octet-stream');
    })().catch(error=>{failure??=error;controls.push({kind:'server-error',method:req.method,url:req.url,error:String(error),stage:stage()});void persist().then(()=>fail(error),()=>fail(error));if(!res.headersSent&&!res.destroyed)send(res,String(error),500,'text/plain');else res.destroy();});});
    server.on('upgrade',(_req,socket)=>{const error=Error('Member Browser forbids external provider sockets');failure??=error;fail(error);socket.destroy();});timer=setTimeout(()=>fail(Error('Member Browser timeout')),50*60000);
    await new Promise<void>((yes,no)=>{server!.once('error',no);server!.listen(40845,'127.0.0.1',yes);});
    await writeFile(prefix+'ready.json',JSON.stringify({origin,control,prefix,plans,table_count:tables.length,sequence_count:sequences.length,tables,sequences,additional_tables:additional,source_count:sourceBefore.length,build_count:buildBefore.length,
      canonical_media:{icon:icon.url,image:background.url},original_pngs:originalPngs,boundary:'Actual H5/Worker/JWT/owned PG16. Detection reconciliation is separately measured; all other business requests are read-only, including exact POST sign/user {sign:1}. QR prewarm occurs before baseline. R2/queue/business SQL reads are unchanged; local rate-guard counters are separately recorded normal guard effects. No activate/sign award/purchase/invite reward/provider/login-form/independent SQL LOGIN/production Durable Object proof.'},null,2)+'\n',{mode:0o600});
    console.log('CUSTOMER_LEVEL_OVERVIEW_BROWSER_READY '+origin);await completion;await queue;
    await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed',plans,evidence,traces,controls,staticPaths,budget_controls:budgetControls,snapshots_by_sha256:snapshots,
      fixture_setup:{before:setupBefore,after:baseline,resources_before:setupResourcesBefore,resources_after:resourceBaseline,website_qr_setup:websiteQrSetup},final:await snapshot(),resources_before:resourceBaseline,resources_after:resources(),sourceBefore,sourceAfter:await sources(),buildBefore,buildAfter:await artifacts()},null,2)+'\n',{mode:0o600});
  }catch(error){failure??=error;await writeFile(prefix+'failed.json',JSON.stringify({status:'failed',error:String(error),stack:error instanceof Error?error.stack:null,evidence,traces,controls,staticPaths,budget_controls:budgetControls,snapshots_by_sha256:snapshots,expected,failed_dispatch:failedDispatch},null,2)+'\n',{mode:0o600});throw error;}
  finally{clearTimeout(timer);let cleanupFailure:unknown,fixtureClosed=false;try{if(server){server.closeAllConnections();if(server.listening)await new Promise<void>((yes,no)=>server!.close(error=>error?no(error):yes()));}}catch(error){cleanupFailure=error;}
    try{await f.close();fixtureClosed=true;}catch(error){cleanupFailure??=error;}wiring.container=undefined;vi.restoreAllMocks();await writeFile(prefix+'cleanup.json',JSON.stringify({server_closed:!server?.listening,fixture_closed:fixtureClosed,failure:failure?String(failure):null,cleanup_failure:cleanupFailure?String(cleanupFailure):null})+'\n',{mode:0o600});if(cleanupFailure)throw cleanupFailure;}
},54*60000);
