// Read-only, pre-edit DB-009E4 evidence extractor. After alignment use the
// frozen manifest and repeated engine/source-binding tests, not this extractor.
const assert=require("node:assert/strict");
const {readFileSync,readdirSync}=require("node:fs");
const {join}=require("node:path");
const ts=require("typescript");
const {is}=require("drizzle-orm");
const {PgTable}=require("drizzle-orm/pg-core");
const api=require("drizzle-kit/api");
const models=require("tsx/cjs/api").require("../src/models/schema/index.ts",__filename);
const root=join(__dirname,"..");
const read=file=>readFileSync(join(root,file),"utf8").replace(/\r\n/g,"\n");
const baseline=JSON.parse(read("audit/orm-ddl-catalog-baseline.json"));
const verified=JSON.parse(read("../MIGRATION_SCHEMA_AUDIT.json"));
const entries=baseline.records.filter(r=>r.comparison==="externalVsOrm"&&r.category==="constraints"&&r.change==="changed")
  .map(r=>({key:r.value.key,catalog:r.value.reference,previousCatalog:r.value.candidate}));
assert.equal(entries.length,9);
assert.equal(entries.filter(e=>!e.catalog.validated).length,8);
const snapshot=api.generateDrizzleJson(models),declarations=new Map();
for(const name of readdirSync(join(root,"src/models/schema")).filter(n=>n.endsWith(".ts"))){
  const file="src/models/schema/"+name,source=read(file),parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  function visit(node){
    if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isCallExpression(node.initializer)
      &&node.initializer.expression.getText(parsed)==="pgTable"&&ts.isStringLiteral(node.initializer.arguments[0])){
      const call=node.initializer,table=call.arguments[0].text;
      assert.ok(!declarations.has(table));
      declarations.set(table,{file,parsed,call,exportName:node.name.getText(parsed)});
    }
    ts.forEachChild(node,visit);
  }
  visit(parsed);
}
function clause(source,start){
  let depth=0,quote=null,opened=false;
  for(let i=start;i<source.length;i++){
    const c=source[i];
    if(quote){if(c===quote&&source[i+1]===quote)i++;else if(c===quote)quote=null;continue;}
    if(c==="'"||c==='"'){quote=c;continue;}
    if(c==="("){depth++;opened=true;}
    if(c===")")depth--;
    if(opened&&depth===0){
      const tail=source.slice(i+1).match(/^\s+NOT VALID\b/);
      return source.slice(start,i+1+(tail?tail[0].length:0));
    }
  }
  throw Error("Unterminated CHECK source");
}
const files=[...readdirSync(join(root,"migrations")).filter(n=>n.endsWith(".sql")).sort().map(n=>"migrations/"+n),
  "src/services/MigrationService.ts",...readdirSync(join(root,"src/migrations")).filter(n=>n.endsWith(".ts")).sort().map(n=>"src/migrations/"+n)];
for(const e of entries){
  const d=declarations.get(e.catalog.table),table=models[d.exportName];
  assert.ok(is(table,PgTable));
  const extra=d.call.arguments[2];
  assert.ok(ts.isArrowFunction(extra)&&ts.isArrayLiteralExpression(extra.body)&&extra.parameters.length===1);
  const found=extra.body.elements.filter(n=>ts.isCallExpression(n)&&n.expression.getText(d.parsed)==="check"&&n.arguments[0]?.text===e.catalog.name);
  assert.equal(found.length,1,e.key+" old CHECK declaration");
  const node=found[0],previousDeclaration=node.getText(d.parsed);
  e.previousSnapshot=JSON.parse(JSON.stringify(snapshot.tables["public."+e.catalog.table].checkConstraints[e.catalog.name]));
  assert.ok(e.previousSnapshot&&e.previousSnapshot.notValid===undefined,e.key+" old validated snapshot");
  e.snapshot={...e.previousSnapshot};
  let declaration=previousDeclaration;
  if(!e.catalog.validated){e.snapshot.notValid=true;declaration="notValid("+previousDeclaration+")";}
  else {
    const oldValues=[...e.previousSnapshot.value.matchAll(/'([^']*)'/g)].map(m=>m[1]);
    const newValues=[...e.catalog.definition.matchAll(/'([^']*)'/g)].map(m=>m[1]);
    assert.equal(oldValues.length,9);assert.deepEqual([...oldValues].sort(),[...newValues].sort());
    const reorder=text=>{let i=0;const result=text.replace(/'([^']*)'/g,()=>"'"+newValues[i++]+"'");assert.equal(i,9);return result;};
    e.snapshot.value=reorder(e.snapshot.value);declaration=reorder(previousDeclaration);
    e.allowedValues={previous:oldValues,target:newValues};
  }
  e.model={file:d.file,exportName:d.exportName,line:d.parsed.getLineAndCharacterOfPosition(node.getStart(d.parsed)).line+1,
    previousDeclaration,declaration};
  const fields=Object.entries(table).filter(([,c])=>c&&typeof c.getSQLType==="function")
    .map(([property,c])=>({property,name:c.name,type:c.getSQLType(),notNull:c.notNull}));
  const definition=e.catalog.definition.replace(/'(?:[^']|'')*'/g,"");
  e.fields=fields.filter(f=>new RegExp("\\b"+f.name+"\\b").test(definition));
  e.fieldDeclarations=e.fields.map(f=>d.call.arguments[1].properties.find(p=>p.name?.getText(d.parsed)===f.property).getText(d.parsed));
  e.sources=[];
  for(const file of files){
    const source=read(file),pattern=new RegExp('\\bCONSTRAINT\\s+"?'+e.catalog.name+'"?\\s+CHECK\\s*\\(',"g");
    for(const match of source.matchAll(pattern)){
      const sql=clause(source,match.index),line=source.slice(0,match.index).split("\n").length;
      e.sources.push({file,line,lineCount:sql.split("\n").length,sql});
    }
  }
  const external=e.sources.filter(s=>s.file.startsWith("migrations/"));
  assert.ok(external.length&&e.sources.some(s=>s.file.startsWith("src/")),e.key+" source paths");
  e.targetSource=external.at(-1);
  assert.equal(e.targetSource.sql.endsWith("NOT VALID"),!e.catalog.validated);
}
console.log(JSON.stringify({baselineCommit:baseline.commit,sourceCommit:verified.sourceCommit,sourceRunId:verified.runId,
  scope:"Nine CHECK differences: eight validation states and one equivalent event-list order. No production access.",entries,
  modelFiles:[...new Set(entries.map(e=>e.model.file))].map(file=>({file,source:read(file)}))}));
