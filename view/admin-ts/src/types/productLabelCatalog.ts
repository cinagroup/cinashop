export interface ProductLabelItem {id:number;type:number;relation_id:number;label_cate:number;label_name:string;style_type:number;
  color:string;bg_color:string;border_color:string;icon:string;icon_preview:string;is_show:number;status:number;sort:number;add_time:string}
export interface ProductLabelCategory {id:number;name:string;sort:number;group:number;type:number;relation_id:number;product_label:ProductLabelItem[]}
export interface ProductLabelForm {label_cate:number;label_name:string;style_type:number;color:string;bg_color:string;border_color:string;
  icon:string;is_show:number;status:number;sort:number}
export type ProductLabelAction = {kind:'category-save';id:number;body:{name:string;sort:number}}
  |{kind:'category-delete';id:number}|{kind:'label-save';id:number;body:ProductLabelForm}|{kind:'label-delete';id:number}
  |{kind:'label-flag';id:number;field:'status'|'is_show';value:number}|{kind:'label-batch';ids:number[]};
