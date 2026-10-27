import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
if(process.env.TEST_DISTRIBUTION_LEDGERS_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Distribution ledgers Browser requires owned local PG16');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/distribution-ledgers.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:35*60000,hookTimeout:60000}});
