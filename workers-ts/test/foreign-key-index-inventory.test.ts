import { describe, expect, it } from "vitest";
import { foreignKey, index, integer, pgTable, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import * as models from "../src/models/schema";
import { foreignKeyIndexInventory } from "../scripts/foreign-key-index-audit";

describe("complete offline FK candidate inventory", () => {
  it("includes all 68 model foreign keys, records the one new missing candidate and does not discard partial indexes", () => {
    const result = foreignKeyIndexInventory(models);
    expect(result.count).toBe(68);
    const addedKeys=['customer_city_delivery_attempt.ccdattempt_job_fk','customer_city_delivery_binding.ccdbinding_attempt_fk',
      'customer_city_delivery_binding.ccdbinding_job_fk','store_coupon_template_issue.scti_issue_fk','store_coupon_template_issue.scti_template_fk'];
    const additions=result.entries.filter(entry=>addedKeys.includes(`${entry.table}.${entry.name}`));
    expect(additions.map(entry=>`${entry.table}.${entry.name}`)).toEqual(addedKeys);
    expect(result.entries.filter(entry=>!addedKeys.includes(`${entry.table}.${entry.name}`))).toHaveLength(63);
    expect(additions.map(({table,name,columns,parentTable,parentColumns,onDelete,onUpdate,leadingCandidates})=>({
      table,name,columns,parentTable,parentColumns,onDelete,onUpdate,
      candidates:leadingCandidates.map(({name,columns,predicate,fullReferencePrefix})=>({name,columns,predicate,fullReferencePrefix})),
    }))).toEqual([
      {table:'customer_city_delivery_attempt',name:'ccdattempt_job_fk',columns:['job_id'],parentTable:'customer_city_delivery_job',parentColumns:['id'],onDelete:'restrict',onUpdate:'no action',
        candidates:[{name:'ccdattempt_job_uq',columns:['job_id'],predicate:null,fullReferencePrefix:true}]},
      {table:'customer_city_delivery_binding',name:'ccdbinding_attempt_fk',columns:['attempt_id'],parentTable:'customer_city_delivery_attempt',parentColumns:['id'],onDelete:'restrict',onUpdate:'no action',candidates:[]},
      {table:'customer_city_delivery_binding',name:'ccdbinding_job_fk',columns:['job_id'],parentTable:'customer_city_delivery_job',parentColumns:['id'],onDelete:'restrict',onUpdate:'no action',
        candidates:[{name:'customer_city_delivery_binding_pkey',columns:['job_id'],predicate:null,fullReferencePrefix:true}]},
      {table:'store_coupon_template_issue',name:'scti_issue_fk',columns:['issue_id'],parentTable:'store_coupon_issue',parentColumns:['id'],onDelete:'no action',onUpdate:'no action',
        candidates:[{name:'store_coupon_template_issue_pkey',columns:['issue_id'],predicate:null,fullReferencePrefix:true}]},
      {table:'store_coupon_template_issue',name:'scti_template_fk',columns:['template_id'],parentTable:'store_coupon_template',parentColumns:['id'],onDelete:'no action',onUpdate:'no action',
        candidates:[{name:'scti_template_idx',columns:['template_id','issue_id'],predicate:null,fullReferencePrefix:true}]},
    ]);
    // A declared gap stays a gap; this inventory does not claim measured performance.
    expect(result.withoutLeadingCandidate).toEqual(['customer_city_delivery_binding.ccdbinding_attempt_fk']);
    expect(result.entries.find(entry => entry.name === "offline_order_query_evidence_selection_key_fkey")?.leadingCandidates)
      .toContainEqual(expect.objectContaining({ name: "ooqe_selection_idx", columns: ["selection_key"], predicate: null, fullReferencePrefix: true }));
    expect(result.entries.find(entry => entry.name === "wcao_client_fk")?.leadingCandidates)
      .toContainEqual(expect.objectContaining({ name: "wcao_client_ref", columns: ["corp_id", "client_id"], predicate: null, fullReferencePrefix: true }));
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
