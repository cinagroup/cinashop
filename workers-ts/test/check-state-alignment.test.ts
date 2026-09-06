import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { assertAllConstraintsAligned, assertCheckStatesAligned } from "../scripts/data-migration/check-state-contracts";
import { CHECK_STATE_ALIGNMENT_SQL as sql } from "../src/migrations/checkStateAlignment";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";

const root=resolve(import.meta.dirname,"..");
const read=(path:string)=>readFileSync(join(root,path),"utf8").replace(/\r\n/g,"\n");
type Entry={key:string;catalog:CatalogRow;previousCatalog:CatalogRow;previousSnapshot:{name:string;value:string;notValid?:true};
  snapshot:{name:string;value:string;notValid?:true};columns:CatalogRow[];fields:Array<{name:string}>;
  model:{file:string;declaration:string;previousDeclaration:string};fieldDeclarations:string[];
  targetSource:{sql:string};sources:Array<{file:string;line:number;lineCount:number;sql:string}>};
const manifest=JSON.parse(read("audit/orm-check-state-reconciliation.json")) as {entries:Entry[]};
const catalog:Catalog={tables:[],columns:[],indexes:[],sequences:[],constraints:manifest.entries.map(e=>e.catalog)};

describe("DB-009E4 nine exact CHECK states",()=>{
  it("binds immutable raw differences, exact source clauses, fields and typed declarations",()=>{
    const baseline=JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as {records:Array<{
      comparison:string;category:string;change:string;value:{key:string;reference:CatalogRow;candidate:CatalogRow}}>};
    const changed=baseline.records.filter(r=>r.comparison==="externalVsOrm"&&r.category==="constraints"&&r.change==="changed");
    expect(manifest.entries.map(e=>[e.key,e.catalog,e.previousCatalog])).toEqual(changed.map(r=>[r.value.key,r.value.reference,r.value.candidate]));
    expect(manifest.entries).toHaveLength(9);
    expect(manifest.entries.filter(e=>!e.catalog.validated)).toHaveLength(8);
    for(const e of manifest.entries) {
      assertModelDeclaration(read(e.model.file),String(e.catalog.table),e.model.declaration);
      for(const field of e.fieldDeclarations)assertModelDeclaration(read(e.model.file),String(e.catalog.table),field);
      expect(e.snapshot.notValid===true).toBe(!e.catalog.validated);
      expect(e.previousSnapshot.notValid).toBeUndefined();
      if(!e.catalog.validated)expect(e.snapshot).toEqual({...e.previousSnapshot,notValid:true});
      else {
        const values=(s:string)=>[...s.matchAll(/'([^']+)'/g)].map(m=>m[1]);
        expect(values(e.snapshot.value)).toHaveLength(9);
        expect(values(e.snapshot.value).sort()).toEqual(values(e.previousSnapshot.value).sort());
      }
      expect(e.sources.some(s=>s.file.startsWith("migrations/"))).toBe(true);
      expect(e.sources.some(s=>s.file.startsWith("src/"))).toBe(true);
      for(const s of e.sources) {
        expect(read(s.file)).toContain(s.sql);
        if(s.file.startsWith("migrations/"))expect(read(s.file).split("\n").slice(s.line-1,s.line-1+s.lineCount).join("\n")).toContain(s.sql);
      }
    }
  });
  it("mirrors reviewed replacements, all-before-mutation preflight, dependency and comment contract",()=>{
    expect(read("migrations/0144_check_state_alignment.sql").trim()).toBe(sql.trim());
    const data=JSON.parse(sql.split("$check_state_data$")[1]) as {
      columns:CatalogRow[];constraints:Array<{table:string;name:string;columns:string[];previousDefinition:string;definition:string;validated:boolean;clause:string}>};
    expect(data.columns).toHaveLength(16);
    expect(new Set(data.columns.map(c=>c.table)).size).toBe(6);
    for(const [i,e] of manifest.entries.entries())expect(data.constraints[i]).toEqual({
      table:e.catalog.table,name:e.catalog.name,columns:e.fields.map(f=>f.name),
      previousDefinition:e.previousCatalog.definition,definition:e.catalog.definition,validated:e.catalog.validated,clause:e.targetSource.sql,
    });
    expect([...sql.matchAll(/EXECUTE pg_catalog\.format\('([^']+)'/g)].map(m=>m[1])).toEqual([
      "LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE","ALTER TABLE ONLY %I.%I DROP CONSTRAINT %I RESTRICT",
      "ALTER TABLE ONLY %I.%I ADD %s","COMMENT ON CONSTRAINT %I ON %I.%I IS %L",
    ]);
    for(const fragment of ["FOR phase IN 1..2","set_config('lock_timeout','2s',true)","pg_catalog,%I,pg_temp",
      "pg_catalog.pg_depend","pg_catalog.pg_shdepend","pg_catalog.pg_seclabel","before_comment","before_dependencies",
      "actual.oid=old_oid","before_expression","NOT target.validated","original_lock_timeout"])expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/EXECUTE[^;]*(?:CASCADE|VALIDATE CONSTRAINT|TRUNCATE|INSERT INTO)/);
    const service=read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0150\(\)/g)).toHaveLength(1);
    expect(service).toContain("return CHECK_STATE_ALIGNMENT_SQL");
  });
  it("rejects every raw field drift, omissions, aliases, duplicate identities and cohort contraction",()=>{
    expect(()=>assertCheckStatesAligned(catalog,manifest)).not.toThrow();
    expect(()=>assertAllConstraintsAligned(catalog,catalog)).not.toThrow();
    for(const e of manifest.entries) {
      expect(()=>assertCheckStatesAligned({...catalog,constraints:catalog.constraints.filter(c=>c.key!==e.key)},manifest)).toThrow(e.key);
      for(const patch of [{definition:String(e.catalog.definition)+" "},{validated:!e.catalog.validated},{deferrable:true},{deferred:true},
        {type:"u"},{local:false},{noInherit:true},{inheritCount:1}]) {
        const drift={...catalog,constraints:catalog.constraints.map(c=>c.key===e.key?{...c,...patch}:c)};
        expect(()=>assertCheckStatesAligned(drift,manifest)).toThrow(e.key);
        expect(()=>assertAllConstraintsAligned(catalog,drift)).toThrow();
      }
      expect(()=>assertCheckStatesAligned({...catalog,constraints:[...catalog.constraints,e.catalog]},manifest)).toThrow();
      expect(()=>assertCheckStatesAligned({...catalog,constraints:[...catalog.constraints,{...e.catalog,key:e.key+"_alias",name:"alias"}]},manifest)).toThrow();
    }
    for(const entries of [manifest.entries.slice(1),[...manifest.entries].reverse(),[...manifest.entries.slice(1),manifest.entries[1]]])
      expect(()=>assertCheckStatesAligned(catalog,{entries})).toThrow();
    expect(()=>assertAllConstraintsAligned(catalog,{...catalog,constraints:[...catalog.constraints,catalog.constraints[0]]})).toThrow();
    const runner=read("scripts/orm-ddl-audit.ts");
    for(const fragment of ['"orm_checks"',"assertCheckStatesAligned(catalog, checkStateManifest)",
      "assertAllConstraintsAligned(catalogs.external, catalog)","compareCatalogs(catalogs.orm, catalogs.orm_checks)"])expect(runner).toContain(fragment);
  });
  it.each(["cjs","esm"])("executes %s full old-ORM upgrade with network denied",format=>{
    const directory=mkdtempSync(join(tmpdir(),"cinashop-check-state-")),report=join(directory,"audit.json");
    try {
      const environment={...process.env};
      const allowed=new Set(["PATH","Path","SystemRoot","WINDIR","COMSPEC","PATHEXT","TEMP","TMP","LOCALAPPDATA"]);
      for(const key of Object.keys(environment))if(!allowed.has(key))delete environment[key];
      Object.assign(environment,{CI:"1",TSX_DISABLE_CACHE:"1",DATABASE_URL:"postgresql://audit:audit@127.0.0.1:9/audit",CINASHOP_DRIZZLE_AUDIT_REPORT:report});
      const result=spawnSync(process.execPath,["--require",join(root,"test/helpers/drizzleCliAudit.cjs"),join(root,"test/helpers/checkStateLocalAudit.cjs"),format],{
        cwd:root,env:environment,encoding:"utf8",timeout:180_000,windowsHide:true,
      });
      expect(result.error,result.stdout+result.stderr).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0);
      expect(result.stdout).toContain("DB-009E4 "+format+": 9 CHECKs aligned;");
      const audit=JSON.parse(readFileSync(report,"utf8"));expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path:string)=>path.includes("/@esbuild-kit/"))).toEqual([]);
    }finally{
      const exact=resolve(directory);
      if(dirname(exact)!==resolve(tmpdir())||!/^cinashop-check-state-[A-Za-z0-9]+$/.test(basename(exact)))throw new Error("Unsafe temporary audit cleanup target");
      rmSync(exact,{recursive:true,force:true});
    }
  },210_000);
});
