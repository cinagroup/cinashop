import request,{getData} from '@/utils/request';
import {classifyProductMediaReference} from '../../../common/productMediaReference';
import type {ProductCategoryAction,ProductCategoryItem,ProductCategoryFormSnapshot} from '../types/productCategoryCatalog';
export type {ProductCategoryAction,ProductCategoryItem,ProductCategoryNode,ProductCategoryForm,ProductCategoryFormSnapshot} from '../types/productCategoryCatalog';
export async function categoryList(pid=0,cate_name='',is_show:number|''=''){
  const result=await getData<{list:ProductCategoryItem[];count:number;revision:string}>(request.get('/product/category',{params:{pid,cate_name,is_show}}));
  if(!Array.isArray(result?.list)||!Number.isSafeInteger(result.count)||result.count!==result.list.length||!/^[a-f0-9]{64}$/.test(result.revision))throw Error('分类列表资料不完整');return {...result,list:result.list.map(row=>({...row,has_children:Array.isArray(row.children)}))};
}
export const categoryForm=(id=0)=>getData<ProductCategoryFormSnapshot>(request.get(id?`/product/category/${id}`:'/product/category/create'));
export async function mutateProductCategory(action:ProductCategoryAction){
  if(action.kind==='save')return getData(action.id?request.put(`/product/category/${action.id}`,{...action.body,id:action.id}):request.post('/product/category',{...action.body,id:0}));
  if(action.kind==='show')return getData(request.put(`/product/category/set_show/${action.id}/${action.value}`,{expected_revision:action.revision}));
  return getData(request.delete(`/product/category/${action.id}`,{data:{expected_revision:action.revision}}));
}
export async function categoryProof(action:ProductCategoryAction){
  const rows=await getData<Array<{id:number;pid:number;type:number;relationId:number;cateName:string;path:string;level:number;pic:string;bigPic:string;sort:number;isShow:number}>>(request.get('/category/list'));
  if(!Array.isArray(rows)||rows.length>1000||rows.some(row=>row.type!==0||row.relationId!==0))throw Error('平台分类核对资料不完整');
  if(action.kind==='delete')return !rows.some(row=>row.id===action.id);
  if(action.kind==='show')return rows.some(row=>row.id===action.id&&row.isShow===action.value)&&rows.filter(row=>row.pid===action.id).every(row=>row.isShow===action.value);
  const path=action.body.pid.filter(id=>id>0),pid=path.at(-1)??0;const ref=(value:string)=>{if(value==='')return '';const classified=classifyProductMediaReference(value);return classified.kind==='invalid'?null:classified.reference;};
  return rows.some(row=>(!action.id||row.id===action.id)&&row.cateName===action.body.cate_name.trim()&&row.pid===pid&&row.path===path.join(',')&&row.level===path.length&&row.pic===ref(action.body.pic)&&row.bigPic===ref(action.body.big_pic)&&row.sort===action.body.sort&&row.isShow===action.body.is_show);
}
