import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
if(process.env.TEST_FINANCE_CENTER_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Finance center Browser requires owned PG16');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/finance-center.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:42*60000,hookTimeout:60000}});
