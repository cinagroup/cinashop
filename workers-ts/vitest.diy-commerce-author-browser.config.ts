import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if(process.env.TEST_DIY_COMMERCE_AUTHOR_BROWSER!=='1'||!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Commerce author Browser requires owned local PostgreSQL16');
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/diy-commerce-author.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:93*60000,hookTimeout:90000}});
