import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {describe,it,expect} from 'vitest';
import {projectMigrationMergeSource} from './helpers/migrationMergeSourceBinding';
const root=resolve(import.meta.dirname,'../..');
const binding=JSON.parse(readFileSync(resolve(import.meta.dirname,'fixtures/migration-merge-source-binding-20261030.json'),'utf8')) as {
 parents:Record<'main'|'checkpoint',{commit:string;sources:Record<string,{current_sha256:string;parent_sha256:string}>}>
};
const sha=(source:string)=>createHash('sha256').update(source).digest('hex');
for(const parent of ['main','checkpoint'] as const)describe(`migration merge preserves the exact ${parent} proof view`,()=>{
 it('names the full immutable parent commit',()=>{expect(binding.parents[parent].commit).toMatch(/^[a-f0-9]{40}$/);});
 for(const[file,image]of Object.entries(binding.parents[parent].sources))it(file,()=>{
  const current=readFileSync(resolve(root,file),'utf8');
  expect(sha(current)).toBe(image.current_sha256);
  expect(sha(projectMigrationMergeSource(file,current,parent))).toBe(image.parent_sha256);
  expect(()=>projectMigrationMergeSource(file,current+'\n',parent)).toThrow('source differs');
 });
});
