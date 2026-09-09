import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { storeCart, systemStore } from '../src/models/schema';
import { readBargainShippingSelection } from '../src/services/activity/BargainShippingSelection';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain selector independent PG16 readers',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture();f.config.store_func_status='1';f.config.store_self_mention='1';
  await f.db.update(systemStore).set({isStore:1});
  await f.db.insert(storeCart).values({id:10,uid:11,productId:70,productAttrUnique:'qared001',cartNum:1,type:2,activityId:40,bargainUserId:80,isNew:1,status:1});
 },30_000);
 afterEach(async()=>{await f?.close();});
 it.each(['COMMIT','ROLLBACK'])('reads committed rules while writer is held, then observes %s without business writes',async finish=>{
  const before=await f.snapshot();
  await withFinancePeers(f.db,async([writer,reader])=>{
   await writer.exec("BEGIN; UPDATE store_bargain SET delivery_type='2' WHERE id=40; UPDATE system_store SET is_store=0 WHERE id=1");
   const read=()=>readBargainShippingSelection(createContainerFromDb(reader.db),f.env,11,[10]);
   expect(await read()).toMatchObject({shippingTypes:[1,2],stores:[{id:1}]});
   // Reader completed while the independent writer still owns its row locks.
   await writer.exec(finish);
   expect(await read()).toMatchObject({shippingTypes:finish==='COMMIT'?[]:[1,2]});
  });
  const after=await f.snapshot();
  for(const key of ['carts','products','skus','users','orders','bills','participations','helps','kv','kvWrites'] as const)expect(after[key]).toEqual(before[key]);
 },15_000);
});
