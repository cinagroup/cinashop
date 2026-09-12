import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { foreignKeyIndexInventory } from "../scripts/foreign-key-index-audit";
import * as models from "../src/models/schema";
import { sequenceRunnerDatabase } from "./helpers/kefuSequenceRunnerDatabase";
import { foreignKeyNestedPlans } from "./helpers/foreignKeyNestedPlans";

const count = 100003;
const eventColumns = "last_event_id,corp_id,last_event_key,last_event_subject_key_hash,last_event_time,last_sequence_rank";
const eventValues = "n,'fixture',lpad(to_hex(n),64,'0'),repeat('c',64),1,0";
// Explicit valid business states; never strip model CHECK/FK/identity constraints.
const fixtures: Record<string, { columns: string; values: string; prepare?: string }> = {
  wcc: { columns: "external_userid,lifecycle_state,profile_complete,provider_snapshot_complete,name,type,gender,external_profile,inactive_time",
    values: "'client_'||n,CASE WHEN n=2 THEN 'ACTIVE' ELSE 'INACTIVE' END,true,true,'client',1,0,'{}',CASE WHEN n=2 THEN NULL ELSE 1 END" },
  wcpf: { columns: "external_userid", values: "'client_'||n",
    prepare: `INSERT INTO work_client_current(corp_id,external_userid) SELECT 'fixture','client_'||n FROM generate_series(1,${count}) n` },
  wcfc: { columns: "client_id,userid,lifecycle_state,profile_complete,tags_complete,follow_created_time,remark_mobiles,deleted_time",
    values: "1,'user_'||n,CASE WHEN n%2=0 THEN 'ACTIVE' ELSE 'DELETED' END,n%2=0,n%2=0,1,'[]',CASE WHEN n%2=0 THEN NULL ELSE 1 END",
    prepare: "INSERT INTO work_client_current(corp_id,external_userid) VALUES ('fixture','client')" },
  wcfpf: { columns: "client_id,userid", values: "1,'user_'||n",
    prepare: "INSERT INTO work_client_current(corp_id,external_userid) VALUES ('fixture','client')" },
  wdc: { columns: "department_id,lifecycle_state,profile_complete,name,name_en,sort_order,deleted_time",
    values: "n,CASE WHEN n=2 THEN 'ACTIVE' ELSE 'DELETED' END,n=2,'department','department',0,CASE WHEN n=2 THEN NULL ELSE 1 END" },
  wdpf: { columns: "department_id", values: "n",
    prepare: `INSERT INTO work_department_current(corp_id,department_id) SELECT 'fixture',n FROM generate_series(1,${count}) n` },
  wetgc: { columns: "group_id,lifecycle_state,snapshot_complete,group_name,sort_order,provider_create_time,deleted_time",
    values: "'group_'||n,CASE WHEN n%2=0 THEN 'ACTIVE' ELSE 'DELETED' END,n%2=0,'group',0,1,CASE WHEN n%2=0 THEN NULL ELSE 1 END" },
  wetc: { columns: "tag_id,group_id,lifecycle_state,snapshot_complete,name,sort_order,provider_create_time,deleted_time",
    values: "'tag_'||n,'support',CASE WHEN n%2=0 THEN 'ACTIVE' ELSE 'DELETED' END,n%2=0,'tag',0,1,CASE WHEN n%2=0 THEN NULL ELSE 1 END",
    prepare: `INSERT INTO work_external_tag_group_current(group_id,lifecycle_state,deleted_time,${eventColumns}) VALUES ('support','DELETED',1,${count+2},'fixture',lpad(to_hex(${count+2}),64,'0'),repeat('c',64),1,0)` },
  wetpf: { columns: "subject_type,remote_id", values: "'tag','tag_'||n" },
  wgcc: { columns: "chat_id,lifecycle_state,profile_complete,members_complete,name,owner,group_created_time,notice,admin_list,provider_status,member_count,dismissed_time",
    values: "'chat_'||n,CASE WHEN n=2 THEN 'ACTIVE' ELSE 'DISMISSED' END,n=2,n=2,'chat','owner',1,'','[]',0,0,CASE WHEN n=2 THEN NULL ELSE 1 END" },
  wgcpf: { columns: "chat_id", values: "'chat_'||n",
    prepare: `INSERT INTO work_group_chat_current(corp_id,chat_id) SELECT 'fixture','chat_'||n FROM generate_series(1,${count}) n` },
  wgcmc: { columns: "group_id,userid,lifecycle_state,type,join_time,join_scene,group_nickname,left_time",
    values: "1,'user_'||n,CASE WHEN n%2=0 THEN 'ACTIVE' ELSE 'LEFT' END,1,1,0,'',CASE WHEN n%2=0 THEN NULL ELSE 1 END",
    prepare: "INSERT INTO work_group_chat_current(corp_id,chat_id) VALUES ('fixture','chat')" },
};
const inventory = foreignKeyIndexInventory(models);
const targets = inventory.entries.filter(entry => entry.columns.length > 1 && entry.leadingCandidates.length
  && !entry.leadingCandidates.some(index => index.fullReferencePrefix));
type Plan = { "Actual Rows"?: number; "Actual Loops"?: number; "Index Name"?: string; "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
type Explained = { Plan: Plan; Triggers?: Array<{ "Constraint Name"?: string; Calls?: number }> };
function explained(value: unknown): Explained {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && "rows" in value ? value.rows : null;
  if (!Array.isArray(rows) || !rows[0]?.["QUERY PLAN"]?.[0]?.Plan) throw new Error("Missing actual JSON plan");
  return rows[0]["QUERY PLAN"][0];
}
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
function summary({ Plan: plan }: Explained) {
  return { rows: plan["Actual Rows"], buffers: (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0),
    filtered: nodes(plan).reduce((n, p) => n + (p["Rows Removed by Filter"] ?? 0) * (p["Actual Loops"] ?? 1), 0),
    indexes: nodes(plan).flatMap(p => p["Index Name"] ? [p["Index Name"]] : []) };
}
function message(error: unknown): string {
  return error instanceof Error ? error.message + (error.cause ? " " + message(error.cause) : "") : String(error);
}

describe("all twelve six-column callback references with existing narrow indexes", () => {
  let generated: string;
  let fixture: Awaited<ReturnType<typeof sequenceRunnerDatabase>> | undefined;
  beforeAll(async () => {
    expect(targets.map(t => t.name).sort()).toEqual(Object.keys(fixtures).map(key => `${key}_last_event_fk`).sort());
    const api = await import("drizzle-kit/api");
    generated = (await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join("\n");
  }, 120000);
  afterEach(async () => {
    const owned = fixture;
    fixture = undefined;
    // Physical DROP DATABASE can wait on storage/checkpoints. Keep the
    // driver's 30s statement limit and two bounded connection drains intact;
    // a late cleanup must never clear the next fixture's reference.
    await owned?.close();
  }, 45_000);
  it.each(targets)("validates full predicates and actual parent protections for $name", async target => {
    fixture = await sequenceRunnerDatabase();
    const { db, exec, query } = fixture;
    await exec(generated);
    expect(target.columns.join(",")).toBe(eventColumns);
    expect(target.parentColumns).toEqual(["id", "corp_id", "event_key", "subject_key_hash", "event_time", "sequence_rank"]);
    expect(target.parentTable).toBe("work_callback_event");
    expect(target.onDelete).toBe("restrict");
    expect(target.onUpdate).toBe("no action");
    const prefix = target.name.replace(/_last_event_fk$/, ""), index = `${prefix}_last_event_idx`;
    expect(target.leadingCandidates).toContainEqual(expect.objectContaining({ name: index, columns: ["last_event_id"] }));
    const state = () => query(`SELECT c.conname,c.convalidated,c.confdeltype,c.confupdtype,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c WHERE c.conrelid='public.${target.table}'::regclass AND c.conname='${target.name}'`);
    const beforeFk = await state();
    expect(beforeFk.rows).toMatchObject([{ conname: target.name, convalidated: true, confdeltype: "r", confupdtype: "a" }]);
    await exec(`INSERT INTO work_callback_event(id,corp_id,event_key,subject_key_hash,payload_hash,payload,event_time)
      SELECT n,'fixture',lpad(to_hex(n),64,'0'),repeat('c',64),repeat('b',64),'{}',1 FROM generate_series(1,${count+2}) n`);
    const data = fixtures[prefix];
    if (data.prepare) await exec(data.prepare);
    await exec(`INSERT INTO public.${target.table}(${eventColumns},${data.columns}) SELECT ${eventValues},${data.values} FROM generate_series(1,${count}) n`);
    await exec(`ANALYZE public.${target.table}; ANALYZE public.work_callback_event`);
    const [version] = await db.select({ value: sql<string>`current_setting('server_version_num')` }).from(sql`(values (1)) p(n)`);
    const major = Math.floor(Number(version.value) / 10000);
    expect([16, 18]).toContain(major);
    const fingerprint = (table: string) => query(`SELECT count(*)::int AS count,md5(string_agg(to_jsonb(x)::text,'' ORDER BY to_jsonb(x)::text)) AS digest FROM public.${table} x`);
    const beforeRows = await fingerprint(target.table), beforeParents = await fingerprint("work_callback_event");
    expect(beforeRows.rows).toMatchObject([{ count }]);
    const probe = (key: number, corp = "fixture") => sql`SELECT 1 FROM ONLY public.${sql.identifier(target.table)} x WHERE
      ${key}::integer OPERATOR(pg_catalog.=) x.last_event_id AND ${corp}::varchar OPERATOR(pg_catalog.=) x.corp_id
      AND ${key.toString(16).padStart(64, "0")}::varchar OPERATOR(pg_catalog.=) x.last_event_key
      AND ${"c".repeat(64)}::varchar OPERATOR(pg_catalog.=) x.last_event_subject_key_hash
      AND ${1}::integer OPERATOR(pg_catalog.=) x.last_event_time AND ${0}::integer OPERATOR(pg_catalog.=) x.last_sequence_rank FOR KEY SHARE OF x`;
    const run = async (key: number, corp?: string) => summary(explained(await db.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${probe(key, corp)}`)));
    const absent = await run(count+1), active = await run(2), inactive = await run(3), wrongCorp = await run(2, "other");
    const generic = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL plan_cache_mode=force_generic_plan`);
      const built = new PgDialect().sqlToQuery(probe(count+1));
      expect(built.params).toHaveLength(6);
      await tx.execute(sql.raw(`PREPARE audit_composite_fk AS ${built.sql}`));
      try {
        return summary(explained(await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE audit_composite_fk(
          ${sql.raw(String(count+1))},'fixture',${sql.raw("'"+(count+1).toString(16).padStart(64,"0")+"'")},
          ${sql.raw("'"+"c".repeat(64)+"'")},1,0)`)));
      } finally { await tx.execute(sql`DEALLOCATE audit_composite_fk`); }
    });
    for (const [name, plan] of Object.entries({ absent, active, inactive, wrongCorp, generic })) {
      expect(plan.rows).toBe(name === "active" || name === "inactive" ? 1 : 0);
      if (name === "wrongCorp") {
        // An absent tenant can be excluded more cheaply by an existing corp_id
        // index/PK. That valid plan is not evidence of a missing event index.
        expect(plan.indexes.length).toBeGreaterThan(0);
        for (const used of plan.indexes) expect(target.leadingCandidates.map(candidate => candidate.name)).toContain(used);
      } else {
        expect(plan.indexes, JSON.stringify({ target: target.name, name, plan })).toContain(index);
      }
      expect(plan.buffers).toBeLessThan(50);
      expect(plan.filtered).toBeLessThanOrEqual(name === "wrongCorp" ? 1 : 0);
    }
    for (const key of [2, 3]) {
      for (const deletion of [true, false]) {
        const operation = deletion ? sql`DELETE FROM public.work_callback_event WHERE id=${key}`
          : sql`UPDATE public.work_callback_event SET sequence_rank=sequence_rank+1 WHERE id=${key}`;
        const error = await db.execute(operation).then(() => undefined, error => error as unknown);
        expect(message(error)).toContain(target.name);
        expect(error).toMatchObject({ cause: { code: deletion && major === 18 ? "23001" : "23503" } });
      }
    }
    for (const operation of [sql`DELETE FROM public.work_callback_event WHERE id=${count+1}`,
      sql`UPDATE public.work_callback_event SET sequence_rank=sequence_rank+1 WHERE id=${count+1}`]) {
      const rollback = new Error("restore unreferenced fixture parent");
      await expect(db.transaction(async tx => {
        const plan = explained(await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${operation}`));
        expect(plan.Triggers).toContainEqual(expect.objectContaining({ "Constraint Name": target.name, Calls: 1 }));
        throw rollback;
      })).rejects.toBe(rollback);
    }
    expect(await fingerprint(target.table)).toEqual(beforeRows);
    expect(await fingerprint("work_callback_event")).toEqual(beforeParents);
    expect(await state()).toEqual(beforeFk);
    process.stdout.write("WORK_COMPOSITE_FK_AUDIT " + JSON.stringify({ target: target.name, version: version.value, rows: count,
      distribution: "single-corp distinct event per child", absent, active, inactive, wrongCorp, generic,
      existingIndex: index, addedIndexes: 0, actualParentActions: true, parentAndChildRowsUnchanged: true,
      foreignKeyUnchanged: true, nestedTriggerPlanCaptured: false, productionLatencyClaim: false }) + "\n");
  }, 180000);
  it.each(targets)("hot multi-tenant correctness and measured plans for $name", async target => {
    fixture = await sequenceRunnerDatabase();
    const { db, exec, query } = fixture;
    await exec(generated);
    const prefix = target.name.replace(/_last_event_fk$/, ""), data = fixtures[prefix];
    await exec(`INSERT INTO work_callback_event(id,corp_id,event_key,subject_key_hash,payload_hash,payload,event_time)
      SELECT n,corp,lpad(to_hex(n),64,'0'),repeat('c',64),repeat('b',64),'{}',1
      FROM (VALUES (1,'fixture'),(2,'other'),(3,'fixture'),(4,'other'),(5,'fixture'),
        (6,'other'),(7,'fixture'),(${count+2},'fixture'),(${count+3},'other')) p(n,corp)`);
    // Seed the actual support relations in both tenants. Equal numeric ids in
    // composite tenant keys are deliberate; no CHECK/FK/identity is removed.
    for (const corp of ["fixture", "other"] as const) {
      if (prefix === "wcpf") await exec(`INSERT INTO work_client_current(corp_id,external_userid)
        SELECT '${corp}','client_'||n FROM generate_series(1,${count}) n`);
      if (["wcfc", "wcfpf"].includes(prefix)) await exec(`INSERT INTO work_client_current(id,corp_id,external_userid)
        OVERRIDING SYSTEM VALUE VALUES (1,'${corp}','client')`);
      if (prefix === "wdpf") await exec(`INSERT INTO work_department_current(corp_id,department_id)
        SELECT '${corp}',n FROM generate_series(1,${count}) n`);
      if (prefix === "wetc") {
        const supportEvent = count + (corp === "fixture" ? 2 : 3);
        await exec(`INSERT INTO work_external_tag_group_current(group_id,lifecycle_state,deleted_time,${eventColumns})
          VALUES ('support','DELETED',1,${supportEvent},'${corp}',lpad(to_hex(${supportEvent}),64,'0'),repeat('c',64),1,0)`);
      }
      if (prefix === "wgcpf") await exec(`INSERT INTO work_group_chat_current(corp_id,chat_id)
        SELECT '${corp}','chat_'||n FROM generate_series(1,${count}) n`);
      if (prefix === "wgcmc") await exec(`INSERT INTO work_group_chat_current(id,corp_id,chat_id)
        OVERRIDING SYSTEM VALUE VALUES (1,'${corp}','chat')`);
    }
    await exec(`WITH seed AS (SELECT n,
      CASE WHEN n<=50000 THEN 1 WHEN n<=100000 THEN 2 WHEN n=100001 THEN 3 WHEN n=100002 THEN 4 ELSE 5 END AS event_id,
      CASE WHEN (n>50000 AND n<=100000) OR n=100002 THEN 'other' ELSE 'fixture' END AS corp
      FROM generate_series(1,${count}) n)
      INSERT INTO public.${target.table}(${eventColumns},${data.columns})
      SELECT event_id,corp,lpad(to_hex(event_id),64,'0'),repeat('c',64),1,0,${data.values} FROM seed`);
    await exec(`ANALYZE public.${target.table}; ANALYZE public.work_callback_event`);
    const version = await query("SELECT current_setting('server_version_num') AS version") as { rows: Array<{ version: string }> };
    const fingerprint = (table: string) => query(`SELECT count(*)::int AS count,
      md5(string_agg(to_jsonb(x)::text,'' ORDER BY to_jsonb(x)::text)) AS digest FROM public.${table} x`);
    const catalog = () => query(`SELECT
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c WHERE c.conrelid='public.${target.table}'::regclass) AS constraints,
      (SELECT jsonb_agg(jsonb_build_object('oid',i.indexrelid,'definition',pg_get_indexdef(i.indexrelid),'metadata',to_jsonb(i)) ORDER BY i.indexrelid)
        FROM pg_index i WHERE i.indrelid='public.${target.table}'::regclass) AS indexes,
      (SELECT jsonb_agg(jsonb_build_object('column',a.attname,'target',a.attstattarget,'statistics',to_jsonb(s)) ORDER BY a.attnum,s.stainherit)
        FROM pg_attribute a LEFT JOIN pg_statistic s ON s.starelid=a.attrelid AND s.staattnum=a.attnum
        WHERE a.attrelid='public.${target.table}'::regclass AND a.attnum>0 AND NOT a.attisdropped) AS statistics`);
    const beforeRows = await fingerprint(target.table), beforeParents = await fingerprint("work_callback_event"), beforeCatalog = await catalog();
    expect(beforeRows.rows).toMatchObject([{ count }]);
    const distribution = await query(`SELECT corp_id,last_event_id,count(*)::int AS count FROM public.${target.table}
      GROUP BY corp_id,last_event_id ORDER BY last_event_id`);
    expect(distribution.rows).toEqual([
      { corp_id:"fixture",last_event_id:1,count:50000 },{ corp_id:"other",last_event_id:2,count:50000 },
      { corp_id:"fixture",last_event_id:3,count:1 },{ corp_id:"other",last_event_id:4,count:1 },{ corp_id:"fixture",last_event_id:5,count:1 },
    ]);
    const probes = [
      { name:"hotA",key:1,corp:"fixture",rows:50000 },{ name:"hotB",key:2,corp:"other",rows:50000 },
      { name:"rareA",key:3,corp:"fixture",rows:1 },{ name:"rareB",key:4,corp:"other",rows:1 },
      { name:"absentA",key:7,corp:"fixture",rows:0 },{ name:"absentB",key:6,corp:"other",rows:0 },
      { name:"wrongTenantA",key:1,corp:"other",rows:0 },{ name:"wrongTenantB",key:2,corp:"fixture",rows:0 },
    ];
    const probe = (key: number, corp: string) => sql`SELECT 1 FROM ONLY public.${sql.identifier(target.table)} x WHERE
      ${key}::integer OPERATOR(pg_catalog.=) x.last_event_id AND ${corp}::varchar OPERATOR(pg_catalog.=) x.corp_id
      AND ${key.toString(16).padStart(64,"0")}::varchar OPERATOR(pg_catalog.=) x.last_event_key
      AND ${"c".repeat(64)}::varchar OPERATOR(pg_catalog.=) x.last_event_subject_key_hash
      AND ${1}::integer OPERATOR(pg_catalog.=) x.last_event_time AND ${0}::integer OPERATOR(pg_catalog.=) x.last_sequence_rank FOR KEY SHARE OF x`;
    const measured: Array<{ name:string;expectedRows:number;custom:ReturnType<typeof summary>;generic:ReturnType<typeof summary> }> = [];
    for (const p of probes) {
      const custom = summary(explained(await db.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${probe(p.key,p.corp)}`)));
      const generic = await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL plan_cache_mode=force_generic_plan`);
        const built = new PgDialect().sqlToQuery(probe(p.key,p.corp));
        expect(built.params).toHaveLength(6);
        await tx.execute(sql.raw(`PREPARE audit_hot_fk AS ${built.sql}`));
        try { return summary(explained(await tx.execute(sql.raw(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
          EXECUTE audit_hot_fk(${p.key},'${p.corp}','${p.key.toString(16).padStart(64,"0")}','${"c".repeat(64)}',1,0)`)))); }
        finally { await tx.execute(sql`DEALLOCATE audit_hot_fk`); }
      });
      expect(custom.rows).toBe(p.rows); expect(generic.rows).toBe(p.rows);
      measured.push({ name:p.name,expectedRows:p.rows,custom,generic });
    }
    // Hot matches necessarily return many rows in these uncapped diagnostic
    // probes. Record costs without imposing the distinct-key fixture's <50
    // budget or claiming these are the nested RI trigger execution plans.
    for (const key of [1,2,3,4]) {
      for (const deletion of [true,false]) {
        const operation = deletion ? sql`DELETE FROM public.work_callback_event WHERE id=${key}`
          : sql`UPDATE public.work_callback_event SET sequence_rank=sequence_rank+1 WHERE id=${key}`;
        const error = await db.execute(operation).then(()=>undefined,error=>error as unknown);
        expect(message(error)).toContain(target.name);
        expect(error).toMatchObject({ cause:{ code: deletion && String(version.rows[0]?.version).startsWith("18") ? "23001" : "23503" } });
      }
    }
    for (const key of [6,7]) {
      for (const deletion of [true,false]) {
        const operation = deletion ? sql`DELETE FROM public.work_callback_event WHERE id=${key}`
          : sql`UPDATE public.work_callback_event SET sequence_rank=sequence_rank+1 WHERE id=${key}`;
        const rollback = new Error("restore unreferenced hot-fixture parent");
        await expect(db.transaction(async tx => {
          const actual = explained(await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${operation}`));
          expect(actual.Triggers).toContainEqual(expect.objectContaining({ "Constraint Name":target.name,Calls:1 }));
          throw rollback;
        })).rejects.toBe(rollback);
      }
    }
    const nestedPlans = fixture.withPeer ? await foreignKeyNestedPlans(fixture, {
      table: target.table, constraint: target.name, columns: target.columns,
      cases: [
        { name: "hotA", key: 1 }, { name: "hotB", key: 2 },
        { name: "rareA", key: 3 }, { name: "rareB", key: 4 },
        { name: "absentA", key: 7 }, { name: "absentB", key: 6 },
      ].map(p => ({ ...p, referenced: p.key <= 4,
        deleteStatement: `DELETE FROM public.work_callback_event WHERE id=${p.key}`,
        updateStatement: `UPDATE public.work_callback_event SET sequence_rank=sequence_rank+1 WHERE id=${p.key}` })),
    }) : [];
    if (fixture.withPeer) expect(nestedPlans).toHaveLength(46);
    expect(await fingerprint(target.table)).toEqual(beforeRows);
    expect(await fingerprint("work_callback_event")).toEqual(beforeParents);
    expect(await catalog()).toEqual(beforeCatalog);
    process.stdout.write("WORK_HOT_COMPOSITE_FK_AUDIT " + JSON.stringify({ target:target.name,version:version.rows[0]?.version,
      rows:count,distribution:distribution.rows,measured,actualParentRejections:8,unreferencedParentRollbacks:4,
      parentAndChildRowsUnchanged:true,indexesConstraintsAndStatisticsUnchanged:true,addedIndexes:0,
      selectiveProbesUnder50:measured.filter(p=>p.expectedRows<=1).every(p=>p.custom.buffers<50 && p.generic.buffers<50),
      nestedTriggerPlanCaptured:nestedPlans.length>0,nestedPlans,performanceAcceptance:false,productionLatencyClaim:false }) + "\n");
  },180000);
});
