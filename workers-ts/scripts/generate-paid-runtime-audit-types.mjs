import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = 'test/integration/paid-runtime-audit-bindings.d.ts';
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'types', output,
  '--config', 'test/integration/paid-runtime-audit.wrangler.jsonc', '--env-interface', 'PaidRuntimeAuditEnv',
  '--include-runtime', 'false', '--strict-vars', 'false'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: resolve(tmpdir(), 'cinashop-paid-runtime-types.log') },
});
// Keep Wrangler's bindings intact but module-scoped: this diagnostic Worker is
// not the application's Cloudflare.Env or NodeJS.ProcessEnv. No hand-written Env.
appendFileSync(resolve(root, output), '\n// Module-scoped by scripts/generate-paid-runtime-audit-types.mjs.\nexport type { PaidRuntimeAuditEnv };\n');
