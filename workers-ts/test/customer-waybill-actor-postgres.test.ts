import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { CUSTOMER_WAYBILL_ACTOR_SQL } from '../src/migrations/customerWaybillActor';
import { inspectCustomerWaybillActor,runCustomerWaybillActor } from '../src/migrations/runCustomerWaybillActor';
import { CUSTOMER_WORK_OPERATION_SQL } from '../src/migrations/customerWorkOperation';
import { inspectCustomerWorkOperation,CUSTOMER_WORK_OPERATION_CATALOG_SQL } from '../src/migrations/runCustomerWorkOperation';
import { compositeCustomerWorkCatalogSql } from '../src/migrations/customerWorkCatalog';
import { CUSTOMER_CITY_DELIVERY_SQL } from '../src/migrations/customerCityDelivery';
import { outRequestHash } from '../src/services/out/OutIdempotency';

describe('native PG16 customer waybill actor catalog and maintenance',()=>{
  it('measures the exact immutable legacy 0091 and explicit forward plus customer ledger on native PG16',async()=>{
    const f=await sequenceRunnerDatabase();
    try {
      if(f.format!=='pg16')throw Error('Customer actor catalog measurement requires native PG16');
      await f.exec(readFileSync('migrations/0091_electronic_waybill_outbox.sql','utf8'));
      const legacy=await inspectCustomerWaybillActor(f.db);
      await f.exec(CUSTOMER_WAYBILL_ACTOR_SQL);
      const upgraded=await inspectCustomerWaybillActor(f.db);
      await f.exec(CUSTOMER_WORK_OPERATION_SQL);
      const ledger=await inspectCustomerWorkOperation(f.db),[shape]=await f.db.execute<{shape:unknown}>(sql.raw(CUSTOMER_WORK_OPERATION_CATALOG_SQL));
      await f.exec('CREATE TABLE system_store(id integer PRIMARY KEY)');await f.exec(CUSTOMER_CITY_DELIVERY_SQL);
      const [city]=await f.db.execute<{shape:unknown}>(sql.raw(compositeCustomerWorkCatalogSql({job:'customer_city_delivery_job',attempt:'customer_city_delivery_attempt',binding:'customer_city_delivery_binding'})));
      console.log('CUSTOMER_NATIVE_CATALOG_MEASUREMENT',JSON.stringify({legacy,upgraded,ledger,ledgerShape:shape.shape,city:{fingerprint:await outRequestHash(city.shape),shape:city.shape}}));
      expect(legacy.fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(upgraded.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(upgraded.fingerprint).not.toBe(legacy.fingerprint);
      await expect(f.exec("INSERT INTO order_waybill_job_action(job_id,request_key,action,previous_status,next_status,actor_type,actor_id,actor_service_id,supplier_id,reason) VALUES(1,'11111111-1111-4111-8111-111111111111','CLOSE_NO_RETRY','UNKNOWN','CLOSED','customer',1,0,0,'owned fixture')")).rejects.toThrow();
      await expect(f.exec("INSERT INTO order_waybill_job_action(job_id,request_key,action,previous_status,next_status,actor_type,actor_id,actor_service_id,supplier_id,reason) VALUES(1,'11111111-1111-4111-8111-111111111111','CLOSE_NO_RETRY','UNKNOWN','CLOSED','admin',1,9,0,'owned fixture')")).rejects.toThrow();
    } finally {await f.close();}
  },60000);
  it('explicit owner forward refuses rerun and rolls back an incompatible legacy catalog',async()=>{
    const f=await sequenceRunnerDatabase();
    try {
      if(f.format!=='pg16')throw Error('Customer actor maintenance requires native PG16');
      await f.exec(readFileSync('migrations/0091_electronic_waybill_outbox.sql','utf8'));
      const before=await inspectCustomerWaybillActor(f.db);expect(before.legacy).toBe(true);
      await f.exec('ALTER TABLE order_waybill_job ADD COLUMN unreviewed_identity integer');
      await expect(runCustomerWaybillActor(f.db)).rejects.toThrow('drift');
      await f.exec('ALTER TABLE order_waybill_job DROP COLUMN unreviewed_identity');
      // Dropped-column slots are intentionally excluded from the shape; the
      // remaining canonical bytes must still match before this forward.
      const forward=await runCustomerWaybillActor(f.db);expect(forward.after.ready).toBe(true);
      await expect(runCustomerWaybillActor(f.db)).rejects.toThrow('already upgraded');
    } finally {await f.close();}
  },60000);
});
