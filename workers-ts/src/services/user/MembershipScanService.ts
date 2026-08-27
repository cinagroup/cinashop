import qrcode from "qrcode-generator";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { WechatMiniProgramCodeService } from "@/services/wechat/WechatMiniProgramCodeService";
import { ValidateException } from "@/utils/errors";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function createQrSvgDataUrl(value: string): string {
  if (!value || value.length > 2_048) throw new ValidateException("会员激活地址无效或过长");
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;
}

export class MembershipScanService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async memberScan(): Promise<{
    wechat_img: string;
    wechat_url: string;
    routine: string;
    routine_status: "ready" | "not_configured" | "unavailable";
  }> {
    const siteUrlValue = await new SystemConfigService(this.container, this.env).get("site_url");
    const siteUrl = typeof siteUrlValue === "string" ? siteUrlValue.trim() : "";
    let base: URL;
    try {
      base = new URL(siteUrl);
    } catch {
      throw new ValidateException("站点地址 site_url 未正确配置");
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new ValidateException("站点地址 site_url 必须使用 HTTP 或 HTTPS");
    }
    base.pathname = `${base.pathname.replace(/\/$/, "")}/pages/annex/vip_active/index`;
    base.search = "";
    base.hash = "";
    const activationUrl = base.toString();

    let routine = "";
    let routineStatus: "ready" | "not_configured" | "unavailable" = "not_configured";
    try {
      routine = await new WechatMiniProgramCodeService(
        this.container,
        this.env,
      ).createMembershipActivationDataUrl() ?? "";
      routineStatus = routine ? "ready" : "not_configured";
    } catch (error) {
      console.error(JSON.stringify({
        event: "membership_activation_code_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      routineStatus = "unavailable";
    }

    return {
      wechat_img: createQrSvgDataUrl(activationUrl),
      wechat_url: activationUrl,
      routine,
      routine_status: routineStatus,
    };
  }
}
