/** A note is a separately editable description of an existing ledger row.
 * This closed comparison view does not authorize execution, alter an archive,
 * or suppress any financial/identity field. Callers still compare every column
 * and prove the complete row set and immutable refund lineage. */
import type {supplierFlowingWater} from '@/models/schema';
type Flow=typeof supplierFlowingWater.$inferSelect;
export const SUPPLIER_FLOW_DESCRIPTION_COLUMNS=['id','supplierId','uid','orderId','linkId','pm','number','type','payType',
 'payPrice','totalPrice','payPostage','remark','finishTime','status','mark','isDel','tradeTime','addTime'] as const satisfies readonly(keyof Flow)[];
function row(value:unknown):Flow|null {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return null;
 const record=value as Record<string,unknown>,keys=Reflect.ownKeys(record);
 if(keys.length!==SUPPLIER_FLOW_DESCRIPTION_COLUMNS.length||keys.some(key=>typeof key!=='string'||!SUPPLIER_FLOW_DESCRIPTION_COLUMNS.includes(key as keyof Flow)))return null;
 for(const key of keys){const property=Object.getOwnPropertyDescriptor(record,key);if(!property||!property.enumerable||!Object.hasOwn(property,'value'))return null;}
 const integer=(key:keyof Flow,min=0,max=2147483647)=>typeof record[key]==='number'&&Number.isSafeInteger(record[key])&&Number(record[key])>=min&&Number(record[key])<=max;
 const text=(key:keyof Flow,max:number)=>typeof record[key]==='string'&&[...(record[key] as string)].length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(record[key] as string);
 if(!integer('id',1)||!integer('supplierId')||!integer('uid')||!integer('pm',0,1)||!integer('type',0,32767)
  ||!integer('isDel',0,1)||!integer('status',-1,1)||!integer('finishTime')||!integer('tradeTime')||!integer('addTime')
  ||!text('orderId',50)||!text('linkId',50)||!text('payType',20)||!text('remark',512)||!text('mark',255))return null;
 for(const key of ['number','payPrice','totalPrice','payPostage'] as const)if(typeof record[key]!=='string'||!/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(record[key]))return null;
 return record as Flow;
}
/** The caller's exact original/frozen row remains authoritative for every
 * field. A valid current note is represented by that original note only while
 * comparing against that already protected row. Both inputs remain untouched. */
export function projectSupplierFlowDescription(current:unknown,frozen:unknown):Flow|null {
 const actual=row(current),original=row(frozen);if(!actual||!original)return null;
 return {...actual,mark:original.mark};
}
