/** Independent type=3 cashier. Never use the merchandise checkout/payment DTO. */
import { isOfflineReturnUrl, validOfflineTicketReturn } from './offlineReturn';
export type OfflineChannel = 'h5' | 'wechat' | 'weixinh5' | 'routine';
export type OfflineMethod = 'yue' | 'weixin' | 'alipay';
export type OfflineTicket = { kind: 'wechat-h5' | 'alipay-wap'; url: string }
  | { kind: 'wechat-jsapi'; appId: string; timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };
export interface OfflineDraft { money: string; expected_pay_price: string; from: OfflineChannel; request_key: string }
export interface OfflineIntent { version: 1; uid: number; draft: OfflineDraft; orderId?: string; method?: OfflineMethod }
export interface OfflineRecoveredIntent { version: 2; uid: number; orderId: string; method?: OfflineMethod; draft?: never }
export type OfflineSavedIntent = OfflineIntent | OfflineRecoveredIntent;
export interface OfflineDetail {
  order_id: string; money: string; pay_price: string; channel: OfflineChannel; hidden: boolean;
  pay_type: OfflineMethod | ''; paid: boolean; created_at: number; paid_at?: number;
  state: 'UNSELECTED' | 'READY' | 'RECOVERY_REQUIRED' | 'UNAVAILABLE' | 'PAID' | 'REVIEW_REQUIRED';
  ticket?: OfflineTicket; display_until?: number;
}
export type OfflineMethodReason = 'available' | 'disabled' | 'not_configured' | 'identity_required' | 'insufficient_balance'
  | 'amount_unsupported' | 'channel_unsupported' | 'read_original';
export interface OfflineCapabilities {
  order_id:string; channel:OfflineChannel; pay_price:string; now_money:string; site_name:string;
  methods:Record<OfflineMethod,OfflineMethodReason>;
}
export function offlineMethodMessage(reason:OfflineMethodReason):string {
  return {available:'可用',disabled:'商家未开启',not_configured:'支付配置尚未就绪',identity_required:'缺少当前渠道的微信身份',
    insufficient_balance:'余额不足',amount_unsupported:'超出此方式的金额范围',channel_unsupported:'当前渠道不支持',read_original:'请核对原支付结果'}[reason];
}
export function decodeOfflineCapabilities(value:unknown, detail:OfflineDetail):OfflineCapabilities {
  const r=object(value),m=object(r.methods);
  only(r,['order_id','channel','pay_price','now_money','site_name','offline_pay_status','yue_pay_status','pay_weixin_open','ali_pay_status','methods']);
  only(m,['yue','weixin','alipay']);
  if(r.order_id!==detail.order_id || r.channel!==detail.channel || r.pay_price!==detail.pay_price || r.offline_pay_status!==true
    || typeof r.now_money!=='string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(r.now_money)
    || typeof r.site_name!=='string' || r.site_name.length>200 || /[\u0000-\u001f\u007f]/.test(r.site_name)) throw Error('支付方式响应与原消费不一致');
  const methods:Record<OfflineMethod,OfflineMethodReason>={yue:'disabled',weixin:'disabled',alipay:'disabled'};
  for(const [key,flag] of [['yue','yue_pay_status'],['weixin','pay_weixin_open'],['alipay','ali_pay_status']] as const){
    const reason=m[key];
    if(typeof reason!=='string' || !['available','disabled','not_configured','identity_required','insufficient_balance','amount_unsupported','channel_unsupported','read_original'].includes(reason)
      || r[flag] !== (reason==='available'?1:0)) throw Error('支付方式状态无效，请重新读取');
    methods[key]=reason as OfflineMethodReason;
  }
  if(detail.channel==='routine' && methods.alipay==='available') throw Error('小程序不能使用支付宝WAP入口');
  return {order_id:detail.order_id,channel:detail.channel,pay_price:detail.pay_price,now_money:r.now_money,site_name:r.site_name,methods};
}
export interface OfflineStorage { get(key: string): unknown; set(key: string, value: string): void; remove(key: string): void }
export const OFFLINE_MIN_PAYABLE_MESSAGE = '线下消费应付金额至少为0.01元，折扣后不足0.01元不能建单或付款';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const channel = (v: unknown): v is OfflineChannel => typeof v === 'string' && ['h5', 'wechat', 'weixinh5', 'routine'].includes(v);
const method = (v: unknown): v is OfflineMethod => typeof v === 'string' && ['yue', 'weixin', 'alipay'].includes(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('收银记录格式无效，请核对原订单');
  return Object.fromEntries(Object.entries(v));
}
function only(v: Record<string, unknown>, keys: string[]) {
  if (Object.keys(v).some(key => !keys.includes(key))) throw Error('收银记录含有未知字段，请核对原订单');
}
export function offlineMoney(value: unknown, zero = false): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) throw Error('请输入不超过99999999.99、最多两位小数的消费金额');
  const [whole, cents = ''] = value.split('.'), result = `${whole}.${cents.padEnd(2, '0')}`;
  if (!zero && result === '0.00') throw Error('消费金额必须大于0');
  return result;
}
export function offlineOrderId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 32 || !/^xx[0-9a-f]{30}$/.test(value)) throw Error('线下消费订单链接无效');
  return value;
}
export const offlineStorageKey = (uid: number) => `cinashop_offline_pending_v1_${uid}`;
export function offlineUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw Error('无法创建安全请求标识，尚未建单');
  const copy = new Uint8Array(bytes); copy[6] = (copy[6] & 15) | 64; copy[8] = (copy[8] & 63) | 128;
  const hex = Array.from(copy, b => b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function decodeOfflineIntent(raw: unknown, uid: number): OfflineSavedIntent {
  if (typeof raw !== 'string' || raw.length > 2048 || !integer(uid) || uid === 0) throw Error('原收银记录不可读，不能新建消费');
  const row = object(JSON.parse(raw));
  if (row.version === 2) {
    only(row, ['version','uid','orderId','method']);
    if (row.uid !== uid || (row.method !== undefined && !method(row.method))) throw Error('原收银身份无效，不能新建消费');
    return {version:2,uid,orderId:offlineOrderId(row.orderId),...(method(row.method)?{method:row.method}:{})};
  }
  const d = object(row.draft);
  only(row, ['version','uid','draft','orderId','method']); only(d, ['money','expected_pay_price','from','request_key']);
  if (row.version !== 1 || row.uid !== uid || typeof d.request_key !== 'string' || !uuid.test(d.request_key)
    || !channel(d.from) || (row.method !== undefined && !method(row.method))) throw Error('原收银身份无效，不能新建消费');
  const draft: OfflineDraft = { money: offlineMoney(d.money), expected_pay_price: offlineMoney(d.expected_pay_price, true), from: d.from, request_key: d.request_key };
  if (draft.money !== d.money || draft.expected_pay_price !== d.expected_pay_price) throw Error('原消费金额记录无效');
  return { version: 1, uid, draft, ...(row.orderId === undefined ? {} : { orderId: offlineOrderId(row.orderId) }),
    ...(method(row.method) ? { method: row.method } : {}) };
}
export class OfflineJournal {
  constructor(private storage: OfflineStorage) {}
  read(uid: number) {
    if (!integer(uid) || !uid) throw Error('请先登录后核对消费');
    const raw = this.storage.get(offlineStorageKey(uid));
    return raw === undefined || raw === null || raw === '' ? null : decodeOfflineIntent(raw, uid);
  }
  private save(intent: OfflineSavedIntent) {
    const raw = JSON.stringify(intent); decodeOfflineIntent(raw, intent.uid);
    this.storage.set(offlineStorageKey(intent.uid), raw);
    if (this.storage.get(offlineStorageKey(intent.uid)) !== raw) throw Error('原消费记录保存失败，不能发送付款请求');
    return decodeOfflineIntent(raw, intent.uid);
  }
  begin(uid: number, draft: OfflineDraft) {
    if (this.read(uid)) throw Error('已有原消费记录，请先核对');
    if (offlineMoney(draft.expected_pay_price, true) === '0.00') throw Error(OFFLINE_MIN_PAYABLE_MESSAGE);
    const saved=this.save({ version: 1, uid, draft });
    if(saved.version!==1)throw Error('消费记录保存失败');
    return saved;
  }
  recover(uid:number,orderId:string) {
    if(this.read(uid))throw Error('已有原消费记录，请先核对；不会覆盖');
    return this.save({version:2,uid,orderId:offlineOrderId(orderId)});
  }
  current(intent: OfflineSavedIntent) {
    const current = this.read(intent.uid);
    if (!current || JSON.stringify(current) !== JSON.stringify(intent)) throw Error('原消费记录已变化，请重新读取');
    return current;
  }
  update(intent: OfflineIntent, change: Partial<Pick<OfflineIntent, 'orderId' | 'method' | 'draft'>>): OfflineIntent;
  update(intent: OfflineSavedIntent, change: Partial<Pick<OfflineSavedIntent, 'orderId' | 'method'>>): OfflineSavedIntent;
  update(intent: OfflineSavedIntent, change: Partial<Pick<OfflineIntent, 'orderId' | 'method' | 'draft'>>): OfflineSavedIntent {
    if(intent.version===2) {
      if(change.draft!==undefined)throw Error('找回的消费不能变成新建单请求');
      this.current(intent);return this.save({...intent,...change,draft:undefined});
    }
    this.current(intent); return this.save({ ...intent, ...change });
  }
  clearPaid(intent: OfflineSavedIntent, detail: OfflineDetail) {
    this.current(intent);
    if (intent.orderId !== detail.order_id || !detail.paid || detail.state !== 'PAID') throw Error('原消费结果未确认，不能开始新消费');
    this.storage.remove(offlineStorageKey(intent.uid));
    if (this.read(intent.uid)) throw Error('原消费记录未能归档，请重新核对');
  }
}
function ticketFrom(value: unknown, detail: Omit<OfflineDetail, 'ticket'>): OfflineTicket {
  const t = object(value);
  if (t.kind === 'wechat-jsapi') {
    only(t, ['kind','appId','timeStamp','nonceStr','package','signType','paySign']);
    if (detail.pay_type !== 'weixin' || !['wechat','routine'].includes(detail.channel) || t.signType !== 'RSA'
      || typeof t.appId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.appId)
      || typeof t.timeStamp !== 'string' || !/^\d{1,12}$/.test(t.timeStamp)
      || typeof t.nonceStr !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.nonceStr)
      || typeof t.package !== 'string' || !/^prepay_id=[A-Za-z0-9_-]{1,128}$/.test(t.package)
      || typeof t.paySign !== 'string' || !/^[A-Za-z0-9+/]{64,1024}={0,2}$/.test(t.paySign)) throw Error('原微信支付入口无效');
    return { kind: t.kind, appId: t.appId, timeStamp: t.timeStamp, nonceStr: t.nonceStr, package: t.package, signType: 'RSA', paySign: t.paySign };
  }
  only(t, ['kind','url']);
  if (typeof t.url !== 'string' || t.url.length > 8192 || !t.url.startsWith('https://') || /[\s\\\u0000-\u001f\u007f]/.test(t.url)) throw Error('支付地址无效');
  const url = new URL(t.url);
  if (url.username || url.password || url.hash || url.port) throw Error('支付地址无效');
  if (t.kind === 'wechat-h5' && detail.pay_type === 'weixin' && ['h5','weixinh5'].includes(detail.channel)
    && t.url.length <= 4096 && url.origin === 'https://wx.tenpay.com' && url.pathname === '/cgi-bin/mmpayweb-bin/checkmweb' && url.search
    && validOfflineTicketReturn(url,'redirect_url',detail.order_id)) return { kind: t.kind, url: t.url };
  if (t.kind === 'alipay-wap' && detail.pay_type === 'alipay' && url.origin === 'https://openapi.alipay.com' && url.pathname === '/gateway.do') {
    const p = url.searchParams;
    if (new Set([...p.keys()]).size !== [...p.keys()].length || p.get('method') !== 'alipay.trade.wap.pay' || p.get('sign_type') !== 'RSA2' || !p.get('sign')
      || !validOfflineTicketReturn(url,'return_url',detail.order_id)) throw Error('支付宝入口参数无效');
    const b = object(JSON.parse(p.get('biz_content') ?? 'null'));
    if (b.quit_url !== undefined && (typeof b.quit_url !== 'string' || !isOfflineReturnUrl(b.quit_url, detail.order_id))) throw Error('支付宝退出地址与原消费不一致');
    if (b.out_trade_no !== detail.order_id || b.total_amount !== detail.pay_price || b.product_code !== 'QUICK_WAP_WAY' || b.passback_params !== 'offline_order') throw Error('支付宝入口与原消费不一致');
    return { kind: t.kind, url: t.url };
  }
  throw Error('支付入口与原渠道不一致');
}
export function decodeOfflineDetail(value: unknown, id: string, draft?: OfflineDraft): OfflineDetail {
  const r = object(value); only(r, ['order_id','money','pay_price','channel','hidden','pay_type','paid','created_at','paid_at','state','ticket','display_until','replayed']);
  if (r.order_id !== offlineOrderId(id) || !channel(r.channel) || typeof r.hidden !== 'boolean' || typeof r.paid !== 'boolean'
    || (r.pay_type !== '' && !method(r.pay_type)) || !integer(r.created_at)
    || !['UNSELECTED','READY','RECOVERY_REQUIRED','UNAVAILABLE','PAID','REVIEW_REQUIRED'].includes(String(r.state))) throw Error('服务器消费记录无效，请重新核对');
  const money = offlineMoney(r.money), price = offlineMoney(r.pay_price, true);
  if (money !== r.money || price !== r.pay_price || (draft && (money !== draft.money || price !== draft.expected_pay_price || r.channel !== draft.from))) throw Error('服务器消费金额或渠道与原确认不一致');
  if (r.paid ? !['PAID','REVIEW_REQUIRED'].includes(String(r.state)) || !method(r.pay_type) || !integer(r.paid_at) || r.paid_at < r.created_at
    : r.state === 'PAID' || r.paid_at !== undefined) throw Error('服务器支付状态矛盾，请核对原消费');
  if ((r.state === 'UNSELECTED' && r.pay_type !== '') || (r.state === 'READY' && (!method(r.pay_type) || r.pay_type === 'yue' || r.hidden || price === '0.00'))) throw Error('服务器支付路径无效');
  if (price === '0.00' && (r.paid || r.state !== 'UNAVAILABLE' || r.pay_type !== '')) throw Error('零元消费不能显示为已付款或可支付');
  // Guard above establishes each public union; no raw fields or payer identity retained.
  const state = r.state as OfflineDetail['state'];
  const detail: OfflineDetail = { order_id: id, money, pay_price: price, channel: r.channel, hidden: r.hidden, pay_type: r.pay_type,
    paid: r.paid, created_at: r.created_at, state, ...(integer(r.paid_at) ? { paid_at: r.paid_at } : {}) };
  if (state === 'READY') {
    if (!integer(r.display_until) || !r.display_until) throw Error('原支付入口缺少展示期限');
    detail.ticket = ticketFrom(r.ticket, detail); detail.display_until = r.display_until;
  } else if (r.ticket !== undefined || r.display_until !== undefined) throw Error('非可支付状态含有支付入口');
  return detail;
}
export type OfflineHistoryItem = Pick<OfflineDetail,'order_id'|'money'|'pay_price'|'channel'|'created_at'|'hidden'>;
export interface OfflineHistoryState { query:string; items:OfflineHistoryItem[]; nextCursor:string; pageCursor:string; loaded:boolean }
export const emptyOfflineHistory = ():OfflineHistoryState=>({query:'',items:[],nextCursor:'',pageCursor:'',loaded:false});
export function decodeOfflineHistory(value:unknown, query=''): {items:OfflineHistoryItem[];nextCursor:string} {
  const r=object(value);only(r,['items','next_cursor']);
  if(!Array.isArray(r.items) || r.items.length>20 || typeof r.next_cursor!=='string')throw Error('消费记录列表无效');
  const seen=new Set<string>();let time=Number.MAX_SAFE_INTEGER;
  const items=r.items.map((value:unknown)=>{
    const item=object(value);only(item,['order_id','money','pay_price','channel','created_at','hidden']);
    const id=offlineOrderId(item.order_id),money=offlineMoney(item.money),price=offlineMoney(item.pay_price,true);
    if(seen.has(id) || (query && id!==query) || !channel(item.channel) || typeof item.hidden!=='boolean'
      || !integer(item.created_at) || item.created_at<=0 || item.created_at>time || money!==item.money || price!==item.pay_price)throw Error('消费记录列表不一致');
    seen.add(id);time=item.created_at;
    return {order_id:id,money,pay_price:price,channel:item.channel,hidden:item.hidden,created_at:item.created_at};
  });
  if((query && (items.length>1 || r.next_cursor!=='')) || (r.next_cursor!=='' && (items.length!==20 || r.next_cursor!==items.at(-1)?.order_id)))throw Error('消费记录分页无效');
  return {items,nextCursor:r.next_cursor};
}
export interface OfflineView { money: string; quote: string; intent: OfflineSavedIntent | null; detail: OfflineDetail | null; capabilities:OfflineCapabilities|null; busy: boolean; error: string; errorSource:'history'|'cashier'; reprice: string; history:OfflineHistoryState }
export interface OfflineOwner { uid: number; current(): boolean }
export class OfflineCashier {
  state: OfflineView = { money: '', quote: '', intent: null, detail: null, capabilities:null, busy: false, error: '',errorSource:'cashier', reprice: '',history:emptyOfflineHistory() };
  private epoch = 0;
  private visible = false;
  private routeId = '';
  private validRoute = false;
  get linked(): boolean { return this.routeId !== ''; }
  constructor(private options: { journal: OfflineJournal; owner(): OfflineOwner; channel(): OfflineChannel;
    key(): Promise<string>; quote(money: string): Promise<unknown>; create(draft: OfflineDraft): Promise<unknown>;
    read(id: string): Promise<unknown>; capabilities(id:string):Promise<unknown>; history(input:{cursor?:string;order_id?:string}):Promise<unknown>; pay(id: string, method: OfflineMethod): Promise<unknown>; readOnly?:boolean;
    publish(state: OfflineView): void; now?(): number; exclusive?(work:()=>Promise<void>):Promise<void> }) {}
  private publish(change: Partial<OfflineView>) { this.state = { ...this.state, ...change }; this.options.publish(this.state); }
  hide() { this.visible = false; this.epoch++; this.publish({ money:'',quote:'',intent:null,detail:null,capabilities:null,busy:false,error:'',errorSource:'cashier',reprice:'',history:emptyOfflineHistory() }); }
  async show(route: unknown = undefined) {
    this.hide(); this.visible = true; this.routeId = ''; this.validRoute = false;
    try {
      this.routeId = route === undefined || route === '' ? '' : offlineOrderId(route);
      if (this.options.readOnly && !this.routeId) throw Error('缺少原消费订单号，请从收银入口查找并核对');
      this.validRoute = true;
      const owner = this.options.owner(); if (!owner.current()) throw Error('请登录后核对原消费');
      // A return link is read-only: another pending/corrupt journal must neither
      // substitute its order nor block reading this authenticated original.
      const intent = this.options.readOnly ? null : this.options.journal.read(owner.uid);
      if (this.routeId && intent && intent.orderId !== this.routeId) throw Error('另有待确认消费，请返回收银入口恢复原记录');
      this.publish({ intent, money: intent?.draft?.money ?? '', quote: intent?.draft?.expected_pay_price ?? '' });
      if (this.routeId || intent?.orderId) await this.refresh();
    } catch (e) { this.validRoute = false; this.publish({ error: message(e) }); }
  }
  private scope() {
    const owner = this.options.owner(), epoch = this.epoch;
    return { uid: owner.uid, current: () => this.visible && epoch === this.epoch && owner.current() };
  }
  private async acceptDetail(detail:OfflineDetail,s:ReturnType<OfflineCashier['scope']>) {
    if(!s.current())return;
    this.publish({detail,capabilities:null,money:detail.money,quote:detail.pay_price});
    if(detail.state!=='UNSELECTED' || this.options.readOnly)return;
    const capabilities=await this.readCapabilities(detail);
    if(s.current())this.publish({capabilities});
  }
  private async readCapabilities(detail:OfflineDetail) {
    let response:unknown;
    try {response=await this.options.capabilities(detail.order_id);}
    catch {throw Error('支付方式暂时无法核验，请重新读取原消费；本页未发送付款请求');}
    return decodeOfflineCapabilities(response,detail);
  }
  private async run(work: (scope: ReturnType<OfflineCashier['scope']>) => Promise<void>, mutating = false, errorSource:OfflineView['errorSource']='cashier') {
    if (!this.visible || !this.validRoute || this.state.busy) return;
    const s = this.scope(); if (!s.current()) { this.publish({ error: '请登录后核对原消费' }); return; }
    this.publish({ busy:true,error:'',errorSource });
    try {
      if (mutating && this.options.exclusive) await this.options.exclusive(async()=>{if(s.current())await work(s);});
      else await work(s);
    } catch (e) { if (s.current()) this.publish({ error: message(e) }); }
    finally { if (s.current()) this.publish({ busy:false }); }
  }
  edit(value: string) { if (!this.options.readOnly && this.visible && this.validRoute && !this.state.busy && !this.state.intent && !this.routeId) this.publish({ money:value,quote:'',error:'',reprice:'' }); }
  searchHistory(query:string) {
    if(this.visible && this.validRoute && !this.state.busy && !this.options.readOnly)this.publish({history:{...emptyOfflineHistory(),query}});
  }
  async loadHistory(next=false) {
    if(this.options.readOnly)return;
    await this.run(async s=>{
      if(this.options.readOnly)return;
      const current=this.state.history,query=current.query.trim(),cursor=next?current.nextCursor:current.pageCursor;
      if(query)offlineOrderId(query);
      if(next && !cursor)return;
      this.publish({history:{...emptyOfflineHistory(),query,pageCursor:cursor}});
      let raw:unknown;
      try {raw=await this.options.history(query?{order_id:query}:cursor?{cursor}:{});}
      catch {throw Error('消费记录读取失败，请重试本页；没有发起建单或付款');}
      if(!s.current())return;
      const result=decodeOfflineHistory(raw,query);
      this.publish({history:{...result,query,pageCursor:cursor,loaded:true}});
    },false,'history');
  }
  /** User-selected recovery saves only an owned order pointer. Never invent an
   * admission UUID, reconstruct a draft, overwrite another journal or pay here. */
  async recover(orderId:string) {
    if(this.options.readOnly || this.routeId)return;
    await this.run(async s=>{
      if(this.options.readOnly || this.routeId)return;
      const id=offlineOrderId(orderId),stored=this.options.journal.read(s.uid);
      if(stored && stored.orderId!==id)throw Error('另有待确认消费，请先核对；不会覆盖原记录');
      this.publish({detail:null,capabilities:null});
      const detail=decodeOfflineDetail(await this.options.read(id),id,stored?.draft);if(!s.current())return;
      const intent=stored?this.options.journal.current(stored):this.options.journal.recover(s.uid,id);
      this.routeId='';this.publish({intent,history:emptyOfflineHistory(),reprice:''});
      await this.acceptDetail(detail,s);
    },true,'history');
  }
  async quote() {
    await this.run(async s => {
      if (this.options.readOnly || this.state.intent || this.routeId) return;
      const money = offlineMoney(this.state.money); this.publish({ money,quote:'' });
      const response = object(await this.options.quote(money)); if (!s.current()) return;
      only(response,['pay_price']); const quote = response.pay_price === 0 ? money : offlineMoney(response.pay_price,true);
      if (quote === '0.00') throw Error(OFFLINE_MIN_PAYABLE_MESSAGE);
      this.publish({ quote });
    });
  }
  async create(reprice = false) {
    if (!this.state.intent && !this.state.quote && !reprice) return;
    await this.run(async s => {
      if (this.options.readOnly || this.routeId || this.state.intent?.orderId || this.state.intent?.version===2) return;
      let intent = this.state.intent;
      // A corrupt/foreign saved journal always blocks, including after show() failed.
      const stored = this.options.journal.read(s.uid);
      if (!intent && stored) throw Error('已有原消费记录，请重新读取');
      if (intent) this.options.journal.current(intent);
      if (reprice) {
        if (!intent || !this.state.reprice) return;
        if (this.state.reprice === '0.00') throw Error(OFFLINE_MIN_PAYABLE_MESSAGE);
        intent = this.options.journal.update(intent, { draft:{ ...intent.draft,expected_pay_price:this.state.reprice } });
        this.publish({ intent,quote:this.state.reprice,reprice:'' });
      }
      if (!intent) {
        const money = offlineMoney(this.state.money), quote = offlineMoney(this.state.quote,true);
        if (quote === '0.00') throw Error(OFFLINE_MIN_PAYABLE_MESSAGE);
        const key = await this.options.key(); if (!s.current()) return;
        intent = this.options.journal.begin(s.uid, { money,expected_pay_price:quote,from:this.options.channel(),request_key:key });
        this.publish({ intent });
      }
      const original = intent;
      if (original.draft.expected_pay_price === '0.00') throw Error(`${OFFLINE_MIN_PAYABLE_MESSAGE}；原记录保留，请查询已有消费核对`);
      try {
        const r = object(await this.options.create({ ...original.draft })); if (!s.current()) return;
        only(r,['order_id','pay_price','replayed']);
        const id = offlineOrderId(r.order_id);
        if (r.pay_price !== original.draft.expected_pay_price || typeof r.replayed !== 'boolean') throw Error('建单响应与原消费不符，请重试原请求');
        intent = this.options.journal.update(original,{orderId:id}); this.publish({ intent,detail:null,reprice:'' });
        const detail = decodeOfflineDetail(await this.options.read(id),id,intent.draft);
        await this.acceptDetail(detail,s);
      } catch (e) {
        if (!s.current()) return;
        const problem = e && typeof e === 'object' ? object(e) : {};
        if (problem.status === 409 && problem.data && typeof problem.data === 'object') {
          const data = object(problem.data);
          if (Object.keys(data).length === 1 && 'pay_price' in data) this.publish({ reprice:offlineMoney(data.pay_price,true) });
        }
        throw Error(`建单结果尚未确认；保留原请求重试，不要另建消费。${message(e)}`);
      }
    }, true);
  }
  async refresh() {
    await this.run(async s => {
      this.publish({ detail:null,capabilities:null });
      const intent = this.state.intent; if (intent) this.options.journal.current(intent);
      const id = this.routeId || intent?.orderId;
      if (!id) throw Error('原建单结果未知，请重试原建单请求');
      const detail = decodeOfflineDetail(await this.options.read(id),id,intent?.draft);
      await this.acceptDetail(detail,s);
    });
  }
  async pay(selected: OfflineMethod) {
    // An unavailable/no-op invocation must not erase the explanation from a
    // failed capability read. Recheck again inside the exclusive operation.
    if(this.options.readOnly || !method(selected) || this.state.capabilities?.methods[selected]!=='available')return;
    await this.run(async s => {
      const prior = this.state.detail; let intent = this.state.intent;
      if (this.options.readOnly || !prior || prior.state !== 'UNSELECTED' || prior.paid || prior.hidden || prior.pay_price === '0.00'
        || !method(selected) || this.state.capabilities?.methods[selected]!=='available') return;
      // A linked order may have no local draft. Persist a recovery-only pointer
      // inside the same browser lock before any possible payment request.
      intent=this.preserveOriginal(s.uid,prior.order_id,intent);
      this.publish({intent});
      this.publish({capabilities:null});
      const capabilities=await this.readCapabilities(prior);
      if(!s.current())return;
      this.publish({capabilities});
      if(capabilities.methods[selected]!=='available')throw Error(`此方式已不可用：${offlineMethodMessage(capabilities.methods[selected])}，本页未发送付款请求`);
      if (intent) this.publish({ intent:this.options.journal.update(intent,{method:selected}) });
      const id = prior.order_id; this.publish({ detail:null,capabilities:null });
      const result = await this.options.pay(id,selected); if (!s.current()) return;
      const detail = decodeOfflineDetail(result,id,intent?.draft);
      if (detail.pay_type !== selected) throw Error('支付响应与所选路径不符，请重新读取原消费');
      this.publish({ detail });
    }, true);
  }
  async open(launch: (ticket: OfflineTicket) => Promise<void>) {
    await this.run(async s => {
      const prior = this.state.detail; if (this.options.readOnly || prior?.state !== 'READY') return;
      this.publish({ detail:null });
      const id = prior.order_id, intent = this.preserveOriginal(s.uid,id,this.state.intent);this.publish({intent});
      const detail = decodeOfflineDetail(await this.options.read(id),id,intent?.draft); if (!s.current()) return;
      this.publish({ detail });
      if (detail.state !== 'READY' || !detail.ticket || (detail.display_until ?? 0) * 1000 <= (this.options.now?.() ?? Date.now())) throw Error('原入口不再可用，请核对原支付结果；不会重新发起');
      await launch(detail.ticket); if (!s.current()) return;
      this.publish({ detail:null });
      const latest = decodeOfflineDetail(await this.options.read(id),id,intent?.draft);
      if (s.current()) this.publish({ detail:latest });
    },true);
  }
  private preserveOriginal(uid:number,id:string,intent:OfflineSavedIntent|null):OfflineSavedIntent {
    if(intent) {
      if(intent.orderId!==id)throw Error('原消费记录不一致');
      return this.options.journal.current(intent);
    }
    return this.options.journal.recover(uid,id);
  }
  async newPurchase() {
    await this.run(async()=>{
      if (this.options.readOnly || this.routeId) return;
      if (!this.state.intent || !this.state.detail) return;
      this.options.journal.clearPaid(this.state.intent,this.state.detail);
      this.publish({ money:'',quote:'',intent:null,detail:null,capabilities:null,error:'',reprice:'',history:emptyOfflineHistory() });
    },true);
  }
}
const message = (e: unknown) => e instanceof Error ? e.message : '收银请求失败，请核对原消费';
export function offlineStatus(detail: OfflineDetail | null): string {
  if (!detail) return '支付结果待核对';
  if (detail.state === 'UNAVAILABLE' && detail.pay_price === '0.00') return '零元消费不可付款（最低应付0.01元）';
  return { UNSELECTED:'待选择支付方式',READY:'支付入口已准备，尚未确认到账',RECOVERY_REQUIRED:'支付结果核对中，请勿重复支付',
    UNAVAILABLE:'当前消费不可继续付款',PAID:'支付成功',REVIEW_REQUIRED:'收款记录需人工核对' }[detail.state];
}
