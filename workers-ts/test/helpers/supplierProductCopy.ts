import { eq, getTableName, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { legacySaveSchema, legacySaveActor, legacySaveSku } from './adminLegacyProductSave';
import { editorProduct } from './adminProductEditor';
import { financePostgres, ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { SupplierProductCopyService } from '@/services/supplier/SupplierProductCopyService';
import { SUPPLIER_COPY_FIELDS } from '@/services/supplier/SupplierProductCopySource';
import { installSupplierProductCopyOperation } from '@/migrations/supplierProductCopyOperation';
import { md5 } from '@/utils/jwt';
import { storeProduct, storeProductAttrValue, storeProductVirtual, storeProductSkuRetirementLog, storeOrder,
  storeOrderCartInfo,userBill, systemAdmin, systemSupplier, systemRole, systemMenus, storeProductCategory,
  storeBrand, storeProductLabel, storeProductEnsure, legacyCategory, storeProductSpecs, userLabel,
  storeCouponIssue, shippingTemplates, systemForm, systemConfig, storeProductRule } from '@/models/schema';
export const supplierProductCopyAppKey='owned-native-supplier-product-copy-key';
export const supplierProductCopyPassword='owned-supplier-product-copy-password';
const schema={...legacySaveSchema,storeProductSkuRetirementLog,storeOrder,storeOrderCartInfo,userBill,storeProductRule};
export const supplierCopyActor=(id=21)=>({id,supplierId:id>=30?30:20,authVersion:md5(supplierProductCopyPassword),expiresAt:Math.floor(Date.now()/1000)+3600});

/** Repeated reset/seed writes can invite background maintenance. Isolate only
 * these two newly owned fixture tables' scheduling; production NOWAIT and the real
 * independent-session DML contention cases remain unchanged. The historical
 * CI 55P03 did not identify its blocker, so this does not attribute its cause. */
async function isolateSupplierCopyMaintenanceScheduling(f: Awaited<ReturnType<typeof financePostgres>>) {
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  type Scheduling = { database: string; search_schema: string; schema: string; table_name: string;
    host: string; port: number; version: number; role: string; table_oid: string; owner: string;
    kind: string; options: string[] | null };
  const evidence = await f.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    const capture = () => tx.execute<Scheduling>(sql`SELECT current_database() AS database,
      current_schema() AS search_schema,n.nspname AS schema,c.relname AS table_name,
      host(inet_server_addr()) AS host,inet_server_port() AS port,
      current_setting('server_version_num')::integer AS version,current_user AS role,
      c.oid::text AS table_oid,pg_get_userbyid(c.relowner) AS owner,c.relkind::text AS kind,c.reloptions AS options
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('store_order_outbox','store_product') ORDER BY c.relname`);
    const expected = ['store_order_outbox', 'store_product'], before = await capture();
    if (before.length !== expected.length || before.some((row, index) => row.search_schema !== 'public' || row.schema !== 'public'
      || row.table_name !== expected[index] || row.role !== 'finance_test' || row.owner !== row.role
      || row.kind !== 'r' || !/^[1-9]\d*$/.test(row.table_oid) || Math.floor(row.version / 10000) !== 16
      || !ownsFinanceFixtureEndpoint(row.database, row.schema, base.href, row.host, row.port)
      || row.options !== null && JSON.stringify(row.options) !== '["autovacuum_enabled=false"]')) {
      throw Error('Supplier copy scheduling requires its exact two owned native tables');
    }
    await tx.execute(sql`ALTER TABLE public.store_product SET (autovacuum_enabled=false)`);
    await tx.execute(sql`ALTER TABLE public.store_order_outbox SET (autovacuum_enabled=false)`);
    const after = await capture();
    if (after.length !== before.length || after.some((row, index) =>
      JSON.stringify({ ...row, options: before[index].options }) !== JSON.stringify(before[index])
      || JSON.stringify(row.options) !== '["autovacuum_enabled=false"]')) {
      throw Error('Supplier copy fixture table identity or scheduling changed unexpectedly');
    }
    return { before, after, historical_blocker_identified: false };
  });
  console.log('SUPPLIER_COPY_FIXTURE_MAINTENANCE_SCHEDULING ' + JSON.stringify(evidence));
}

export async function supplierProductCopyFixture(){
  const f=await financePostgres(Object.values(schema),{namespace:'public'}),container=createContainerFromDb(f.db);
  try{
    await isolateSupplierCopyMaintenanceScheduling(f);
    await f.db.transaction(tx=>installSupplierProductCopyOperation(tx));
    const service=new SupplierProductCopyService(container,supplierProductCopyAppKey);
    const seed=async()=>{
      // Owned fixture owner only: runtime evidence remains immutable.
      await f.db.transaction(async tx=>{await tx.execute(sql.raw('ALTER TABLE public.supplier_product_copy_operation_v1 DISABLE TRIGGER spco_immutable_truncate; TRUNCATE public.supplier_product_copy_operation_v1; ALTER TABLE public.supplier_product_copy_operation_v1 ENABLE TRIGGER spco_immutable_truncate'));});
      await f.reset();
      await f.db.insert(systemRole).values([{id:1,rules:'product.manage'},
        {id:21,type:4,relationId:20,rules:'supplier.product.manage'},
        {id:22,type:4,relationId:20,rules:'supplier.product.view'},
        {id:23,type:4,relationId:20,rules:'930081'},
        {id:31,type:4,relationId:30,rules:'supplier.product.manage'}]);
      await f.db.insert(systemSupplier).values([{id:20,adminId:29,supplierName:'owned-copy'},{id:30,adminId:39,supplierName:'foreign-copy'}]);
      await f.db.insert(systemAdmin).values([{id:1,account:'legacy-save',pwd:'legacy-save-password',roles:'1',level:1},
        ...[21,22,23,29,31,39].map(id=>({id,account:'supplier-copy-'+id,pwd:supplierProductCopyPassword,adminType:4,
          relationId:id>=30?30:20,roles:[29,39].includes(id)?'':String(id),level:[29,39].includes(id)?0:1}))]);
      await f.db.insert(systemMenus).values([
        {id:105,authType:2,apiUrl:'product/product/<id>',methods:'POST',menuPath:'/admin/product/save',uniqueAuth:'product-save'},
        {id:620,authType:2,apiUrl:'product/product/<id>',methods:'GET',menuPath:'',uniqueAuth:''},
        {id:930081,type:4,authType:2,apiUrl:'product/product/copy/<id>',methods:'GET',menuName:'Synthetic copy read'}]);
      await f.db.insert(systemConfig).values({menuName:'store_stock',value:'2'});
      await f.db.insert(storeProductCategory).values([{id:11,type:2,relationId:20,cateName:'Owned copy category'},{id:12,type:2,relationId:30,cateName:'Foreign category'}]);
      await f.db.insert(storeBrand).values({id:12,brandName:'Retained brand'});
      await f.db.insert(legacyCategory).values([{id:21,type:2,relationId:20,name:'Owned labels',group:2},{id:51,type:2,relationId:20,name:'Owned specs',group:3}]);
      await f.db.insert(storeProductLabel).values({id:31,type:2,relationId:20,labelCate:21,labelName:'Retained product label'});
      await f.db.insert(storeProductEnsure).values({id:41,name:'Retained assurance'});
      await f.db.insert(storeProductSpecs).values({id:52,type:2,relationId:20,tempId:51,name:'材质'});
      await f.db.insert(userLabel).values({id:61,type:2,relationId:20,name:'Retained user label'});
      await f.db.insert(storeCouponIssue).values({id:71,title:'Retained gift coupon',couponTitle:'Retained gift coupon'});
      await f.db.insert(systemForm).values({id:81,name:'Retained form',status:1,value:JSON.stringify([{name:'texts',title:'留言'}])});
      await f.db.insert(shippingTemplates).values({id:91,ownerType:2,relationId:20,name:'Owned shipping'});
      await f.exec("SELECT setval('public.store_product_id_seq',80,false)");
      const writer=new AdminLegacyProductSaveService(container),now=Math.floor(Date.now()/1000);
      const hidden={supplier_id:20,cate_id:[11],brand_id:[12],store_label_id:[31],ensure_id:[41],specs_id:51,
        specs:[{name:'材质',value:'羊毛',sort:0}],coupon_ids:[71],label_id:[61],is_sub:[0,1],give_integral:'2.50',
        is_hot:1,is_benefit:1,is_best:1,is_new:1,is_good:1,is_vip_product:1,command_word:'retained-command',
        is_presale_product:1,presale_time:[new Date((now+3600)*1000).toISOString(),new Date((now+7200)*1000).toISOString()],presale_day:2,
        auto_on_time:new Date((now+1800)*1000).toISOString(),auto_off_time:new Date((now+8000)*1000).toISOString(),
        custom_form:[{name:'texts',title:'原样留言'}],system_form_id:81,recommend_list:[82]};
      const physical=await writer.save(0,editorProduct({...hidden,store_name:'Copy physical source',freight:3,temp_id:91,
        soure_link:'https://owned-source.example/physical',attrs:[legacySaveSku({settle_price:'3.00',code:'source-sku-code'})]}),legacySaveActor());
      const card=await writer.save(0,editorProduct({supplier_id:20,cate_id:[11],store_name:'Copy card source',product_type:1,spec_type:1,
        items:[{value:'交付',detail:['固定','卡密']}],attrs:[
          legacySaveSku({detail:{交付:'固定'},settle_price:'3.00',stock:4,disk_info:'SYNTHETIC-SOURCE-FIXED-SECRET',virtual_list:[]}),
          legacySaveSku({detail:{交付:'卡密'},settle_price:'3.00',stock:0,disk_info:'',virtual_list:[{key:'SOURCE-CARD-A',value:'SOURCE-PASSWORD-A'},{key:'SOURCE-CARD-B',value:'SOURCE-PASSWORD-B'}]}),
        ]}),legacySaveActor());
      const manual=await writer.save(0,editorProduct({supplier_id:20,cate_id:[11],store_name:'Copy manual source',product_type:3,attrs:[legacySaveSku({settle_price:'3.00'})]}),legacySaveActor());
      if(physical.id!==80||card.id!==81||manual.id!==82)throw Error('Owned copy fixture source IDs changed');
      await f.db.update(storeProduct).set({isVerify:1,isShow:1,sales:17,codePath:'source-code-path',labelId:'61'}).where(eq(storeProduct.id,80));
      await f.db.update(storeProduct).set({isDel:1,isShow:0,sales:19}).where(eq(storeProduct.id,81));
      const [inventory]=await f.db.select().from(storeProductVirtual).where(eq(storeProductVirtual.productId,81)).limit(1);
      await f.db.update(storeProductVirtual).set({uid:11,orderId:'retained-source-issued-order'}).where(eq(storeProductVirtual.id,inventory.id));
      const [cardSku]=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.unique,inventory.attrUnique)).limit(1);
      await f.db.update(storeProductAttrValue).set({stock:1}).where(eq(storeProductAttrValue.id,cardSku.id));
      await f.db.update(storeProduct).set({stock:5}).where(eq(storeProduct.id,81));
      const [retired]=await f.db.insert(storeProductAttrValue).values({productId:81,type:0,unique:'oldcopy1',suk:'退役',isRetired:1,stock:3,sales:4,sumStock:9}).returning();
      await f.db.insert(storeProductSkuRetirementLog).values({productId:81,skuId:retired.id,uniqueSnapshot:retired.unique,sukSnapshot:retired.suk,action:'retire',actorId:21});
      await f.db.insert(storeOrder).values({id:601,orderId:'retained-source-issued-order',uid:11,supplierId:20,paid:1,virtualInfo:'RETAINED-DELIVERY-FACT'});
      await f.db.insert(storeOrderCartInfo).values({id:601,oid:601,uid:11,type:2,relationId:20,productId:81,productType:1,skuUnique:inventory.attrUnique,cartInfo:'{"immutable":"retained source order"}'});
      await f.db.insert(userBill).values({id:601,uid:11,title:'Retained payment fact',category:'now_money',type:'pay_product',number:'12.50'});
    };
    const snapshot=async()=>{
      const result:Record<string,unknown[]>={};
      for(const table of Object.values(schema)){const name=getTableName(table);result[name]=await f.db.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t ORDER BY to_jsonb(t)::text`);}
      result.supplier_product_copy_operation_v1=await f.db.execute(sql`SELECT to_jsonb(t) AS row FROM public.supplier_product_copy_operation_v1 t ORDER BY operation_id`);return result;
    };
    const body=async(sourceId:number,operationId=crypto.randomUUID())=>{
      const seed=await service.seed(sourceId,supplierCopyActor());
      const safe=seed.product as Record<string,unknown>;
      return {operation_id:operationId,copy_token:seed.copy.token,product:Object.fromEntries(SUPPLIER_COPY_FIELDS.map(k=>[k,safe[k]]))};
    };
    await seed();
    return {...f,container,service,seed,reset:seed,snapshot,body,actor:supplierCopyActor,sourceIds:{physical:80,card:81,manual:82} as const};
  }catch(error){await f.close();throw error;}
}
