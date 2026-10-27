import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'src')}},test:{environment:'node',include:['test/browser/membership-clause.acceptance.ts'],fileParallelism:false,maxWorkers:1,silent:false,testTimeout:42*60000,hookTimeout:60000}});
