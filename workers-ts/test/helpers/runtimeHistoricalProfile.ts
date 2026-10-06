import { runtimeLockOnlyBoundaryBody } from '../../src/migrations/runtimeLockOnlyBoundary';
import { SIGN_DAY_GROUP_LOCK_BOUNDARY } from '../../src/migrations/runtimeSignDayGroupLockBoundary';
import { AGENT_LEVEL_CATALOG_FENCE, AGENT_LEVEL_ROW_GUARD } from '../../src/migrations/runtimeAgentLevelCatalogBoundary';
/** Disposable reconstruction only. Production forwards never revoke grants. */
export async function removeAgentLevelFixtureGrants(exec:(statement:string)=>Promise<unknown>,target:{app:string;admin:string}) {
  for(const name of [target.app,target.admin])if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Fixture role identity required');
  await exec(`REVOKE INSERT ON public.agent_level FROM "${target.admin}";
    REVOKE UPDATE(name,image,color,one_brokerage,two_brokerage,grade,status,is_del) ON public.agent_level FROM "${target.admin}";
    REVOKE USAGE ON SEQUENCE public.agent_level_id_seq FROM "${target.admin}"`);
  for(const table of ['agent_level','agent_level_task','agent_level_task_record'])
    await exec(`DROP TRIGGER IF EXISTS ${AGENT_LEVEL_CATALOG_FENCE} ON public.${table}`);
  await exec(`DROP TRIGGER IF EXISTS ${AGENT_LEVEL_ROW_GUARD} ON public.agent_level;
    DROP FUNCTION IF EXISTS public.${AGENT_LEVEL_CATALOG_FENCE}();DROP FUNCTION IF EXISTS public.${AGENT_LEVEL_ROW_GUARD}()`);
  await exec(`CREATE OR REPLACE FUNCTION public.cinashop_runtime_lock_only_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,pg_temp AS $fixture_boundary$${runtimeLockOnlyBoundaryBody(target.app,target.admin,'promotion-gifts')}$fixture_boundary$`);
}
/** Disposable fixture reconstruction of the exact former current profile. */
export async function removeSignDayFixtureGrants(
  exec:(statement:string)=>Promise<unknown>,target:{app:string;admin:string},
) {
  await removeAgentLevelFixtureGrants(exec,target);
  if(!/^[a-z_][a-z_0-9]*$/.test(target.admin))throw Error('Fixture role identity required');
  await exec(`REVOKE INSERT ON public.system_group FROM "${target.admin}";
    REVOKE UPDATE(id) ON public.system_group FROM "${target.admin}";
    REVOKE INSERT,DELETE ON public.system_group_data FROM "${target.admin}";
    REVOKE UPDATE(value,sort,status) ON public.system_group_data FROM "${target.admin}";
    REVOKE USAGE ON SEQUENCE public.system_group_id_seq,public.system_group_data_id_seq FROM "${target.admin}"`);
  await exec(`DROP TRIGGER ${SIGN_DAY_GROUP_LOCK_BOUNDARY} ON public.system_group;
    DROP FUNCTION public.${SIGN_DAY_GROUP_LOCK_BOUNDARY}()`);
}
/** Disposable PG16 fixture only. Reconstruct the frozen coupon-era ACLs after
 * commissioning today's fixed profile; production forwards never revoke. */
export async function removePromotionGiftFixtureGrants(
  exec:(statement:string)=>Promise<unknown>,target:{app:string;admin:string},
) {
  for(const name of [target.app,target.admin])if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Fixture role identity required');
  await removeSignDayFixtureGrants(exec,target);
  await exec(`REVOKE INSERT ON public.store_promotions FROM "${target.admin}";
    REVOKE INSERT,DELETE ON public.store_promotions_auxiliary FROM "${target.admin}";
    REVOKE USAGE ON SEQUENCE public.store_promotions_id_seq,public.store_promotions_auxiliary_id_seq FROM "${target.admin}";
    REVOKE SELECT ON public.store_order_promotion_gift_coupon_reward FROM "${target.admin}";
    REVOKE SELECT,INSERT ON public.store_order_promotion_gift_coupon_reward FROM "${target.app}";
    REVOKE USAGE ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq FROM "${target.app}"`);
  await exec(`CREATE OR REPLACE FUNCTION public.cinashop_runtime_lock_only_v1() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,pg_temp AS $fixture_boundary$${runtimeLockOnlyBoundaryBody(target.app,target.admin,'legacy')}$fixture_boundary$`);
}
