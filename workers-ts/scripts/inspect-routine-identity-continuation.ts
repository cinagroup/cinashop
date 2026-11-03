/** Explicit maintenance inputs only. The authenticator is used locally for
 * HMAC verification; it is not a switch permit and is never sent to SQL. */
import postgres from 'postgres';
import { collectRoutineIdentityContinuationDraft } from './routine-ownership-inventory';

let client: ReturnType<typeof postgres> | undefined;
try {
  const [database, maintenance, ...extra] = process.argv.slice(2);
  if (extra.length || ![database,maintenance].every(v => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(v)))
    throw Error('Explicit target required');
  const target = process.env.ROUTINE_IDENTITY_DRAFT_DATABASE_URL;
  const key = process.env.ROUTINE_IDENTITY_DRAFT_FINGERPRINT_KEY;
  const authenticator = process.env.ROUTINE_IDENTITY_DRAFT_AUTHENTICATOR;
  if (!target || !key || !/^[a-f0-9]{64}$/.test(key) || !authenticator || Buffer.byteLength(authenticator)>4096
    || authenticator === key) throw Error('Explicit diagnostic inputs required');
  const url = new URL(target);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.search || url.hash
    || decodeURIComponent(url.pathname.slice(1)) !== database || decodeURIComponent(url.username) !== maintenance)
    throw Error('Unexpected target');
  client = postgres(target, { max:1, prepare:false, connect_timeout:5, idle_timeout:5, onnotice:()=>{},
    ssl:['127.0.0.1','localhost','[::1]'].includes(url.hostname)?false:'verify-full',
    connection:{options:'-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c default_transaction_read_only=on -c search_path=pg_catalog',
      application_name:'cinashop-routine-identity-continuation-draft'} });
  const report = await collectRoutineIdentityContinuationDraft(client,{database,maintenance},key,{APP_KEY:authenticator});
  process.stdout.write(JSON.stringify(report)+'\n');
} catch {
  process.stderr.write('Routine identity continuation draft incomplete; no ownership or switch authorization issued.\n');
  process.exitCode=1;
} finally {
  try { await client?.end({timeout:5}); }
  catch { process.stderr.write('Routine identity continuation connection close failed.\n'); process.exitCode=1; }
}
