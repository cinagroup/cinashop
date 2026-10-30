/** 微信支付 API v3：下单、回调验签、原路退款和退款查询。 */
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import {
  aesGcmDecrypt,
  buildV3Authorization,
  rsaVerify,
  rsaSign,
} from "@/utils/wechat-crypto";
import type {
  RefundProviderRequest,
  RefundProviderResult,
  RefundProviderStatus,
} from "@/services/payment/RefundGateway";
import type {
  PaymentProviderQueryRequest,
  PaymentProviderQueryResult,
} from "@/services/payment/PaymentProviderQuery";
import {
  isWechatMerchantCertificateSerial,
  isWechatMerchantId,
  WECHAT_PAYMENT_PROFILE_APP_ID_KEYS,
} from "@/services/payment/PaymentReadinessService";
import { assertPaymentQueryCredentialIdentity, validatePaymentQueryIdentity, type PaymentQueryOriginalIdentity } from '@/services/payment/PaymentQueryIdentity';
import { readPaymentProviderResponse } from '@/utils/payment-response';
import { assertOfflineProviderRequest, checkedOfflineHttps, validateOfflinePaymentTicket,
  type OfflinePaymentTicket, type PreparedOfflineProvider } from '@/services/payment/OfflinePaymentProviderContract';
import { prepareOfflineReturn, type OfflineReturnClient } from '@/services/payment/OfflinePaymentReturn';
import { readNativeAppPaymentAccount, recordNativeAppPaymentInitiation, confirmNativeAppPaymentInitiation,
  recordNativeAppProviderEvidence, assertNativeAppQueryAccount, assertNativeAppRefundAccount } from '@/services/payment/NativeAppPaymentAuthority';
import { assertNativeAppRefundProviderRequest } from '@/services/payment/NativeAppRefundProviderAuthority';
import { readPaymentPublicConfig, type PaymentPublicSnapshot } from '@/services/payment/PaymentPublicRuntimeConfig';
import { readRoutinePaymentReplay, reserveRoutinePayment, recordRoutinePaymentReceipt, requireRoutinePaymentReady,
  type RoutinePaymentAdmission } from '@/services/payment/RoutinePaymentInitiation';

const BASE_URL = "https://api.mch.weixin.qq.com";

export type WechatPayProfile = "wechat" | "routine" | "app";

export function wechatPayAppIdKey(profile: WechatPayProfile): string {
  return WECHAT_PAYMENT_PROFILE_APP_ID_KEYS[profile];
}

interface WechatMerchantConfig {
  mchId: string;
  serialNo: string;
  apiV3Key: string;
  privateKey: string;
  platformPublicKey: string;
  platformPublicKeyId?: string;
  refundNotifyUrl: string;
}
interface WechatPayConfig extends WechatMerchantConfig {
  appId: string;
  notifyUrl: string;
  nativeAppStamp?: string;
  routinePaymentSource?: PaymentPublicSnapshot;
}

interface WechatRefundResponse {
  refund_id?: string;
  out_refund_no?: string;
  transaction_id?: string;
  out_trade_no?: string;
  status?: string;
  success_time?: string;
  amount?: { refund?: number; total?: number };
  code?: string;
  message?: string;
}

interface WechatTradeQueryResponse {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  success_time?: string;
  amount?: { total?: number; currency?: string };
  payer?: { openid?: string };
  trade_type?: string;
}

export class WechatPayService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /** Frozen request-local credentials for the dedicated offline dispatcher. */
  async prepareOfflineOrder(profile: 'wechat' | 'routine', currentConfig?: Readonly<Record<string, string>>, returnClient: OfflineReturnClient = 'pc'): Promise<PreparedOfflineProvider> {
    const cfg = await this.getConfig(profile, true, currentConfig);
    const returnUrl = profile === 'routine' ? undefined : prepareOfflineReturn(this.env,returnClient);
    const url = checkedOfflineHttps(cfg.notifyUrl, 255);
    if (url.search || !/^[A-Za-z0-9_-]{1,32}$/.test(cfg.appId)) throw new ValidateException('线下微信配置无效');
    const probe = await rsaSign(cfg.privateKey, 'offline-preflight');
    // Import/algorithm validation only: platform and merchant keys are distinct.
    await rsaVerify(cfg.platformPublicKey, 'offline-preflight', probe);
    const identity = { provider: 'wechat' as const, profile, appId: cfg.appId, merchantId: cfg.mchId };
    return { identity: { ...identity }, initiate: async input => {
      const request = { ...input }; assertOfflineProviderRequest(request);
      if (!['jsapi', 'h5'].includes(request.transactionType) || (profile === 'routine' && request.transactionType !== 'jsapi')) {
        throw new ValidateException('线下微信交易类型无效');
      }
      const body: Record<string, unknown> = { appid: cfg.appId, mchid: cfg.mchId, out_trade_no: request.orderNo,
        description: 'CinaShop线下消费', notify_url: cfg.notifyUrl, attach: 'offline_order',
        amount: { total: request.amountCents, currency: 'CNY' } };
      if (request.transactionType === 'jsapi') body.payer = { openid: request.payerId };
      else {
        body.scene_info = { payer_client_ip: request.clientIp, h5_info: { type: 'Wap' } };
      }
      const result = await this.callApi<Record<string, unknown>>('POST', `/v3/pay/transactions/${request.transactionType}`, body, cfg, true);
      let ticket: OfflinePaymentTicket;
      if (request.transactionType === 'h5') {
        if (typeof result.h5_url !== 'string') throw new ValidateException('微信H5响应缺少支付链接');
        // Verify the signed provider URL first. Preserve every original byte;
        // WeChat explicitly permits appending an encoded merchant redirect_url.
        ticket = { kind: 'wechat-h5', url: result.h5_url };
        validateOfflinePaymentTicket(ticket,identity,request.transactionType);
        if (!returnUrl || new URL(result.h5_url).searchParams.has('redirect_url')) throw new ValidateException('微信H5返回参数异常');
        ticket = {kind:'wechat-h5',url:`${result.h5_url}&redirect_url=${encodeURIComponent(returnUrl(request.orderNo))}`};
      } else {
        if (typeof result.prepay_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.prepay_id)) {
          throw new ValidateException('微信预支付标识无效');
        }
        const { buildJsapiPaySign } = await import('@/utils/wechat-crypto');
        const signed = await buildJsapiPaySign(cfg.privateKey, cfg.appId, result.prepay_id);
        if (signed.signType !== 'RSA') throw new ValidateException('微信支付签名类型无效');
        ticket = { kind: 'wechat-jsapi', appId: cfg.appId, ...signed, signType: 'RSA' };
      }
      validateOfflinePaymentTicket(ticket, identity, request.transactionType, request); return ticket;
    } };
  }

  async createOrder(params: {
    profile: WechatPayProfile;
    type: "jsapi" | "native" | "h5" | "app";
    outTradeNo: string;
    description: string;
    amount: number;
    openid?: string;
    attach?: string;
    payerClientIp?: string;
    /** Explicit new clients need complete JSAPI/App invocation parameters.
     * Other callers retain their historical response shape. */
    includeInvocationParameters?: boolean;
    /** Assisted orders persist their one-shot claim after local validation and before HTTP. */
    beforeProviderRequest?: () => Promise<void>;
    /** Mini uses the actual captured AppID and a SQL-bound order admission. */
    routinePayer?: RoutinePaymentAdmission;
  }): Promise<Record<string, unknown>> {
    // Capture caller primitives and admission before the first asynchronous read.
    params = { ...params, ...(params.routinePayer ? { routinePayer: { ...params.routinePayer } } : {}) };
    if ((params.profile === 'app') !== (params.type === 'app')) throw new ValidateException('原生App支付渠道与交易类型不一致');
    if (params.profile === 'routine') return this.createRoutineOrder(params);
    if (params.routinePayer) throw new ValidateException('小程序付款准入与渠道不一致');
    const cfg = await this.getConfig(params.profile);
    const appDomain = ({ product: 'store_order', user_recharge: 'recharge', member: 'membership' } as const)[(params.attach ?? 'product') as 'product' | 'user_recharge' | 'member'];
    if (params.profile === 'app' && (!appDomain || !cfg.nativeAppStamp)) throw new ValidateException('原生App支付订单域未登记');
    const path = `/v3/pay/transactions/${params.type}`;
    const total = Math.round(params.amount * 100);
    if (!Number.isSafeInteger(total) || total <= 0) throw new ValidateException("微信支付金额无效");
    const body: Record<string, unknown> = {
      appid: cfg.appId,
      mchid: cfg.mchId,
      out_trade_no: params.outTradeNo,
      description: params.description,
      notify_url: cfg.notifyUrl,
      attach: params.attach ?? "product",
      amount: { total, currency: "CNY" },
    };
    if (params.type === "jsapi" && params.openid) body.payer = { openid: params.openid };
    if (params.type === "h5") {
      body.scene_info = {
        payer_client_ip: params.payerClientIp ?? "0.0.0.0",
        h5_info: { type: "Wap" },
      };
    }

    if (params.beforeProviderRequest) {
      // A malformed merchant key must fail before the durable initiation claim.
      await rsaSign(cfg.privateKey, "assisted-provider-preflight");
      await params.beforeProviderRequest();
    }

    const selection = params.profile === 'app' ? await recordNativeAppPaymentInitiation(this.container, this.env, {
      appId: cfg.appId, merchantId: cfg.mchId, profile: 'app', orderNo: params.outTradeNo, amountCents: total,
      orderDomain: appDomain!, currency: 'CNY', configStamp: cfg.nativeAppStamp!,
    }) : null;

    const result = await this.callApi<Record<string, unknown>>("POST", path, body, cfg, params.profile === 'app');
    if (params.profile === 'app') {
      const { buildNativeAppPaySign } = await import('@/utils/wechat-crypto');
      if (typeof result.prepay_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(result.prepay_id) || !selection) throw new ValidateException('原生App预支付响应缺少有效会话标识');
      // Confirm the provider's actual order account. A local retry selection
      // alone cannot retroactively assign an original AppID to a legacy order.
      const observed = await this.callApi<WechatTradeQueryResponse>('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(params.outTradeNo)}?mchid=${encodeURIComponent(cfg.mchId)}`, undefined, cfg, true);
      if (observed.appid !== cfg.appId || observed.mchid !== cfg.mchId || observed.out_trade_no !== params.outTradeNo
        || observed.trade_type !== 'APP' || observed.amount?.total !== total || observed.amount?.currency !== 'CNY'
        || !['NOTPAY','USERPAYING','SUCCESS'].includes(observed.trade_state ?? '')) throw new ValidateException('原生App预支付实际订单身份不一致');
      await confirmNativeAppPaymentInitiation(this.container, this.env, selection, { appId: observed.appid, merchantId: observed.mchid,
        orderNo: observed.out_trade_no, amountCents: total, currency: 'CNY', tradeType: 'APP', prepayId: result.prepay_id });
      return { prepay_id: result.prepay_id, ...await buildNativeAppPaySign(cfg.privateKey, cfg.appId, cfg.mchId, result.prepay_id) };
    }
    if (params.type === "jsapi" && typeof result.prepay_id === "string") {
      const { buildJsapiPaySign } = await import("@/utils/wechat-crypto");
      const signParams = await buildJsapiPaySign(cfg.privateKey, cfg.appId, result.prepay_id);
      return { ...(params.includeInvocationParameters ? { appId: cfg.appId } : {}), prepay_id: result.prepay_id, ...signParams };
    }
    if (params.type === 'app' && params.includeInvocationParameters) {
      const { buildWechatAppPaymentLaunch } = await import('@/services/payment/WechatPaymentLaunch');
      return buildWechatAppPaymentLaunch(cfg.privateKey, cfg.appId, cfg.mchId, result.prepay_id);
    }
    return result;
  }

  private async createRoutineOrder(params: Parameters<WechatPayService['createOrder']>[0]): Promise<Record<string, unknown>> {
    const admission=params.routinePayer,total=Math.round(params.amount*100);
    const domain=({product:'store_order',user_recharge:'recharge',member:'membership'} as const)[(params.attach??'product') as 'product'|'user_recharge'|'member'];
    if (params.type!=='jsapi' || !admission || admission.orderDomain!==domain || params.openid!==undefined
      || params.beforeProviderRequest || !Number.isSafeInteger(total) || total<=0)
      throw new ValidateException('小程序支付必须使用已登记的 JSAPI 付款准入');
    const request={orderNo:params.outTradeNo,amountCents:total,admission};
    const existing=await readRoutinePaymentReplay(this.container,this.env,request);
    if (existing.kind!=='new') return {...requireRoutinePaymentReady(existing)};
    const cfg=await this.getConfig('routine',true);
    if (!cfg.routinePaymentSource) throw new ValidateException('小程序支付公开来源未登记');
    // Validate both keys before committing the at-most-once attempt. No RSA or
    // HTTP is performed inside the source/storage/order transaction.
    const probe=await rsaSign(cfg.privateKey,'routine-payment-preflight');
    await rsaVerify(cfg.platformPublicKey,'routine-payment-preflight',probe);
    const reservation=await reserveRoutinePayment(this.container,this.env,{...request,appId:cfg.appId,
      merchantId:cfg.mchId,publicSource:cfg.routinePaymentSource,description:params.description,
      notifyUrl:cfg.notifyUrl,attach:params.attach??'product'});
    if (reservation.kind==='conflict') throw new ValidateException('支付金额或渠道与已发起的交易不一致，请先人工对账');
    if (reservation.kind!=='reserved') return {...requireRoutinePaymentReady(reservation)};
    const result=await this.callApi<Record<string,unknown>>('POST','/v3/pay/transactions/jsapi',reservation.intent.payload.providerBody,cfg,true);
    if (typeof result.prepay_id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(result.prepay_id))
      throw new ValidateException('小程序预支付响应缺少有效会话标识');
    const {buildJsapiPaySign}=await import('@/utils/wechat-crypto');
    const packet={prepay_id:result.prepay_id,...await buildJsapiPaySign(cfg.privateKey,cfg.appId,result.prepay_id)};
    await recordRoutinePaymentReceipt(this.container,this.env,reservation.intent,packet);
    const ready=await readRoutinePaymentReplay(this.container,this.env,request);
    if (ready.kind==='new') throw new ValidateException('小程序付款记录丢失，请核对原交易');
    return {...requireRoutinePaymentReady(ready)};
  }

  async verifyAndParseNotify(
    headers: Record<string, string>,
    rawBody: string,
    profile: WechatPayProfile,
  ): Promise<{
    eventId: string;
    outTradeNo: string;
    transactionId: string;
    tradeState: string;
    amountTotal: number;
    providerEventTime: number;
    appId: string;
    merchantId: string;
    payerId?: string;
  }> {
    const { data, cfg, eventId } = await this.verifyAndDecryptNotify<{
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      success_time?: string;
      amount?: { total?: number; currency?: string };
      payer?: { openid?: string };
      trade_type?: string;
    }>(headers, rawBody, "transaction", profile);
    if (data.mchid !== cfg.mchId || (profile !== 'app' && data.appid !== cfg.appId)) {
      throw new ValidateException("微信支付回调商户信息不匹配");
    }
    if (
      !data.out_trade_no
      || !data.transaction_id
      || !data.trade_state
      || !/^[A-Za-z0-9_-]{2,64}$/.test(data.out_trade_no)
      || !/^[A-Za-z0-9_-]{1,100}$/.test(data.transaction_id)
      || !Number.isSafeInteger(data.amount?.total)
      || Number(data.amount?.total) <= 0
      || data.amount?.currency !== "CNY"
    ) {
      throw new ValidateException("微信支付回调业务字段不完整");
    }
    const providerEventTime = parseProviderTime(data.success_time);
    if (data.trade_state === "SUCCESS" && providerEventTime === undefined) {
      throw new ValidateException("微信支付回调成功时间无效");
    }
    if (profile === 'app') {
      if (data.trade_type !== 'APP' || typeof data.appid !== 'string') throw new ValidateException('原生App回调交易类型无效');
      await recordNativeAppProviderEvidence(this.container, this.env, { source: 'callback', providerEventId: eventId,
        appId: data.appid, merchantId: cfg.mchId, orderNo: data.out_trade_no, transactionId: data.transaction_id,
        tradeState: data.trade_state, amountCents: Number(data.amount?.total), currency: 'CNY', providerEventTime: providerEventTime ?? 0, tradeType: 'APP' });
    }
    return {
      eventId,
      outTradeNo: data.out_trade_no,
      transactionId: data.transaction_id,
      tradeState: data.trade_state,
      amountTotal: data.amount?.total ?? 0,
      providerEventTime: providerEventTime ?? 0,
      appId: data.appid as string,
      merchantId: cfg.mchId,
      ...(typeof data.payer?.openid === 'string' ? { payerId: data.payer.openid } : {}),
    };
  }

  async requestRefund(request: RefundProviderRequest): Promise<RefundProviderResult> {
    request = { ...request };
    validateRefundRequest(request);
    const cfg = await this.getRefundConfig();
    await assertNativeAppRefundProviderRequest(this.container, this.env, request, 'request', cfg.mchId);
    const path = "/v3/refund/domestic/refunds";
    const body: Record<string, unknown> = {
      out_refund_no: request.outRefundNo,
      reason: (request.reason ?? "").slice(0, 80),
      notify_url: cfg.refundNotifyUrl,
      amount: {
        refund: request.refundAmount,
        total: request.totalAmount,
        currency: "CNY",
      },
    };
    if (request.transactionId) body.transaction_id = request.transactionId;
    else body.out_trade_no = request.outTradeNo;

    const response = await this.callApi<WechatRefundResponse>("POST", path, body, cfg);
    return normalizeWechatRefundResponse(response, request);
  }

  async queryRefund(request: RefundProviderRequest): Promise<RefundProviderResult> {
    request = { ...request };
    validateRefundRequest(request);
    const cfg = await this.getRefundConfig();
    await assertNativeAppRefundProviderRequest(this.container, this.env, request, 'query', cfg.mchId);
    const path = `/v3/refund/domestic/refunds/${encodeURIComponent(request.outRefundNo)}`;
    try {
      const response = await this.callApi<WechatRefundResponse>("GET", path, undefined, cfg);
      return normalizeWechatRefundResponse(response, request);
    } catch (error) {
      if (error instanceof WechatApiError && error.code === "RESOURCE_NOT_EXISTS") {
        return { status: "NOT_FOUND", message: error.message };
      }
      throw error;
    }
  }

  async queryOrder(request: PaymentProviderQueryRequest, original?: PaymentQueryOriginalIdentity): Promise<PaymentProviderQueryResult> {
    if (request.provider !== "wechat" || !["wechat", "routine", "app"].includes(request.profile)) {
      throw new ValidateException("微信支付查单渠道无效");
    }
    request = { ...request };
    original = original ? { ...original } : undefined;
    validatePaymentQueryIdentity(request, original);
    const cfg = await this.getConfig(request.profile as WechatPayProfile, false, undefined, true);
    assertPaymentQueryCredentialIdentity(original, cfg.appId, cfg.mchId);
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(request.orderNo)}`
      + `?mchid=${encodeURIComponent(cfg.mchId)}`;
    let response: WechatTradeQueryResponse;
    try {
      response = await this.callApi<WechatTradeQueryResponse>("GET", path, undefined, cfg, true);
    } catch (error) {
      if (
        error instanceof WechatApiError
        && ["ORDER_NOT_EXIST", "RESOURCE_NOT_EXISTS"].includes(error.code)
      ) {
        return emptyTradeQueryResult(request, "NOT_FOUND", "NOTPAY", "provider_trade_not_found");
      }
      throw error;
    }
    if (
      typeof response.appid !== 'string'
      || (request.profile !== 'app' && response.appid !== cfg.appId)
      || response.mchid !== cfg.mchId
      || response.out_trade_no !== request.orderNo
    ) {
      return emptyTradeQueryResult(request, "UNKNOWN", "UNKNOWN", "provider_identity_mismatch");
    }
    if (request.profile === 'app') {
      if (response.trade_type !== 'APP' || typeof response.appid !== 'string')
        return emptyTradeQueryResult(request, 'UNKNOWN', 'UNKNOWN', 'provider_identity_mismatch');
      await assertNativeAppQueryAccount(this.container, this.env, request, { appId: response.appid, merchantId: cfg.mchId });
    }
    const providerTradeState = typeof response.trade_state === 'string' ? response.trade_state : 'UNKNOWN';
    if (["NOTPAY", "USERPAYING"].includes(providerTradeState)) {
      return emptyTradeQueryResult(request, "PENDING", providerTradeState, "");
    }
    if (["CLOSED", "REVOKED", "PAYERROR", "REFUND"].includes(providerTradeState)) {
      const uncertain = !!original || ['REVOKED', 'REFUND'].includes(providerTradeState);
      return emptyTradeQueryResult(request, uncertain ? "UNKNOWN" : "CLOSED", providerTradeState,
        uncertain ? 'provider_closed_or_refunded' : "");
    }
    if (providerTradeState !== "SUCCESS") {
      return emptyTradeQueryResult(request, "UNKNOWN", providerTradeState, "provider_status_unknown");
    }
    const transactionId = typeof response.transaction_id === 'string' ? response.transaction_id : '';
    const amountCents = typeof response.amount?.total === 'number' ? response.amount.total : -1;
    const providerEventTime = parseProviderTime(response.success_time) ?? 0;
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(transactionId)
      || !Number.isSafeInteger(amountCents)
      || amountCents !== request.expectedAmountCents
      || response.amount?.currency !== "CNY"
      || providerEventTime <= 0
      || (request.profile === 'app' && (response.trade_type !== 'APP' || typeof response.appid !== 'string'))
      || (original && (transactionId.length > 50
        || response.trade_type !== (original.transactionType === 'jsapi' ? 'JSAPI' : 'MWEB')
        || (original.payerId !== '' && response.payer?.openid !== original.payerId)))
    ) {
      return {
        ...emptyTradeQueryResult(
          request,
          "UNKNOWN",
          providerTradeState,
          "provider_evidence_mismatch",
        ),
        transactionId,
        amountCents,
        providerEventTime,
      };
    }
    const nativeAppEvidenceId = request.profile === 'app' ? await recordNativeAppProviderEvidence(this.container, this.env, {
      source: 'signed_query', appId: response.appid!, merchantId: cfg.mchId, orderNo: request.orderNo, transactionId,
      tradeState: providerTradeState, amountCents, currency: 'CNY', providerEventTime, tradeType: 'APP',
    }) : undefined;
    return {
      status: "SUCCESS",
      providerTradeState,
      orderNo: request.orderNo,
      transactionId,
      amountCents,
      currency: "CNY",
      providerEventTime,
      errorCode: "",
      ...(nativeAppEvidenceId ? { nativeAppEvidenceId } : {}),
      ...(original ? { identityEvidence: { source: 'wechat-signed-query' as const,
        appId: response.appid, merchantId: response.mchid,
        ...(original.payerId ? { payerId: response.payer?.openid } : {}) } } : {}),
    };
  }

  async verifyAndParseRefundNotify(
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{
    eventId: string;
    outTradeNo: string;
    transactionId: string;
    outRefundNo: string;
    providerRefundId: string;
    status: RefundProviderStatus;
    refundAmount: number;
    totalAmount: number;
    successTime?: number;
  }> {
    const { data, cfg, eventId } = await this.verifyAndDecryptNotify<{
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      out_refund_no?: string;
      refund_id?: string;
      refund_status?: string;
      success_time?: string;
      amount?: { refund?: number; total?: number };
    }>(headers, rawBody, "refund", "wechat");
    if (data.mchid !== cfg.mchId) throw new ValidateException("微信退款回调商户号不匹配");
    if (
      !data.out_trade_no ||
      !data.transaction_id ||
      !data.out_refund_no ||
      !data.refund_id ||
      !data.refund_status
    ) {
      throw new ValidateException("微信退款回调业务字段不完整");
    }
    await assertNativeAppRefundAccount(this.container, this.env, {
      orderNo: data.out_trade_no, merchantId: cfg.mchId, totalAmount: data.amount?.total ?? -1,
      transactionId: data.transaction_id,
    });
    return {
      eventId,
      outTradeNo: data.out_trade_no,
      transactionId: data.transaction_id,
      outRefundNo: data.out_refund_no,
      providerRefundId: data.refund_id,
      status: normalizeWechatStatus(data.refund_status),
      refundAmount: data.amount?.refund ?? -1,
      totalAmount: data.amount?.total ?? -1,
      successTime: parseProviderTime(data.success_time),
    };
  }

  private verifyAndDecryptNotify<T>(headers: Record<string, string>, rawBody: string,
    expectedOriginalType: 'transaction', profile: WechatPayProfile): Promise<{ data: T; cfg: WechatPayConfig; eventId: string }>;
  private verifyAndDecryptNotify<T>(headers: Record<string, string>, rawBody: string,
    expectedOriginalType: 'refund', profile: WechatPayProfile): Promise<{ data: T; cfg: WechatMerchantConfig; eventId: string }>;
  private async verifyAndDecryptNotify<T>(
    headers: Record<string, string>,
    rawBody: string,
    expectedOriginalType: "transaction" | "refund",
    profile: WechatPayProfile,
  ): Promise<{ data: T; cfg: WechatMerchantConfig; eventId: string }> {
    const timestamp = headers["wechatpay-timestamp"] ?? "";
    const nonce = headers["wechatpay-nonce"] ?? "";
    const signature = headers["wechatpay-signature"] ?? "";
    const serial = headers["wechatpay-serial"] ?? "";
    if (!timestamp || !nonce || !signature || !serial) {
      throw new ValidateException("缺少微信回调签名头");
    }
    const timestampNumber = Number(timestamp);
    if (!Number.isSafeInteger(timestampNumber)) throw new ValidateException("微信回调时间戳无效");
    if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) {
      throw new ValidateException("微信回调已过期");
    }

    const cfg = expectedOriginalType === 'refund' ? await this.getRefundConfig() : await this.getConfig(profile, false, undefined, true);
    this.assertPlatformSerial(serial, cfg);
    if (signature.startsWith("WECHATPAY/SIGNTEST/")) {
      throw new ValidateException("微信签名探测请求已拒绝");
    }
    const valid = await rsaVerify(
      cfg.platformPublicKey,
      `${timestamp}\n${nonce}\n${rawBody}\n`,
      signature,
    );
    if (!valid) throw new ValidateException("微信回调验签失败");

    const notifyBody = JSON.parse(rawBody) as {
      id?: string;
      resource_type?: string;
      resource?: {
        algorithm?: string;
        original_type?: string;
        ciphertext?: string;
        nonce?: string;
        associated_data?: string;
      };
    };
    const eventId = notifyBody.id ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(eventId)) {
      throw new ValidateException("微信回调通知 ID 无效");
    }
    const resource = notifyBody.resource;
    if (
      notifyBody.resource_type !== "encrypt-resource" ||
      resource?.algorithm !== "AEAD_AES_256_GCM" ||
      resource.original_type !== expectedOriginalType ||
      !resource.ciphertext ||
      !resource.nonce
    ) {
      throw new ValidateException("微信回调 resource 格式不正确");
    }
    const decrypted = await aesGcmDecrypt(
      resource.ciphertext,
      cfg.apiV3Key,
      resource.nonce,
      resource.associated_data ?? "",
    );
    return { data: JSON.parse(decrypted) as T, cfg, eventId };
  }

  private async callApi<T extends object>(
    method: "GET" | "POST",
    path: string,
    bodyValue: Record<string, unknown> | undefined,
    cfg: WechatMerchantConfig,
    verifyErrorResponse = false,
  ): Promise<T> {
    const body = bodyValue ? JSON.stringify(bodyValue) : "";
    const authorization = await buildV3Authorization(
      cfg.privateKey,
      method,
      path,
      body,
      cfg.mchId,
      cfg.serialNo,
    );
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authorization,
    };
    if (bodyValue) headers["Content-Type"] = "application/json";
    if (cfg.platformPublicKeyId) headers["Wechatpay-Serial"] = cfg.platformPublicKeyId;

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: bodyValue ? body : undefined,
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new Error(`微信支付请求网络状态未知: ${errorMessage(error)}`);
    }
    const rawBody = await readPaymentProviderResponse(response);
    if (response.ok || verifyErrorResponse) await this.verifyApiResponse(response.headers, rawBody, cfg);

    let result: Record<string, unknown>;
    try {
      const parsed: unknown = rawBody ? JSON.parse(rawBody) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid response shape');
      result = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`微信支付响应不是 JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new WechatApiError(
        typeof result.code === "string" ? result.code : `HTTP_${response.status}`,
        typeof result.message === "string" ? result.message : response.statusText,
      );
    }
    return result as T;
  }

  private async verifyApiResponse(
    headers: Headers,
    rawBody: string,
    cfg: WechatMerchantConfig,
  ): Promise<void> {
    const timestamp = headers.get("Wechatpay-Timestamp") ?? "";
    const nonce = headers.get("Wechatpay-Nonce") ?? "";
    const signature = headers.get("Wechatpay-Signature") ?? "";
    const serial = headers.get("Wechatpay-Serial") ?? "";
    if (!timestamp || !nonce || !signature || !serial) {
      throw new Error("微信支付成功响应缺少验签头");
    }
    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300
      || nonce.length > 128 || signature.startsWith('WECHATPAY/SIGNTEST/')) {
      throw new Error('微信支付响应签名时间或签名头无效');
    }
    this.assertPlatformSerial(serial, cfg);
    const valid = await rsaVerify(
      cfg.platformPublicKey,
      `${timestamp}\n${nonce}\n${rawBody}\n`,
      signature,
    );
    if (!valid) throw new Error("微信支付成功响应验签失败");
  }

  private assertPlatformSerial(serial: string, cfg: WechatMerchantConfig): void {
    if (cfg.platformPublicKeyId && serial !== cfg.platformPublicKeyId) {
      throw new ValidateException("微信支付平台公钥 ID 不匹配");
    }
  }

  private async getConfig(profile: WechatPayProfile, requireEnabled = false, currentConfig?: Readonly<Record<string, string>>, verification = false): Promise<WechatPayConfig> {
    // Offline dispatch supplies its own already captured SQL selection. Other
    // requests read one fresh fixed public cohort, never cfg_* or OAuth Secret.
    const snapshot = currentConfig ? undefined : await readPaymentPublicConfig(this.container, profile === 'routine' ? 'routine' : profile === 'wechat' ? 'official' : 'merchant');
    const values = currentConfig ?? snapshot!.values;
    if (requireEnabled && values.pay_weixin_open !== '1') throw new ValidateException('微信支付未开启');
    const merchant = this.merchantConfig(values);
    const native = profile === 'app' ? await readNativeAppPaymentAccount(this.container, this.env) : null;
    const appId = native ? native.appId : values[wechatPayAppIdKey(profile)] ?? "";
    if (native ? native.merchantId !== merchant.mchId || !verification && !/^[A-Za-z0-9_-]{1,32}$/u.test(appId)
      : profile === 'routine' ? !/^[A-Za-z0-9_-]{1,32}$/u.test(appId) : !appId) {
      throw new ValidateException("微信支付公开商户配置不完整");
    }
    const siteUrl = (values.site_url ?? "").replace(/\/$/, "");
    const notifyUrl = `${siteUrl}/api/pay/notify/${profile}`;
    assertCallbackUrl(notifyUrl, "微信支付回调");
    return {
      ...merchant,
      appId,
      notifyUrl,
      ...(native ? { nativeAppStamp: native.stamp } : {}),
      ...(profile === 'routine' && !verification && snapshot ? { routinePaymentSource: snapshot } : {}),
    };
  }

  /** Refund APIs are merchant-scoped. Neither any client AppID/Secret nor the
   * new-payment enable switch may prevent recovery of an existing refund. */
  private async getRefundConfig(): Promise<WechatMerchantConfig> {
    return this.merchantConfig((await readPaymentPublicConfig(this.container, 'merchant')).values);
  }
  private merchantConfig(values: Readonly<Record<string, string>>): WechatMerchantConfig {
    const privateKey = this.env.WECHAT_MCH_PRIVATE_KEY;
    const platformPublicKey = this.env.WECHAT_PLATFORM_PUBLIC_KEY ?? this.env.WECHAT_PLATFORM_CERT;
    if (!privateKey) throw new ValidateException('微信商户私钥未配置');
    if (!platformPublicKey?.includes('BEGIN PUBLIC KEY')) throw new ValidateException('微信支付平台公钥未配置为 SPKI PEM');
    const mchId = values.pay_weixin_mchid ?? '', serialNo = values.pay_weixin_serial_no ?? '';
    if (!isWechatMerchantId(mchId) || !isWechatMerchantCertificateSerial(serialNo)) throw new ValidateException('微信支付公开商户配置不完整');
    const apiV3Key = this.env.WECHAT_API_V3_KEY ?? '';
    if (new TextEncoder().encode(apiV3Key).byteLength !== 32) throw new ValidateException('微信支付 APIv3 密钥必须为 32 字节');
    const siteUrl = (values.site_url ?? '').replace(/\/$/, '');
    const refundNotifyUrl = this.env.WECHAT_REFUND_NOTIFY_URL ?? `${siteUrl}/api/pay/notify/wechat/refund`;
    assertCallbackUrl(refundNotifyUrl, '微信退款回调');
    return {
      mchId,
      serialNo,
      apiV3Key,
      privateKey,
      platformPublicKey,
      platformPublicKeyId: this.env.WECHAT_PLATFORM_PUBLIC_KEY_ID,
      refundNotifyUrl,
    };
  }
}

export class WechatApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`微信支付 ${code}: ${message}`);
    this.name = "WechatApiError";
  }
}

export function normalizeWechatRefundResponse(
  response: WechatRefundResponse,
  request: RefundProviderRequest,
): RefundProviderResult {
  if (
    response.out_refund_no !== request.outRefundNo ||
    response.out_trade_no !== request.outTradeNo ||
    (request.transactionId && response.transaction_id !== request.transactionId)
  ) {
    return { status: "UNKNOWN", message: "微信退款响应单号不匹配" };
  }
  if (
    response.amount?.refund !== request.refundAmount ||
    response.amount?.total !== request.totalAmount
  ) {
    return { status: "UNKNOWN", message: "微信退款响应金额不匹配" };
  }
  return {
    status: normalizeWechatStatus(response.status ?? "UNKNOWN"),
    providerRefundId: response.refund_id,
    successTime: parseProviderTime(response.success_time),
    message: response.message,
  };
}

function normalizeWechatStatus(status: string): RefundProviderStatus {
  if (["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"].includes(status)) {
    return status as RefundProviderStatus;
  }
  return "UNKNOWN";
}

function validateRefundRequest(request: RefundProviderRequest): void {
  if (!request.outTradeNo || !request.outRefundNo) throw new ValidateException("微信退款单号无效");
  if (
    !Number.isSafeInteger(request.refundAmount) ||
    !Number.isSafeInteger(request.totalAmount) ||
    request.refundAmount <= 0 ||
    request.totalAmount <= 0 ||
    request.refundAmount > request.totalAmount
  ) {
    throw new ValidateException("微信退款金额无效");
  }
}

function parseProviderTime(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}

function emptyTradeQueryResult(
  request: PaymentProviderQueryRequest,
  status: PaymentProviderQueryResult["status"],
  providerTradeState: string,
  errorCode: string,
): PaymentProviderQueryResult {
  return {
    status,
    providerTradeState: /^[A-Z0-9_.:-]{1,32}$/.test(providerTradeState)
      ? providerTradeState
      : "UNKNOWN",
    orderNo: request.orderNo,
    transactionId: "",
    amountCents: 0,
    currency: "CNY",
    providerEventTime: 0,
    errorCode,
  };
}

function assertCallbackUrl(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
    if (url.search || url.hash) throw new Error();
  } catch {
    throw new ValidateException(`${label}地址无效`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
