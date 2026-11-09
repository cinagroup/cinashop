/** 微信支付 API v3：下单、回调验签、原路退款和退款查询。 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { consumeRechargeRefundQuery,type PreparedRechargeRefundQuery } from '@/services/payment/RechargeRefundQueryClaim';
import { parseRechargeRefundQueryResult,type RechargeRefundQueryAttempt,type RechargeRefundQueryProviderStatus } from '@/services/payment/RechargeRefundQueryCodec';
import { readRechargeRefundQueryAttemptTx } from '@/services/payment/RechargeRefundQueryHistory';
import { consumeRechargeRefundFirstRequest, parseRechargeRefundFirstRequest, rechargeRefundTransportApproval,
  type PreparedRechargeRefundFirstRequest, type RechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { authenticateRechargeRefundRecord, insertRechargeRefundEvidenceTx, readRechargeRefundOperationByIdTx,
  signRechargeRefundRecord, type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { readRechargeRoutineRefundAccountJournalTx } from '@/services/payment/RechargeRoutineRefundAccount';
import { requireRechargeRoutineRefundPurpose } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { captureRechargeRefundJson } from '@/services/payment/RechargeRefundJournalCodec';
import { routineCommittedMerchantMaterials } from '@/services/payment/RoutineApprovedPaymentAccount';
import { routineEvidenceCanonical } from '@/services/payment/RoutineProviderObservation';
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
import { attachRoutineProviderObservation, captureRoutineProviderObservation, routineProviderObservationOf } from '@/services/payment/RoutineProviderObservation';
import { prepareApprovedRoutineQuery, prepareApprovedRoutineNotify, routineApprovedAccountMaterials,
  assertPreparedRoutineAccount, attachRoutinePaymentAccountAuthorization } from '@/services/payment/RoutineApprovedPaymentAccount';
import { prepareRoutineRefundProvider,routineRefundPreparedMaterials,captureRoutineRefundResult,
  type PreparedRoutineRefund } from '@/services/payment/RoutineRefundProvider';
import { sameRoutineRefund } from '@/services/payment/RoutineRefundDispatch';

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
  appid?:string;
  mchid?:string;
  refund_id?: string;
  out_refund_no?: string;
  transaction_id?: string;
  out_trade_no?: string;
  status?: string;
  success_time?: string;
  amount?: { refund?: number; total?: number; currency?:string };
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
    approvedAccountId?: string,
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
    headers = { ...headers };
    if (approvedAccountId !== undefined && profile !== 'routine') throw new ValidateException('原账号回调渠道无效');
    const approved = approvedAccountId === undefined ? null : await prepareApprovedRoutineNotify(this.container, this.env, approvedAccountId);
    const materials = approved ? routineApprovedAccountMaterials(approved) : null;
    const approvedConfig: WechatPayConfig | undefined = materials ? { ...materials, mchId: materials.merchantId,
      notifyUrl: '', refundNotifyUrl: '' } : undefined;
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
    }>(headers, rawBody, "transaction", profile, approvedConfig);
    if (approved) await assertPreparedRoutineAccount(this.container, this.env, approved);
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
    if (profile === 'routine' && data.trade_state === 'SUCCESS'
      && (data.trade_type !== 'JSAPI' || typeof data.payer?.openid !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(data.payer.openid))) {
      throw new ValidateException('小程序付款回调交易类型或付款人不完整');
    }
    if (profile === 'app') {
      if (data.trade_type !== 'APP' || typeof data.appid !== 'string') throw new ValidateException('原生App回调交易类型无效');
      await recordNativeAppProviderEvidence(this.container, this.env, { source: 'callback', providerEventId: eventId,
        appId: data.appid, merchantId: cfg.mchId, orderNo: data.out_trade_no, transactionId: data.transaction_id,
        tradeState: data.trade_state, amountCents: Number(data.amount?.total), currency: 'CNY', providerEventTime: providerEventTime ?? 0, tradeType: 'APP' });
    }
    const result = {
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
    // Public merchant-only verification still works without APP_KEY when the
    // optional original-evidence addon is absent. Its installed ingress will
    // require this independent authenticated capture, never scalar identity.
    const verified = profile === 'routine' && data.trade_state === 'SUCCESS' && this.env.APP_KEY
      ? attachRoutineProviderObservation(result, captureRoutineProviderObservation(this.env, {
        source: 'callback', providerEventId: eventId, verifiedBody: rawBody,
        verifierKey: headers['wechatpay-serial'] ?? headers['Wechatpay-Serial'] ?? '',
        facts: { appId: data.appid!, merchantId: cfg.mchId, orderNo: data.out_trade_no,
          transactionId: data.transaction_id, amountCents: data.amount!.total!, currency: 'CNY',
          tradeState: 'SUCCESS', tradeType: 'JSAPI', payerId: data.payer!.openid!, providerEventTime: providerEventTime! },
      })) : result;
    return approved && data.trade_state === 'SUCCESS'
      ? attachRoutinePaymentAccountAuthorization(verified, this.env, approved, routineProviderObservationOf(verified)) : verified;
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

  /** Consumes the sole committed Admin request before signing. No second POST
   * can be obtained on any failure; only a verified response can mint a result. */
  async requestRechargeRefundFirst(admitted:PreparedRechargeRefundFirstRequest):Promise<VerifiedRechargeRefundFirstResult>{
    const signing={APP_KEY:this.env.APP_KEY};
    const {binding,materials,rootDb}=consumeRechargeRefundFirstRequest(this.env,admitted),p=binding.payload,q=p.request;
    if(rootDb!==this.container.db)return rechargeFirstUnavailable();
    const cfg:WechatPayConfig={...materials,mchId:materials.merchantId,notifyUrl:'',refundNotifyUrl:p.notifyUrl};
    const body={out_refund_no:q.outRefundNo,reason:q.reason,notify_url:p.notifyUrl,transaction_id:q.transactionId,
      amount:{refund:q.refundAmount,total:q.totalAmount,currency:'CNY'}};
    let captured:RechargeFirstVerifiedResponse|undefined;
    let result:RechargeFirstProviderResult;
    try{
      const response=await this.callApi<WechatRefundResponse>('POST','/v3/refund/domestic/refunds',body,cfg,true,
        (raw,serial,httpStatus)=>{captured={responseDigest:createHash('sha256').update(raw).digest('hex'),
          verifierKey:serial,httpStatus,observedAt:rechargeFirstNow()};},
        ()=>{
          const now=rechargeFirstNow();
          if(this.env.APP_KEY!==signing.APP_KEY||now<p.issuedAt-1||now>=admitted.expiresAt)rechargeFirstUnavailable();
          const a=p.approval;
          // Recheck after asynchronous RSA, immediately before fetch. No new
          // materials are substituted for the already signed original pair.
          routineCommittedMerchantMaterials(this.env,{appId:a.appId,merchantId:a.merchantId,credentialRef:a.credentialRef,
            credentialVersion:a.credentialVersion,credentialStamp:a.credentialStamp});
        });
      if(!captured)return rechargeFirstUnavailable();
      result=rechargeFirstResponseResult(binding,response,captured.observedAt);
    }catch(error){
      // A signed HTTP error is an UNKNOWN observation only. It never supplies
      // definitive rejection or releases a wallet reservation.
      if(!(error instanceof WechatApiError)||!captured||captured.httpStatus<400)throw error;
      result={status:'UNKNOWN',providerRefundId:'',successTime:0,
        errorCode:/^[A-Za-z0-9._:-]{1,128}$/u.test(error.code)?error.code:''};
    }
    if(!captured||captured.verifierKey!==materials.platformPublicKeyId)rechargeFirstUnavailable();
    const evidence=captureRechargeRefundJson({format:1,purpose:'recharge-refund-first-provider-result-v1',scope:p.scope,
      operationSignature:p.operationSignature,attemptSignature:binding.attempt.signature,requestHash:binding.attempt.request_hash,
      approval:p.approval,request:p.request,result,verification:captured});
    const row=signRechargeRefundRecord(signing,p.scope,'recharge_refund_result',{
      result_id:randomUUID(),operation_id:p.operationId,attempt_id:binding.attempt.attempt_id,source:'request',
      source_id:binding.attempt.attempt_id,status:result.status,evidence,created_at:captured.observedAt,caused_by_result_id:null});
    const token=Object.freeze({operationId:p.operationId,attemptId:String(binding.attempt.attempt_id),status:result.status,
      [rechargeFirstVerifiedBrand]:true as const});
    rechargeFirstVerified.set(token,{binding,signing,row,owner:this,root:this.container.db});return token;
  }

  /** Independent evidence COMMIT. Deadlines/current wallet/source/credentials
   * do not invalidate an already authenticated external observation. */
  async persistRechargeRefundFirstResult(token:VerifiedRechargeRefundFirstResult):Promise<RechargeRefundProviderReceipt>{
    const retained=token&&typeof token==='object'?rechargeFirstVerified.get(token):undefined;
    if(!retained||retained.owner!==this||retained.root!==this.container.db)return rechargeFirstUnavailable();
    if(retained.receipt)return retained.receipt;
    if(retained.inFlight)return retained.inFlight;
    const running=persistRechargeFirstResult(this.container.db,retained);
    retained.inFlight=running;
    try{
      const receipt=await running;retained.receipt=receipt;return receipt;
    }finally{
      // The verified entry is deliberately retained after every failure. The
      // same ID/observedAt retries a failed or ambiguously acknowledged COMMIT.
      if(retained.inFlight===running)retained.inFlight=undefined;
    }
  }

  /** Exactly one GET handoff, consumed before RSA/fetch. No SQL is open. */
  async queryRechargeRefund(admitted:PreparedRechargeRefundQuery):Promise<VerifiedRechargeRefundQueryResult>{
    const signing={APP_KEY:this.env.APP_KEY};
    const {binding,materials,rootDb,role}=consumeRechargeRefundQuery(this.container.db,this.env,admitted.role,admitted);
    if(rootDb!==this.container.db)return rechargeFirstUnavailable();
    const p=binding.payload,cfg:WechatPayConfig={...materials,mchId:materials.merchantId,notifyUrl:'',refundNotifyUrl:binding.firstRequest.notifyUrl};
    let captured:RechargeFirstVerifiedResponse|undefined,result:RechargeQueryProviderResult;
    try{
      const response=await this.callApi<WechatRefundResponse>('GET',p.request.path,undefined,cfg,true,
        (raw,serial,httpStatus)=>{captured={responseDigest:createHash('sha256').update(raw).digest('hex'),verifierKey:serial,httpStatus,observedAt:rechargeFirstNow()};},
        ()=>{
          const now=rechargeFirstNow(),a=p.approval;
          if(this.env.APP_KEY!==signing.APP_KEY||now<p.issuedAt-1||now>=admitted.expiresAt)return rechargeFirstUnavailable();
          routineCommittedMerchantMaterials(this.env,{appId:a.appId,merchantId:a.merchantId,credentialRef:a.credentialRef,
            credentialVersion:a.credentialVersion,credentialStamp:a.credentialStamp});
        });
      if(!captured)return rechargeFirstUnavailable();result=rechargeQueryResponseResult(binding,response,captured.observedAt);
    }catch(error){
      if(!(error instanceof WechatApiError)||!captured||captured.httpStatus<400||captured.httpStatus>599)throw error;
      const notFound=captured.httpStatus===404&&error.code==='RESOURCE_NOT_EXISTS';
      result={status:notFound?'NOT_FOUND':'UNKNOWN',providerRefundId:'',successTime:0,
        errorCode:/^[A-Za-z0-9._:-]{1,128}$/u.test(error.code)?error.code:''};
    }
    if(!captured||captured.verifierKey!==materials.platformPublicKeyId)return rechargeFirstUnavailable();
    const evidence=captureRechargeRefundJson({format:1,purpose:'recharge-refund-query-provider-result-v1',scope:p.scope,
      operationSignature:p.operationSignature,firstAttemptId:p.firstAttemptId,firstAttemptSignature:p.firstAttemptSignature,
      firstRequestHash:p.firstRequestHash,queryAttemptSignature:binding.attempt.signature,requestHash:binding.attempt.request_hash,
      approval:p.approval,original:p.original,request:p.request,result,verification:captured});
    const row=signRechargeRefundRecord(signing,p.scope,'recharge_refund_result',{result_id:randomUUID(),operation_id:p.operationId,
      attempt_id:binding.attempt.attempt_id,source:'query',source_id:binding.attempt.attempt_id,status:result.status,evidence,
      created_at:captured.observedAt,caused_by_result_id:null});
    const parsed=parseRechargeRefundQueryResult(signing,p.scope,binding.operation,binding.firstAttempt,binding.firstApproval,
      binding.attempt,binding.approval,row);
    const token=Object.freeze({operationId:p.operationId,attemptId:String(binding.attempt.attempt_id),status:parsed.observation.status,
      [rechargeQueryVerifiedBrand]:true as const});
    rechargeQueryVerified.set(token,{binding,signing,row:parsed.record,owner:this,root:this.container.db,role});return token;
  }

  /** Retain verified truth independently of mutable state, actor, lease or live credentials. */
  async persistRechargeRefundQueryResult(token:VerifiedRechargeRefundQueryResult):Promise<RechargeRefundQueryProviderReceipt>{
    const retained=token&&typeof token==='object'?rechargeQueryVerified.get(token):undefined;
    if(!retained||retained.owner!==this||retained.root!==this.container.db)return rechargeFirstUnavailable();
    if(retained.receipt)return retained.receipt;if(retained.inFlight)return retained.inFlight;
    const running=persistRechargeQueryResult(this.container.db,retained);retained.inFlight=running;
    try{const receipt=await running;retained.receipt=receipt;return receipt;}
    finally{if(retained.inFlight===running)retained.inFlight=undefined;}
  }

  /** Historical Routine uses one authenticated first dispatch, never current
   * merchant configuration or a trial across the archive. SQL closes before I/O. */
  async requestRoutineRefund(dispatchId:string,request:RefundProviderRequest):Promise<RefundProviderResult>{
    request={...request};
    const p=await prepareRoutineRefundProvider(this.container,this.env,dispatchId,'request');
    if(!sameRoutineRefund(request,p.dispatch.payload.request))throw new ValidateException('原账号退款请求与首次受理不一致');
    const cfg=this.routineRefundConfig(p),q=p.dispatch.payload.request;
    const body={out_refund_no:q.outRefundNo,reason:q.reason.slice(0,80),notify_url:p.dispatch.payload.notifyUrl,
      transaction_id:q.transactionId,amount:{refund:q.refundAmount,total:q.totalAmount,currency:'CNY'}};
    let verified:{body:string;serial:string;status:number}|undefined;
    const response=await this.callApi<WechatRefundResponse>('POST','/v3/refund/domestic/refunds',body,cfg,true,
      (body,serial,status)=>{verified={body,serial,status};});
    if(!verified)throw new ValidateException('原账号退款响应缺少验签记录');
    return this.routineRefundResponse(p,response,verified);
  }

  async queryRoutineRefund(dispatchId:string,request:RefundProviderRequest):Promise<RefundProviderResult>{
    request={...request};
    const p=await prepareRoutineRefundProvider(this.container,this.env,dispatchId,'query');
    if(!sameRoutineRefund(request,p.dispatch.payload.request))throw new ValidateException('原账号退款查单与首次受理不一致');
    const cfg=this.routineRefundConfig(p);let verified:{body:string;serial:string;status:number}|undefined;
    try{
      const response=await this.callApi<WechatRefundResponse>('GET',`/v3/refund/domestic/refunds/${encodeURIComponent(request.outRefundNo)}`,
        undefined,cfg,true,(body,serial,status)=>{verified={body,serial,status};});
      if(!verified)throw new ValidateException('原账号退款查单缺少验签记录');
      return this.routineRefundResponse(p,response,verified);
    }catch(error){
      if(error instanceof WechatApiError&&error.httpStatus===404&&error.code==='RESOURCE_NOT_EXISTS'&&verified?.status===404){
        return captureRoutineRefundResult(this.env,p,{result:{status:'NOT_FOUND'},verifiedBody:verified.body,
          verifierKey:verified.serial,httpStatus:404});
      }throw error;
    }
  }

  private routineRefundConfig(p:PreparedRoutineRefund):WechatPayConfig{
    const m=routineRefundPreparedMaterials(this.env,p);return{...m,mchId:m.merchantId,notifyUrl:'',refundNotifyUrl:p.dispatch.payload.notifyUrl};
  }

  private routineRefundResponse(p:PreparedRoutineRefund,response:WechatRefundResponse,verified:{body:string;serial:string;status:number}):RefundProviderResult{
    const result=normalizeWechatRefundResponse(response,p.dispatch.payload.request);
    if(response.mchid!==undefined&&response.mchid!==p.dispatch.payload.approval.merchantId
      ||response.amount?.currency!=='CNY'||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL'].includes(result.status))
      throw new ValidateException('原账号退款响应业务字段或币种不匹配');
    return captureRoutineRefundResult(this.env,p,{result,verifiedBody:verified.body,verifierKey:verified.serial,httpStatus:verified.status});
  }

  async verifyAndParseRoutineRefundNotify(dispatchId:string,headers:Record<string,string>,rawBody:string):Promise<RefundProviderResult>{
    headers={...headers};
    const p=await prepareRoutineRefundProvider(this.container,this.env,dispatchId,'callback'),cfg=this.routineRefundConfig(p);
    const {data,eventId}=await this.verifyAndDecryptNotify<{mchid?:string;out_trade_no?:string;transaction_id?:string;
      out_refund_no?:string;refund_id?:string;refund_status?:string;success_time?:string;amount?:{total?:number;refund?:number}}>
      (headers,rawBody,'refund','routine',cfg);
    const q=p.dispatch.payload.request,event=JSON.parse(rawBody) as {event_type?:unknown};
    if(data.mchid!==cfg.mchId||data.out_trade_no!==q.outTradeNo||data.transaction_id!==q.transactionId
      ||data.out_refund_no!==q.outRefundNo||data.amount?.refund!==q.refundAmount||data.amount?.total!==q.totalAmount
      ||!['SUCCESS','CLOSED','ABNORMAL'].includes(data.refund_status??'')||event.event_type!=='REFUND.'+data.refund_status)
      throw new ValidateException('原账号退款回调与首次受理记录不匹配');
    return captureRoutineRefundResult(this.env,p,{result:{status:normalizeWechatStatus(data.refund_status!),
      providerRefundId:data.refund_id,successTime:parseProviderTime(data.success_time)},verifiedBody:rawBody,
      verifierKey:headers['wechatpay-serial'],httpStatus:200,eventId});
  }

  async queryOrder(request: PaymentProviderQueryRequest, original?: PaymentQueryOriginalIdentity): Promise<PaymentProviderQueryResult> {
    if (request.provider !== "wechat" || !["wechat", "routine", "app"].includes(request.profile)) {
      throw new ValidateException("微信支付查单渠道无效");
    }
    request = { ...request };
    original = original ? { ...original } : undefined;
    validatePaymentQueryIdentity(request, original);
    const approved = await prepareApprovedRoutineQuery(this.container, this.env, request);
    const materials = approved ? routineApprovedAccountMaterials(approved) : null;
    const cfg: WechatPayConfig = materials ? { ...materials, mchId: materials.merchantId, notifyUrl: '', refundNotifyUrl: '' }
      : await this.getConfig(request.profile as WechatPayProfile, false, undefined, true);
    assertPaymentQueryCredentialIdentity(original, cfg.appId, cfg.mchId);
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(request.orderNo)}`
      + `?mchid=${encodeURIComponent(cfg.mchId)}`;
    let response: WechatTradeQueryResponse;
    let verifiedResponse: { body: string; serial: string } | undefined;
    try {
      response = await this.callApi<WechatTradeQueryResponse>("GET", path, undefined, cfg, true,
        (body, serial) => { verifiedResponse = { body, serial }; });
    } catch (error) {
      if (
        error instanceof WechatApiError
        && ["ORDER_NOT_EXIST", "RESOURCE_NOT_EXISTS"].includes(error.code)
      ) {
        return emptyTradeQueryResult(request, "NOT_FOUND", "NOTPAY", "provider_trade_not_found");
      }
      throw error;
    } finally {
      if (approved) await assertPreparedRoutineAccount(this.container, this.env, approved);
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
    const rejected = (): PaymentProviderQueryResult => ({
      ...emptyTradeQueryResult(request, 'UNKNOWN', providerTradeState, 'provider_evidence_mismatch'),
      transactionId, amountCents, providerEventTime,
    });
    const completeFacts = /^[A-Za-z0-9_-]{1,100}$/u.test(transactionId)
      && Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= 2147483647
      && response.amount?.currency === 'CNY' && providerEventTime > 0
      && (request.profile !== 'routine' || response.trade_type === 'JSAPI'
        && typeof response.payer?.openid === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(response.payer.openid))
      && (request.profile !== 'app' || response.trade_type === 'APP');
    if (!completeFacts) return rejected();
    const captured = (result: PaymentProviderQueryResult): PaymentProviderQueryResult => {
      if (request.profile === 'routine' && this.env.APP_KEY) {
        if (!verifiedResponse) throw Error('routine_query_verification_capture_missing');
        attachRoutineProviderObservation(result, captureRoutineProviderObservation(this.env, {
          source: 'signed_query', verifiedBody: verifiedResponse.body, verifierKey: verifiedResponse.serial,
          facts: { appId: response.appid!, merchantId: cfg.mchId, orderNo: request.orderNo, transactionId,
            amountCents, currency: 'CNY', tradeState: 'SUCCESS', tradeType: 'JSAPI',
            payerId: response.payer!.openid!, providerEventTime },
        }));
        if (approved) attachRoutinePaymentAccountAuthorization(result, this.env, approved, routineProviderObservationOf(result));
      }
      return result;
    };
    // Complete, genuine provider facts survive a local amount/payer conflict;
    // their capture does not authorize settlement of that conflicting order.
    if (amountCents !== request.expectedAmountCents || original && (transactionId.length > 50
      || response.trade_type !== (original.transactionType === 'jsapi' ? 'JSAPI' : 'MWEB')
      || original.payerId !== '' && response.payer?.openid !== original.payerId)) return captured(rejected());
    const nativeAppEvidenceId = request.profile === 'app' ? await recordNativeAppProviderEvidence(this.container, this.env, {
      source: 'signed_query', appId: response.appid!, merchantId: cfg.mchId, orderNo: request.orderNo, transactionId,
      tradeState: providerTradeState, amountCents, currency: 'CNY', providerEventTime, tradeType: 'APP',
    }) : undefined;
    return captured({
      status: 'SUCCESS', providerTradeState, orderNo: request.orderNo, transactionId,
      amountCents, currency: 'CNY', providerEventTime, errorCode: '',
      ...(nativeAppEvidenceId ? { nativeAppEvidenceId } : {}),
      ...(original ? { identityEvidence: { source: 'wechat-signed-query' as const,
        appId: response.appid, merchantId: response.mchid,
        ...(original.payerId ? { payerId: response.payer?.openid } : {}) } } : {}),
    });
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
    expectedOriginalType: 'transaction', profile: WechatPayProfile, approvedConfig?: WechatPayConfig): Promise<{ data: T; cfg: WechatPayConfig; eventId: string }>;
  private verifyAndDecryptNotify<T>(headers: Record<string, string>, rawBody: string,
    expectedOriginalType: 'refund', profile: WechatPayProfile, approvedConfig?:WechatPayConfig): Promise<{ data: T; cfg: WechatMerchantConfig; eventId: string }>;
  private async verifyAndDecryptNotify<T>(
    headers: Record<string, string>,
    rawBody: string,
    expectedOriginalType: "transaction" | "refund",
    profile: WechatPayProfile,
    approvedConfig?: WechatPayConfig,
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

    const cfg = approvedConfig ?? (expectedOriginalType === 'refund' ? await this.getRefundConfig() : await this.getConfig(profile, false, undefined, true));
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
    captureVerified?: (body: string, serial: string,status:number) => void,
    beforeFetch?: () => void,
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

    beforeFetch?.();
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
    // Negative observations are exposed only when the caller explicitly asked
    // for error RSA verification. Unsigned 404 never becomes retry authority.
    if(response.ok||verifyErrorResponse)captureVerified?.(rawBody,response.headers.get('Wechatpay-Serial')??'',response.status);
    if (!response.ok) {
      throw new WechatApiError(
        typeof result.code === "string" ? result.code : `HTTP_${response.status}`,
        typeof result.message === "string" ? result.message : response.statusText,
        response.status,
      );
    }
    // This observer runs only for a successfully verified, bounded response.
    // It retains no signature/raw body outside the request-local query scope.
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
    readonly httpStatus?:number,
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

/** Private recharge-only transport attestation. No constructor/capture helper
 * is exported; only the real verified first-POST path can populate this map. */
const rechargeFirstVerifiedBrand:unique symbol=Symbol('recharge-refund-verified-first-response');
export interface VerifiedRechargeRefundFirstResult{
  readonly operationId:string;readonly attemptId:string;
  readonly status:'SUCCESS'|'PROCESSING'|'CLOSED'|'ABNORMAL'|'UNKNOWN';
  readonly [rechargeFirstVerifiedBrand]:true;
}
export interface RechargeRefundProviderReceipt{
  readonly operationId:string;readonly attemptId:string;readonly resultId:string;
  readonly status:VerifiedRechargeRefundFirstResult['status'];readonly signature:string;readonly replayed:boolean;
}
interface RechargeFirstVerifiedResponse{responseDigest:string;verifierKey:string;httpStatus:number;observedAt:number}
interface RechargeFirstProviderResult{
  status:VerifiedRechargeRefundFirstResult['status'];providerRefundId:string;successTime:number;errorCode:string;
}
interface RechargeFirstRetained{
  binding:RechargeRefundFirstRequest;signing:Pick<Env,'APP_KEY'>;row:RechargeRefundRecord;
  owner:WechatPayService;root:DbClient;
  inFlight?:Promise<RechargeRefundProviderReceipt>;receipt?:RechargeRefundProviderReceipt;
}
const rechargeFirstVerified=new WeakMap<object,RechargeFirstRetained>();
function rechargeFirstUnavailable():never{throw new ValidateException('充值退款渠道证据暂不可核对，请保留原操作并查询');}
function rechargeFirstNow(){
  const now=Math.floor(Date.now()/1000);
  if(!Number.isSafeInteger(now)||now<1||now>2147483647)return rechargeFirstUnavailable();return now;
}
function rechargeFirstSame(a:unknown,b:unknown){return routineEvidenceCanonical(a)===routineEvidenceCanonical(b);}
function rechargeFirstResponseResult(binding:RechargeRefundFirstRequest,response:WechatRefundResponse,observedAt:number):RechargeFirstProviderResult{
  const p=binding.payload,q=p.request,status=response.status;
  if(response.out_trade_no!==q.outTradeNo||response.transaction_id!==q.transactionId||response.out_refund_no!==q.outRefundNo
    ||response.amount?.refund!==q.refundAmount||response.amount.total!==q.totalAmount||response.amount.currency!=='CNY'
    ||response.mchid!==undefined&&response.mchid!==p.approval.merchantId
    ||response.appid!==undefined&&response.appid!==p.approval.appId
    ||typeof response.refund_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(response.refund_id)
    ||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL'].includes(status??''))return rechargeFirstUnavailable();
  let successTime=0;
  if(status==='SUCCESS'){
    if(typeof response.success_time!=='string'
      ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(response.success_time))return rechargeFirstUnavailable();
    successTime=Math.floor(Date.parse(response.success_time)/1000);
    if(!Number.isSafeInteger(successTime)||successTime<1||successTime>2147483647
      ||successTime<p.issuedAt-300||successTime>observedAt+300)return rechargeFirstUnavailable();
  }
  return{status:status as RechargeFirstProviderResult['status'],providerRefundId:response.refund_id,successTime,errorCode:''};
}
async function persistRechargeFirstResult(root:DbClient,retained:RechargeFirstRetained):Promise<RechargeRefundProviderReceipt>{
  const client=Object.getOwnPropertyDescriptor(root,'$client');
  if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')return rechargeFirstUnavailable();
  const {binding,signing,row}=retained,p=binding.payload;
  return root.transaction(async raw=>{
    const tx=raw as unknown as DbClient;
    await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
    const scope=await assertRechargeRefundRuntimeTx(tx,'admin','write');
    if(!rechargeFirstSame(scope,p.scope))return rechargeFirstUnavailable();
    // This lock serializes evidence persistence, not provider sending. A hash
    // collision serializes unrelated attempts; database uniqueness still wins.
    const digest=createHash('sha256').update(String(binding.attempt.attempt_id)).digest('hex');
    await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731733,${Number.parseInt(digest.slice(0,8),16)|0}::integer)`);
    const operation=await readRechargeRefundOperationByIdTx(tx,signing,'admin',p.operationId,'write');
    const attempts=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt
      WHERE operation_id=${p.operationId}::uuid AND attempt_id=${binding.attempt.attempt_id}::uuid LIMIT 2`);
    if(attempts.length!==1)return rechargeFirstUnavailable();
    const parsed=parseRechargeRefundFirstRequest(signing,scope,operation,attempts[0]);
    if(!rechargeFirstSame(parsed,binding))return rechargeFirstUnavailable();
    const historical=await readRechargeRoutineRefundAccountJournalTx(tx,signing,p.approval.recordId,'admin','write');
    // Evaluate the historical purpose at the actual request's issuedAt; never
    // substitute latest policy, current credentials or a live original actor.
    requireRechargeRoutineRefundPurpose(historical,'refund_request',p.issuedAt);
    if(!rechargeFirstSame(rechargeRefundTransportApproval(historical),p.approval))return rechargeFirstUnavailable();
    const saved=await tx.execute(sql`SELECT * FROM public.recharge_refund_result
      WHERE (source='request' AND source_id=${binding.attempt.attempt_id})
        OR attempt_id=${binding.attempt.attempt_id}::uuid OR result_id=${row.result_id}::uuid LIMIT 3`);
    let result:RechargeRefundRecord;
    if(saved.length){
      if(saved.length!==1)return rechargeFirstUnavailable();
      result=authenticateRechargeRefundRecord(signing,scope,'recharge_refund_result',saved[0]);
      if(!rechargeFirstSame(result,row))return rechargeFirstUnavailable();
    }else{
      const {signature:_,...unsigned}=row;
      result=await insertRechargeRefundEvidenceTx(tx,signing,'admin','recharge_refund_result',unsigned);
      if(!rechargeFirstSame(result,row))return rechargeFirstUnavailable();
    }
    const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT
      pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
    if(deadline?.ready!==true)return rechargeFirstUnavailable();
    return Object.freeze({operationId:p.operationId,attemptId:String(binding.attempt.attempt_id),resultId:String(result.result_id),
      status:result.status as VerifiedRechargeRefundFirstResult['status'],signature:String(result.signature),replayed:saved.length===1});
  },{isolationLevel:'read committed',accessMode:'read write'});
}

/** Query-only private verifier entries. No caller rows/JSON can mint these. */
const rechargeQueryVerifiedBrand:unique symbol=Symbol('recharge-refund-verified-query-response');
export interface VerifiedRechargeRefundQueryResult{
  readonly operationId:string;readonly attemptId:string;readonly status:RechargeRefundQueryProviderStatus;
  readonly [rechargeQueryVerifiedBrand]:true;
}
export interface RechargeRefundQueryProviderReceipt{
  readonly operationId:string;readonly attemptId:string;readonly resultId:string;readonly status:RechargeRefundQueryProviderStatus;
  readonly signature:string;readonly replayed:boolean;
}
interface RechargeQueryProviderResult{
  status:RechargeRefundQueryProviderStatus;providerRefundId:string;successTime:number;errorCode:string;
}
interface RechargeQueryRetained{
  binding:RechargeRefundQueryAttempt;signing:Pick<Env,'APP_KEY'>;row:RechargeRefundRecord;
  owner:WechatPayService;root:DbClient;role:RechargeRefundRuntimeRole;
  inFlight?:Promise<RechargeRefundQueryProviderReceipt>;receipt?:RechargeRefundQueryProviderReceipt;
}
const rechargeQueryVerified=new WeakMap<object,RechargeQueryRetained>();
function rechargeQueryResponseResult(binding:RechargeRefundQueryAttempt,response:WechatRefundResponse,observedAt:number):RechargeQueryProviderResult{
  const p=binding.payload,q=p.original,status=response.status;
  if(response.out_trade_no!==q.outTradeNo||response.transaction_id!==q.transactionId||response.out_refund_no!==q.outRefundNo
    ||response.amount?.refund!==q.refundAmount||response.amount.total!==q.totalAmount||response.amount.currency!=='CNY'
    ||response.mchid!==undefined&&response.mchid!==p.approval.merchantId
    ||response.appid!==undefined&&response.appid!==p.approval.appId
    ||typeof response.refund_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(response.refund_id)
    ||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL'].includes(status??''))return rechargeFirstUnavailable();
  let successTime=0;
  if(status==='SUCCESS'){
    if(typeof response.success_time!=='string'
      ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(response.success_time))return rechargeFirstUnavailable();
    successTime=Math.floor(Date.parse(response.success_time)/1000);
    if(!Number.isSafeInteger(successTime)||successTime<1||successTime>2147483647
      ||successTime<p.firstIssuedAt-300||successTime>observedAt+300)return rechargeFirstUnavailable();
  }
  return{status:status as RechargeRefundQueryProviderStatus,providerRefundId:response.refund_id,successTime,errorCode:''};
}
async function persistRechargeQueryResult(root:DbClient,retained:RechargeQueryRetained):Promise<RechargeRefundQueryProviderReceipt>{
  const client=Object.getOwnPropertyDescriptor(root,'$client');
  if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')return rechargeFirstUnavailable();
  const {binding,signing,row,role}=retained,p=binding.payload;
  return root.transaction(async raw=>{
    const tx=raw as unknown as DbClient;await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
      pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
    const scope=await assertRechargeRefundRuntimeTx(tx,role,'write');
    if(!rechargeFirstSame(scope,p.scope))return rechargeFirstUnavailable();
    // One per-attempt persistence fence, shared namespace with first results.
    // No operation/state lock, source/hold/economic/current-policy dependency.
    const digest=createHash('sha256').update(String(binding.attempt.attempt_id)).digest('hex');
    await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(731733,${Number.parseInt(digest.slice(0,8),16)|0}::integer)`);
    const point=await readRechargeRefundQueryAttemptTx(tx,signing,role,p.operationId,binding.attempt.attempt_id,'write');
    if(!rechargeFirstSame(point,binding))return rechargeFirstUnavailable();
    const saved=await tx.execute(sql`SELECT * FROM public.recharge_refund_result
      WHERE (source='query' AND source_id=${binding.attempt.attempt_id})
        OR attempt_id=${binding.attempt.attempt_id}::uuid OR result_id=${row.result_id}::uuid LIMIT 3`);
    let result:RechargeRefundRecord;
    if(saved.length){
      if(saved.length!==1)return rechargeFirstUnavailable();
      result=authenticateRechargeRefundRecord(signing,point.scope,'recharge_refund_result',saved[0]);
      if(!rechargeFirstSame(result,row))return rechargeFirstUnavailable();
    }else{
      const {signature:_,...unsigned}=row;
      result=await insertRechargeRefundEvidenceTx(tx,signing,role,'recharge_refund_result',unsigned);
      if(!rechargeFirstSame(result,row))return rechargeFirstUnavailable();
    }
    const parsed=parseRechargeRefundQueryResult(signing,point.scope,point.operation,point.firstAttempt,point.firstApproval,
      point.attempt,point.approval,result);
    const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
      AND pg_catalog.current_setting('role')='none' AS ready`);
    if(deadline?.ready!==true)return rechargeFirstUnavailable();
    return Object.freeze({operationId:p.operationId,attemptId:String(point.attempt.attempt_id),resultId:String(parsed.record.result_id),
      status:parsed.observation.status,signature:String(parsed.record.signature),replayed:saved.length===1});
  },{isolationLevel:'read committed',accessMode:'read write'});
}
