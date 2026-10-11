/** Reviewed finite v2→v3 extension. Original six kinds retain their shape.
 * Legacy hard deletion adds a full immutable role snapshot, without new ACLs. */
export const ADMIN_LEGACY_ROLE_OPERATION_UPGRADE_SQL = `
ALTER TABLE ONLY public.admin_authority_operation
  DROP CONSTRAINT aao_operation_ck,
  DROP CONSTRAINT aao_state_ck,
  ADD CONSTRAINT aao_operation_ck CHECK (operation IN
    ('admin-save','role-save','role-delete','legacy-admin-save','legacy-admin-status','legacy-admin-delete',
     'legacy-role-status','legacy-role-delete')),
  ADD CONSTRAINT aao_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND revision = '' AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$' AND revision ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result->'id') = 'number' AND (result->>'id') ~ '^[1-9][0-9]{0,9}$'
      AND (result->>'id')::bigint <= 2147483647
      AND ((operation IN ('role-delete','legacy-admin-delete') AND result->'deleted' = 'true'::jsonb
        AND result - 'id' - 'deleted' = '{}'::jsonb AND result ? 'deleted') OR
        (operation IN ('admin-save','role-save','legacy-admin-save','legacy-admin-status','legacy-role-status')
          AND jsonb_typeof(result->'created') = 'boolean'
          AND (operation NOT IN ('legacy-admin-status','legacy-role-status') OR result->'created' = 'false'::jsonb)
          AND result - 'id' - 'created' = '{}'::jsonb AND result ? 'created') OR
        (operation = 'legacy-role-delete' AND result->'deleted' = 'true'::jsonb
          AND result - 'id' - 'deleted' - 'deleted_role' = '{}'::jsonb
          AND jsonb_typeof(result->'deleted_role') = 'object'
          AND (result->'deleted_role') - 'id' - 'type' - 'relation_id' - 'role_name' - 'rules' - 'level' - 'status' = '{}'::jsonb
          AND (result->'deleted_role') ?& ARRAY['id','type','relation_id','role_name','rules','level','status']
          AND (result->'deleted_role'->'id') = (result->'id')
          AND (result->'deleted_role'->'type') IN ('0'::jsonb,'1'::jsonb)
          AND (result->'deleted_role'->'relation_id') = '0'::jsonb
          AND jsonb_typeof(result->'deleted_role'->'role_name') = 'string'
          AND char_length(result->'deleted_role'->>'role_name') <= 32
          AND jsonb_typeof(result->'deleted_role'->'rules') = 'string'
          AND char_length(result->'deleted_role'->>'rules') <= 16384
          AND jsonb_typeof(result->'deleted_role'->'level') = 'number'
          AND (result->'deleted_role'->>'level') ~ '^([1-9]|10)$'
          AND (result->'deleted_role'->'status') IN ('0'::jsonb,'1'::jsonb))))) IS TRUE);
`;
/** Filled from actual catalog deparsing, then pinned and independently checked. */
export const ADMIN_LEGACY_ROLE_OPERATION_STATE_CONSTRAINT = "CHECK ((((((state)::text = 'not_applied'::text) AND ((request_hash)::text = ''::text) AND ((revision)::text = ''::text) AND (result IS NULL)) OR (((state)::text = 'committed'::text) AND ((request_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((revision)::text ~ '^[0-9a-f]{64}$'::text) AND (result IS NOT NULL) AND (jsonb_typeof(result) = 'object'::text) AND (jsonb_typeof((result -> 'id'::text)) = 'number'::text) AND ((result ->> 'id'::text) ~ '^[1-9][0-9]{0,9}$'::text) AND (((result ->> 'id'::text))::bigint <= 2147483647) AND ((((operation)::text = ANY ((ARRAY['role-delete'::character varying, 'legacy-admin-delete'::character varying])::text[])) AND ((result -> 'deleted'::text) = 'true'::jsonb) AND (((result - 'id'::text) - 'deleted'::text) = '{}'::jsonb) AND (result ? 'deleted'::text)) OR (((operation)::text = ANY ((ARRAY['admin-save'::character varying, 'role-save'::character varying, 'legacy-admin-save'::character varying, 'legacy-admin-status'::character varying, 'legacy-role-status'::character varying])::text[])) AND (jsonb_typeof((result -> 'created'::text)) = 'boolean'::text) AND (((operation)::text <> ALL ((ARRAY['legacy-admin-status'::character varying, 'legacy-role-status'::character varying])::text[])) OR ((result -> 'created'::text) = 'false'::jsonb)) AND (((result - 'id'::text) - 'created'::text) = '{}'::jsonb) AND (result ? 'created'::text)) OR (((operation)::text = 'legacy-role-delete'::text) AND ((result -> 'deleted'::text) = 'true'::jsonb) AND ((((result - 'id'::text) - 'deleted'::text) - 'deleted_role'::text) = '{}'::jsonb) AND (jsonb_typeof((result -> 'deleted_role'::text)) = 'object'::text) AND (((((((((result -> 'deleted_role'::text) - 'id'::text) - 'type'::text) - 'relation_id'::text) - 'role_name'::text) - 'rules'::text) - 'level'::text) - 'status'::text) = '{}'::jsonb) AND ((result -> 'deleted_role'::text) ?& ARRAY['id'::text, 'type'::text, 'relation_id'::text, 'role_name'::text, 'rules'::text, 'level'::text, 'status'::text]) AND (((result -> 'deleted_role'::text) -> 'id'::text) = (result -> 'id'::text)) AND (((result -> 'deleted_role'::text) -> 'type'::text) = ANY (ARRAY['0'::jsonb, '1'::jsonb])) AND (((result -> 'deleted_role'::text) -> 'relation_id'::text) = '0'::jsonb) AND (jsonb_typeof(((result -> 'deleted_role'::text) -> 'role_name'::text)) = 'string'::text) AND (char_length(((result -> 'deleted_role'::text) ->> 'role_name'::text)) <= 32) AND (jsonb_typeof(((result -> 'deleted_role'::text) -> 'rules'::text)) = 'string'::text) AND (char_length(((result -> 'deleted_role'::text) ->> 'rules'::text)) <= 16384) AND (jsonb_typeof(((result -> 'deleted_role'::text) -> 'level'::text)) = 'number'::text) AND (((result -> 'deleted_role'::text) ->> 'level'::text) ~ '^([1-9]|10)$'::text) AND (((result -> 'deleted_role'::text) -> 'status'::text) = ANY (ARRAY['0'::jsonb, '1'::jsonb])))))) IS TRUE))";
