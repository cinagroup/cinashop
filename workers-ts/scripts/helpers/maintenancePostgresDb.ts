/** Explicit CLI maintenance connection only. It reuses server plans, never
 * rows or authorization results. Runtime/Hyperdrive DI remains prepare:false.
 * Every maintenance author still owns its transaction, gates and full proofs. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import * as schema from '../../src/models/schema';

export interface MaintenancePostgresTarget {
 readonly database:string;
 readonly databaseOid:string;
 readonly maintenance:string;
 readonly maintenanceOid:string;
}
const identifier=/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const oid=/^[1-9][0-9]{0,9}$/u;

/** Conservative extended-protocol eligibility, never a SQL authorizer.
 * WITH may include writes: all caller SQL still executes with identical facts.
 * Ambiguous quoting or multiple commands retain the original unsafe protocol. */
export function oneMaintenanceSelect(text:string):boolean {
 let keyword='',terminated=false;
 for(let i=0;i<text.length;) {
  const c=text[i],n=text[i+1];
  if(/\s/u.test(c)){i++;continue;}
  if(c==='-'&&n==='-'){const end=text.indexOf('\n',i+2);if(end<0)break;i=end+1;continue;}
  if(c==='/'&&n==='*'){
   let depth=1;i+=2;
   while(i<text.length&&depth){if(text[i]==='/'&&text[i+1]==='*'){depth++;i+=2;}else if(text[i]==='*'&&text[i+1]==='/'){depth--;i+=2;}else i++;}
   if(depth)return false;continue;
  }
  if(terminated)return false;
  if(!keyword){const word=text.slice(i).match(/^[A-Za-z]+/u)?.[0];if(!word)return false;keyword=word.toUpperCase();if(keyword!=='SELECT'&&keyword!=='WITH')return false;i+=word.length;continue;}
  if(c===';'){terminated=true;i++;continue;}
  if(c==="'"||c==='"'){
   const quote=c;let closed=false;i++;
   while(i<text.length){if(text[i]==='\\'&&quote==="'")return false;if(text[i]===quote){if(text[i+1]===quote){i+=2;continue;}i++;closed=true;break;}i++;}
   if(!closed)return false;continue;
  }
  if(c==='$'){
   const delimiter=text.slice(i).match(/^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/u)?.[0];
   if(delimiter){const end=text.indexOf(delimiter,i+delimiter.length);if(end<0)return false;i=end+delimiter.length;continue;}
  }
  i++;
 }
 return keyword==='SELECT'||keyword==='WITH';
}

/** postgres-js connection prepare:true AND unsafe prepare:true are both
 * necessary. Explicit caller protocol options are always preserved. */
function preparedMaintenanceSql<T extends object>(client:T) {
 const counts={unsafeCalls:0,preparedCalls:0,unchangedCalls:0,transactionScopes:0};
 const wrappers=new WeakMap<object,object>();
 const wrap=<S extends object>(raw:S):S=>{
  const known=wrappers.get(raw);if(known)return known as S;
  const wrapped=new Proxy(raw,{get(value,key,receiver){
   const original=Reflect.get(value,key,receiver);
   if(key==='unsafe'&&typeof original==='function')return(...input:unknown[])=>{
    const text=input[0];if(typeof text!=='string')return Reflect.apply(original,value,input);
    const parameters=Array.isArray(input[1])?input[1]:[];
    const supplied=(Array.isArray(input[1])?input[2]:input[1])??{};
    counts.unsafeCalls++;
    if(supplied&&typeof supplied==='object'&&!Array.isArray(supplied)
     &&!Object.hasOwn(supplied,'prepare')&&!Object.hasOwn(supplied,'simple')&&oneMaintenanceSelect(text)){
     counts.preparedCalls++;
     return Reflect.apply(original,value,[text,parameters,{...supplied,prepare:true,simple:false}]);
    }
    counts.unchangedCalls++;
    return Reflect.apply(original,value,input);
   };
   if((key==='begin'||key==='savepoint')&&typeof original==='function')return(...input:unknown[])=>{
    let index=-1;for(let i=input.length-1;i>=0;i--)if(typeof input[i]==='function'){index=i;break;}
    if(index<0)return Reflect.apply(original,value,input);
    const callback=input[index] as (tx:object)=>unknown,copy=[...input];
    copy[index]=(tx:object)=>{counts.transactionScopes++;return callback(wrap(tx));};
    return Reflect.apply(original,value,copy);
   };
   return typeof original==='function'?original.bind(value):original;
  }});
  wrappers.set(raw,wrapped);return wrapped;
 };
 return{client:wrap(client),counts};
}

/** Direct target and exact catalog identities must already have been reviewed
 * by the CLI caller. This origin check does not authorize a deployment or
 * replace any maintenance author's complete before/after profile inspection.
 * Call close() in finally; never store this owner client in a runtime Env. */
export async function openPreparedMaintenanceDb(input:{
 readonly connectionString:string;
 readonly target:MaintenancePostgresTarget;
 readonly applicationName:string;
 readonly prepareSelects:true;
}) {
 const target={...input.target},applicationName=input.applicationName;
 if(input.prepareSelects!==true||!identifier.test(target.database)||!identifier.test(target.maintenance)
  ||!oid.test(target.databaseOid)||!oid.test(target.maintenanceOid)
  ||BigInt(target.databaseOid)>4294967295n||BigInt(target.maintenanceOid)>4294967295n
  ||!/^[A-Za-z0-9._-]{1,63}$/u.test(applicationName))throw Error('Explicit exact maintenance target required');
 let url:URL;
 try{url=new URL(input.connectionString);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.search||url.hash
   ||decodeURIComponent(url.pathname.slice(1))!==target.database
   ||decodeURIComponent(url.username)!==target.maintenance)throw Error('target');
 }catch{throw Error('Explicit direct maintenance URL differs from reviewed target');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 const raw=postgres(url.href,{max:1,prepare:true,connect_timeout:5,idle_timeout:0,max_lifetime:0,
  ssl:loopback?false:'verify-full',
  connection:{application_name:applicationName,
   options:'-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000'}});
 const wrapped=preparedMaintenanceSql(raw),db=drizzle(wrapped.client,{schema}) as unknown as DbClient;
 try{
  const [identity]=await db.execute<{database:string;databaseOid:string;role:string;oid:string;pid:number;host:string;port:number;safe:boolean}>(sql`SELECT
   current_database() AS database,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
   current_user AS role,r.oid::text AS oid,pg_backend_pid() AS pid,host(inet_server_addr()) AS host,inet_server_port() AS port,
   current_user=session_user AND current_setting('role')='none' AND r.rolsuper AND r.rolcanlogin
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid() AND usesysid=r.oid)
   AND current_setting('server_version_num')::integer/10000=16
   AND current_setting('session_replication_role')='origin'
   AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off' AS safe
   FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if(identity?.safe!==true||identity.database!==target.database||identity.databaseOid!==target.databaseOid
   ||identity.role!==target.maintenance||identity.oid!==target.maintenanceOid)
   throw Error('Actual direct PG16 maintenance LOGIN/database/context differs from reviewed target');
  return{db,identity,counts:wrapped.counts,close:()=>raw.end({timeout:5})};
 }catch(error){await raw.end({timeout:5});throw error;}
}
