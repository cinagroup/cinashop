/** Executed as a separate Node/tsx process with the immutable old workers cwd.
 * No module under the current checkout is imported here. The protocol receives
 * a temporary LOGIN through stdin and never emits its connection string. */
import { readFileSync, realpathSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, URL as NodeURL } from 'node:url';

const REF = '41f4d25ae1daab3067f5ea745d30cabd77c93b80';
const PREFIX = 'COUPON_LEGACY_RUNTIME_RESULT ';
type Input = { connectionString: string; role: string; appKey: string; uid: number;
  config: Array<[string, string | null]>; selection: Record<string, unknown>; mode: 'quote' | 'create' };
type Put = { key: string; value: string; ttl?: number };
let stage = 'stdin';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('protocol');
  return value as Record<string, unknown>;
}
function check(value: unknown, label: string): asserts value {
  if (!value) throw Error(label);
}

/** Bundle the complete fixed App to preserve its normal bundled evaluation of
 * legacy circular imports. No entry replacement, pricing hook or auth shim is
 * supplied. Every bundled source must be tracked in the same immutable repo. */
async function bundledOldApp(workers: string, repository: string, tsconfig: string) {
  stage = 'old_bundle_prepare';
  const require = createRequire(join(workers, 'package.json'));
  const esbuild = require('esbuild') as typeof import('esbuild');
  check(esbuild.version === '0.28.2', 'old_esbuild_version');
  const directory = await mkdtemp(join(tmpdir(), 'cinashop-coupon-old-bundle-'));
  const outfile = join(directory, 'app.mjs');
  const provenance = { entryPoint: 'workers-ts/src/app.ts', format: 'esm', platform: 'node', target: 'node24', packages: 'external',
    esbuildVersion: esbuild.version, inputCount: 0, inputs: {} as Record<string, string>, inputManifestSha256: '', bundleSha256: '',
    externalImports: [] as string[], emittedExternalAliases: [] as string[], allInputsTrackedInFixedRepository: true,
    allTrackedFilesCleanAtFixedRef: true, sourceScopesHaveNoUntrackedFiles: true, temporaryDirectoryRemoved: false };
  const release = async () => { await rm(directory, { recursive: true, force: true }); provenance.temporaryDirectoryRemoved = true; };
  try {
    // Only the symlink itself belongs to this temporary directory. rm never
    // traverses it into the shared locked dependency installation.
    await symlink(realpathSync(join(workers, 'node_modules')), join(directory, 'node_modules'), 'dir');
    stage = 'old_bundle_build';
    const built = await esbuild.build({ entryPoints: [join(workers, 'src/app.ts')], outfile, absWorkingDir: workers, tsconfig,
      bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external', metafile: true, logLevel: 'silent' });
    check(built.metafile, 'old_bundle_metafile_missing');
    stage = 'old_bundle_provenance';
    const tracked = new Set(execFileSync('git', ['-C', repository, 'ls-files', '-z', '--', 'workers-ts/src', 'view/common'], { encoding: 'utf8' }).split('\0').filter(Boolean));
    execFileSync('git', ['-C', repository, 'diff', '--quiet', REF, '--']);
    const inputs = Object.keys(built.metafile.inputs).map(path => {
      const absolute = realpathSync(resolve(workers, path)), name = relative(repository, absolute).split(sep).join('/');
      check(absolute.startsWith(repository + sep) && !isAbsolute(name) && !name.split('/').includes('..')
        && !name.includes('ci-readonly-key') && tracked.has(name), 'old_bundle_input_not_fixed');
      check(name.startsWith('workers-ts/src/') || name.startsWith('view/common/'), 'old_bundle_input_scope');
      return [name, createHash('sha256').update(readFileSync(absolute)).digest('hex')] as const;
    }).sort(([left], [right]) => left.localeCompare(right, 'en'));
    check(inputs.length === 1796 && new Set(inputs.map(([name]) => name)).size === inputs.length, 'old_bundle_input_count');
    provenance.inputs = Object.fromEntries(inputs); provenance.inputCount = inputs.length;
    provenance.inputManifestSha256 = createHash('sha256').update(JSON.stringify(provenance.inputs)).digest('hex');
    provenance.bundleSha256 = createHash('sha256').update(readFileSync(outfile)).digest('hex');
    const outputs = Object.values(built.metafile.outputs); check(outputs.length === 1, 'old_bundle_output_count');
    const emitted = outputs[0].imports;
    // Input metadata can retain erased type-only aliases. Only emitted imports
    // execute; each must resolve as an external package or Node built-in.
    check(emitted.every(entry => entry.external && !/^(?:@\/|\.|\/|file:)/u.test(entry.path)), 'old_bundle_emitted_source_external');
    provenance.externalImports = [...new Set(emitted.map(entry => entry.path))].sort();
    provenance.emittedExternalAliases = emitted.filter(entry => entry.path.startsWith('@/')).map(entry => entry.path);
    stage = 'old_bundle_import';
    const { createApp } = await import(pathToFileURL(outfile).href);
    check(typeof createApp === 'function', 'old_bundle_app_missing');
    return { createApp, provenance, release };
  } catch (error) { await release(); throw error; }
  finally { esbuild.stop(); }
}

async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length; check(size <= 131072, 'input_size'); chunks.push(bytes);
  }
  const input = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as unknown as Input;
  check(typeof input.connectionString === 'string' && typeof input.role === 'string'
    && /^[a-z_][a-z_0-9]{0,62}$/.test(input.role), 'login_protocol');
  const target = new NodeURL(input.connectionString);
  check(['postgres:', 'postgresql:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    && target.username === input.role && Boolean(target.password) && Number(target.port) > 0, 'owned_endpoint');
  check(input.uid === 11 && typeof input.appKey === 'string' && input.appKey.length > 8 && Array.isArray(input.config), 'actor_protocol');
  check(input.mode === 'quote' || input.mode === 'create', 'mode_protocol');
  check(JSON.stringify(input.selection) === JSON.stringify({ cartIds: [1], type: 0, addressId: 11,
    shippingType: 1, storeId: 0, couponId: 956101, useIntegral: false }), 'fixed_selection');

  stage = 'fixed_source';
  const workers = realpathSync(process.cwd()), repository = dirname(workers);
  check(workers.endsWith('/workers-ts'), 'old_workers_cwd');
  const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  check(head === REF, 'old_git_head');
  execFileSync('git', ['-C', repository, 'diff', '--quiet', REF, '--']);
  const untracked = execFileSync('git', ['-C', repository, 'ls-files', '--others', '-z', '--', 'workers-ts/src', 'view/common']);
  check(untracked.length === 0, 'old_untracked_source_shadow');
  const tsconfigPath = join(workers, 'tsconfig.json');
  check(realpathSync(process.env.TSX_TSCONFIG_PATH ?? '') === tsconfigPath, 'old_tsconfig_alias');
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as { compilerOptions: { baseUrl: string; paths: Record<string, string[]> } };
  check(tsconfig.compilerOptions.baseUrl === '.' && JSON.stringify(tsconfig.compilerOptions.paths['@/*']) === '["src/*"]', 'old_src_alias');
  const sources: Record<string, string> = {};
  for (const path of ['tsconfig.json', 'src/app.ts', 'src/lib/di.ts', 'src/services/order/LegacyOrderCompatibilityService.ts',
    'src/services/order/StoreOrderCreateService.ts', 'src/services/activity/OrderCouponService.ts',
    'src/services/activity/ProductCouponService.ts', 'src/services/activity/StoreNewcomerService.ts',
    'src/services/order/CheckoutLineAllocation.ts', 'src/services/order/CheckoutConfirmation.ts']) {
    const live = readFileSync(join(workers, path)), fixed = execFileSync('git', ['-C', repository, 'show', `${REF}:workers-ts/${path}`]);
    check(live.length === fixed.length && live.every((byte, index) => byte === fixed[index]), 'old_source_bytes'); sources['workers-ts/' + path] = createHash('sha256').update(live).digest('hex');
  }
  const bundle = await bundledOldApp(workers, repository, tsconfigPath);
  try {
  // The full App is a bundle of all verified old sources. Direct transport/JWT
  // imports below retain their checked absolute old paths outside Vitest mocks.
  const { createApp } = bundle;
  stage = 'old_di_import';
  const { createContainer } = await import(pathToFileURL(resolve(workers, 'src/lib/di.ts')).href);
  stage = 'old_jwt_import';
  const { createToken, md5 } = await import(pathToFileURL(resolve(workers, 'src/utils/jwt.ts')).href);

  stage = 'transports';
  const values = new Map<string, string>(), puts: Put[] = [];
  for (const entry of input.config) {
    check(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
      && entry[0].startsWith('cfg_') && entry[0].length > 4 && entry[0].length <= 260
      && !/[\x00-\x1f\x7f]/u.test(entry[0])
      && (typeof entry[1] === 'string' || entry[1] === null), 'config_transport');
    if (entry[1] !== null) values.set(entry[0], entry[1]);
  }
  let externalCalls = 0, sequenceCalls = 0;
  globalThis.fetch = async () => { externalCalls++; throw Error('external_io_forbidden'); };
  const env = { NODE_ENV: 'test', APP_KEY: input.appKey, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    HYPERDRIVE: { connectionString: input.connectionString },
    CONFIG_KV: {
      get: async (key: string, type?: string) => values.has(key) ? type === 'json' ? JSON.parse(values.get(key)!) : values.get(key)! : null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        puts.push({ key, value, ttl: options?.expirationTtl }); values.set(key, value);
      },
      delete: async () => { throw Error('old_quote_delete_forbidden'); },
    },
    TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, auditEvent: false,
      limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) },
    SEQUENCE: { idFromName: () => 'owned-legacy-coupon', get: () => ({ fetch: async () => {
      sequenceCalls++; check(input.mode === 'create' && sequenceCalls === 1, 'old_order_number_forbidden');
      return new Response('coupon_legacy_created_1');
    } }) },
    ORDER_QUEUE: { send: async () => { throw Error('old_quote_queue_forbidden'); },
      sendBatch: async () => { throw Error('old_quote_queue_forbidden'); } },
  };
  stage = 'actual_login';
  const container = createContainer(env);
  let token: string, identity: Record<string, unknown>;
  try {
    const rows = await container.db.$client.unsafe('SELECT current_user AS role,session_user AS session,current_database() AS database');
    identity = rows[0]; check(identity.role === input.role && identity.session === input.role, 'old_actual_role');
    const account = await container.userDao.findForAuth(input.uid);
    check(account && account.uid === input.uid, 'old_actual_account');
    token = (await createToken(input.uid, 'api', md5(account.pwd), input.appKey)).token;
  } finally { await container.db.$client.end({ timeout: 5 }); }
  const app = createApp(), replies: Array<{ path: string; httpStatus: number; body: string; sha256: string }> = [];
  const request = async (path: string, payload = input.selection) => {
    const tasks: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('http://127.0.0.1' + path, { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env,
    { waitUntil: (task: Promise<unknown>) => { tasks.push(task); }, passThroughOnException() {}, props: {} });
    await Promise.all(tasks);
    const body = await response.text(), reply = object(JSON.parse(body));
    replies.push({ path, httpStatus: response.status, body, sha256: createHash('sha256').update(body).digest('hex') });
    check(response.status === 200 && reply.status === 200, 'old_actual_http'); return object(reply.data);
  };
  stage = 'actual_confirm';
  const confirm = await request('/api/order/confirm'), price = object(confirm.priceGroup);
  check(price.totalPrice === '19.99' && price.couponPrice === '2.99' && price.pay_price === '17.00', 'old_confirm_money');
  check(typeof confirm.orderKey === 'string' && typeof confirm.quoteToken === 'string', 'old_confirm_receipt');
  stage = 'actual_computed';
  const computed = await request('/api/order/computed/' + confirm.orderKey);
  check(computed.orderKey === confirm.orderKey && computed.couponPrice === '2.99' && computed.pay_price === '17.00', 'old_computed_money');
  check(typeof computed.quoteToken === 'string' && computed.quoteToken !== confirm.quoteToken, 'old_computed_receipt');
  check(puts.length === 3 && puts.every(put => put.ttl === 1800), 'old_kv_writes');
  check(externalCalls === 0 && sequenceCalls === 0, 'old_quote_no_writers');
  let created: Record<string, unknown> | undefined;
  let createdState: { order: Record<string, unknown>; lines: Record<string, unknown>[] } | undefined;
  if (input.mode === 'create') {
    stage = 'actual_create';
    created = await request('/api/order/create/' + confirm.orderKey, { ...input.selection, quoteToken: computed.quoteToken });
    check(created.key === confirm.orderKey && created.orderId === 'coupon_legacy_created_1', 'old_created_response');
    const reader = createContainer(env);
    try {
      const orders = await reader.db.$client.unsafe('SELECT id,uid,order_id,"unique",paid,coupon_price::text,pay_price::text FROM public.store_order WHERE uid=$1 AND "unique"=$2', [input.uid, confirm.orderKey]);
      check(orders.length === 1, 'old_created_order_count'); const order = orders[0];
      check(order.paid === 0 && order.coupon_price === '2.99' && order.pay_price === '17.00', 'old_created_sql_money');
      const lines = await reader.db.$client.unsafe('SELECT product_id,cart_num,cart_info FROM public.store_order_cart_info WHERE oid=$1 ORDER BY id', [order.id]) as Record<string, unknown>[];
      check(lines.length === 1 && object(JSON.parse(String(lines[0].cart_info))).coupon_price === '2.99', 'old_created_line_money');
      createdState = { order, lines: Array.from(lines) };
    } finally { await reader.db.$client.end({ timeout: 5 }); }
    check(Number(sequenceCalls) === 1 && externalCalls === 0, 'old_created_effects');
    check(puts.length === 3, 'old_created_kv_unchanged');
  }
  const records = [...values.entries()].filter(([key]) => !key.startsWith('cfg_'));
  check(records.length === 3, 'old_kv_records');
  const result = { version: 1, mode: input.mode, ref: head, sources, bundle: bundle.provenance, identity: identity!, externalCalls, sequenceCalls,
    selection: input.selection, confirm, computed, replies, puts, records, ...(created ? { created, createdState } : {}) };
  return result;
  } finally { await bundle.release(); }
}
main().then(result => {
  // Production DI opens one client per request; process exit closes those
  // child-owned sockets. The bundle finally has completed before output/exit.
  process.stdout.write(PREFIX + JSON.stringify(result) + '\n', () => process.exit(0));
}).catch(error => {
  // Never stringify DB errors, stdin, env or URLs containing temporary secrets.
  const label = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'unexpected';
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  process.stderr.write('COUPON_LEGACY_RUNTIME_FAILURE ' + JSON.stringify({ stage, label, code }) + '\n', () => process.exit(1));
});
