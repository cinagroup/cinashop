import {createUserCenterRequests} from '@/api/userCenter';

export interface MemberCardActivationReceipt {order_id:string;overdue_time:number}
/** PHP distinguishes the request platform from the membership order channel. */
export function memberCardActivationChannel(userAgent=typeof navigator==='undefined'?'':navigator.userAgent):'h5'|'weixin'|'routine'{
  // #ifdef MP
  return 'routine';
  // #endif
  // #ifdef H5
  if(/micromessenger/iu.test(userAgent))return 'weixin';
  // #endif
  return 'h5';
}
export function decodeMemberCardActivation(value:unknown):MemberCardActivationReceipt{
  const v=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
  if(!v||typeof v.order_id!=='string'||!v.order_id||v.order_id.length>32||/[\u0000-\u0020\u007f]/u.test(v.order_id)
    ||!Number.isSafeInteger(v.overdue_time)||Number(v.overdue_time)<1)throw Error('激活回执无效，结果暂未确认');
  return{order_id:v.order_id,overdue_time:Number(v.overdue_time)};
}
export function createMemberCardActivationRequests(current:()=>boolean){
  const scope=createUserCenterRequests(current);
  return{...scope,
    async nickname(){
      const value=await scope.request<unknown>('user/info','GET',{profile:1},true);
      const v=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
      const p=v?.profile&&typeof v.profile==='object'&&!Array.isArray(v.profile)?v.profile as Record<string,unknown>:null;
      if(v?.actor_uid!==scope.owner.uid||p?.uid!==scope.owner.uid||typeof p.nickname!=='string'||p.nickname.length>255)throw Error('会员账户资料不一致');
      return p.nickname;
    },
    async redeem(code:string,password:string){
      if(!code||code.length>20||!password||password.length>12||/[\u0000-\u001f\u007f]/u.test(code+password))throw Error('会员卡号或卡密格式错误');
      return decodeMemberCardActivation(await scope.request('user/member/card/draw','POST',{
        member_card_code:code,member_card_pwd:password,from:memberCardActivationChannel(),
      },true));
    },
  };
}
export type MemberCardActivationRequests=ReturnType<typeof createMemberCardActivationRequests>;
