import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {withTx,createContainerFromDb,type DbClient} from '@/lib/di';
import {storeOrder,storeOrderCartInfo,storeOrderRefund,systemRole,user,userBill} from '@/models/schema';
import {applyOrderRefundWithMaterialization,StoreOrderRefundService} from '@/services/order/StoreOrderRefundService';
import {prepareSupplierManualRefundApplication,authorizeSupplierManualRefundApplication,readSupplierManualRefundProof,
  prepareSupplierManualRefundExecution,persistSupplierManualRefundProof,readBoundManualRefundProof} from '@/services/supplier/SupplierManualRefundProof';
import {parseSupplierManualRefundIntent} from '@/services/supplier/SupplierManualRefundInput';
import {SupplierManualRefundService} from '@/services/supplier/SupplierManualRefundService';
import {supplierManualRefundFixture} from './helpers/supplierManualRefund';
import {supplierOrderEditActor,supplierOrderEditAppKey} from './helpers/supplierUnpaidOrderEdit';
import {customerWorkWriteoffFixture} from './helpers/customerWorkWriteoffFixture';
import {installSupplierManualRefund,assertSupplierManualRefundReady,lockSupplierManualRefundSources} from '@/migrations/supplierManualRefund';
import {customerManualRefundReadiness,inspectCustomerManualRefund} from '@/migrations/runCustomerManualRefund';
import {auditCheckoutPricingLockRuntime} from '@/migrations/checkoutPricingLock';
import {inspectCashierSecondCardPromotionLock} from '@/migrations/cashierSecondCardPromotionLock';
import {CustomerWorkFinancialService} from '@/services/customer-work/CustomerWorkFinancialService';
import {authorizeCustomerWorkActor} from '@/services/customer-work/CustomerWorkScope';
import {financialRevisions} from '@/services/customer-work/CustomerWorkFinancialReadService';
import {CUSTOMER_FINANCIAL_VERSION,CUSTOMER_FINANCIAL_QUOTE_VERSION,type FinancialInput} from '@/services/customer-work/CustomerWorkFinancialProtocol';
import type {CustomerJson} from '@/services/customer-work/CustomerWorkOperationRequest';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real Supplier offline cash refunds on independent LOGIN',()=>{
  let f:Awaited<ReturnType<typeof supplierManualRefundFixture>>;
  beforeEach(async()=>{f=await supplierManualRefundFixture();},120000);
  afterEach(async()=>{await f?.close();},30000);
  const paid=()=>f.paid();
  const snapshot=()=>f.manualSnapshot();
  const runtime=<T>(work:Parameters<typeof f.withManualRuntime<T>>[0])=>f.withManualRuntime(work);
  const application=(...args:Parameters<typeof f.apply>)=>f.apply(...args);
  const body=(...args:Parameters<typeof f.manualBody>)=>f.manualBody(...args);
  it('settles actual partial then remaining cash refunds, preserves buyer cash and replays one immutable original operation',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const beforeAccount=(await f.db.select().from(user).where(eq(user.uid,11)))[0],original=await runtime.order(id);
      const first=await application(runtime,id),request=await body(service,first),done=await service.execute(first,request,supplierOrderEditActor());
      expect(done).toMatchObject({state:'committed',result:{refund_id:first,status:'CASH_SUCCESS'}});
      const committed=await snapshot();expect(await service.execute(first,request,supplierOrderEditActor())).toEqual(done);expect(await snapshot()).toEqual(committed);
      const receipt=await runtime.receipt(first);expect(receipt?.remainingOrderId).not.toBeNull();
      const remaining=await runtime.order(receipt!.remainingOrderId!);const carts=await runtime.carts(remaining.id);
      const second=await withTx(runtime.container,async tx=>{
        await tx.execute(sql`LOCK TABLE ONLY public.system_admin,ONLY public.system_supplier,ONLY public.system_role,ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
        const cap=await prepareSupplierManualRefundApplication(tx,supplierOrderEditActor(),remaining);
        return applyOrderRefundWithMaterialization(createContainerFromDb(tx),{uid:remaining.uid,orderId:remaining.orderId,
          privilegedActor:'supplier',selectorNamespace:'row',supplierManualRefundCapability:cap,applyType:4,
          cartSelections:carts.map(c=>({cartId:c.id,cartNum:c.cartNum})),refundReason:'退回真实剩余现金',refundExplain:'',
          applicationOrderId:'srf'+randomUUID().replaceAll('-','').slice(0,27),authorizeApplication:async(_db,current)=>{expect(current.supplierId).toBe(7);}},0);
      });
      expect(await service.execute(second.refundId,await body(service,second.refundId),supplierOrderEditActor())).toMatchObject({state:'committed',result:{status:'CASH_SUCCESS'}});
      expect((await f.db.select().from(user).where(eq(user.uid,11)))[0].nowMoney).toBe(beforeAccount.nowMoney);
      const finalRecord=await runtime.receipt(second.refundId);
      const ids=(value:string):number[]=>{const parsed:unknown=JSON.parse(value);
        if(!Array.isArray(parsed)||!parsed.every((id:unknown)=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0))throw Error('Actual returned-point identities invalid');
        return parsed as number[];
      };
      const firstIds=ids(receipt!.returnedPointBillIds),secondIds=ids(finalRecord!.returnedPointBillIds);
      expect(firstIds.length).toBeGreaterThan(0);expect(secondIds.length).toBeGreaterThan(0);
      expect(firstIds.every(id=>!secondIds.includes(id))).toBe(true);
      const returned=await runtime.db.select().from(userBill).where(and(eq(userBill.uid,11),
        inArray(userBill.type,['pay_product_integral_back','order_integral_refund'])));
      expect(new Set(returned.map(row=>row.id))).toEqual(new Set([...firstIds,...secondIds]));
      expect(returned.every(row=>row.category==='integral'&&row.pm===1&&row.status===1&&row.eventKey===row.type)).toBe(true);
      expect(returned.filter(row=>row.type==='pay_product_integral_back').reduce((sum,row)=>sum+Number(row.number),0)).toBe(Number(original.useIntegral));
      expect((await f.db.select().from(user).where(eq(user.uid,11)))[0].integral).toBe(beforeAccount.integral+Number(original.useIntegral));
      const proofs=await f.db.execute<{amount:string}>(sql`SELECT amount FROM public.supplier_manual_refund_proof_v1 ORDER BY refund_id`);
      expect(proofs.reduce((n,x)=>n+BigInt(x.amount.replace('.','')),0n)).toBe(BigInt(remaining.payPrice.replace('.',''))+BigInt(done.result!.amount.replace('.','')));
      expect(await service.receipt(request.operation_id,supplierOrderEditActor())).toEqual(done);
    });
  },120000);
  it('rejects zeroed modern owners and a forged PHP tag on a protected modern refund generation without business DML',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),original=await runtime.carts(id);
      await f.db.update(storeOrderCartInfo).set({type:0,relationId:0}).where(eq(storeOrderCartInfo.oid,id));
      const corrupt=await snapshot();
      await expect(service.seed(refundId,supplierOrderEditActor())).rejects.toThrow('归属');
      await expect(service.execute(refundId,request,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
      expect(await snapshot()).toEqual(corrupt);
      // Rewriting the entire current cart into a financially valid PHP shape
      // still contradicts the protected modern source collected by Supplier.
      // This is stronger than deleting owner columns or attaching a tag.
      for(const row of original) {
        const info=JSON.parse(row.cartInfo!),product=info.product,sku=info.sku;
        for(const field of ['financial_version','product','sku','member_savings_version','paid_member','member_postage_price','member_coupon_price'])delete info[field];
        info.productInfo={id:row.productId,store_name:product.storeName,give_integral:product.giveIntegral,attrInfo:{...sku}};
        await f.db.update(storeOrderCartInfo).set({type:0,relationId:0,cartInfo:JSON.stringify(info)}).where(eq(storeOrderCartInfo.id,row.id));
      }
      const rewritten=await snapshot();
      await expect(service.seed(refundId,supplierOrderEditActor())).rejects.toThrow('归属');
      await expect(application(runtime,id)).rejects.toThrow('归属');
      await expect(service.execute(refundId,request,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
      expect(await snapshot()).toEqual(rewritten);
      for(const row of original)await f.db.update(storeOrderCartInfo).set({type:row.type,relationId:row.relationId,cartInfo:row.cartInfo}).where(eq(storeOrderCartInfo.id,row.id));
      await service.execute(refundId,request,supplierOrderEditActor());
      const first=await runtime.receipt(refundId),remainingId=first!.remainingOrderId!,remaining=await runtime.carts(remainingId);
      const final=await application(runtime,remainingId,0),finalBody=await body(service,final);
      for(const row of remaining)await f.db.update(storeOrderCartInfo).set({type:0,relationId:0,
        cartInfo:JSON.stringify({...JSON.parse(row.cartInfo!),legacy_php_financial_source:'original-php-purchase-facts-v1'})}).where(eq(storeOrderCartInfo.id,row.id));
      const forged=await snapshot();
      await expect(service.seed(final,supplierOrderEditActor())).rejects.toThrow('归属');
      await expect(service.execute(final,finalBody,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
      expect(await snapshot()).toEqual(forged);
    });
  },120000);
  it('settles complete raw PHP zero-owner purchases through partial and protected remaining cash refunds without relabelling the source',async()=>{
    const id=await f.paidPhp();await runtime(async(runtime,service)=>{
      const original=await runtime.order(id),purchased=await runtime.carts(id),account=(await f.db.select().from(user).where(eq(user.uid,11)))[0];
      expect(purchased.every(row=>row.type===0&&row.relationId===0&&!Object.hasOwn(JSON.parse(row.cartInfo!),'financial_version'))).toBe(true);
      const first=await application(runtime,id),firstResult=await service.execute(first,await body(service,first),supplierOrderEditActor());
      expect(firstResult).toMatchObject({state:'committed',result:{status:'CASH_SUCCESS'}});
      expect((await runtime.carts(id)).map(row=>row.cartInfo)).toEqual(purchased.map(row=>row.cartInfo));
      const split=await runtime.receipt(first),remainingId=split!.remainingOrderId!,remaining=await runtime.carts(remainingId);
      expect(remaining.every(row=>row.type===0&&row.relationId===0&&JSON.parse(row.cartInfo!).financial_version==='refund-order-line-finance-v1')).toBe(true);
      // A genuine marker cannot authorize changed merchandise on that child.
      const row=remaining[0];await f.db.update(storeOrderCartInfo).set({productType:3}).where(eq(storeOrderCartInfo.id,row.id));
      const corrupt=await snapshot();
      await expect(application(runtime,remainingId,0)).rejects.toThrow('归属');expect(await snapshot()).toEqual(corrupt);
      await f.db.update(storeOrderCartInfo).set({productType:row.productType}).where(eq(storeOrderCartInfo.id,row.id));
      const final=await application(runtime,remainingId,0),finalResult=await service.execute(final,await body(service,final),supplierOrderEditActor());
      expect(finalResult).toMatchObject({state:'committed',result:{status:'CASH_SUCCESS'}});
      expect(BigInt(firstResult.result!.amount.replace('.',''))+BigInt(finalResult.result!.amount.replace('.',''))).toBe(BigInt(original.payPrice.replace('.','')));
      const after=(await f.db.select().from(user).where(eq(user.uid,11)))[0];
      expect(after.nowMoney).toBe(account.nowMoney);expect(after.integral).toBe(account.integral+Number(original.useIntegral));
      expect((await runtime.carts(id)).map(row=>row.cartInfo)).toEqual(purchased.map(row=>row.cartInfo));
      expect(await f.exec('SELECT refund_id FROM public.supplier_manual_refund_proof_v1 ORDER BY refund_id')).toHaveLength(2);
    });
  },120000);
  it('rejects missing actual cash confirmation, wrong tenant and serialized manual capability with zero business effects',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),before=await snapshot();
      await expect(service.execute(refundId,{...request,cash_returned:false},supplierOrderEditActor())).rejects.toThrow();
      await expect(service.seed(refundId,{...supplierOrderEditActor(),supplierId:8})).rejects.toThrow();
      await expect(withTx(runtime.container,tx=>new StoreOrderRefundService(createContainerFromDb(tx),f.env).agreeRefund(refundId,
        {supplierManualRefund:JSON.parse('{}')}))).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
  },120000);
  it('recovers a committed UUID and seals only an absent UUID after actual manage withdrawal',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),committed=await service.execute(refundId,request,supplierOrderEditActor());
      await f.db.update(systemRole).set({rules:'supplier.order.view,supplier.refund.view'}).where(eq(systemRole.id,21));
      const beforeReplay=await snapshot();
      expect(await service.execute(refundId,request,supplierOrderEditActor())).toEqual(committed);
      expect(await snapshot()).toEqual(beforeReplay);
      expect(await service.receipt(request.operation_id,supplierOrderEditActor())).toEqual(committed);
      const uuid=randomUUID();expect(await service.receipt(uuid,supplierOrderEditActor())).toMatchObject({state:'unknown'});
      expect(await service.resolve(uuid,refundId,supplierOrderEditActor())).toMatchObject({state:'not_applied'});
      await expect(service.execute(refundId,{...request,operation_id:uuid},supplierOrderEditActor())).rejects.toThrow();
      const [refund]=await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)),[order]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,id));
      await withTx(runtime.container,tx=>readSupplierManualRefundProof(tx,refund,order));
    });
  },120000);
  it('recovers actual COMMIT-return loss using the same UUID without another refund or promotion deletion',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),transaction=runtime.db.transaction.bind(runtime.db);
      const fault=Object.create(runtime.db) as DbClient;
      Object.defineProperty(fault,'transaction',{value:async(run:Parameters<typeof runtime.db.transaction>[0])=>{
        await transaction(run);throw Error('Actual Supplier cash-refund COMMIT reply lost');
      }});
      const uncertain=new SupplierManualRefundService(createContainerFromDb(fault),supplierOrderEditAppKey,f.env);
      await expect(uncertain.execute(refundId,request,supplierOrderEditActor())).rejects.toThrow('COMMIT reply lost');
      const after=await snapshot(),saved=await service.receipt(request.operation_id,supplierOrderEditActor());
      expect(saved).toMatchObject({state:'committed',result:{refund_id:refundId,status:'CASH_SUCCESS'}});
      expect(await service.execute(refundId,request,supplierOrderEditActor())).toEqual(saved);expect(await snapshot()).toEqual(after);
      await expect(service.execute(refundId,{...request,refund_price:'0.01'},supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
      expect(await snapshot()).toEqual(after);
    });
  },120000);
  it('fails closed on missing proof SELECT and rolls back deferred account corruption with no operation or refund effects',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),before=await snapshot();
      await f.exec(`REVOKE SELECT ON public.supplier_manual_refund_proof_v1 FROM "${runtime.role}"`);
      await expect(service.execute(refundId,request,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:503});
      expect(await snapshot()).toEqual(before);
      await f.exec(`GRANT SELECT ON public.supplier_manual_refund_proof_v1 TO "${runtime.role}"`);
      await f.exec(`CREATE FUNCTION public.owned_supplier_refund_late_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.change_type='supplier_manual_refund' THEN UPDATE public."user" SET now_money=now_money+1 WHERE uid=11; END IF;
        RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER owned_supplier_refund_late_account AFTER INSERT ON public.store_order_status
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_supplier_refund_late_account()`);
      await expect(service.execute(refundId,request,supplierOrderEditActor())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
  },120000);
  it('keeps genuine independent authority and order writers as NOWAIT rejection instead of a successful cash refund',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),before=await snapshot();
      for(const statement of ['UPDATE public.store_order SET mark=mark WHERE id='+id,'UPDATE public.system_role SET rules=rules WHERE id=21']){
        await f.db.transaction(async maintenance=>{
          await maintenance.execute(sql.raw(statement));
          await expect(service.execute(refundId,request,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
        });
        expect(await snapshot()).toEqual(before);
      }
    });
  },120000);
  it('uses fixed source-lock capabilities to fence actual independent provider and promotion INSERT phantoms without runtime source DML',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const refundId=await application(runtime,id),request=await body(service,refundId),before=await snapshot();
      const [privileges]=await runtime.db.execute(sql`SELECT
        has_table_privilege(current_user,'public.store_order_refund_payment','UPDATE') AS payment_update,
        has_table_privilege(current_user,'public.store_order_promotions','UPDATE') AS promotion_update,
        has_table_privilege(current_user,'public.store_order_promotions','DELETE') AS promotion_delete`);
      expect(privileges).toEqual({payment_update:false,promotion_update:false,promotion_delete:false});
      const insertions=[
        `INSERT INTO public.store_order_refund_payment(refund_id,store_order_id,provider,out_refund_no,request_amount,total_amount)
          VALUES(${refundId},${id},'wechat','OWNED_CHANNEL_PHANTOM',1,1)`,
        `INSERT INTO public.store_order_promotions(oid,uid,promotions_id,product_id,promotions_price,add_time)
          VALUES(${id},11,999999,70,0.01,1)`];
      await withTx(runtime.container,async tx=>{
        await lockSupplierManualRefundSources(tx);
        for(const statement of insertions)await expect(f.db.transaction(async peer=>{
          await peer.execute(sql`SET LOCAL lock_timeout='150ms'`);await peer.execute(sql.raw(statement));
        })).rejects.toMatchObject({cause:{code:'55P03'}});
      });
      for(const statement of insertions)await expect(f.db.transaction(async peer=>{
        await peer.execute(sql.raw(statement));
        await expect(service.execute(refundId,request,supplierOrderEditActor())).rejects.toMatchObject({httpStatus:409});
        throw Error('Owned source phantom rolls back');
      })).rejects.toThrow('Owned source phantom rolls back');
      expect(await snapshot()).toEqual(before);
      expect(await service.execute(refundId,request,supplierOrderEditActor())).toMatchObject({state:'committed'});
    });
  },120000);
  it('binds opaque application and execution capabilities to the actual PG transaction and backend while allowing nested SAVEPOINTs',async()=>{
    const id=await paid();await runtime(async(runtime,service)=>{
      const order=await runtime.order(id),carts=await runtime.carts(id),before=await snapshot();
      await expect(prepareSupplierManualRefundApplication(runtime.db,supplierOrderEditActor(),order)).rejects.toThrow('原业务事务');
      const connection=postgres(runtime.connectionString,{max:1,prepare:false,connect_timeout:5,
        connection:{options:'-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000'}});
      try {
        const independent=drizzle(connection) as unknown as DbClient;
        const cap=await withTx(runtime.container,async tx=>{
          const app=await prepareSupplierManualRefundApplication(tx,supplierOrderEditActor(),order);
          await withTx(createContainerFromDb(tx),nested=>authorizeSupplierManualRefundApplication(nested,app,order,carts));
          await expect(withTx(createContainerFromDb(independent),peer=>authorizeSupplierManualRefundApplication(peer,app,order,carts))).rejects.toMatchObject({httpStatus:409});
          return app;
        });
        await expect(withTx(runtime.container,tx=>authorizeSupplierManualRefundApplication(tx,cap,order,carts))).rejects.toMatchObject({httpStatus:409});
        expect(await snapshot()).toEqual(before);
        const refundId=await application(runtime,id),request=await body(service,refundId),
          [refund]=await runtime.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)),prepared=await parseSupplierManualRefundIntent(refundId,request,supplierOrderEditActor());
        const pendingOrder=await runtime.order(id);
        await expect(prepareSupplierManualRefundExecution(runtime.db,supplierOrderEditActor(),prepared.intent,prepared.hash,pendingOrder,refund)).rejects.toThrow('原业务事务');
        const execution=await withTx(runtime.container,tx=>prepareSupplierManualRefundExecution(tx,supplierOrderEditActor(),prepared.intent,prepared.hash,pendingOrder,refund));
        const pending=await snapshot();
        await expect(withTx(runtime.container,tx=>persistSupplierManualRefundProof(tx,execution,refund,pendingOrder))).rejects.toMatchObject({httpStatus:409});
        await expect(withTx(createContainerFromDb(independent),peer=>persistSupplierManualRefundProof(peer,execution,refund,pendingOrder))).rejects.toMatchObject({httpStatus:409});
        expect(await snapshot()).toEqual(pending);
        // The genuine core opens nested transactions inside the original
        // service TX; both the factory and persistence must still succeed.
        expect(await service.execute(refundId,request,supplierOrderEditActor())).toMatchObject({state:'committed'});
      }finally{await connection.end({timeout:5});}
    });
  },120000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('explicit Customer and Supplier manual-refund feature composition',()=>{
  it('preserves ungranted old checkout and actual Customer cash refunds while strictly admitting only the commissioned combined LOGIN',async()=>{
    const old=await customerWorkWriteoffFixture(),channelLockOwner='composed_refund_channel_'+randomUUID().replaceAll('-','');let channelCreated=false;
    try {
      const original=await inspectCustomerManualRefund(old.maintenanceDb);
      expect((await customerManualRefundReadiness(old.db)).ready).toBe(true);
      expect((await old.ordinary()).paid).toBe(1);await old.reset();
      const [owner]=await old.maintenanceDb.execute<{identity:string}>(sql`SELECT pg_get_userbyid(proowner) AS identity
        FROM pg_catalog.pg_proc WHERE oid='public.customer_manual_refund_promotion_delete_v1(integer,integer)'::regprocedure`);
      await old.exec(`CREATE ROLE "${channelLockOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);channelCreated=true;
      await old.maintenanceDb.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner.identity,channelLockOwner}));
      expect(await inspectCustomerManualRefund(old.maintenanceDb)).toEqual(original);
      const [grants]=await old.db.execute(sql`SELECT has_function_privilege(current_user,
        'public.supplier_manual_refund_promotion_delete_v1(integer,integer)','EXECUTE') AS execute,
        has_table_privilege(current_user,'public.supplier_manual_refund_proof_v1','SELECT') AS proof_read`);
      expect(grants).toEqual({execute:false,proof_read:false});
      // This is a genuine new checkout in its existing transaction, not merely
      // a readiness query after swallowing a PostgreSQL permission exception.
      expect((await auditCheckoutPricingLockRuntime(old.db,'public','customer-work')).ready).toBe(true);
      expect((await old.ordinary()).paid).toBe(1);await old.reset();
      expect((await customerManualRefundReadiness(old.db)).ready).toBe(true);
      // The independently created old cash order must refund before any new
      // SELECT/EXEC grant, through its genuine frozen Customer LOGIN/profile.
      const cash=await old.cashier(11),service=new CustomerWorkFinancialService(old.container,old.env);
      const input=async(id:number,payload:CustomerJson):Promise<FinancialInput>=>{
        const [order]=await old.db.select().from(storeOrder).where(eq(storeOrder.id,id));
        const scope=await authorizeCustomerWorkActor(old.db,old.actor()),revision=await financialRevisions(old.db,order);
        return{version:CUSTOMER_FINANCIAL_VERSION,scope_key:scope.scope_key,order_id:id,
          expected_order_revision:revision.order_revision,expected_financial_revision:revision.financial_revision,payload};
      };
      const basis=await input(cash.order.id,{}),quote=(await service.reader.quote(old.actor(),{
        version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:basis.scope_key,order_id:cash.order.id,
        expected_order_revision:basis.expected_order_revision,expected_financial_revision:basis.expected_financial_revision,mode:'remaining',items:[]})).data;
      const created=await service.create({actor:old.actor(),request_key:randomUUID()},await input(cash.order.id,{
        mode:'remaining',items:[],quoted_price:quote.quoted_price,refund_price:quote.quoted_price,
        quote_fingerprint:quote.quote_fingerprint,reason:'真实旧Customer现金退款组合验收'}));
      expect(created.receipt?.outcome).toBe('refund-created');
      const id=Number(created.receipt!.evidence.refund_id),[refund]=await old.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,id));
      const review=(await service.reader.review(old.actor(),id,{refund_no:refund.orderId})).data;
      const executed=await service.execute('refund_execute',{actor:old.actor(),request_key:randomUUID()},await input(review.order_id,{
        refund_id:id,refund_no:review.refund_no,expected_refund_revision:review.refund_revision,review_fingerprint:review.review_fingerprint,
        decision:{apply_type:review.apply_type,refund_type:review.refund_type,received:false,cash_returned:true},refund_price:review.refund_price}));
      expect(executed).toMatchObject({receipt:{outcome:'cash-settled'},execution:{completed:true,status:'CASH_SUCCESS',verified:true}});
      expect(await old.exec('SELECT * FROM public.supplier_manual_refund_proof_v1')).toEqual([]);
      expect(await old.exec('SELECT * FROM public.customer_financial_manual_refund_v1')).toHaveLength(1);
      expect(await inspectCustomerManualRefund(old.maintenanceDb)).toEqual(original);
      expect((await old.db.execute(sql`SELECT has_table_privilege(current_user,'public.supplier_manual_refund_proof_v1','SELECT') AS read,
        has_function_privilege(current_user,'public.supplier_manual_refund_promotion_delete_v1(integer,integer)','EXECUTE') AS execute`))[0])
        .toEqual({read:false,execute:false});
      // New feature composition is an explicit owned maintenance choice. The
      // published Customer/default role profiles receive no automatic grant.
      await old.exec(`GRANT SELECT,INSERT ON public.supplier_manual_refund_operation_v1,public.supplier_manual_refund_proof_v1 TO "${old.role}";
        GRANT EXECUTE ON FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer),public.supplier_manual_refund_promotion_lock_v1(),public.supplier_manual_refund_channel_lock_v1() TO "${old.role}"`);
      await withTx(old.container,async tx=>{
        await assertSupplierManualRefundReady(tx);await lockSupplierManualRefundSources(tx);
        const [currentRefund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,id));
        const [currentOrder]=await tx.select().from(storeOrder).where(eq(storeOrder.id,currentRefund.storeOrderId));
        expect(await readBoundManualRefundProof(tx,currentRefund,currentOrder)).toHaveProperty('refund_id',id);
      });
      expect((await inspectCashierSecondCardPromotionLock(old.db,old.role)).ready).toBe(true);
      expect((await customerManualRefundReadiness(old.db)).ready).toBe(true);
      expect((await auditCheckoutPricingLockRuntime(old.db,'public','customer-work')).ready).toBe(true);
      // Partial or drifted composed privileges cannot silently exempt the new
      // definer from the independent pricing envelope.
      await old.exec(`REVOKE SELECT ON public.supplier_manual_refund_proof_v1 FROM "${old.role}"`);
      await expect(auditCheckoutPricingLockRuntime(old.db,'public','customer-work')).rejects.toMatchObject({httpStatus:503});
      await old.exec(`GRANT SELECT ON public.supplier_manual_refund_proof_v1 TO "${old.role}";
        ALTER FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) RESET ALL`);
      await expect(auditCheckoutPricingLockRuntime(old.db,'public','customer-work')).rejects.toMatchObject({httpStatus:503});
    }finally{try{if(channelCreated)await old.exec(`DROP OWNED BY "${channelLockOwner}";DROP ROLE "${channelLockOwner}"`);}finally{await old.close();}}
  },180000);
});
