import { and, desc, eq, inArray } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { expressCompany, notificationTemplate } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { parseConfigInteger } from "@/utils/config";
import { ValidateException } from "@/utils/errors";

const MAX_EXPRESS_COMPANIES = 500;

/** PHP config/template.php subscribe short IDs, returned with strtolower(event name). */
export const LEGACY_SUBSCRIBE_TEMPLATE_KEYS = {
  bind_spread_uid: "3801",
  order_pay_success: "1927",
  order_deliver_success: "1458",
  order_postage_success: "1128",
  order_take: "1481",
  order_refund: "1451",
  recharge_success: "755",
  integral_accout: "335",
  order_brokerage: "14403",
  bargain_success: "2727",
  pink_true: "3098",
  pink_status: "3353",
  user_extract: "1470",
  sign_remind_time: "25599",
} as const;

function boundedText(value: string | undefined, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, max);
}

function publicCustomerUrl(value: string | undefined): string {
  const text = boundedText(value, 2_048);
  if (!text) return "";
  if (/^\/(?!\/)/u.test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export class PublicBootstrapCompatibilityService {
  private readonly config: SystemConfigService;

  constructor(
    private readonly container: Container,
    env: Env,
  ) {
    this.config = new SystemConfigService(container, env);
  }

  async copyWords(): Promise<{ words: string }> {
    return { words: boundedText(await this.config.get("copy_words"), 10_000) };
  }

  async customerType(): Promise<{
    routine_contact_type: number;
    customer_type: number;
    customer_phone: string;
    customer_url: string;
    wechat_work_corpid: string;
    userInfo: never[];
  }> {
    const values = await this.config.getMany([
      "routine_contact_type",
      "customer_type",
      "customer_phone",
      "customer_url",
      "wechat_work_corpid",
    ]);
    return {
      routine_contact_type: parseConfigInteger(values.routine_contact_type, 0),
      customer_type: parseConfigInteger(values.customer_type, 0),
      customer_phone: boundedText(values.customer_phone, 64),
      customer_url: publicCustomerUrl(values.customer_url),
      wechat_work_corpid: boundedText(values.wechat_work_corpid, 128),
      userInfo: [],
    };
  }

  async subscriptionTemplateIds(): Promise<Record<keyof typeof LEGACY_SUBSCRIBE_TEMPLATE_KEYS, string | null>> {
    const shortIds = [...new Set(Object.values(LEGACY_SUBSCRIBE_TEMPLATE_KEYS))];
    const rows = await this.container.db
      .select({ id: notificationTemplate.id, mark: notificationTemplate.mark, tempid: notificationTemplate.tempid })
      .from(notificationTemplate)
      .where(and(
        eq(notificationTemplate.legacyType, 0),
        eq(notificationTemplate.status, 1),
        inArray(notificationTemplate.mark, shortIds),
      ))
      .orderBy(desc(notificationTemplate.id));
    const byShortId = new Map<string, string>();
    for (const row of rows) {
      const tempid = boundedText(row.tempid, 100);
      if (tempid && !byShortId.has(row.mark)) byShortId.set(row.mark, tempid);
    }
    return Object.fromEntries(
      Object.entries(LEGACY_SUBSCRIBE_TEMPLATE_KEYS)
        .map(([name, shortId]) => [name, byShortId.get(shortId) ?? null]),
    ) as Record<keyof typeof LEGACY_SUBSCRIBE_TEMPLATE_KEYS, string | null>;
  }

  async expressList(statusValue: unknown): Promise<Array<{ id: number; name: string; code: string }>> {
    const status = typeof statusValue === "string" ? statusValue.trim() : "";
    if (status && status !== "0" && status !== "1") {
      throw new ValidateException("快递公司状态错误");
    }
    const rows = await this.container.db
      .select({
        id: expressCompany.id,
        name: expressCompany.name,
        code: expressCompany.code,
      })
      .from(expressCompany)
      .where(and(
        eq(expressCompany.isShow, 1),
        status === "1" ? eq(expressCompany.status, 1) : undefined,
      ))
      .orderBy(desc(expressCompany.sort), desc(expressCompany.id))
      .limit(MAX_EXPRESS_COMPANIES + 1);
    if (rows.length > MAX_EXPRESS_COMPANIES) {
      throw new ValidateException("快递公司超过安全上限");
    }
    // PHP exposed partner/account/key fields here. No first-party caller uses them.
    return rows.map((row) => ({
      id: row.id,
      name: boundedText(row.name, 64),
      code: boundedText(row.code, 50),
    }));
  }
}
