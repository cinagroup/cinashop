/** Catalog definitions, never business rows. Run all compared paths on the same engine. */
export type CatalogRow = { key: string; name: string; table?: string; [field: string]: unknown };
export type CatalogKind = "tables" | "columns" | "constraints" | "indexes" | "sequences";
export type Catalog = Record<CatalogKind, CatalogRow[]>;
export const catalogKinds: CatalogKind[] = ["tables", "columns", "constraints", "indexes", "sequences"];
export type CatalogQuery = (query: string) => Promise<CatalogRow[]>;

export async function readCatalog(query: CatalogQuery): Promise<Catalog> {
  // NOT NULL appears in pg_constraint only on PG18+. Its semantic state is
  // always included as columns.notNull; it must not be counted a second time.
  const tables = await query(`SELECT c.relname AS key, c.relname AS name,
    c.relkind::text AS kind, c.relpersistence::text AS persistence,
    c.relrowsecurity AS "rowSecurity", c.relforcerowsecurity AS "forceRowSecurity",
    c.relispartition AS partition, pg_get_partkeydef(c.oid) AS "partitionKey"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  const columns = await query(`SELECT c.relname||'.'||a.attname AS key, a.attname AS name, c.relname AS "table",
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS "notNull",
    pg_get_expr(d.adbin,d.adrelid) AS "default", a.attidentity::text AS identity,
    a.attgenerated::text AS generated,
    CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END AS collation
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attname`);
  const constraints = await query(`SELECT t.relname||'.'||c.conname AS key, c.conname AS name, t.relname AS "table",
    c.contype::text AS type, pg_get_constraintdef(c.oid,false) AS definition,
    c.convalidated AS validated, c.condeferrable AS deferrable, c.condeferred AS deferred,
    c.connoinherit AS "noInherit", c.conislocal AS local, c.coninhcount AS "inheritCount"
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND c.contype<>'n' ORDER BY t.relname,c.conname`);
  const indexes = await query(`SELECT t.relname||'.'||c.relname AS key, c.relname AS name, t.relname AS "table",
    -- Strip only the exact server-quoted index-name prefix, not SQL expressions.
    substring(pg_get_indexdef(i.indexrelid) FROM length('CREATE '||CASE WHEN i.indisunique THEN 'UNIQUE ' ELSE '' END||'INDEX '||quote_ident(c.relname)||' ON ')+1) AS definition,
    i.indisunique AS unique, i.indisprimary AS primary, i.indisvalid AS valid, i.indisready AS ready,
    i.indnullsnotdistinct AS "nullsNotDistinct", i.indisreplident AS "replicaIdentity",
    EXISTS(SELECT 1 FROM pg_constraint owner WHERE owner.conindid=i.indexrelid AND owner.contype IN ('p','u','x')) AS "constraintOwned"
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY t.relname,c.relname`);
  const sequences = await query(`SELECT c.relname AS key, c.relname AS name, format_type(s.seqtypid,NULL) AS type,
    s.seqstart::text AS start, s.seqmin::text AS min, s.seqmax::text AS max,
    s.seqincrement::text AS increment, s.seqcache::text AS cache, s.seqcycle AS cycle,
    (SELECT tn.nspname||'.'||t.relname||'.'||a.attname FROM pg_depend d
      JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass
        AND d.deptype IN ('a','i')) AS "ownedBy"
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname`);
  return { tables, columns, constraints, indexes, sequences };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function structure({ key: _key, name: _name, ...rest }: CatalogRow): string {
  return stable(rest);
}

/** Exact named contracts already reconciled; this never waives other drift. */
export function assertIndexContracts(reference: Catalog, candidate: Catalog, keys: readonly string[]): void {
  if (!keys.length || keys.some((key) => typeof key !== "string" || !key) || new Set(keys).size !== keys.length) {
    throw new Error("Invalid or duplicate required index contracts");
  }
  const left = new Map(reference.indexes.map((row) => [row.key, row]));
  const right = new Map(candidate.indexes.map((row) => [row.key, row]));
  if (left.size !== reference.indexes.length || right.size !== candidate.indexes.length) {
    throw new Error("Duplicate indexes catalog identity");
  }
  for (const key of keys) {
    if (!left.has(key)) throw new Error(`Required reference index missing: ${key}`);
    if (!right.has(key)) throw new Error(`Required candidate index missing: ${key}`);
    if (stable(left.get(key)) !== stable(right.get(key))) throw new Error(`Index contract drift: ${key}`);
  }
}

/** Exact duplicate-definition evidence only; prefix coverage is not equivalence. */
export function classifyMissingIndexes(reference: Catalog, candidate: Catalog) {
  const names = new Set(candidate.indexes.map((row) => row.key));
  return reference.indexes.filter((row) => !names.has(row.key)).map((row) => ({
    reference: row.key,
    exactCandidates: candidate.indexes.filter((other) => structure(row) === structure(other)).map((other) => other.key),
  }));
}

export function compareCatalogs(reference: Catalog, candidate: Catalog) {
  return Object.fromEntries(catalogKinds.map((kind) => {
    const map = (rows: CatalogRow[]) => {
      const result = new Map(rows.map((row) => [row.key, row]));
      if (result.size !== rows.length) throw new Error(`Duplicate ${kind} catalog identity`);
      return result;
    };
    const left = map(reference[kind]);
    const right = map(candidate[kind]);
    const referenceOnly = [...left.values()].filter((row) => !right.has(row.key));
    const candidateOnly = [...right.values()].filter((row) => !left.has(row.key));
    const changed = [...left.values()].filter((row) => right.has(row.key)).flatMap((row) => {
      const other = right.get(row.key)!;
      const fields = [...new Set([...Object.keys(row), ...Object.keys(other)])].filter((key) => stable(row[key]) !== stable(other[key])).sort();
      return fields.length ? [{ key: row.key, fields, reference: row, candidate: other }] : [];
    });
    // Evidence for review, not an automatic rename or an equivalence waiver.
    const possibleRenames = kind === "indexes" || kind === "constraints"
      ? referenceOnly.flatMap((row) => {
        const matches = candidateOnly.filter((other) => structure(row) === structure(other));
        return matches.length === 1 && referenceOnly.filter((other) => structure(row) === structure(other)).length === 1
          ? [{ reference: row.key, candidate: matches[0].key }] : [];
      }) : [];
    return [kind, { referenceOnly, candidateOnly, changed, possibleRenames }];
  })) as Record<CatalogKind, {
    referenceOnly: CatalogRow[]; candidateOnly: CatalogRow[];
    changed: Array<{ key: string; fields: string[]; reference: CatalogRow; candidate: CatalogRow }>;
    possibleRenames: Array<{ reference: string; candidate: string }>;
  }>;
}

export function summarizeCatalogDiff(diff: ReturnType<typeof compareCatalogs>) {
  return Object.fromEntries(catalogKinds.map((kind) => [kind, {
    referenceOnly: diff[kind].referenceOnly.length, candidateOnly: diff[kind].candidateOnly.length,
    changed: diff[kind].changed.length, possibleRenames: diff[kind].possibleRenames.length,
  }]));
}
