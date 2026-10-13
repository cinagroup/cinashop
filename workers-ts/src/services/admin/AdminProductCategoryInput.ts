import {ValidateException} from '@/utils/errors';
import {classifyProductMediaReference} from '../../../../view/common/productMediaReference';
export interface ProductCategoryInput {pid:number[];cateName:string;pic:string;bigPic:string;sort:number;isShow:number;expectedRevision?:string}
export function categoryId(value:unknown,zero=false):number{
  if((typeof value!=='number'&&typeof value!=='string')||!/^(?:0|[1-9]\d{0,9})$/.test(String(value)))throw new ValidateException('分类ID错误');
  const id=Number(value);if(id>2147483647||!zero&&id===0)throw new ValidateException('分类ID错误');return id;
}
export function categoryFlag(value:unknown):number{if(value===0||value==='0')return 0;if(value===1||value==='1')return 1;throw new ValidateException('分类状态只能为0或1');}
export function categoryObject(value:unknown,allowed:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidateException('分类提交格式错误');
  const row=value as Record<string,unknown>;if(Object.keys(row).some(key=>!allowed.includes(key)))throw new ValidateException('分类提交包含未知字段');return row;
}
export function categoryPicture(value:unknown,maximum=512):string{
  if(value===undefined||value==='')return '';
  const result=classifyProductMediaReference(value);if(result.kind==='invalid'||result.reference.length>maximum)throw new ValidateException('分类图片须为长期HTTPS、站内路径或授权素材引用');return result.reference;
}
export function parseProductCategoryInput(body:unknown):ProductCategoryInput{
  const row=categoryObject(body,['pid','cate_name','pic','big_pic','sort','is_show','expected_revision']);
  if(typeof row.cate_name!=='string'||/[\u0000-\u001f\u007f-\u009f]/u.test(row.cate_name))throw new ValidateException('分类名称格式错误');
  const cateName=row.cate_name.trim();if(!cateName||[...cateName].length>30)throw new ValidateException('分类名称必须为1至30个字符');
  const raw=row.pid??[];if(!Array.isArray(raw)||raw.length>2)throw new ValidateException('分类父级路径错误');
  const pid=raw.map(value=>categoryId(value,true));if(new Set(pid).size!==pid.length||pid.includes(0)&&pid.length!==1)throw new ValidateException('分类父级路径错误');
  const expectedRevision=row.expected_revision;if(expectedRevision!==undefined&&(typeof expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(expectedRevision)))throw new ValidateException('分类确认版本错误，请刷新');
  return {pid,cateName,pic:categoryPicture(row.pic),bigPic:categoryPicture(row.big_pic,255),sort:row.sort===undefined?0:categoryId(row.sort,true),isShow:row.is_show===undefined?0:categoryFlag(row.is_show),...(expectedRevision===undefined?{}:{expectedRevision:expectedRevision as string})};
}
export function parseProductCategoryQuery(query:URLSearchParams){
  for(const key of query.keys())if(!['pid','id','is_show','cate_name','page','limit'].includes(key)||query.getAll(key).length!==1)throw new ValidateException('分类查询参数未知或重复');
  const keyword=query.get('cate_name')??'';if(keyword.length>100||/[\u0000-\u001f\u007f-\u009f]/u.test(keyword))throw new ValidateException('分类搜索名称错误');
  const number=(key:string)=>query.has(key)&&query.get(key)!==''?categoryId(query.get(key),true):0;
  // The old first-party page sends page/limit, but this DAO list is unpaged.
  number('page');number('limit');return {pid:number('pid'),id:number('id'),show:query.has('is_show')&&query.get('is_show')!==''?categoryFlag(query.get('is_show')):undefined,keyword};
}
export const productCategoryCatalogType=(value:unknown)=>value===undefined?1:categoryId(value,true);