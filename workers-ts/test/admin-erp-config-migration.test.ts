import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { adminErpConfig } from "@/controllers/api/v1/AdminController";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  ErpCapabilityService,
  parseErpCapabilityFlag,
} from "@/services/system/ErpCapabilityService";

describe("embedded admin ERP capability migration", () => {
  it("fails closed for missing and non-canonical switch values", () => {
    expect(parseErpCapabilityFlag(undefined)).toBe(false);
    expect(parseErpCapabilityFlag("")).toBe(false);
    expect(parseErpCapabilityFlag("0")).toBe(false);
    expect(parseErpCapabilityFlag("false")).toBe(false);
    expect(parseErpCapabilityFlag("enabled")).toBe(false);
    expect(parseErpCapabilityFlag("1")).toBe(true);
    expect(parseErpCapabilityFlag(" TRUE ")).toBe(true);
  });

  it("returns only the non-secret capability field from system configuration", async () => {
    const get = vi.fn().mockResolvedValue('"1"');
    const put = vi.fn();
    const systemConfigDao = { getValue: vi.fn() };
    const container = { systemConfigDao } as never;
    const env = {
      CONFIG_KV: { get, put, delete: vi.fn() },
    } as never;

    const result = await new ErpCapabilityService(container, env).getCapability();

    expect(result).toEqual({ open_erp: true });
    expect(Object.keys(result)).toEqual(["open_erp"]);
    expect(get).toHaveBeenCalledWith("cfg_erp_open");
    expect(systemConfigDao.getValue).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/token|secret|password|account/i);
  });

  it("treats an absent production setting as disabled and caches the empty scalar", async () => {
    const getValue = vi.fn().mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue(undefined);
    const result = await new ErpCapabilityService(
      { systemConfigDao: { getValue } } as never,
      {
        CONFIG_KV: {
          get: vi.fn().mockResolvedValue(null),
          put,
          delete: vi.fn(),
        },
      } as never,
    ).getCapability();

    expect(result).toEqual({ open_erp: false });
    expect(getValue).toHaveBeenCalledWith("erp_open");
    expect(put).toHaveBeenCalledWith("cfg_erp_open", "", { expirationTtl: 1_800 });
  });

  it("returns the PHP envelope with a private non-cacheable response", async () => {
    const header = vi.fn();
    const context = {
      env: {
        CONFIG_KV: {
          get: vi.fn().mockResolvedValue("1"),
          put: vi.fn(),
          delete: vi.fn(),
        },
      },
      get: (key: string) => key === "container"
        ? { systemConfigDao: { getValue: vi.fn() } }
        : undefined,
      header,
      json: (body: unknown) => Response.json(body),
    } as never;

    const response = await adminErpConfig(context);

    expect(header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    expect(await response.json()).toEqual({
      status: 200,
      msg: "ok",
      data: { open_erp: true },
    });
  });

  it("mounts the exact PHP route behind admin auth and config.view", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminController.ts", "utf8");
    expect(routes).toContain(
      'v1Routes.get("/admin/erp/config", adminAuth, AdminController.adminErpConfig)',
    );
    expect(requiredAdminPermission("GET", "/api/admin/erp/config")).toBe("config.view");
    expect(controller).toContain('c.header("Cache-Control", "private, no-store, max-age=0")');
    expect(controller).toContain("new ErpCapabilityService");
  });
});
