import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {user,userLevel,systemUserLevel,userGroup,userLabel,userLabelRelation,userMoney,userBill,otherOrder,otherOrderStatus,storeCouponIssue,storeCouponUser,storeCouponIssueUser} from '@/models/schema';
import type {AdminUserBatchInput,AdminUserFinanceInput} from '@/services/admin/AdminMobileUserService';
import {NotFoundException,ValidateException} from '@/utils/errors';
const MAX_INTEGER=2147483647,MAX_MONEY_CENTS=999999999999,PLATFORM_TYPE=0,PLATFORM_RELATION_ID=0;
type UserRow=typeof user.$inferSelect;
export interface MobileUserCoreEvidence {userId:number;targetCount:number;moneyLedgerId?:number;integralLedgerId?:number;otherOrderId?:number;couponIssueId?:number}
export type MobileUserCoreAudit=(event:{operation:string;uids:number[];now:number;evidence:MobileUserCoreEvidence})=>Promise<void>;
export type MobileUserCoreRecord={kind:"money"|"integral"|"membership"|"wallet";id:number;values:Record<string,unknown>}|{kind:"membership_status";oid:number;values:Record<string,unknown>};
export interface MobileUserCoreExpectation {accounts:{uid:number;values:Partial<UserRow>}[];levels?:{uid:number;rows:(typeof userLevel.$inferSelect)[]}[];records?:MobileUserCoreRecord[];issue?:{id:number;remainCount:number};issueUsers?:{issueId:number;uids:number[];now:number;before:number[]}}
export interface MobileUserCoreOptions {expected?:(facts:MobileUserCoreExpectation)=>void;catalogLocked?:boolean;semanticNoop?:boolean;authorityLabel?:string;authorityRealm?:'customer';assertBeforeMutation?:(tx:DbClient)=>Promise<void>}
function centsFromStored(value: string): number {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidateException("用户当前余额异常，请先修复账户数据");
  }
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_MONEY_CENTS) {
    throw new ValidateException("用户当前余额异常，请先修复账户数据");
  }
  return result;
}

function formatMoney(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}


async function lockedUsers(tx: DbClient, uids: number[]): Promise<UserRow[]> {
  const rows = await tx.select().from(user).where(and(
    inArray(user.uid, uids),
    eq(user.isDel, 0),
    isNull(user.deleteTime),
  )).orderBy(asc(user.uid)).for("update");
  if (rows.length !== uids.length) throw new NotFoundException("部分用户不存在或已删除");
  return rows;
}


export async function applyMobileUserState(tx:DbClient,input:Extract<AdminUserBatchInput,{type:1|4|5}>,audit:MobileUserCoreAudit,options:MobileUserCoreOptions={}) {
      const accounts = await lockedUsers(tx, input.uids);
      const now = Math.floor(Date.now() / 1_000);
      await options.assertBeforeMutation?.(tx);
      if (input.type === 1) {
        const levelQuery = tx.select().from(systemUserLevel).where(and(
          eq(systemUserLevel.id, input.levelId),
          eq(systemUserLevel.isShow, 1),
          eq(systemUserLevel.isDel, 0),
        )).limit(1);
        const level = (await (options.catalogLocked ? levelQuery : levelQuery.for("share")))[0];
        if (!level) throw new NotFoundException("会员等级不存在或已停用");
        const account = accounts[0], beforeLevels=options.expected?await tx.select().from(userLevel).where(eq(userLevel.uid,account.uid)).orderBy(asc(userLevel.id)):[];
        let expectedLevels=beforeLevels;
        if (account.level !== input.levelId) {
          await tx.update(userLevel).set({ status: 0, isDel: 1 }).where(eq(userLevel.uid, account.uid));
          const existing = await tx.select({ id: userLevel.id }).from(userLevel).where(and(
            eq(userLevel.uid, account.uid),
            eq(userLevel.levelId, input.levelId),
          )).orderBy(asc(userLevel.id)).for("update");
          const levelData = {
            grade: level.grade,
            validTime: 0,
            isForever: level.isForever,
            merId: level.merId,
            status: 1,
            mark: `${options.authorityLabel ?? '管理员设置会员等级'}：${level.name}`.slice(0, 255),
            remind: 0,
            isDel: 0,
            addTime: now,
            discount: Math.round(Number(level.discount)),
          };
          let selectedId=existing[0]?.id;
          if (existing[0]) await tx.update(userLevel).set(levelData).where(eq(userLevel.id, existing[0].id));
          else if(options.expected){const [created]=await tx.insert(userLevel).values({uid:account.uid,levelId:input.levelId,...levelData}).returning();if(!created)throw Error("Level history creation failed");selectedId=created.id;expectedLevels.push(created);}
          else await tx.insert(userLevel).values({ uid: account.uid, levelId: input.levelId, ...levelData });
          if(options.expected) expectedLevels=expectedLevels.map(row=>row.id===selectedId?{...row,...levelData}:{...row,status:0,isDel:1});
          await tx.update(user).set({
            level: input.levelId,
            exp: level.expNum.toFixed(2),
            levelStatus: 1,
          }).where(eq(user.uid, account.uid));
        }
        options.expected?.({accounts:[{uid:account.uid,values:account.level===input.levelId?{level:account.level,exp:account.exp,levelStatus:account.levelStatus}:{level:input.levelId,exp:level.expNum.toFixed(2),levelStatus:1}}],levels:[{uid:account.uid,rows:expectedLevels}]});
        await audit({ operation: "level_replace", uids: input.uids, now, evidence: { userId: input.uids.length === 1 ? input.uids[0] : 0, targetCount: input.uids.length } });
        return { changed: account.level === input.levelId ? 0 : 1, idempotent: account.level === input.levelId };
      }
      if (input.type === 4) {
        const groupQuery = tx.select({ id: userGroup.id }).from(userGroup)
          .where(eq(userGroup.id, input.groupId)).limit(1);
        const group = await (options.catalogLocked ? groupQuery : groupQuery.for("share"));
        if (!group[0]) throw new NotFoundException("用户分组不存在");
        const changedUids = options.semanticNoop ? accounts.filter(u => u.groupId !== input.groupId).map(u => u.uid) : input.uids;
        if (changedUids.length) await tx.update(user).set({ groupId: input.groupId }).where(inArray(user.uid, changedUids));
        options.expected?.({accounts:input.uids.map(uid=>({uid,values:{groupId:input.groupId}}))});
        await audit({ operation: "group_replace", uids: input.uids, now, evidence: { userId: input.uids.length === 1 ? input.uids[0] : 0, targetCount: input.uids.length } });
        return { changed: changedUids.length };
      }

      if (input.labelIds.length) {
        const labelsQuery = tx.select({ id: userLabel.id }).from(userLabel).where(and(
          inArray(userLabel.id, input.labelIds),
          eq(userLabel.type, PLATFORM_TYPE),
          eq(userLabel.relationId, PLATFORM_RELATION_ID),
          eq(userLabel.status, 1),
        )).orderBy(asc(userLabel.id));
        const labels = await (options.catalogLocked ? labelsQuery : labelsQuery.for("share"));
        if (labels.length !== input.labelIds.length) throw new NotFoundException("部分用户标签不存在或已停用");
      }
      const priorLabels = options.semanticNoop ? await tx.select().from(userLabelRelation).where(and(inArray(userLabelRelation.uid,input.uids),eq(userLabelRelation.type,PLATFORM_TYPE),eq(userLabelRelation.relationId,PLATFORM_RELATION_ID))).orderBy(asc(userLabelRelation.id)) : [];
      const changedUids = options.semanticNoop ? input.uids.filter(uid => { const ids=priorLabels.filter(r=>r.uid===uid).map(r=>r.labelId).sort((a,b)=>a-b);return ids.join(",")!==input.labelIds.join(","); }) : input.uids;
      if (changedUids.length) await tx.delete(userLabelRelation).where(and(
        inArray(userLabelRelation.uid, changedUids),
        eq(userLabelRelation.type, PLATFORM_TYPE),
        eq(userLabelRelation.relationId, PLATFORM_RELATION_ID),
      ));
      if (input.labelIds.length && changedUids.length) {
        await tx.insert(userLabelRelation).values(changedUids.flatMap((uid) => input.labelIds.map((labelId) => ({
          uid,
          type: PLATFORM_TYPE,
          relationId: PLATFORM_RELATION_ID,
          labelId,
        }))));
      }
      options.expected?.({accounts:input.uids.map(uid=>({uid,values:{}}))});
      await audit({ operation: "label_replace", uids: input.uids, now, evidence: { userId: input.uids.length === 1 ? input.uids[0] : 0, targetCount: input.uids.length } });
      return { changed: changedUids.length, labels: input.labelIds.length };
}
export async function applyMobileUserFinance(tx:DbClient,input:AdminUserFinanceInput,linkId:string,audit:MobileUserCoreAudit,options:MobileUserCoreOptions={}) {
      const account = (await lockedUsers(tx, [input.uid]))[0];
      const now = Math.floor(Date.now() / 1_000);
      await options.assertBeforeMutation?.(tx);
      if (input.kind === "money") {
        const current = centsFromStored(account.nowMoney);
        const applied = input.status === 1 ? input.moneyCents : Math.min(input.moneyCents, current);
        const next = input.status === 1 ? current + applied : current - applied;
        if (!Number.isSafeInteger(next) || next < 0 || next > MAX_MONEY_CENTS) {
          throw new ValidateException("余额变更后超出数据库范围");
        }
        let ledgerId = 0;
        if (applied > 0) {
          await tx.update(user).set({ nowMoney: formatMoney(next) }).where(eq(user.uid, input.uid));
          const ledgers = await tx.insert(userMoney).values({
            uid: input.uid,
            linkId,
            type: input.status === 1 ? "system_add" : "system_sub",
            title: input.status === 1 ? "系统增加余额" : "系统减少余额",
            number: formatMoney(applied),
            balance: formatMoney(next),
            pm: input.status === 1 ? 1 : 0,
            mark: `${input.status === 1 ? "系统增加" : "系统减少"}${formatMoney(applied)}余额`,
            status: 1,
            addTime: now,
          }).returning({ id: userMoney.id });
          ledgerId = ledgers[0]?.id ?? 0;
        }
        if(applied>0&&!ledgerId)throw Error("Money journal did not persist");
        options.expected?.({accounts:[{uid:input.uid,values:{nowMoney:formatMoney(next)}}],records:ledgerId?[{kind:"money",id:ledgerId,values:{uid:input.uid,linkId,number:formatMoney(applied),balance:formatMoney(next),pm:input.status===1?1:0,status:1}}]:[]});
        await audit({operation: "finance",uids:[input.uid],now,evidence:{
          userId: input.uid,
          targetCount: 1,
          moneyLedgerId: ledgerId,
        }});
        return {
          uid: input.uid,
          kind: input.kind,
          applied: `${input.status === 1 ? "" : "-"}${formatMoney(applied)}`,
          balance: formatMoney(next),
          ledger_id: ledgerId,
          idempotent: false,
        };
      }

      if (!Number.isSafeInteger(account.integral) || account.integral < 0) {
        throw new ValidateException("用户当前积分异常，请先修复账户数据");
      }
      const applied = input.status === 1 ? input.integral : Math.min(input.integral, account.integral);
      const next = input.status === 1 ? account.integral + applied : account.integral - applied;
      if (!Number.isSafeInteger(next) || next < 0 || next > MAX_INTEGER) {
        throw new ValidateException("积分变更后超出数据库范围");
      }
      let ledgerId = 0;
      if (applied > 0) {
        await tx.update(user).set({ integral: next }).where(eq(user.uid, input.uid));
        const ledgers = await tx.insert(userBill).values({
          uid: input.uid,
          linkId,
          pm: input.status === 1 ? 1 : 0,
          title: input.status === 1 ? "系统增加积分" : "系统减少积分",
          category: "integral",
          type: input.status === 1 ? "system_add" : "system_sub",
          eventKey: options.authorityRealm === 'customer' ? (input.status === 1 ? 'customer_work_add_integral' : 'customer_work_sub_integral') : (input.status === 1 ? "admin_system_add_integral" : "admin_system_sub_integral"),
          number: applied.toFixed(2),
          balance: next.toFixed(2),
          mark: `${input.status === 1 ? "系统增加" : "系统减少"}${applied}积分`,
          addTime: now,
          status: 1,
        }).returning({ id: userBill.id });
        ledgerId = ledgers[0]?.id ?? 0;
      }
      if(applied>0&&!ledgerId)throw Error("Integral journal did not persist");
      options.expected?.({accounts:[{uid:input.uid,values:{integral:next}}],records:ledgerId?[{kind:"integral",id:ledgerId,values:{uid:input.uid,linkId,number:applied.toFixed(2),balance:next.toFixed(2),pm:input.status===1?1:0,category:"integral",status:1,eventKey:options.authorityRealm==="customer"?(input.status===1?"customer_work_add_integral":"customer_work_sub_integral"):(input.status===1?"admin_system_add_integral":"admin_system_sub_integral")}}]:[]});
      await audit({operation: "finance",uids:[input.uid],now,evidence:{
        userId: input.uid,
        targetCount: 1,
        integralLedgerId: ledgerId,
      }});
      return {
        uid: input.uid,
        kind: input.kind,
        applied: input.status === 1 ? applied : -applied,
        balance: next,
        ledger_id: ledgerId,
        idempotent: false,
      };
}
export async function applyMobileUserMembership(tx:DbClient,input:Extract<AdminUserBatchInput,{type:2}>,orderId:string,audit:MobileUserCoreAudit,options:MobileUserCoreOptions={}) {
      const account = (await lockedUsers(tx, input.uids))[0];
      if (account.isEverLevel === 1) throw new ValidateException("永久会员无需调整会员时长");
      const now = Math.floor(Date.now() / 1_000);
      await options.assertBeforeMutation?.(tx);
      const seconds = input.days * 86_400;
      if (!Number.isSafeInteger(seconds)) throw new ValidateException("会员天数超出支持范围");
      const base = Math.max(now, account.overdueTime);
      const overdueTime = input.daysStatus === 1 ? base + seconds : Math.max(now, base - seconds);
      if (!Number.isSafeInteger(overdueTime) || overdueTime > MAX_INTEGER) {
        throw new ValidateException("会员有效期超出支持范围");
      }
      const isMoneyLevel = overdueTime <= now ? 0 : account.isMoneyLevel > 0 ? account.isMoneyLevel : 3;
      await tx.update(user).set({ isMoneyLevel, isEverLevel: 0, overdueTime })
        .where(eq(user.uid, account.uid));
      const orders = await tx.insert(otherOrder).values({
        uid: account.uid,
        type: 4,
        orderId: orderId,
        memberType: "0",
        // Mature free system-adjustment channel. Customer admission supplies
        // its own actor receipt; this string grants no Admin authentication.
        payType: "admin",
        paid: 1,
        payTime: now,
        isFree: 1,
        overdueTime,
        vipDay: input.daysStatus === 1 ? input.days : -input.days,
        addTime: now,
        remarks: options.authorityLabel ?? "管理员调整付费会员时长",
      }).returning({ id: otherOrder.id });
      if (!orders[0]) throw new Error("会员调整记录创建失败");
      const statuses=await tx.insert(otherOrderStatus).values({
        oid: orders[0].id,
        changeType: options.authorityRealm === 'customer' ? 'customer_work_adjust' : "admin_adjust",
        changeMessage: options.authorityLabel ?? "管理员调整付费会员时长",
        shopType: 1,
        changeTime: now,
      }).returning();
      if(statuses.length!==1)throw Error("Membership status did not persist");
      // The actual status table has no primary key. This newly-created order's
      // real PK is its binding; the customer readback requires exactly one row.
      options.expected?.({accounts:[{uid:account.uid,values:{isMoneyLevel,isEverLevel:0,overdueTime}}],records:[{kind:"membership",id:orders[0].id,values:{uid:account.uid,type:4,orderId,overdueTime,vipDay:input.daysStatus===1?input.days:-input.days,paid:1,isFree:1,payType:"admin"}},{kind:"membership_status",oid:orders[0].id,values:{oid:orders[0].id,changeType:options.authorityRealm==="customer"?"customer_work_adjust":"admin_adjust",changeMessage:options.authorityLabel??"管理员调整付费会员时长",shopType:1,changeTime:now}}]});
      await audit({operation:"membership",uids:input.uids,now,evidence:{
        userId: account.uid,
        targetCount: 1,
        otherOrderId: orders[0].id,
      }});
      return {
        changed: Number(account.overdueTime !== overdueTime || account.isMoneyLevel !== isMoneyLevel || account.isEverLevel !== 0),
        other_order_id: orders[0].id,
        uid: account.uid,
        overdue_time: overdueTime,
        order_id: orderId,
        idempotent: false,
      };
}
export async function applyMobileUserCoupons(tx:DbClient,input:Extract<AdminUserBatchInput,{type:3}>,audit:MobileUserCoreAudit,options:MobileUserCoreOptions={}) {
      await lockedUsers(tx, input.uids);
      const issue = (await tx.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, input.couponId))
        .limit(1).for("update"))[0];
      if (!issue || issue.isDel !== 0 || issue.status !== 1 || issue.receiveType !== 3) {
        throw new NotFoundException("可赠送优惠券不存在或已停用");
      }
      const now = new Date();
      await options.assertBeforeMutation?.(tx);
      if (issue.startTime && issue.startTime > now) throw new ValidateException("优惠券尚未开始发放");
      if (issue.endTime && issue.endTime < now) throw new ValidateException("优惠券发放已结束");
      if (issue.day <= 0 && (!issue.useEndTime || issue.useEndTime < now)) {
        throw new ValidateException("优惠券使用有效期已结束或未配置");
      }
      if (!issue.isPermanent && issue.remainCount < input.uids.length) {
        throw new ValidateException("优惠券库存不足，整批未发放");
      }
      const title = issue.couponTitle || issue.title;
      if (!title || [...title].length > 64) throw new ValidateException("优惠券标题为空或过长，无法发放");
      const receiveTime = Math.floor(now.getTime() / 1_000);
      const startTime = issue.day > 0 ? now : issue.useStartTime ?? now;
      const endTime = issue.day > 0
        ? new Date(now.getTime() + issue.day * 86_400_000)
        : issue.useEndTime!;
      const beforeIssueUsers=options.expected?await tx.select().from(storeCouponIssueUser).where(and(eq(storeCouponIssueUser.issueCouponId,issue.id),inArray(storeCouponIssueUser.uid,input.uids),eq(storeCouponIssueUser.addTime,receiveTime))):[];
      const wallets=await tx.insert(storeCouponUser).values(input.uids.map((uid) => ({
        uid,
        issueCouponId: issue.id,
        couponTitle: title,
        couponPrice: issue.couponPrice,
        useMinPrice: issue.useMinPrice,
        status: 0,
        startTime,
        endTime,
        type: issue.type,
        receiveTime,
        receiveSource: "send",
        isFail: 0,
      }))).returning({id:storeCouponUser.id,uid:storeCouponUser.uid});
      if(wallets.length!==input.uids.length||wallets.map(w=>w.uid).sort((a,b)=>a-b).join(",")!==input.uids.join(","))throw Error("Coupon wallets did not persist exact targets");
      await tx.insert(storeCouponIssueUser).values(input.uids.map((uid) => ({
        uid,
        issueCouponId: issue.id,
        addTime: receiveTime,
      })));
      if (!issue.isPermanent) {
        const updated = await tx.update(storeCouponIssue)
          .set({ remainCount: sql`${storeCouponIssue.remainCount} - ${input.uids.length}` })
          .where(and(
            eq(storeCouponIssue.id, issue.id),
            sql`${storeCouponIssue.remainCount} >= ${input.uids.length}`,
          )).returning({ id: storeCouponIssue.id });
        if (!updated[0]) throw new ValidateException("优惠券库存不足，整批未发放");
      }
      options.expected?.({accounts:input.uids.map(uid=>({uid,values:{}})),records:wallets.map(w=>({kind:"wallet",id:w.id,values:{uid:w.uid,issueCouponId:issue.id,couponTitle:title,couponPrice:issue.couponPrice,useMinPrice:issue.useMinPrice,status:0,startTime,endTime,type:issue.type,receiveTime,receiveSource:"send",isFail:0}})),issue:{id:issue.id,remainCount:issue.isPermanent?issue.remainCount:issue.remainCount-input.uids.length},issueUsers:{issueId:issue.id,uids:input.uids,now:receiveTime,before:input.uids.map(uid=>beforeIssueUsers.filter(r=>r.uid===uid).length)}});
      await audit({operation:"coupon_grant",uids:input.uids,now:receiveTime,evidence:{
        userId: input.uids.length === 1 ? input.uids[0] : 0,
        targetCount: input.uids.length,
        couponIssueId: issue.id,
      }});
      return { changed: input.uids.length, coupon_id: issue.id, idempotent: false };
}
