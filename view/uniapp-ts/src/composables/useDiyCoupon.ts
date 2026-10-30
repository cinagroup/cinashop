import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { safeDiyColor } from '@/utils/diy';
import { useDiyCommerceWidget } from './useDiyCommerceWidget';
import { couponDefaultLabel, couponPresentation } from '../../../common/diyCoupon';
/** Coupon reads, claims and recovery continue through the existing controller.
 * Native events own the original whole authored block, actor and rendered row. */
export function useDiyCoupon(block:()=>unknown,active:()=>boolean){
 const auth=useAuthStore(),theme=useThemeStore(),view=computed(()=>couponPresentation(block(),theme.preset,safeDiyColor));
 const state=useDiyCommerceWidget(block,()=>active()&&view.value.enabled);
 let alive=true;const epoch=ref(0);
 const owner=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
 const raw=()=>JSON.stringify(block());
 watch([raw,owner,active,()=>state.loading.value,()=>state.loaded.value,()=>state.error.value,()=>state.coupons.value],()=>{epoch.value++;},{flush:'sync'});
 const issued=()=>{const revision=epoch.value,actor=owner(),source=raw();return()=>alive&&epoch.value===revision&&owner()===actor&&raw()===source&&active()&&view.value.enabled;};
 const actions=computed(()=>{const allowed=issued();return{refresh:()=>{if(allowed()&&!state.loading.value)void state.load();},more:()=>{if(allowed())state.more();},reconcile:()=>{if(allowed())void state.reconcile();}};});
 const entries=computed(()=>{
  const allowed=issued();return state.coupons.value.map(coupon=>{
   const journal=state.couponState(coupon.id),label=journal?state.couponLabel(coupon):couponDefaultLabel(coupon,view.value.style);
   return{coupon,label,disabled:coupon.is_use!==false||!!journal||!!state.claiming.value,tap:()=>{if(allowed()&&state.loaded.value&&!state.loading.value&&!state.error.value&&state.coupons.value.includes(coupon))void state.receive(coupon.id);}};
  });
 });
 onScopeDispose(()=>{alive=false;epoch.value++;});
 return{view,state,entries,actions};
}
