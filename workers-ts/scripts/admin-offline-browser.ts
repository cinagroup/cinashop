/** Opt-in joined acceptance host for the installed Browser plugin. Start only
 * through run-local-finance-postgres.mjs --schema-maintenance ...
 * audit:admin-offline-browser. No browser driver, production credentials, or
 * artifacts are written. Fixture controls affect only the owned random PG16 DB.
 * A successful finish proves SQL/HTTP checkpoints, NOT unobserved UI assertions. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { eq, sql } from 'drizzle-orm';
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse } from 'miniflare';
import { createContainerFromDb } from '../src/lib/di';
import * as schema from '../src/models/schema';
import { runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { OFFLINE_RUNTIME_READ_TABLES } from '../src/migrations/offlineOrderRuntimeContract';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { createToken, md5 } from '../src/utils/jwt';
import { sequenceRunnerDatabase, validateSequenceRunnerTestUrl } from '../test/helpers/kefuSequenceRunnerDatabase';
import { seedHistoricalZeroOfflineOrder } from '../test/helpers/offlineLegacyZeroFixture';

assert.ok(process.env.TEST_FINANCE_POSTGRES_URL, 'Explicit owned PG16 required');
validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL);
const dist = resolve(import.meta.dirname, '../../view/admin-ts/dist');
assert.ok((await stat(resolve(dist, 'index.html'))).isFile(), 'Build Admin first');
const f = await sequenceRunnerDatabase();
assert.equal(f.format, 'pg16');
assert.ok(f.withRuntimeRole);
const secret = randomUUID(), password = randomUUID().replaceAll('-',''), control = '/__fixture/' + randomUUID();
const token = (await createToken(2, 'admin', md5(password), secret)).token;
const expired = (await createToken(2, 'admin', md5(password), secret, 'cinashop', Math.floor(Date.now()/1000)-8*86400)).token;
const session = { userInfo: { id:2, account:'本机 PG 只读账号', head_pic:'', real_name:'本地验收', level:1, roles:'1' },
  menus:[{id:1,pid:0,path:'/order',name:'订单管理',icon:'',sort:1,type:1,children:[]}], uniqueAuth:['order.view'] };
type Seen = { path:string; query:string; status:number; count?:number };
const seen: Seen[] = [], checkpoints: string[] = [];
let origin = '', outbound = 0, businessWrites = 0, passed = false;
function send(res: ServerResponse, body: string | Buffer, status = 200, mime = 'text/html; charset=utf-8') {
  res.writeHead(status, {'Content-Type':mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(body);
}
const json = (res:ServerResponse, data:unknown, status=200) => send(res, JSON.stringify(data),status,'application/json; charset=utf-8');
const fingerprint = async () => {
  const hash=createHash('sha256');
  for(const table of OFFLINE_RUNTIME_READ_TABLES) hash.update(JSON.stringify((await f.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM public."${table}" t`)).rows));
  return hash.digest('hex');
};
try {
  const kit=await import('drizzle-kit/api');
  const ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(schema))).join('\n');
  await f.db.transaction(tx=>tx.execute(sql.raw(ddl))); await runOfflineOrderSchema(f.db,true);
  await f.db.insert(schema.user).values({uid:11,account:'owned-offline-buyer',pwd:password,nickname:'PG_会员%甲',nowMoney:'100.00',integral:50,isEverLevel:1});
  await f.db.insert(schema.systemConfig).values([{menuName:'member_card_status',value:'1'},{menuName:'order_give_integral',value:'1'},
    {menuName:'balance_func_status',value:'1'},{menuName:'yue_pay_status',value:'1'}]);
  await f.db.insert(schema.memberRight).values([{rightType:'offline',number:80,status:1},{rightType:'integral',number:2,status:1}]);
  await f.db.insert(schema.systemAdmin).values({id:2,account:'owned-offline-admin',pwd:password,level:1,roles:'1',adminType:1});
  await f.db.insert(schema.systemRole).values({id:1,roleName:'owned offline viewer',rules:'order.view'});
  const container=createContainerFromDb(f.db);
  for(let i=0;i<22;i++) {
    const order=await admitOfflineOrder(container,{uid:11,requestKey:randomUUID(),orderNo:'xx'+randomUUID().replaceAll('-','').slice(0,30),
      money:'12.50',expectedPayPrice:'10.00',from:'h5'});
    if(i===21) await payOfflineOrderBalance(container,{uid:11,orderNo:order.order_id});
  }
  await seedHistoricalZeroOfflineOrder(f.db);
  const before=await fingerprint();
  const bundle=await build({entryPoints:[resolve(import.meta.dirname,'../test/integration/AdminOfflineOrderHttpWorker.ts')],bundle:true,write:false,
    platform:'browser',format:'esm',target:'es2022',conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],
    tsconfig:resolve(import.meta.dirname,'../tsconfig.json')});
  await f.withRuntimeRole(async r=>{
    const tables=[...OFFLINE_RUNTIME_READ_TABLES,'system_admin','system_role','system_menus'];
    await f.exec(`GRANT SELECT ON ${tables.map(t=>`public."${t}"`).join(',')} TO "${r.role}";
      ALTER ROLE "${r.role}" SET default_transaction_read_only=on`);
    await r.exec('SET default_transaction_read_only=on');
    const privilege=await r.exec(`SELECT current_user=session_user AS login,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      current_setting('default_transaction_read_only') AS readonly FROM pg_roles WHERE rolname=current_user`);
    assert.deepEqual(privilege,[{login:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,readonly:'on'}]);
    const [rights]=await r.exec(`SELECT bool_or(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE')
      OR has_any_column_privilege(current_user,c.oid,'UPDATE') OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS writable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'`);
    assert.equal(rights.writable,false);
    const mf=new Miniflare(convertV4MiniflareOptions({script:bundle.outputFiles[0].text,modules:true,
      compatibilityDate:'2026-08-09',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,
      hyperdrives:{HYPERDRIVE:r.connectionString},kvNamespaces:['CONFIG_KV'],
      outboundService:async()=>{outbound++;return new LocalResponse(null,{status:503});},
      bindings:{APP_KEY:secret,NODE_ENV:'test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',OFFLINE_H5_RETURN_ORIGIN:'https://cinashop-h5.pages.dev'}}));
    let finish!:()=>void, fail!:(error:Error)=>void;
    const complete=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
    // Serialize owned fixture mutations; no arbitrary SQL/body values accepted.
    let action=Promise.resolve();
    const actions=['check','role-off','role-on','select-off','select-on','finish'];
    const controlHtml=()=>`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>PG16 线下收银联合验收</title><body><h1>PG16 线下收银联合验收</h1><p>实际 Admin / workerd / PostgreSQL，只读 LOGIN。仅登录壳与待办品牌为夹具；23条真实 SQL 合成订单，未连接生产或微信。</p>
      <button id="login">进入真实只读后台</button><button id="expired">使用过期测试会话</button><button id="logout">清除测试会话</button>
      <p>固定本地数据库控制：</p>${actions.map(a=>`<button data-action="${a}">${a}</button>`).join(' ')}<pre id="state">${JSON.stringify({checkpoints,requests:seen.length})}</pre>
      <script>const session=${JSON.stringify(session)};
      const login=token=>{localStorage.setItem('admin_token',token);localStorage.setItem('admin_session',JSON.stringify(session));location.href='/order/offline';};
      document.getElementById('login').onclick=()=>login(${JSON.stringify(token)});
      document.getElementById('expired').onclick=()=>login(${JSON.stringify(expired)});
      document.getElementById('logout').onclick=()=>{localStorage.removeItem('admin_token');localStorage.removeItem('admin_session');document.getElementById('state').textContent='已清除';};
      document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=await fetch(${JSON.stringify(control)}+'/'+b.dataset.action,{method:'POST'});document.getElementById('state').textContent=await r.text();}finally{b.disabled=false;}});</script></body></html>`;
    const server=createServer((req,res)=>{void(async()=>{
      if(req.headers.host!==new URL(origin).host) return send(res,'Invalid host',403,'text/plain');
      const url=new URL(req.url??'/',origin);
      if(req.method==='GET'&&url.pathname===control) return send(res,controlHtml());
      if(url.pathname.startsWith(control+'/')) {
        const name=url.pathname.slice(control.length+1);
        if(req.method!=='POST'||req.headers.origin!==origin||url.search||!actions.includes(name)) return send(res,'Invalid fixture action',403,'text/plain');
        action=action.then(async()=>{
          assert.equal(await fingerprint(),before,'Business rows changed');
          if(name==='role-off'||name==='role-on') await f.db.update(schema.systemRole).set({rules:name==='role-on'?'order.view':'product.view'}).where(eq(schema.systemRole.id,1));
          if(name==='select-off'||name==='select-on') await f.exec(`${name==='select-on'?'GRANT':'REVOKE'} SELECT ON public.offline_order_admission ${name==='select-on'?'TO':'FROM'} "${r.role}"`);
          assert.equal(await fingerprint(),before,'Fixture control changed business rows');
          if(name==='finish') {
            assert.ok(['role-off','role-on','select-off','select-on'].every(a=>checkpoints.includes(a)),'Missing fixture checkpoint');
            assert.ok(seen.some(x=>x.path.endsWith('scan_list')&&x.query.includes('before=')&&x.count===3),'Missing SQL second page');
            assert.ok(seen.some(x=>x.path.endsWith('scan_list')&&x.count===0),'Missing SQL empty filter');
            assert.ok(seen.filter(x=>x.path.includes('scan_detail')&&x.status===200).length>=2,'Missing real details');
            for(const type of ['0','1']) assert.ok(seen.some(x=>x.path.endsWith('offline_scan')&&x.query===`?type=${type}`&&x.status===200),'Missing code format');
            for(const status of [400011,503,410001]) assert.ok(seen.some(x=>x.status===status),'Missing actual rejection '+status);
            assert.equal(outbound,0);assert.equal(businessWrites,0);passed=true;
          }
          checkpoints.push(name);json(res,{checkpoint:name,businessRowsUnchanged:true,requests:seen.length,passed});
          if(name==='finish')finish();
        }).catch(error=>{send(res,'Acceptance checkpoint failed',500,'text/plain');fail(error instanceof Error?error:new Error('Checkpoint failed'));});
        return;
      }
      if(url.pathname==='/api/site_config') return json(res,{status:200,data:{site_name:'CinaShop',site_logo:'/logo.png',site_logo_square:'/logo.png',login_logo:'/logo.png',ico_path:'/favicon.ico',admin_login_slide:[]}});
      if(url.pathname==='/adminapi/new_push') return json(res,{status:200,data:{ordernum:0,inventory:0,commentnum:0,reflectnum:0,msgcount:0,sampled_at:Math.floor(Date.now()/1000)}});
      if(url.pathname.startsWith('/adminapi/')||url.pathname.startsWith('/api/')) {
        if(req.method!=='GET'){businessWrites++;return send(res,'No browser business writes',405,'text/plain');}
        // All business responses below come from real route/auth/SQL, never a
        // canned status. Do not forward arbitrary hosts, cookies or credentials.
        if(!/^\/adminapi\/order\/(scan_list|scan_detail\/\d+|offline_scan)$/.test(url.pathname)) return send(res,'Unexpected business route',404,'text/plain');
        const auth=req.headers['authori-zation']??req.headers.authorization;
        const result=await mf.dispatchFetch('http://localhost'+url.pathname+url.search,{headers:typeof auth==='string'?{Authorization:auth}:{}});
        assert.ok(result.headers.get('Cache-Control')?.includes('no-store'));
        const body=await result.text(),decoded=JSON.parse(body) as {status:number;data?:{list?:unknown[]}};
        seen.push({path:url.pathname,query:url.search,status:decoded.status,...(Array.isArray(decoded.data?.list)?{count:decoded.data.list.length}:{})});
        return send(res,body,result.status,'application/json; charset=utf-8');
      }
      if(req.method!=='GET') return send(res,'Method not allowed',405,'text/plain');
      const target=resolve(dist,'.'+decodeURIComponent(url.pathname));
      if(target!==dist&&!target.startsWith(dist+sep)) return send(res,'Not found',404,'text/plain');
      let file=target;try{if(!(await stat(file)).isFile())file=resolve(dist,'index.html');}catch{file=resolve(dist,'index.html');}
      const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml','.woff2':'font/woff2'};
      send(res,await readFile(file),200,mime[extname(file)]??'application/octet-stream');
    })().catch(error=>{if(!res.headersSent)send(res,'Local acceptance failure',500,'text/plain');fail(error instanceof Error?error:new Error('HTTP failure'));});});
    const timeout=setTimeout(()=>fail(new Error('Browser acceptance not finished within eight minutes')),8*60_000);
    try {
      await mf.ready;
      await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
      const address=server.address();assert.ok(address&&typeof address==='object');origin=`http://127.0.0.1:${address.port}`;
      console.log('OFFLINE_BROWSER_READY '+JSON.stringify({url:origin+control,orders:23,paid:1,legacyZero:1,readonly:privilege[0]}));
      await complete;
      console.log('OFFLINE_BROWSER_SQL_PASS '+JSON.stringify({checkpoints,seen,outbound,businessWrites,businessRowsUnchanged:await fingerprint()===before}));
    } finally {
      clearTimeout(timeout);
      server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await mf.dispose();
    }
  });
  assert.equal(passed,true);
} catch (error) {
  // Do not let a query wrapper print SQL parameters, JWTs or connection strings.
  const kind=error instanceof Error?error.name:'UnknownError';
  console.error('OFFLINE_BROWSER_FAILED '+JSON.stringify({kind}));process.exitCode=1;
} finally {await f.close();}
