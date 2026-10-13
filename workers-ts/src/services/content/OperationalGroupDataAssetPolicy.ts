import type {DbClient} from '@/lib/di';
import {publicProductPictures,renderProductPictures} from '@/services/activity/ProductAssetPolicy';
const groups=new Set(['routine_home_bast_banner','combination_banner','routine_home_hot_banner','routine_home_new_banner','routine_home_benefit_banner','integral_shop_banner']);
export function isOperationalGroupName(name:string){return groups.has(name);}
/** Resolve only the six commissioned platform content groups. No network or signing in the snapshot. */
export async function operationalGroupPublicPictures(tx:Pick<DbClient,'select'>,rows:ReadonlyArray<{config_name:string;img:unknown}>){
  return publicProductPictures(tx,rows.map(row=>({type:0,relationId:0,image:groups.has(row.config_name)?row.img:''})));
}
export const renderOperationalGroupPictures=renderProductPictures;
