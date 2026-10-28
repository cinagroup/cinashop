import { eq, and, isNull, sql } from 'drizzle-orm';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { user,userBrokerage,userExtract } from '@/models/schema';
import { AuthException,NotFoundException } from '@/utils/errors';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { signAttachmentReferences } from '@/services/system/AttachmentService';
import { authorizeWithdrawalMedia,readWithdrawalApplicationConfig,withdrawalApplicationPolicy } from './UserWithdrawalApplicationPolicy';
export class UserWithdrawalApplicationService {
 constructor(private readonly container:Container,private readonly appKey:string){}
 private async read<T>(uid:number,run:(tx:DbClient)=>Promise<T>){if(!Number.isSafeInteger(uid)||uid<=0||uid>2147483647)throw new AuthException();return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);await themeDeadlines(tx);const owner=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,uid),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).limit(1);if(!owner[0])throw new NotFoundException('用户不存在或已被禁用');return run(tx);});}
 async config(uid:number){return this.read(uid,async tx=>{
  const config=withdrawalApplicationPolicy(await readWithdrawalApplicationConfig(tx));
  const [amounts]=await tx.execute<{brokerage_amount:string;frozen_amount:string;withdrawable_amount:string}>(sql`select round(u.brokerage_price,2)::text as brokerage_amount,round(f.amount,2)::text as frozen_amount,round(greatest(u.brokerage_price-f.amount,0),2)::text as withdrawable_amount from ${user} u cross join lateral(select greatest(coalesce(sum(number),0),0) as amount from ${userBrokerage} where uid=u.uid and pm=1 and status=1 and frozen_time>${Math.floor(Date.now()/1000)}) f where u.uid=${uid}`);
  return{owner_uid:uid,...amounts,...config};});}
 async media(uid:number,reference:string){const authorized=await this.read(uid,tx=>authorizeWithdrawalMedia(tx,uid,reference));const[preview]=await signAttachmentReferences(this.appKey,[authorized]);return{owner_uid:uid,reference:authorized,preview};}
 async receipt(uid:number,requestId:string){return this.read(uid,async tx=>{
  const rows=await tx.execute<{receipt:unknown}>(sql`select jsonb_build_object('id',id,'extract_type',extract_type,'gross_amount',round(extract_price+extract_fee,2)::text,'net_amount',round(extract_price,2)::text,'fee_amount',round(extract_fee,2)::text,'status',case when status in(-1,0,1) then status else null end,'add_time',add_time,'time',case when add_time<>0 then to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai','YYYY/MM/DD HH24:MI:SS') else '' end,'withdrawal_message',case when status=-1 then fail_msg else '' end) as receipt from ${userExtract} where uid=${uid} and request_key=${requestId} limit 1`);
  return{owner_uid:uid,request_id:requestId,found:!!rows[0],receipt:rows[0]?.receipt??null};});}
}
