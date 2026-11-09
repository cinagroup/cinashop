/** Disposable local caller of the proposed CLI-only maintenance factory. */
import { openPreparedMaintenanceDb } from '../../scripts/helpers/maintenancePostgresDb';
import { ownsFinanceFixtureEndpoint,ownsFinanceFixtureTarget,validateFinanceFixtureUrl } from './financePostgres';
import type { RechargeRefundRuntimeProfileFixture } from './rechargeRefundRuntimeProfileNative';

export async function coldPreparedRechargeMaintenance(f:RechargeRefundRuntimeProfileFixture) {
 const base=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');
 if(!ownsFinanceFixtureTarget(f.target.database,'public',base.href)||f.binding.maintenance!=='finance_test'
  ||f.binding.database!==f.target.database)throw Error('Registered canonical local maintenance target required');
 // f.connectionString is the existing Financial LOGIN, never maintenance.
 const url=new URL(base.href);url.pathname='/'+f.target.database;
 const cold=await openPreparedMaintenanceDb({connectionString:url.href,target:f.binding,
  applicationName:'recharge_maintenance_prepared_drift',prepareSelects:true});
 try{
  if(cold.identity.pid===f.owner.pid||Object.values(f.identities).some(peer=>peer.pid===cold.identity.pid)
   ||!ownsFinanceFixtureEndpoint(cold.identity.database,'public',base.href,cold.identity.host,cold.identity.port))
   throw Error('Cold maintenance backend is not an independent registered local PID');
  return cold;
 }catch(error){await cold.close();throw error;}
}
