import { customerWorkMoney, customerWorkImage, customerWorkDateRange, customerWorkFormRows,
  parseCustomerWorkQuery, resolveCustomerWorkPageRoute, parseCustomerWorkEnvelope, isCustomerWorkContext,
  isCustomerWorkTrend, CUSTOMER_WORK_SCOPES } from './customerWork';

/** Portable assertions exercise the same helpers loaded by actual page setup. */
export function runCustomerWorkPureTests(assert:{equal:(actual:unknown,expected:unknown)=>void;deepEqual:(actual:unknown,expected:unknown)=>void;throws:(fn:()=>unknown)=>void}) {
  assert.equal(customerWorkMoney('1.01'),true);for(const bad of ['1',1,'1.001','-1.00','NaN','1e2'])assert.equal(customerWorkMoney(bad),false);
  assert.equal(customerWorkImage('https://example.test/p.jpg?signature=a%2Fb'),true);assert.equal(customerWorkImage('/p.jpg'),true);
  for(const bad of ['//host/p.jpg','/../p','/%2e%2e/p','/%252e%252e/p','/%2f%2fhost/p','javascript:alert(1)','https://name:secret@host/p'])assert.equal(customerWorkImage(bad),false);
  assert.deepEqual(parseCustomerWorkQuery('orders','types=0'),{status:'0'});assert.deepEqual(parseCustomerWorkQuery('orders','types=-4'),{status:'-4',is_del:'1'});
  for(const raw of ['types=0&types=1','status=0&types=0','status=01','status=10','field_key=uid&keyword=0','field_key=uid&keyword=11x','field_key=uid&keyword=01','data=2026-02-30','data=2026-10-02,2026-10-01','x=1','keyword=%00'])assert.throws(()=>parseCustomerWorkQuery('orders',raw));
  assert.equal(resolveCustomerWorkPageRoute('/pages/admin/orderDetail/index','id=ORDER_12&types=0&goname=look'),'/pages/customer-work/orderDetail?status=0&orderId=ORDER_12');
  assert.equal(resolveCustomerWorkPageRoute('/pages/admin/refundOrderDetail/index','id=REFUND_9'),'/pages/customer-work/refundDetail?refundOrderId=REFUND_9');
  assert.equal(resolveCustomerWorkPageRoute('/pages/admin/logistics/index','orderId=REFUND_9&type=refund'),'/pages/customer-work/logistics?orderId=REFUND_9&type=refund');
  assert.equal(resolveCustomerWorkPageRoute('/pages/customer-work/orderDetail','id=A&orderId=A'),'');assert.equal(resolveCustomerWorkPageRoute('/pages/customer-work/logistics','orderId=A&type=delivery'),'');
  assert.equal(resolveCustomerWorkPageRoute('/pages/goods/detail','id=1'),null);
  for(const selector of ['0','2','5','6'])assert.equal(parseCustomerWorkQuery('refunds','refundTypes='+selector).refundTypes,selector);
  assert.equal(customerWorkDateRange(1,Date.parse('2026-10-04T01:00:00Z')),'2026-10-02,2026-10-04');
  assert.deepEqual(customerWorkFormRows({name:'<script>bad</script>'}),[{name:'name',value:'<script>bad</script>'}]);
  const context={metric_scopes:CUSTOMER_WORK_SCOPES,profile:{uid:11,nickname:'fixture',phone:'',avatar:''},capabilities:{statistics:true,orders:true,refunds:true,logistics:true,product_management:false,user_management:false,assisted_order:false,writes:false}};
  const envelope={version:'customer-work-read-v1',actor_uid:11,principal:{kind:'customer-order-manager',service_id:1,scope:'global'},scope_key:'a'.repeat(64),consistency_key:'b'.repeat(64),data:context};
  assert.equal(parseCustomerWorkEnvelope(envelope,11,isCustomerWorkContext).data.profile.uid,11);
  assert.throws(()=>parseCustomerWorkEnvelope({...envelope,data:{...context,profile:{...context.profile,uid:12}}},11,isCustomerWorkContext));
  assert.throws(()=>parseCustomerWorkEnvelope({...envelope,actor_uid:12},11,isCustomerWorkContext));
  const days=[{date:'2026-10-03',time:'10-03',num:0,price:'0.00'},{date:'2026-10-04',time:'10-04',num:1,price:'1.00'}];
  assert.equal(isCustomerWorkTrend({type:1,list:days}),true);assert.equal(isCustomerWorkTrend({type:1,list:days.slice(1)}),false);
  assert.equal(isCustomerWorkTrend({type:1,list:[days[0],{...days[1],date:'2026-10-05',time:'10-05'}]}),false);
}
