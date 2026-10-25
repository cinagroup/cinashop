import { DIY_STATE_DEFAULTS } from './diyStateDefaults';
import { navigationDocument, navigationRecord, navRead, navSet, navTimestamp, NAVIGATION_BODY_NAMES } from './diyNavigationEditor';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';
import { normalizeDiyStateWidget, statePreviewTheme } from './diyStateProjection';

export const STATE_NAMES = ['userInfor', 'newVip', 'signIn', 'ranking'] as const;
export type StateKind = typeof STATE_NAMES[number];
export type StateRecord = Record<string, unknown>;
export const stateLabels: Record<StateKind,string> = { userInfor:'会员信息', newVip:'新人专区', signIn:'签到', ranking:'排行榜' };
export const stateKind = (value: unknown): StateKind|null => STATE_NAMES.includes(value as StateKind) ? value as StateKind : null;
export const stateDocument = navigationDocument, stateRecord = navigationRecord, stateRead = navRead;
export function stateNumber(raw: unknown, fallback=0): number { const value=typeof raw==='number'||typeof raw==='string'&&raw.trim()!==''?Number(raw):NaN;return Number.isFinite(value)&&value>=0?value:fallback; }
export function stateEntries(value: unknown[]) { return value.flatMap((row,index)=>{const kind=stateKind(stateRecord(row)?.name);return kind?[{index,kind}]:[];}).sort((a,b)=>navTimestamp(value[a.index])-navTimestamp(value[b.index])||a.index-b.index); }
export function newStateBlock(kind: StateKind,timestamp: number): StateRecord { const block:StateRecord=structuredClone(DIY_STATE_DEFAULTS[kind]);block.timestamp=timestamp;return block; }
export function addStateBlock(value:unknown[],kind:StateKind) {
  if(!stateKind(kind))throw Error('会员权益组件类型无效');
  const copy=structuredClone(value),ordinary=copy.filter(row=>NAVIGATION_BODY_NAMES.includes(stateRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]));
  const maximum=Math.max(0,...ordinary.map(navTimestamp)),timestamp=maximum+Math.max(1,Math.abs(maximum)*Number.EPSILON*2);
  if(!Number.isSafeInteger(timestamp)||timestamp<=maximum)throw Error('排序空间不足，请先明确调整排序');
  const footer=copy.findIndex(row=>String(stateRecord(row)?.name).toLowerCase()==='pagefoot'),selected=footer<0?copy.length:footer;
  copy.splice(selected,0,newStateBlock(kind,timestamp));return{value:copy,selected};
}
export function moveStateBlock(value:unknown[],selected:number,direction:-1|1) {
  if(!stateKind(stateRecord(value[selected])?.name))throw Error('未选择会员权益组件');
  const indices=value.map((_,index)=>index).filter(index=>NAVIGATION_BODY_NAMES.includes(stateRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number])).sort((a,b)=>navTimestamp(value[a])-navTimestamp(value[b])||a-b);
  const target=indices[indices.indexOf(selected)+direction];
  if(target===undefined||['homeComb','headerSerch','tabNav','pageFoot'].includes(String(stateRecord(value[target])?.name)))throw Error('不能越过头部或底部导航');
  const a=navTimestamp(value[selected]),b=navTimestamp(value[target]);if(a===b||[a,b].includes(Number.MAX_SAFE_INTEGER))throw Error('相同或异常排序值需要先明确调整');
  const copy=structuredClone(value);[stateRecord(copy[selected])!.timestamp,stateRecord(copy[target])!.timestamp]=[b,a];[copy[selected],copy[target]]=[copy[target],copy[selected]];return{value:copy,selected:target};
}
export function canonicalStateBlock(raw:StateRecord):StateRecord { const block=structuredClone(raw),key=block.name==='userInfor'?'logoConfig':block.name==='ranking'?'imgConfig':null,field=key?stateRecord(block[key]):null;if(field&&typeof field.url==='string')field.url=canonicalPresentationReference(field.url);return block; }
export function canonicalStateValue(raw:string):string { const value:unknown=JSON.parse(raw);if(value===null)throw Error('装修 value 不能为null');if(Array.isArray(value))for(let i=0;i<value.length;i++){const row=stateRecord(value[i]);if(row&&stateKind(row.name))value[i]=canonicalStateBlock(row);}return JSON.stringify(value); }
export function statePreviewBlock(raw:StateRecord,previews:Record<string,string>):StateRecord {const block=structuredClone(raw),key=block.name==='userInfor'?'logoConfig':block.name==='ranking'?'imgConfig':null,field=key?stateRecord(block[key]):null;if(field&&typeof field.url==='string')field.url=presentationPreviewForReference(field.url,previews[canonicalPresentationReference(field.url)])||presentationPreviewUrl(field.url);return block;}
export function statePixelStyle(style:Record<string,string>) {return Object.fromEntries(Object.entries(style).map(([key,value])=>[key,value.replace(/(?<![\w.])([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)rpx/giu,(_,n:string)=>`${Number(n)/2}px`)]));}
export interface StateColour {key:string;index:number;label:string;fallback:string}
export function stateColours(kind:StateKind):StateColour[] {const output:StateColour[]=[];const names:Record<string,string>=kind==='newVip'?{bntColor:'积分按钮背景',bntBgColor:'优惠券按钮背景',couponBgColor:'经典优惠券背景',couponBgColor2:'现代优惠券背景'}:kind==='signIn'?{moduleColor:'奖励组件背景',moduleColor2:'每周组件背景'}:{};for(const[key,raw]of Object.entries(DIY_STATE_DEFAULTS[kind])){const field=stateRecord(raw);if(!Array.isArray(field?.color))continue;for(const[index,value]of field.color.entries()){const item=stateRecord(value);output.push({key,index,label:`${names[key]??String(field.title??key)}${field.color.length>1?index===0?'起始色':'结束色':''}`,fallback:typeof item?.item==='string'?item.item:'#ffffff'});}}return output;}
export function stateChecks(block:StateRecord,id:number,checked:boolean) {const kind=stateKind(block.name);if(kind!=='userInfor'&&kind!=='newVip'||!Number.isInteger(id)||id<0||id>(kind==='userInfor'?5:2))throw Error('展示信息无效');const raw=navRead(block,['checkboxInfo','type']);if(raw!==undefined&&!Array.isArray(raw))throw Error('已存展示信息结构异常，请在JSON中明确修复');const items=structuredClone(Array.isArray(raw)?raw:normalizeDiyStateWidget(block,statePreviewTheme).checks);if(items.includes(id)===checked)return false;const next=items.filter(value=>value!==id);if(checked)next.push(id);navSet(block,['checkboxInfo','type'],next);return true;}
