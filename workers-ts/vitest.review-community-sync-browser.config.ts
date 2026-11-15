import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if(process.env.TEST_REVIEW_COMMUNITY_SYNC_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Review community sync Browser acceptance requires its explicit owned PG16 runner');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/review-community-sync.acceptance.ts'],fileParallelism:false,silent:false,testTimeout:92*60000,hookTimeout:45000}});
