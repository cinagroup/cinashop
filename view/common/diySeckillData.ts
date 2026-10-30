/** Public read models only. Business pictures never become authored media slots. */
export interface DiySeckillRow {
 id:number;productId:number;activityId:number;title:string;image:string;activityImage:string;
 price:string;oldPrice:string;people:number;count:number;stock:number;percent:number;integral:number;status:number;
}
export interface DiySeckillSlot {id:number;start_time:string;end_time:string;state:string;stop:number;status:number}
export interface DiySeckillSchedule {slots:DiySeckillSlot[];index:number}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('秒杀响应格式无效');return value as Record<string,unknown>;}
function integer(value:unknown,min=0,max=2147483647):number{if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw Error('秒杀数值无效');return Number(value);}
function text(value:unknown,max=1024):string{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))throw Error('秒杀文字无效');return value;}
function money(value:unknown):string{if(!(typeof value==='number'||typeof value==='string')||!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value)))throw Error('秒杀金额无效');const[whole,fraction='']=String(value).split('.');return `${whole}.${fraction.padEnd(2,'0')}`;}
function rows(value:unknown,max:number):Record<string,unknown>[]{if(!Array.isArray(value)||value.length>max)throw Error('秒杀列表格式无效');const seen=new Set<number>();return Array.from(value,item=>{const row=record(item),id=integer(row.id,1);if(seen.has(id))throw Error('秒杀标识重复');seen.add(id);return row;});}
export function checkedDiySeckillSchedule(value:unknown):DiySeckillSchedule{
 const result=record(value),slots=rows(result.seckillTime,1000).map(row=>({id:integer(row.id,1),start_time:text(row.start_time,16),end_time:text(row.end_time,16),state:text(row.state,64),stop:integer(row.stop,0,9999999999),status:integer(row.status,0,2)}));
 const index=integer(result.seckillTimeIndex,-1);if(index>=slots.length)throw Error('秒杀当前时段无效');return{slots,index};
}
export function checkedDiySeckillLimit(limit:number){if(!Number.isInteger(limit)||limit<1||limit>10)throw Error('秒杀商品预览数量必须为1至10的整数');}
/** All rows including the tail are validated before a caller sees any product. */
export function checkedDiySeckillRows(value:unknown,limit:number,safeImage:(value:unknown)=>string):DiySeckillRow[]{
 checkedDiySeckillLimit(limit);return rows(value,limit).map(row=>{const percent=row.percent;if(typeof percent!=='number'||!Number.isFinite(percent)||percent<0||percent>100)throw Error('秒杀进度无效');return{id:integer(row.id,1),productId:integer(row.product_id,1),activityId:integer(row.activity_id),title:text(row.title),image:safeImage(text(row.image,8192)),activityImage:safeImage(text(row.activity_image,8192)),price:money(row.price),oldPrice:money(row.ot_price),stock:integer(row.stock),percent,people:0,count:0,integral:0,status:0};});
}
