import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
if(process.env.TEST_SPREAD_POSTER_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Spread poster Browser requires owned local PG16');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/spread-poster.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:57*60000,hookTimeout:60000}});
