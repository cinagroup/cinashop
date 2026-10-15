import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import ts from 'typescript';
import {
  storeProductCate,
  storeProductCategoryBrand,
  storeProductLabelAuxiliary,
} from "@/models/schema";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

const categorySources = () => ({
  product: readFileSync('src/services/supplier/SupplierProductManagementService.ts','utf8'),
  category: readFileSync('src/services/supplier/SupplierProductCategoryService.ts','utf8'),
});
/** Follow the production save dispatcher and the transaction that moves every
 * descendant. An old implementation pasted into a comment cannot prove it. */
function relationContract(sources: ReturnType<typeof categorySources>) {
  const compact = (value:string) => value.replace(/\s+/g,'').replace(/"/g,"'");
  const parsed = Object.fromEntries(Object.entries(sources).map(([role,text])=>[role,ts.createSourceFile(role+'.ts',text,ts.ScriptTarget.Latest,true)]));
  const printer = ts.createPrinter({removeComments:true});
  const scope = (role:string,name:string):ts.Block|undefined => {
    const found:ts.Block[]=[];
    const visit=(node:ts.Node)=>{if((ts.isMethodDeclaration(node)||ts.isFunctionDeclaration(node))&&node.name?.getText(parsed[role])===name&&node.body)found.push(node.body);ts.forEachChild(node,visit);};
    visit(parsed[role]);return found.length===1?found[0]:undefined;
  };
  const body = (role:string,name:string) => {
    const found=scope(role,name);return found?compact(printer.printNode(ts.EmitHint.Unspecified,found,parsed[role])):'';
  };
  const importsWithTx=parsed.category.statements.some(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)
    &&node.moduleSpecifier.text==='@/lib/di'&&!node.importClause?.isTypeOnly&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)
    &&node.importClause.namedBindings.elements.some(binding=>binding.name.text==='withTx'&&!binding.propertyName&&!binding.isTypeOnly));
  const saveBody=scope('category','save');
  const returnedCategoryWrite=!!saveBody?.statements.some(node=>{
    if(!ts.isReturnStatement(node)||!node.expression||!ts.isCallExpression(node.expression))return false;
    const call=node.expression,callback=call.arguments[1];
    return call.expression.getText(parsed.category)==='categoryWrite'&&call.arguments.length===2&&call.arguments[0]!.getText(parsed.category)==='this.container'
      &&!!callback&&ts.isArrowFunction(callback)&&!!callback.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)
      &&callback.parameters.length===1&&callback.parameters[0]!.name.getText(parsed.category)==='db'&&ts.isBlock(callback.body);
  });
  let returnsAwaitedWithTx=false;
  const transactionBody=scope('category','categoryWrite');
  const visitTransaction=(node:ts.Node)=>{
    // A same-name call in an unrelated nested function cannot prove the live wrapper.
    if(node!==transactionBody&&ts.isFunctionLike(node))return;
    if(ts.isReturnStatement(node)&&node.expression&&ts.isAwaitExpression(node.expression)&&ts.isCallExpression(node.expression.expression)){
      const call=node.expression.expression;
      if(call.expression.getText(parsed.category)==='withTx'&&call.arguments.length===2
        &&call.arguments[0]!.getText(parsed.category)==='container'&&call.arguments[1]!.getText(parsed.category)==='work')returnsAwaitedWithTx=true;
    }
    ts.forEachChild(node,visitTransaction);
  };
  if(transactionBody)visitTransaction(transactionBody);
  const imported=parsed.product.statements.some(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)
    &&node.moduleSpecifier.text==='./SupplierProductCategoryService'&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)
    &&node.importClause.namedBindings.elements.some(binding=>binding.name.text==='SupplierProductCategoryService'&&!binding.propertyName));
  const product=body('product','saveProduct'),moved=body('category','save');
  const all=Object.values(parsed).map(tree=>printer.printFile(tree)).join('\n');
  return {
    delegates:!!imported&&body('product','saveCategory').includes("returnnewSupplierProductCategoryService(this.container).save(supplierId,categoryId,input,actor)"),
    createsImmediateParent:product.includes('tx.insert(storeProductRelation).values(categories.map((category)=>({')
      &&product.includes('relationId:category.id,relationPid:category.pid'),
    repairsMovedSubtree:moved.includes('if(current&&(current.pid!==pid||current.path!==path))')
      &&moved.includes('for(constcategoryof[{id,pid},...affected])awaitdb.update(storeProductRelation).set({relationPid:category.pid})')
      &&moved.includes('eq(storeProductRelation.type,1),eq(storeProductRelation.relationId,category.id)'),
    tenantScoped:moved.includes('inArray(storeProductRelation.productId,db.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.type,2),eq(storeProduct.relationId,supplierId))))'),
    transactional:!!importsWithTx&&returnedCategoryWrite&&returnsAwaitedWithTx,
    noSupersededWrites:!(/\bstoreProductCategoryBrand\b|\bstoreProductCate\b|\bstoreProductLabelAuxiliary\b/).test(all),
  };
}

describe("superseded product auxiliary migration", () => {
  it("preserves all three source-shaped tables and stable migration keys", () => {
    expect(getTableName(storeProductCategoryBrand)).toBe("store_product_category_brand");
    expect(getTableName(storeProductCate)).toBe("store_product_cate");
    expect(getTableName(storeProductLabelAuxiliary)).toBe("store_product_label_auxiliary");
    expect(Object.keys(getTableColumns(storeProductCategoryBrand))).toEqual([
      "id", "productId", "cateId", "brandId", "brandName", "status", "addTime",
    ]);
    expect(Object.keys(getTableColumns(storeProductCate))).toEqual([
      "id", "productId", "cateId", "addTime", "catePid", "status",
    ]);
    expect(Object.keys(getTableColumns(storeProductLabelAuxiliary))).toEqual([
      "id", "labelId", "productId",
    ]);
    for (const table of [
      "store_product_category_brand",
      "store_product_cate",
      "store_product_label_auxiliary",
    ]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external and embedded 0068 SQL equivalent without inventing constraints", () => {
    const migration = readFileSync("migrations/0068_superseded_product_relations.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(/private migration_0075\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]?.trim();
    expect(embedded?.replace(/\r\n/g, '\n')).toBe(migration.replace(/\r\n/g, '\n'));
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"|CREATE UNIQUE INDEX/i);
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    expect(migration).toContain('("label_id", "product_id")');
  });

  it("keeps store_product_relation authoritative and writes the PHP immediate-parent semantics", () => {
    expect(relationContract(categorySources())).toEqual({delegates:true,createsImmediateParent:true,
      repairsMovedSubtree:true,tenantScoped:true,transactional:true,noSupersededWrites:true});
  });

  it.each([
    ['product','return new SupplierProductCategoryService(this.container).save','return new FakeCategoryService(this.container).save','delegates'],
    ['product','relationPid: category.pid','relationPid: Number(category.path.split(",")[0])','createsImmediateParent'],
    ['category','[{ id, pid }, ...affected]','[{ id, pid }]','repairsMovedSubtree'],
    ['category','.set({ relationPid: category.pid })','.set({ relationPid: 0 })','repairsMovedSubtree'],
    ['category','eq(storeProduct.relationId, supplierId)','sql`TRUE`','tenantScoped'],
    ['category','await withTx(container, work)','await work(container.db)','transactional'],
    ['category','return categoryWrite(this.container, async db =>','return fakeCategoryWrite(this.container, async db =>','transactional'],
    ['category','from "@/lib/di"','from "@/lib/fake-di"','transactional'],
    ['category','return await withTx(container, work)','return withTx(container, work)','transactional'],
  ] as const)('refuses lost relation authority: %s %s', (role,before,after,gate) => {
    const source=categorySources();expect(source[role]).toContain(before);expect(relationContract(source)[gate]).toBe(true);
    expect(relationContract({...source,[role]:source[role].split(before).join(after)})[gate]).toBe(false);
  });

  it('does not accept a nested unrelated transaction call after the actual wrapper is bypassed', () => {
    const source=categorySources(),before='try { return await withTx(container, work); }';
    expect(source.category).toContain(before);
    source.category=source.category.replace(before,'function unrelated(){return withTx(container,work); } try { return await work(container.db); }');
    expect(relationContract(source).transactional).toBe(false);
  });
});
