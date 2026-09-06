import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { assertIndexContracts, type Catalog, type CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { extendOrdinaryIndexContracts } from "../scripts/data-migration/ordinary-index-contracts";
import { extendIndexNameContracts } from "../scripts/data-migration/index-name-contracts";
import { extendConstraintNameContracts, assertConstraintNamesAligned } from "../scripts/data-migration/constraint-name-contracts";
import { CONSTRAINT_NAME_ALIGNMENT_SQL as sql } from "../src/migrations/constraintNameAlignment";

type Entry = { key: string; previousKey: string; catalog: CatalogRow; previousCatalog: CatalogRow; constraint: CatalogRow; previousConstraint: CatalogRow;
  columns: string[]; previousSnapshotConstraint: { name: string; columns: string[] }; snapshotField: string;
  model: { file: string; line: number; previousDeclaration: string; declaration: string }; source: { file: string; line: number; sql: string } };
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g,"\n");
const manifest = JSON.parse(read("audit/orm-constraint-name-reconciliation.json")) as { entries: Entry[] };
const prior = (name: string) => JSON.parse(read(`audit/${name}`)) as { entries: Array<Entry & { decision: string }> };
const base = [...prior("orm-query-index-reconciliation.json").entries, ...prior("orm-index-definition-reconciliation.json").entries,
  ...prior("orm-extra-index-reconciliation.json").entries.filter(e=>e.decision==="restore-missing-legacy-query-index")];
const base128 = extendOrdinaryIndexContracts(base.map(e=>e.key),prior("orm-ordinary-index-reconciliation.json")).keys;
const base172 = extendIndexNameContracts(base128,prior("orm-index-name-reconciliation.json")).keys;
const catalog: Catalog = { tables:[],columns:[],sequences:[],indexes:manifest.entries.map(e=>e.catalog),constraints:manifest.entries.map(e=>e.constraint) };

describe("DB-009D2b3d owning constraint and index identity", () => {
  it("checks both real driver error field spellings without accepting missing, wrong or conflicting names", () => {
    const { matchesDatabaseError } = createRequire(import.meta.url)("./helpers/constraintNameAudit.cjs") as {
      matchesDatabaseError(error: Record<string, unknown>, code: string, constraint?: string): boolean;
    };
    const name = "kefu_visitor_session_token_hash_key";
    for (const fields of [{ constraint: name }, { constraint_name: name }, { constraint: name, constraint_name: name }]) {
      expect(matchesDatabaseError({ code: "23505", ...fields }, "23505", name)).toBe(true);
    }
    for (const error of [{ code: "23505" }, { code: "23503", constraint: name }, { code: "23505", constraint_name: "wrong" },
      { code: "23505", constraint: name, constraint_name: "wrong" }]) {
      expect(() => matchesDatabaseError(error, "23505", name)).toThrow();
    }
  });
  it("binds all three constraint-owned aliases to immutable engine rows and exact source/model declarations", () => {
    const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as { records: Array<{
      comparison?: string; category?: string; change?: string; value: CatalogRow & { reference: string; candidate: string } }> };
    const records = baseline.records.filter(r=>r.comparison==="externalVsOrm");
    const find = (category:string,change:string,key:string)=>records.find(r=>r.category===category&&r.change===change&&r.value.key===key)!.value;
    const aliases = records.filter(r=>r.category==="indexes"&&r.change==="possibleRenames"&&find("indexes","referenceOnly",r.value.reference).constraintOwned===true);
    expect(aliases).toHaveLength(3);
    expect(manifest.entries.map(e=>[e.key,e.previousKey])).toEqual(aliases.map(r=>[r.value.reference,r.value.candidate]));
    for(const e of manifest.entries) {
      expect(e.catalog).toEqual(find("indexes","referenceOnly",e.key));
      expect(e.previousCatalog).toEqual(find("indexes","candidateOnly",e.previousKey));
      expect(e.constraint).toEqual(find("constraints","referenceOnly",e.key));
      expect(e.previousConstraint).toEqual(find("constraints","candidateOnly",e.previousKey));
      expect(e.catalog).toEqual({...e.previousCatalog,key:e.key,name:e.catalog.name});
      expect(e.constraint).toEqual({...e.previousConstraint,key:e.key,name:e.constraint.name});
      expect(e.previousSnapshotConstraint).toMatchObject({name:e.previousCatalog.name,columns:e.columns});
      expect(e.snapshotField).toBe(e.constraint.type==="p"?"compositePrimaryKeys":"uniqueConstraints");
      expect(read(e.model.file).split("\n")[e.model.line-1]).toBe(e.model.declaration);
      const replacement=e.constraint.type==="p"?e.model.previousDeclaration.replace("primaryKey({ columns:",`primaryKey({ name: "${e.catalog.name}", columns:`)
        :e.model.previousDeclaration.replace(".unique()",`.unique("${e.catalog.name}")`);
      expect(e.model.declaration).toBe(replacement);
      expect(read(e.source.file).split("\n")[e.source.line-1]).toBe(e.source.sql);
    }
  });

  it("registers an exact SQL mirror limited to locking and renaming the owning constraint", () => {
    expect(read("migrations/0139_constraint_name_alignment.sql").trim()).toBe(sql.trim());
    expect([...sql.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', '([a-z0-9_]+)', '([pu])', ARRAY\[/g)].map(m=>[m[1],m[2],m[3],m[4]]))
      .toEqual(manifest.entries.map(e=>[e.catalog.table,e.previousCatalog.name,e.catalog.name,e.constraint.type]));
    expect([...sql.matchAll(/EXECUTE format\('([^']+)'/g)].map(m=>m[1])).toEqual([
      "LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE","ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I",
    ]);
    expect(sql).not.toMatch(/\b(?:DROP|INSERT|UPDATE|DELETE|TRUNCATE|CASCADE|REINDEX)\b/);
    for(const guard of ["current_schema()","set_config('lock_timeout', '2s', true)","c.conindid=selected_index","c.contype::text=item.constraint_type",
      "NOT c.condeferrable","NOT c.condeferred","c.convalidated","c.conparentid=0","i.indimmediate","NOT i.indnullsnotdistinct",
      "i.indisprimary=(item.constraint_type='p')","new_constraint IS DISTINCT FROM old_constraint","new_index IS DISTINCT FROM old_index"])
      expect(sql).toContain(guard);
    const service=read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0145\(\)/g)).toHaveLength(1);
    expect(service).toContain("return CONSTRAINT_NAME_ALIGNMENT_SQL");
  });

  it("retains 172 prior contracts and adds exactly three owning index and constraint contracts", () => {
    const result=extendConstraintNameContracts(base172,manifest);
    expect(result.keys).toHaveLength(175); expect(result.keys.slice(0,172)).toEqual(base172);
    expect(result.constraintKeys).toEqual(manifest.entries.map(e=>e.key));
    expect(result.oldKeys).toEqual(manifest.entries.map(e=>e.previousKey));
    expect(()=>assertConstraintNamesAligned(catalog,catalog)).not.toThrow();
    expect(()=>assertIndexContracts(catalog,catalog,result.constraintKeys)).not.toThrow();
    for(const e of manifest.entries) {
      expect(()=>assertConstraintNamesAligned(catalog,{...catalog,constraints:catalog.constraints.filter(r=>r.key!==e.key)})).toThrow(e.key);
      expect(()=>assertConstraintNamesAligned(catalog,{...catalog,constraints:catalog.constraints.map(r=>r.key===e.key?{...r,deferrable:true}:r)})).toThrow(e.key);
      expect(()=>assertIndexContracts(catalog,{...catalog,indexes:catalog.indexes.filter(r=>r.key!==e.key)},result.constraintKeys)).toThrow(e.key);
    }
  });

  it("rejects contract contraction, reclassification and any definition change", () => {
    expect(()=>extendConstraintNameContracts(base172.slice(1),manifest)).toThrow();
    for(const mutate of [
      (copy:typeof manifest)=>copy.entries.pop(),
      (copy:typeof manifest)=>{copy.entries[0]=copy.entries[1];},
      (copy:typeof manifest)=>{copy.entries[0].catalog.constraintOwned=false;},
      (copy:typeof manifest)=>{copy.entries[0].constraint.definition="different";},
      (copy:typeof manifest)=>{copy.entries[0].constraint.deferrable=true;},
      (copy:typeof manifest)=>{copy.entries[0].previousKey="wrong.index";},
    ]) {const copy=structuredClone(manifest);mutate(copy);expect(()=>extendConstraintNameContracts(base172,copy)).toThrow();}
  });

  it("rejects obsolete constraints or indexes even on other tables and gates every database path", () => {
    for(const e of manifest.entries) for(const kind of ["indexes","constraints"] as const) {
      const old=kind==="indexes"?e.previousCatalog:e.previousConstraint;
      for(const row of [old,{...old,key:`wrong.${old.name}`,table:"wrong"}]) expect(()=>assertConstraintNamesAligned(catalog,{...catalog,[kind]:[...catalog[kind],row]})).toThrow(e.previousKey);
    }
    const runner=read("scripts/orm-ddl-audit.ts");
    expect(runner).toContain("for (const catalog of Object.values(catalogs)) assertConstraintNamesAligned(catalogs.external, catalog)");
    expect(runner).toContain("const requiredIndexKeys = owningContracts.keys");
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_upgrade)");
  });
});
