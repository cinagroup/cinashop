import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { storeOrder,storeOrderCartInfo,userBill } from '@/models/schema/order';
import { storeOrderStatus } from '@/models/schema/order_refund';
import { runPurchaseCancellationEvidenceSchema } from '@/migrations/runPurchaseCancellationEvidence';
import { inspectPurchaseCancellationGiftEvidence } from '@/migrations/runPurchaseCancellationGiftEvidence';
import { storeOrderPurchasePhysicalOrigin } from '@/models/schema/purchase_physical_origin_evidence';
import { runPurchaseOriginEvidenceSchema,runPurchaseOriginEvidence } from '@/migrations/runPurchaseOriginEvidence';
import { PURCHASE_PHYSICAL_ORIGIN_DEFINITION_SQL } from '@/migrations/purchasePhysicalOriginEvidence';
import { PURCHASE_PHYSICAL_ORIGIN_STATE_SQL } from '@/migrations/purchasePhysicalOriginEvidenceCatalog';
import { inspectPurchasePhysicalOriginEvidence,runPurchasePhysicalOriginEvidenceSchema,
  runPurchasePhysicalOriginEvidence,completePurchasePhysicalOriginEvidenceOrm } from '@/migrations/runPurchasePhysicalOriginEvidence';
import { recordPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('physical origin controlled native PG16 installation',()=>{
  let f:Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async()=>{
    f=await sequenceRunnerDatabase();const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({storeOrder,storeOrderCartInfo}))).join('\n'));
    await runPurchaseOriginEvidenceSchema(f.db);
  },30000);
  afterEach(async()=>{await f?.close();},45000);
  const state=()=>inspectPurchasePhysicalOriginEvidence(f.db);
  const identities=()=>f.exec("SELECT oid::text,relfilenode::text,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid");
  const seed=async()=>{
    await f.db.insert(storeOrder).values({id:1,uid:11,orderId:'LOCAL-PHYSICAL',cartId:'1',totalNum:1});
    await f.db.insert(storeOrderCartInfo).values({id:1,oid:1,uid:11,productId:70,skuUnique:'sku70',cartId:'1',cartNum:1,
      surplusNum:1,splitSurplusNum:1,cartInfo:JSON.stringify({financial_version:'checkout-line-finance-v1',id:'1',cart_num:1,
        product:{id:70},sku:{id:1,unique:'sku70'},use_integral:'0'})});
  };
  it('diagnoses canonical native catalog without sampling or accepting drift',async()=>{
    await f.db.transaction(tx=>tx.execute(sql.raw(PURCHASE_PHYSICAL_ORIGIN_DEFINITION_SQL)));
    const [s]=await f.db.execute(sql.raw(PURCHASE_PHYSICAL_ORIGIN_STATE_SQL));
    const cte=PURCHASE_PHYSICAL_ORIGIN_STATE_SQL.slice(0,PURCHASE_PHYSICAL_ORIGIN_STATE_SQL.lastIndexOf('SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relation)'));
    const diag=await f.db.execute(sql.raw(cte+`SELECT (SELECT row_to_json(shape) FROM shape) AS shape,
      (SELECT ready FROM protection) AS protection,
      (SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,false),'type',contype,'noinherit',connoinherit))
        FROM pg_constraint WHERE conrelid='public.store_order_purchase_physical_origin'::regclass) AS constraints,
      (SELECT jsonb_agg(jsonb_build_object('name',p.proname,'body_match',p.prosrc=e.body,'cost',p.procost,'rows',p.prorows))
        FROM functions_live p JOIN functions_expected e ON e.name=p.proname) AS functions`));
    expect(s?.state,JSON.stringify(diag)).toBe('v1');
  });
  it('installs fresh, replays without replacing objects, and captures no historical rows',async()=>{
    expect(await state()).toEqual({state:'fresh',sourcesReady:true});await runPurchasePhysicalOriginEvidenceSchema(f.db);
    const before=await identities();await runPurchasePhysicalOriginEvidenceSchema(f.db);expect(await identities()).toEqual(before);
    expect(await state()).toEqual({state:'v1',sourcesReady:true});expect(await f.exec('TABLE public.store_order_purchase_physical_origin')).toEqual([]);
  });
  it('completes only the exact empty ORM table in place',async()=>{
    const api=await import('drizzle-kit/api');await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({storeOrderPurchasePhysicalOrigin}))).join('\n'));
    expect((await state()).state).toBe('orm-pending');const before=await identities();
    await expect(runPurchasePhysicalOriginEvidenceSchema(f.db)).rejects.toThrow();
    await completePurchasePhysicalOriginEvidenceOrm(f.db);expect(await identities()).toEqual(before);expect((await state()).state).toBe('v1');
  });
  it('does not adopt rows in an unprotected ORM table',async()=>{
    const api=await import('drizzle-kit/api');await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({storeOrderPurchasePhysicalOrigin}))).join('\n'));
    await f.exec("INSERT INTO public.store_order_purchase_physical_origin VALUES(1,11,'purchase-physical-origin-v1',0,1,'[{}]',CURRENT_TIMESTAMP)");
    await expect(completePurchasePhysicalOriginEvidenceOrm(f.db)).rejects.toThrow('empty');expect((await state()).state).toBe('orm-pending');
  });
  it('rejects a changed column default and never repairs it',async()=>{
    await runPurchasePhysicalOriginEvidenceSchema(f.db);await f.exec('ALTER TABLE public.store_order_purchase_physical_origin ALTER COLUMN total_num SET DEFAULT 1');
    expect((await state()).state).toBe('drift');await expect(runPurchasePhysicalOriginEvidenceSchema(f.db)).rejects.toThrow();
    expect(await f.exec("SELECT column_default FROM information_schema.columns WHERE table_name='store_order_purchase_physical_origin' AND column_name='total_num'"))
      .toEqual([{column_default:'1'}]);
  });
  it('rejects changed physical cancellation COST without replacing or repairing the function',async()=>{
    const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({storeOrderStatus,userBill}))).join('\n'));
    await runPurchaseCancellationEvidenceSchema(f.db);await runPurchasePhysicalOriginEvidenceSchema(f.db);
    expect((await inspectPurchaseCancellationGiftEvidence(f.db)).state).toBe('physical-v1');
    await f.exec('ALTER FUNCTION public.validate_purchase_cancellation_v1() COST 7');
    const before=await f.exec("SELECT oid::text,prosrc,procost FROM pg_proc WHERE oid='public.validate_purchase_cancellation_v1()'::regprocedure");
    expect((await inspectPurchaseCancellationGiftEvidence(f.db)).state).toBe('drift');
    await expect(runPurchasePhysicalOriginEvidenceSchema(f.db)).rejects.toThrow();
    expect(await f.exec("SELECT oid::text,prosrc,procost FROM pg_proc WHERE oid='public.validate_purchase_cancellation_v1()'::regprocedure")).toEqual(before);
  });
  it('rejects an additional capture-function attachment and leaves the extra trigger untouched',async()=>{
    await runPurchasePhysicalOriginEvidenceSchema(f.db);
    await f.exec('CREATE TRIGGER physical_extra_attachment BEFORE INSERT ON public.store_order FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_physical_origin_v1()');
    const before=await f.exec("SELECT oid::text,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='physical_extra_attachment'");
    expect((await state()).state).toBe('drift');await expect(runPurchasePhysicalOriginEvidenceSchema(f.db)).rejects.toThrow();
    expect(await f.exec("SELECT oid::text,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='physical_extra_attachment'")).toEqual(before);
  });
  it('rejects string-valued gift product identity before attempting physical line capture',async()=>{
    await runPurchasePhysicalOriginEvidenceSchema(f.db);await seed();
    const intent={version:'order-promotion-gifts-v1',promotions:[{id:1,tier_id:1,eligible_cart_ids:['1'],
      products:[{cart_id:'2',product_id:'70',sku_id:1,aux_id:1,quantity:1,unique:'sku70'}]}]};
    const failure=await f.db.transaction(async tx=>{
      await recordPurchaseOriginEvidence(tx,{orderId:1,buyerId:11});
      await tx.update(storeOrder).set({cartId:'1,2',totalNum:2,promotionsGive:JSON.stringify(intent)}).where(sql`${storeOrder.id}=1`);
      await tx.execute(sql`INSERT INTO public.store_order_purchase_physical_origin(order_id,buyer_id) VALUES(1,11)`);
    }).then(()=>null,error=>error);
    let cause=failure;for(let n=0;n<8 && cause && typeof cause==='object' && !('code' in cause);n++)cause=cause.cause;
    expect(cause).toMatchObject({code:'23514',message:'Physical origin gift identity invalid'});
    expect(await f.exec('TABLE public.store_order_purchase_origin')).toEqual([]);
    expect(await f.exec('TABLE public.store_order_purchase_physical_origin')).toEqual([]);
    expect(await f.exec('SELECT cart_id,total_num,promotions_give FROM public.store_order WHERE id=1'))
      .toEqual([{cart_id:'1',total_num:1,promotions_give:null}]);
  });
  it('commissions only SELECT/INSERT to a safe independent LOGIN and preserves append-only denial',async()=>{
    await runPurchasePhysicalOriginEvidenceSchema(f.db);
    await f.withRuntimeRole!(async peer=>{
      await f.exec(`GRANT SELECT,UPDATE(id) ON public.store_order,public.store_order_cart_info TO "${peer.role}"`);
      await runPurchaseOriginEvidence(f.db,peer.role);expect(await inspectPurchasePhysicalOriginEvidence(f.db,peer.role)).toMatchObject({runtimeReady:false});
      expect((await runPurchasePhysicalOriginEvidence(f.db,peer.role)).runtimeReady).toBe(true);
      await seed();await peer.db.transaction(async tx=>{await recordPurchaseOriginEvidence(tx,{orderId:1,buyerId:11});
        await tx.execute(sql`INSERT INTO public.store_order_purchase_physical_origin(order_id,buyer_id) VALUES(1,11)`);});
      expect(await peer.exec('SELECT total_num FROM public.store_order_purchase_physical_origin')).toEqual([{total_num:1}]);
      for(const command of ['UPDATE public.store_order_purchase_physical_origin SET total_num=2','DELETE FROM public.store_order_purchase_physical_origin','TRUNCATE public.store_order_purchase_physical_origin'])
        await expect(peer.exec(command)).rejects.toMatchObject({code:'42501'});
      for(const command of ['UPDATE public.store_order_purchase_physical_origin SET total_num=2','DELETE FROM public.store_order_purchase_physical_origin','TRUNCATE public.store_order_purchase_physical_origin'])
        await expect(f.exec(command)).rejects.toMatchObject({code:'42501'});
    });
  });
  it('rejects an old charged-origin xmin instead of backfilling physical evidence',async()=>{
    await runPurchasePhysicalOriginEvidenceSchema(f.db);await seed();
    await f.db.transaction(tx=>recordPurchaseOriginEvidence(tx,{orderId:1,buyerId:11}));
    await expect(f.db.transaction(tx=>tx.execute(sql`INSERT INTO public.store_order_purchase_physical_origin(order_id,buyer_id) VALUES(1,11)`))).rejects.toThrow();
    expect(await f.exec('TABLE public.store_order_purchase_physical_origin')).toEqual([]);
  });
  it('captures a new charged origin inside an actual savepoint without requiring origin UPDATE',async()=>{
    await runPurchasePhysicalOriginEvidenceSchema(f.db);await seed();
    await f.db.transaction(async tx=>{
      await tx.execute(sql`SAVEPOINT physical_creation`);await recordPurchaseOriginEvidence(tx,{orderId:1,buyerId:11});
      await tx.execute(sql`INSERT INTO public.store_order_purchase_physical_origin(order_id,buyer_id) VALUES(1,11)`);
      await tx.execute(sql`RELEASE SAVEPOINT physical_creation`);
    });
    expect(await f.exec('SELECT total_num,jsonb_array_length(lines) AS rows FROM public.store_order_purchase_physical_origin')).toEqual([{total_num:1,rows:1}]);
  });
});
