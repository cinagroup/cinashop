import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { ValidateException } from "@/utils/errors";

export type CheckoutPaymentMethod = "yue" | "weixin" | "alipay" | "offline";

export interface PaymentMethodReadiness {
  enabled: boolean;
  reason: string;
}

export type PaymentReadiness = Record<CheckoutPaymentMethod, PaymentMethodReadiness>;

const PAYMENT_CONFIG_KEYS = [
  "ali_pay_status",
  "balance_func_status",
  "offline_pay_status",
  "pay_weixin_mchid",
  "pay_weixin_open",
  "pay_weixin_serial_no",
  "site_url",
  "wechat_appid",
  "yue_pay_status",
] as const;

function disabled(reason: string): PaymentMethodReadiness {
  return { enabled: false, reason };
}

function enabled(): PaymentMethodReadiness {
  return { enabled: true, reason: "" };
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve the effective payment surface. A database switch alone is not
 * enough: external methods are exposed only when their callback and secret
 * material are also complete in the current Worker deployment.
 */
export async function getPaymentReadiness(
  container: Container,
  env: Env,
): Promise<PaymentReadiness> {
  const config = await new SystemConfigService(container, env).getMany([...PAYMENT_CONFIG_KEYS]);

  const yue = config.balance_func_status === "1" && config.yue_pay_status === "1"
    ? enabled()
    : disabled("余额支付未开启");

  let weixin = disabled("微信支付未开启");
  if (config.pay_weixin_open === "1") {
    const publicConfigReady = Boolean(
      config.wechat_appid
      && config.pay_weixin_mchid
      && config.pay_weixin_serial_no
      && isHttpsUrl(config.site_url),
    );
    const secretConfigReady = Boolean(
      env.WECHAT_MCH_PRIVATE_KEY
      && env.WECHAT_API_V3_KEY
      && new TextEncoder().encode(env.WECHAT_API_V3_KEY).byteLength === 32
      && (env.WECHAT_PLATFORM_PUBLIC_KEY ?? env.WECHAT_PLATFORM_CERT)?.includes("BEGIN PUBLIC KEY"),
    );
    weixin = publicConfigReady && secretConfigReady
      ? enabled()
      : disabled("微信支付商户配置未完成");
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
    yue,
    weixin,
    alipay,
    offline: config.offline_pay_status === "1"
      ? enabled()
      : disabled("线下支付未开启"),
  };
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
