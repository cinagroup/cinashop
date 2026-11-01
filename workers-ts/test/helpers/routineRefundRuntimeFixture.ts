/** Real full migration/commissioning, independent App/Admin LOGINs. This
 * helper installs storage only and does not approve an account or send a refund. */
import { sql } from 'drizzle-orm';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '../../src/migrations/runRuntimeBusinessCommissioning';
import { runRoutineRefundUpgrade } from '../../src/migrations/runRoutineRefundUpgrade';
import type { RoutinePaymentRuntimeTarget } from '../../src/migrations/routinePaymentRuntime';

type Fixture=Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer=Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer:infer P)=>unknown?P:never;
export interface RoutineRefundRuntimeContext { f:Fixture;app:Peer;admin:Peer;target:RoutinePaymentRuntimeTarget }
export async function routineRefundRuntimeFixture<T>(run:(context:RoutineRefundRuntimeContext)=>Promise<T>,install=true):Promise<T> {
 const f=await refundRuntimeFixture();
 try {
  if(!f.withRuntimeRole)throw Error('Independent owned runtime LOGINs required');
  return await f.withRuntimeRole(app=>f.withRuntimeRole!(async admin=>{
   const [identity]=await f.db.execute<{database:string;maintenance:string}>(sql`SELECT current_database() AS database,current_user AS maintenance`);
   const target={...identity,app:app.role,admin:admin.role};
   await runRuntimeBusinessCommissioning(f.db,{...target,pricingOwner:f.pricingOwner});
   if(install)await runRoutineRefundUpgrade(f.db,target);
   return run({f,app,admin,target});
  }));
 }finally{await f.close();}
}
