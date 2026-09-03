import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import type { WechatPaymentProfile } from "@/services/payment/WechatPaymentIdentity";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { ValidateException } from "@/utils/errors";

export type CheckoutPaymentMethod = "yue" | "weixin" | "alipay" | "offline";

export interface PaymentMethodReadiness {
  enabled: boolean;
  reason: string;
}

export type PaymentReadiness = Record<CheckoutPaymentMethod, PaymentMethodReadiness>;
export type WechatProfileReadiness = Record<WechatPaymentProfile, PaymentMethodReadiness>;

export interface PaymentReadinessSnapshot {
  methods: PaymentReadiness;
  wechatProfiles: WechatProfileReadiness;
}

export const WECHAT_PAYMENT_PROFILE_APP_ID_KEYS = {
  wechat: "wechat_appid",
  routine: "routine_appId",
  app: "wechat_app_appid",
} as const satisfies Record<WechatPaymentProfile, string>;

const WECHAT_PAYMENT_PROFILE_LABELS = {
  wechat: "公众号/H5/PC",
  routine: "小程序",
  app: "App",
} as const satisfies Record<WechatPaymentProfile, string>;

const PAYMENT_CONFIG_KEYS = [
  "ali_pay_status",
  "balance_func_status",
  "offline_pay_status",
  "pay_weixin_mchid",
  "pay_weixin_open",
  "pay_weixin_serial_no",
  "routine_appId",
  "site_url",
  "wechat_app_appid",
  "wechat_appid",
  "yue_pay_status",
] as const;

type PaymentConfigKey = (typeof PAYMENT_CONFIG_KEYS)[number];
type PaymentConfig = Partial<Record<PaymentConfigKey, string>>;
type PaymentRuntimeEnv = Pick<
  Env,
  | "WECHAT_MCH_PRIVATE_KEY"
  | "WECHAT_API_V3_KEY"
  | "WECHAT_PLATFORM_PUBLIC_KEY"
  | "WECHAT_PLATFORM_CERT"
  | "ALIPAY_APP_ID"
  | "ALIPAY_PRIVATE_KEY"
  | "ALIPAY_PUBLIC_KEY"
  | "ALIPAY_SELLER_ID"
  | "ALIPAY_NOTIFY_URL"
  | "ALIPAY_RETURN_URL"
>;

function disabled(reason: string): PaymentMethodReadiness {
  return { enabled: false, reason };
}

function enabled(): PaymentMethodReadiness {
  return { enabled: true, reason: "" };
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** WeChat Pay API v3 direct-merchant number: decimal string, at most 32 characters. */
export function isWechatMerchantId(value: string | undefined): boolean {
  return /^\d{1,32}$/.test(value ?? "");
}

/** Merchant API certificate serial used in request Authorization; this is not certificate content. */
export function isWechatMerchantCertificateSerial(value: string | undefined): boolean {
  return /^[A-F0-9]{1,64}$/i.test(value ?? "");
}

function isWechatAppId(value: string | undefined): boolean {
  return Boolean(value && value.length <= 32);
}

function hasWechatDeploymentCredentials(env: PaymentRuntimeEnv): boolean {
  const platformPublicKey = env.WECHAT_PLATFORM_PUBLIC_KEY ?? env.WECHAT_PLATFORM_CERT;
  return Boolean(
    env.WECHAT_MCH_PRIVATE_KEY
    && env.WECHAT_API_V3_KEY
    && new TextEncoder().encode(env.WECHAT_API_V3_KEY).byteLength === 32
    && platformPublicKey?.includes("BEGIN PUBLIC KEY"),
  );
}

/**
 * Evaluate effective payment readiness without exposing credential values.
 * All WeChat profiles share one APIv3 merchant credential set; only AppID differs.
 * The legacy pay_routine_mchid/pay_routine_open branch is intentionally retired.
 */
export function evaluatePaymentReadiness(
  config: PaymentConfig,
  env: PaymentRuntimeEnv,
): PaymentReadinessSnapshot {
  const yue = config.balance_func_status === "1" && config.yue_pay_status === "1"
    ? enabled()
    : disabled("余额支付未开启");

  const wechatOpen = config.pay_weixin_open === "1";
  const publicMerchantReady = Boolean(
    isWechatMerchantId(config.pay_weixin_mchid)
    && isWechatMerchantCertificateSerial(config.pay_weixin_serial_no)
    && isHttpsUrl(config.site_url),
  );
  const deploymentCredentialsReady = hasWechatDeploymentCredentials(env);
  const wechatProfiles = Object.fromEntries(
    (Object.keys(WECHAT_PAYMENT_PROFILE_APP_ID_KEYS) as WechatPaymentProfile[]).map((profile) => {
      let state = disabled("微信支付未开启");
      if (wechatOpen) {
        if (!publicMerchantReady) {
          state = disabled("微信支付公开商户配置未完成");
        } else if (!deploymentCredentialsReady) {
          state = disabled("微信支付部署凭据未完成");
        } else if (!isWechatAppId(config[WECHAT_PAYMENT_PROFILE_APP_ID_KEYS[profile]])) {
          state = disabled(`${WECHAT_PAYMENT_PROFILE_LABELS[profile]} AppID 未配置`);
        } else {
          state = enabled();
        }
      }
      return [profile, state];
    }),
  ) as WechatProfileReadiness;

  let weixin = disabled("微信支付未开启");
  if (wechatOpen) {
    if (!publicMerchantReady) {
      weixin = disabled("微信支付公开商户配置未完成");
    } else if (!deploymentCredentialsReady) {
      weixin = disabled("微信支付部署凭据未完成");
    } else if (Object.values(wechatProfiles).some((profile) => profile.enabled)) {
      weixin = enabled();
    } else {
      weixin = disabled("微信支付渠道 AppID 未配置");
    }
  }

  let alipay = disabled("支付宝支付未开启");
  if (config.ali_pay_status === "1") {
    const ready = Boolean(
      env.ALIPAY_APP_ID
      && env.ALIPAY_PRIVATE_KEY
      && env.ALIPAY_PUBLIC_KEY
      && env.ALIPAY_SELLER_ID
      && isHttpsUrl(env.ALIPAY_NOTIFY_URL)
      && isHttpsUrl(env.ALIPAY_RETURN_URL),
    );
    alipay = ready ? enabled() : disabled("支付宝商户配置未完成");
  }

  return {
    methods: {
      yue,
      weixin,
      alipay,
      offline: config.offline_pay_status === "1"
        ? enabled()
        : disabled("线下支付未开启"),
    },
    wechatProfiles,
  };
}

export async function getPaymentReadinessSnapshot(
  container: Container,
  env: Env,
): Promise<PaymentReadinessSnapshot> {
  const config = await new SystemConfigService(container, env).getMany([...PAYMENT_CONFIG_KEYS]);
  return evaluatePaymentReadiness(config, env);
}

/** Resolve the cashier surface after database switches and deployment dependencies are combined. */
export async function getPaymentReadiness(
  container: Container,
  env: Env,
): Promise<PaymentReadiness> {
  return (await getPaymentReadinessSnapshot(container, env)).methods;
}

export async function assertPaymentMethodAvailable(
  container: Container,
  env: Env,
  method: CheckoutPaymentMethod,
): Promise<void> {
  const readiness = await getPaymentReadiness(container, env);
  if (!readiness[method].enabled) {
    throw new ValidateException(readiness[method].reason || "支付方式不可用");
  }
}

export async function assertWechatPaymentProfileAvailable(
  container: Container,
  env: Env,
  profile: WechatPaymentProfile,
): Promise<void> {
  const readiness = (await getPaymentReadinessSnapshot(container, env)).wechatProfiles[profile];
  if (!readiness.enabled) {
    throw new ValidateException(readiness.reason || "当前微信支付渠道不可用");
  }
}
