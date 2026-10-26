/** Opt-in CUA host: actual Worker/JWT/owned PG and fresh H5 only.
 * One QA expiry-config maintenance action is separate from read-only business APIs.
 * Fixture DI and QA JWT bootstrap do not prove the login form or independent LOGIN ACL. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { and, eq, inArray, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemConfig, user, userBill, userSign, storeIntegral, luckLottery, luckPrize, luckLotteryRecord } from '@/models/schema';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned points-centre database'); return wiring.container;
} }));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
const plans = ['centre-initial','centre-refreshed','ledger-page1','ledger-page2-same-month','ledger-terminal-unknown-time','ledger-refreshed','centre-returned','sign-link','sign-returned','mall-link','mall-returned','lottery-link','lottery-returned','expiry-off','negative-owner','empty-ledger','guest','restored','desktop','finished'];
async function files(dir: string): Promise<string[]> { return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat().sort(); }
async function body(req: IncomingMessage, consumed?: (size: number) => void, max = 65_536) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; consumed?.(size); expect(size).toBeLessThanOrEqual(max); chunks.push(part); } return Buffer.concat(chunks); }
function abortedEmptyGet(req: IncomingMessage, error: unknown, consumed: number) {
  const lengths = req.rawHeaders.flatMap((name, i) => i % 2 === 0 && name.toLowerCase() === 'content-length' ? [req.rawHeaders[i + 1]] : []);
  return req.aborted === true && req.method === 'GET' && consumed === 0 && lengths.length <= 1 && lengths.every(value => value === '0')
    && !req.rawHeaders.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'transfer-encoding')
    && error instanceof Error && error.message === 'aborted' && 'code' in error && error.code === 'ECONNRESET';
}
it('built customer points centre reads real totals and complete monthly pages with explicit owner changes and zero business writes on owned PG16', async () => {
  const f = await diyFooterBrowserFixture();
  const prefix = '/tmp/cinashop-customer-points-centre-browser-', repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const origin = 'http://127.0.0.1:40839', control = '/__points/' + randomUUID();
  let server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown;
  const traces: Row[] = [], evidence: Row[] = [], staticPaths: Row[] = [], controls: Row[] = [], setups: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  let failedDispatch: Row | undefined, expected: DiyStateSnapshot | undefined;
  try {
    // Only exact ORM table columns/defaults needed by read-only navigation. No production migration or ACL claim.
    const dialect = new PgDialect(), additionalTables: string[] = [];
    for (const table of [storeIntegral, luckLottery, luckPrize, luckLotteryRecord]) {
      const definition = getTableConfig(table); if (f.tables.includes(definition.name)) continue;
      const columns = definition.columns.map(column => { const initial = column.default, defaultSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`; });
      await f.exec(`create table "${definition.name}" (${columns.join(', ')})`); additionalTables.push(definition.name);
    }
    const tableNames = (await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    const sequenceNames = (await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    async function snapshot(): Promise<DiyStateSnapshot> {
      const value: DiyStateSnapshot = {};
      const rows = await f.db.execute<{name:string;rows:Row[]}>(sql.join(tableNames.map(name => sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `));
      for (const row of rows) value[row.name] = row.rows;
      value.__sequences = await f.db.execute(sql.join(sequenceNames.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));
      return sortedDiyState(value);
    }
    const setupBefore = await snapshot(), now = Math.floor(Date.now() / 1000), local = new Date((now + 28_800) * 1000), year = local.getUTCFullYear(), month = local.getUTCMonth();
    const shanghai = (y: number, m: number, d: number, seconds = 3600) => Math.floor(Date.UTC(y,m,d) / 1000) - 28_800 + seconds;
    await f.db.delete(userBill); await f.db.delete(userSign); await f.db.delete(storeIntegral);
    await f.db.update(user).set({ nickname:'积分详情用户11',integral:75,signNum:0,exp:'0.00',levelStatus:0 }).where(eq(user.uid,11));
    await f.db.update(user).set({ nickname:'负积分空账单用户22',integral:-7,signNum:0,exp:'0.00',levelStatus:0 }).where(eq(user.uid,22));
    const bills: Array<typeof userBill.$inferInsert> = [];
    for (let i=0;i<23;i++) bills.push({ uid:11,category:'integral',type:'owned_points_read',title:'积分账单'+i,mark:i===0?'日期未知的历史调整':i===1?'历史负原值调整':i===2?'历史消费':`积分记录${i}`,pm:i===0||i===2?0:i%2,
      number:i===0?'-2.99':i===1?'-3.90':i===2?'5.25':i===3?'100.75':i===4?'0.75':'2.90',balance:'75.99',status:i===21?0:1,
      addTime:i===0?0:i<=3?shanghai(year-1,2,10+i):i<8?shanghai(year,month-2,5+i):i<19?shanghai(year,month-1,1,i):now-i,
      frozenTime:i===22?now+86400:0 });
    const ownedRows = await f.db.insert(userBill).values(bills).returning({id:userBill.id});
    await f.db.insert(userBill).values({uid:11,category:'now_money',number:'999.99',balance:'999.99',pm:1,title:'其他财务域旁观',mark:'不可展示为积分',addTime:now,status:1});
    const configKeys = ['sign_status','sign_in_switch','sign_give_point','sign_in_integral','sign_mode','sign_give_exp','sign_remind','member_func_status','member_card_status','integral_effective_status','integral_effective_time'];
    await f.db.delete(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,configKeys)));
    await f.db.insert(systemConfig).values(Object.entries({sign_in_switch:'1',sign_in_integral:'7',sign_mode:'1',sign_give_exp:'0',sign_remind:'1',member_func_status:'1',member_card_status:'0',integral_effective_status:'1',integral_effective_time:'3'}).map(([menuName,value])=>({menuName,value,isStore:0,status:1})));
    const [lottery] = await f.db.insert(luckLottery).values({name:'积分入口只读抽奖活动',desc:'仅验证真实导航与读取，不抽奖',factor:1,factorNum:10,startTime:now-3600,endTime:now+86400,attendsUser:1,isSvip:2,isAllRecord:0,isPersonalRecord:0,lotteryNum:5,totalLotteryNum:20,content:'本次不执行抽奖业务'}).returning({id:luckLottery.id});
    await f.db.insert(luckPrize).values({lotteryId:lottery.id,type:1,name:'只读奖品',image:'/static/logo.png',chance:100,total:100,status:1});
    f.cache.clear(); wiring.container=f.container;
    const app=createApp(), tokens=new Map<number,string>([[11,f.token],[22,f.otherToken]]);
    const resources=()=>({puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length,objects:digest([...f.objects].map(([key,value])=>({key,type:value.type,bytes:[...value.bytes]}))),queue:vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length});
    const remember=(value:DiyStateSnapshot)=>{const id=digest(value);snapshots[id]??=structuredClone(value);return id;};
    expected=await snapshot(); const baseline=structuredClone(expected),initialResources=resources();remember(setupBefore);remember(expected);
    const sources=async()=>{const dirs=['workers-ts/src','workers-ts/test/helpers','view/uniapp-ts/src','view/uniapp-ts/scripts','view/common'];
      const paths=[...(await Promise.all(dirs.map(dir=>files(resolve(repository,dir))))).flat(),...['workers-ts/test/browser/customer-points-centre.acceptance.ts','workers-ts/vitest.customer-points-centre-browser.config.ts','workers-ts/test/customer-points-centre-read-postgres.test.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json'].map(path=>resolve(repository,path))];
      return Promise.all([...new Set(paths)].sort().map(async path=>({path:path.slice(repository.length+1),sha256:hash(await readFile(path))})));};
    const artifacts=async()=>Promise.all((await files(dist)).map(async path=>({path:path.slice(dist.length+1),sha256:hash(await readFile(path))})));
    const sourceBefore=await sources(),buildBefore=await artifacts();expect(buildBefore.length).toBeGreaterThan(100);
    const external=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Points-centre Browser forbids external provider I/O'));
    let queue=Promise.resolve(),pending=0,owner=11,expiryOff=false;
    const stage=()=>plans[evidence.length],serial=<T>(work:()=>Promise<T>)=>{const next=queue.then(work);queue=next.then(()=>{},()=>{});return next;};
    let finish!:()=>void,fail!:(error:Error)=>void;const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});completion.catch(()=>{});
    const persist=async()=>writeFile(prefix+'progress.json',JSON.stringify({status:'running',plans,evidence,traces,controls,setups,staticPaths,snapshots_by_sha256:snapshots,failedDispatch},null,2)+'\n',{mode:0o600});
    const send=(res:ServerResponse,bytes:string|Buffer,status=200,type='text/html; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'"});res.end(bytes);};
    const json=(res:ServerResponse,value:unknown)=>send(res,JSON.stringify(value),200,'application/json');
    function actor(req:IncomingMessage){const token=String(req.headers['authori-zation']??req.headers.authorization??'').replace(/^Bearer\s+/i,'');return [...tokens].find(([,value])=>value===token)?.[0]??0;}
    const allowed=['/api/site_config','/api/share','/api/get_open_adv','/api/get_script','/api/v2/diy/color_change/color_change','/api/diy/get_suspended','/api/diy/diy_version/0','/api/navigation','/api/sign/config','/api/sign/status','/api/sign/list','/api/sign/calendar','/api/sign/user','/api/integral/list','/api/user/info','/api/store_integral/list','/api/v2/lottery/info/1'];
    async function api(req:IncomingMessage,res:ServerResponse,url:URL){pending++;try{await serial(async()=>{
      const started=Date.now(),method=req.method??'',before=await snapshot(),beforeResources=resources(),issuedActorHint=actor(req);expect(before).toEqual(expected);
      expect(allowed.includes(url.pathname)||/^\/api\/assets\/[1-9]\d*$/.test(url.pathname)).toBe(true);expect([...url.searchParams.keys()].length).toBe(new Set(url.searchParams.keys()).size);
      let consumed=0,bytes:Buffer;try{bytes=await body(req,size=>{consumed=size;});}catch(error){if(!abortedEmptyGet(req,error,consumed))throw error;
        const after=await snapshot(),afterResources=resources();controls.push({kind:'cancelled-before-dispatch',path:url.pathname,query:url.search,method,issued_actor_hint:issuedActorHint,token_match:issuedActorHint!==0,worker_authenticated:false,aborted:true,dispatched:false,nonproof:true,stage:stage(),request:{bytes_received:consumed,content_length:req.headers['content-length']??null,transfer_encoding:req.headers['transfer-encoding']??null,framing_headers:req.rawHeaders.flatMap((name,i)=>i%2===0&&['content-length','transfer-encoding'].includes(name.toLowerCase())?[{name,value:req.rawHeaders[i+1]}]:[])},error:{name:(error as Error).name,message:(error as Error).message,code:'ECONNRESET'},before:remember(before),after:remember(after),resources_before:beforeResources,resources_after:afterResources,started_at_ms:started,completed_at_ms:Date.now()});await persist();expect(after).toEqual(before);expect(afterResources).toEqual(beforeResources);return;}
      const input:unknown=bytes.length?JSON.parse(bytes.toString()):{};
      failedDispatch={path:url.pathname,query:url.search,method,issued_actor_hint:issuedActorHint,stage:stage(),request:{bytes:bytes.length,body:bytes.toString(),sha256:hash(bytes),input},before:remember(before),resources_before:beforeResources};await persist();
      if(url.pathname==='/api/sign/user'){expect(method).toBe('POST');expect(input).toEqual(stage()==='sign-link'?{sign:1}:{sign:1,integral:1,all:1});expect([11,22]).toContain(issuedActorHint);}
      else{expect(method).toBe('GET');expect(bytes.length).toBe(0);}
      if(url.pathname==='/api/integral/list'){expect([...url.searchParams.keys()].sort()).toEqual(['limit','page']);expect(url.searchParams.get('limit')).toBe('10');expect(url.searchParams.get('page')).toMatch(/^[123]$/);expect([11,22]).toContain(issuedActorHint);}
      const headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      const waits:Promise<unknown>[]=[];const response=await app.fetch(new Request(origin+url.pathname+url.search,{method,headers,...(bytes.length?{body:bytes}:{})}),f.env,{waitUntil:(work:Promise<unknown>)=>waits.push(work),passThroughOnException(){}} as unknown as ExecutionContext);await Promise.all(waits);
      const raw=Buffer.from(await response.arrayBuffer()),type=response.headers.get('Content-Type')??'',isText=/(?:json|javascript|text\/)/.test(type),payload:Row|undefined=type.includes('application/json')?JSON.parse(raw.toString()):undefined;
      const after=await snapshot(),afterResources=resources();failedDispatch={...failedDispatch,after:remember(after),resources_after:afterResources,worker_response:{http_status:response.status,content_type:type,cache_control:response.headers.get('Cache-Control'),bytes:raw.length,body_encoding:isText?'utf8':'base64',body:isText?raw.toString():raw.toString('base64'),sha256:hash(raw),dto:payload}};await persist();
      expect(response.status).toBe(200);expect(payload?.status??200).toBe(200);expect(after).toEqual(before);expect(afterResources).toEqual(beforeResources);expect(afterResources).toEqual(initialResources);
      if(url.pathname.startsWith('/api/sign/')||url.pathname==='/api/integral/list')expect(response.headers.get('Cache-Control')).toContain('no-store');
      if(url.pathname==='/api/sign/user')expect(payload?.data.uid).toBe(issuedActorHint);
      if(url.pathname==='/api/integral/list'){expect(payload?.data.list.every((row:Row)=>row.uid===issuedActorHint&&row.category==='integral')).toBe(true);expect(payload?.data.count).toBe(issuedActorHint===11?23:0);}
      if(/^\/api\/assets\//.test(url.pathname)){expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']);expect(Number(url.searchParams.get('expires'))*1000).toBeGreaterThan(Date.now());expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/);}
      traces.push({...failedDispatch,actor:issuedActorHint,mutation:{kind:'read'},synthetic:false,started_at_ms:started,completed_at_ms:Date.now(),browser_delivery:{kind:'bridge-delivered',http_status:response.status,bytes:raw.length,sha256:hash(raw),received_proof:true}});failedDispatch=undefined;await persist();res.writeHead(response.status,Object.fromEntries(response.headers));res.end(raw);
    });}finally{pending--;}}
    const latest=(path:string,time:number)=>[...traces].reverse().find(t=>t.actor===owner&&t.path===path&&t.worker_response.dto?.status===200&&t.browser_delivery.received_proof&&t.completed_at_ms<=time);
    const link=(trace:Row)=>({trace_index:traces.indexOf(trace),sha256:trace.worker_response.sha256});
    async function capture(name:string,data:Row){
      expect(name).toBe(stage());expect(pending).toBe(0);expect(data.errors).toEqual([]);expect(data.statuses).toEqual([]);expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms??0));expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);
      const width=['desktop','finished'].includes(name)?1000:375;expect(data.frameWidth).toBe(width);expect(data.viewportWidth).toBe(width);expect(data.clientWidth).toBeLessThanOrEqual(width);expect(width-data.clientWidth).toBeLessThanOrEqual(20);
      const ledger=name.startsWith('ledger-')||name==='empty-ledger',special=name==='sign-link'?'sign':name==='mall-link'?'integral':name==='lottery-link'?'../activity/lottery?factor=1':null;
      const route=ledger?'/pages/user/integralLogs':special==='sign'?'/pages/user/sign':special==='integral'?'/pages/user/integral':special?'/pages/activity/lottery?factor=1':'/pages/user/points';expect(data.href).toBe(origin+'/__h5#'+route);
      expect(owner).toBe(['negative-owner','empty-ledger'].includes(name)?22:name==='guest'?0:11);
      for(const image of data.images){expect(image.complete).toBe(true);expect(image.naturalWidth).toBeGreaterThan(0);const url=new URL(image.currentSrc||image.src,origin);expect(url.origin===origin||url.protocol==='data:').toBe(true);if(url.origin===origin)expect(staticPaths.some(row=>row.path===url.pathname)||traces.some(row=>row.path===url.pathname&&row.worker_response.http_status===200&&row.completed_at_ms<=data.captured_at_ms)).toBe(true);}
      const links:Row={};
      if(!owner){expect(data.text).toContain('登录后查看我的积分');expect(data.summary.balance).toBe(null);expect(data.groups).toEqual([]);expect(data.buttons).toContain('去登录');expect(traces.filter(t=>t.stage==='guest'&&['/api/sign/user','/api/integral/list'].includes(t.path))).toEqual([]);}
      else if(ledger){
        const pageNumbers=name==='ledger-page2-same-month'?[1,2]:name==='ledger-terminal-unknown-time'?[1,2,3]:[1];
        const sourceStage=name==='empty-ledger'?'empty-ledger':name==='ledger-refreshed'?'ledger-refreshed':'ledger-page1';
        const first=traces.find(t=>t.actor===owner&&t.path==='/api/integral/list'&&t.stage===sourceStage&&new URLSearchParams(t.query).get('page')==='1'&&t.completed_at_ms<=data.captured_at_ms);expect(first).toBeDefined();
        const selected=pageNumbers.map(page=>page===1?first!:traces.find(t=>t.actor===owner&&t.path==='/api/integral/list'&&t.stage===(page===2?'ledger-page2-same-month':'ledger-terminal-unknown-time')&&new URLSearchParams(t.query).get('page')===String(page)&&t.completed_at_ms<=data.captured_at_ms)!);expect(selected.every(Boolean)).toBe(true);
        const rows:Row[]=selected.flatMap(t=>t.worker_response.dto.data.list),groups=new Map<string,Row[]>();for(const row of rows){const group=groups.get(row.time_key)??[];group.push(row);groups.set(row.time_key,group);}
        expect(data.records.map((row:Row)=>row.id)).toEqual(rows.map(row=>row.id));expect(data.groups.map((group:Row)=>({month:group.month,ids:group.records.map((row:Row)=>row.id)}))).toEqual([...groups].map(([month,list])=>({month,ids:list.map(row=>row.id)})));
        for(const [index,row]of rows.entries()){const shown=data.records[index];expect(shown.mark).toBe(row.mark||row.title||'积分变动');expect(shown.time).toBe(row.add_time||'时间未记录');const amount=row.pm===1?row.number:-row.number;expect(shown.amount).toBe(amount>0?'+'+amount:amount<0?String(amount):row.pm===1?'+0':'-0');expect(shown.source).toBe(row.number<0?`${row.pm===1?'收入':'支出'}记录原值 ${row.number} 积分`:'');}
        for(const group of data.groups)expect(group.title).toBe(group.month||'日期未记录');
        expect(rows.every(row=>row.uid===owner)).toBe(true);expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);expect(selected.every(t=>t.worker_response.dto.data.count===(owner===11?23:0))).toBe(true);
        if(name==='ledger-page1'||name==='ledger-refreshed')expect(rows).toHaveLength(10);if(name==='ledger-page2-same-month'){expect(rows).toHaveLength(20);const months1=selected[0].worker_response.dto.data.times,months2=selected[1].worker_response.dto.data.times;expect(months1.some((month:string)=>months2.includes(month))).toBe(true);}
        if(name==='ledger-terminal-unknown-time'){expect(rows).toHaveLength(23);expect(rows.map(row=>row.id)).toEqual(ownedRows.map(row=>row.id).reverse());expect(data.text).toContain('没有更多内容啦~');expect(data.groups.at(-1).month).toBe('');expect(data.groups.at(-1).title).toBe('日期未记录');expect(data.records.at(-1).time).toBe('时间未记录');expect(data.text).not.toContain('1970');expect(data.buttons).not.toContain('加载更多');}
        if(name==='empty-ledger'){expect(rows).toEqual([]);expect(data.text).toContain('暂无积分记录~');expect(data.current_images.some((image:Row)=>new URL(image.currentSrc||image.src,origin).pathname==='/static/php-points/noOrder.gif')).toBe(true);}
        links.pages=selected.map(link);
      }else if(name==='sign-link'){
        const config=latest('/api/sign/config',data.captured_at_ms),points=latest('/api/sign/user',data.captured_at_ms),status=latest('/api/sign/status',data.captured_at_ms);for(const trace of[config,points,status]){expect(trace).toBeDefined();expect(trace!.stage).toBe(name);}expect(points!.worker_response.dto.data.uid).toBe(11);expect(data.text).toContain('立即签到');expect(data.sign_button).not.toBe(null);expect(data.sign_button.disabled).toBe(false);links.config=link(config!);links.points=link(points!);links.status=link(status!);
      }else if(name==='mall-link'){
        const list=latest('/api/store_integral/list',data.captured_at_ms),account=latest('/api/user/info',data.captured_at_ms);for(const trace of[list,account]){expect(trace).toBeDefined();expect(trace!.stage).toBe(name);}expect(data.text).toContain('我的积分');expect(data.text).toContain('暂无积分商品');expect(data.mall_balance).toBe('75');links.list=link(list!);links.account=link(account!);
      }else if(name==='lottery-link'){
        const info=latest('/api/v2/lottery/info/1',data.captured_at_ms);expect(info).toBeDefined();expect(info!.stage).toBe(name);expect(info!.worker_response.dto.data.id).toBe(lottery.id);expect(info!.worker_response.dto.data.factor).toBe(1);expect(data.text).toContain('积分入口只读抽奖活动');expect(data.text).toContain('立即抽奖');links.info=link(info!);
      }else{
        const summary=latest('/api/sign/user',data.captured_at_ms),config=latest('/api/sign/config',data.captured_at_ms);for(const trace of[summary,config])expect(trace).toBeDefined();if(!['desktop','finished'].includes(name))for(const trace of[summary,config])expect(trace!.stage).toBe(name);
        const dto=summary!.worker_response.dto.data;expect(dto.uid).toBe(owner);expect(data.summary).toEqual({balance:dto.integral,income:dto.sum_integral,expense:dto.deduction_integral,frozen:dto.frozen_integral});expect(data.sign_task).toBe(config!.worker_response.dto.data.signStatus!==0);
        if(!expiryOff){expect(dto.clear_integral).toBe(75);expect(data.notice).toBe('您的积分将于 '+dto.clear_end+' 清零');}else{expect(dto.clear_integral).toBe(0);expect(dto.clear_time).toBe(0);expect(dto.clear_end).toBe('');expect(data.notice).toBe('积分可用于商品兑换、下单抵扣及活动');}
        if(owner===22){expect(data.summary).toEqual({balance:-7,income:0,expense:0,frozen:0});expect(data.text).not.toContain('积分账单');}
        expect(data.current_images.filter((image:Row)=>new URL(image.currentSrc||image.src,origin).pathname.startsWith('/static/php-points/'))).toHaveLength(9);links.summary=link(summary!);links.config=link(config!);
      }
      expect(await snapshot()).toEqual(expected);expect(resources()).toEqual(initialResources);evidence.push({name,...data,actor:owner,links,traces_through:traces.length,db_sha256:remember(expected!),resources:resources()});await persist();
      if(name==='finished'){expect(evidence).toHaveLength(plans.length);expect(setups).toHaveLength(1);expect(expiryOff).toBe(true);expect(traces.every(t=>t.mutation.kind==='read')).toBe(true);expect(controls.filter(c=>c.kind==='server-error')).toEqual([]);expect(external).not.toHaveBeenCalled();expect(await sources()).toEqual(sourceBefore);expect(await artifacts()).toEqual(buildBefore);finish();}
    }
    const shell=String.raw`<!doctype html><html lang="zh"><meta charset="utf-8"><link rel="icon" href="data:,"><title>真实顾客积分中心 PG16</title><style>body{margin:8px;font:14px sans-serif;background:#f6f7f8}h1{font-size:18px}button{margin:3px;padding:6px}iframe{display:block;width:375px;height:1100px;border:0;background:#fff}pre{white-space:pre-wrap;max-height:95px;overflow:auto}</style><h1>顾客积分中心 · 真实 Worker / PostgreSQL16</h1><p>所有业务与 chrome 响应来自实际 Worker。QA 仅装载 owned JWT、一次关闭积分到期配置。没有业务写入、兑换或抽奖；不证明登录表单、独立 LOGIN ACL 或商城交易复测。先装载用户11；页内使用真实按钮导航，返回请使用实际应用导航或 iframe history.back。</p>${[11,22,0].map(uid=>'<button data-owner="'+uid+'">装载用户'+uid+'</button>').join('')}<button id="expiry-off">QA关闭积分到期</button><button id="reload">真实重新加载当前页</button><button id="wide">桌面1000</button>${plans.map(name=>'<button data-stage="'+name+'">验收 '+name+'</button>').join('')}<pre id="result"></pre><iframe title="实际顾客积分应用"></iframe><script>
let frame=document.querySelector('iframe');const result=document.querySelector('#result');let errors=[];
frame.onload=e=>{const w=e.currentTarget.contentWindow;if(!w)return;w.addEventListener('error',e=>errors.push({kind:'error',message:e.message}));w.addEventListener('unhandledrejection',e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}))};
async function ctl(path){const r=await fetch(${JSON.stringify(control)}+path,{method:'POST'});if(!r.ok)throw Error(await r.text());return r.json()}
function open(){errors=[];const old=frame,fresh=old.cloneNode(false);fresh.removeAttribute('src');fresh.onload=old.onload;frame=fresh;old.replaceWith(fresh);frame.src='/__h5#/pages/user/points'}
for(const b of document.querySelectorAll('[data-owner]'))b.onclick=async()=>{try{const uid=Number(b.dataset.owner),data=await ctl('/owner?uid='+uid);if(uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:data.token}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}))}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid')}open()}catch(e){result.textContent=String(e)}};
document.querySelector('#expiry-off').onclick=async()=>{try{await ctl('/expiry-off');open()}catch(e){result.textContent=String(e)}};
document.querySelector('#reload').onclick=()=>{errors=[];frame.contentWindow.location.reload()};document.querySelector('#wide').onclick=()=>{frame.style.width='1000px'};
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{b.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,shown=n=>!!n&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&w.getComputedStyle(n).display!=='none',p=[...d.querySelectorAll('uni-page')].filter(shown).at(-1)||d,txt=n=>(n?.textContent||'').trim(),images=n=>[...n.querySelectorAll('img')].map(i=>({src:i.src,currentSrc:i.currentSrc,complete:i.complete,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,className:i.className,parentClassName:i.parentElement?.className||''})),records=n=>[...n.querySelectorAll('[data-points-record-id]')].map(row=>({id:Number(row.getAttribute('data-points-record-id')),mark:txt(row.querySelector('.ledger-mark')),time:txt(row.querySelector('.ledger-time')),amount:txt(row.querySelector('.ledger-amount')),source:txt(row.querySelector('.ledger-source')),text:row.innerText})),num=selector=>{const n=p.querySelector(selector);return n?Number(txt(n)):null},button=p.querySelector('.sign-button');
const data={captured_at_ms:Date.now(),href:w.location.href,frameWidth:frame.clientWidth,viewportWidth:w.innerWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:p.innerText,errors:[...errors],statuses:[...p.querySelectorAll('[role="alert"],[role="status"]')].filter(n=>shown(n)&&!n.classList.contains('points-notice')).map(n=>n.innerText).filter(Boolean),images:images(d),current_images:images(p),summary:{balance:num('[data-points-balance]'),income:num('[data-points-income]'),expense:num('[data-points-expense]'),frozen:num('[data-points-frozen]')},notice:txt(p.querySelector('.points-notice')),sign_task:!!p.querySelector('[data-points-sign-task]'),records:records(p),groups:[...p.querySelectorAll('[data-points-month]')].map(group=>({month:group.getAttribute('data-points-month'),title:txt(group.querySelector('.month-title')),records:records(group)})),buttons:[...p.querySelectorAll('button,uni-button')].map(n=>txt(n)),mall_balance:txt(p.querySelector('.points-num')),sign_button:button?{text:txt(button),disabled:(button.hasAttribute('disabled')&&button.getAttribute('disabled')!=='false')||button.getAttribute('aria-disabled')==='true'||button.classList.contains('uni-button-disabled')}:null};
const r=await fetch(${JSON.stringify(control)}+'/phase/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});result.textContent=await r.text()}catch(e){result.textContent=String(e)}finally{b.disabled=false}};
</script></html>`;
    const host=createServer((req,res)=>{void(async()=>{
      expect(req.socket.remoteAddress).toBe('127.0.0.1');expect(req.headers.host).toBe('127.0.0.1:40839');const url=new URL(req.url??'/',origin);
      if(url.pathname.startsWith(control)){expect(req.method).toBe('POST');
        if(url.pathname===control+'/owner'){const uid=Number(url.searchParams.get('uid'));expect([0,11,22]).toContain(uid);expect(pending).toBe(0);owner=uid;controls.push({kind:'qa-session',issued_actor_hint:uid,stage:stage(),at_ms:Date.now()});json(res,{token:tokens.get(uid)??''});return;}
        if(url.pathname===control+'/expiry-off'){await serial(async()=>{expect(stage()).toBe('expiry-off');expect(owner).toBe(11);expect(expiryOff).toBe(false);const before=await snapshot(),beforeResources=resources();expect(before).toEqual(expected);await f.db.update(systemConfig).set({value:'0'}).where(and(eq(systemConfig.isStore,0),eq(systemConfig.menuName,'integral_effective_status')));const after=await snapshot(),want=structuredClone(before);expect(want.system_config.filter(row=>row.menu_name==='integral_effective_status'&&row.is_store===0)).toHaveLength(1);want.system_config=want.system_config.map(row=>row.menu_name==='integral_effective_status'&&row.is_store===0?{...row,value:'0'}:row);expect(after).toEqual(sortedDiyState(want));expect(resources()).toEqual(beforeResources);expect(resources()).toEqual(initialResources);expected=after;expiryOff=true;f.cache.clear();setups.push({kind:'qa-expiry-off',before:remember(before),after:remember(after),resources_before:beforeResources,resources_after:resources(),at_ms:Date.now()});await persist();json(res,{expiry:false});});return;}
        if(url.pathname.startsWith(control+'/phase/')){const data=JSON.parse((await body(req,undefined,524_288)).toString());await serial(async()=>{const name=url.pathname.slice((control+'/phase/').length);await capture(name,data);json(res,{accepted:true,name,complete:evidence.length===plans.length,next:stage(),actual_dispatched:traces.length,actual_readonly_responses:traces.length,business_writes:0,cancelled:controls.filter(c=>c.kind==='cancelled-before-dispatch').length,qa_setups:setups.length});});return;}
        throw Error('Unknown owned points control');
      }
      if(url.pathname.startsWith('/api/')){await api(req,res,url);return;}
      expect(req.method).toBe('GET');if(url.pathname==='/'){send(res,shell);return;}if(url.pathname==='/favicon.ico'){send(res,'',204,'image/x-icon');return;}
      const decoded=decodeURIComponent(url.pathname),target=decoded==='/__h5'?resolve(dist,'index.html'):resolve(dist,'.'+decoded);expect(target.startsWith(dist+sep)).toBe(true);let raw=await readFile(target);if(target===resolve(dist,'index.html'))raw=Buffer.from(raw.toString().replace('<head>','<head><link rel="icon" href="data:,">'));
      const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.gif':'image/gif','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf'};staticPaths.push({path:decoded,file:target.slice(dist.length+1),bytes:raw.length,sha256:hash(raw),status:200,index_transform:target===resolve(dist,'index.html')?'insert-data-favicon-after-head':null});send(res,raw,200,types[extname(target)]??'application/octet-stream');
    })().catch(error=>{failure??=error;controls.push({kind:'server-error',method:req.method,url:req.url,stage:stage(),error:String(error)});void persist().then(()=>fail(error),saveError=>fail(saveError));if(!res.headersSent&&!res.destroyed)send(res,String(error),500,'text/plain');else res.destroy();});});
    server=host;host.on('upgrade',(_req,socket)=>{const error=Error('Points-centre Browser must not open provider sockets');failure??=error;fail(error);socket.destroy();});timer=setTimeout(()=>fail(Error('Points-centre Browser timed out')),50*60_000);await new Promise<void>((yes,no)=>{host.once('error',no);host.listen(40839,'127.0.0.1',yes);});
    await writeFile(prefix+'ready.json',JSON.stringify({origin,plans,prefix,control,table_count:tableNames.length,sequence_count:sequenceNames.length,additional_tables:additionalTables,source_count:sourceBefore.length,build_count:buildBefore.length,seed:{uid:11,wallet:75,ledger_count:23,ledger_ids_desc:ownedRows.map(row=>row.id).reverse(),other_uid:22,other_wallet:-7,other_ledger_count:0,lottery_id:lottery.id,expiry_enabled:true},boundary:'Actual registered Worker APIs, JWT auth, owned PG and H5. sign/user POST is read-only. One exact QA expiry configuration change is independent of zero business writes. No sign/reminder, exchange, order, cart or lottery draw is dispatched. QA session bootstrap is not login-form or independent LOGIN ACL proof.'},null,2)+'\n',{mode:0o600});
    console.log('CUSTOMER_POINTS_CENTRE_BROWSER_READY '+origin);await completion;await queue;
    await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed',plans,evidence,traces,controls,setups,staticPaths,snapshots_by_sha256:snapshots,fixture_setup:{before:setupBefore,after:baseline},final:expected,resources_before:initialResources,resources_after:resources(),sourceBefore,sourceAfter:await sources(),buildBefore,buildAfter:await artifacts()},null,2)+'\n',{mode:0o600});
  }catch(error){failure??=error;await writeFile(prefix+'failed.json',JSON.stringify({status:'failed',error:String(error),stack:error instanceof Error?error.stack:null,failedDispatch,evidence,traces,controls,setups,staticPaths,snapshots_by_sha256:snapshots,latest_expected:expected},null,2)+'\n',{mode:0o600});throw error;}
  finally{clearTimeout(timer);let cleanupFailure:unknown,fixtureClosed=false;try{if(server){server.closeAllConnections();if(server.listening)await new Promise<void>((yes,no)=>server!.close(error=>error?no(error):yes()));}}catch(error){cleanupFailure=error;}try{await f.close();fixtureClosed=true;}catch(error){cleanupFailure??=error;}wiring.container=undefined;vi.restoreAllMocks();await writeFile(prefix+'cleanup.json',JSON.stringify({server_created:!!server,server_closed:!server?.listening,fixture_closed:fixtureClosed,failure:failure?String(failure):null,cleanup_failure:cleanupFailure?String(cleanupFailure):null})+'\n',{mode:0o600});if(cleanupFailure)throw cleanupFailure;}
},54*60_000);
