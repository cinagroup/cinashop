export type CustomerWorkProductKind='set_show'|'replace_categories'|'replace_labels'|'update_skus';
export interface CustomerWorkProductEnvelope<T>{version:'customer-work-product-read-v1';actor_uid:number;principal:{kind:'customer-order-manager';service_id:number;scope:'global'};scope_key:string;consistency_key:string;data:T}
export interface CustomerWorkProductMeta{scopes:{products:'global';taxonomy:'platform';inventory:'active_base_skus'};catalog_revision:string;readiness:{writes:boolean;reason:string}}
export interface CustomerWorkProductSku{id:number;product_id:number;unique:string;suk:string;price:string;cost:string;ot_price:string;stock:number;sum_stock:number;sales:number;bar_code:string;image:string;stock_editable:boolean}
export interface CustomerWorkProduct{id:number;type:0|1|2;relation_id:number;pid:number;product_type:0|1|2|3|4;store_name:string;image:string;plate_name:string;spec_type:0|1;price:string;cost:string;ot_price:string;stock:number;branch_stock:number;sales:number;branch_sales:number;is_show:0|1;is_verify:-2|-1|0|1;is_police:0|1;is_sold:0|1;cate_id:number[];cate_name:string;store_label_id:number[];sku_count:number;attr_value:CustomerWorkProductSku|null;product_revision:string;actions:{show:boolean;hide:boolean;categories:boolean;labels:boolean;skus:boolean};sku_policy:string}
export interface CustomerWorkProductList extends CustomerWorkProductMeta{list:CustomerWorkProduct[];count:number;page:number;limit:number;has_more:boolean}
export interface CustomerWorkProductCategory{id:number;pid:number;cate_name:string;pic:string;big_pic:string;children:CustomerWorkProductCategory[]}
export interface CustomerWorkProductLabel{id:number;label_name:string;color:string;bg_color:string;border_color:string;icon:string}
export interface CustomerWorkProductLabelGroup{id:number;label_name:string;children:CustomerWorkProductLabel[]}
export interface CustomerWorkProductCategories extends CustomerWorkProductMeta{categories:CustomerWorkProductCategory[]}
export interface CustomerWorkProductLabels extends CustomerWorkProductMeta{labels:CustomerWorkProductLabelGroup[]}
export interface CustomerWorkProductSkus extends CustomerWorkProductMeta{product:CustomerWorkProduct;skus:CustomerWorkProductSku[]}
export interface CustomerWorkProductSkuUpdate{unique:string;price:string;cost:string;ot_price:string;stock:number}
export interface CustomerWorkProductBody{version:'customer-work-product-operation-v1';scope_key:string;targets:{product_id:number;expected_product_revision:string}[];expected_catalog_revision:string;payload:Record<string,unknown>}
export interface CustomerWorkProductIntent{version:'customer-work-product-pending-v1';actor_uid:number;service_id:number;scope_key:string;kind:CustomerWorkProductKind;request_key:string;request_hash:string;body:CustomerWorkProductBody;endpoint:string;method:'POST';created_at:number}
export interface CustomerWorkProductReceipt{version:'customer-work-product-operation-v1';actor_uid:number;service_id:number;request_key:string;request_hash:string;kind:CustomerWorkProductKind;product_ids:number[];outcome:'products-updated'|'skus-updated'|'rollback-rejected'|'abandoned';evidence:{changed:number;verified:true}|{code:string}|Record<string,never>}
export interface CustomerWorkProductOperationState{receipt:CustomerWorkProductReceipt|null;unknown:boolean;error:string}
