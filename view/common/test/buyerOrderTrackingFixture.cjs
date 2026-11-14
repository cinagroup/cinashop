/** Declared transport fixtures for component lifecycle tests; no business acceptance claim. */
function tracking({ reference='local_A', kind='order', uid=11, split=false }={}) {
  const entityNo=kind==='refund'?'return_'+reference:reference,entityId=kind==='refund'?Number(reference):501;
  const parcel=(orderId,no)=>({orderId,deliveryStatus:'运输中',expressName:'本地承运商样本',expressCode:'LOCAL',expressNo:no,trackingState:'in_transit',trackingSource:'carrier',message:'',lastUpdatedAt:1700000000,
    traces:[{time:'本地时间 A',content:'本地样本揽收',status:'已揽收'},{time:'本地时间 B',content:'本地样本交运',status:'运输中'}]});
  const packages=split?[parcel('child_A','PACKET-A'),parcel('child_B','PACKET-B')]:[parcel(entityNo,kind==='refund'?'RETURN-'+reference:'OUTGOING-'+reference)];
  const primary=split?{...packages[0],orderId:entityNo,deliveryStatus:'分包发货',message:'共 2 个已发货包裹'}:packages[0];
  return {...primary,version:1,identity:{kind,reference,uid,entityId,entityNo,split},packages,contexts:packages.map((p,i)=>({orderId:p.orderId,entityId:split?601+i:entityId,uid,recipientName:'私有联系人'+i,recipientPhone:'000000',recipientAddress:'私有测试地址'+i,
    merchant:{source:'platform',name:'本地商家',phone:'000000',address:'本地登记地址'},items:[{id:701+i,name:'本地包裹商品'+i,sku:'规格'+i,image:'',quantity:i+1,unitPrice:'10.00'}],itemsError:''})),
    express:primary.traces.map(t=>({time:t.time,status:t.content})),order:{order_id:entityNo,delivery_id:primary.expressNo,delivery_name:primary.expressName,delivery_code:primary.expressCode,delivery_type:'express'}};
}
module.exports={tracking};
