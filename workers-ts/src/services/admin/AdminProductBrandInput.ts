import {ValidateException} from '@/utils/errors';
export interface ProductBrandInput {fid:number[];brandName:string;sort:number;isShow:number}
export function brandId(value:unknown,zero=false):number{
  if((typeof value!=='number'&&typeof value!=='string')||!/^(?:0|[1-9]\d{0,9})$/.test(String(value)))throw new ValidateException('品牌ID错误');
  const id=Number(value);if(id>2147483647||!zero&&id===0)throw new ValidateException('品牌ID错误');return id;
}
export function brandFlag(value:unknown):number{if(value===0||value==='0')return 0;if(value===1||value==='1')return 1;throw new ValidateException('品牌显示状态只能为0或1');}
export function brandObject(value:unknown,allowed:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidateException('品牌提交格式错误');
  const row=value as Record<string,unknown>;if(Object.keys(row).some(key=>!allowed.includes(key)))throw new ValidateException('品牌提交包含未知字段');return row;
}
export function parseProductBrandInput(body:unknown):ProductBrandInput{
  const row=brandObject(body,['fid','brand_name','sort','is_show']);
  if(typeof row.brand_name!=='string'||/[\u0000-\u001f\u007f-\u009f]/u.test(row.brand_name))throw new ValidateException('品牌名称格式错误');
  const brandName=row.brand_name.trim();if(!brandName||[...brandName].length>10)throw new ValidateException('品牌名称必须为1至10个字符');
  const raw=row.fid??[];if(!Array.isArray(raw)||raw.length>3)throw new ValidateException('品牌父级路径错误');
  const fid=raw.map(value=>brandId(value,true));
  if(new Set(fid).size!==fid.length||fid.slice(1).includes(0))throw new ValidateException('品牌父级路径错误');
  return {fid,brandName,sort:row.sort===undefined?0:brandId(row.sort,true),isShow:row.is_show===undefined?0:brandFlag(row.is_show)};
}
export function parseProductBrandQuery(query:URLSearchParams){
  for(const key of query.keys())if(!['brand_name','pid'].includes(key)||query.getAll(key).length!==1)throw new ValidateException('品牌查询参数未知或重复');
  const keyword=query.get('brand_name')??'';if(keyword.length>64||/[\u0000-\u001f\u007f-\u009f]/u.test(keyword))throw new ValidateException('品牌搜索名称错误');
  return {pid:query.has('pid')&&query.get('pid')!==''?brandId(query.get('pid'),true):0,keyword:keyword.trim()};
}
export function productBrandCatalogType(value:unknown):1|2{if(value===undefined||value==='1'||value===1)return 1;if(value==='2'||value===2)return 2;throw new ValidateException('品牌目录类型只能为1或2');}
