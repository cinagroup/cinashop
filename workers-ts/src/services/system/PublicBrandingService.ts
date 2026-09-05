import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { SystemConfigService } from "@/services/system/SystemConfigService";

const PUBLIC_BRANDING_KEYS = [
  "record_No",
  "site_name",
  "site_url",
  "site_logo",
  "site_logo_square",
  "login_logo",
  "admin_login_slide",
  "ico_path",
  "wechat_share_img",
  "wechat_share_title",
  "wechat_share_synopsis",
] as const;

function safeText(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function safeHttpsOrigin(value: string | undefined): string | null {
  try {
    const parsed = new URL(value ?? "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safeAssetReference(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || text.length > 2_048) return "";
  if (/^\/(?!\/)/.test(text)) return text;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? text : "";
  } catch {
    return "";
  }
}

function singleAsset(value: string | undefined): string {
  const text = value?.trim() ?? "";
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return safeAssetReference(parsed[0]);
    } catch {
      return "";
    }
  }
  return safeAssetReference(text);
}

function assetList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(safeAssetReference).filter(Boolean))].slice(0, 5);
  } catch {
    return [];
  }
}

function absoluteAsset(reference: string, requestOrigin: string, siteOrigin: string | null): string {
  if (!reference) return "";
  if (reference.startsWith("https://")) return reference;
  const base = reference.startsWith("/api/assets/") ? requestOrigin : (siteOrigin ?? requestOrigin);
  try {
    return new URL(reference, base).toString();
  } catch {
    return "";
  }
}

export class PublicBrandingService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async values() {
    return new SystemConfigService(this.container, this.env).getMany([...PUBLIC_BRANDING_KEYS]);
  }

  async siteConfig(requestOrigin: string) {
    const values = await this.values();
    const siteOrigin = safeHttpsOrigin(values.site_url);
    const rawAssets = [
      singleAsset(values.site_logo),
      singleAsset(values.site_logo_square),
      singleAsset(values.login_logo),
      singleAsset(values.ico_path),
      ...assetList(values.admin_login_slide),
    ];
    const signed = await signAttachmentReferences(this.env.APP_KEY, rawAssets);
    const publicAssets = signed.map((item) => absoluteAsset(item, requestOrigin, siteOrigin));
    return {
      record_No: safeText(values.record_No, 100),
      site_name: safeText(values.site_name, 100),
      site_logo: publicAssets[0] ?? "",
      site_logo_square: publicAssets[1] ?? "",
      login_logo: publicAssets[2] ?? "",
      ico_path: publicAssets[3] ?? "",
      admin_login_slide: publicAssets.slice(4, 9),
    };
  }

  async share(requestOrigin: string) {
    const values = await this.values();
    const siteOrigin = safeHttpsOrigin(values.site_url);
    const [signedImage = ""] = await signAttachmentReferences(
      this.env.APP_KEY,
      [singleAsset(values.wechat_share_img)],
    );
    return {
      img: absoluteAsset(signedImage, requestOrigin, siteOrigin),
      title: safeText(values.wechat_share_title, 100),
      synopsis: safeText(values.wechat_share_synopsis, 200),
    };
  }

  /** Legacy GET /api/wechat/get_logo with a fresh signature for canonical R2 assets. */
  async loginLogo(requestOrigin: string) {
    const values = await new SystemConfigService(this.container, this.env)
      .getMany(["site_url", "wap_login_logo"]);
    const siteOrigin = safeHttpsOrigin(values.site_url);
    const [signed = ""] = await signAttachmentReferences(
      this.env.APP_KEY,
      [singleAsset(values.wap_login_logo)],
    );
    return { logo_url: absoluteAsset(signed, requestOrigin, siteOrigin) };
  }
}
