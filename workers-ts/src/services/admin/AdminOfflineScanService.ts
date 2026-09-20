import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { boundedOfflineCodeFetch, OFFLINE_SCAN_VERSION, offlineH5ScanImage, offlineMiniScanImage, offlineScanUrl } from '@/services/order/OfflineScanCode';
import { assertAdminOfflineReader, type AdminOfflineReadActor } from './AdminOfflineOrderReadService';
import { emitOperationalEvent, operationalErrorCode } from '@/utils/observability';

export async function readAdminOfflineScan(container: Container, env: Env, actor: AdminOfflineReadActor, type: 0 | 1) {
  await assertAdminOfflineReader(container, actor);
  const url = offlineScanUrl(env.OFFLINE_H5_RETURN_ORIGIN);
  const wechat = offlineH5ScanImage(url, type);
  let routine = '', routineStatus: 'ready' | 'not_configured' | 'unavailable' = 'not_configured';
  try {
    const image = await new WechatMiniProgramCodeService(container, env, boundedOfflineCodeFetch()).createOfflineCashierDataUrl();
    if (image) { routine = offlineMiniScanImage(image, type); routineStatus = 'ready'; }
  } catch (error) {
    routineStatus = 'unavailable';
    emitOperationalEvent('error', { event: 'offline_cashier_code_failed', component: 'http', operation: 'offline_cashier_code',
      outcome: 'failure', errorCode: operationalErrorCode(error) });
  }
  // Do not keep a database transaction open across provider I/O. A fresh
  // snapshot prevents a revoked reader receiving the delayed response.
  await assertAdminOfflineReader(container, actor);
  return { version: OFFLINE_SCAN_VERSION, type, wechat, wechat_url: url, routine, routine_status: routineStatus };
}
