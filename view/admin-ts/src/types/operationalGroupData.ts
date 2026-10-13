export type OperationalGroupName='routine_home_bast_banner'|'combination_banner'|'routine_home_hot_banner'|'routine_home_new_banner'|'routine_home_benefit_banner'|'integral_shop_banner';
export type OperationalOperation='create'|'update'|'status'|'delete'|'replace';
export interface OperationalField {name:string;title:'img'|'comment'|'link';type:'upload'|'input';param:string}
export interface OperationalValues {img:string;comment:string;link:string;sort:number;status:0|1}
export interface OperationalRow {id:number;gid:number;img:string[];img_preview:string;comment:string;link:string;sort:number;status:number;add_time:number;editable:boolean;issues:string[];revision:string}
export interface OperationalList {list:OperationalRow[];count:number;gid:number;config_name:OperationalGroupName;fields:OperationalField[];revision:string;page:number;limit:number;type:'img'}
export interface OperationalOption {gid:number|null;config_name:OperationalGroupName;name:string;available:boolean;issue:string}
export interface OperationalForm {title:string;gid:number;config_name:OperationalGroupName;revision:string;img_preview:string;rules:Array<{field:string;value:unknown}>}
export interface OperationalAction {operation:OperationalOperation;id:number;input:{gid?:number;config_name:OperationalGroupName;expected_revision:string;request_id:string;img?:string;comment?:string;link?:string;sort?:number;status?:0|1;data?:OperationalValues[]};payload_hash?:string}
export interface OperationalReceipt {operation:OperationalOperation;config_name:OperationalGroupName;id:number;ids:number[];count:number;request_id:string|null;payload_hash:string;revision:string;verified:true}
