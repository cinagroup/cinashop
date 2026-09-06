import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Catalog, CatalogRow } from "../scripts/data-migration/postgres-catalog-audit";
import { assertForeignKeyNamesAligned } from "../scripts/data-migration/foreign-key-name-contracts";
import { FOREIGN_KEY_NAME_ALIGNMENT_SQL as sql } from "../src/migrations/foreignKeyNameAlignment";
import { assertModelDeclaration } from "./helpers/modelDeclarationBinding";

const root=resolve(import.meta.dirname,"..");
const read=(path:string)=>readFileSync(join(root,path),"utf8").replace(/\r\n/g,"\n");
type Entry={key:string;previousKey:string;catalog:CatalogRow;previousCatalog:CatalogRow;
  previousSnapshot:{name:string;onDelete:string};snapshot:{name:string};
  model:{file:string;declaration:string;previousDeclaration:string;foreignKeyDeclaration:string};
  sources:Array<{file:string;line:number;lineCount:number;sql:string}>};
const manifest=JSON.parse(read("audit/orm-foreign-key-name-reconciliation.json")) as {entries:Entry[]};
const catalog:Catalog={tables:[],columns:[],indexes:[],sequences:[],constraints:manifest.entries.map(e=>e.catalog)};

describe("DB-009E3 identity-preserving foreign-key names",()=>{
  it("binds exactly twelve immutable aliases, both source paths and typed declarations",()=>{
    const baseline=JSON.parse(read("audit/orm-ddl-catalog-baseline.json")) as {records:Array<{
      comparison:string;category:string;change:string;value:CatalogRow&{reference:string;candidate:string}}>};
    const records=baseline.records.filter(r=>r.comparison==="externalVsOrm"&&r.category==="constraints");
    const find=(change:string,key:string)=>records.find(r=>r.change===change&&r.value.key===key)!.value;
    const aliases=records.filter(r=>r.change==="possibleRenames"&&find("referenceOnly",r.value.reference).type==="f");
    expect(manifest.entries.map(e=>[e.key,e.previousKey])).toEqual(aliases.map(r=>[r.value.reference,r.value.candidate]));
    expect(manifest.entries).toHaveLength(12);
    for(const e of manifest.entries) {
      expect(e.catalog).toEqual(find("referenceOnly",e.key));expect(e.previousCatalog).toEqual(find("candidateOnly",e.previousKey));
      expect(e.catalog).toEqual({...e.previousCatalog,key:e.key,name:e.catalog.name});
      expect(e.snapshot).toEqual({...e.previousSnapshot,name:e.catalog.name});
      expect(e.previousSnapshot.name.slice(0,63)).toBe(e.previousCatalog.name);
      assertModelDeclaration(read(e.model.file),String(e.catalog.table),e.model.declaration);
      assertModelDeclaration(read(e.model.file),String(e.catalog.table),e.model.foreignKeyDeclaration);
      expect(e.model.previousDeclaration).toMatch(/\.references\(/);
      expect(e.model.declaration).not.toContain(".references(");
      expect(e.sources.some(s=>s.file.startsWith("migrations/"))).toBe(true);
      expect(e.sources.some(s=>s.file.startsWith("src/"))).toBe(true);
      for(const source of e.sources) {
        expect(read(source.file)).toContain(source.sql);
        if(source.file.startsWith("migrations/")) expect(read(source.file).split("\n").slice(source.line-1,source.line-1+source.lineCount).join("\n")).toBe(source.sql);
      }
    }
  });
  it("registers only bounded locks and reviewed renames with complete RI protocol checks",()=>{
    expect(read("migrations/0143_foreign_key_name_alignment.sql").trim()).toBe(sql.trim());
    const data=JSON.parse(sql.split("$foreign_key_data$")[1]) as {columns:unknown[];constraints:Array<{table:string;name:string;previousName:string;definition:string}>};
    expect(data.columns).toHaveLength(19);
    expect(data.constraints.map(e=>[e.table+"."+e.name,e.table+"."+e.previousName,e.definition]))
      .toEqual(manifest.entries.map(e=>[e.key,e.previousKey,e.catalog.definition]));
    expect([...sql.matchAll(/EXECUTE pg_catalog\.format\('([^']+)'/g)].map(m=>m[1])).toEqual([
      "LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE","ALTER TABLE ONLY %I.%I RENAME CONSTRAINT %I TO %I",
    ]);
    for(const fragment of ["FOR phase IN 1..2","set_config('lock_timeout', '2s', true)","pg_catalog,%I,pg_temp",
      "actual.conindid IS DISTINCT FROM ref_key.conindid","actual.conpfeqop IS DISTINCT FROM ARRAY[equality_oid]",
      "RI_FKey_check_ins","RI_FKey_check_upd","RI_FKey_cascade_del","RI_FKey_restrict_del","RI_FKey_noaction_upd",
      "t.tgconstrindid=ref_key.conindid","t.tgenabled='O'","t.tgparentid=0","before_constraint","before_triggers"])
      expect(sql).toContain(fragment);
    expect(sql).not.toMatch(/\b(?:DROP|ADD CONSTRAINT|VALIDATE CONSTRAINT|TRUNCATE|INSERT INTO)\b/);
    const service=read("src/services/MigrationService.ts");
    expect(service.match(/this\.migration_0149\(\)/g)).toHaveLength(1);
    expect(service).toContain("return FOREIGN_KEY_NAME_ALIGNMENT_SQL");
  });
  it("rejects missing/duplicate rows, every field drift, retired names and contract contraction",()=>{
    expect(()=>assertForeignKeyNamesAligned(catalog,manifest)).not.toThrow();
    for(const e of manifest.entries) {
      expect(()=>assertForeignKeyNamesAligned({...catalog,constraints:catalog.constraints.filter(c=>c.key!==e.key)},manifest)).toThrow(e.key);
      for(const patch of [{definition:String(e.catalog.definition)+" "},{validated:false},{deferrable:true},{deferred:true},{type:"u"},{local:false},{noInherit:false},{inheritCount:1}])
        expect(()=>assertForeignKeyNamesAligned({...catalog,constraints:catalog.constraints.map(c=>c.key===e.key?{...c,...patch}:c)},manifest)).toThrow(e.key);
      for(const old of [e.previousCatalog,{...e.previousCatalog,key:"wrong."+e.previousCatalog.name,table:"wrong"}])
        expect(()=>assertForeignKeyNamesAligned({...catalog,constraints:[...catalog.constraints,old]},manifest)).toThrow();
      expect(()=>assertForeignKeyNamesAligned({...catalog,constraints:[...catalog.constraints,{...e.catalog,name:"unknown_alias",key:e.catalog.table+".unknown_alias"}]},manifest)).toThrow();
    }
    for(const entries of [manifest.entries.slice(1),[...manifest.entries].reverse(),[...manifest.entries.slice(1),manifest.entries[1]]])
      expect(()=>assertForeignKeyNamesAligned(catalog,{entries})).toThrow();
    const runner=read("scripts/orm-ddl-audit.ts");
    expect(runner).toContain('"orm_fk_names"');
    expect(runner).toContain("assertForeignKeyNamesAligned(catalog, foreignKeyNameManifest)");
    expect(runner).toContain("compareCatalogs(catalogs.orm, catalogs.orm_fk_names)");
  });
  it.each(["cjs","esm"])("executes %s full old ORM with network denied and preserves foreign-key identity",format=>{
    const directory=mkdtempSync(join(tmpdir(),"cinashop-fk-names-")),report=join(directory,"audit.json");
    try {
      const environment={...process.env};
      const allowed=new Set(["PATH","Path","SystemRoot","WINDIR","COMSPEC","PATHEXT","TEMP","TMP","LOCALAPPDATA"]);
      for(const key of Object.keys(environment))if(!allowed.has(key))delete environment[key];
      Object.assign(environment,{CI:"1",TSX_DISABLE_CACHE:"1",DATABASE_URL:"postgresql://audit:audit@127.0.0.1:9/audit",CINASHOP_DRIZZLE_AUDIT_REPORT:report});
      const result=spawnSync(process.execPath,["--require",join(root,"test/helpers/drizzleCliAudit.cjs"),join(root,"test/helpers/foreignKeyNameLocalAudit.cjs"),format],{
        cwd:root,env:environment,encoding:"utf8",timeout:180_000,windowsHide:true,
      });
      expect(result.error,result.stdout+result.stderr).toBeUndefined();expect(result.status,result.stdout+result.stderr).toBe(0);
      expect(result.stdout).toContain(`DB-009E3 ${format}: 12 foreign keys renamed;`);
      expect(result.stdout).toContain("141 drift refusals / 12 raw proposal hazards");
      const audit=JSON.parse(readFileSync(report,"utf8"));expect(audit.networkAttempts).toBe(0);
      expect(audit.loaded.filter((path:string)=>path.includes("/@esbuild-kit/"))).toEqual([]);
    } finally {
      const exact=resolve(directory);
      if(dirname(exact)!==resolve(tmpdir()) || !/^cinashop-fk-names-[A-Za-z0-9]+$/.test(basename(exact))) throw new Error("Unsafe temporary audit cleanup target");
      rmSync(exact,{recursive:true,force:true});
    }
  },210_000);
});
