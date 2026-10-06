import {and,desc,eq,isNull,sql} from 'drizzle-orm';
import type {Env} from '@/env';
import {withTx,type Container} from '@/lib/di';
import {storeProduct,systemConfig,user} from '@/models/schema';
import {publicOrdinaryProductIdentitySql} from './OrdinaryProductReadData';
import {integralDetailText,integralPublicH5Origin} from '@/services/activity/IntegralProductDetailData';
import {publicProductPictures,renderProductPictures} from '@/services/activity/ProductAssetPolicy';
import {themeDeadlines} from '@/services/content/ThemeReadService';
import {OfficialAccountQrcodeService} from '@/services/wechat/OfficialAccountQrcodeService';
import {WechatMiniProgramCodeService} from '@/services/wechat/WechatMiniProgramCodeService';
import {createQrSvgDataUrl} from '@/services/user/MembershipScanService';
import {AuthException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {createProductShareScene,verifyProductShareScene} from './ProductShareScene';

export type ProductShareCodeType='wechat'|'routine';
const validId=(value:number)=>Number.isSafeInteger(value)&&value>0&&value<=2147483647;
export class ProductShareCodeService {
  constructor(private readonly container:Container,private readonly env:Env,private readonly fetcher:typeof fetch=fetch){}
  private async snapshot(id:number,uid:number){
    if(!validId(id))throw new ValidateException('商品ID无效');
    if(!validId(uid))throw new AuthException();
    return withTx(this.container,async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
      const [account]=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,uid),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).limit(1);
      if(!account)throw new AuthException();
      const [product]=await tx.select({id:storeProduct.id,type:storeProduct.type,relationId:storeProduct.relationId,storeName:storeProduct.storeName,storeInfo:storeProduct.storeInfo,image:storeProduct.image}).from(storeProduct).where(and(eq(storeProduct.id,id),publicOrdinaryProductIdentitySql())).limit(1);
      if(!product)throw new NotFoundException('商品不存在或已下架');
      const rows=await tx.select({value:sql<string>`left(${systemConfig.value},201)`}).from(systemConfig).where(and(eq(systemConfig.isStore,0),eq(systemConfig.menuName,'share_qrcode'))).orderBy(desc(systemConfig.sort),desc(systemConfig.id)).limit(1001);
      if(rows.length>1000||(rows[0]?.value?.length??0)>200)throw new ValidateException('商品分享配置超过完整读取容量');
      // Match the ordinary detail's platform scope, winner order and scalar decoding.
      const raw=rows[0]?.value??'';let value=raw;try{const parsed:unknown=JSON.parse(raw);value=typeof parsed==='string'||typeof parsed==='number'?String(parsed):'';}catch{/* Legacy unencoded scalar. */}
      const official=value==='1';
      const [image]=await publicProductPictures(tx,[{image:product.image,type:product.type,relationId:product.relationId}]);
      return {product,image,official};
    });
  }
  private url(id:number,uid:number){
    const origin=integralPublicH5Origin(this.env.PUBLIC_H5_ORIGIN);
    if(!origin)throw new ValidateException('商品分享站点未配置');
    const url=new URL('/',origin),query=new URLSearchParams({id:String(id),spid:String(uid)});url.hash='/pages/goods/detail?'+query.toString();return url.href;
  }
  async code(id:number,uid:number,type:ProductShareCodeType,isWechat=false):Promise<{code:string}>{
    if(type!=='wechat'&&type!=='routine')throw new ValidateException('商品分享类型无效');
    const snapshot=await this.snapshot(id,uid);
    if(type==='routine'){
      try{const code=await new WechatMiniProgramCodeService(this.container,this.env,this.fetcher).createOrdinaryProductDataUrl(id,uid);if(!code)throw new Error('not_configured');return {code};}
      catch{throw new ServiceUnavailableException('商品小程序分享码暂不可用，请稍后重试');}
    }
    if(snapshot.official&&isWechat){
      // Validate the destination now; provider and images run after RR closes.
      this.url(id,uid);
      const scene=await createProductShareScene(id,uid,this.env.APP_KEY);
      try{return {code:await new OfficialAccountQrcodeService(this.container,this.env,this.fetcher).requestTemporaryProduct(scene)};}
      catch{throw new ServiceUnavailableException('商品公众号分享码暂不可用，请稍后重试');}
    }
    return {code:createQrSvgDataUrl(this.url(id,uid))};
  }
  /** Called only by the authenticated, normalized official subscribe/scan
   * callback. A signed scene works without broadening App qrcode privileges. */
  async news(eventKey:string):Promise<Record<string,unknown>|null>{
    const scene=eventKey.startsWith('qrscene_')?eventKey.slice(8):eventKey;
    const verified=await verifyProductShareScene(scene,this.env.APP_KEY);if(!verified)return null;
    let snapshot:Awaited<ReturnType<ProductShareCodeService['snapshot']>>;
    try{snapshot=await this.snapshot(verified.id,verified.uid);}catch(error){if(error instanceof AuthException||error instanceof NotFoundException)return null;throw error;}
    const url=this.url(verified.id,verified.uid),[reference]=await renderProductPictures(this.env.APP_KEY,[snapshot.image]);
    let image='';if(reference){try{const parsed=new URL(reference,integralPublicH5Origin(this.env.PUBLIC_H5_ORIGIN));if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)image=parsed.href;}catch{/* An unavailable image cannot become a foreign URL. */}}
    return {type:'news',title:integralDetailText(snapshot.product.storeName,128),description:integralDetailText(snapshot.product.storeInfo,256),image,url};
  }
}
