/** Shared by the public menu resolver and actual UniApp pages. No auth grant is inferred here. */
import {parseCustomerWriteoffQuery,writeoffLookupValue,decodeCustomerWriteoffScan,parseCustomerWriteoffLegacyChoice} from './customerWorkWriteoff';
export type CustomerWorkPage = 'index' | 'statistics' | 'orders' | 'orderDetail' | 'refunds' | 'refundDetail' | 'refund' | 'logistics' | 'delivery' | 'products' | 'productSkus' | 'users' | 'userDetail' | 'scanning' | 'writeoff' | 'writeoffRecords' | 'writeoffResult';
export const CUSTOMER_WORK_PAGES: CustomerWorkPage[] = ['index','statistics','orders','orderDetail','refunds','refundDetail','refund','logistics','delivery','products','productSkus','users','userDetail','scanning','writeoff','writeoffRecords','writeoffResult'];
const aliases: Record<string,CustomerWorkPage> = {
  '/pages/admin/work/index':'index', '/pages/admin/order/index':'statistics', '/pages/admin/orderList/index':'orders',
  '/pages/admin/orderDetail/index':'orderDetail', '/pages/admin/refundOrderList/index':'refunds',
  '/pages/admin/refundOrderDetail/index':'refundDetail', '/pages/admin/logistics/index':'logistics',
  '/pages/admin/refund/index':'refund',
  '/pages/admin/delivery/index':'delivery',
  '/pages/admin/goods/index':'products', '/pages/admin/goods/specs':'productSkus',
  '/pages/admin/user/list':'users', '/pages/admin/user/index':'userDetail',
};
export const customerWorkBusinessId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,50}$/u.test(value);
function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number(value.slice(0,4))<1970) throw Error('日期范围无效');
  const epoch=Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(epoch) || new Date(epoch+8*3600000).toISOString().slice(0,10)!==value) throw Error('日期范围无效');
  return epoch;
}
export function parseCustomerWorkQuery(page: CustomerWorkPage, input: string | Record<string, unknown>): Record<string,string> {
  if (!CUSTOMER_WORK_PAGES.includes(page) || typeof input==='string'&&input.length>4096) throw Error('经营入口参数无效');
  if(page==='scanning'||page==='writeoff'||page==='writeoffRecords'||page==='writeoffResult')return parseCustomerWriteoffQuery(page,input);
  const fields: Record<string,string> = {};
  const entries = typeof input === 'string' ? input.split('&').filter(Boolean).map(part => {
    const at=part.indexOf('='); if(at<1)throw Error('经营入口参数无效');
    return [decodeURIComponent(part.slice(0,at)),decodeURIComponent(part.slice(at+1).replace(/\+/gu,' '))] as const;
  }) : Object.entries(input).filter(([,value])=>value!==undefined).map(([key,value])=>{
    if(typeof value!=='string')throw Error('经营入口参数无效');return [key,value] as const;
  });
  const allowed:Record<CustomerWorkPage,string[]>={scanning:[],writeoff:[],writeoffRecords:[],writeoffResult:[],index:[],statistics:['type'],orders:['status','types','keyword','data','pay_type','type','field_key','is_del'],
    orderDetail:['orderId','id','status','types','goname'],refunds:['refundTypes','apply_type','order_id','time'],refundDetail:['refundOrderId','id'],refund:['orderId','id','listId'],logistics:['orderId','id','type'],
    delivery:['orderId','id','listId','totalNum','orderStatus','comeType','productType'],products:['type','keyword','store_name'],productSkus:['productId','id'],
    users:['nickname','keyword','group_id','level','label_ids','label_id','isMember'],userDetail:['uid']};
  for(const [key,value]of entries){if(!allowed[page].includes(key)||Object.hasOwn(fields,key)||value.length>(page==='users'&&['label_ids','label_id'].includes(key)?1099:512))throw Error('经营入口参数重复或无效');fields[key]=value;}
  if(page==='users'){
    for(const [alias,key]of [['keyword','nickname'],['label_id','label_ids']])if(fields[alias]!==undefined){
      if(fields[key]!==undefined)throw Error('经营入口参数含有冲突标识');fields[key]=fields[alias]!;delete fields[alias];
    }
    if(fields.nickname!==undefined&&Array.from(fields.nickname).length>100)throw Error('查询文字过长');
    for(const key of ['group_id','level'])if(fields[key]!==undefined&&(!/^(0|[1-9]\d{0,9})$/u.test(fields[key]!)||Number(fields[key])>2147483647))throw Error('用户分类编号无效');
    if(fields.isMember!==undefined&&!['0','1',''].includes(fields.isMember))throw Error('会员筛选无效');
    if(fields.label_ids==='0')fields.label_ids='';
    if(fields.label_ids){
      const ids=fields.label_ids.split(',');if(ids.length>100||ids.some(id=>!/^[1-9]\d{0,9}$/u.test(id)||Number(id)>2147483647)||new Set(ids).size!==ids.length)throw Error('用户标签筛选无效');
      fields.label_ids=ids.sort((a,b)=>Number(a)-Number(b)).join(',');
    }
  }
  if(page==='userDetail'&&(!fields.uid||!/^[1-9]\d{0,9}$/u.test(fields.uid)||Number(fields.uid)>2147483647))throw Error('用户编号无效');
  for(const [alias,key]of [['types','status'],['id',page==='refundDetail'?'refundOrderId':page==='productSkus'?'productId':'orderId'],['store_name','keyword']])if(fields[alias]!==undefined){
    if(fields[key]!==undefined)throw Error('经营入口参数含有冲突标识');fields[key]=fields[alias]!;delete fields[alias];}
  if(fields.goname!==undefined){if(fields.goname!=='look')throw Error('经营入口参数无效');delete fields.goname;}
  if(page==='delivery'){
    for(const key of ['listId','totalNum'])if(fields[key]!==undefined&&(!/^[1-9]\d{0,9}$/u.test(fields[key]!)||Number(fields[key])>2147483647))throw Error('发货入口提示参数无效');
    if(fields.orderStatus!==undefined&&!Array.from({length:14},(_,i)=>String(i-4)).includes(fields.orderStatus))throw Error('发货状态提示无效');
    if(fields.comeType!==undefined&&!['1','2'].includes(fields.comeType))throw Error('发货来源提示无效');
    if(fields.productType!==undefined&&!['0','1','2','3','4'].includes(fields.productType))throw Error('商品类型提示无效');
    // Historical display hints never select a target, quantity, channel or authority.
    for(const key of ['listId','totalNum','orderStatus','comeType','productType'])delete fields[key];
  }
  if(page==='refund'&&fields.listId!==undefined){
    if(!/^[1-9]\d{0,9}$/u.test(fields.listId)||Number(fields.listId)>2147483647)throw Error('退款入口提示编号无效');
    // The old physical-key hint never selects an order. Resolve the public number anew, then bind both real identities.
    delete fields.listId;
  }
  const select=(key:string,values:readonly string[])=>{if(fields[key]!==undefined&&!values.includes(fields[key]!))throw Error('经营筛选参数无效');};
  select('status',['',...Array.from({length:14},(_,i)=>String(i-4))]);select('is_del',['0','1']);select('pay_type',['','1','2','3','4','5']);
  select('field_key',['','uid','order_id','real_name','user_phone','title','total_num']);select('refundTypes',['0','1','2','3','4','5','6']);select('apply_type',['','0','1','2','3','4']);
  select('type',page==='statistics'?['1','7','30']:page==='logistics'?['','refund']:page==='products'?['','1','2','4','5']:['',...Array.from({length:9},(_,i)=>String(i)),'105','106','107']);
  if(page==='productSkus'&&(!fields.productId||!/^[1-9]\d{0,9}$/u.test(fields.productId)||Number(fields.productId)>2147483647))throw Error('商品编号无效');
  for(const key of ['orderId','refundOrderId'])if(fields[key]!==undefined&&!customerWorkBusinessId(fields[key]))throw Error('订单编号无效');
  if((['orderDetail','logistics','delivery','refund'].includes(page)&&!fields.orderId)||(page==='refundDetail'&&!fields.refundOrderId))throw Error('缺少订单编号');
  if((fields.keyword!==undefined&&fields.keyword.length>100)||(fields.order_id!==undefined&&fields.order_id.length>100))throw Error('查询文字过长');
  if(Object.values(fields).some(value=>/[\u0000-\u001f\u007f]/u.test(value)))throw Error('经营入口参数无效');
  if(fields.keyword&&['uid','total_num'].includes(fields.field_key??'')){
    if(!/^(0|[1-9]\d{0,9})$/u.test(fields.keyword)||Number(fields.keyword)>2147483647||(fields.field_key==='uid'&&fields.keyword==='0'))throw Error('数字查询无效');
  }
  if(page==='orders'){
    if(fields.status==='-4'&&fields.is_del===undefined)fields.is_del='1';
    if(fields.status==='-4'&&fields.is_del!=='1'||fields.is_del==='1'&&fields.status!==undefined&&fields.status!==''&&fields.status!=='-4')throw Error('删除筛选与订单状态冲突');
  }
  for(const key of ['data','time'])if(fields[key]!==undefined&&fields[key]!==''){
    const days=fields[key]!.split(',');if(days.length>2)throw Error('日期范围无效');const dates=days.map(calendarDay);
    if(dates.length===2&&dates[0]!>dates[1]!)throw Error('日期范围无效');
  }
  return fields;
}
export function customerWorkRoute(page:CustomerWorkPage,query:Record<string,string|number>={}):string {
  const parsed=parseCustomerWorkQuery(page,Object.fromEntries(Object.entries(query).map(([key,value])=>[key,String(value)])));
  const parts=Object.entries(parsed).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return `/pages/customer-work/${page}${parts.length?'?'+parts.join('&'):''}`;
}
/** null = another route; empty string = a recognized work route with invalid parameters. */
export function resolveCustomerWorkPageRoute(path:string,query=''):string|null {
  const legacy=resolveCustomerWriteoffLegacyRoute(path,query);if(legacy!==null)return legacy;
  const actual=path.startsWith('/pages/customer-work/')?path.slice('/pages/customer-work/'.length):'';
  const page=aliases[path]??(CUSTOMER_WORK_PAGES.includes(actual as CustomerWorkPage)?actual as CustomerWorkPage:undefined);
  if(!page)return path.startsWith('/pages/customer-work/')?'':null;
  try{return customerWorkRoute(page,parseCustomerWorkQuery(page,query));}catch{return '';}
}
/** Historic auth values select a destination, never an execution authority. */
export function resolveCustomerWriteoffLegacyRoute(path:string,query=''):string|null{
 const pages:Record<string,'scanning'|'writeoff'|'writeoffRecords'|'writeoffResult'>={'/pages/admin/order_cancellation/index':'scanning','/pages/admin/distribution/scanning/index':'scanning','/pages/admin/distribution/scanning/detail/index':'writeoff','/pages/admin/writeOffCard/index':'writeoff','/pages/admin/writeRecordList/index':'writeoffRecords','/pages/admin/offOrderResult/index':'writeoffResult'};
 const page=pages[path];if(!page)return null;
 try{const fields:Record<string,string>={};if(query.length>4096)throw Error('历史核销入口过长');for(const part of query.split('&').filter(Boolean)){const at=part.indexOf('=');if(at<1)throw Error('历史核销参数无效');const key=decodeURIComponent(part.slice(0,at)),value=decodeURIComponent(part.slice(at+1));if(!['auth','code','scene','id','let'].includes(key)||Object.hasOwn(fields,key)||/[\u0000-\u001f\u007f]/u.test(value))throw Error('历史核销参数无效');fields[key]=value;}
  const auth=fields.auth??'1';if(!['0','1','2','3'].includes(auth))throw Error('历史核销身份提示无效');if(fields.let!==undefined&&!['0','1','true','false'].includes(fields.let))throw Error('历史核销展示提示无效');if(fields.code!==undefined&&!writeoffLookupValue('auto',fields.code))throw Error('历史核销码无效');if(fields.scene!==undefined){if(fields.code!==undefined)throw Error('历史扫码提示冲突');fields.code=decodeCustomerWriteoffScan(fields.scene,'scene').value;}
  if(fields.id!==undefined&&!writeoffLookupValue('legacy-order-id',fields.id))throw Error('历史物理订单编号无效');if(page!=='scanning'&&!fields.id)throw Error('缺少历史物理订单编号');
  // The existing personal-center staff menu uses this unqualified alias. Preserve its default realm.
  if(path==='/pages/admin/order_cancellation/index'&&fields.auth===undefined)return '/pages/operator/writeoff'+(fields.code&&/^\d{12}$/u.test(fields.code)?'?code='+fields.code:'');
  if(auth==='2')return '/pages/delivery/scanning';
  if(auth==='0'||auth==='3'){const choice=parseCustomerWriteoffLegacyChoice({entry:'legacy-auto',next:page,...(fields.id?{legacyOrderId:fields.id}:{}),...(fields.code?{code:fields.code}:{})});return'/pages/operator/writeoff?'+Object.entries(choice).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');}
  return page==='scanning'?customerWorkRoute('scanning',fields.code?{namespace:'auto',value:fields.code}:{}):customerWorkRoute(page,{legacyOrderId:fields.id!});
 }catch{return '';}
}
