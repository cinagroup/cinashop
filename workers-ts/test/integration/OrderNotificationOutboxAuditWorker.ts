import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import {
  productionNotificationTemplateState,
  runOrderNotificationOutboxPostgresScenario,
} from "./OrderNotificationOutboxPostgresScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const MIGRATION_STATEMENTS = [
  `ALTER TABLE public.system_message ADD COLUMN IF NOT EXISTS event_key VARCHAR(128)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS smsg_event_key_uq ON public.system_message (event_key)`,
  `ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck`,
  `ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (
    event_type IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice')
  )`,
  `CREATE TABLE IF NOT EXISTS public.order_notification_delivery (
    id SERIAL PRIMARY KEY,
    outbox_id INTEGER NOT NULL,
    event_key VARCHAR(128) NOT NULL,
    order_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    notice_mark VARCHAR(50) NOT NULL,
    channel VARCHAR(32) NOT NULL,
    target VARCHAR(255) DEFAULT '' NOT NULL,
    template_code VARCHAR(100) DEFAULT '' NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
    dispatch_count INTEGER DEFAULT 0 NOT NULL,
    attempt_count INTEGER DEFAULT 0 NOT NULL,
    replay_count INTEGER DEFAULT 0 NOT NULL,
    available_time INTEGER DEFAULT 0 NOT NULL,
    lease_until INTEGER DEFAULT 0 NOT NULL,
    lease_token VARCHAR(36) DEFAULT '' NOT NULL,
    provider_reference VARCHAR(255) DEFAULT '' NOT NULL,
    provider_request_id VARCHAR(255) DEFAULT '' NOT NULL,
    response_code VARCHAR(100) DEFAULT '' NOT NULL,
    last_error VARCHAR(1000) DEFAULT '' NOT NULL,
    sent_time INTEGER DEFAULT 0 NOT NULL,
    add_time INTEGER DEFAULT 0 NOT NULL,
    update_time INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT ond_channel_ck CHECK (channel IN (
      'sms', 'wechat_official', 'wechat_routine', 'wechat_shipping'
    )),
    CONSTRAINT ond_status_ck CHECK (status IN (
      'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
      'SENT', 'SKIPPED', 'UNKNOWN', 'DEAD'
    )),
    CONSTRAINT ond_time_ck CHECK (
      available_time >= 0 AND lease_until >= 0 AND sent_time >= 0
      AND add_time >= 0 AND update_time >= 0
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ond_event_channel_uq
    ON public.order_notification_delivery (event_key, channel)`,
  `CREATE INDEX IF NOT EXISTS ond_outbox
    ON public.order_notification_delivery (outbox_id, id)`,
  `CREATE INDEX IF NOT EXISTS ond_order
    ON public.order_notification_delivery (order_id, id)`,
  `CREATE INDEX IF NOT EXISTS ond_dispatch_ready
    ON public.order_notification_delivery (available_time, id)
    WHERE status IN ('PENDING', 'RETRYABLE')`,
  `CREATE INDEX IF NOT EXISTS ond_expired_queue_lease
    ON public.order_notification_delivery (lease_until, id)
    WHERE status IN ('ENQUEUING', 'ENQUEUED')`,
  `CREATE INDEX IF NOT EXISTS ond_expired_provider_lease
    ON public.order_notification_delivery (lease_until, id)
    WHERE status = 'PROCESSING'`,
  `CREATE TABLE IF NOT EXISTS public.order_notification_delivery_action (
    id SERIAL PRIMARY KEY,
    delivery_id INTEGER NOT NULL,
    request_key VARCHAR(36) NOT NULL,
    action VARCHAR(32) NOT NULL,
    previous_status VARCHAR(16) NOT NULL,
    next_status VARCHAR(16) NOT NULL,
    admin_id INTEGER NOT NULL,
    reason VARCHAR(500) NOT NULL,
    provider_reference VARCHAR(255) DEFAULT '' NOT NULL,
    add_time INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT onda_action_ck CHECK (
      action IN ('CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
    ),
    CONSTRAINT onda_admin_time_ck CHECK (admin_id > 0 AND add_time >= 0)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS onda_request_key_uq
    ON public.order_notification_delivery_action (request_key)`,
  `CREATE INDEX IF NOT EXISTS onda_delivery
    ON public.order_notification_delivery_action (delivery_id, id)`,
  `CREATE INDEX IF NOT EXISTS onda_admin_time
    ON public.order_notification_delivery_action (admin_id, add_time, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS wu_openid_uq ON public.wechat_user (openid)`,
  `CREATE INDEX IF NOT EXISTS wu_unionid ON public.wechat_user (unionid)`,
  `CREATE INDEX IF NOT EXISTS wu_uid ON public.wechat_user (uid)`,
  `CREATE INDEX IF NOT EXISTS wu_uid_type_latest ON public.wechat_user (uid, user_type, id)`,
  `CREATE INDEX IF NOT EXISTS nt_enabled_provider_lookup
    ON public.notification_template (legacy_type, mark, id) WHERE status = 1`,
] as const;

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function businessSnapshot(
  db: DbClient,
  eventKeyExists: boolean,
  deliveryTableExists: boolean,
  actionTableExists: boolean,
) {
  const [messages, outboxes, deliveries, actions] = await Promise.all([
    eventKeyExists
      ? db.$client<{ rows: string; non_null_event_keys: string }[]>`
          SELECT count(*)::text AS rows,
            count(*) FILTER (WHERE event_key IS NOT NULL)::text AS non_null_event_keys
          FROM public.system_message
        `
      : db.$client<{ rows: string; non_null_event_keys: string }[]>`
          SELECT count(*)::text AS rows, '0'::text AS non_null_event_keys
          FROM public.system_message
        `,
    db.$client<{ rows: string; payment_rows: string; other_rows: string }[]>`
      SELECT count(*)::text AS rows,
        count(*) FILTER (WHERE event_type = 'order.paid')::text AS payment_rows,
        count(*) FILTER (WHERE event_type <> 'order.paid')::text AS other_rows
      FROM public.store_order_outbox
    `,
    deliveryTableExists
      ? db.$client<{ rows: string }[]>`
          SELECT count(*)::text AS rows FROM public.order_notification_delivery
        `
      : Promise.resolve([{ rows: "0" }]),
    actionTableExists
      ? db.$client<{ rows: string }[]>`
          SELECT count(*)::text AS rows FROM public.order_notification_delivery_action
        `
      : Promise.resolve([{ rows: "0" }]),
  ]);
  return { messages: messages[0], outboxes: outboxes[0], deliveries: deliveries[0], actions: actions[0] };
}

async function currentState(db: DbClient) {
  const rows = await db.$client<{
    server_version: string;
    event_key_exists: boolean;
    event_key_type: string | null;
    index_definition: string | null;
    event_constraint: string | null;
    unsupported_outbox_rows: number;
    delivery_table_exists: boolean;
    delivery_index_count: number;
    delivery_constraint_count: number;
    action_table_exists: boolean;
    action_index_count: number;
    action_constraint_count: number;
    target_lookup_index_count: number;
    temporary_schemas: number;
  }[]>`
    SELECT
      current_setting('server_version') AS server_version,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'system_message' AND column_name = 'event_key'
      ) AS event_key_exists,
      (
        SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'system_message' AND column_name = 'event_key'
      ) AS event_key_type,
      (
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'system_message' AND indexname = 'smsg_event_key_uq'
      ) AS index_definition,
      (
        SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'public.store_order_outbox'::regclass AND conname = 'soob_event_type_ck'
      ) AS event_constraint,
      (
        SELECT count(*)::int FROM public.store_order_outbox
        WHERE event_type NOT IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice')
      ) AS unsupported_outbox_rows,
      to_regclass('public.order_notification_delivery') IS NOT NULL AS delivery_table_exists,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'order_notification_delivery'
          AND indexname IN ('ond_event_channel_uq', 'ond_outbox', 'ond_order',
            'ond_dispatch_ready', 'ond_expired_queue_lease', 'ond_expired_provider_lease'))
        AS delivery_index_count,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = to_regclass('public.order_notification_delivery')
          AND conname IN ('ond_channel_ck', 'ond_status_ck', 'ond_time_ck'))
        AS delivery_constraint_count,
      to_regclass('public.order_notification_delivery_action') IS NOT NULL AS action_table_exists,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'order_notification_delivery_action'
          AND indexname IN ('onda_request_key_uq', 'onda_delivery', 'onda_admin_time'))
        AS action_index_count,
      (SELECT count(*)::int FROM pg_constraint
        WHERE conrelid = to_regclass('public.order_notification_delivery_action')
          AND conname IN ('onda_action_ck', 'onda_admin_time_ck'))
        AS action_constraint_count,
      (SELECT count(*)::int FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'wu_openid_uq', 'wu_unionid', 'wu_uid', 'wu_uid_type_latest',
          'nt_enabled_provider_lookup'
        )) AS target_lookup_index_count,
      (
        SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_order_notice_%'
      ) AS temporary_schemas
  `;
  const state = rows[0];
  if (!state) throw new Error("notification migration state query returned no row");
  const indexValid = !!state.index_definition
    && /CREATE UNIQUE INDEX smsg_event_key_uq ON public\.system_message USING btree \(event_key\)/i
      .test(state.index_definition);
  const constraint = state.event_constraint ?? "";
  const constraintValid = [
    "order.paid",
    "order.delivery.notice",
    "order.refund.refused.notice",
  ].every((eventType) => constraint.includes(eventType));
  type AuditMarkers = {
    users: number;
    orders: number;
    carts: number;
    refunds: number;
    statuses: number;
    outboxes: number;
    deliveries: number;
    templates: number;
  };
  const auditMarkers = state.delivery_table_exists
    ? await db.$client<AuditMarkers[]>`
        WITH audit_orders AS (
          SELECT id FROM public.store_order
          WHERE "unique" LIKE 'notice-16%' AND order_id ~ '^(NOD|NOR)16[0-9]+$'
        )
        SELECT
          (SELECT count(*)::int FROM public."user" WHERE account LIKE 'notice-audit-16%') AS users,
          (SELECT count(*)::int FROM audit_orders) AS orders,
          (SELECT count(*)::int FROM public.store_order_cart_info WHERE oid IN (SELECT id FROM audit_orders)) AS carts,
          (SELECT count(*)::int FROM public.store_order_refund WHERE store_order_id IN (SELECT id FROM audit_orders)) AS refunds,
          (SELECT count(*)::int FROM public.store_order_status WHERE oid IN (SELECT id FROM audit_orders)) AS statuses,
          (SELECT count(*)::int FROM public.store_order_outbox WHERE aggregate_id IN (SELECT id FROM audit_orders)) AS outboxes,
          (SELECT count(*)::int FROM public.order_notification_delivery
            WHERE order_id IN (SELECT id FROM audit_orders)) AS deliveries,
          (SELECT count(*)::int FROM public.system_notification
            WHERE id >= 1600000000 AND name IN ('快递通知', '售后拒绝', '配送通知')) AS templates
      `
    : await db.$client<AuditMarkers[]>`
        WITH audit_orders AS (
          SELECT id FROM public.store_order
          WHERE "unique" LIKE 'notice-16%' AND order_id ~ '^(NOD|NOR)16[0-9]+$'
        )
        SELECT
          (SELECT count(*)::int FROM public."user" WHERE account LIKE 'notice-audit-16%') AS users,
          (SELECT count(*)::int FROM audit_orders) AS orders,
          (SELECT count(*)::int FROM public.store_order_cart_info WHERE oid IN (SELECT id FROM audit_orders)) AS carts,
          (SELECT count(*)::int FROM public.store_order_refund WHERE store_order_id IN (SELECT id FROM audit_orders)) AS refunds,
          (SELECT count(*)::int FROM public.store_order_status WHERE oid IN (SELECT id FROM audit_orders)) AS statuses,
          (SELECT count(*)::int FROM public.store_order_outbox WHERE aggregate_id IN (SELECT id FROM audit_orders)) AS outboxes,
          0::int AS deliveries,
          (SELECT count(*)::int FROM public.system_notification
            WHERE id >= 1600000000 AND name IN ('快递通知', '售后拒绝', '配送通知')) AS templates
      `;
  return {
    ...state,
    index_valid: indexValid,
    constraint_valid: constraintValid,
    schema_valid: state.event_key_exists
      && state.event_key_type === "character varying"
      && indexValid
      && constraintValid
      && state.unsupported_outbox_rows === 0,
    delivery_schema_valid: state.delivery_table_exists
      && state.delivery_index_count === 6
      && state.delivery_constraint_count === 3
      && state.target_lookup_index_count === 5,
    action_schema_valid: state.action_table_exists
      && state.action_index_count === 3
      && state.action_constraint_count === 2,
    business: await businessSnapshot(
      db,
      state.event_key_exists,
      state.delivery_table_exists,
      state.action_table_exists,
    ),
    audit_markers: auditMarkers[0],
    templates: [...await productionNotificationTemplateState(db)],
  };
}

async function externalNotificationState(db: DbClient) {
  const marks = [
    "order_postage_success",
    "order_deliver_success",
    "order_fictitious_success",
    "send_order_refund_no_status",
  ];
  const configKeys = [
    "order_shipping_open",
    "sms_type",
    "sms_account",
    "sms_token",
    "aliyun_SignName",
    "aliyun_AccessKeyId",
    "aliyun_AccessKeySecret",
    "aliyun_RegionId",
    "tencent_SignName",
    "tencent_SdkAppId",
    "tencent_SecretId",
    "tencent_SecretKey",
    "routine_appId",
    "routine_appsecret",
    "wechat_appid",
    "wechat_appsecret",
    "pay_weixin_mchid",
    "site_url",
  ];
  const [notifications, templates, configs, identities, orders, smsRecords, indexes] =
    await Promise.all([
      db.$client<{
        mark: string;
        rows: number;
        system_enabled: number;
        sms_enabled: number;
        wechat_enabled: number;
        routine_enabled: number;
        sms_template_configured: number;
        wechat_template_configured: number;
        routine_template_configured: number;
      }[]>`
        SELECT mark, count(*)::int AS rows,
          count(*) FILTER (WHERE is_system = 1)::int AS system_enabled,
          count(*) FILTER (WHERE is_sms = 1)::int AS sms_enabled,
          count(*) FILTER (WHERE is_wechat = 1)::int AS wechat_enabled,
          count(*) FILTER (WHERE is_routine = 1)::int AS routine_enabled,
          count(*) FILTER (WHERE NULLIF(btrim(sms_id), '') IS NOT NULL)::int
            AS sms_template_configured,
          count(*) FILTER (WHERE NULLIF(btrim(wechat_id), '') IS NOT NULL AND wechat_id <> '0')::int
            AS wechat_template_configured,
          count(*) FILTER (WHERE NULLIF(btrim(routine_id), '') IS NOT NULL AND routine_id <> '0')::int
            AS routine_template_configured
        FROM public.system_notification
        WHERE mark = ANY(${marks})
        GROUP BY mark ORDER BY mark
      `,
      db.$client<{
        mark: string;
        legacy_type: number;
        rows: number;
        enabled: number;
        provider_template_configured: number;
      }[]>`
        SELECT mark, legacy_type, count(*)::int AS rows,
          count(*) FILTER (WHERE status = 1)::int AS enabled,
          count(*) FILTER (WHERE NULLIF(btrim(tempid), '') IS NOT NULL)::int
            AS provider_template_configured
        FROM public.notification_template
        WHERE mark IN ('1458', '1128', '42984', '46232',
          'OPENTM416122303', 'OPENTM415939287', 'OPENTM207284059')
        GROUP BY mark, legacy_type ORDER BY legacy_type, mark
      `,
      db.$client<{
        menu_name: string;
        rows: number;
        configured: boolean;
        non_secret_value: string | null;
      }[]>`
        SELECT menu_name, count(*)::int AS rows,
          bool_or(
            NULLIF(btrim(value, E' \t\n\r\"'), '') IS NOT NULL
            AND lower(btrim(value, E' \t\n\r\"')) <> 'null'
          ) AS configured,
          max(CASE WHEN menu_name IN ('order_shipping_open', 'sms_type')
            THEN btrim(value, E' \t\n\r\"') ELSE NULL END) AS non_secret_value
        FROM public.system_config
        WHERE menu_name = ANY(${configKeys})
        GROUP BY menu_name ORDER BY menu_name
      `,
      db.$client<{
        user_type: string;
        rows: number;
        distinct_users: number;
        usable_openids: number;
        subscribed_openids: number;
      }[]>`
        SELECT user_type, count(*)::int AS rows,
          count(DISTINCT uid)::int AS distinct_users,
          count(*) FILTER (WHERE NULLIF(btrim(openid), '') IS NOT NULL AND is_del = 0)::int
            AS usable_openids,
          count(*) FILTER (WHERE NULLIF(btrim(openid), '') IS NOT NULL
            AND is_del = 0 AND subscribe = 1)::int AS subscribed_openids
        FROM public.wechat_user
        GROUP BY user_type ORDER BY user_type
      `,
      db.$client<{
        rows: number;
        delivered_rows: number;
        wechat_shipping_eligible_rows: number;
        eligible_with_trade_no: number;
        eligible_with_routine_openid: number;
        split_rows: number;
      }[]>`
        SELECT count(*)::int AS rows,
          count(*) FILTER (WHERE status IN (1, 2, 3, 4))::int AS delivered_rows,
          count(*) FILTER (WHERE is_channel = 1 AND pay_type = 'weixin')::int
            AS wechat_shipping_eligible_rows,
          count(*) FILTER (WHERE is_channel = 1 AND pay_type = 'weixin'
            AND NULLIF(btrim(trade_no), '') IS NOT NULL)::int AS eligible_with_trade_no,
          count(*) FILTER (WHERE is_channel = 1 AND pay_type = 'weixin'
            AND EXISTS (SELECT 1 FROM public.wechat_user wu
              WHERE wu.uid = store_order.uid AND wu.user_type = 'routine'
                AND wu.is_del = 0 AND NULLIF(btrim(wu.openid), '') IS NOT NULL))::int
            AS eligible_with_routine_openid,
          count(*) FILTER (WHERE pid > 0)::int AS split_rows
        FROM public.store_order
        WHERE is_del = 0
      `,
      db.$client<{
        rows: number;
        successful_rows: number;
        distinct_templates: number;
      }[]>`
        SELECT count(*)::int AS rows,
          count(*) FILTER (WHERE resultcode = 1)::int AS successful_rows,
          count(DISTINCT template)::int AS distinct_templates
        FROM public.sms_record
      `,
      db.$client<{ tablename: string; indexname: string; indexdef: string }[]>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('system_notification', 'notification_template', 'wechat_user')
        ORDER BY tablename, indexname
      `,
    ]);
  const presentConfig = new Map(configs.map((row) => [row.menu_name, row]));
  return {
    notifications,
    templates,
    configs: configKeys.map((key) => presentConfig.get(key) ?? {
      menu_name: key,
      rows: 0,
      configured: false,
      non_secret_value: null,
    }),
    identities,
    orders: orders[0],
    sms_records: smsRecords[0],
    indexes,
  };
}

async function applyMigration(db: DbClient) {
  const before = await currentState(db);
  if (before.unsupported_outbox_rows !== 0) {
    throw new Error("unsupported outbox event types exist; refusing constraint replacement");
  }
  if (before.event_key_exists && before.event_key_type !== "character varying") {
    throw new Error("existing system_message.event_key has an incompatible type");
  }
  if (before.index_definition && !before.index_valid) {
    throw new Error("existing smsg_event_key_uq definition is incompatible");
  }
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    for (const statement of MIGRATION_STATEMENTS) await tx.unsafe(statement);
  });
  const after = await currentState(db);
  if (!after.schema_valid || !after.delivery_schema_valid || !after.action_schema_valid) {
    throw new Error("order notification outbox migration verification failed");
  }
  if (
    before.business.messages?.rows !== after.business.messages?.rows ||
    before.business.outboxes?.rows !== after.business.outboxes?.rows ||
    before.business.outboxes?.payment_rows !== after.business.outboxes?.payment_rows ||
    before.business.outboxes?.other_rows !== after.business.outboxes?.other_rows ||
    before.business.deliveries?.rows !== after.business.deliveries?.rows ||
    before.business.actions?.rows !== after.business.actions?.rows
  ) {
    throw new Error("business row snapshot changed while applying notification migration");
  }
  return { before, after, business_rows_unchanged: true };
}

async function cleanupAuditMarkers(db: DbClient) {
  const guards = await db.$client<{
    invalid_orders: number;
    invalid_users: number;
    invalid_carts: number;
    invalid_refunds: number;
    invalid_templates: number;
    invalid_operation_deliveries: number;
  }[]>`
    WITH audit_users AS (
      SELECT uid FROM public."user"
      WHERE account LIKE 'notice-audit-16%'
    ), audit_orders AS (
      SELECT * FROM public.store_order
      WHERE "unique" LIKE 'notice-16%' AND order_id ~ '^(NOD|NOR)16[0-9]+$'
    )
    SELECT
      (SELECT count(*)::int FROM audit_orders
        WHERE supplier_id <> 5 OR store_id <> 0 OR paid <> 1 OR total_num <> 1
          OR pay_price <> 19.90 OR user_phone <> '13800000000'
          OR real_name <> '通知审计用户' OR uid NOT IN (SELECT uid FROM audit_users)) AS invalid_orders,
      (SELECT count(*)::int FROM public."user"
        WHERE account LIKE 'notice-audit-16%'
          AND (nickname <> '通知审计用户' OR phone <> '13800000000')) AS invalid_users,
      (SELECT count(*)::int FROM public.store_order_cart_info
        WHERE oid IN (SELECT id FROM audit_orders)
          AND cart_info NOT LIKE '%审计商品%') AS invalid_carts,
      (SELECT count(*)::int FROM public.store_order_refund
        WHERE store_order_id IN (SELECT id FROM audit_orders)
          AND (refund_reason <> 'audit' OR order_id !~ '^RF16[0-9]+$')) AS invalid_refunds,
      (SELECT count(*)::int FROM public.system_notification
        WHERE id >= 1600000000 AND name IN ('快递通知', '售后拒绝', '配送通知')
          AND mark NOT IN ('order_postage_success', 'send_order_refund_no_status', 'order_deliver_success')) AS invalid_templates,
      (SELECT count(*)::int FROM public.order_notification_delivery
        WHERE last_error IN ('audit_manual_confirm_sent', 'audit_manual_close')
          AND NOT (
            event_key ~ '^order\.delivery\.notice:16[0-9]+$'
            AND order_id >= 1600000000 AND user_id >= 1600000000
            AND channel = 'sms' AND target = '13800000000'
            AND status = 'UNKNOWN' AND sent_time = 0
          )) AS invalid_operation_deliveries
  `;
  const guard = guards[0];
  if (!guard || Object.values(guard).some((value) => value !== 0)) {
    throw new Error("audit marker cleanup guard detected non-fixture rows");
  }
  const removed = await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '20s'`;
    const auditOrders = await tx<{ id: number }[]>`
      SELECT id FROM public.store_order
      WHERE "unique" LIKE 'notice-16%' AND order_id ~ '^(NOD|NOR)16[0-9]+$'
      FOR UPDATE
    `;
    const orderIds = auditOrders.map((row) => row.id);
    const orphanOperationDeliveries = await tx<{ id: number }[]>`
      SELECT id FROM public.order_notification_delivery
      WHERE last_error IN ('audit_manual_confirm_sent', 'audit_manual_close')
        AND event_key ~ '^order\.delivery\.notice:16[0-9]+$'
        AND order_id >= 1600000000 AND user_id >= 1600000000
        AND channel = 'sms' AND target = '13800000000'
        AND status = 'UNKNOWN' AND sent_time = 0
      FOR UPDATE
    `;
    const auditDeliveryIds = orderIds.length
      ? await tx<{ id: number }[]>`SELECT id FROM public.order_notification_delivery
          WHERE order_id = ANY(${orderIds}) FOR UPDATE`
      : [];
    const removableDeliveryIds = [...new Set([
      ...auditDeliveryIds.map((row) => row.id),
      ...orphanOperationDeliveries.map((row) => row.id),
    ])];
    const actions = removableDeliveryIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.order_notification_delivery_action
          WHERE delivery_id = ANY(${removableDeliveryIds}) RETURNING id`
      : [];
    const deliveries = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.order_notification_delivery
          WHERE order_id = ANY(${orderIds}) RETURNING id`
      : [];
    const orphanDeliveries = orphanOperationDeliveries.length
      ? await tx<{ id: number }[]>`DELETE FROM public.order_notification_delivery
          WHERE id = ANY(${orphanOperationDeliveries.map((row) => row.id)}) RETURNING id`
      : [];
    const outboxes = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.store_order_outbox
          WHERE aggregate_id = ANY(${orderIds}) RETURNING id`
      : [];
    const statuses = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.store_order_status
          WHERE oid = ANY(${orderIds}) RETURNING id`
      : [];
    const payments = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.store_order_refund_payment
          WHERE store_order_id = ANY(${orderIds}) RETURNING id`
      : [];
    const refunds = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.store_order_refund
          WHERE store_order_id = ANY(${orderIds}) AND refund_reason = 'audit' RETURNING id`
      : [];
    const carts = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.store_order_cart_info
          WHERE oid = ANY(${orderIds}) AND cart_info LIKE '%审计商品%' RETURNING id`
      : [];
    const orders = orderIds.length
      ? await tx<{ id: number }[]>`DELETE FROM public.store_order
          WHERE id = ANY(${orderIds}) RETURNING id`
      : [];
    const users = await tx<{ uid: number }[]>`DELETE FROM public."user"
      WHERE account LIKE 'notice-audit-16%' AND nickname = '通知审计用户'
        AND phone = '13800000000' RETURNING uid`;
    const templates = await tx<{ id: number }[]>`DELETE FROM public.system_notification
      WHERE id >= 1600000000 AND name IN ('快递通知', '售后拒绝', '配送通知')
        AND mark IN ('order_postage_success', 'send_order_refund_no_status', 'order_deliver_success')
      RETURNING id`;
    return {
      users: users.length,
      orders: orders.length,
      carts: carts.length,
      refunds: refunds.length,
      refund_payments: payments.length,
      statuses: statuses.length,
      outboxes: outboxes.length,
      actions: actions.length,
      deliveries: deliveries.length + orphanDeliveries.length,
      orphan_operation_deliveries: orphanDeliveries.length,
      templates: templates.length,
    };
  });
  const after = await currentState(db);
  if (!after.audit_markers || Object.values(after.audit_markers).some((value) => value !== 0)) {
    throw new Error("audit marker cleanup did not converge to zero");
  }
  return { removed, after };
}

async function cleanupTemporarySchemas(db: DbClient) {
  const rows = await db.$client<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname LIKE 'codex_order_notice_%'
    ORDER BY nspname
  `;
  for (const row of rows) {
    if (!/^codex_order_notice_[a-z0-9_]+$/.test(row.nspname)) {
      throw new Error("temporary schema name failed the cleanup guard");
    }
  }
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    for (const row of rows) await tx.unsafe(`DROP SCHEMA "${row.nspname}" CASCADE`);
  });
  const remaining = await db.$client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'codex_order_notice_%'
  `;
  if (remaining[0]?.count !== 0) throw new Error("temporary schema cleanup did not converge");
  return { removed: rows.map((row) => row.nspname), remaining: 0 };
}

async function liveState(db: DbClient) {
  return db.$client.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '20s'`;
    const rows = await tx<{
      observed_at: string;
      delivery_rows: string;
      action_rows: string;
      orphan_operation_deliveries: string;
      temporary_schemas: string;
    }[]>`
      SELECT clock_timestamp()::text AS observed_at,
        (SELECT count(*)::text FROM public.order_notification_delivery
          WHERE random() >= 0) AS delivery_rows,
        (SELECT count(*)::text FROM public.order_notification_delivery_action
          WHERE random() >= 0) AS action_rows,
        (SELECT count(*)::text FROM public.order_notification_delivery
          WHERE last_error IN ('audit_manual_confirm_sent', 'audit_manual_close')
            AND random() >= 0) AS orphan_operation_deliveries,
        (SELECT count(*)::text FROM pg_namespace
          WHERE nspname LIKE 'codex_order_notice_%' AND random() >= 0) AS temporary_schemas
    `;
    return rows[0];
  });
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !new Set([
      "/state", "/external-state", "/apply", "/run", "/run-diagnostic", "/cleanup-markers",
      "/cleanup-schemas", "/live-state",
    ]).has(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_order_notice_audit",
    });
    try {
      if (path === "/state") return Response.json(await currentState(db));
      if (path === "/external-state") return Response.json(await externalNotificationState(db));
      if (path === "/apply") return Response.json(await applyMigration(db));
      if (path === "/cleanup-markers") return Response.json(await cleanupAuditMarkers(db));
      if (path === "/cleanup-schemas") return Response.json(await cleanupTemporarySchemas(db));
      if (path === "/live-state") return Response.json(await liveState(db));
      const state = await currentState(db);
      if (!state.schema_valid || !state.delivery_schema_valid || !state.action_schema_valid) {
        throw new Error("order notification outbox migration is not applied");
      }
      const scenario = await runOrderNotificationOutboxPostgresScenario(
        env.HYPERDRIVE.connectionString,
        path !== "/run-diagnostic",
      );
      return Response.json({ state, scenario, after: await currentState(db) });
    } catch (error) {
      console.error("[order-notification-audit] failed", error instanceof Error ? error.name : "unknown");
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
