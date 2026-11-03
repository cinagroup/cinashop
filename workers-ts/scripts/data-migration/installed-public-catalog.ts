import {
  catalogKinds, compareCatalogs, readCatalog, summarizeCatalogDiff,
  type Catalog, type CatalogQuery, type CatalogRow,
} from './postgres-catalog-audit';

export const installedPublicCatalogKinds = [
  'columnAttributes', 'relationAttributes', 'routines', 'triggers', 'views', 'policies',
  'objectOwners', 'acls', 'defaultAcls', 'roles', 'roleMemberships', 'unsupportedObjects',
] as const;
export type InstalledPublicCatalogKind = typeof installedPublicCatalogKinds[number];
export interface InstalledObjectObservation extends CatalogRow {
  kind: string;
  oid: string;
  references: Record<string, unknown>;
}
export interface InstalledPublicCatalog {
  base: Catalog;
  extensions: Record<InstalledPublicCatalogKind, CatalogRow[]>;
  identities: InstalledObjectObservation[];
  context: CatalogRow;
  scope: {
    version: 1; schema: 'public'; engineMajor: 16; queriesReadOnly: true;
    identityObservationsCompared: false; roleNamesNormalized: false;
    fullInstallationEquivalence: false; effectivePrivilegesProven: false;
    unsupportedObjectsPresent: boolean;
  };
}

const routineIdentity = (alias: string) =>
  `pg_catalog.format('%I.%I(%s)',pn.nspname,${alias}.proname,pg_catalog.pg_get_function_identity_arguments(${alias}.oid))`;
const relationIdentity = (alias: string) => `pg_catalog.format('%I.%I',n.nspname,${alias}.relname)`;
const qualifiedRelation = (oid: string) => `(SELECT pg_catalog.format('%I.%I',rn.nspname,rc.relname)
  FROM pg_catalog.pg_class rc JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace WHERE rc.oid=${oid})`;
const qualifiedRoutine = (oid: string) => `(SELECT pg_catalog.format('%I.%I(%s)',rn.nspname,rp.proname,
  pg_catalog.pg_get_function_identity_arguments(rp.oid)) FROM pg_catalog.pg_proc rp
  JOIN pg_catalog.pg_namespace rn ON rn.oid=rp.pronamespace WHERE rp.oid=${oid})`;
const qualifiedType = (oid: string) => `(SELECT pg_catalog.format('%I.%I',tn.nspname,ty.typname)
  FROM pg_catalog.pg_type ty JOIN pg_catalog.pg_namespace tn ON tn.oid=ty.typnamespace WHERE ty.oid=${oid})`;
const roleName = (oid: string) => `CASE WHEN ${oid}=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(${oid}) END`;
const aclEntries = (acl: string) => `COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'grantor',${roleName('a.grantor')},'grantee',${roleName('a.grantee')},
  'privilege',a.privilege_type,'grantable',a.is_grantable)
  ORDER BY ${roleName('a.grantor')},${roleName('a.grantee')},a.privilege_type,a.is_grantable)
  FROM pg_catalog.aclexplode(${acl}) a),'[]'::jsonb)`;

// Only roles connected to public owners/ACL/policies/default privileges are
// read. No password field or indiscriminate cluster-wide role snapshot exists.
// Membership closure is bidirectional: both inherited authority and members of
// a granted group matter. The grantor is observed, not a wildcard traversal.
const roleScope = `WITH RECURSIVE
  public_acl AS (
    SELECT a.grantor,a.grantee FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE n.nspname='public'
    UNION ALL SELECT a.grantor,a.grantee FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')
    UNION ALL SELECT a.grantor,a.grantee FROM pg_catalog.pg_attribute col JOIN pg_catalog.pg_class c ON c.oid=col.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a WHERE c.relnamespace='public'::regnamespace AND col.attnum>0
    UNION ALL SELECT a.grantor,a.grantee FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE p.pronamespace='public'::regnamespace
  ), seeds(oid) AS (
    SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='public'
    UNION SELECT relowner FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
    UNION SELECT proowner FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
    UNION SELECT typowner FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
    UNION SELECT x FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
      CROSS JOIN LATERAL unnest(p.polroles) x WHERE c.relnamespace='public'::regnamespace
    UNION SELECT grantor FROM public_acl UNION SELECT grantee FROM public_acl
    UNION SELECT defaclrole FROM pg_catalog.pg_default_acl WHERE defaclnamespace='public'::regnamespace
    UNION SELECT a.grantor FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE d.defaclnamespace='public'::regnamespace
    UNION SELECT a.grantee FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a WHERE d.defaclnamespace='public'::regnamespace
    UNION SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database()
  ), edges(from_role,to_role) AS (
    SELECT roleid,member FROM pg_catalog.pg_auth_members UNION SELECT member,roleid FROM pg_catalog.pg_auth_members
    UNION SELECT d.defaclrole,a.grantor FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE d.defaclnamespace IN (0,'public'::regnamespace)
    UNION SELECT d.defaclrole,a.grantee FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE d.defaclnamespace IN (0,'public'::regnamespace)
  ), closure(oid) AS (
    SELECT oid FROM seeds WHERE oid<>0 UNION SELECT e.to_role FROM edges e JOIN closure c ON c.oid=e.from_role WHERE e.to_role<>0
  ), memberships AS (
    SELECT m.* FROM pg_catalog.pg_auth_members m WHERE m.member IN (SELECT oid FROM closure) OR m.roleid IN (SELECT oid FROM closure)
  ), participants(oid) AS (
    SELECT oid FROM closure UNION SELECT grantor FROM memberships
  )`;

export const installedPublicCatalogQueries: Record<InstalledPublicCatalogKind, string> = {
  columnAttributes: `SELECT pg_catalog.format('%I.%I.#%s',n.nspname,c.relname,a.attnum) AS key,
    a.attname AS name,${relationIdentity('c')} AS relation,a.attnum::integer AS ordinal,
    a.attisdropped AS dropped,${qualifiedType('a.atttypid')} AS "typeIdentity",
    a.atttypmod AS "typeModifier",a.attndims AS dimensions,a.attnotnull AS "notNull",
    a.attidentity::text AS identity,a.attgenerated::text AS generated,
    a.attislocal AS local,a.attinhcount AS "inheritCount",a.attstorage::text AS storage,
    a.attcompression::text AS compression,a.attstattarget AS "statisticsTarget",
    a.attoptions AS options,a.attfdwoptions AS "foreignOptions",
    pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS "default",
    CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END AS collation
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' ORDER BY key`,
  relationAttributes: `SELECT ${relationIdentity('c')} AS key,c.relname AS name,c.relkind::text AS kind,
    c.relpersistence::text AS persistence,c.relnatts::integer AS "attributeCount",c.relchecks::integer AS "checkCount",
    c.relhasindex AS "hasIndex",c.relhasrules AS "hasRules",c.relhastriggers AS "hasTriggers",
    c.relhassubclass AS "hasSubclass",c.relrowsecurity AS "rowSecurity",c.relforcerowsecurity AS "forceRowSecurity",
    c.relispopulated AS populated,c.relreplident::text AS "replicaIdentity",c.relispartition AS partition,
    c.reloptions AS options,am.amname AS "accessMethod",ts.spcname AS tablespace,
    ${qualifiedType('c.reloftype')} AS "ofType",
    pg_catalog.pg_get_expr(c.relpartbound,c.oid,false) AS "partitionBound",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',${qualifiedRelation('h.inhparent')},
      'sequence',h.inhseqno,'detachPending',h.inhdetachpending) ORDER BY h.inhseqno)
      FROM pg_catalog.pg_inherits h WHERE h.inhrelid=c.oid),'[]'::jsonb) AS parents
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid=c.reltablespace
    WHERE n.nspname='public' ORDER BY key`,
  routines: `SELECT ${routineIdentity('p')} AS key,p.proname AS name,p.prokind::text AS kind,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.pg_get_function_result(p.oid) AS result,${qualifiedType('p.prorettype')} AS "resultType",
    CASE WHEN p.prokind IN ('f','p') THEN pg_catalog.pg_get_functiondef(p.oid) ELSE NULL END AS definition,
    p.prosrc AS source,p.probin AS binary,p.proconfig AS config,
    l.lanname AS language,l.lanpltrusted AS "languageTrusted",p.prosecdef AS "securityDefiner",
    p.proleakproof AS leakproof,p.proisstrict AS strict,p.proretset AS "returnsSet",
    p.provolatile::text AS volatility,p.proparallel::text AS parallel,p.procost AS cost,p.prorows AS rows,
    p.pronargs::integer AS "argumentCount",p.pronargdefaults::integer AS "defaultCount",
    p.proargnames AS "argumentNames",p.proargmodes AS "argumentModes",
    ARRAY(SELECT ${qualifiedType('x')} FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(x,ord) ORDER BY ord) AS "argumentTypes",
    CASE WHEN p.proallargtypes IS NULL THEN NULL ELSE ARRAY(SELECT ${qualifiedType('x')} FROM unnest(p.proallargtypes) WITH ORDINALITY a(x,ord) ORDER BY ord) END AS "allArgumentTypes",
    ${qualifiedType('p.provariadic')} AS "variadicType",${qualifiedRoutine('p.prosupport')} AS support,
    pg_catalog.pg_get_expr(p.proargdefaults,0,false) AS defaults,
    CASE WHEN p.protrftypes IS NULL THEN NULL ELSE ARRAY(SELECT ${qualifiedType('x')} FROM unnest(p.protrftypes) WITH ORDINALITY a(x,ord) ORDER BY ord) END AS "transformTypes",
    pg_catalog.pg_get_userbyid(p.proowner) AS owner
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE pn.nspname='public' ORDER BY key`,
  triggers: `SELECT pg_catalog.format('%I.%I.%I',n.nspname,c.relname,t.tgname) AS key,t.tgname AS name,
    ${relationIdentity('c')} AS relation,pg_catalog.pg_get_triggerdef(t.oid,false) AS definition,
    t.tgtype::integer AS type,t.tgenabled::text AS enabled,t.tgisinternal AS internal,
    ${qualifiedRoutine('t.tgfoid')} AS routine,t.tgnargs::integer AS "argumentCount",encode(t.tgargs,'hex') AS arguments,
    t.tgattr::text AS "columnNumbers",t.tgqual IS NOT NULL AS "hasCondition",
    t.tgdeferrable AS deferrable,t.tginitdeferred AS "initiallyDeferred",
    ${qualifiedRelation('t.tgconstrrelid')} AS "constraintRelation",${qualifiedRelation('t.tgconstrindid')} AS "constraintIndex",
    (SELECT pg_catalog.format('%I.%I.%I',kn.nspname,kc.relname,k.conname)
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class kc ON kc.oid=k.conrelid
      JOIN pg_catalog.pg_namespace kn ON kn.oid=kc.relnamespace WHERE k.oid=t.tgconstraint) AS "constraint",
    (SELECT pg_catalog.format('%I.%I.%I',pn.nspname,pc.relname,pt.tgname) FROM pg_catalog.pg_trigger pt
      JOIN pg_catalog.pg_class pc ON pc.oid=pt.tgrelid JOIN pg_catalog.pg_namespace pn ON pn.oid=pc.relnamespace WHERE pt.oid=t.tgparentid) AS parent,
    t.tgoldtable AS "oldTransitionTable",t.tgnewtable AS "newTransitionTable"
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY key`,
  views: `SELECT ${relationIdentity('c')} AS key,c.relname AS name,c.relkind::text AS kind,
    pg_catalog.pg_get_viewdef(c.oid,false) AS definition,c.reloptions AS options,c.relispopulated AS populated,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name',r.rulename,'event',r.ev_type::text,
      'enabled',r.ev_enabled::text,'instead',r.is_instead,'definition',pg_catalog.pg_get_ruledef(r.oid,false)) ORDER BY r.rulename)
      FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb) AS rules
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY key`,
  policies: `SELECT pg_catalog.format('%I.%I.%I',n.nspname,c.relname,p.polname) AS key,p.polname AS name,
    ${relationIdentity('c')} AS relation,p.polcmd::text AS command,p.polpermissive AS permissive,
    ARRAY(SELECT ${roleName('x')} FROM unnest(p.polroles) x ORDER BY ${roleName('x')}) AS roles,
    pg_catalog.pg_get_expr(p.polqual,p.polrelid,false) AS "using",
    pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false) AS "withCheck"
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY key`,
  objectOwners: `SELECT 'schema:public' AS key,'public' AS name,'schema' AS kind,pg_catalog.pg_get_userbyid(nspowner) AS owner
    FROM pg_catalog.pg_namespace WHERE nspname='public'
    UNION ALL SELECT 'relation:'||${relationIdentity('c')},${relationIdentity('c')},'relation',pg_catalog.pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'routine:'||${routineIdentity('p')},${routineIdentity('p')},'routine',pg_catalog.pg_get_userbyid(p.proowner)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE pn.nspname='public'
    UNION ALL SELECT 'type:'||pg_catalog.format('%I.%I',n.nspname,t.typname),pg_catalog.format('%I.%I',n.nspname,t.typname),'type',pg_catalog.pg_get_userbyid(t.typowner)
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY key`,
  acls: `SELECT 'schema:public' AS key,'public' AS name,'schema' AS kind,n.nspacl IS NULL AS "aclIsNull",
    ${aclEntries("COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))")} AS entries
    FROM pg_catalog.pg_namespace n WHERE n.nspname='public'
    UNION ALL SELECT 'relation:'||${relationIdentity('c')},${relationIdentity('c')},'relation',c.relacl IS NULL,
    ${aclEntries("COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner))")}
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
    UNION ALL SELECT 'column:'||pg_catalog.format('%I.%I.#%s',n.nspname,c.relname,col.attnum),pg_catalog.format('%I.%I.%I',n.nspname,c.relname,col.attname),'column',col.attacl IS NULL,
    ${aclEntries('col.attacl')}
    FROM pg_catalog.pg_attribute col JOIN pg_catalog.pg_class c ON c.oid=col.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND col.attnum>0 AND c.relkind IN ('r','p','v','m','S','f')
    UNION ALL SELECT 'routine:'||${routineIdentity('p')},${routineIdentity('p')},'routine',p.proacl IS NULL,
    ${aclEntries("COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))")}
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE pn.nspname='public' ORDER BY key`,
  defaultAcls: `${roleScope}
    SELECT pg_catalog.format('default:%s:%I:%s',CASE WHEN d.defaclnamespace=0 THEN '<global>' ELSE 'public' END,r.rolname,d.defaclobjtype) AS key,
    r.rolname AS name,CASE WHEN d.defaclnamespace=0 THEN NULL ELSE 'public' END AS namespace,
    d.defaclobjtype::text AS "objectType",r.rolname AS owner,${aclEntries('d.defaclacl')} AS entries
    FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles r ON r.oid=d.defaclrole
    WHERE d.defaclnamespace='public'::regnamespace OR d.defaclnamespace=0 AND d.defaclrole IN (SELECT oid FROM closure) ORDER BY key`,
  roles: `${roleScope}
    SELECT r.rolname AS key,r.rolname AS name,r.rolsuper AS superuser,r.rolinherit AS inherit,
    r.rolcreaterole AS "createRole",r.rolcreatedb AS "createDatabase",r.rolcanlogin AS login,
    r.rolreplication AS replication,r.rolbypassrls AS "bypassRls",r.rolconnlimit AS "connectionLimit",
    r.rolvaliduntil::text AS "validUntil",r.rolconfig AS config,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('databaseScope',CASE WHEN s.setdatabase=0 THEN 'global' ELSE 'current' END,
      'config',s.setconfig) ORDER BY s.setdatabase=0 DESC) FROM pg_catalog.pg_db_role_setting s
      WHERE s.setrole=r.oid AND s.setdatabase IN (0,(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()))),'[]'::jsonb) AS settings
    FROM pg_catalog.pg_roles r WHERE r.oid IN (SELECT oid FROM participants) ORDER BY key`,
  roleMemberships: `${roleScope}
    SELECT pg_catalog.format('%I>%I@%I',r.rolname,m.rolname,g.rolname) AS key,m.rolname AS name,
    r.rolname AS role,m.rolname AS member,g.rolname AS grantor,a.admin_option AS admin,
    a.inherit_option AS inherit,a.set_option AS "setRole"
    FROM memberships a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid JOIN pg_catalog.pg_roles m ON m.oid=a.member
    JOIN pg_catalog.pg_roles g ON g.oid=a.grantor ORDER BY key`,
  unsupportedObjects: `SELECT 'relation:'||${relationIdentity('c')} AS key,${relationIdentity('c')} AS name,
    'relation-kind' AS kind,c.relkind::text AS detail FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind NOT IN ('r','p','i','I','S','v','m')
    UNION ALL SELECT 'routine:'||${routineIdentity('p')},${routineIdentity('p')},'routine-kind',p.prokind::text
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE pn.nspname='public' AND p.prokind NOT IN ('f','p')
    UNION ALL SELECT 'type:'||pg_catalog.format('%I.%I',n.nspname,t.typname),pg_catalog.format('%I.%I',n.nspname,t.typname),'user-defined-type',t.typtype::text
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
    AND NOT (t.typtype='c' AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind IN ('r','p','v','m')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type e JOIN pg_catalog.pg_class c ON c.oid=e.typrelid
      WHERE t.typelem=e.oid AND e.typarray=t.oid AND e.typtype='c' AND c.relkind IN ('r','p','v','m'))
    UNION ALL SELECT 'type-acl:'||pg_catalog.format('%I.%I',n.nspname,t.typname),t.typname,'type-acl','not-modelled'
      FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typacl IS NOT NULL
    UNION ALL SELECT 'extension:'||e.extname,e.extname,'extension',e.extversion FROM pg_catalog.pg_extension e
    WHERE e.extnamespace='public'::regnamespace OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e' AND
      (d.classid='pg_catalog.pg_class'::regclass AND d.objid IN(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace)
       OR d.classid='pg_catalog.pg_proc'::regclass AND d.objid IN(SELECT oid FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace)
       OR d.classid='pg_catalog.pg_type'::regclass AND d.objid IN(SELECT oid FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace)))
    UNION ALL SELECT 'operator:'||o.oid::regoperator::text,o.oid::regoperator::text,'operator','not-modelled' FROM pg_catalog.pg_operator o WHERE o.oprnamespace='public'::regnamespace
    UNION ALL SELECT 'opclass:'||pg_catalog.format('%I.%I/%I',n.nspname,o.opcname,a.amname),o.opcname,'operator-class','not-modelled'
      FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace JOIN pg_catalog.pg_am a ON a.oid=o.opcmethod WHERE n.nspname='public'
    UNION ALL SELECT 'opfamily:'||pg_catalog.format('%I.%I/%I',n.nspname,o.opfname,a.amname),o.opfname,'operator-family','not-modelled'
      FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid=o.opfnamespace JOIN pg_catalog.pg_am a ON a.oid=o.opfmethod WHERE n.nspname='public'
    UNION ALL SELECT 'collation:'||pg_catalog.format('%I.%I/%s',n.nspname,c.collname,c.collencoding),c.collname,'collation','not-modelled'
      FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'conversion:'||c.conname,c.conname,'conversion','not-modelled' FROM pg_catalog.pg_conversion c WHERE c.connamespace='public'::regnamespace
    UNION ALL SELECT 'statistics:'||s.stxname,s.stxname,'extended-statistics','not-modelled' FROM pg_catalog.pg_statistic_ext s WHERE s.stxnamespace='public'::regnamespace
    UNION ALL SELECT 'text-search-config:'||c.cfgname,c.cfgname,'text-search-config','not-modelled' FROM pg_catalog.pg_ts_config c WHERE c.cfgnamespace='public'::regnamespace
    UNION ALL SELECT 'text-search-dictionary:'||c.dictname,c.dictname,'text-search-dictionary','not-modelled' FROM pg_catalog.pg_ts_dict c WHERE c.dictnamespace='public'::regnamespace
    UNION ALL SELECT 'text-search-parser:'||c.prsname,c.prsname,'text-search-parser','not-modelled' FROM pg_catalog.pg_ts_parser c WHERE c.prsnamespace='public'::regnamespace
    UNION ALL SELECT 'text-search-template:'||c.tmplname,c.tmplname,'text-search-template','not-modelled' FROM pg_catalog.pg_ts_template c WHERE c.tmplnamespace='public'::regnamespace
    UNION ALL SELECT 'rule:'||pg_catalog.format('%I.%I.%I',n.nspname,c.relname,r.rulename),r.rulename,'rewrite-rule',pg_catalog.pg_get_ruledef(r.oid,false)
      FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT(c.relkind IN('v','m') AND r.rulename='_RETURN') ORDER BY key`,
};

const contextQuery = `SELECT 'context' AS key,'context' AS name,current_database() AS database,
  current_user AS "currentUser",session_user AS "sessionUser",current_setting('server_version_num')::integer AS "serverVersionNum",
  current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly",
  current_setting('search_path') AS "searchPath"`;
const identityQuery = `${roleScope}
  SELECT 'schema:public' AS key,'public' AS name,'schema' AS kind,n.oid::text AS oid,jsonb_build_object('owner',n.nspowner::text) AS "references" FROM pg_catalog.pg_namespace n WHERE n.nspname='public'
  UNION ALL SELECT 'relation:'||${relationIdentity('c')},${relationIdentity('c')},'relation',c.oid::text,jsonb_build_object('owner',c.relowner::text,'file',c.relfilenode::text,'rowType',c.reltype::text)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'routine:'||${routineIdentity('p')},${routineIdentity('p')},'routine',p.oid::text,
    jsonb_build_object('owner',p.proowner::text,'argumentTypes',p.proargtypes::text,'allArgumentTypes',p.proallargtypes::text,'result',p.prorettype::text,'sqlBody',p.prosqlbody::text,'argumentDefaults',p.proargdefaults::text)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE pn.nspname='public'
  UNION ALL SELECT 'trigger:'||pg_catalog.format('%I.%I.%I',n.nspname,c.relname,t.tgname),t.tgname,'trigger',t.oid::text,
    jsonb_build_object('relation',t.tgrelid::text,'routine',t.tgfoid::text,'parent',t.tgparentid::text,'constraint',t.tgconstraint::text,'condition',t.tgqual::text)
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'policy:'||pg_catalog.format('%I.%I.%I',n.nspname,c.relname,p.polname),p.polname,'policy',p.oid::text,jsonb_build_object('relation',p.polrelid::text,'roles',p.polroles::text,'using',p.polqual::text,'check',p.polwithcheck::text)
    FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'column:'||pg_catalog.format('%I.%I.#%s',n.nspname,c.relname,a.attnum),a.attname,'column',c.oid::text,
    jsonb_build_object('ordinal',a.attnum,'type',a.atttypid::text,'collation',a.attcollation::text)
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0
  UNION ALL SELECT 'type:'||pg_catalog.format('%I.%I',n.nspname,t.typname),t.typname,'type',t.oid::text,
    jsonb_build_object('owner',t.typowner::text,'relation',t.typrelid::text,'array',t.typarray::text,'element',t.typelem::text)
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'rule:'||pg_catalog.format('%I.%I.%I',n.nspname,c.relname,r.rulename),r.rulename,'rewrite',r.oid::text,
    jsonb_build_object('relation',r.ev_class::text,'condition',r.ev_qual::text,'action',r.ev_action::text)
    FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT pg_catalog.format('default:%s:%I:%s',CASE WHEN d.defaclnamespace=0 THEN '<global>' ELSE 'public' END,r.rolname,d.defaclobjtype),r.rolname,'defaultAcl',d.oid::text,
    jsonb_build_object('owner',d.defaclrole::text,'namespace',d.defaclnamespace::text)
    FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles r ON r.oid=d.defaclrole
    WHERE d.defaclnamespace='public'::regnamespace OR d.defaclnamespace=0 AND d.defaclrole IN(SELECT oid FROM closure)
  UNION ALL SELECT pg_catalog.format('membership:%I>%I@%I',r.rolname,m.rolname,g.rolname),m.rolname,'membership',a.oid::text,
    jsonb_build_object('role',a.roleid::text,'member',a.member::text,'grantor',a.grantor::text)
    FROM memberships a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid JOIN pg_catalog.pg_roles m ON m.oid=a.member JOIN pg_catalog.pg_roles g ON g.oid=a.grantor
  UNION ALL SELECT 'role:'||r.rolname,r.rolname,'role',r.oid::text,'{}'::jsonb FROM pg_catalog.pg_roles r WHERE r.oid IN(SELECT oid FROM participants)
  ORDER BY key`;

const fields: Record<string, readonly string[]> = {
  'base.tables': ['key','name','kind','persistence','rowSecurity','forceRowSecurity','partition','partitionKey'],
  'base.columns': ['key','name','table','type','notNull','default','identity','generated','collation'],
  'base.constraints': ['key','name','table','type','definition','validated','deferrable','deferred','noInherit','local','inheritCount'],
  'base.indexes': ['key','name','table','definition','unique','primary','valid','ready','nullsNotDistinct','replicaIdentity','constraintOwned'],
  'base.sequences': ['key','name','type','start','min','max','increment','cache','cycle','ownedBy'],
  columnAttributes: ['key','name','relation','ordinal','dropped','typeIdentity','typeModifier','dimensions','notNull','identity','generated','local','inheritCount','storage','compression','statisticsTarget','options','foreignOptions','default','collation'],
  relationAttributes: ['key','name','kind','persistence','attributeCount','checkCount','hasIndex','hasRules','hasTriggers','hasSubclass','rowSecurity','forceRowSecurity','populated','replicaIdentity','partition','options','accessMethod','tablespace','ofType','partitionBound','parents'],
  routines: ['key','name','kind','arguments','result','resultType','definition','source','binary','config','language','languageTrusted','securityDefiner','leakproof','strict','returnsSet','volatility','parallel','cost','rows','argumentCount','defaultCount','argumentNames','argumentModes','argumentTypes','allArgumentTypes','variadicType','support','defaults','transformTypes','owner'],
  triggers: ['key','name','relation','definition','type','enabled','internal','routine','argumentCount','arguments','columnNumbers','hasCondition','deferrable','initiallyDeferred','constraintRelation','constraintIndex','constraint','parent','oldTransitionTable','newTransitionTable'],
  views: ['key','name','kind','definition','options','populated','rules'],
  policies: ['key','name','relation','command','permissive','roles','using','withCheck'],
  objectOwners: ['key','name','kind','owner'], acls: ['key','name','kind','aclIsNull','entries'],
  defaultAcls: ['key','name','namespace','objectType','owner','entries'],
  roles: ['key','name','superuser','inherit','createRole','createDatabase','login','replication','bypassRls','connectionLimit','validUntil','config','settings'],
  roleMemberships: ['key','name','role','member','grantor','admin','inherit','setRole'],
  unsupportedObjects: ['key','name','kind','detail'], identities: ['key','name','kind','oid','references'],
  context: ['key','name','database','currentUser','sessionUser','serverVersionNum','isolation','readOnly','searchPath'],
};
const booleanFields = new Set(['rowSecurity','forceRowSecurity','partition','notNull','validated','deferrable','deferred','noInherit','local','unique','primary','valid','ready','nullsNotDistinct','constraintOwned','cycle','dropped','hasIndex','hasRules','hasTriggers','hasSubclass','populated','languageTrusted','securityDefiner','leakproof','strict','returnsSet','internal','hasCondition','initiallyDeferred','permissive','aclIsNull','superuser','inherit','createRole','createDatabase','login','replication','bypassRls','admin','setRole']);
const numericFields = new Set(['ordinal','typeModifier','dimensions','inheritCount','statisticsTarget','attributeCount','checkCount','cost','rows','argumentCount','defaultCount','connectionLimit','serverVersionNum']);

function checkedRows(rows: CatalogRow[], category: string): CatalogRow[] {
  if (!Array.isArray(rows)) throw new Error(`Invalid installed catalog rows: ${category}`);
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !row.key || typeof row.name !== 'string' || !row.name)
      throw new Error(`Invalid installed catalog identity: ${category}`);
    const expected = fields[category];
    if (!expected || Object.keys(row).sort().join(',') !== [...expected].sort().join(','))
      throw new Error(`Missing or unknown installed catalog field: ${category}:${row.key}`);
    for (const [field, value] of Object.entries(row)) {
      if (value === undefined) throw new Error(`Undefined installed catalog field: ${category}:${field}`);
      // replicaIdentity is a boolean in the legacy index reader, a one-byte
      // configuration in relationAttributes. Type is numeric only for triggers.
      const boolean = booleanFields.has(field) || field === 'replicaIdentity' && category === 'base.indexes';
      if (boolean && typeof value !== 'boolean') throw new Error(`Invalid boolean installed catalog field: ${category}:${field}`);
      if ((numericFields.has(field) || field === 'type' && category === 'triggers')
        && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid numeric installed catalog field: ${category}:${field}`);
    }
    if (category === 'acls' || category === 'defaultAcls') {
      if (!Array.isArray(row.entries) || row.entries.some(entry => !entry || typeof entry !== 'object'
        || Object.keys(entry).sort().join(',') !== 'grantable,grantee,grantor,privilege'
        || typeof entry.grantable !== 'boolean' || !['grantee','grantor','privilege'].every(field => typeof entry[field] === 'string' && entry[field])))
        throw new Error(`Invalid installed ACL entries: ${row.key}`);
    }
    if (keys.has(row.key)) throw new Error(`Duplicate installed catalog identity: ${category}:${row.key}`);
    keys.add(row.key);
  }
  return [...rows].sort((a, b) => a.key.localeCompare(b.key));
}

/** SELECT-only reader for a caller-owned, stable PG16 snapshot. It never
 * constructs a database, normalizes a role/body/trigger name, grants privileges,
 * or claims complete/global installation or runtime authorization equivalence. */
export async function readInstalledPublicCatalog(query: CatalogQuery): Promise<InstalledPublicCatalog> {
  const context = checkedRows(await query(contextQuery), 'context');
  if (context.length !== 1 || typeof context[0]!.serverVersionNum !== 'number'
    || Math.floor(context[0]!.serverVersionNum / 10000) !== 16
    || context[0]!.isolation !== 'repeatable read' || context[0]!.readOnly !== 'on')
    throw new Error('Installed public catalog requires one PG16 REPEATABLE READ READ ONLY snapshot');
  const base = await readCatalog(query);
  for (const kind of catalogKinds) base[kind] = checkedRows(base[kind], `base.${kind}`);
  const extensions = {} as Record<InstalledPublicCatalogKind, CatalogRow[]>;
  for (const kind of installedPublicCatalogKinds) extensions[kind] = checkedRows(await query(installedPublicCatalogQueries[kind]), kind);
  const identities = checkedRows(await query(identityQuery), 'identities') as InstalledObjectObservation[];
  if (identities.some(row => typeof row.kind !== 'string' || typeof row.oid !== 'string' || !/^\d+$/.test(row.oid)
    || !row.references || typeof row.references !== 'object' || Array.isArray(row.references)))
    throw new Error('Invalid installed object OID observation');
  return { base, extensions, identities, context: context[0]!, scope: {
    version: 1, schema: 'public', engineMajor: 16, queriesReadOnly: true,
    identityObservationsCompared: false, roleNamesNormalized: false,
    fullInstallationEquivalence: false, effectivePrivilegesProven: false,
    unsupportedObjectsPresent: extensions.unsupportedObjects.length > 0,
  } };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function compareRows(reference: CatalogRow[], candidate: CatalogRow[], kind: string) {
  const left = new Map(checkedRows(reference, kind).map(row => [row.key, row]));
  const right = new Map(checkedRows(candidate, kind).map(row => [row.key, row]));
  return {
    referenceOnly: [...left.values()].filter(row => !right.has(row.key)),
    candidateOnly: [...right.values()].filter(row => !left.has(row.key)),
    changed: [...left.values()].flatMap(row => {
      const other = right.get(row.key);
      if (!other) return [];
      const fields = [...new Set([...Object.keys(row), ...Object.keys(other)])]
        .filter(field => stable(row[field]) !== stable(other[field])).sort();
      return fields.length ? [{ key: row.key, fields, reference: row, candidate: other }] : [];
    }),
  };
}

export function compareInstalledPublicCatalogs(reference: InstalledPublicCatalog, candidate: InstalledPublicCatalog) {
  for (const catalog of [reference, candidate]) {
    if (catalog.scope.version !== 1 || catalog.scope.schema !== 'public' || catalog.scope.engineMajor !== 16
      || catalog.scope.fullInstallationEquivalence !== false || catalog.scope.effectivePrivilegesProven !== false
      || catalog.scope.roleNamesNormalized !== false || catalog.scope.identityObservationsCompared !== false
      || catalog.scope.queriesReadOnly !== true)
      throw new Error('Unexpected installed public catalog scope');
    checkedRows([catalog.context], 'context');
    if (Math.floor(Number(catalog.context.serverVersionNum) / 10000) !== 16
      || catalog.context.isolation !== 'repeatable read' || catalog.context.readOnly !== 'on')
      throw new Error('Unexpected installed public catalog snapshot context');
    for (const kind of catalogKinds) checkedRows(catalog.base[kind], `base.${kind}`);
    for (const kind of installedPublicCatalogKinds) checkedRows(catalog.extensions[kind], kind);
    if (Object.keys(catalog.extensions).sort().join(',') !== [...installedPublicCatalogKinds].sort().join(','))
      throw new Error('Missing or unknown installed public catalog category');
  }
  if (reference.context.serverVersionNum !== candidate.context.serverVersionNum)
    throw new Error('Installed public catalogs require the same PostgreSQL engine version');
  const base = compareCatalogs(reference.base, candidate.base);
  const extensions = Object.fromEntries(installedPublicCatalogKinds.map(kind =>
    [kind, compareRows(reference.extensions[kind], candidate.extensions[kind], kind)])) as
    Record<InstalledPublicCatalogKind, ReturnType<typeof compareRows>>;
  const unsupported = { reference: reference.extensions.unsupportedObjects.length, candidate: candidate.extensions.unsupportedObjects.length };
  const equal = unsupported.reference === 0 && unsupported.candidate === 0
    && catalogKinds.every(kind => Object.values(base[kind]).every(rows => rows.length === 0))
    && installedPublicCatalogKinds.every(kind => Object.values(extensions[kind]).every(rows => rows.length === 0));
  return { base, extensions, unsupported, equal, fullInstallationEquivalence: false as const };
}

export function summarizeInstalledPublicCatalogDiff(diff: ReturnType<typeof compareInstalledPublicCatalogs>) {
  return { base: summarizeCatalogDiff(diff.base), extensions: Object.fromEntries(installedPublicCatalogKinds.map(kind =>
    [kind, { referenceOnly: diff.extensions[kind].referenceOnly.length, candidateOnly: diff.extensions[kind].candidateOnly.length,
      changed: diff.extensions[kind].changed.length }])), unsupported: diff.unsupported, equal: diff.equal,
    fullInstallationEquivalence: false as const };
}
