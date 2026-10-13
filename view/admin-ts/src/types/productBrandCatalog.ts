export interface ProductBrandItem {id:number;brand_name:string;pid:number;fid:number[];store_id:number;sort:number;is_show:number;add_time:string;is_del:number;brand_num:number;type:number;fid_son?:number[];children?:ProductBrandItem[];loading?:boolean;_loading?:boolean;has_children?:boolean}
export interface ProductBrandNode {value:number;label:string;pid?:number;children?:ProductBrandNode[]}
export interface ProductBrandForm {fid:number[];brand_name:string;sort:number;is_show:number}
export type ProductBrandAction={kind:'save';id:number;body:ProductBrandForm}|{kind:'show';id:number;value:number}|{kind:'delete';id:number};
