import request,{getData} from '@/utils/request';
import type {ProductLabelItem,ProductLabelCategory,ProductLabelAction} from '../types/productLabelCatalog';
export type {ProductLabelItem,ProductLabelCategory,ProductLabelForm,ProductLabelAction} from '../types/productLabelCatalog';
export const labelCategories=(name='',page=1)=>getData<{list:ProductLabelCategory[];count:number}>(request.get('/product/label_cate',{params:{name,page,limit:100}}));
export const labelPage=(category:number,page:number)=>getData<{list:ProductLabelItem[];count:number}>(request.get('/product/label',{params:{label_cate:category,page,limit:20}}));
export const labelGroupOptions=()=>getData<{rules:Array<{field:string;options?:Array<{value:number;label:string}>}>}>(request.get('/product/label/form'));
export async function mutateProductLabel(action:ProductLabelAction):Promise<unknown>{
  switch(action.kind){
    case 'category-save':return getData(action.id?request.put(`/product/label_cate/${action.id}`,action.body):request.post('/product/label_cate',action.body));
    case 'category-delete':return getData(request.delete(`/product/label_cate/${action.id}`));
    case 'label-save':return getData(request.post(`/product/label/${action.id}`,action.body));
    case 'label-delete':return getData(request.delete(`/product/label/${action.id}`));
    case 'label-flag':return getData(request.put(`/product/label/${action.field==='status'?'set_status':'set_show'}/${action.id}/${action.value}`));
    case 'label-batch':return getData(request.put('/product/label/dels',{ids:action.ids,all:0,where:''}));
  }
}
export async function labelProof(action:ProductLabelAction):Promise<boolean>{
  if(action.kind==='category-save'||action.kind==='category-delete'){
    const result=await labelCategories(action.kind==='category-save'?action.body.name:'');
    if(action.kind==='category-delete')return result.count<=100&&!result.list.some(row=>row.id===action.id);
    if(action.kind==='category-save')return result.list.some(row=>(action.id===0||row.id===action.id)&&row.name===action.body.name&&row.sort===action.body.sort);
    return false;
  }
  const rows=await getData<Array<Record<string,unknown>>>(request.get('/product_label/list'));
  if(!Array.isArray(rows)||rows.length>2000)throw Error('标签核对资料不完整');
  if(action.kind==='label-delete')return !rows.some(row=>row.id===action.id);
  if(action.kind==='label-batch')return action.ids.filter(id=>id>5).every(id=>!rows.some(row=>row.id===id));
  const row=rows.find(row=>action.kind==='label-save'?(action.id?row.id===action.id:row.labelCate===action.body.label_cate&&row.labelName===action.body.label_name):row.id===action.id);
  if(!row)return false;
  if(action.kind==='label-flag')return row[action.field==='is_show'?'isShow':'status']===action.value;
  if(action.kind==='label-save'){
    const map={label_cate:'labelCate',label_name:'labelName',style_type:'styleType',color:'color',bg_color:'bgColor',border_color:'borderColor',icon:'icon',is_show:'isShow',status:'status',sort:'sort'};
    return Object.entries(action.body).every(([key,value])=>row[map[key as keyof typeof map]]===value);
  }
  return false;
}
