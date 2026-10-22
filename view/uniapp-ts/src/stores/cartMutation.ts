import { ref } from 'vue';
/** Successful, authenticated cart writes only. Read/cancel counters are unrelated. */
export const cartMutationRevision = ref(0);
export function recordCartMutation(url: string, method: string): void {
  if (method !== 'GET' && /^(?:cart\/(?:add|num|del|update|remove)|cart\/add\/newcomer-replay)$/u.test(url.split('?')[0] ?? '')) cartMutationRevision.value++;
}
