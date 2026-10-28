import { eq, sql, type SQL } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, user, userBrokerage, userExtract } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { signAttachmentReferences } from '@/services/system/AttachmentService';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { parseAdminWithdrawalDirectoryQuery, parseAdminWithdrawalMediaRevision, withdrawalDirectoryPeriod,
  type AdminWithdrawalDirectoryPeriod, type AdminWithdrawalDirectoryQuery } from './AdminWithdrawalDirectoryInput';

export interface AdminWithdrawalDirectoryActor { id: number; authVersion: string; expiresAt: number }
export interface AdminWithdrawalDirectoryRow {
  /** Preserve signed int4 historical values, including anomalous imported IDs. */
  id: number; uid: number; nickname: string; account: string;
  extract_type: string; real_name: string; bank_name: string; bank_code: string; bank_address: string;
  alipay_code: string; wechat: string; extract_number: string;
  gross_amount: string; net_amount: string; fee_amount: string; balance_before: string;
  status: number; fail_msg: string; fail_time: number; mark: string; add_time: number; time: string;
  /** Metadata eligibility only: not proof that an R2 object exists or is decoded. */
  media_available: boolean;
  revision: string;
}
export interface AdminWithdrawalDirectoryDto {
  version: 1; actor_id: number; query: AdminWithdrawalDirectoryQuery; period: AdminWithdrawalDirectoryPeriod;
  count: number;
  statistics: { price: string; priced: string; brokerage_count: string; brokerage_not: string };
  list: AdminWithdrawalDirectoryRow[];
}
export type AdminWithdrawalDirectoryMediaDto = {
  version: 1; actor_id: number; id: number; revision: string;
} & ({ available: false; reference: null; preview: null; expires: null }
  | { available: true; reference: string; preview: string; expires: number });
interface MediaRow extends Record<string, unknown> {
  id: number; row_version: string; media_version: string | null; reference: string; eligible: boolean;
}
interface RawRow extends Omit<AdminWithdrawalDirectoryRow, 'revision'> { row_version: string; media_version: string | null }
interface Report extends Record<string, unknown> { count: string; price: string; priced: string; brokerage_count: string; brokerage_not: string; list: RawRow[] }

function claims(actor: AdminWithdrawalDirectoryActor): void {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2_147_483_647
    || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

async function authorize(tx: DbClient, actor: AdminWithdrawalDirectoryActor): Promise<void> {
  const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
    || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  // Level0 is the repository's existing platform-super-admin contract. Every
  // ordinary Admin must resolve current roles inside this same read snapshot.
  if (live.level !== 0) {
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (!hasAdminPermission(keys, 'extract.view')) throw new AuthException('提现查看权限已变化', ApiErrorCode.ERR_AUTH);
  }
  claims(actor);
}

function directoryRevision(appKey: string, actor: AdminWithdrawalDirectoryActor, id: number,
  rowVersion: string, mediaVersion: string | null): string {
  return createHmac('sha256', appKey).update(JSON.stringify([
    'admin-withdrawal-directory-v1', actor.id, actor.authVersion, actor.expiresAt, id, rowVersion, mediaVersion,
  ])).digest('hex');
}

/** Both list eligibility and opt-in issuance use this exact SQL predicate.
 * It reads metadata only, never the state or existence of the historical user. */
function eligibleMedia(alias: 'p' | 'e'): SQL {
  const r = sql.identifier(alias);
  return sql`coalesce(${r}.id>0 AND ${r}.uid>0 AND ${r}.extract_type IN ('weixin','alipay')
    AND a.type=3 AND a.relation_id=${r}.uid AND a.module_type=3 AND a.file_type=1 AND a.image_type=8
    AND a.att_dir=${r}.qrcode_url AND a.name LIKE ('attachments/user/'||${r}.uid::text||'/%')
    AND a.name ~ '^[A-Za-z0-9_./-]+$' AND a.name NOT LIKE '%//%' AND right(a.name,1)<>'/'
    AND a.name !~ '(^|/)[.]{1,2}(/|$)' AND a.name ~* '[.](jpe?g|png|webp|gif)$'
    AND CASE lower(btrim(a.att_type)) WHEN 'image/jpg' THEN 'image/jpeg' ELSE lower(btrim(a.att_type)) END
      = CASE lower(substring(a.name FROM '[.]([^.]+)$'))
        WHEN 'jpg' THEN 'image/jpeg' WHEN 'jpeg' THEN 'image/jpeg' WHEN 'png' THEN 'image/png'
        WHEN 'webp' THEN 'image/webp' WHEN 'gif' THEN 'image/gif' ELSE '' END,false)`;
}

function attachmentId(alias: 'p' | 'e'): SQL {
  const r = sql.identifier(alias);
  return sql`CASE WHEN ${r}.qrcode_url ~ '^/api/assets/[1-9][0-9]{0,9}$'
    THEN substring(${r}.qrcode_url FROM '^/api/assets/([1-9][0-9]{0,9})$')::bigint ELSE NULL END`;
}

function periodPredicate(alias: 'e' | 'b', period: AdminWithdrawalDirectoryPeriod): SQL {
  if (period.rule === 'none') return sql`true`;
  const column = alias === 'e' ? sql`e.add_time` : sql`b.add_time`;
  return sql`${column}::bigint BETWEEN ${String(period.start)}::bigint AND ${String(period.effective_stop)}::bigint`;
}

/** One report statement after authority: list, count and the two different
 * PHP summary scopes cannot observe different committed application states. */
async function readAdminWithdrawalDirectoryReport(tx: DbClient, query: AdminWithdrawalDirectoryQuery,
  period: AdminWithdrawalDirectoryPeriod): Promise<Report> {
  const keyword = query.keyword !== '' && query.keyword !== '0';
  const pattern = '%' + query.keyword + '%';
  const search = keyword ? sql`(e.real_name ILIKE ${pattern} OR e.id::text ILIKE ${pattern}
    OR e.bank_code ILIKE ${pattern} OR e.alipay_code ILIKE ${pattern} OR u.nickname ILIKE ${pattern})` : sql`true`;
  const channel = query.extract_type === '' ? sql`true` : sql`e.extract_type=${query.extract_type}`;
  const state = query.status === null ? sql`true` : sql`f.status=${query.status}`;
  const rows = await tx.execute<Report>(sql`
    WITH filtered AS MATERIALIZED (
      SELECT e.*,e.xmin::text AS row_version,coalesce(u.nickname,'') AS nickname,coalesce(u.account,'') AS account
      FROM ${userExtract} e LEFT JOIN ${user} u ON u.uid=e.uid
      WHERE ${periodPredicate('e', period)} AND ${channel} AND ${search}
    ), list_scope AS MATERIALIZED (
      SELECT f.* FROM filtered f WHERE ${state}
    ), paged AS (
      SELECT * FROM list_scope ORDER BY id DESC LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    ), extraction_totals AS (
      SELECT coalesce(sum(extract_price+extract_fee) FILTER(WHERE status=0),0) AS pending,
             coalesce(sum(extract_price+extract_fee) FILTER(WHERE status=1),0) AS approved
      FROM filtered
    ), brokerage_total AS (
      SELECT coalesce(sum(b.number),0) AS amount FROM ${userBrokerage} b
      WHERE b.status=1 AND b.pm=1 AND b.type NOT IN ('extract_fail','refund') AND ${periodPredicate('b', period)}
    )
    SELECT (SELECT count(*)::text FROM list_scope) AS count,
      round(x.pending,2)::text AS price,round(x.approved,2)::text AS priced,
      round(b.amount,2)::text AS brokerage_count,round(greatest(b.amount-x.approved,0),2)::text AS brokerage_not,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'uid',p.uid,'nickname',p.nickname,'account',p.account,
        'extract_type',p.extract_type,'real_name',p.real_name,'bank_name',p.bank_name,
        'bank_code',p.bank_code,'bank_address',p.bank_address,'alipay_code',p.alipay_code,
        'wechat',p.wechat,'extract_number',p.extract_number,
        'gross_amount',round(p.extract_price+p.extract_fee,2)::text,
        'net_amount',round(p.extract_price,2)::text,'fee_amount',round(p.extract_fee,2)::text,
        'balance_before',round(p.balance,2)::text,
        'status',p.status,'fail_msg',p.fail_msg,'fail_time',p.fail_time,'mark',p.mark,'add_time',p.add_time,
        'time',CASE WHEN p.add_time=0 THEN '' ELSE to_char(to_timestamp(p.add_time) AT TIME ZONE 'Asia/Shanghai','YYYY/MM/DD HH24:MI') END,
        'row_version',p.row_version,'media_version',a.xmin::text,
        'media_available',${eligibleMedia('p')}
      ) ORDER BY p.id DESC) FROM paged p LEFT JOIN ${systemAttachment} a
        ON a.att_id::bigint=${attachmentId('p')}),'[]'::jsonb) AS list
    FROM extraction_totals x CROSS JOIN brokerage_total b
  `);
  if (rows.length !== 1) throw new ServiceUnavailableException('提现目录读取结果不完整');
  return rows[0];
}

/** Additive read-only directory and opt-in historical image capability.
 * Neither operation reads R2 or moves funds. The generic signed asset GET
 * remains a 900-second bearer capability with its existing delivery policy. */
export class AdminWithdrawalDirectoryService {
  constructor(private readonly container: Container, private readonly appKey: string) {}

  private async read<T>(value: AdminWithdrawalDirectoryActor,
    run: (tx: DbClient, actor: AdminWithdrawalDirectoryActor) => Promise<T>): Promise<T> {
    const actor = Object.freeze({ ...value });
    claims(actor);
    if (typeof this.appKey !== 'string' || this.appKey.length === 0) throw new ServiceUnavailableException('提现目录版本签名未配置');
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      await authorize(tx, actor);
      const result = await run(tx, actor);
      const [deadline] = await tx.execute<{ expired: boolean }>(sql`SELECT extract(epoch FROM clock_timestamp())>=${actor.expiresAt} AS expired`);
      if (deadline?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
      claims(actor);
      return result;
    });
  }

  async list(parameters: URLSearchParams, actor: AdminWithdrawalDirectoryActor): Promise<AdminWithdrawalDirectoryDto> {
    const query = parseAdminWithdrawalDirectoryQuery(parameters), period = withdrawalDirectoryPeriod(query);
    return this.read(actor, async (tx, identity): Promise<AdminWithdrawalDirectoryDto> => {
      const report = await readAdminWithdrawalDirectoryReport(tx, query, period);
      if (!/^(?:0|[1-9]\d*)$/.test(report.count)) throw new ServiceUnavailableException('提现目录计数异常');
      const count = Number(report.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new ServiceUnavailableException('提现目录计数超出有效范围');
      const exact = (value: string) => { if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)\.\d{2}$/.test(value) || value === '-0.00') throw new ServiceUnavailableException('提现目录金额格式异常'); return value; };
      const list = report.list.map(row => {
        const { row_version, media_version, ...fields } = row;
        for (const name of ['gross_amount','net_amount','fee_amount','balance_before'] as const) exact(fields[name]);
        return { ...fields, revision: directoryRevision(this.appKey, identity, fields.id, row_version, media_version) };
      });
      return { version:1,actor_id:identity.id,query,period,count,
        statistics:{price:exact(report.price),priced:exact(report.priced),brokerage_count:exact(report.brokerage_count),brokerage_not:exact(report.brokerage_not)},list };
    });
  }

  async media(id: number, parameters: URLSearchParams, actor: AdminWithdrawalDirectoryActor): Promise<AdminWithdrawalDirectoryMediaDto> {
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException('提现媒体记录须为规范正整数ID');
    const expected = parseAdminWithdrawalMediaRevision(parameters);
    return this.read(actor, async (tx, identity): Promise<AdminWithdrawalDirectoryMediaDto> => {
      const [row] = await tx.execute<MediaRow>(sql`SELECT e.id,e.xmin::text AS row_version,a.xmin::text AS media_version,
        e.qrcode_url AS reference,${eligibleMedia('e')} AS eligible FROM ${userExtract} e
        LEFT JOIN ${systemAttachment} a ON a.att_id::bigint=${attachmentId('e')} WHERE e.id=${id} LIMIT 1`);
      const blank = (revision: string): AdminWithdrawalDirectoryMediaDto => ({ version:1,actor_id:identity.id,id,revision,
        available:false,reference:null,preview:null,expires:null });
      // Missing rows have no current revision to compare. Return a bounded
      // unavailable result without echoing any stored reference or signing.
      if (!row) return blank(expected);
      const revision = directoryRevision(this.appKey, identity, row.id, row.row_version, row.media_version);
      const encoder = new TextEncoder();
      if (!timingSafeEqual(encoder.encode(revision), encoder.encode(expected))) throw new HttpApiException('提现记录或收款码已变化，请刷新列表',409,409);
      if (row.eligible !== true) return blank(revision);
      const [preview] = await signAttachmentReferences(this.appKey, [row.reference], 900);
      const expires = Number(new URL(preview, 'https://asset.invalid').searchParams.get('expires'));
      if (!Number.isSafeInteger(expires) || expires <= 0) throw new ServiceUnavailableException('提现收款码签名结果异常');
      return { version:1,actor_id:identity.id,id,revision,available:true,reference:row.reference,preview,expires };
    });
  }
}
