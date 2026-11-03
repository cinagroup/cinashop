import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname,'..'), key='37'.repeat(32), secret='owned-account-draft-authenticator';
const target=`postgres://maintenance:${secret}@invalid.example/inventory_db`;
function invoke(args:string[],inputs:Record<string,string|undefined>={}) {
  const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:target,APP_KEY:secret,
    ROUTINE_OWNERSHIP_INVENTORY_DATABASE_URL:target,ROUTINE_OWNERSHIP_INVENTORY_FINGERPRINT_KEY:key,
    ROUTINE_ACCOUNT_DRAFT_DATABASE_URL:target,ROUTINE_ACCOUNT_DRAFT_FINGERPRINT_KEY:key,ROUTINE_ACCOUNT_DRAFT_AUTHENTICATOR:secret,
    ROUTINE_IDENTITY_DRAFT_DATABASE_URL:target,ROUTINE_IDENTITY_DRAFT_FINGERPRINT_KEY:key,ROUTINE_IDENTITY_DRAFT_AUTHENTICATOR:secret};
  for(const name of ['ROUTINE_NOTIFICATION_DRAFT_DATABASE_URL','ROUTINE_NOTIFICATION_DRAFT_FINGERPRINT_KEY','ROUTINE_NOTIFICATION_DRAFT_AUTHENTICATOR'])delete env[name];
  for(const [name,value] of Object.entries(inputs))if(value!==undefined)env[name]=value;
  const result=spawnSync(process.execPath,['--import','tsx','scripts/routine-notification-continuation-cli.ts',...args],
    {cwd:root,env,encoding:'utf8',timeout:10000});
  expect(result.error).toBeUndefined();expect(result.status).toBe(1);expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Routine notification continuation draft incomplete; no send, ownership or switch authorization issued.\n');
  expect(result.stderr).not.toContain(secret);expect(result.stderr).not.toContain(key);
}
const complete={ROUTINE_NOTIFICATION_DRAFT_DATABASE_URL:target,ROUTINE_NOTIFICATION_DRAFT_FINGERPRINT_KEY:key,ROUTINE_NOTIFICATION_DRAFT_AUTHENTICATOR:secret};
describe('notification continuation CLI explicit local verification inputs',()=>{
  it.each(Object.keys(complete))('requires its own %s despite runtime and inventory fallbacks',name=>{
    invoke(['inventory_db','maintenance'],{...complete,[name]:undefined});
  });
  it.each([[],['inventory_db'],['inventory_db','bad role'],['inventory_db','maintenance','--switch']])('refuses invalid arguments %j',(...args)=>{
    invoke(args as string[],complete);
  });
  it.each([
    'https://maintenance:secret@invalid.example/inventory_db',
    'postgres://other:secret@invalid.example/inventory_db',
    'postgres://maintenance:secret@invalid.example/other',
    target+'?options=anything',target+'#anything',
  ])('refuses mismatched or decorated URL %s',url=>invoke(['inventory_db','maintenance'],{...complete,ROUTINE_NOTIFICATION_DRAFT_DATABASE_URL:url}));
  it.each(['A'.repeat(64),key+'0','ab'.repeat(31)])('refuses malformed independent fingerprint key %s',value=>invoke(['inventory_db','maintenance'],{
    ...complete,ROUTINE_NOTIFICATION_DRAFT_FINGERPRINT_KEY:value,
  }));
  it.each(['','x'.repeat(4097),'é'.repeat(2049)])('refuses an empty or over-4KiB UTF8 record authenticator case %#',value=>invoke(['inventory_db','maintenance'],{
    ...complete,ROUTINE_NOTIFICATION_DRAFT_AUTHENTICATOR:value,
  }));
  it('requires distinct fingerprint and record-verification keys',()=>invoke(['inventory_db','maintenance'],{
    ...complete,ROUTINE_NOTIFICATION_DRAFT_AUTHENTICATOR:key,
  }));
});
