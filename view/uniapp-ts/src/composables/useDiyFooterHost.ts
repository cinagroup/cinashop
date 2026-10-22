import { ref, nextTick, onScopeDispose } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useDiyFooterStore } from '@/stores/diyFooter';
import { useNativeFooterStore } from '@/stores/nativeFooter';

/** Register page hooks at the actual Page, never in a dynamically mounted block. */
export function useDiyFooterHost() {
  const visible = ref(false), height = ref(0), footer = useDiyFooterStore(), native = useNativeFooterStore();
  let disposed = false, generation = 0, physicalTicket: number | undefined;
  // If this Page disappears before the flush, release only its own barrier.
  // The coordinator always reconciles the latest global owner/actor claim.
  function releasePhysical() { const ticket = physicalTicket; physicalTicket = undefined; if (ticket !== undefined) void nextTick(() => native.reconcilePhysical(ticket)); }
  onShow(() => { if (!disposed) {
    const life = ++generation, ticket = native.invalidatePhysical(); physicalTicket = ticket;
    visible.value = true; void footer.refresh();
    void nextTick(() => { if (disposed || !visible.value || life !== generation) return; physicalTicket = undefined; native.reconcilePhysical(ticket); });
  } });
  onHide(() => { visible.value = false; generation++; releasePhysical(); });
  const dispose = () => { if (disposed) return; disposed = true; visible.value = false; height.value = 0; generation++; releasePhysical(); };
  onUnload(dispose); onScopeDispose(dispose);
  return { visible, height };
}
