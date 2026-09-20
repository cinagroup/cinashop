import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container } from '@/lib/di';
import { user, wechatUser } from '@/models/schema';
import { prepareOfflinePaymentProvider } from '@/services/payment/OfflinePaymentProvider';
import { readOfflinePaymentConfig } from '@/services/payment/OfflinePaymentConfig';
import type { OfflineReturnClient } from '@/services/payment/OfflinePaymentReturn';
import { AuthException, ValidateException } from '@/utils/errors';
import { offlineAccountCents } from './OfflineOrderPaymentPolicy';
import { offlineAmountCents, offlineMoney } from './OfflineOrderQuoteService';
import { readOfflineOrder } from './OfflineOrderReadService';

type Reason = 'available' | 'disabled' | 'not_configured' | 'identity_required' | 'insufficient_balance'
  | 'amount_unsupported' | 'channel_unsupported' | 'read_original';

/** Advisory availability, never admission/settlement. Known orders use their
 * server-frozen channel/amount, not browser overrides. Crypto runs after the
 * bounded READ ONLY policy snapshot; provider.initiate is never called here. */
export async function readOfflinePaymentMethods(container: Container, env: Env, uid: number, orderNo?: string, returnClient: OfflineReturnClient = 'pc') {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new AuthException('请先登录');
  const detail = orderNo === undefined ? undefined : await readOfflineOrder(container, uid, orderNo);
  const channel = detail?.channel ?? 'h5';
  const source = await withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    const [account] = await tx.select({ balance: user.nowMoney }).from(user)
      .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime)));
    if (!account) throw new AuthException('用户状态不可用，请重新登录');
    const config = await readOfflinePaymentConfig(tx);
    const bindings = ['wechat','routine'].includes(channel) ? await tx.select({ openid: wechatUser.openid })
      .from(wechatUser).where(and(eq(wechatUser.uid, uid), eq(wechatUser.userType, channel), eq(wechatUser.isDel, 0))).limit(2) : [];
    return { balance: offlineAccountCents(account.balance), config,
      payer: bindings.length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(bindings[0].openid) };
  });
  const methods: Record<'yue' | 'weixin' | 'alipay', Reason> = { yue:'available',weixin:'available',alipay:'available' };
  const { config } = source;
  const switchReason = (...keys: string[]): Reason => keys.some(key => !['','0','1'].includes(config[key] ?? '')) ? 'not_configured'
    : keys.every(key => config[key] === '1') ? 'available' : 'disabled';
  methods.yue = switchReason('balance_func_status','yue_pay_status');
  methods.weixin = switchReason('pay_weixin_open'); methods.alipay = switchReason('ali_pay_status');
  const cents = detail ? offlineAmountCents(detail.pay_price, true) : undefined;
  if (methods.yue === 'available' && source.balance < (cents ?? 1n)) methods.yue = 'insufficient_balance';
  if (methods.weixin === 'available' && ['wechat','routine'].includes(channel) && !source.payer) methods.weixin = 'identity_required';
  if (channel === 'routine') methods.alipay = 'channel_unsupported';
  if (cents !== undefined && cents > 2_147_483_647n) { methods.weixin='amount_unsupported'; methods.alipay='amount_unsupported'; }
  if (detail && (detail.state !== 'UNSELECTED' || detail.paid || detail.hidden || cents === 0n)) {
    methods.yue='read_original'; methods.weixin='read_original'; methods.alipay='read_original';
  }
  for (const method of ['weixin','alipay'] as const) {
    if (methods[method] !== 'available') continue;
    try {
      await prepareOfflinePaymentProvider(container, env, method === 'weixin' ? 'wechat' : 'alipay',
        method === 'alipay' ? 'alipay' : channel === 'routine' ? 'routine' : 'wechat', config, returnClient);
    } catch { methods[method]='not_configured'; } // Never expose key material or raw config exceptions.
  }
  // No permission to pay is retained across this response. Writers recheck
  // current account, amount, switches, credentials and immutable selection.
  const siteName = config.site_name ?? '';
  if (siteName === '[oversized-config]' || siteName.length > 200 || /[\u0000-\u001f\u007f]/.test(siteName)) throw new ValidateException('收银名称配置无效');
  return { site_name: siteName, now_money: offlineMoney(source.balance), offline_pay_status: true as const,
    yue_pay_status: methods.yue === 'available' ? 1 : 0, pay_weixin_open: methods.weixin === 'available' ? 1 : 0,
    ali_pay_status: methods.alipay === 'available' ? 1 : 0,
    ...(detail ? { order_id: detail.order_id, channel: detail.channel, pay_price: detail.pay_price } : {}), methods };
}
