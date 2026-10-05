import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {ProductShareCodeService,type ProductShareCodeType} from '@/services/product/ProductShareCodeService';
import {categoryPublicId} from '@/services/product/PublicCategoryPolicy';
import {ValidateException} from '@/utils/errors';
import {jsonOk} from '@/utils/json';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
export async function code(c:C){
  const query=new URL(c.req.url).searchParams;
  for(const key of query.keys())if(key!=='user_type'||query.getAll(key).length!==1)throw new ValidateException('商品分享查询参数无效');
  const type=query.get('user_type')??'wechat';if(type!=='wechat'&&type!=='routine')throw new ValidateException('商品分享类型无效');
  c.header('Cache-Control','private, no-store');
  return jsonOk(c,await new ProductShareCodeService(c.get('container'),c.env).code(categoryPublicId(c.req.param('id')),c.get('uid')??0,type as ProductShareCodeType,/micromessenger/i.test(c.req.header('User-Agent')??'')));
}
