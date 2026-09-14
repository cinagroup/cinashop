import postgres from 'postgres';
import { ValidateException } from '@/utils/errors';

type Option = { id: number; name: string };
const BATCH_SIZE = 128;
const MAX_DURATION_MS = 20_000;
const unavailable = () => new Error('运费模板完整列表读取失败，请重试');

/** PHP's full id/name array without an unbounded Worker buffer or silent limit.
 * One transaction-local SQL cursor retains one snapshot on an owned connection.
 * No WITH HOLD, session-level state, row locks, writes or driver async iterators.
 */
export async function openLegacyShippingOptions(
  connectionString: string,
  supplierId: number,
  signal: AbortSignal,
  options: { deadlineMs?: number } = {},
): Promise<{ body: ReadableStream<Uint8Array>; completion: Promise<void> }> {
  if (!Number.isSafeInteger(supplierId) || supplierId < 1 || supplierId > 2_147_483_647) throw new ValidateException('供应商ID错误');
  const duration = options.deadlineMs ?? MAX_DURATION_MS;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_DURATION_MS) throw new ValidateException('完整列表读取期限错误');
  signal.throwIfAborted();
  let stopped = false, cancelled = false;
  let disposing = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  let settle!: () => void;
  const completion = new Promise<void>(resolve => { settle = resolve; });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Do not reserve the request's authentication pool: postgres.js reserve()
  // cannot report an idle socket close, and release() may reopen a dead socket.
  // This max-one client uses the same Hyperdrive binding, but is solely owned
  // by this response, so abort can end it without disrupting other work.
  const connection = postgres(connectionString, {
    max: 1, prepare: false, connect_timeout: 5,
    connection: { application_name: 'cinashop_legacy_shipping_options',
      options: '-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000' },
    onclose() { if (!disposing) abort(); },
  });
  let closing: Promise<void> | undefined;
  function dispose() {
    disposing = true;
    return closing ??= connection.end({ timeout: 0 });
  }

  function run<T extends object[]>(statement: string, params: number[] = []) {
    if (stopped) throw unavailable();
    const result = connection.unsafe<T>(statement, params).then(rows => rows);
    pending = result;
    return result;
  }
  function finish(commit: boolean): Promise<void> {
    if (!cleanup) {
      stopped = true;
      cleanup = (async () => {
        // The deadline remains active through pending SQL and COMMIT/ROLLBACK.
        // dispose() terminates this client's pending/queued work on abort.
        await pending.catch(() => undefined);
        try {
          if (!disposing) await connection.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
          if (commit && cancelled) throw unavailable();
        } finally {
          try { await dispose(); }
          finally { clearTimeout(timer); signal.removeEventListener('abort', abort); settle(); }
        }
      })();
    }
    return cleanup;
  }
  function abort() {
    if (disposing) return;
    cancelled = true;
    controller?.error(unavailable());
    // Track closure through finish()/completion. No shared pool is ended.
    void dispose().catch(() => undefined);
    // completion is registered with waitUntil by the HTTP boundary.
    void finish(false).catch(() => undefined);
  }
  async function batch(): Promise<Option[]> {
    const rows = await run<Option[]>(`FETCH FORWARD ${BATCH_SIZE} FROM supplier_product_shipping_options`);
    if (rows.length > BATCH_SIZE || rows.some(row => !Number.isSafeInteger(row.id) || row.id < 1 || typeof row.name !== 'string')) throw unavailable();
    return rows.map(({ id, name }) => ({ id, name }));
  }

  signal.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, duration);
  try {
    if (signal.aborted) throw unavailable();
    await run('BEGIN READ ONLY');
    await run("SET LOCAL search_path TO public,pg_temp");
    await run("SET LOCAL statement_timeout TO '5s'");
    await run("SET LOCAL idle_in_transaction_session_timeout TO '10s'");
    await run(`DECLARE supplier_product_shipping_options NO SCROLL CURSOR WITHOUT HOLD FOR
      SELECT id,name FROM shipping_templates WHERE owner_type=2 AND relation_id=$1 AND is_del=0
      ORDER BY sort DESC,id DESC`, [supplierId]);
    // Fail before sending HTTP 200 if setup/permission/first FETCH cannot succeed.
    let firstBatch: Option[] | undefined = await batch();
    if (stopped) throw unavailable();
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      async pull(value) {
        if (stopped) return;
        try {
          const rows = firstBatch ?? await batch();
          firstBatch = undefined;
          if (stopped) return;
          const prefix = first ? '{"status":200,"msg":"ok","data":[' : rows.length ? ',' : '';
          first = false;
          const chunk = prefix + rows.map(row => JSON.stringify(row)).join(',');
          if (rows.length < BATCH_SIZE) {
            // A partial read or failed commit must never form valid success JSON.
            await finish(true);
            if (!cancelled) { value.enqueue(encoder.encode(chunk + ']}')); value.close(); }
          } else {
            value.enqueue(encoder.encode(chunk));
          }
        } catch {
          cancelled = true;
          value.error(unavailable());
          await finish(false).catch(() => undefined);
        }
      },
      async cancel() { cancelled = true; await finish(false).catch(() => undefined); },
    }, { highWaterMark: 0 });
    return { body, completion };
  } catch (error) {
    await finish(false).catch(() => undefined);
    throw error;
  }
}
