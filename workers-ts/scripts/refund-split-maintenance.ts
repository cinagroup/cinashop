/** Explicit offline maintenance only. No runtime URL fallback or auto-retry. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { inspectRefundOrderSplit, runRefundOrderSplit } from '../src/migrations/runRefundOrderSplit';

const [mode,database,role,confirmation,...extra]=process.argv.slice(2);
if(!['inspect','install','complete-orm'].includes(mode) || !database || !role || extra.length
  || (mode!=='inspect' ? confirmation!=='--confirm-install' : confirmation!==undefined))
  throw Error('Usage: tsx scripts/refund-split-maintenance.ts inspect|install|complete-orm <expected-database> <runtime-role> [--confirm-install]');
const target=process.env.REFUND_SPLIT_MAINTENANCE_DATABASE_URL;
if(!target) throw Error('Explicit REFUND_SPLIT_MAINTENANCE_DATABASE_URL is required; no runtime URL fallback');
let url: URL;
try{url=new URL(target);}catch{throw Error('Invalid maintenance database URL');}
if(!['postgres:','postgresql:'].includes(url.protocol) || !url.username || !url.hostname
  || decodeURIComponent(url.pathname.slice(1))!==database) throw Error('Maintenance database identity does not match explicit target');
if(url.search || url.hash) throw Error('Maintenance URL must not contain query options or fragments');
const client=postgres(target,{max:1,prepare:false,connect_timeout:5,idle_timeout:5,
  ssl:['127.0.0.1','localhost','[::1]'].includes(url.hostname) ? false : 'verify-full',
  connection:{options:'-c statement_timeout=30000 -c lock_timeout=1000 -c search_path=public,pg_temp'}});
try {
  const db=drizzle(client),[identity]=await db.execute(sql`SELECT current_database() AS database`);
  if(identity?.database!==database) throw Error('Connected maintenance database identity mismatch');
  const result=await(mode==='inspect' ? inspectRefundOrderSplit(db,role) : runRefundOrderSplit(db,role,mode==='complete-orm'));
  process.stdout.write(JSON.stringify({mode,...result})+'\n');
  if(result.state!=='v1' || !result.runtimeReady) process.exitCode=2;
}catch{
  process.stderr.write('Refund split maintenance failed; no automatic retry or evidence repair was attempted.\n');
  process.exitCode=1;
}finally{await client.end({timeout:5});}
