import { sequenceRunnerDatabase } from '../test/helpers/kefuSequenceRunnerDatabase';
import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from '../src/migrations/shippingTemplateCreateReplay';
import { SHIPPING_CREATE_REPLAY_CATALOG_SQL } from '../src/migrations/shippingTemplateCreateReplayCatalog';
const f = await sequenceRunnerDatabase();
if (f.format !== 'pg16') { await f.close(); throw new Error('Dedicated PG16 required'); }
try { await f.exec(SHIPPING_TEMPLATE_CREATE_REPLAY_SQL); console.log(JSON.stringify(await f.query(SHIPPING_CREATE_REPLAY_CATALOG_SQL), null, 2)); }
finally { await f.close(); }
