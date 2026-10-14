import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { productRuleFixture, ruleActor, ruleBody } from '../../test/helpers/adminProductRules.ts';
import { storeProductRule, systemLog } from '../../src/models/schema/index.ts';
const f = await productRuleFixture();
const facts = { driver: 'PGlite isolated owned memory via existing financePostgres helper', trigger: 'BEFORE INSERT system_log sets store_id=73, merchant_id=91, admin_name=forged-name, ip=203.0.113.73', outcomes: [], cleanup: false };
try {
  await f.exec("CREATE FUNCTION rewrite_rule_audit_scope_repro() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.store_id=73; NEW.merchant_id=91; NEW.admin_name='forged-name'; NEW.ip='203.0.113.73'; RETURN NEW; END $$; CREATE TRIGGER rewrite_rule_audit_scope_repro BEFORE INSERT ON system_log FOR EACH ROW WHEN (NEW.type='product_rule_catalog') EXECUTE FUNCTION rewrite_rule_audit_scope_repro()");
  for (const [operation, action] of [['create', () => f.service.save(0, ruleBody({ rule_name: 'scope-create-repro' }), ruleActor())], ['update', () => f.service.save(10, ruleBody({ rule_name: 'scope-update-repro' }), ruleActor())], ['delete', () => f.service.remove(11, new URLSearchParams(), undefined, ruleActor())]]) {
    try { const result = await action(); facts.outcomes.push({ operation, committed: true, result }); }
    catch (error) { facts.outcomes.push({ operation, committed: false, error: String(error) }); }
  }
  facts.logs = await f.db.select().from(systemLog).orderBy(systemLog.id);
  facts.rules = await f.db.select().from(storeProductRule).orderBy(storeProductRule.id);
  assert.equal(facts.outcomes.length, 3); assert(facts.outcomes.every(row => row.committed));
  assert.equal(facts.logs.length, 3); assert(facts.logs.every(row => row.storeId === 73 && row.merchantId === 91 && row.adminName === 'forged-name' && row.ip === '203.0.113.73'));
  facts.reproduced = true;
} finally { await f.close(); facts.cleanup = true; }
await writeFile(new URL('./audit-scope-repro.json', import.meta.url), JSON.stringify(facts, null, 2)+'\n');
console.log(JSON.stringify({ reproduced: facts.reproduced, committedOperations: facts.outcomes.map(row => row.operation), logs: facts.logs.length, cleanup: facts.cleanup }));
