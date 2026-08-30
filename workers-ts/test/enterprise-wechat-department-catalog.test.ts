import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Container } from "../src/lib/di";
import { EnterpriseWechatCatalogService } from "../src/services/work/EnterpriseWechatCatalogService";

describe("Enterprise WeChat department current catalog", () => {
  it("returns only current rows supplied by the fenced ancestor-closure query", async () => {
    const current = [{
      corp_id: "ww0123456789abcdef",
      department_id: 7,
      name: "Engineering",
      name_en: "Engineering",
      parent_department_id: 1,
      sort_order: 4_294_967_295,
      leader_count: 2,
      create_time: 100,
      update_time: 200,
    }];
    const db = {
      execute: vi.fn(async () => current),
    };
    const service = new EnterpriseWechatCatalogService(
      { db } as unknown as Container,
      { WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY: "verified" },
    );

    await expect(service.departments({ corp_id: "ww0123456789abcdef" }))
      .resolves.toMatchObject({
        list: [{
          id: 7,
          department_id: 7,
          parentid: 1,
          srot: 4_294_967_295,
          department_leader_count: 2,
        }],
        count: 1,
        catalog_authority: "enterprise_wechat_department_current",
      });
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("fails closed in one statement even if a blocked sentinel carries legacy-looking fields", async () => {
    const db = {
      select: vi.fn(),
      execute: vi.fn(async () => [{
        blocked_current_rows: 1,
        id: 99,
        corp_id: "must-not-leak",
        department_id: 99,
        name: "Legacy must not leak",
      }]),
    };
    const service = new EnterpriseWechatCatalogService({ db } as unknown as Container);

    await expect(service.departments({})).resolves.toEqual({
      list: [],
      count: 0,
      truncated: false,
      blocked_current_rows: 1,
      catalog_authority: "department_current_authority_disabled",
      remote_write_authority: "not_migrated_requires_idempotent_outbox",
      pii_display: "masked",
    });
    expect(db.execute).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns scoped legacy rows from the same authority-off statement snapshot", async () => {
    const db = {
      select: vi.fn(),
      execute: vi.fn(async () => [{
        blocked_current_rows: 0,
        id: 7,
        corp_id: "ww0123456789abcdef",
        department_id: 2,
        name: "Legacy Child",
        name_en: "Legacy Child",
        department_leader: '["leader-a"]',
        parentid: 1,
        srot: 5,
        create_time: 100,
        update_time: 200,
      }]),
    };
    const service = new EnterpriseWechatCatalogService({ db } as unknown as Container);

    await expect(service.departments({ corp_id: "ww0123456789abcdef" }))
      .resolves.toMatchObject({
        list: [{
          id: 7,
          department_id: 2,
          name: "Legacy Child",
          parentid: 1,
          srot: 5,
          department_leader_count: 1,
        }],
        count: 1,
        catalog_authority: "postgresql_imported_history",
      });
    expect(db.execute).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("binds visibility to current/fence/callback equality and a closed ACTIVE tree", () => {
    const source = readFileSync(
      "src/services/work/EnterpriseWechatCatalogService.ts",
      "utf8",
    );
    expect(source).toContain("WITH RECURSIVE eligible AS");
    expect(source).toContain("INNER JOIN work_department_projection_fence AS fence");
    expect(source).toContain("INNER JOIN work_callback_event AS callback_event");
    expect(source).toContain("current_row.lifecycle_state = 'ACTIVE'");
    expect(source).toContain("current_row.profile_complete = true");
    expect(source).toContain("child.parent_department_id = parent.department_id");
    expect(source).toContain("NOT child.department_id = ANY(parent.ancestor_path)");
    expect(source).toContain("cardinality(parent.ancestor_path) <= ${MAX_DEPARTMENT_ANCESTOR_DEPTH}");
    expect(source).toContain("visible.sort_order DESC");
    expect(source).toContain("WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY");
    expect(source).toContain("WITH current_state AS MATERIALIZED");
    expect(source).toContain("CROSS JOIN current_state");
    expect(source).toContain("LEFT JOIN legacy_rows ON true");
    expect(source).toContain("current_state.blocked_current_rows = 0");
  });
});
