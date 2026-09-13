// Exact observed-catalog queries shared by the JS inspector and SQL installer.
export const SHIPPING_LIFECYCLE_FUNCTIONS_SQL = String.raw`
SELECT p.proname AS "name",
    p.proargtypes::text AS "args",
    p.proargnames AS "argNames",
    p.prorettype::int AS "returns",
    l.lanname AS "language",
    p.provolatile AS "volatility",
    p.proisstrict AS "strict",
    p.prosrc AS "body",
    p.proconfig AS "config",
    p.prokind='f' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proleakproof
      AND p.proparallel='u' AND p.provariadic=0 AND p.prosupport=0 AND p.procost=100 AND p.prorows=0
      AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
      AND p.proargdefaults IS NULL AND p.protrftypes IS NULL AND p.probin IS NULL AND p.prosqlbody IS NULL
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      AND ARRAY(SELECT a::text FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a ORDER BY a::text)
        =ARRAY(SELECT a::text FROM pg_catalog.aclexplode(pg_catalog.acldefault('f',p.proowner)) a ORDER BY a::text) AS "common"
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_')
`;

export const SHIPPING_LIFECYCLE_TRIGGERS_SQL = String.raw`
SELECT t.tgname AS "name",
    c.relname AS "table",
    n.nspname AS "schema",
    p.proname AS "function",
    t.tgtype AS "type",
    pn.nspname='public' AND p.pronargs=0 AND t.tgenabled='O' AND NOT t.tgisinternal
      AND t.tgparentid=0 AND t.tgconstrrelid=0 AND t.tgconstrindid=0 AND t.tgconstraint=0
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgattr::text=''
      AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "common"
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE (n.nspname='public' AND starts_with(t.tgname,'shipping_lifecycle_'))
      OR (pn.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_'))
`;
