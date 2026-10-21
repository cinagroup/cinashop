import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { reverseRouteSourceIncrement, reverseRouteSourceFollowup, type RouteSourceIncrement, type RouteSourceFollowup } from "./helpers/routeSourceIncrement";
import { loadStatisticsScript, type StatisticsScriptElement } from "../../view/common/statisticsScript";

interface RouteDecision {
  surface: string; method: string; path: string; status: string;
  reason: string; evidence: string[]; replacement: string;
}
interface SourceProof { file: string; sha256: string; evidence_lines?: Array<number|[number,number]>; line_count?: number }
interface RestorationProof {
  status: string;
  route: { surface: string; method: string; path: string; php_target: string; worker_target: string };
  human_decision: { statement: string };
  previous_manifest: { sha256: string; retired_count: number };
  previous_retirement: RouteDecision;
  previous_retirement_json_sha256: string;
  retained_retirements: { count: number; decisions_json_sha256: string; identities: Array<{ surface: string; method: string; path: string }> };
  php_sources: SourceProof[];
  current_sources: Array<SourceProof & { role: string }>;
}
const root=resolve(import.meta.dirname,"../..");
const read=(file:string)=>readFileSync(resolve(root,file),"utf8");
const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const authority=JSON.parse(read("workers-ts/audit/legacy-route-authority.json")) as {
  files:Record<string,{sha256:string;lineCount:number}>;
  surfaces:{api:Array<{method:string;path:string;target:string}>};
};
const decisions=JSON.parse(read("workers-ts/audit/legacy-route-decisions.json")) as {decisions:RouteDecision[]};
const restoration=JSON.parse(read("workers-ts/audit/statistics-script-restoration-20261015.json")) as RestorationProof;
const stateIncrement=JSON.parse(read("workers-ts/audit/community-state-root-source-increment-20261021.json")) as RouteSourceIncrement & {
  route_file:string; statistics_restoration:{file:string;sha256:string};
};
const availabilityFollowup=JSON.parse(read("workers-ts/audit/community-availability-root-source-followup-20261021.json")) as RouteSourceFollowup;
function source(file:string){
  const raw=read(file),text=file.endsWith(".vue")?/<script\b[^>]*>([\s\S]*?)<\/script>/.exec(raw)?.[1]:raw;
  if(text===undefined)throw Error("Statistics entry script missing: "+file);
  return ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
}
function calls(node:ts.Node){
  const result:ts.CallExpression[]=[];
  const visit=(child:ts.Node)=>{if(ts.isCallExpression(child))result.push(child);ts.forEachChild(child,visit);};
  visit(node);return result;
}
function namedImport(file:ts.SourceFile,name:string,module:string){
  for(const statement of file.statements){
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)||statement.moduleSpecifier.text!==module)continue;
    const bindings=statement.importClause?.namedBindings;if(!bindings||!ts.isNamedImports(bindings))continue;
    const match=bindings.elements.find(binding=>(binding.propertyName?.text??binding.name.text)===name);
    if(match)return match.name.text;
  }
  throw Error("Missing real statistics import: "+name+" from "+module);
}
const literal=(node:ts.Node|undefined)=>node&&ts.isStringLiteral(node)?node.text:undefined;

describe("restored PHP statistics script contract and retained retirement history",()=>{
  it("preserves PHP authority, the exact prior retirement and the user's explicit restoration choice",()=>{
    expect(authority.surfaces.api).toContainEqual(expect.objectContaining({method:"GET",path:"/api/get_script",target:"v1.PublicController/getScript"}));
    expect(restoration.status).toBe("restored_php_compatibility");
    expect(restoration.route).toEqual({surface:"api",method:"GET",path:"/api/get_script",php_target:"v1.PublicController/getScript",worker_target:"PublicController.getScript"});
    expect(restoration.human_decision.statement).toBe("保留已恢复的 PHP 兼容行为，更新退役审计");
    expect(restoration.previous_manifest).toMatchObject({retired_count:17,sha256:"c92bd28c9ca29f3cbbf9108c52153c20af5e65ecc1ed195afb257c537ac01b56"});
    expect(digest(JSON.stringify(restoration.previous_retirement))).toBe("300cfac2602b507dc88726df2c9b7452fd2e282469b172dd843f97f0e044a4db");
    expect(restoration.previous_retirement_json_sha256).toBe("300cfac2602b507dc88726df2c9b7452fd2e282469b172dd843f97f0e044a4db");
    expect(restoration.previous_retirement).toMatchObject({surface:"api",method:"GET",path:"/api/get_script",status:"retired",
      evidence:["cinashop-php/route/api.php:26","cinashop-php/app/controller/api/v1/PublicController.php:640","cinashop-php/view/uniapp/App.vue:290","cinashop-php/app/services/system/config/SystemConfigServices.php:1843"]});
    expect(restoration.php_sources.map(row=>row.file)).toEqual([
      "cinashop-php/route/api.php","cinashop-php/app/controller/api/v1/PublicController.php",
      "cinashop-php/view/uniapp/App.vue","cinashop-php/app/services/system/config/SystemConfigServices.php",
    ]);
    for(const proof of restoration.php_sources)expect(authority.files[proof.file]).toEqual({sha256:proof.sha256,lineCount:proof.line_count});
  });

  it("removes only get_script from the live retirement manifest and preserves each of the other sixteen decisions",()=>{
    expect(decisions.decisions).toHaveLength(16);
    expect(decisions.decisions.every(row=>row.status==="retired")).toBe(true);
    expect(decisions.decisions.some(row=>row.surface==="api"&&row.method==="GET"&&row.path==="/api/get_script")).toBe(false);
    expect(digest(JSON.stringify(decisions.decisions))).toBe("1f239cb9054ade283f46cd3476c8a0664883c94370e3b6120124f0fb5c41af77");
    expect(restoration.retained_retirements).toEqual({count:16,decisions_json_sha256:"1f239cb9054ade283f46cd3476c8a0664883c94370e3b6120124f0fb5c41af77",
      identities:decisions.decisions.map(({surface,method,path})=>({surface,method,path}))});
  });

  it("binds the complete current handler, route, loader and three frontend entry sources",()=>{
    expect(restoration.current_sources.map(({role,file})=>[role,file])).toEqual([
      ["worker_handler","workers-ts/src/controllers/api/v1/PublicController.ts"],
      ["worker_route","workers-ts/src/routes/v1/index.ts"],
      ["shared_loader","view/common/statisticsScript.ts"],
      ["admin_entry","view/admin-ts/src/main.ts"],
      ["supplier_entry","view/supplier-ts/src/main.ts"],
      ["uniapp_h5_entry","view/uniapp-ts/src/App.vue"],
    ]);
    expect(stateIncrement.statistics_restoration).toEqual({file:"workers-ts/audit/statistics-script-restoration-20261015.json",
      sha256:"68dbcb37e31f6ed8c57efe0ab0c41684f1e1edda9394a547129cf235ab5cf8f1"});
    expect(digest(readFileSync(resolve(root,stateIncrement.statistics_restoration.file)))).toBe(stateIncrement.statistics_restoration.sha256);
    expect(stateIncrement.route_file).toBe("workers-ts/src/routes/v1/index.ts");
    expect(stateIncrement.inserted_source).toBe('v1Routes.get("/community/state/:id", authMiddleware({ force: false }), CommunityController.communityState);');
    for(const proof of restoration.current_sources){
      const current=read(proof.file);
      const original=proof.file===stateIncrement.route_file?reverseRouteSourceIncrement(reverseRouteSourceFollowup(current,availabilityFollowup),stateIncrement):current;
      expect(digest(original),proof.file).toBe(proof.sha256);
    }
  });

  it.each([
    ["route", "workers-ts/src/routes/v1/index.ts", "PublicController.getScript", "PublicController.getScriptChanged"],
    ["handler", "workers-ts/src/controllers/api/v1/PublicController.ts", "c.body(script)", "c.body('')"],
  ])("rejects a statistics %s mutation even when the state route exists",(_role,file,before,after)=>{
    const proof=restoration.current_sources.find(row=>row.file===file)!;
    const changed=read(file).replace(before,after);
    expect(changed).not.toBe(read(file));
    if(file===stateIncrement.route_file)expect(()=>reverseRouteSourceIncrement(reverseRouteSourceFollowup(changed,availabilityFollowup),stateIncrement)).toThrow();
    else expect(digest(changed)).not.toBe(proof.sha256);
  });

  it("registers the real public handler and returns the configured script through the raw body",()=>{
    const routes=source("workers-ts/src/routes/v1/index.ts");
    expect(routes.statements.some(statement=>ts.isImportDeclaration(statement)&&literal(statement.moduleSpecifier)==="@/controllers/api/v1/PublicController"
      &&statement.importClause?.namedBindings&&ts.isNamespaceImport(statement.importClause.namedBindings)&&statement.importClause.namedBindings.name.text==="PublicController")).toBe(true);
    const registration=calls(routes).filter(call=>call.expression.getText(routes)==="v1Routes.get"&&literal(call.arguments[0])==="/get_script");
    expect(registration).toHaveLength(1);expect(registration[0].arguments.map(arg=>arg.getText(routes))).toEqual(["'/get_script'","PublicController.getScript"]);
    const controller=source("workers-ts/src/controllers/api/v1/PublicController.ts");
    const config=namedImport(controller,"SystemConfigService","@/services/system/SystemConfigService");
    const handler=controller.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==="getScript");
    if(!handler||!ts.isFunctionDeclaration(handler)||!handler.body)throw Error("Statistics handler missing");
    const getters=calls(handler).filter(call=>ts.isPropertyAccessExpression(call.expression)&&call.expression.name.text==="get"&&literal(call.arguments[0])==="system_statistics");
    expect(getters).toHaveLength(1);
    const script=handler.body.statements.filter(ts.isVariableStatement).flatMap(statement=>statement.declarationList.declarations)
      .find(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text==="script");
    expect(script?.initializer&&ts.isAwaitExpression(script.initializer)&&script.initializer.expression===getters[0]).toBe(true);
    const getter=getters[0].expression;if(!ts.isPropertyAccessExpression(getter)||!ts.isNewExpression(getter.expression))throw Error("Statistics configuration service call missing");
    expect(getter.expression.expression.getText(controller)).toBe(config);
    expect(getter.expression.arguments?.map(arg=>arg.getText(controller))).toEqual(["c.get('container')","c.env"]);
    const returned=handler.body.statements.find(ts.isReturnStatement);
    expect(returned?.expression?.getText(controller)).toBe("c.body(script)");
    expect(handler.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword)).toBe(true);
  });

  it.each([
    ["view/admin-ts/src/main.ts","'/adminapi'"],
    ["view/supplier-ts/src/main.ts","import.meta.env.VITE_API_BASE_URL??'/supplierapi'"],
    ["view/uniapp-ts/src/App.vue","API_BASE"],
  ])("connects %s to the actual shared loader with its configured API base",(path,argument)=>{
    const file=source(path),name=namedImport(file,"loadStatisticsScript","../../common/statisticsScript");
    const invocations=calls(file).filter(call=>ts.isIdentifier(call.expression)&&call.expression.text===name);
    expect(invocations).toHaveLength(1);expect(invocations[0].arguments.map(arg=>arg.getText(file).replace(/\s+/g,""))).toEqual([argument]);
    if(path.endsWith("App.vue")){
      const launchName=namedImport(file,"onLaunch","@dcloudio/uni-app");
      const launch=calls(file).find(call=>ts.isIdentifier(call.expression)&&call.expression.text===launchName);
      expect(launch&&calls(launch.arguments[0]).includes(invocations[0])).toBe(true);
      expect(namedImport(file,"API_BASE","@/utils/request")).toBe("API_BASE");
      const raw=read(path),position=raw.indexOf(invocations[0].getText(file));expect(position).toBeGreaterThan(0);
      expect(raw.slice(0,position).lastIndexOf("// #ifdef H5")).toBeGreaterThan(raw.slice(0,position).lastIndexOf("// #endif"));
    }
  });

  it("uses the real script-element loader, reuses its public URL and permits retry after a failed load",()=>{
    // Explicit DOM stand-in only. The existing HTTP and frontend suites retain
    // their real controller/configuration and origin/platform behavior checks.
    const appended:StatisticsScriptElement[]=[],listeners=new Map<StatisticsScriptElement,()=>void>();let created=0;
    const surface={
      querySelectorAll:(selector:string)=>{expect(selector).toBe("script[data-cinashop-statistics]");return appended;},
      createElement:(tag:"script")=>{expect(tag).toBe("script");created++;const attrs=new Map<string,string>();
        const script:StatisticsScriptElement={src:"",async:false,getAttribute:name=>name==="src"?script.src:attrs.get(name)??null,
          setAttribute:(name,value)=>{attrs.set(name,value);},addEventListener:(event,listener,options)=>{expect(event).toBe("error");expect(options).toEqual({once:true});listeners.set(script,listener);},
          remove:()=>{const index=appended.indexOf(script);if(index>=0)appended.splice(index,1);}};return script;},
      head:{appendChild:(script:StatisticsScriptElement)=>{appended.push(script);}},
      documentElement:{appendChild:()=>{throw Error("Unexpected fallback when document.head exists");}},
    };
    const first=loadStatisticsScript("/adminapi",surface);expect(first).toBeDefined();expect(first?.src).toBe("/api/get_script");
    expect(first?.async).toBe(true);expect(first?.getAttribute("data-cinashop-statistics")).toBe("");
    expect(loadStatisticsScript("/supplierapi",surface)).toBe(first);expect(appended).toHaveLength(1);expect(created).toBe(1);
    listeners.get(first!)!();expect(appended).toEqual([]);
    expect(loadStatisticsScript("/api",surface)).not.toBe(first);expect(appended).toHaveLength(1);expect(created).toBe(2);
  });
});
