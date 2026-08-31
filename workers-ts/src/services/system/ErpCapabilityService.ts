import type { Container } from "@/lib/di";
import {
  SystemConfigService,
  type SystemConfigEnv,
} from "@/services/system/SystemConfigService";

/**
 * Interpret the legacy ERP switch conservatively.
 *
 * CRMEB stores switch values as JSON scalars. Only the canonical enabled
 * representations are accepted so a missing or malformed value fails closed.
 */
export function parseErpCapabilityFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true";
}

export class ErpCapabilityService {
  constructor(
    private readonly container: Container,
    private readonly env: SystemConfigEnv,
  ) {}

  async getCapability(): Promise<{ open_erp: boolean }> {
    const value = await new SystemConfigService(this.container, this.env).get("erp_open");
    return { open_erp: parseErpCapabilityFlag(value) };
  }
}
