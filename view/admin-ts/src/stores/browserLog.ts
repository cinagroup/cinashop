import { shallowRef } from 'vue';
import type { BrowserLogModel } from '@/utils/browserLogState';

// Installation belongs to the app lifetime, not to the log viewer route.
export const browserLog = shallowRef<BrowserLogModel | null>(null);
