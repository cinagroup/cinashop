import { sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemDise } from '@/models/schema';

export const THEME_TEMPLATE_NAME = 'color_change';
/** ECMAScript trim whitespace, shared with PostgreSQL btrim candidates. */
export const DISE_TEMPLATE_TRIM_CHARACTERS = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export function normalizeDiseTemplateName(value: string): string {
  let start = 0, end = value.length;
  while (start < end && DISE_TEMPLATE_TRIM_CHARACTERS.includes(value[start])) start++;
  while (end > start && DISE_TEMPLATE_TRIM_CHARACTERS.includes(value[end - 1])) end--;
  return value.slice(start, end).toLowerCase();
}
export type ThemeStatus = 1 | 2 | 3 | 4 | 5 | 6;
export type ThemeIssue = 'theme_missing' | 'theme_duplicate' | 'theme_identity_invalid' | 'theme_status_invalid';
export interface ThemeSnapshot {
  revision: string;
  status: ThemeStatus | null;
  configured: boolean;
  editable: boolean;
  issues: ThemeIssue[];
}

export async function themeHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Preserve stricter existing transaction limits. No role or schema repair. */
export async function themeDeadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}

/** All affected generic mutations take this before row locks. It also fences
 * direct legacy/import INSERTs which do not participate in our advisory lock. */
export async function lockDiseCatalogForMutation(tx: DbClient) {
  await tx.execute(sql`LOCK TABLE ${systemDise} IN SHARE ROW EXCLUSIVE MODE`);
}

/** At most three candidates: writes already fail closed when two exist. A
 * bounded value prefix is sufficient for the one-character legacy scalar;
 * xmin covers all row columns, including unprojected text and metadata. */
export async function themeCatalog(tx: DbClient) {
  const rows = await tx.select({
    id: systemDise.id, templateName: systemDise.templateName, type: systemDise.type,
    isDel: systemDise.isDel, status: systemDise.status, isShow: systemDise.isShow,
    version: systemDise.version, updateTime: systemDise.updateTime,
    value: sql<string | null>`left(${systemDise.value},64)`,
    valueBytes: sql<number | null>`octet_length(${systemDise.value})`,
    rowVersion: sql<string>`xmin::text`,
  }).from(systemDise).where(sql`lower(btrim(${systemDise.templateName},${DISE_TEMPLATE_TRIM_CHARACTERS}))=${THEME_TEMPLATE_NAME}`)
    .orderBy(systemDise.id).limit(3);
  return { rows, revision: await themeHash({ template_name: THEME_TEMPLATE_NAME, type: 3, rows }) };
}

export function projectThemeCatalog(catalog: Awaited<ReturnType<typeof themeCatalog>>): ThemeSnapshot {
  const snapshot: ThemeSnapshot = { revision: catalog.revision, status: null, configured: false, editable: false, issues: [] };
  if (!catalog.rows.length) { snapshot.editable = true; snapshot.issues.push('theme_missing'); return snapshot; }
  if (catalog.rows.length !== 1) { snapshot.issues.push('theme_duplicate'); return snapshot; }
  const row = catalog.rows[0];
  if (row.templateName !== THEME_TEMPLATE_NAME || row.type !== 3 || row.isDel !== 0 || row.id <= 0) {
    snapshot.issues.push('theme_identity_invalid'); return snapshot;
  }
  snapshot.editable = true;
  if (row.valueBytes !== 1 || typeof row.value !== 'string' || !/^[1-6]$/.test(row.value)) {
    snapshot.issues.push('theme_status_invalid'); return snapshot;
  }
  snapshot.status = Number(row.value) as ThemeStatus;
  snapshot.configured = true;
  return snapshot;
}

/** Caller can reuse this within an existing bounded read-only snapshot. */
export async function readThemeSnapshot(tx: DbClient): Promise<ThemeSnapshot> {
  return projectThemeCatalog(await themeCatalog(tx));
}

export class ThemeReadService {
  constructor(private readonly container: Container) {}
  async read(): Promise<ThemeSnapshot> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      return readThemeSnapshot(tx);
    });
  }
}
