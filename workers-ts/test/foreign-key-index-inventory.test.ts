import { describe, expect, it } from "vitest";
import { foreignKey, index, integer, pgTable, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import * as models from "../src/models/schema";
import { foreignKeyIndexInventory } from "../scripts/foreign-key-index-audit";

describe("complete offline FK candidate inventory", () => {
  it("includes all 45 model foreign keys and does not discard partial indexes", () => {
    const result = foreignKeyIndexInventory(models);
    expect(result.count).toBe(45);
    expect(result.withoutLeadingCandidate).toEqual(["work_contact_action_outbox.wcao_client_fk"]);
    expect(result.partialOnly).toEqual([
      "work_member_current.wmc_last_event_fk",
      "work_member_identity_alias.wmia_last_event_fk",
      "work_member_identity_alias.wmia_link_event_fk",
    ]);
    for (const key of result.partialOnly) {
      const entry = result.entries.find(entry => `${entry.table}.${entry.name}` === key)!;
      expect(entry.leadingCandidates).toHaveLength(1);
      expect(entry.leadingCandidates[0].predicate).toContain("IS NOT NULL");
      expect(entry.onDelete).toBe("restrict");
    }
    expect(result.entries.find(entry => entry.name === "wcc_last_event_fk")?.leadingCandidates)
      .toContainEqual(expect.objectContaining({ name: "wcc_last_event_idx", fullReferencePrefix: false }));
  });
  it("distinguishes a narrow usable leading shape from full composite coverage and ignores trailing-only keys", () => {
    const parent = pgTable("inventory_parent", { a: integer("a"), b: integer("b") }, t => [primaryKey({ columns: [t.a, t.b] })]);
    const child = pgTable("inventory_child", { a: integer("a"), b: integer("b"), other: integer("other") }, t => [
      foreignKey({ name: "fixture_fk", columns: [t.a, t.b], foreignColumns: [parent.a, parent.b] }),
      index("trailing_only").on(t.other, t.a), index("narrow").on(t.a), index("reordered").on(t.b, t.a),
      index("partial").on(t.a).where(sql`${t.a} IS NOT NULL`), index("expression").on(sql`${t.a}+0`),
    ]);
    const result = foreignKeyIndexInventory({ parent, child, aliasOfChild: child });
    expect(result.count).toBe(1);
    expect(result.entries[0].leadingCandidates.map(index => [index.name, index.fullReferencePrefix]))
      .toEqual([["narrow", false], ["reordered", true], ["partial", false]]);
    expect(result.mode).toBe("offline-model-candidates-not-performance-acceptance");
  });
});
