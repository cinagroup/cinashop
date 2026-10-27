import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
if(process.env.TEST_MEMBER_CARD_ACTIVATION_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Card activation Browser requires owned local PG16');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/membership-card-activation.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:39*60000,hookTimeout:45000}});
