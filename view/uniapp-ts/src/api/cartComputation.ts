import { http } from '@/utils/request';
import { useAuthStore } from '@/stores/auth';
import { cartBudgetRequest, type CartBudgetScope } from '../../../common/cartComputation';

export async function apiCartCompute(scope:CartBudgetScope):Promise<unknown> {
  const auth=useAuthStore(),token=auth.token;
  if(!token||auth.uid!==scope.uid||auth.sessionVersion!==scope.version)throw new Error('登录状态已变化，请重新读取预算');
  const result=await http.post<unknown>('/cart/compute',cartBudgetRequest(scope),{headers:{'Content-Type':'application/json'}});
  if(auth.token!==token||auth.uid!==scope.uid||auth.sessionVersion!==scope.version)throw new Error('登录状态已变化，请重新读取预算');
  return result;
}
