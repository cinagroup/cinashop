import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { user } from '@/models/schema';
import { AuthException, ApiErrorCode } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
export interface BuyerReviewActor { uid:number; authVersion:string; expiresAt:number }
export async function actorInDatabase(db:DbClient,actor:BuyerReviewActor,lock=false) {
  if (!Number.isInteger(actor.uid)||actor.uid<=0||actor.uid>2147483647||!actor.authVersion||!Number.isInteger(actor.expiresAt)||actor.expiresAt<=Math.floor(Date.now()/1000))
    throw new AuthException('登录已过期，请重新登录',ApiErrorCode.ERR_EXPIRED);
  const query=db.select({pwd:user.pwd,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime}).from(user).where(eq(user.uid,actor.uid)).limit(1);
  const [row]=await (lock?query.for('share',{noWait:true}):query);
  if (!row||row.status!==1||row.isDel||row.deleteTime!==null||![md5(row.pwd),row.pwd].includes(actor.authVersion))
    throw new AuthException('登录状态已变化，请重新登录',ApiErrorCode.ERR_EXPIRED);
}
