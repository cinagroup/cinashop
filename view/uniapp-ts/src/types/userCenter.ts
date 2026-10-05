import type { PublicUserCenterDesignValue } from '../../../common/userCenterDesign';
import type { WriteoffOperatorProfile } from '@/api/order';

export interface UserCenterProfile {
  uid:number;nickname:string;phone:string;avatar:string;now_money:string;integral:number;
  couponCount:number;collectProductCount:number;collectVideoCount:number;visit_num:number;
  level_name:string;vip_discount:string|number;is_promoter:boolean|0|1;pay_vip_status:boolean|0|1;service_num:number;
  commissionCount:string;brokerage_price:string;spread_user_count:number;spread_order_count:number;
}
export interface UserCenterCapabilities {balance:boolean;member:boolean;paid_member:boolean;promotion:boolean;video:boolean;merchant:boolean;writeoff:boolean;deliveryWorkBench:boolean;invoice:boolean;promoter_application:boolean;agent_application:boolean;agent_records:boolean;kefu?:boolean;work?:boolean}
export interface UserCenterCounts {order_count:number;unpaid_count:number;unshipped_count:number;received_count:number;evaluated_count:number;refund_count:number}
export interface UserCenterMenu {
  actor_uid:number;consistency_key:string;diy_data:PublicUserCenterDesignValue;
  user_center_design_state:{revision:string;configured:boolean;issues:string[]};
  profile:UserCenterProfile|null;capabilities:UserCenterCapabilities;orderStatusNum:UserCenterCounts;
  operator_profile:WriteoffOperatorProfile|null;routine_contact_type:number;
  kefu_workbench_url?:string;
}
export interface UserCenterPendingOrder {id:number;order_id:string;pay_price:string;img:string;store_name:string;stop_time:number}
export interface UserCenterStats {
  actor_uid:number;consistency_key:string;design_revision:string;
  commission:{brokerage_price:string;number:number;order_num:number}|[];
  order:{user_order:false}|{user_order:true;price:string;num:number;consignment:number};
  not_pay_order:UserCenterPendingOrder|null|[];
}
export interface UserCenterSnapshot {menu:UserCenterMenu;stats:UserCenterStats}
export interface CollectionProduct {id:number;store_name:string;image:string;price:string;is_show?:number;is_fail?:boolean|0|1;available?:boolean;[key:string]:unknown}
export interface CollectionVideo {id:number;video_id:number;image:string;site_name:string;wap_login_logo:string;desc:string;video_url:string;like_num:number;available:boolean;is_fail:0|1}
export type CollectionKind='product'|'video';
export interface CollectionPage<T> {list:T[];count:number}
