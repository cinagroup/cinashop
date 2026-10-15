import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../../src/env';
import { storeOrderInvoice, systemAdmin, systemRole, userInvoice } from '../../src/models/schema';
import { v1Routes } from '../../src/routes/v1';
import { adminapiRoutes } from '../../src/routes/adminapi';
import { errorHandler } from '../../src/middleware/error';
import { createToken, md5 } from '../../src/utils/jwt';
import { runInvoiceManualRedNote } from '../../src/migrations/runInvoiceManualRedNote';
import { invoiceManualRedNoteReadiness, inspectInvoiceManualRedNote, INVOICE_MANUAL_RED_NOTE_PINS } from '../../src/migrations/invoiceManualRedNoteCatalog';
import { INVOICE_EVIDENCE_CATALOG_SQL } from '../../src/migrations/invoiceEvidenceCatalog';
import { REFUND_SPLIT_CATALOG_SQL } from '../../src/migrations/refundOrderSplitCatalog';
import { customerManualGuestIdentityReadiness } from '../../src/migrations/guestRefundEntityCatalog';
import { customerWorkOfflineOriginRefundFixture } from './customerWorkOfflineOriginRefundFixture';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './financePostgres';

export const MANUAL_RED_ADMINS = { manager: 9801, viewer: 9802, orderManager: 9803, otherManager: 9804 } as const;
export type ManualRedAdmin = keyof typeof MANUAL_RED_ADMINS;
export type ManualRedHttpEnvelope = { status: number; msg: string; data: unknown };

/** One registered database per whole suite. Each case creates a fresh actual
 * order/application/UUID; immutable red-note facts are never deleted, truncated
 * or rewritten between cases. The original fixture drops only its registered
 * owned database after all independent LOGIN pools have closed. */
export async function adminGuestInvoiceManualRedNoteFixture() {
  const f = await customerWorkOfflineOriginRefundFixture();
  const published = async () => {
    const rows = [...await f.maintenanceDb.execute<Record<string, unknown>>(sql.raw(INVOICE_EVIDENCE_CATALOG_SQL)),
      ...await f.maintenanceDb.execute<Record<string, unknown>>(sql.raw(REFUND_SPLIT_CATALOG_SQL))]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const identities = await f.maintenanceDb.execute<{ name: string; oid: string }>(sql`
      SELECT relname AS name,oid::text AS oid FROM pg_class WHERE oid IN(
        to_regclass('public.store_order_invoice'),to_regclass('public.store_order_invoice_evidence'),
        to_regclass('public.store_order_invoice_allocation'),to_regclass('public.store_order_refund_split'),to_regclass('public.store_order_fulfillment_branch'))
      UNION ALL SELECT proname AS name,oid::text AS oid FROM pg_proc WHERE oid IN(
        to_regprocedure('public.capture_invoice_evidence()'),to_regprocedure('public.protect_invoice_evidence()'),to_regprocedure('public.protect_refund_order_split()'))
      ORDER BY name`);
    return { rows, identities, guest: await customerManualGuestIdentityReadiness(f.db) };
  };
  let publishedBefore: Awaited<ReturnType<typeof published>> | undefined;
  let freshBefore = false;
  try {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [owned] = await f.maintenanceDb.execute<{ database: string; role: string; session: string; host: string; port: number; version: number }>(sql`
      SELECT current_database() AS database,current_user AS role,session_user AS session,
        host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version`);
    if (owned.role !== 'finance_test' || owned.session !== owned.role || Math.floor(owned.version / 10000) !== 16
      || !ownsFinanceFixtureEndpoint(owned.database, 'public', base.href, owned.host, owned.port)) {
      throw Error('Manual red-note acceptance requires the registered owned PG16 fixture');
    }
    // Keep the original buyer-template table present, with zero guest rows.
    // No runtime receives an added template privilege.
    const [templates] = await f.maintenanceDb.execute<{ present: boolean }>(sql`SELECT to_regclass('public.user_invoice') IS NOT NULL AS present`);
    if (!templates.present) {
      const kit = await import('drizzle-kit/api');
      for (const statement of await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ userInvoice }))) await f.exec(statement);
    }
    publishedBefore = await published();
    freshBefore = (await inspectInvoiceManualRedNote(f.maintenanceDb)).fresh;
    if (!publishedBefore.guest.ready || publishedBefore.identities.length !== 8) throw Error('Complete published guest profile must precede red-note commissioning');
    await runInvoiceManualRedNote(f.maintenanceDb, { adminRole: f.admin.role, readerRoles: [f.role] });
    const [writer, reader] = await Promise.all([
      invoiceManualRedNoteReadiness(f.admin.db, 'admin-write'), invoiceManualRedNoteReadiness(f.db),
    ]);
    if (!writer.ready || !reader.ready) throw Error('Fixed manual red-note catalog and independent writer/reader LOGINs must be commissioned');
    const identities = await Promise.all([f.db, f.admin.db, f.manager.db].map(db => db.execute<{ role: string; session: string; pid: number }>(sql`
      SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`)));
    if (identities.some((rows, index) => rows[0].role !== [f.role, f.admin.role, f.manager.role][index]
      || rows[0].session !== rows[0].role) || new Set(identities.map(rows => rows[0].pid)).size !== 3) {
      throw Error('Invoice customer/Admin/manager identities must be independent authenticated backends');
    }
    const permissions = { manager: 'invoice.manage', viewer: 'invoice.view', orderManager: 'order.manage', otherManager: 'invoice.manage' } as const;
    await f.maintenanceDb.insert(systemRole).values(Object.entries(MANUAL_RED_ADMINS).map(([name, id]) => ({
      id, roleName: 'Owned invoice ' + name, rules: permissions[name as ManualRedAdmin], status: 1,
    })));
    await f.maintenanceDb.insert(systemAdmin).values(Object.entries(MANUAL_RED_ADMINS).map(([name, id]) => ({
      id, account: 'owned-invoice-' + name, pwd: 'offline-native-admin-password', roles: String(id),
      level: 1, adminType: 1, status: 1, isDel: 0,
    })));
    // Large inventory is an input to actual pricing/stock consumers, not a
    // fabricated paid or red-note result. Cases keep separate real orders.
    await f.exec('UPDATE public.store_product SET stock=10000 WHERE id=70;UPDATE public.store_product_attr_value SET stock=10000 WHERE id=1');
    let lose: { path: string; requestId: string } | undefined;
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', f.container);
      const request = c.req.method === 'POST' ? await c.req.raw.clone().json() as Record<string, unknown> : undefined;
      await next();
      if (lose && c.req.path === lose.path && request?.request_id === lose.requestId) {
        const expected = lose; lose = undefined;
        const result = await c.res.clone().json() as ManualRedHttpEnvelope;
        if (result.status !== 200) throw Error('Response-loss fixture did not observe an actual successful commit');
        if (request.request_id !== expected.requestId) throw Error('Response-loss fixture changed the original UUID');
        // Actual auth, independent Admin session and transaction have finished.
        // This models the response failing after COMMIT, never a fake receipt.
        throw Error('Owned invoice HTTP response lost after actual COMMIT');
      }
    });
    app.onError(errorHandler); app.route('/api', v1Routes); app.route('/adminapi', adminapiRoutes);
    const request = async (path: string, body?: unknown, name: ManualRedAdmin | 'anonymous' | 'user' | 'supplier' | 'kefu' = 'manager', bindings = f.env) => {
      const token = name === 'anonymous' ? undefined : name === 'user'
        ? (await createToken(101, 'api', md5('owned-financial-password'), f.env.APP_KEY)).token
        : name === 'supplier' || name === 'kefu'
        ? (await createToken(101, name, md5('owned-financial-password'), f.env.APP_KEY)).token
        : (await createToken(MANUAL_RED_ADMINS[name], 'admin', md5('offline-native-admin-password'), f.env.APP_KEY)).token;
      const response = await app.request(path, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings);
      return { response, body: await response.json() as ManualRedHttpEnvelope };
    };
    const loseResponseAfterCommit = (path: string, requestId: string) => {
      if (lose) throw Error('One exact owned response-loss injection at a time');
      lose = { path, requestId };
    };
    const application = async (orderId: number) => {
      const order = await f.order(orderId);
      const [invoice] = await f.maintenanceDb.insert(storeOrderInvoice).values({ orderId: order.id,
        uid: order.uid, category: 'order', isPay: 1, isInvoice: 0, invoiceAmount: order.payPrice,
        name: '真实票据测试抬头', drawerPhone: '00000000000', remark: '待实际Admin处理' }).returning();
      if (!invoice) throw Error('Unissued application input was not captured by the real invoice evidence trigger');
      return invoice;
    };
    const restoreAdminAuthority = async () => {
      await f.maintenanceDb.update(systemAdmin).set({ status: 1, isDel: 0 })
        .where(eq(systemAdmin.id, MANUAL_RED_ADMINS.manager));
      await f.maintenanceDb.update(systemRole).set({ rules: 'invoice.manage', status: 1 })
        .where(eq(systemRole.id, MANUAL_RED_ADMINS.manager));
    };
    return { ...f, request, application, loseResponseAfterCommit, restoreAdminAuthority, independentIdentities: identities.map(rows => rows[0]) };
  } catch (error) {
    try {
      if (freshBefore && publishedBefore && Object.values(INVOICE_MANUAL_RED_NOTE_PINS).some(pin => String(pin) === 'commissioning-pending')) {
        const after = await published(), newRealm = await inspectInvoiceManualRedNote(f.maintenanceDb);
        const evidence = {
          version: 'manual-red-note-fixture-commissioning-rollback-v1', fixed_pins_pending: true,
          fresh_before: freshBefore, new_objects_absent_after: newRealm.fresh && newRealm.rows.length === 4 && newRealm.rows.every(row => row.present === false),
          published_catalog_unchanged: JSON.stringify(after.rows) === JSON.stringify(publishedBefore.rows),
          published_oids_unchanged: JSON.stringify(after.identities) === JSON.stringify(publishedBefore.identities),
          guest_ready_before: publishedBefore.guest.ready, guest_ready_after: after.guest.ready,
        };
        console.log('INVOICE_MANUAL_RED_NOTE_FIXTURE_ROLLBACK ' + JSON.stringify(evidence));
        if (!evidence.new_objects_absent_after || !evidence.published_catalog_unchanged || !evidence.published_oids_unchanged || !evidence.guest_ready_after) {
          throw Error('Independent post-rollback commissioning proof failed');
        }
      }
    } finally { await f.close(); }
    throw error;
  }
}
