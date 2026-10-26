import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export interface GrowthRecordsManifestProof {
  schema:string;base_ref:string;file:string;before_sha256:string;after_sha256:string;
  before_bytes:number;after_bytes:number;before_pages:number;after_pages:number;inserted_line:number;inserted_source:string;
  legacy_rule:{key:string;before:{target:string;coverage:string};after:{target:string;coverage:string};before_rules_sha256:string;after_rules_sha256:string};
  preserved_files:Array<{file:string;bytes:number;sha256:string}>;
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(resolve(import.meta.dirname,'../fixtures/customer-growth-records-manifest-20261026.json'),'utf8');
if(sha(raw)!=='ad63de188028e7801656cae00e94dd2b1132abf0953febe3611c5439cb292298')throw Error('Growth records manifest proof bytes differ');
export const growthRecordsManifest=JSON.parse(raw) as GrowthRecordsManifestProof;
/** Peel exactly one page before the unchanged points, sign and dated footer gates. */
export function reverseGrowthRecordsManifest(source:string,binding=growthRecordsManifest):string {
  if(sha(JSON.stringify(binding))!=='c0a4dd11c982a3649bc61c1f27428c03a733df45a45fc946cc8bbfb8bb344ec8'||binding.schema!=='cinashop.customer-growth-records-manifest-increment.v1'
    ||binding.base_ref!=='c92584cd42a3329b6eb1d41dd7c875b070deb39b'||binding.file!=='view/uniapp-ts/src/pages.json'
    ||sha(source)!==binding.after_sha256||Buffer.byteLength(source)!==binding.after_bytes
    ||source.split(binding.inserted_source).length!==2
    ||source.slice(0,source.indexOf(binding.inserted_source)).split('\n').length!==binding.inserted_line)throw Error('Current growth records manifest differs');
  const previous=source.replace(binding.inserted_source,'');
  if(sha(previous)!==binding.before_sha256||Buffer.byteLength(previous)!==binding.before_bytes)throw Error('Previous growth records manifest differs');
  return previous;
}
