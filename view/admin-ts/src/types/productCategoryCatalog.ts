export interface ProductCategoryItem {id:number;pid:number;type:number;relation_id:number;cate_name:string;path:string;level:number;depth:number;pic:string;big_pic:string;pic_preview:string;big_pic_preview:string;sort:number;is_show:number;add_time:string;revision:string;children?:ProductCategoryItem[];has_children?:boolean}
export interface ProductCategoryNode {value:number;label:string;pid?:number;children?:ProductCategoryNode[]}
export interface ProductCategoryForm {pid:number[];cate_name:string;pic:string;big_pic:string;sort:number;is_show:number;expected_revision?:string}
export interface ProductCategoryFormSnapshot {title:string;method:string;action:string;revision:string;pic_preview:string;big_pic_preview:string;rules:Array<{field:string;value?:unknown;props?:{data?:ProductCategoryNode[]}}>}
export type ProductCategoryAction={kind:'save';id:number;body:ProductCategoryForm}|{kind:'show';id:number;value:number;revision:string}|{kind:'delete';id:number;revision:string};
