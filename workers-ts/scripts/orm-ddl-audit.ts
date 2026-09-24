/** Offline test-service audit. Never consumes production DATABASE_URL/Hyperdrive. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Container } from "../src/lib/di";
import { runShippingLifecycle } from "../src/migrations/runShippingLifecycle";
import { inspectShippingLifecycleProtocol } from "../src/migrations/inspectShippingLifecycleProtocol";
import { inspectShippingLifecycleIndexes, runShippingLifecycleIndexes } from '../src/migrations/runShippingLifecycleIndexes';
import { SHIPPING_LIFECYCLE_INDEXES } from '../src/migrations/shippingLifecycleIndexes';
import { inspectShippingTemplateCreateReplay, runShippingTemplateCreateReplay } from '../src/migrations/runShippingTemplateCreateReplay';
import { inspectAdminRefundOperation, runAdminRefundOperation } from '../src/migrations/runAdminRefundOperation';
import { inspectAdminRefundCreation, runAdminRefundCreation } from '../src/migrations/runAdminRefundCreation';
import { inspectInvoiceEvidenceSchema, runInvoiceEvidenceSchema } from '../src/migrations/runInvoiceEvidence';
import { inspectRefundOrderSplitSchema, runRefundOrderSplitSchema } from '../src/migrations/runRefundOrderSplit';
import { inspectOfflineOrderSchema, runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { inspectCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { pricingCatalogReady } from '../src/migrations/checkoutPricingLockCatalog';
import { runCheckoutPricingLockSchema } from '../src/migrations/runCheckoutPricingLock';
import { runPresaleDeliveryOutbox } from '../src/migrations/runPresaleDeliveryOutbox';
import { runSupplierRefundLookupIndexes } from '../src/migrations/runSupplierRefundLookupIndexes';
import { inspectPurchaseOriginEvidence, runPurchaseOriginEvidenceSchema, completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { inspectPurchaseCancellationEvidence, runPurchaseCancellationEvidenceSchema, completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';
import { PRESALE_OUTBOX_CHECK_DEFINITION, withPresaleOutboxContract } from './data-migration/presale-outbox-contract';
import { dropOwnedAuditDatabase } from './data-migration/drop-owned-audit-database';
import { extendOrdinaryIndexContracts, assertRetiredIndexesAbsent } from "./data-migration/ordinary-index-contracts";
import { extendIndexNameContracts, assertOldIndexNamesAbsent } from "./data-migration/index-name-contracts";
import { extendConstraintNameContracts, assertConstraintNamesAligned } from "./data-migration/constraint-name-contracts";
import { extendExternalDuplicateContracts, assertAllIndexesAligned } from "./data-migration/external-duplicate-index-contracts";
import { assertColumnDefaultContracts, assertAllColumnsAligned } from "./data-migration/column-default-contracts";
import { assertMissingConstraintContracts } from "./data-migration/missing-constraint-contracts";
import { assertForeignKeyNamesAligned } from "./data-migration/foreign-key-name-contracts";
import { assertAllConstraintsAligned, assertCheckStatesAligned } from "./data-migration/check-state-contracts";
import { assertAllSequencesAligned, assertKefuSequenceAligned } from "./data-migration/kefu-sequence-contracts";
import { assertAllTablesAligned, TABLE_CATALOG_FIELDS } from "./data-migration/table-catalog-contracts";
import { assertIndexContracts, catalogKinds, classifyMissingIndexes, compareCatalogs, readCatalog, summarizeCatalogDiff, type Catalog, type CatalogRow } from "./data-migration/postgres-catalog-audit";

const root = resolve(import.meta.dirname, "..");

export function validateTestTarget(raw: string | undefined): URL {
  if (!raw) throw new Error("Set TEST_FINANCE_POSTGRES_URL to the dedicated loopback PostgreSQL 16 test service; production is forbidden");
  let target: URL;
  try { target = new URL(raw); } catch { throw new Error("Invalid test-service URL (value redacted)"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname)
    || target.pathname !== "/cinashop_finance_test" || target.username !== "finance_test" || target.search || target.hash) {
    throw new Error("Catalog audit requires the dedicated loopback finance_test/cinashop_finance_test service; production is forbidden");
  }
  return target;
}

export async function auditOrmDdl(raw = process.env.TEST_FINANCE_POSTGRES_URL) {
  const target = validateTestTarget(raw);
  const options = { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 10, connection: { statement_timeout: 30_000, lock_timeout: 3_000 } };
  const control = postgres(target.href, options);
  const created: string[] = [];
  const pricingOwners: string[] = [];
  const catalogs: Record<string, Catalog> = {};
  const paths: Array<{ path: string; steps: number }> = [];
  let upgradeVerification;
  let externalDuplicateIndexRetirement;
  let columnDefaultUpgradeVerification;
  let missingConstraintUpgradeVerification;
  let foreignKeyNameUpgradeVerification;
  let checkStateUpgradeVerification;
  let kefuSequenceUpgradeVerification;
  let tableCatalogGateVerification;
  const columnWriteVerification: Record<string, unknown> = {};
  const shippingLifecycleVerification: Record<string, unknown> = {};
  const shippingIndexVerification: Record<string, unknown> = {};
  const shippingReplayVerification: Record<string, unknown> = {};
  const adminRefundOperationVerification: Record<string, unknown> = {};
  const adminRefundCreationVerification: Record<string, unknown> = {};
  const invoiceEvidenceVerification: Record<string, unknown> = {};
  const refundSplitVerification: Record<string, unknown> = {};
  const offlineOrderVerification: Record<string, unknown> = {};
  const checkoutPricingLockVerification: Record<string, unknown> = {};
  const presaleOutboxVerification: Record<string, unknown> = {};
  const supplierRefundLookupVerification: Record<string, unknown> = {};
  const purchaseOriginVerification: Record<string, unknown> = {};
  const purchaseCancellationVerification: Record<string, unknown> = {};
  const cleanupRecoveries: Array<{ database: string; timeoutRecovered: boolean; retried: boolean }> = [];
  try {
    const [identity] = await control`SELECT current_database() AS database, current_user AS role, current_setting('server_version_num') AS version`;
    if (identity.database !== "cinashop_finance_test" || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16) {
      throw new Error("Unexpected catalog audit service identity/version; no databases created");
    }
    // Load Drizzle's CLI/toolchain only inside the validated audit operation,
    // never while importing the URL validator into a unit-test process.
    const api = await import("drizzle-kit/api");
    const { generateDrizzleJson, generateMigration } = api;
    const { MigrationService } = await import("../src/services/MigrationService");
    const models = await import("../src/models/schema");
    const migrationNames = (await readdir(resolve(root, "migrations"))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const migrationSources = await Promise.all(migrationNames.map((name) => readFile(resolve(root, "migrations", name), "utf8")));
    const inputDigest = createHash("sha256");
    migrationNames.forEach((name, index) => inputDigest.update(name).update(migrationSources[index]));
    const snapshot = generateDrizzleJson(models);
    const generated = await generateMigration(generateDrizzleJson({}), snapshot);
    const auditDefaults = createRequire(import.meta.url)("../test/helpers/columnDefaultAudit.cjs");
    for (const path of ["external", "embedded", "orm", "orm_upgrade", "orm_default_upgrade", "orm_constraints", "orm_fk_names", "orm_checks", "orm_sequences", "table_gate"] as const) {
      const name = `orm_audit_${path}_${randomUUID().replaceAll("-", "")}`;
      if (!/^orm_audit_(external|embedded|orm|orm_upgrade|orm_default_upgrade|orm_constraints|orm_fk_names|orm_checks|orm_sequences|table_gate)_[a-f0-9]{32}$/.test(name) || name.length > 63) throw new Error("Invalid isolated database name");
      await control.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created.push(name);
      const isolated = new URL(target.href);
      isolated.pathname = `/${name}`;
      const client = postgres(isolated.href, options);
      try {
        const [actual] = await client`SELECT current_database() AS database, current_user AS role`;
        if (actual.database !== name || actual.role !== "finance_test") throw new Error("Isolated catalog database identity mismatch");
        if (path === "table_gate") {
          // An additional empty fixture DB, never a tenth complete project path.
          const { verifyTableCatalogGate } = await import("../test/helpers/tableCatalogGateAudit");
          tableCatalogGateVerification = await verifyTableCatalogGate({
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => Array.from(await client.unsafe(query)) as CatalogRow[],
          });
          continue;
        }
        let steps = 0;
        // Explicit test-only provisioning, not an installer fallback. Each
        // database has its own never-logged-in owner, removed after DB cleanup.
        const pricingOwner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(pricingOwner)) throw Error('Invalid owned pricing role');
        await control.unsafe(`CREATE ROLE "${pricingOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
        pricingOwners.push(pricingOwner);
        await client`SELECT pg_catalog.set_config('cinashop.checkout_pricing_owner',${pricingOwner},false)`;
        if (path === "external") {
          for (let index = 0; index < migrationNames.length; index++) {
            if (migrationNames[index] === "0140_external_duplicate_index_retirement.sql") {
              // Before the final removal, probe the actual full external-history catalog.
              // The helper commits exactly this migration after all rollback fixtures pass.
              const auditDuplicates = createRequire(import.meta.url)("../test/helpers/externalDuplicateIndexAudit.cjs");
              externalDuplicateIndexRetirement = await auditDuplicates({ format: "pg16", db: {
                exec: (query: string) => client.unsafe(query),
                query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
              }, read: () => readCatalog(async (query) => Array.from(await client.unsafe(query)) as CatalogRow[]) });
              steps++;
              continue;
            }
            try { await client.begin(async (tx) => { await tx.unsafe("SET LOCAL search_path TO public, pg_temp"); await tx.unsafe(migrationSources[index]); }); }
            catch (error) { throw new Error(`External path failed at ${migrationNames[index]}: ${error instanceof Error ? error.message : "SQL failure"}`); }
            steps++;
          }
        } else if (path === "embedded") {
          const service = new MigrationService({ db: drizzle(client) } as unknown as Container);
          const result = await service.runAll();
          if (result.errors.length || result.executed.some((step) => step.includes("skipped"))) {
            throw new Error(`Embedded path incomplete: ${JSON.stringify(result)}`);
          }
          steps = result.executed.length;
        } else if (path === "orm_sequences") {
          const auditSequences = createRequire(import.meta.url)("../test/helpers/kefuSequenceAudit.cjs");
          kefuSequenceUpgradeVerification = await auditSequences({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
            withPeer: async (operation: (peer: { exec: (query: string) => Promise<CatalogRow[]> }) => Promise<unknown>) => {
              const peer = postgres(isolated.href, options);
              try {
                const [identity] = await peer`SELECT current_database() AS database, current_user AS role`;
                if (identity.database !== name || identity.role !== "finance_test") throw new Error("Sequence lock peer identity mismatch");
                return await operation({ exec: async (query: string) => Array.from(await peer.unsafe(query)) as CatalogRow[] });
              } finally { await peer.end({ timeout: 5 }); }
            },
          } });
          if (!kefuSequenceUpgradeVerification.modelAligned || !kefuSequenceUpgradeVerification.lockVerification
            || kefuSequenceUpgradeVerification.lockVerification.concurrentDistinctNumbers !== 16)
            throw new Error("Sequence model or two-connection verification missing");
          steps = kefuSequenceUpgradeVerification.initialStatements + kefuSequenceUpgradeVerification.guardedStatements;
        } else if (path === "orm_checks") {
          const auditChecks = createRequire(import.meta.url)("../test/helpers/checkStateAudit.cjs");
          checkStateUpgradeVerification = await auditChecks({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
            withPeer: async (operation: (peer: { exec: (query: string) => Promise<unknown> }) => Promise<unknown>) => {
              const peer = postgres(isolated.href, options);
              try {
                const [identity] = await peer`SELECT current_database() AS database, current_user AS role`;
                if (identity.database !== name || identity.role !== "finance_test") throw new Error("CHECK lock peer identity mismatch");
                return await operation({ exec: (query: string) => peer.unsafe(query) });
              } finally { await peer.end({ timeout: 5 }); }
            },
          } });
          steps = checkStateUpgradeVerification.initialStatements + checkStateUpgradeVerification.guardedStatements;
        } else if (path === "orm_fk_names") {
          const auditForeignKeys = createRequire(import.meta.url)("../test/helpers/foreignKeyNameAudit.cjs");
          foreignKeyNameUpgradeVerification = await auditForeignKeys({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = foreignKeyNameUpgradeVerification.initialStatements + foreignKeyNameUpgradeVerification.guardedStatements;
        } else if (path === "orm_constraints") {
          const auditConstraints = createRequire(import.meta.url)("../test/helpers/missingConstraintAudit.cjs");
          missingConstraintUpgradeVerification = await auditConstraints({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = missingConstraintUpgradeVerification.initialStatements + missingConstraintUpgradeVerification.guardedStatements;
        } else if (path === "orm_default_upgrade") {
          // Separate full-schema old-default path; don't extend the bounded six-stage index probe.
          columnDefaultUpgradeVerification = await auditDefaults({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = columnDefaultUpgradeVerification.initialStatements + columnDefaultUpgradeVerification.guardedStatements;
        } else if (path === "orm_upgrade") {
          // Same actual generator/rollback/row/OID/FK assertions as the local API probes,
          // but backed by this fresh, identity-checked PostgreSQL 16 database.
          const auditUpgrade = createRequire(import.meta.url)("../test/helpers/drizzleIndexDefinitionAudit.cjs");
          upgradeVerification = await auditUpgrade({ api, models, snapshot, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = upgradeVerification.initialStatements + upgradeVerification.upgradeStatements;
        } else {
          await client.unsafe(generated.join("\n"));
          steps = generated.length;
        }
        // The catalog's five categories do not include triggers/functions.
        // Explicitly prove this protocol on every real construction path, with
        // no repair masking a missing external/embedded registration.
        const shippingDb = drizzle(client);
        const initialOrigin = await inspectPurchaseOriginEvidence(shippingDb);
        const expectedOrigin = path === 'external' || path === 'embedded' ? 'v1' : 'orm-pending';
        if (initialOrigin.state !== expectedOrigin || !initialOrigin.sourcesReady)
          throw Error(`Purchase origin registration differs on ${path}; no automatic repair`);
        const originIdentityQuery = `SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text
          FROM pg_class WHERE relnamespace='public'::regnamespace
          UNION ALL SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
          UNION ALL SELECT 'trigger',oid::text,NULL,NULL,NULL FROM pg_trigger WHERE tgrelid IN
            (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY kind,oid`;
        const beforeOrigin = await client.unsafe(originIdentityQuery);
        if (initialOrigin.state === 'orm-pending') await completePurchaseOriginEvidenceOrm(shippingDb);
        const installedOrigin = await client.unsafe(originIdentityQuery);
        if (JSON.stringify(installedOrigin.filter(row => beforeOrigin.some(old => old.kind === row.kind && old.oid === row.oid))) !== JSON.stringify(beforeOrigin))
          throw Error(`Purchase origin completion replaced an existing object on ${path}`);
        await runPurchaseOriginEvidenceSchema(shippingDb); await runPurchaseOriginEvidenceSchema(shippingDb);
        if ((await inspectPurchaseOriginEvidence(shippingDb)).state !== 'v1'
          || JSON.stringify(installedOrigin) !== JSON.stringify(await client.unsafe(originIdentityQuery))
          || (await client.unsafe('SELECT 1 FROM public.store_order_purchase_origin LIMIT 1')).length)
          throw Error(`Purchase origin repeat or no-backfill verification differs on ${path}`);
        purchaseOriginVerification[path] = { initial: initialOrigin.state, complete: true, completionPreserved: true, repeatPreserved: true, noBackfill: true };
        const initialCancellation = await inspectPurchaseCancellationEvidence(shippingDb);
        const expectedCancellation = path === 'external' || path === 'embedded' ? 'v1' : 'orm-pending';
        if (initialCancellation.state !== expectedCancellation || !initialCancellation.sourcesReady)
          throw Error(`Purchase cancellation registration differs on ${path}; no automatic repair`);
        const beforeCancellation = await client.unsafe(originIdentityQuery);
        if (initialCancellation.state === 'orm-pending') await completePurchaseCancellationEvidenceOrm(shippingDb);
        const installedCancellation = await client.unsafe(originIdentityQuery);
        if (JSON.stringify(installedCancellation.filter(row => beforeCancellation.some(old => old.kind === row.kind && old.oid === row.oid))) !== JSON.stringify(beforeCancellation))
          throw Error(`Purchase cancellation completion replaced an existing object on ${path}`);
        await runPurchaseCancellationEvidenceSchema(shippingDb); await runPurchaseCancellationEvidenceSchema(shippingDb);
        if ((await inspectPurchaseCancellationEvidence(shippingDb)).state !== 'v1'
          || JSON.stringify(installedCancellation) !== JSON.stringify(await client.unsafe(originIdentityQuery))
          || (await client.unsafe('SELECT 1 FROM public.store_order_purchase_cancellation LIMIT 1')).length)
          throw Error(`Purchase cancellation repeat or no-backfill verification differs on ${path}`);
        purchaseCancellationVerification[path] = { initial: initialCancellation.state, complete: true, completionPreserved: true, repeatPreserved: true, noBackfill: true };
        const supplierLookupIdentityQuery = `SELECT c.oid::text,c.relfilenode::text,c.relname,c.relowner::text,c.relacl::text,
          pg_get_indexdef(c.oid) AS definition FROM pg_class c WHERE c.relnamespace='public'::regnamespace
          AND c.relname IN ('sfw_link_id_idx','stx_link_id_idx') ORDER BY c.relname`;
        const supplierLookupBefore = await client.unsafe(supplierLookupIdentityQuery);
        const supplierLookupDefinitions = [
          'CREATE INDEX sfw_link_id_idx ON public.supplier_flowing_water USING btree (link_id, id)',
          'CREATE INDEX stx_link_id_idx ON public.supplier_transactions USING btree (link_id, id)',
        ];
        if (supplierLookupBefore.length !== 2 || supplierLookupBefore.some((row,index) => row.definition !== supplierLookupDefinitions[index]))
          throw Error(`Supplier refund lookup indexes not registered on ${path}; no automatic repair`);
        // The real runner validates the remaining raw pg_index/column/owner fields.
        // Missing names must fail above before any CREATE could mask a bad path.
        await runSupplierRefundLookupIndexes(shippingDb); await runSupplierRefundLookupIndexes(shippingDb);
        if (JSON.stringify(supplierLookupBefore) !== JSON.stringify(await client.unsafe(supplierLookupIdentityQuery)))
          throw Error(`Supplier refund lookup repeat changed identity on ${path}`);
        supplierRefundLookupVerification[path] = { initialRegistered: true, exactTwoIndexes: true, repeatPreserved: true };
        const presaleIdentityQuery = `SELECT c.oid::text,to_jsonb(c) AS metadata,pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'`;
        const presaleBefore = await client.unsafe(presaleIdentityQuery);
        if (presaleBefore.length !== 1 || presaleBefore[0].definition !== PRESALE_OUTBOX_CHECK_DEFINITION)
          throw new Error(`Presale event registration differs on ${path}; no automatic repair`);
        await runPresaleDeliveryOutbox(shippingDb); await runPresaleDeliveryOutbox(shippingDb);
        if (JSON.stringify(presaleBefore) !== JSON.stringify(await client.unsafe(presaleIdentityQuery)))
          throw new Error(`Presale event repeat changed identity on ${path}`);
        presaleOutboxVerification[path] = { initialRegistered: true, exactTenEvents: true, repeatPreserved: true };
        const initialInvoice=await inspectInvoiceEvidenceSchema(shippingDb);
        const expectedInvoice=path==='external' || path==='embedded' ? 'v2' : 'orm-pending';
        if(initialInvoice!==expectedInvoice) throw new Error(`Invoice protection registration differs on ${path}`);
        if(initialInvoice==='orm-pending') await runInvoiceEvidenceSchema(shippingDb,true);
        const invoiceIdentityQuery=`SELECT 'relation' AS kind,c.oid::text,c.relfilenode::text FROM pg_class c
          WHERE c.relnamespace='public'::regnamespace AND (c.relname IN ('store_order_invoice','store_order_invoice_evidence','store_order_invoice_allocation')
          OR c.oid IN(SELECT indexrelid FROM pg_index WHERE indrelid IN('public.store_order_invoice'::regclass,'public.store_order_invoice_evidence'::regclass,'public.store_order_invoice_allocation'::regclass)))
          UNION ALL SELECT 'function',p.oid::text,NULL FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
          AND p.proname IN('capture_invoice_evidence','protect_invoice_evidence') ORDER BY kind,oid`;
        const invoiceIdentities=await client.unsafe(invoiceIdentityQuery);
        await runInvoiceEvidenceSchema(shippingDb); await runInvoiceEvidenceSchema(shippingDb);
        if(await inspectInvoiceEvidenceSchema(shippingDb)!=='v2'
          || JSON.stringify(invoiceIdentities)!==JSON.stringify(await client.unsafe(invoiceIdentityQuery)))
          throw new Error(`Invoice protection repeat changed object identity on ${path}`);
        invoiceEvidenceVerification[path]={initial:initialInvoice,complete:true,repeatPreserved:true};
        const initialSplit=await inspectRefundOrderSplitSchema(shippingDb);
        const expectedSplit=path==='external' || path==='embedded' ? 'v1' : 'orm-pending';
        if(initialSplit.state!==expectedSplit || !initialSplit.invoiceProtectionReady)
          throw new Error(`Refund split registration differs on ${path}`);
        if(initialSplit.state==='orm-pending') await runRefundOrderSplitSchema(shippingDb,true);
        const splitIdentityQuery=`SELECT 'relation' AS kind,c.oid::text,c.relfilenode::text FROM pg_class c
          WHERE c.relnamespace='public'::regnamespace AND (c.relname IN ('store_order_refund_split','store_order_fulfillment_branch')
          OR c.oid IN(SELECT indexrelid FROM pg_index WHERE indrelid IN('public.store_order_refund_split'::regclass,'public.store_order_fulfillment_branch'::regclass)))
          UNION ALL SELECT 'function',p.oid::text,NULL FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
          AND p.proname='protect_refund_order_split' ORDER BY kind,oid`;
        const splitIdentities=await client.unsafe(splitIdentityQuery);
        await runRefundOrderSplitSchema(shippingDb);await runRefundOrderSplitSchema(shippingDb);
        const finalSplit=await inspectRefundOrderSplitSchema(shippingDb);
        if(finalSplit.state!=='v1' || !finalSplit.invoiceProtectionReady
          || JSON.stringify(splitIdentities)!==JSON.stringify(await client.unsafe(splitIdentityQuery)))
          throw new Error(`Refund split repeat changed object identity on ${path}`);
        refundSplitVerification[path]={initial:initialSplit.state,complete:true,repeatPreserved:true};
        const initialOffline = await inspectOfflineOrderSchema(shippingDb);
        const expectedOffline = path === 'external' || path === 'embedded' ? 'v1' : 'orm-pending';
        if (initialOffline.state !== expectedOffline) throw new Error(`Offline registration differs on ${path}: ${initialOffline.state}`);
        // Preserve every existing public relation/index/sequence OID and file during
        // explicit empty-ORM completion; do not repair missing registered migrations.
        const offlineIdentityQuery = `SELECT 'relation' AS kind,oid::text,relfilenode::text FROM pg_class WHERE relnamespace='public'::regnamespace
          UNION ALL SELECT 'function',oid::text,NULL FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`;
        const beforeOffline = await client.unsafe(offlineIdentityQuery);
        if (initialOffline.state === 'orm-pending') await runOfflineOrderSchema(shippingDb, true);
        const offlineIdentities = await client.unsafe(offlineIdentityQuery);
        if (JSON.stringify(offlineIdentities.filter(row => beforeOffline.some(old => old.kind === row.kind && old.oid === row.oid))) !== JSON.stringify(beforeOffline))
          throw new Error(`Offline completion replaced an existing object on ${path}`);
        await runOfflineOrderSchema(shippingDb); await runOfflineOrderSchema(shippingDb);
        if ((await inspectOfflineOrderSchema(shippingDb)).state !== 'v1'
          || JSON.stringify(offlineIdentities) !== JSON.stringify(await client.unsafe(offlineIdentityQuery)))
          throw new Error(`Offline repeat changed object identity on ${path}`);
        offlineOrderVerification[path] = { initial: initialOffline.state, complete: true, completionPreserved: true, repeatPreserved: true };
        const initialPricing = await inspectCheckoutPricingLock(shippingDb);
        const registeredPricing = path === 'external' || path === 'embedded';
        if (registeredPricing ? !pricingCatalogReady(initialPricing) : !initialPricing.absent)
          throw Error(`Pricing capability registration differs on ${path}`);
        const beforePricing = await client.unsafe(offlineIdentityQuery);
        if (!registeredPricing) await runCheckoutPricingLockSchema(shippingDb);
        const installedPricing = await client.unsafe(offlineIdentityQuery);
        if (JSON.stringify(installedPricing.filter(row => beforePricing.some(old => old.kind===row.kind && old.oid===row.oid)))!==JSON.stringify(beforePricing))
          throw Error(`Pricing installation replaced an existing object on ${path}`);
        await runCheckoutPricingLockSchema(shippingDb); await runCheckoutPricingLockSchema(shippingDb);
        if (!pricingCatalogReady(await inspectCheckoutPricingLock(shippingDb))
          || JSON.stringify(installedPricing)!==JSON.stringify(await client.unsafe(offlineIdentityQuery)))
          throw Error(`Pricing repeat changed object identity on ${path}`);
        checkoutPricingLockVerification[path] = { initial: initialPricing.absent ? 'absent' : 'v1', complete: true, installationPreserved: true, repeatPreserved: true };
        const initialCreation = await inspectAdminRefundCreation(shippingDb);
        if (!initialCreation.complete) throw new Error(`Admin refund creation registration differs on ${path}`);
        const creationOidQuery = "SELECT oid,relfilenode FROM pg_class WHERE oid='public.admin_refund_creation'::regclass OR oid IN (SELECT indexrelid FROM pg_index WHERE indrelid='public.admin_refund_creation'::regclass) ORDER BY oid";
        const creationOids = await client.unsafe(creationOidQuery);
        await runAdminRefundCreation(shippingDb);
        await runAdminRefundCreation(shippingDb);
        const verifiedCreation = await inspectAdminRefundCreation(shippingDb);
        if (!verifiedCreation.complete || initialCreation.oid !== verifiedCreation.oid
          || JSON.stringify(creationOids) !== JSON.stringify(await client.unsafe(creationOidQuery)))
          throw new Error(`Admin refund creation repeat changed identity on ${path}`);
        adminRefundCreationVerification[path] = { initialComplete: true, repeatComplete: true, oidsAndFilesPreserved: true };
        const initialRefundReceipt = await inspectAdminRefundOperation(shippingDb);
        if (!initialRefundReceipt.complete) throw new Error(`Admin refund receipt registration differs on ${path}`);
        const refundReceiptOidQuery = "SELECT oid,relfilenode FROM pg_class WHERE oid='public.admin_refund_operation'::regclass OR oid IN (SELECT indexrelid FROM pg_index WHERE indrelid='public.admin_refund_operation'::regclass) ORDER BY oid";
        const refundReceiptOids = await client.unsafe(refundReceiptOidQuery);
        await runAdminRefundOperation(shippingDb);
        await runAdminRefundOperation(shippingDb);
        const verifiedRefundReceipt = await inspectAdminRefundOperation(shippingDb);
        if (!verifiedRefundReceipt.complete || initialRefundReceipt.oid !== verifiedRefundReceipt.oid
          || JSON.stringify(refundReceiptOids) !== JSON.stringify(await client.unsafe(refundReceiptOidQuery)))
          throw new Error(`Admin refund receipt repeat changed identity on ${path}`);
        adminRefundOperationVerification[path] = { initialComplete: true, repeatComplete: true, oidsAndFilesPreserved: true };
        const initialReplay = await inspectShippingTemplateCreateReplay(shippingDb);
        if (!initialReplay.complete) throw new Error(`Shipping receipt registration differs on ${path}`);
        const replayOids = await client.unsafe("SELECT oid,relfilenode FROM pg_class WHERE oid='public.shipping_template_create_replay'::regclass OR oid IN (SELECT indexrelid FROM pg_index WHERE indrelid='public.shipping_template_create_replay'::regclass) ORDER BY oid");
        await runShippingTemplateCreateReplay(shippingDb);
        await runShippingTemplateCreateReplay(shippingDb);
        const verifiedReplay = await inspectShippingTemplateCreateReplay(shippingDb);
        const replayAfter = await client.unsafe("SELECT oid,relfilenode FROM pg_class WHERE oid='public.shipping_template_create_replay'::regclass OR oid IN (SELECT indexrelid FROM pg_index WHERE indrelid='public.shipping_template_create_replay'::regclass) ORDER BY oid");
        if (!verifiedReplay.complete || initialReplay.oid !== verifiedReplay.oid || JSON.stringify(replayOids) !== JSON.stringify(replayAfter))
          throw new Error(`Shipping receipt repeat changed identity on ${path}`);
        shippingReplayVerification[path] = { initialComplete: true, repeatComplete: true, oidsAndFilesPreserved: true };
        const initialShippingIndexes = await inspectShippingLifecycleIndexes(shippingDb);
        if (!initialShippingIndexes.complete) throw new Error(`Shipping index registration differs on ${path}`);
        const shippingIndexOidQuery = `SELECT c.relname,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN (${SHIPPING_LIFECYCLE_INDEXES.map(s=>`'${s.name}'`).join(',')}) ORDER BY c.relname`;
        const shippingIndexOids = await client.unsafe(shippingIndexOidQuery);
        const initialShipping = await inspectShippingLifecycleProtocol(shippingDb);
        const shippingExpected = path === "external" || path === "embedded" ? "complete" : "absent";
        if (initialShipping.state !== shippingExpected) throw new Error(`Shipping protocol registration differs on ${path}`);
        const shippingFirst = await runShippingLifecycle(shippingDb);
        if (shippingFirst.applied !== (shippingExpected === "absent")) throw new Error(`Shipping first-install identity differs on ${path}`);
        const shippingRepeat = await runShippingLifecycle(shippingDb);
        const verifiedShipping = await inspectShippingLifecycleProtocol(shippingDb);
        if (shippingRepeat.applied || verifiedShipping.state !== "complete") throw new Error(`Shipping repeat verification differs on ${path}`);
        shippingLifecycleVerification[path] = { initial: initialShipping.state, firstApplied: shippingFirst.applied,
          repeatApplied: shippingRepeat.applied, ...verifiedShipping };
        await runShippingLifecycleIndexes(shippingDb);
        await runShippingLifecycleIndexes(shippingDb);
        const verifiedShippingIndexes = await inspectShippingLifecycleIndexes(shippingDb);
        if (!verifiedShippingIndexes.complete || JSON.stringify(await client.unsafe(shippingIndexOidQuery)) !== JSON.stringify(shippingIndexOids))
          throw new Error(`Shipping index repeat identity differs on ${path}`);
        shippingIndexVerification[path] = { initialComplete: true, repeatComplete: true, oidsPreserved: true,
          indexCount: verifiedShippingIndexes.present, reusedPackageSourceCompatible: verifiedShippingIndexes.reusedPackageSourceCompatible };
        columnWriteVerification[path] = await auditDefaults.verifyDefaultWrites({
          exec: (query: string) => client.unsafe(query),
          query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
        });
        catalogs[path] = await readCatalog(async (query) => Array.from(await client.unsafe(query)) as CatalogRow[]);
        paths.push({ path, steps });
      } finally { await client.end({ timeout: 5 }); }
    }
    const externalVsEmbedded = compareCatalogs(catalogs.external, catalogs.embedded);
    const externalVsOrm = compareCatalogs(catalogs.external, catalogs.orm);
    if (!tableCatalogGateVerification) throw new Error("Table catalog engine gate verification is missing");
    const contractManifests = await Promise.all([
      "orm-query-index-reconciliation.json",
      "orm-index-definition-reconciliation.json",
      "orm-extra-index-reconciliation.json",
      "orm-ordinary-index-reconciliation.json",
      "orm-index-name-reconciliation.json",
      "orm-constraint-name-reconciliation.json",
      "external-duplicate-index-reconciliation.json",
    ].map(async (name) => JSON.parse(await readFile(resolve(root, "audit", name), "utf8"))));
    if (contractManifests.some((manifest) => !Array.isArray(manifest.entries))) throw new Error("Invalid reconciled index manifest");
    const extra = contractManifests[2].entries;
    if (contractManifests[0].entries.length !== 22 || contractManifests[1].entries.length !== 57 || extra.length !== 50
      || extra.some((entry: { decision: string }) => !["restore-missing-legacy-query-index", "review-orm-only"].includes(entry.decision))) {
      throw new Error("Reconciled index cohort changed; explicit review required");
    }
    const restoredLegacy = extra.filter((entry: { decision: string }) => entry.decision === "restore-missing-legacy-query-index");
    if (restoredLegacy.length !== 28) throw new Error("Expected all 28 legacy query index contracts");
    const priorIndexKeys = [...contractManifests[0].entries, ...contractManifests[1].entries, ...restoredLegacy]
      .map((entry: { key: string }) => entry.key);
    const ordinaryContracts = extendOrdinaryIndexContracts(priorIndexKeys, contractManifests[3]);
    const { retiredKeys } = ordinaryContracts;
    const { keys: namedKeys, oldKeys } = extendIndexNameContracts(ordinaryContracts.keys, contractManifests[4]);
    const owningContracts = extendConstraintNameContracts(namedKeys, contractManifests[5]);
    const duplicateContracts = extendExternalDuplicateContracts(owningContracts.keys, contractManifests[6]);
    // Positive presence gate as well as cross-path equality: both sides missing
    // the new recovery index must not count as aligned.
    const requiredIndexKeys = [...duplicateContracts.keys, "store_order_refund.sor_pink_recovery_scan"];
    requiredIndexKeys.push("payment_reconciliation_case.prc_callback_event", "store_product_reply.spr_order_cart_info");
    requiredIndexKeys.push("work_contact_action_outbox.wcao_client_ref");
    requiredIndexKeys.push('supplier_flowing_water.sfw_link_id_idx', 'supplier_transactions.stx_link_id_idx');
    requiredIndexKeys.push('store_order_purchase_origin.store_order_purchase_origin_pkey', 'store_order_purchase_origin.sopo_buyer_history');
    requiredIndexKeys.push('store_order_purchase_cancellation.store_order_purchase_cancellation_pkey', 'store_order_purchase_cancellation.sopc_buyer_history');
    requiredIndexKeys.push('store_order.so_assisted_actor_list');
    const defaultManifest = JSON.parse(await readFile(resolve(root, "audit/orm-column-default-reconciliation.json"), "utf8"));
    const missingConstraintManifest = JSON.parse(await readFile(resolve(root, "audit/orm-missing-constraint-reconciliation.json"), "utf8"));
    const foreignKeyNameManifest = JSON.parse(await readFile(resolve(root, "audit/orm-foreign-key-name-reconciliation.json"), "utf8"));
    const checkStateManifest = withPresaleOutboxContract(JSON.parse(await readFile(resolve(root, "audit/orm-check-state-reconciliation.json"), "utf8")));
    const kefuSequenceManifest = JSON.parse(await readFile(resolve(root, "audit/orm-kefu-sequence-reconciliation.json"), "utf8"));
    for (const catalog of Object.values(catalogs)) assertRetiredIndexesAbsent(catalog, retiredKeys);
    for (const catalog of Object.values(catalogs)) assertOldIndexNamesAbsent(catalog, oldKeys);
    for (const catalog of Object.values(catalogs)) assertConstraintNamesAligned(catalogs.external, catalog);
    for (const catalog of Object.values(catalogs)) assertAllIndexesAligned(catalogs.external, catalog);
    for (const catalog of Object.values(catalogs)) {
      assertAllTablesAligned(catalogs.external, catalog);
      assertColumnDefaultContracts(catalog, defaultManifest);
      assertAllColumnsAligned(catalogs.external, catalog);
      assertMissingConstraintContracts(catalog, missingConstraintManifest);
      assertForeignKeyNamesAligned(catalog, foreignKeyNameManifest);
      assertCheckStatesAligned(catalog, checkStateManifest);
      assertAllConstraintsAligned(catalogs.external, catalog);
      assertKefuSequenceAligned(catalog, kefuSequenceManifest);
      assertAllSequencesAligned(catalogs.external, catalog);
    }
    assertIndexContracts(catalogs.external, catalogs.embedded, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_upgrade, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_default_upgrade, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_constraints, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_fk_names, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_checks, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_sequences, requiredIndexKeys);
    const ormVsSequenceAligned = compareCatalogs(catalogs.orm, catalogs.orm_sequences);
    if (!kefuSequenceUpgradeVerification || Object.values(ormVsSequenceAligned).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and sequence-aligned ORM catalogs differ");
    }
    const ormVsCheckAligned = compareCatalogs(catalogs.orm, catalogs.orm_checks);
    if (!checkStateUpgradeVerification || Object.values(ormVsCheckAligned).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and CHECK-aligned ORM catalogs differ");
    }
    const ormVsForeignKeyRenamed = compareCatalogs(catalogs.orm, catalogs.orm_fk_names);
    if (!foreignKeyNameUpgradeVerification || Object.values(ormVsForeignKeyRenamed).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and foreign-key-renamed ORM catalogs differ");
    }
    const ormVsConstraintUpgraded = compareCatalogs(catalogs.orm, catalogs.orm_constraints);
    if (!missingConstraintUpgradeVerification || Object.values(ormVsConstraintUpgraded).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and constraint-upgraded ORM catalogs differ");
    }
    const ormVsUpgraded = compareCatalogs(catalogs.orm, catalogs.orm_upgrade);
    if (!externalDuplicateIndexRetirement) throw new Error("External duplicate retirement verification is missing");
    const ormVsDefaultUpgraded = compareCatalogs(catalogs.orm, catalogs.orm_default_upgrade);
    if (!columnDefaultUpgradeVerification || Object.values(ormVsDefaultUpgraded).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and default-upgraded ORM catalogs differ");
    }
    if (!upgradeVerification || Object.values(ormVsUpgraded).some((changes) => Object.values(changes).some((values) => values.length))) {
      throw new Error("Fresh ORM and upgraded ORM catalogs differ");
    }
    return {
      scope: "Isolated PostgreSQL 16 external SQL, embedded migration, fresh ORM, index-upgraded ORM, default-upgraded ORM, constraint-upgraded ORM, foreign-key-renamed ORM CHECK-aligned ORM and sequence-aligned ORM catalogs: tables, columns, constraints, indexes and sequences. Includes six existing index phases, five external duplicate retirements, a separate four-default upgrade, a separate 41-constraint addition preserving eight NOT VALID states, twelve identity-preserving FK renames nine guarded CHECK replacements and one guarded integer/ownership sequence alignment preserving the current number. CHECK replacements intentionally change only the target constraint OIDs and their outgoing dependency object IDs, retaining comments and write rules. Complete table/index/column/constraint/sequence categories, the 41 added constraint contracts, twelve FK names and nine CHECK states are nine-path gates. An additional empty fixture database verifies table metadata refusals and rollback, separate from the nine project paths. All paths verify omitted/DEFAULT/explicit/NULL writes. Upgrade probes verify synthetic rows, OIDs/files/dependencies, drift refusal, rollback, new writes, FK/unique/cascade behavior, idempotence and schema isolation. View/function/trigger probes cover self-created fixtures, not complete schema equivalence for those categories, privileges or policies. No production rows inspected.",
      serverVersionNum: Number(identity.version),
      externalInputSha256: inputDigest.digest("hex"),
      generatedSqlSha256: createHash("sha256").update(generated.join("\n")).digest("hex"),
      paths,
      counts: Object.fromEntries(Object.entries(catalogs).map(([path, catalog]) => [path, Object.fromEntries(catalogKinds.map((kind) => [kind, catalog[kind].length]))])),
      summary: { externalVsEmbedded: summarizeCatalogDiff(externalVsEmbedded), externalVsOrm: summarizeCatalogDiff(externalVsOrm) },
      fullTableCatalogContract: { mode: "all nine paths: exact 279 unique public tables and every raw metadata field; no omissions, additions or aliases waived", count: catalogs.external.tables.length, fields: TABLE_CATALOG_FIELDS },
      tableCatalogGateVerification,
      verifiedIndexContracts: { mode: "exact named definitions; reject drift in every embedded, fresh ORM and upgraded ORM path", keys: requiredIndexKeys },
      retiredIndexContracts: { mode: "reject the two retired physical index names in every compared path", keys: retiredKeys },
      alignedIndexNameContracts: { mode: "exact canonical names in positive contracts; reject all 44 old physical names in every path", oldKeys },
      alignedConstraintNameContracts: { mode: "exact owning primary/unique constraints and indexes; reject all three old names in every path", constraintKeys: owningContracts.constraintKeys, oldKeys: owningContracts.oldKeys },
      fullIndexCatalogContract: { mode: "all nine paths: exact complete index names and definitions; no additions, omissions or aliases waived", count: catalogs.external.indexes.length, retiredExternalKeys: duplicateContracts.retiredKeys },
      fullColumnCatalogContract: { mode: "all nine paths: exact complete columns, types, nullability, defaults, identity, generation and collation", count: catalogs.external.columns.length, defaultKeys: defaultManifest.entries.map((e: { key: string }) => e.key) },
      missingConstraintContracts: { mode: "all nine paths: exact 39 CHECK and 2 FK including eight NOT VALID states; no other constraint differences waived", keys: missingConstraintManifest.entries.map((e: { key: string }) => e.key) },
      foreignKeyNameContracts: { mode: "all nine paths: exact twelve FK catalog rows and no obsolete physical names or duplicate aliases", keys: foreignKeyNameManifest.entries.map((e: { key: string }) => e.key), oldKeys: foreignKeyNameManifest.entries.map((e: { previousKey: string }) => e.previousKey) },
      foreignKeyNameUpgradeVerification: { ...foreignKeyNameUpgradeVerification, freshCatalogMatched: true },
      checkStateContracts: { mode: "all nine paths: nine exact CHECK definitions/states; eight NOT VALID, one validated ten-event list after standalone 0161; immutable 0144 history independently verified; no normalized waiver", keys: checkStateManifest.entries.map((e: { key: string }) => e.key) },
      presaleOutboxVerification,
      supplierRefundLookupVerification,
      purchaseOriginVerification,
      purchaseCancellationVerification,
      fullConstraintCatalogContract: { mode: "all nine paths: exact complete constraint catalog including names, types, expressions, validation and inheritance", count: catalogs.external.constraints.length },
      checkStateUpgradeVerification: { ...checkStateUpgradeVerification, freshCatalogMatched: true },
      fullSequenceCatalogContract: { mode: "all nine paths: exact 227 named sequences, type, options and ownership; no omissions or aliases waived", count: catalogs.external.sequences.length },
      kefuSequenceContracts: { mode: "all nine paths: exact integer type, bounds and AUTO owning column", keys: kefuSequenceManifest.entries.map((e: { key: string }) => e.key) },
      kefuSequenceUpgradeVerification: { ...kefuSequenceUpgradeVerification, freshCatalogMatched: true },
      missingConstraintUpgradeVerification: { ...missingConstraintUpgradeVerification, freshCatalogMatched: true },
      columnDefaultUpgradeVerification: { ...columnDefaultUpgradeVerification, freshCatalogMatched: true },
      columnWriteVerification,
      shippingLifecycleVerification,
      shippingIndexVerification,
      shippingReplayVerification,
      adminRefundOperationVerification,
      adminRefundCreationVerification,
      invoiceEvidenceVerification,
      refundSplitVerification,
      offlineOrderVerification,
      checkoutPricingLockVerification,
      cleanupRecoveries,
      externalDuplicateIndexRetirement,
      upgradeVerification: { ...upgradeVerification, freshCatalogMatched: true },
      missingIndexEvidence: {
        externalVsEmbedded: classifyMissingIndexes(catalogs.external, catalogs.embedded),
        externalVsOrm: classifyMissingIndexes(catalogs.external, catalogs.orm),
      },
      externalVsEmbedded, externalVsOrm,
    };
  } finally {
    // Only exact names recorded after our successful CREATE DATABASE are eligible.
    // Never FORCE-disconnect other sessions, and never drop the control database.
    const cleanupErrors: Error[] = [];
    try {
      for (const name of created.reverse()) {
        try {
          if (!/^orm_audit_(external|embedded|orm|orm_upgrade|orm_default_upgrade|orm_constraints|orm_fk_names|orm_checks|orm_sequences|table_gate)_[a-f0-9]{32}$/.test(name) || name.length > 63) throw new Error("Unsafe cleanup target");
          const recovery = await dropOwnedAuditDatabase((statement, parameters) => control.unsafe(statement, parameters), name, created);
          if (recovery.timeoutRecovered) cleanupRecoveries.push({ database: name, ...recovery });
          const remains = await control`SELECT datname FROM pg_database WHERE datname=${name}`;
          if (remains.length) throw new Error("Isolated database cleanup was not confirmed");
        } catch (error) { cleanupErrors.push(new Error(`Cleanup failed for ${name}`, { cause: error })); }
      }
      for (const role of pricingOwners.reverse()) {
        try {
          if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unsafe owned pricing role cleanup');
          await control.unsafe(`DROP ROLE "${role}"`);
          if ((await control`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${role}`).length)
            throw Error('Owned pricing role cleanup unconfirmed');
        } catch (error) { cleanupErrors.push(new Error('Pricing owner cleanup failed', { cause: error })); }
      }
    } finally { await control.end({ timeout: 5 }); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Catalog audit cleanup incomplete");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  auditOrmDdl().then((report) => {
    // One independently parseable record per catalog difference, suitable for CI logs.
    const { externalVsEmbedded, externalVsOrm, ...metadata } = report;
    console.log(`ORM_DDL_AUDIT ${JSON.stringify({ kind: "summary", ...metadata, cleanupConfirmed: true, mode: "enforced exact five-category catalog; broader runtime equivalence remains unaudited" })}`);
    for (const [comparison, diff] of Object.entries({ externalVsEmbedded, externalVsOrm })) {
      for (const category of catalogKinds) for (const [change, values] of Object.entries(diff[category])) {
        for (const value of values) console.log(`ORM_DDL_AUDIT ${JSON.stringify({ comparison, category, change, value })}`);
      }
    }
  }).catch((error) => { console.error(error instanceof Error ? error.message : "Catalog audit failed"); process.exitCode = 1; });
}
