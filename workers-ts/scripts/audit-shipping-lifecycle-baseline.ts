import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { auditShippingLifecycleBaseline } from '../src/migrations/auditShippingLifecycleBaseline';

// Explicit target only: never silently use DATABASE_URL, dotenv, an installed
// local server or Hyperdrive maintenance credentials. No apply/reset mode.
const connectionString=process.env.SHIPPING_BASELINE_DATABASE_URL;
let valid=false,remote=false;
try {
 const target=new URL(connectionString??'');
 remote=!['127.0.0.1','localhost','[::1]'].includes(target.hostname);
 valid=process.argv.length===2&&['postgres:','postgresql:'].includes(target.protocol)
  &&Boolean(target.hostname&&target.username&&target.pathname.length>1)&&!target.search&&!target.hash
  &&(!remote||process.env.SHIPPING_BASELINE_ALLOW_REMOTE==='1');
}catch{/* Parser errors can include secrets; never print them. */}
if(!valid||!connectionString){
 process.stderr.write('Set SHIPPING_BASELINE_DATABASE_URL explicitly; remote targets require SHIPPING_BASELINE_ALLOW_REMOTE=1. Arguments and URL options are not accepted. No database was contacted.\n');
 process.exitCode=2;
}else{
 for(const key of Object.keys(process.env))if(/^PG/i.test(key))delete process.env[key];
 let client:ReturnType<typeof postgres>|undefined;
 try{
  client=postgres(connectionString,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
   ssl:remote?{rejectUnauthorized:true}:false,
   connection:{options:'-c search_path=public,pg_temp -c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000'}});
  const result=await auditShippingLifecycleBaseline(drizzle(client));
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.baselineReady?0:1;
 }catch{
  process.stderr.write('Shipping baseline could not complete. No schema, grants, references or business data were modified.\n');
  process.exitCode=2;
 }finally{
  try{await client?.end({timeout:5});}
  catch{process.stderr.write('Shipping baseline connection cleanup could not be confirmed.\n');process.exitCode=2;}
 }
}
