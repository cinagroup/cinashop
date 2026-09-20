/** Test-only entrypoint, never imported by src/app.ts or any deploy config.
 * Actual production DI/services, local Hyperdrive/KV, fixed synthetic buyer.
 */
import { sql } from 'drizzle-orm';
import type { Env } from '../../src/env';
import { createDb, createContainerFromDb } from '../../src/lib/di';
import { admitOfflineOrder } from '../../src/services/order/OfflineOrderAdmissionService';
import { dispatchOfflineOrderPayment } from '../../src/services/order/OfflineOrderPaymentDispatchService';
import { PaymentReconciliationService } from '../../src/services/payment/PaymentReconciliationService';
import { auditOfflineOrderRuntimePermissions } from '../../src/migrations/auditOfflineOrderRuntimePermissions';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const encoder = new TextEncoder();
    const [provided, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') ?? '')),
      crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${env.APP_KEY}`)),
    ]);
    if (!env.APP_KEY || !crypto.subtle.timingSafeEqual(provided, expected)) return new Response(null, { status: 403 });
    if (!/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(env.HYPERDRIVE.database)
      || !/^cinashop_runtime_[a-f0-9]{32}$/.test(env.HYPERDRIVE.user)) return new Response(null, { status: 503 });
    const path = new URL(request.url).pathname;
    const match = /^\/(admit|dispatch|recover)\/(xx[a-f0-9]{30})\/(h5|wechat|routine|alipay)$/.exec(path);
    const readRoute = path === '/identity' || path === '/audit';
    if (readRoute ? request.method !== 'GET' : !match || request.method !== 'POST') return new Response(null, { status: 404 });
    const db = createDb(env);
    try {
      const [identity] = await db.execute(sql`SELECT current_database() AS database,current_user AS role,
        session_user=current_user AS login,pg_backend_pid() AS pid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
        current_setting('server_version_num') AS version,
        (SELECT tableowner=current_user FROM pg_tables WHERE schemaname='public' AND tablename='other_order') AS owner
        FROM pg_roles WHERE rolname=current_user`);
      if (!identity || identity.database !== env.HYPERDRIVE.database || identity.role !== env.HYPERDRIVE.user
        || !identity.login || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolbypassrls
        || identity.owner || Math.floor(Number(identity.version) / 10000) !== 16) throw Error('Unexpected test identity');
      if (path === '/identity') return Response.json(identity);
      if (path === '/audit') return Response.json(await auditOfflineOrderRuntimePermissions(db));
      if (!match) throw Error('Invalid test route');
      const [, operation, orderNo, channel] = match;
      const container = createContainerFromDb(db);
      if (operation === 'admit') return Response.json(await admitOfflineOrder(container, {
        uid: 11, requestKey: crypto.randomUUID(), orderNo, money: '12.50', expectedPayPrice: '10.00',
        from: channel === 'alipay' ? 'h5' : channel,
      }));
      if (operation === 'dispatch') return Response.json(await dispatchOfflineOrderPayment(container, env, {
        uid: 11, orderNo, provider: channel === 'alipay' ? 'alipay' : 'wechat', clientIp: '203.0.113.42',
      }));
      const [row] = await db.execute(sql`SELECT id,replay_key FROM payment_reconciliation_case WHERE order_no=${orderNo}`);
      if (!row) throw Error('Missing recovery case');
      return Response.json({ result: await new PaymentReconciliationService(container, env).processMessage({
        action: 'processPaymentReconciliation', caseId: Number(row.id), replayKey: String(row.replay_key),
      }) });
    } catch (error) {
      // Report SQLSTATE only, never keys, database URLs, query bindings or raw messages.
      let cause: unknown = error, code = 'TEST_OPERATION_FAILED';
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)) code = cause.code;
        if (!('cause' in cause) || cause.cause === cause) break;
        cause = cause.cause;
      }
      return Response.json({ error: code }, { status: 500 });
    } finally { await db.$client.end({ timeout: 5 }); }
  },
} satisfies ExportedHandler<Env>;
