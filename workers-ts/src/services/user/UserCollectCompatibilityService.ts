import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { withTx,createContainerFromDb,type Container } from "@/lib/di";
import { themeDeadlines } from "@/services/content/ThemeReadService";
import { normalizeConfigScalar } from "@/utils/config";
import { publicProductPictures,renderProductPictures } from "@/services/activity/ProductAssetPolicy";
import { readDetailVideo } from "@/services/product/ProductDetailDesignData";
import { storeProduct, userRelation, video, user } from "@/models/schema";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { V2PromotionCompatibilityService } from "@/services/activity/V2PromotionCompatibilityService";
import { ValidateException } from "@/utils/errors";

type CollectCategory = "product" | "video";

function category(value: string): CollectCategory {
  if (value === "product" || value === "video") return value;
  throw new ValidateException("该收藏分类暂未迁移");
}

/** PHP-compatible collection list without hiding delisted/deleted products. */
export class UserCollectCompatibilityService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async list(uid: number, page: number, limit: number, value: string) {
    const selectedCategory = category(value);
    if(selectedCategory === "video")return this.videoCollection(uid,page,limit);
    const where = and(
      eq(userRelation.uid, uid),
      eq(userRelation.type, "collect"),
      eq(userRelation.category, selectedCategory),
    );
    const [relations, counts] = await Promise.all([
      this.container.db
        .select({ id: userRelation.relationId })
        .from(userRelation)
        .where(where)
        .orderBy(desc(userRelation.addTime), desc(userRelation.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userRelation)
        .where(where),
    ]);
    const ids = relations.map((row) => row.id);
    const list = await this.productList(uid, ids);
    // PHP counts relation rows even when a referenced object was physically
    // removed; its list similarly omits only a truly missing object.
    return { list, count: counts[0]?.count ?? 0 };
  }

  private async productList(uid: number, ids: number[]): Promise<Record<string, unknown>[]> {
    if (!ids.length) return [];
    const snapshot = await withTx(this.container,async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
      const[actor]=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,uid),eq(user.status,1),eq(user.isDel,0),sql`${user.deleteTime} IS NULL`)).limit(1);if(!actor)throw new ValidateException('请重新登录');
      const scoped=createContainerFromDb(tx),[rows,visible]=await Promise.all([
      tx
        .select({
          id: storeProduct.id,
          type:storeProduct.type,
          relationId:storeProduct.relationId,
          storeName: storeProduct.storeName,
          price: storeProduct.price,
          isPresaleProduct: storeProduct.isPresaleProduct,
          vipPrice: storeProduct.vipPrice,
          freight: storeProduct.freight,
          otPrice: storeProduct.otPrice,
          sales: storeProduct.sales,
          image: storeProduct.image,
          isDel: storeProduct.isDel,
          isShow: storeProduct.isShow,
          activity: storeProduct.activity,
        })
        .from(storeProduct)
        .where(inArray(storeProduct.id, ids)),
      new PublicCatalogService(scoped, this.env).recommend(uid, {
        ids,
        limit: ids.length,
      }),
      ]);
      const visibleIds=new Set(visible.map(item=>Number(item.id))),pictures=await publicProductPictures(tx,rows.map(row=>({image:visibleIds.has(row.id)&&row.isDel===0&&row.isShow===1?row.image:'',type:row.type,relationId:row.relationId})));
      return{rows,visible,pictures};
    });
    const{rows,visible}=snapshot,images=await renderProductPictures(this.env.APP_KEY,snapshot.pictures),imageById=new Map(rows.map((row,index)=>[row.id,images[index]]));
    const direct = new Map(rows.map((row) => [row.id, row]));
    const decorated = new Map(visible.map((item) => {
      const record = item as Record<string, unknown>;
      return [Number(record.id), record] as const;
    }));
    const list = ids.flatMap((id) => {
      const row = direct.get(id);
      if (!row) return [];
      const rich = decorated.get(id) ?? {};
      const priceType = typeof rich.price_type === "string" ? rich.price_type : "";
      const effectiveMemberPrice = rich.vip_price ?? "0";
      return [{
        ...rich,
        id: row.id,
        product_id: id,
        store_name: row.storeName,
        price_type: priceType,
        price: row.price,
        is_presale_product: row.isPresaleProduct,
        vip_price: priceType === "member" ? effectiveMemberPrice : "0",
        level_name: rich.level_name ?? "",
        // PHP exposes the same getMinPrice value under different keys based
        // on whether the winning price is paid-membership or user-level.
        level_price: priceType === "member" ? "0" : effectiveMemberPrice,
        freight: row.freight,
        ot_price: row.otPrice,
        sales: row.sales,
        image: imageById.get(id)??'',
        is_del: row.isDel,
        is_show: row.isShow,
        // Correct the PHP `is_del && is_show` typo: either unavailable state
        // should be visible to the client so the relation can be removed.
        is_fail: row.isDel !== 0 || row.isShow === 0 || !decorated.has(id) ? 1 : 0,
        activity: row.activity,
        promotions: rich.promotions && typeof rich.promotions === "object"
          ? rich.promotions
          : {},
        activity_frame: [],
        activity_background: [],
      }];
    });
    return new V2PromotionCompatibilityService(this.container, this.env)
      .decorateCatalogProducts(list);
  }

  private async videoCollection(uid:number,page:number,limit:number){
    if(!Number.isSafeInteger(uid)||uid<=0||uid>2147483647||!Number.isSafeInteger(page)||page<=0||!Number.isSafeInteger(limit)||limit<=0||limit>100)throw new ValidateException('视频收藏查询无效');
    const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
      const [actor]=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,uid),eq(user.status,1),eq(user.isDel,0),sql`${user.deleteTime} IS NULL`)).limit(1);if(!actor)throw new ValidateException('请重新登录');
      const settings=await createContainerFromDb(tx).systemConfigDao.getValuesWithPresence(['video_func_status','site_name','wap_login_logo']),setting=settings.video_func_status,flag=normalizeConfigScalar(setting.value),enabled=!setting.exists||flag==='1'||flag==='true';
      const rawSite=normalizeConfigScalar(settings.site_name.value),siteName=typeof rawSite==='string'&&!/[\u0000-\u001f\u007f]/u.test(rawSite)?rawSite.slice(0,200):'';
      const[logo]=await publicProductPictures(tx,[{image:normalizeConfigScalar(settings.wap_login_logo.value),type:0,relationId:0}]);
      const where=and(eq(userRelation.uid,uid),eq(userRelation.type,'collect'),eq(userRelation.category,'video'));
      const relations=await tx.select({id:userRelation.relationId}).from(userRelation).where(where).orderBy(desc(userRelation.addTime),desc(userRelation.id)).limit(limit).offset((page-1)*limit),[count]=await tx.select({count:sql<number>`count(*)::int`}).from(userRelation).where(where),ids=relations.map(row=>row.id);
      const rows=ids.length?await tx.select().from(video).where(inArray(video.id,ids)):[],byId=new Map(rows.map(row=>[row.id,row]));
      const pictures=await publicProductPictures(tx,rows.map(row=>({image:row.image,type:row.type,relationId:row.relationId}))),videos=await Promise.all(rows.map(row=>enabled&&row.isShow===1&&row.isVerify===1&&row.isDel===0?readDetailVideo(tx,{type:row.type,relationId:row.relationId,videoOpen:1,videoLink:row.videoUrl}):Promise.resolve('')));
      return{actor_uid:uid,count:Number(count?.count??0),ids,rows,byId,pictures,videos,enabled,siteName,logo};});
    const signed=await renderProductPictures(this.env.APP_KEY,[...result.pictures,...result.videos,result.logo]),indexes=new Map(result.rows.map((row,index)=>[row.id,index]));
    return{actor_uid:uid,count:result.count,list:result.ids.map(id=>{const row=result.byId.get(id),index=indexes.get(id),available=!!row&&result.enabled&&row.isShow===1&&row.isVerify===1&&row.isDel===0&&!!result.videos[index!];
      return{id,video_id: id,available,is_fail:available?0:1,image:available?signed[index!]:'',desc:available?row!.desc.slice(0,10000):'视频已不可用',video_url:available?signed[result.rows.length+index!]:'',like_num:available?row!.likeNum:0,site_name:result.siteName,wap_login_logo:signed[result.rows.length*2]};})};
  }
}
