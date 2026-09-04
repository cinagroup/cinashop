import { spawnSync } from "node:child_process";

const maxAttempts = 3;
const retryDelaysMs = [5_000, 15_000];
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("npm_execpath is unavailable; run this audit through npm run audit:prod");
}

const auditArgs = [
  npmCli,
  "audit",
  "--omit=dev",
  "--audit-level=low",
  "--registry=https://registry.npmjs.org",
  "--fetch-timeout=60000",
  "--fetch-retries=1",
  "--fetch-retry-mintimeout=5000",
  "--fetch-retry-maxtimeout=15000",
  "--json",
];

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseAuditJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function isRetryableServiceFailure(result, report) {
  if (report?.error) return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /audit endpoint returned an error|\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT)\b|\b5\d\d\s+(?:Service Unavailable|Bad Gateway|Gateway Timeout|Internal Server Error)\b/i.test(output);
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(process.execPath, auditArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  const report = parseAuditJson(result.stdout ?? "");

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) process.exit(0);

  if (!isRetryableServiceFailure(result, report) || attempt === maxAttempts) {
    process.exit(result.status ?? 1);
  }

  const delayMs = retryDelaysMs[attempt - 1];
  process.stderr.write(
    `[audit:prod] registry audit service unavailable; retrying attempt ${attempt + 1}/${maxAttempts} in ${delayMs / 1000}s\n`,
  );
  await wait(delayMs);
}
