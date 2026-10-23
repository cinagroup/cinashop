import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if(process.env.TEST_DIY_PRESENTATION_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('DIY presentation Browser requires owned local PG16');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/diy-presentation.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:36*60_000,hookTimeout:90_000}});
