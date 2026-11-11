import { eq, sql } from 'drizzle-orm';
import { customerCashierRuntimeHttpFixture } from './customerCashierRuntimeHttpFixture';
import { installPurchasedProductLabelStorage } from '../../src/migrations/installPurchasedProductLabelStorage';
import { upgradePurchasedProductLabelRuntime } from '../../src/migrations/upgradePurchasedProductLabelRuntime';
import { createContainerFromDb } from '../../src/lib/di';
import { PurchasedProductLabelTaskService } from '../../src/services/order/PurchasedProductLabelTaskService';
import { storeProduct, storeProductAttrValue, userLabel, systemAdmin, systemRole } from '../../src/models/schema';
import { capturePurchasedProductLabelMessage } from '../../src/services/order/PurchasedProductLabelQueue';
export async function purchasedLabelOperationsFixture(count=4) {
  if(!Number.isSafeInteger(count)||count<4||count>24)throw Error('Bounded owned operations fixture required');
  const f=await customerCashierRuntimeHttpFixture();
  try {
    const addon={purchasedProductLabels:true} as const,peers={...f.peers,purchasedProductLabels:addon};
    await installPurchasedProductLabelStorage(f.maintenanceDb,{database:f.target.database,maintenance:f.target.maintenance},addon);
    await upgradePurchasedProductLabelRuntime(f.maintenanceDb,peers,f.appReaders);
    f.env.PURCHASED_PRODUCT_LABEL_RUNTIME=peers;
    await f.maintenanceDb.insert(systemRole).values({id:92,rules:'outbox.view'});
    await f.maintenanceDb.insert(systemAdmin).values({id:92,account:'owned-label-task-viewer',pwd:'offline-native-admin-password',level:1,roles:'92'});
    await f.maintenanceDb.insert(userLabel).values([{id:9201,name:'运维验收平台标签'},{id:9202,name:'运维验收其他门店',type:1,relationId:2}]);
    await f.maintenanceDb.update(storeProduct).set({productType:0,freight:2,deliveryType:'2',stock:100,labelId:'9201'}).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({productType:0,stock:100,price:'1.00'}).where(eq(storeProductAttrValue.id,1));
    const app=new PurchasedProductLabelTaskService(createContainerFromDb(f.appRuntime.db),f.env);
    const admin=new PurchasedProductLabelTaskService(createContainerFromDb(f.adminRuntime.db),f.env);
    const tasks=[];
    for(let i=0;i<count;i++){
      const paid=await f.paid('admin',11,'1.00',1);
      const [task]=await f.maintenanceDb.execute<{taskId:string;eventKey:string}>(sql`SELECT task_id::text AS "taskId",event_key AS "eventKey" FROM public.purchased_product_label_intent WHERE order_id=${paid.order.id}`);
      if(!task)throw Error('Real assisted payment did not author its task');
      tasks.push({ref:capturePurchasedProductLabelMessage({action:'processPurchasedProductLabels',...task}),orderId:paid.order.id});
    }
    await app.process(tasks[2]!.ref);
    await app.dispatchPending(1,tasks[3]!.ref.taskId);
    await f.maintenanceDb.update(storeProduct).set({labelId:'9202'}).where(eq(storeProduct.id,70));
    for(const task of tasks.slice(0,2)){
      let failed=false;try{await app.process(task.ref);}catch{failed=true;}
      if(!failed)throw Error('Foreign-store label must fail before maintenance');
    }
    const maintain=()=>f.maintenanceDb.update(storeProduct).set({labelId:'9201'}).where(eq(storeProduct.id,70));
    const request=async(path:string,body?:unknown,id=1)=>{
      const token=await f.bearer(id,'admin','offline-native-admin-password');
      const response=await f.raw(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {response,body:await response.json() as {status:number;msg:string;data:any}};
    };
    return {...f,tasks,appTasks:app,adminTasks:admin,maintain,adminRequest:request};
  }catch(error){await f.close();throw error;}
}
