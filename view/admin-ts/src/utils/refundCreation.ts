import { applyOperationResult, operationBody, operationHash, operationMessage, operationResolved, parseOperationResult,
  parseRefundOperation, type RefundOperation } from './refundOperation';

export const creationVersion = 'admin-refund-creation-v1' as const;
export const creationQuoteVersion = 'admin-refund-creation-quote-v1' as const;
export interface CreationItem { cartId: number; cartNum: number }
export interface CreationSelection { version: typeof creationQuoteVersion; orderId: number; mode: 'remaining' | 'items'; items: CreationItem[] }
export interface CreationReview {
  id: number; orderId: string; uid: number; storeId: number; supplierId: number;
  payPrice: string; totalNum: number; status: number; refundPrice: string; payType: string;
}
export interface CreationQuote {
  version: typeof creationQuoteVersion; review: CreationReview; mode: 'remaining' | 'items'; items: CreationItem[];
  quotedPrice: string; refundNum: number; refundTimeDays: number; receivedAt: number | null; quoteFingerprint: string;
}
export interface CreationBody {
  version: typeof creationVersion; review: CreationReview; mode: 'remaining' | 'items'; items: CreationItem[];
  quotedPrice: string; refundPrice: string; reason: string; quoteFingerprint: string;
}
export interface CreationReceipt {
  version: typeof creationVersion; adminId: number; requestKey: string; requestHash: string; orderId: number;
  outcome: 'created' | 'abandoned'; refundId: number | null;
}
export interface CreationIntent {
  version: 1; actorId: number; orderId: number; nonce: string; createdAt: number; body: CreationBody; requestHash: string;
  receipt: CreationReceipt | null; operation: RefundOperation | null; phase: 'pending' | 'resolved';
}
export type CreationMode = 'create' | 'execute' | 'receipt' | 'abandon';
const invalid = () => Error('主动退款记录或回执无效，请保留原记录并核对');
function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (keys && (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)))) throw invalid();
  return row;
}
function id(value: unknown, min = 1, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value.trim();
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw invalid();
  const [whole, fraction] = value.split('.'); return BigInt(whole).toString() + '.' + fraction;
}
const cents = (value: string) => BigInt(value.replace('.', ''));
function hashText(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid(); return value;
}
function review(value: unknown): CreationReview {
  const r = record(value, ['id','orderId','uid','storeId','supplierId','payPrice','totalNum','status','refundPrice','payType']);
  return { id:id(r.id),orderId:text(r.orderId,32),uid:id(r.uid),storeId:id(r.storeId,0),supplierId:id(r.supplierId,0),
    payPrice:money(r.payPrice),totalNum:id(r.totalNum),status:id(r.status,0,5),refundPrice:money(r.refundPrice),payType:text(r.payType,32) };
}
function items(value: unknown, allowEmpty = false): CreationItem[] {
  if (!Array.isArray(value) || value.length > 100 || !allowEmpty && !value.length) throw invalid();
  const result = value.map(value => { const r=record(value,['cartId','cartNum']); return {cartId:id(r.cartId),cartNum:id(r.cartNum)}; }).sort((a,b)=>a.cartId-b.cartId);
  if (new Set(result.map(row=>row.cartId)).size !== result.length) throw invalid(); return result;
}
export function creationSelection(orderId: number, mode: 'remaining' | 'items', selected: CreationItem[] = []): CreationSelection {
  if (mode !== 'items' && mode !== 'remaining') throw invalid();
  const result = items(selected,mode==='remaining'); if (mode==='remaining' && result.length) throw invalid();
  return {version:creationQuoteVersion,orderId:id(orderId),mode,items:result};
}
export function parseCreationQuote(value: unknown, selection: CreationSelection): CreationQuote {
  const expected=creationSelection(selection.orderId,selection.mode,selection.items);
  const r=record(value,['version','review','mode','items','quotedPrice','refundNum','refundTimeDays','receivedAt','quoteFingerprint']);
  const identity=review(r.review), selected=items(r.items), quantity=id(r.refundNum);
  if (r.version!==creationQuoteVersion || identity.id!==expected.orderId || r.mode!==expected.mode
    || selected.reduce((sum,item)=>sum+item.cartNum,0)!==quantity || quantity>identity.totalNum
    || expected.mode==='items' && JSON.stringify(selected)!==JSON.stringify(expected.items)) throw invalid();
  const quotedPrice=money(r.quotedPrice);
  if (cents(quotedPrice)>cents(identity.payPrice)-cents(identity.refundPrice)) throw invalid();
  return {version:creationQuoteVersion,review:identity,mode:expected.mode,items:selected,quotedPrice,refundNum:quantity,
    refundTimeDays:id(r.refundTimeDays,0,36500),receivedAt:r.receivedAt===null?null:id(r.receivedAt,0,Number.MAX_SAFE_INTEGER),quoteFingerprint:hashText(r.quoteFingerprint)};
}
export function parseCreationBody(value: unknown): CreationBody {
  const r=record(value,['version','review','mode','items','quotedPrice','refundPrice','reason','quoteFingerprint']);
  if (r.version!==creationVersion || r.mode!=='remaining' && r.mode!=='items') throw invalid();
  const identity=review(r.review), selection=creationSelection(identity.id,r.mode,items(r.items,true));
  const quotedPrice=money(r.quotedPrice),refundPrice=money(r.refundPrice);
  if (cents(refundPrice)>cents(quotedPrice)) throw Error('退款金额不得超过本次报价上限');
  const body: CreationBody={version:creationVersion,review:identity,mode:selection.mode,items:selection.items,
    quotedPrice,refundPrice,reason:text(r.reason,255),quoteFingerprint:hashText(r.quoteFingerprint)};
  if (new TextEncoder().encode(JSON.stringify(body)).length>8192) throw invalid(); return body;
}
function canonical(value: unknown): string {
  if (value===null || typeof value!=='object') return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  const row=record(value); return '{'+Object.keys(row).sort().map(key=>JSON.stringify(key)+':'+canonical(row[key])).join(',')+'}';
}
async function bodyHash(body: CreationBody): Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(body)));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function parseCreationReceipt(value: unknown, intent: Pick<CreationIntent,'actorId'|'orderId'|'nonce'|'requestHash'>): CreationReceipt {
  const r=record(value,['version','adminId','requestKey','requestHash','orderId','outcome','refundId']);
  if (r.version!==creationVersion || r.adminId!==intent.actorId || r.orderId!==intent.orderId || r.requestKey!==intent.nonce || r.requestHash!==intent.requestHash
    || r.outcome!=='created' && r.outcome!=='abandoned' || r.outcome==='abandoned' && r.refundId!==null) throw invalid();
  return {version:creationVersion,adminId:intent.actorId,orderId:intent.orderId,requestKey:intent.nonce,requestHash:intent.requestHash,
    outcome:r.outcome,refundId:r.outcome==='created'?id(r.refundId):null};
}
export function creationResolved(intent: Pick<CreationIntent,'receipt'|'operation'>) {
  return intent.receipt?.outcome==='abandoned' || !!intent.operation && operationResolved(intent.operation);
}
export function parseCreationIntent(value: unknown, actorId: number, orderId: number): CreationIntent {
  const r=record(value,['version','actorId','orderId','nonce','createdAt','body','requestHash','receipt','operation','phase']);
  id(actorId);id(orderId);
  if (r.version!==1 || r.actorId!==actorId || r.orderId!==orderId || typeof r.nonce!=='string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.nonce)) throw invalid();
  const body=parseCreationBody(r.body);if(body.review.id!==orderId)throw invalid();
  const intent:CreationIntent={version:1,actorId,orderId,nonce:r.nonce,createdAt:id(r.createdAt,1,Number.MAX_SAFE_INTEGER),body,
    requestHash:hashText(r.requestHash),receipt:null,operation:null,phase:'pending'};
  intent.receipt=r.receipt===null?null:parseCreationReceipt(r.receipt,intent);
  if (r.operation!==null) {
    if(intent.receipt?.outcome!=='created' || !intent.receipt.refundId)throw invalid();
    intent.operation=parseRefundOperation(r.operation,actorId,intent.receipt.refundId);
    const expected=financialFields(intent);
    if(intent.operation.nonce!==intent.nonce || intent.operation.createdAt!==intent.createdAt
      || JSON.stringify(operationBody(intent.operation))!==JSON.stringify(operationBody(expected)))throw invalid();
  }
  intent.phase=creationResolved(intent)?'resolved':'pending'; if(r.phase!==intent.phase)throw invalid();return intent;
}
function financialFields(intent: CreationIntent) {
  if(intent.receipt?.outcome!=='created' || !intent.receipt.refundId)throw invalid();
  const r=intent.body.review, bytes=intent.nonce.replaceAll('-','').match(/../g)!.map(pair=>Number.parseInt(pair,16));
  const number='AR'+intent.actorId.toString(36)+'_'+btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  return {nonce:intent.nonce,actorId:intent.actorId,refundId:intent.receipt.refundId,action:'refund' as const,applyType:4,initialStatus:0,
    received:false,reason:'',createdAt:intent.createdAt,review:{uid:r.uid,storeOrderId:r.id,storeId:r.storeId,supplierId:r.supplierId,orderId:number,refundPrice:intent.body.refundPrice}};
}
export async function creationFinancialIntent(input: CreationIntent): Promise<RefundOperation> {
  const intent=parseCreationIntent(input,input.actorId,input.orderId), fields=financialFields(intent);
  const requestHash=await operationHash(fields);
  if(intent.operation) { if(intent.operation.requestHash!==requestHash)throw invalid();return intent.operation; }
  return parseRefundOperation({...fields,version:3,requestHash,receipt:null,execution:null,phase:'pending'},intent.actorId,fields.refundId);
}
export async function verifyCreationIntent(value: unknown, actorId: number, orderId: number) {
  const intent=parseCreationIntent(value,actorId,orderId);
  if(await bodyHash(intent.body)!==intent.requestHash)throw invalid();
  if(intent.operation)await creationFinancialIntent(intent);return intent;
}
export async function makeCreationIntent(actorId: number, quote: CreationQuote, refundPrice: string, reason: string) {
  // Copy all confirmed facts synchronously, before the digest yields.
  const q=parseCreationQuote(quote,creationSelection(quote.review.id,quote.mode,quote.mode==='items'?quote.items:[]));
  const body=parseCreationBody({version:creationVersion,review:q.review,mode:q.mode,items:q.mode==='items'?q.items:[],
    quotedPrice:q.quotedPrice,refundPrice,reason,quoteFingerprint:q.quoteFingerprint});
  const nonce=crypto.randomUUID(),createdAt=Date.now();id(actorId);
  return parseCreationIntent({version:1,actorId,orderId:q.review.id,nonce,createdAt,body,requestHash:await bodyHash(body),receipt:null,operation:null,phase:'pending'},actorId,q.review.id);
}
export async function applyCreationResponse(input: CreationIntent, value: unknown, mode: CreationMode): Promise<CreationIntent> {
  const intent=await verifyCreationIntent(input,input.actorId,input.orderId);
  const r=record(value,mode==='execute'?['version','creation','operation']:mode==='create'?['version','receipt','replayed']:['version','receipt']);
  if(r.version!==creationVersion || mode==='create' && typeof r.replayed!=='boolean')throw invalid();
  const source=mode==='execute'?record(r.creation,['receipt','replayed']):r;
  if(mode==='execute' && typeof source.replayed!=='boolean')throw invalid();
  const receipt=mode==='receipt' && source.receipt===null?null:parseCreationReceipt(source.receipt,intent);
  if(intent.receipt && JSON.stringify(receipt)!==JSON.stringify(intent.receipt))throw invalid();
  const next={...intent,receipt};
  if(mode==='execute') {
    if(receipt?.outcome==='abandoned') { if(r.operation!==null)throw invalid(); }
    else {
      const operation=record(r.operation,['receipt','replayed','execution']);
      const original=await creationFinancialIntent(next);
      next.operation=applyOperationResult(original,parseOperationResult({version:'admin-refund-operation-v1',...operation},original,'execute'));
    }
  }
  return parseCreationIntent({...next,phase:creationResolved(next)?'resolved':'pending'},intent.actorId,intent.orderId);
}
export async function applyCreationFinancialResult(input: CreationIntent, result: Parameters<typeof applyOperationResult>[1]) {
  const intent=await verifyCreationIntent(input,input.actorId,input.orderId);
  const next={...intent,operation:applyOperationResult(await creationFinancialIntent(intent),result)};
  return parseCreationIntent({...next,phase:creationResolved(next)?'resolved':'pending'},intent.actorId,intent.orderId);
}
export function creationIntentKey(actorId: number, orderId: number) { return `admin-refund-creation-v1:${id(actorId)}:${id(orderId)}`; }
export async function readCreationIntent(actorId: number, orderId: number) {
  const key=creationIntentKey(actorId,orderId), raw=localStorage.getItem(key);
  if(raw && raw.length>32768)throw invalid();
  const intent=raw===null?null:await verifyCreationIntent(JSON.parse(raw),actorId,orderId);
  if(localStorage.getItem(key)!==raw)throw Error('其他标签页已更新主动退款，请重新打开核对');return {raw,intent};
}
/** Hold the order Web Lock for compare-and-swap and dispatch. Retain terminal
 * tombstones; an old null snapshot may never overwrite an unknown operation. */
export function writeCreationIntent(intent: CreationIntent, expectedRaw: string | null) {
  const key=creationIntentKey(intent.actorId,intent.orderId),raw=JSON.stringify(parseCreationIntent(intent,intent.actorId,intent.orderId));
  if(localStorage.getItem(key)!==expectedRaw)throw Error('其他标签页已更新主动退款，请重新打开核对');
  localStorage.setItem(key,raw);if(localStorage.getItem(key)!==raw)throw Error('原主动退款请求未可靠保存，禁止提交');return raw;
}
export async function withCreationLock<T>(orderId: number, work: () => Promise<T>): Promise<T> {
  id(orderId);
  const locks=typeof navigator==='undefined'?undefined:Reflect.get(navigator,'locks') as {
    request<R>(name:string,options:{mode:'exclusive';ifAvailable:true},callback:(lock:object|null)=>Promise<R>):Promise<R>;
  } | undefined;
  if(!locks?.request)throw Error('当前浏览器不支持 Web Locks，不能安全提交主动退款');
  return locks.request('admin-refund-creation:'+orderId,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)throw Error('另一标签页正在处理此订单，请稍后重新打开核对');return work();
  });
}
export function creationMessage(intent: CreationIntent): string {
  if(intent.receipt?.outcome==='abandoned')return '原创建请求已永久放弃；不是取消已创建的退款。可以重新读取报价。';
  if(intent.operation?.receipt)return operationMessage(intent.operation);
  if(intent.receipt?.outcome==='created')return `已确认创建退款单 ID ${intent.receipt.refundId}；尚未确认资金结果。查询资金回执不会执行退款。`;
  return '尚未确认创建结果；查询为空也不能排除迟到请求。请保留原键，不要新建请求。';
}
