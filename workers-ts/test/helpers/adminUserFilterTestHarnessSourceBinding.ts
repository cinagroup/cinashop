import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reverseRouteSourceFollowup,type RouteSourceFollowup } from './routeSourceIncrement';
export interface AdminUserFilterTestHarnessSourceBinding {
 schema:string;base_ref:string;
 sources:Array<RouteSourceFollowup&{file:string;before_ref:string;before_bytes:number;after_bytes:number}>;
 unchanged_contract_files:Array<{file:string;sha256:string;bytes:number}>;boundary:string;
}
const sha=(source:string)=>createHash('sha256').update(source).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/admin-user-filter-test-harness-source-binding-20261025.json'),'utf8');
if(sha(raw)!=='003db31800bcaec20f3ec571b64384e6173738860aa235a20c4087be3d7f9c2e')throw Error('Admin user-filter test-harness fixture bytes differ');
export const adminUserFilterTestHarnessSourceBinding=JSON.parse(raw) as AdminUserFilterTestHarnessSourceBinding;
const files=['workers-ts/test/diy-commerce-author-source-binding.test.ts','workers-ts/test/diy-commerce-preview-expiry-source-binding.test.ts'];
/** Only two complete test sources are peeled before E6's immutable preserved-file checks. */
export function reverseAdminUserFilterTestHarnessSource(file:string,source:string,binding=adminUserFilterTestHarnessSourceBinding):string{
 if(binding.schema!=='cinashop.admin-user-filter-test-harness-source-binding.v1'||binding.base_ref!=='330625d39b3988eb37ee73d19fde8e51e14cf625'||binding.sources.length!==2||binding.sources.some((row,index)=>row.file!==files[index]||row.before_ref!==binding.base_ref)||sha(JSON.stringify(binding.sources))!=='cb45a2891fcb9bdf3c3efe7787b966ddaef28791747ac927db00f31409946030')throw Error('Admin user-filter exact two-test-source inventory differs');
 const entry=binding.sources.find(row=>row.file===file);if(!entry)return source;
 if(Buffer.byteLength(source)!==entry.after_bytes)throw Error('Admin user-filter current test source bytes differ');
 const previous=reverseRouteSourceFollowup(source,entry);
 if(Buffer.byteLength(previous)!==entry.before_bytes)throw Error('Admin user-filter historical test source bytes differ');return previous;
}
