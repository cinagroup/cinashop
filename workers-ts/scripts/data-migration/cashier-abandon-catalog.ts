import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { inspectCashierSecondCardAbandon, installCashierSecondCardAbandon } from '../../src/migrations/runCashierSecondCardAbandon';

export const CASHIER_ABANDON_EXTERNAL_FILE = '0174_customer_cashier_abandon.sql';
export const CASHIER_ABANDON_TABLE = 'cashier_second_card_abandon_v1';
export const CASHIER_ABANDON_SOURCE_SHA256 = '49bc46205953c28e482f76d3e62d044bf719b98466077f22401a69ed375c8899';
export const CASHIER_ABANDON_DECLARATION_SHA256 = 'e91f303bc1786c4eb32da38932eb2b1485aaa3e5ccd63696b570f5ccab856c0c';
export function assertReviewedCashierAbandonSources(root: string) {
  for (const [file, expected] of [
    ['migrations/' + CASHIER_ABANDON_EXTERNAL_FILE, CASHIER_ABANDON_SOURCE_SHA256],
    ['src/migrations/cashierSecondCardAbandon.ts', CASHIER_ABANDON_DECLARATION_SHA256],
  ]) {
    const source = readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, 'Complete reviewed abandonment source changed: ' + file);
  }
}

const objectIdentities = sql`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text AS acl
 FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL
 SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace UNION ALL
 SELECT 'constraint',oid::text,NULL,NULL,NULL FROM pg_constraint WHERE connamespace='public'::regnamespace UNION ALL
 SELECT 'trigger',oid::text,NULL,NULL,NULL FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
 ORDER BY kind,oid`;

/** Explicit composition on an owned, empty audit fixture only. This does not
 * register the table in runAll or alter the frozen 285-table ORM base. */
export async function composeReviewedCashierAbandonCatalog(db: DbClient, path: string, root: string) {
  assertReviewedCashierAbandonSources(root);
  const initial = await inspectCashierSecondCardAbandon(db);
  assert.ok(path === 'external' ? initial.complete : !initial.present, 'Unexpected abandonment registration on ' + path);
  const beforeNames = await db.execute(sql`SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname COLLATE "C"`);
  assert.equal(beforeNames.length, path === 'external' ? 286 : 285, 'Historical complete table basis changed');
  const before = await db.execute(objectIdentities);
  if (path !== 'external') await installCashierSecondCardAbandon(db);
  assert.ok((await inspectCashierSecondCardAbandon(db)).complete, 'Composed abandonment catalog differs');
  const installed = await db.execute(objectIdentities);
  assert.deepEqual(Array.from(installed).filter(row => before.some(old => old.kind === row.kind && old.oid === row.oid)), Array.from(before), 'Abandonment composition changed an existing identity/owner/ACL');
  const afterNames = await db.execute(sql`SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname COLLATE "C"`);
  assert.deepEqual(afterNames.map(row => row.name), path === 'external' ? beforeNames.map(row => row.name)
    : [...beforeNames.map(row => row.name), CASHIER_ABANDON_TABLE].sort(), 'Unexpected table composition difference');
  const [count] = await db.execute(sql`SELECT count(*)::integer AS count FROM public.cashier_second_card_abandon_v1`);
  assert.equal(count.count, 0, 'Abandonment audit fixture must remain empty');
  await assert.rejects(installCashierSecondCardAbandon(db), error => error instanceof Error
    && error.message === 'Existing cashier abandonment protocol requires exact catalog review, no reinstall');
  assert.ok((await inspectCashierSecondCardAbandon(db)).complete);
  assert.deepEqual(Array.from(await db.execute(objectIdentities)), Array.from(installed), 'Refused abandonment reinstall changed identities');
  return { initial: initial.present ? 'exact-catalog' : 'absent', explicitInstallation: path !== 'external',
    complete: true, existingObjectsPreserved: true, repeatRefused: true, noBackfill: true, tables: 286 };
}
