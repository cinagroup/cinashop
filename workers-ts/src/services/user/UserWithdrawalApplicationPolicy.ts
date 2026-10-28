import { asc, eq, and, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig, systemAttachment } from '@/models/schema';
import { normalizeConfigScalar, parseConfigInteger } from '@/utils/config';
import { ValidateException } from '@/utils/errors';
export const APPLICATION_CHANNELS = ['bank','balance','weixin','alipay'] as const;
export const APPLICATION_CONFIG_KEYS = ['user_extract_min_price','user_extract_max_price','withdraw_fee','brokerage_type','user_extract_balance_status','user_extract_bank_status','user_extract_wechat_status','user_extract_alipay_status','user_extract_bank','extract_time'];
export type WithdrawalChannel = typeof APPLICATION_CHANNELS[number];
/** Fresh SQL winners, never SystemConfigService/KV. In a funds transaction this
 * runs only after locking the account and resolving a successful old intent. */
export async function readWithdrawalApplicationConfig(db: DbClient): Promise<Record<string,string>> {
 const rows=await db.select({key:systemConfig.menuName,value:systemConfig.value}).from(systemConfig)
  .where(and(inArray(systemConfig.menuName,APPLICATION_CONFIG_KEYS),eq(systemConfig.isStore,0))).orderBy(asc(systemConfig.sort),asc(systemConfig.id));
 return Object.fromEntries(rows.map(row=>[row.key,row.value]));
}
function amount(value:string|undefined,label:string){const raw=normalizeConfigScalar(value)||'0';if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(raw))throw new ValidateException(label+'配置错误');const[w,f='']=raw.split('.');return{value:w+'.'+f.padEnd(2,'0'),cents:BigInt(w)*100n+BigInt(f.padEnd(2,'0'))};}
export function withdrawalApplicationPolicy(config:Record<string,string>){
 const min=amount(config.user_extract_min_price,'最低提现额'),max=amount(config.user_extract_max_price,'最高提现额');if(max.cents<=0n||min.cents>max.cents)throw new ValidateException('提现限额尚未配置完成');
 const rate=normalizeConfigScalar(config.withdraw_fee)||'0';if(!/^\d{1,3}(?:\.\d{1,6})?$/.test(rate)||BigInt(rate.split('.')[0])>=100n)throw new ValidateException('提现手续费配置错误');
 const[whole,fraction='']=rate.split('.'),decimal=fraction.replace(/0+$/,'');const fee_rate=String(BigInt(whole))+(decimal?'.'+decimal:'');
 const keys={bank:'user_extract_bank_status',balance:'user_extract_balance_status',weixin:'user_extract_wechat_status',alipay:'user_extract_alipay_status'};
 const channels=APPLICATION_CHANNELS.filter(channel=>parseConfigInteger(config[keys[channel]],1)===1);
 let bankValue:unknown=config.user_extract_bank??'';try{bankValue=JSON.parse(String(bankValue));}catch{/* PHP multiline bank config. */}
 if(Array.isArray(bankValue))bankValue=bankValue[0]??'';
 const banks=[...new Set(String(bankValue??'').replaceAll('\r\n','\n').split('\n').map(s=>s.trim()).filter(Boolean))];
 if(banks.length>100||banks.some(s=>[...s].length>64||/[\u0000-\u001f\u007f]/u.test(s)))throw new ValidateException('提现银行配置超出有效范围');
 return{min_amount:min.value,max_amount:max.value,fee_rate,freeze_days:Math.min(2147483647,Math.max(0,parseConfigInteger(config.extract_time,0))),channels,wechat_mode:parseConfigInteger(config.brokerage_type,0)===1?'automatic' as const:'manual' as const,banks};
}
export function withdrawalMediaId(reference:string){const match=/^\/api\/assets\/([1-9]\d{0,9})$/.exec(reference);const id=match?Number(match[1]):0;if(!Number.isSafeInteger(id)||id<=0||id>2147483647)throw new ValidateException('收款码须为本人已上传的规范图片');return id;}
/** Only ordinary user images, no platform defaults, external URLs or copied
 * signatures. The funds path holds the actual metadata row until commit. */
export async function authorizeWithdrawalMedia(db:DbClient,uid:number,reference:string,lock=false){
 const id=withdrawalMediaId(reference),query=db.select().from(systemAttachment).where(eq(systemAttachment.attId,id)).limit(1);
 const rows=lock?await query.for('share'):await query;const asset=rows[0],extension=asset&&/\.(jpe?g|png|webp|gif)$/i.exec(asset.name)?.[1]?.toLowerCase(),expected=extension?'image/'+(extension==='jpg'?'jpeg':extension):'';
 if(!asset||asset.type!==3||asset.relationId!==uid||asset.moduleType!==3||asset.fileType!==1||asset.imageType!==8||asset.attDir!==reference||!asset.name.startsWith(`attachments/user/${uid}/`)
  ||!/^[A-Za-z0-9_./-]+$/.test(asset.name)||asset.name.split('/').some(part=>!part||part==='.'||part==='..')||!expected||asset.attType.trim().toLowerCase().replace(/^image\/jpg$/,'image/jpeg')!==expected)throw new ValidateException('收款码不存在、类型不符或不属于本人');
 return reference;
}
export async function authorizeWithdrawalApplication(db:DbClient,uid:number,input:{extractType:string;realName:string;bankName:string;qrcodeUrl:string},config:Record<string,string>){
 const policy=withdrawalApplicationPolicy(config);if(!policy.channels.includes(input.extractType as WithdrawalChannel))throw new ValidateException('当前提现方式已关闭');
 if(['bank','alipay'].includes(input.extractType)&&!input.realName)throw new ValidateException('请填写收款人姓名');
 if(input.extractType==='bank'&&!policy.banks.includes(input.bankName))throw new ValidateException('请选择后台支持的银行');
 const needsCode=input.extractType==='alipay'||input.extractType==='weixin'&&policy.wechat_mode==='manual';
 if(needsCode)await authorizeWithdrawalMedia(db,uid,input.qrcodeUrl,true);else if(input.qrcodeUrl!=='')throw new ValidateException('当前提现方式不使用收款码');
}
