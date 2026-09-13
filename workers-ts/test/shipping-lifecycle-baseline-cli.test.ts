import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
const exec=promisify(execFile);
async function cli(values:Record<string,string>={},args:string[]=[]){
 const env={...process.env},allow=new Set(['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','LOCALAPPDATA']);
 for(const key of Object.keys(env))if(!allow.has(key))delete env[key];Object.assign(env,values);
 try{const r=await exec(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/audit-shipping-lifecycle-baseline.ts',...args],
  {cwd:resolve(import.meta.dirname,'..'),env,timeout:15000,windowsHide:true});return{code:0,...r};
 }catch(error){const e=error as {code?:number;stdout?:string;stderr?:string;killed?:boolean};
  if(typeof e.code!=='number'||e.killed)throw error;return{code:e.code,stdout:e.stdout??'',stderr:e.stderr??''};}
}
it('rejects implicit targets, arguments, URL options and unapproved remote access before any TCP connection',async()=>{
 let connections=0;const server=createServer(socket=>{connections++;socket.destroy();});server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw new Error('No sentinel port');
 const url=`postgresql://sentinel:synthetic-shipping-secret@127.0.0.1:${address.port}/fixture`;
 try{for(const [env,args] of [
  [{DATABASE_URL:url,TEST_FINANCE_POSTGRES_URL:url},[]],
  [{SHIPPING_BASELINE_DATABASE_URL:url},['--apply']],
  [{SHIPPING_BASELINE_DATABASE_URL:url+'?options=-c%20default_transaction_read_only=off'},[]],
  [{SHIPPING_BASELINE_DATABASE_URL:url+'#fragment'},[]],
  [{SHIPPING_BASELINE_DATABASE_URL:url.replace('postgresql:','https:')},[]],
  [{SHIPPING_BASELINE_DATABASE_URL:'postgresql://sentinel:synthetic-shipping-secret@unauthorized.invalid/fixture'},[]],
 ] as Array<[Record<string,string>,string[]]>){const r=await cli(env,args);expect(r.code).toBe(2);expect(r.stdout).toBe('');expect(r.stderr).not.toContain('synthetic-shipping-secret');}
 expect(connections).toBe(0);
 }finally{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
},30000);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real SELECT-only shipping baseline CLI',()=>{
 let f:Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
 beforeAll(async()=>{f=await sequenceRunnerDatabase();const api=await import('drizzle-kit/api'),models=await import('../src/models/schema');
  await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
  await f.exec("INSERT INTO shipping_templates(id,name) VALUES(10,'private-name'); INSERT INTO store_product(id,temp_id,freight) VALUES(100,10,3)");
 },120000);
 afterAll(async()=>{await f?.close();},45000);
 it('uses exit 0/1/2 for compatible/invalid/unreadable baselines without echoing credentials or repairing rows',async()=>{
  await f.withRuntimeRole!(async runtime=>{
   await f.exec(`GRANT SELECT ON shipping_templates,store_product,store_seckill,store_bargain,store_combination,store_integral,store_discounts_products TO "${runtime.role}"`);
   const input={SHIPPING_BASELINE_DATABASE_URL:runtime.connectionString},safe=await cli(input);
   expect(safe.code,safe.stderr).toBe(0);expect(JSON.parse(safe.stdout)).toMatchObject({baselineReady:true,futureWritesProtected:false});
   await f.exec('UPDATE shipping_templates SET status=0 WHERE id=10');
   const before=await f.query('SELECT id,temp_id,freight FROM store_product'),invalid=await cli(input);
   expect(invalid.code).toBe(1);expect(JSON.parse(invalid.stdout).tables.find((r:{table:string})=>r.table==='store_product')).toMatchObject({unavailableTemplate:1});
   expect(await f.query('SELECT id,temp_id,freight FROM store_product')).toEqual(before);
   await f.exec(`REVOKE SELECT ON shipping_templates FROM "${runtime.role}"`);const denied=await cli(input);
   expect(denied).toMatchObject({code:2,stdout:'',stderr:expect.stringContaining('could not complete')});
   const wrong=new URL(runtime.connectionString);wrong.password='synthetic-incorrect-password';const auth=await cli({SHIPPING_BASELINE_DATABASE_URL:wrong.href});
   expect(auth.code).toBe(2);
   const passwordless=new URL(runtime.connectionString);passwordless.password='';
   const inherited=await cli({SHIPPING_BASELINE_DATABASE_URL:passwordless.href,PGPASSWORD:decodeURIComponent(new URL(runtime.connectionString).password)});
   expect(inherited.code).toBe(2);
   for(const r of [safe,invalid,denied,auth,inherited])for(const value of [runtime.role,new URL(runtime.connectionString).password,'private-name','synthetic-incorrect-password'])
    expect(r.stdout+r.stderr).not.toContain(value);
  });
 },30000);
});
