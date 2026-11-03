import { describe, expect, it } from 'vitest';
import { catalogKinds, type CatalogRow } from '../scripts/data-migration/postgres-catalog-audit';
import { compareInstalledPublicCatalogs, installedPublicCatalogKinds, installedPublicCatalogQueries,
  readInstalledPublicCatalog, summarizeInstalledPublicCatalogDiff, type InstalledPublicCatalog,
  type InstalledPublicCatalogKind } from '../scripts/data-migration/installed-public-catalog';

function sample(): InstalledPublicCatalog {
  const extensions: Record<InstalledPublicCatalogKind, CatalogRow[]> = {
    columnAttributes: [], relationAttributes: [], routines: [], triggers: [], views: [], policies: [],
    objectOwners: [], acls: [], defaultAcls: [], roles: [], roleMemberships: [], unsupportedObjects: [],
  };
  extensions.columnAttributes = [{ key: 'public.probe.#1', name: 'id', relation: 'public.probe', ordinal: 1,
    dropped: false, typeIdentity: 'pg_catalog.int4', typeModifier: -1, dimensions: 0, notNull: true,
    identity: '', generated: '', local: true, inheritCount: 0, storage: 'p', compression: '',
    statisticsTarget: -1, options: null, foreignOptions: null, default: null, collation: null }];
  extensions.relationAttributes = [{ key: 'public.probe', name: 'probe', kind: 'r', persistence: 'p',
    attributeCount: 1, checkCount: 0, hasIndex: false, hasRules: false, hasTriggers: true, hasSubclass: false,
    rowSecurity: true, forceRowSecurity: false, populated: true, replicaIdentity: 'd', partition: false,
    options: null, accessMethod: 'heap', tablespace: null, ofType: null, partitionBound: null, parents: [] }];
  extensions.routines = [{ key: 'public.guard()', name: 'guard', kind: 'f', arguments: '', result: 'trigger',
    resultType: 'pg_catalog.trigger', definition: 'CREATE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    source: ' BEGIN RETURN NEW; END ', binary: null, config: ['search_path=pg_catalog, public'], language: 'plpgsql',
    languageTrusted: true, securityDefiner: false, leakproof: false, strict: false, returnsSet: false,
    volatility: 'v', parallel: 'u', cost: 100, rows: 0, argumentCount: 0, defaultCount: 0, argumentNames: null,
    argumentModes: null, argumentTypes: [], allArgumentTypes: null, variadicType: null, support: null,
    defaults: null, transformTypes: null, owner: 'fixture_owner' }];
  extensions.triggers = [{ key: 'public.probe.guard', name: 'guard', relation: 'public.probe',
    definition: 'CREATE TRIGGER guard BEFORE INSERT ON public.probe FOR EACH ROW WHEN ((new.id > 0)) EXECUTE FUNCTION public.guard()',
    type: 7, enabled: 'O', internal: false, routine: 'public.guard()', argumentCount: 0, arguments: '',
    columnNumbers: '', hasCondition: true, deferrable: false, initiallyDeferred: false, constraintRelation: null,
    constraintIndex: null, constraint: null, parent: null, oldTransitionTable: null, newTransitionTable: null }];
  extensions.views = [{ key: 'public.visible_probe', name: 'visible_probe', kind: 'v',
    definition: 'SELECT probe.id FROM public.probe;', options: ['security_barrier=true'], populated: true,
    rules: [{ name: '_RETURN', event: '1', enabled: 'O', instead: true,
      definition: 'CREATE RULE "_RETURN" AS ON SELECT TO public.visible_probe DO INSTEAD SELECT probe.id FROM public.probe;' }] }];
  extensions.policies = [{ key: 'public.probe.visible', name: 'visible', relation: 'public.probe',
    command: 'r', permissive: true, roles: ['PUBLIC'], using: '(id > 0)', withCheck: null }];
  extensions.objectOwners = [{ key: 'schema:public', name: 'public', kind: 'schema', owner: 'fixture_owner' }];
  const entries = [{ grantor: 'fixture_owner', grantee: 'PUBLIC', privilege: 'USAGE', grantable: false }];
  extensions.acls = [{ key: 'schema:public', name: 'public', kind: 'schema', aclIsNull: false, entries }];
  extensions.defaultAcls = [{ key: 'default:public:fixture_owner:r', name: 'fixture_owner', namespace: 'public',
    objectType: 'r', owner: 'fixture_owner', entries: [{ grantor: 'fixture_owner', grantee: 'fixture_reader', privilege: 'SELECT', grantable: false }] }];
  extensions.roles = [{ key: 'fixture_owner', name: 'fixture_owner', superuser: false, inherit: false,
    createRole: false, createDatabase: false, login: false, replication: false, bypassRls: false,
    connectionLimit: -1, validUntil: null, config: null, settings: [] }];
  extensions.roleMemberships = [{ key: 'fixture_reader>fixture_member@fixture_owner', name: 'fixture_member',
    role: 'fixture_reader', member: 'fixture_member', grantor: 'fixture_owner', admin: false, inherit: true, setRole: false }];
  return { base: { tables: [{ key: 'probe', name: 'probe', kind: 'r', persistence: 'p', rowSecurity: true,
    forceRowSecurity: false, partition: false, partitionKey: null }], columns: [], constraints: [], indexes: [], sequences: [] },
  extensions, identities: [{ key: 'schema:public', name: 'public', kind: 'schema', oid: '2200', references: { owner: '100' } }],
  context: { key: 'context', name: 'context', database: 'owned_fixture_a', currentUser: 'maintenance', sessionUser: 'maintenance',
    serverVersionNum: 160010, isolation: 'repeatable read', readOnly: 'on', searchPath: 'pg_catalog, public' },
  scope: { version: 1, schema: 'public', engineMajor: 16, queriesReadOnly: true, identityObservationsCompared: false,
    roleNamesNormalized: false, fullInstallationEquivalence: false, effectivePrivilegesProven: false, unsupportedObjectsPresent: false } };
}

function reader(model: InstalledPublicCatalog, seen: string[] = []) {
  let baseIndex = 0;
  return async (query: string): Promise<CatalogRow[]> => {
    seen.push(query);
    if (query.includes("current_setting('transaction_read_only')")) return [structuredClone(model.context)];
    const extension = installedPublicCatalogKinds.find(kind => installedPublicCatalogQueries[kind] === query);
    if (extension) return structuredClone(model.extensions[extension]);
    if (query.includes('AS "references"')) return structuredClone(model.identities);
    const kind = catalogKinds[baseIndex++];
    if (!kind) throw new Error('Unexpected catalog query');
    return structuredClone(model.base[kind]);
  };
}

describe('actual installed public metadata read port, without normalization or full-equivalence claims', () => {
  it('reads all old categories, all added categories and separate raw identities using SELECT-only queries', async () => {
    const expected = sample(), seen: string[] = [];
    const actual = await readInstalledPublicCatalog(reader(expected, seen));
    expect(actual).toEqual(expected);
    expect(seen).toHaveLength(1 + 5 + 12 + 1);
    expect(seen.every(query => /^\s*(SELECT|WITH RECURSIVE)\b/.test(query))).toBe(true);
    expect(seen.join('\n')).not.toMatch(/\brolpassword\b|\bpg_authid\b/);
    expect(actual.scope.fullInstallationEquivalence).toBe(false);
    expect(actual.scope.effectivePrivilegesProven).toBe(false);
  });

  it('does not equate changed object OIDs with changed definitions or normalize actual roles and bodies', () => {
    const left = sample(), right = structuredClone(left);
    right.identities[0]!.oid = '9999'; right.identities[0]!.references.owner = '200';
    right.context.database = 'owned_fixture_b';
    expect(compareInstalledPublicCatalogs(left, right).equal).toBe(true);
    right.extensions.routines[0]!.source = ' BEGIN RETURN NEW; END  ';
    expect(compareInstalledPublicCatalogs(left, right).extensions.routines.changed[0]!.fields).toEqual(['source']);
    right.extensions.routines[0]!.owner = 'cinashop_runtime_ffffffffffffffffffffffffffffffff';
    expect(compareInstalledPublicCatalogs(left, right).extensions.routines.changed[0]!.fields).toEqual(['owner', 'source']);
  });

  it.each([
    ['columnAttributes', 'ordinal', 2], ['columnAttributes', 'dropped', true],
    ['relationAttributes', 'replicaIdentity', 'f'], ['routines', 'securityDefiner', true],
    ['routines', 'config', ['search_path=public']], ['triggers', 'enabled', 'D'],
    ['triggers', 'internal', true], ['views', 'options', ['security_invoker=true']],
    ['policies', 'roles', ['fixture_reader']], ['objectOwners', 'owner', 'another_owner'],
    ['acls', 'aclIsNull', true], ['roles', 'login', true], ['roleMemberships', 'admin', true],
  ] as const)('reports the actual %s.%s difference', (kind, field, changed) => {
    const left = sample(), right = structuredClone(left);
    right.extensions[kind][0]![field] = changed;
    const diff = compareInstalledPublicCatalogs(left, right), summary = summarizeInstalledPublicCatalogDiff(diff);
    expect(diff.equal).toBe(false); expect(diff.extensions[kind].changed[0]!.fields).toEqual([field]);
    expect(summary.extensions[kind].changed).toBe(1);
    expect(summary.fullInstallationEquivalence).toBe(false);
  });

  it.each(['acls', 'defaultAcls'] as const)('keeps grantor, grantee, privilege and grant option changes in %s', kind => {
    const left = sample(), right = structuredClone(left);
    right.extensions[kind][0]!.entries = [{ grantor: 'other_grantor', grantee: 'PUBLIC', privilege: 'CREATE', grantable: true }];
    expect(compareInstalledPublicCatalogs(left, right).extensions[kind].changed[0]!.fields).toEqual(['entries']);
  });

  it('keeps internal trigger identities and parent/constraint relationships visible without suffix rewriting', () => {
    const left = sample(), right = structuredClone(left);
    left.extensions.triggers[0]!.key = 'public.probe.RI_ConstraintTrigger_c_123';
    left.extensions.triggers[0]!.name = 'RI_ConstraintTrigger_c_123';
    left.extensions.triggers[0]!.internal = true;
    right.extensions.triggers[0]!.key = 'public.probe.RI_ConstraintTrigger_c_456';
    right.extensions.triggers[0]!.name = 'RI_ConstraintTrigger_c_456';
    right.extensions.triggers[0]!.internal = true;
    const diff = compareInstalledPublicCatalogs(left, right);
    expect(diff.extensions.triggers.referenceOnly).toHaveLength(1);
    expect(diff.extensions.triggers.candidateOnly).toHaveLength(1); expect(diff.equal).toBe(false);
  });

  it('rejects an unsupported object even when both sides contain the same unmodelled object', async () => {
    const left = sample(); left.extensions.unsupportedObjects = [{ key: 'type:public.secret_enum', name: 'public.secret_enum', kind: 'user-defined-type', detail: 'e' }];
    const actual = await readInstalledPublicCatalog(reader(left));
    expect(actual.scope.unsupportedObjectsPresent).toBe(true);
    const diff = compareInstalledPublicCatalogs(actual, structuredClone(actual));
    expect(diff.equal).toBe(false); expect(diff.unsupported).toEqual({ reference: 1, candidate: 1 });
    expect(diff.extensions.unsupportedObjects.changed).toEqual([]);
  });

  it.each(['isolation', 'readOnly', 'serverVersionNum'] as const)('refuses a non-PG16 stable readonly snapshot: %s', async field => {
    const catalog = sample(), seen: string[] = [];
    catalog.context[field] = field === 'serverVersionNum' ? 170000 : field === 'isolation' ? 'read committed' : 'off';
    await expect(readInstalledPublicCatalog(reader(catalog, seen))).rejects.toThrow('PG16 REPEATABLE READ READ ONLY');
    expect(seen).toHaveLength(1);
  });

  it.each(['missing', 'extra', 'undefined', 'boolean-string', 'duplicate', 'acl-entry'] as const)(
    'refuses %s metadata instead of accepting symmetric omissions', kind => {
      const catalog = sample();
      if (kind === 'missing') delete catalog.extensions.routines[0]!.source;
      if (kind === 'extra') catalog.extensions.routines[0]!.unreviewed = true;
      if (kind === 'undefined') catalog.extensions.routines[0]!.source = undefined;
      if (kind === 'boolean-string') catalog.extensions.triggers[0]!.internal = 'false';
      if (kind === 'duplicate') catalog.extensions.objectOwners.push({ ...catalog.extensions.objectOwners[0]! });
      if (kind === 'acl-entry') catalog.extensions.acls[0]!.entries = [{ grantor: 'owner', grantee: 'PUBLIC', privilege: 'USAGE', grantable: 'false' }];
      expect(() => compareInstalledPublicCatalogs(catalog, structuredClone(catalog))).toThrow();
    },
  );

  it('rejects an unknown category, a stronger scope claim and an engine-version mismatch', () => {
    const left = sample(), right = structuredClone(left);
    Object.assign(right.extensions, { fabricated: [] });
    expect(() => compareInstalledPublicCatalogs(left, right)).toThrow('Missing or unknown');
    delete (right.extensions as Record<string, unknown>).fabricated;
    Object.assign(right.scope, { fullInstallationEquivalence: true });
    expect(() => compareInstalledPublicCatalogs(left, right)).toThrow('Unexpected installed public catalog scope');
    right.scope.fullInstallationEquivalence = false; right.context.serverVersionNum = 160011;
    expect(() => compareInstalledPublicCatalogs(left, right)).toThrow('same PostgreSQL engine version');
  });

  it('keeps the OLD/NEW condition in the complete trigger definition and its raw tree only in observations', () => {
    const query = installedPublicCatalogQueries.triggers;
    expect(query).toContain('pg_catalog.pg_get_triggerdef(t.oid,false)');
    expect(query).toContain('t.tgqual IS NOT NULL AS "hasCondition"');
    expect(query).not.toContain('pg_get_expr(t.tgqual');
    expect(query).not.toMatch(/NOT\s+t\.tgisinternal/);
    expect(query).toContain('t.tgoldtable'); expect(query).toContain('t.tgnewtable');
  });

  it('covers unsupported public object families and restricts role reads to public participants and membership closure', () => {
    const unsupported = installedPublicCatalogQueries.unsupportedObjects;
    for (const catalog of ['pg_type', 'pg_extension', 'pg_operator', 'pg_opclass', 'pg_opfamily', 'pg_collation',
      'pg_conversion', 'pg_statistic_ext', 'pg_ts_config', 'pg_ts_dict', 'pg_ts_parser', 'pg_ts_template', 'pg_rewrite'])
      expect(unsupported).toContain(`pg_catalog.${catalog}`);
    expect(unsupported).toContain("p.prokind NOT IN ('f','p')");
    expect(unsupported).toContain('t.typacl IS NOT NULL');
    expect(installedPublicCatalogQueries.roles).toContain('WHERE r.oid IN (SELECT oid FROM participants)');
    expect(installedPublicCatalogQueries.roles).toContain('JOIN closure c ON c.oid=e.from_role');
    expect(installedPublicCatalogQueries.roleMemberships).toContain('a.inherit_option');
    expect(installedPublicCatalogQueries.roleMemberships).toContain('a.set_option');
    expect(installedPublicCatalogQueries.acls).toContain("THEN 's'::\"char\"");
    expect(installedPublicCatalogQueries.acls).toContain('pg_catalog.aclexplode(col.attacl)');
    expect(installedPublicCatalogQueries.acls).not.toContain("COALESCE(col.attacl,'{}'::aclitem[])");
  });
});
