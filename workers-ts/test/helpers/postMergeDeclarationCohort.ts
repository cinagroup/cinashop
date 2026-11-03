import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import ts from 'typescript';
import { parseCreateTables, type ParsedColumn } from '../../scripts/data-migration/schema-audit';

interface Position { start: number; end: number; line: number; column: number }
interface SourceImage { file: string; sha256: string; bytes: number; rawUtf8: string }
interface StaticSegment extends Position { index: number; sha256: string; bytes: number }
interface Interpolation extends Position { text: string; syntaxKind: string }
interface DeclarationTable {
  name: string;
  columns: ParsedColumn[];
  primaryKey: string[];
  staticSegment: number;
}
interface DeclarationModule {
  file: string;
  sqlSymbol: string;
  representation: 'string-literal' | 'no-substitution-template' | 'interpolated-template';
  sqlRange: Position;
  staticSegments: StaticSegment[];
  interpolations: Interpolation[];
  ownerFiles: string[];
  tables: DeclarationTable[];
}
interface OwnerInstallation {
  file: string;
  entryPoints: Array<Position & { name: string }>;
  executions: Array<Position & { text: string }>;
}
export interface PostMergeDeclarationProof {
  formatVersion: number;
  basisCommit: string;
  meaning: string;
  installationEquivalenceProven: false;
  runAllRegistrationProven: false;
  completeSqlEvaluation: false;
  unresolvedListExhaustive: false;
  sourceImages: SourceImage[];
  modules: DeclarationModule[];
  owners: OwnerInstallation[];
  atomicOwnerBundles: Array<{ ownerFile: string; moduleFiles: string[]; tableNames: string[] }>;
  declarationTableNames: string[];
  declarationSourceNames: string[];
}

export const POST_MERGE_DECLARATION_PROOF_FILE = 'test/fixtures/post-merge-declaration-cohort-20261103.json';
export const POST_MERGE_DECLARATION_PROOF_SHA256 = 'ae97e9e557a7bb669ea618e9b267fb4c001aba3cda1d051e3c7a1e41ffde5dae';
const canonicalProofSha256 = 'c1a897f95876877c2726d2cba0b22d3074378a1f92c68411f7d026e0975eed5d';
const workerRoot = resolve(import.meta.dirname, '../..');
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const proofBytes = readFileSync(resolve(workerRoot, POST_MERGE_DECLARATION_PROOF_FILE));
assert.equal(digest(proofBytes), POST_MERGE_DECLARATION_PROOF_SHA256, 'Complete post-merge declaration fixture differs');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
// Read as data, rather than importing a large JSON type or executing migrations.
export const postMergeDeclarationProof = freeze(JSON.parse(
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(proofBytes),
) as PostMergeDeclarationProof);

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function position(file: ts.SourceFile, node: ts.Node): Position {
  const start = node.getStart(file), location = file.getLineAndCharacterOfPosition(start);
  return { start, end: node.end, line: location.line + 1, column: location.character + 1 };
}

function parseSource(source: string, name: string): ts.SourceFile {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  assert.equal(diagnostics.length, 0, `Invalid declaration TypeScript: ${name}`);
  return file;
}

/** Inspect only complete CREATE TABLE declarations within one literal segment.
 * Interpolations remain separate, unexecuted source expressions. Concatenating
 * segments, replacing expressions with blanks, or claiming full SQL would erase
 * the installation boundary this fixture is intended to preserve. */
function inspectModule(file: ts.SourceFile, expected: DeclarationModule) {
  const statements = file.statements.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node) && exported(node));
  const declarations = statements.flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === expected.sqlSymbol);
  assert.equal(declarations.length, 1, `Expected one exported SQL declaration: ${expected.file}`);
  const declaration = declarations[0]!, initializer = declaration.initializer;
  const statement = declaration.parent;
  assert.ok(ts.isVariableDeclarationList(statement) && (statement.flags & ts.NodeFlags.Const) !== 0, 'SQL declaration must remain const');
  assert.ok(initializer, 'SQL declaration requires an initializer');
  let literals: Array<ts.TemplateLiteralLikeNode | ts.StringLiteral>, interpolations: Interpolation[];
  let representation: DeclarationModule['representation'];
  if (ts.isTemplateExpression(initializer)) {
    representation = 'interpolated-template';
    literals = [initializer.head, ...initializer.templateSpans.map(span => span.literal)];
    interpolations = initializer.templateSpans.map(span => ({ text: span.expression.getText(file),
      syntaxKind: ts.SyntaxKind[span.expression.kind], ...position(file, span.expression) }));
  } else {
    assert.ok(ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer), 'SQL declaration must retain reviewed literal segments');
    representation = ts.isStringLiteral(initializer) ? 'string-literal' : 'no-substitution-template';
    literals = [initializer]; interpolations = [];
  }
  const staticSegments = literals.map((literal, index) => ({ index, sha256: digest(literal.text),
    bytes: Buffer.byteLength(literal.text), ...position(file, literal) }));
  const tables = literals.flatMap((literal, staticSegment) => {
    const parsed = parseCreateTables(literal.text, 'postgres');
    // The reviewed cohort uses explicit public-qualified, static identifiers.
    // Reject duplicate declarations instead of accepting the parser's first-definition behavior.
    const creates = [...literal.text.matchAll(/\bCREATE\s+TABLE\s+public\.(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*\(/gi)];
    assert.equal(creates.length, parsed.size, `Duplicate or unreviewed CREATE shape: ${expected.file}`);
    return [...parsed.values()].map(table => ({ name: table.name,
      columns: [...table.columns.values()].map(column => ({ ...column, primaryKey: table.primaryKey.includes(column.name) })),
      primaryKey: table.primaryKey, staticSegment }));
  });
  assert.deepEqual({ representation, sqlRange: position(file, initializer), staticSegments, interpolations, tables },
    { representation: expected.representation, sqlRange: expected.sqlRange, staticSegments: expected.staticSegments,
      interpolations: expected.interpolations, tables: expected.tables }, `Reviewed declaration structure differs: ${expected.file}`);
}

function inspectOwner(file: ts.SourceFile, expected: OwnerInstallation) {
  for (const entry of expected.entryPoints) {
    const declarations = file.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && exported(node) && node.name?.text === entry.name);
    assert.equal(declarations.length, 1, `Missing explicit owner entry: ${expected.file}:${entry.name}`);
    assert.deepEqual(position(file, declarations[0]!), { start: entry.start, end: entry.end, line: entry.line, column: entry.column });
  }
  for (const execution of expected.executions) {
    assert.ok(expected.entryPoints.some(entry => entry.start <= execution.start && execution.end <= entry.end),
      `SQL execution must belong to a named owner entry: ${expected.file}`);
    let matched = false;
    const visit = (node: ts.Node) => {
      if (ts.isExpressionStatement(node) && node.getStart(file) === execution.start) {
        assert.equal(node.getText(file), execution.text, `Owner SQL execution differs: ${expected.file}`);
        assert.deepEqual(position(file, node), { start: execution.start, end: execution.end, line: execution.line, column: execution.column });
        matched = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(matched, `Missing actual owner SQL execution: ${expected.file}`);
  }
}

/** Pure read port used by the real-filesystem wrapper and controlled negative
 * tests. A replacement manifest cannot redefine the expected current sources. */
export function verifyPostMergeDeclarationCohort(
  readSource: (file: string) => string,
  proof: PostMergeDeclarationProof = postMergeDeclarationProof,
) {
  assert.equal(digest(JSON.stringify(proof)), canonicalProofSha256, 'Complete post-merge declaration proof differs');
  const files = new Set(proof.sourceImages.map(image => image.file));
  assert.equal(proof.sourceImages.length, 63); assert.equal(files.size, 63);
  assert.equal(proof.modules.length, 33); assert.equal(proof.owners.length, 31);
  const wanted = [...new Set([...proof.modules.map(module => module.file), ...proof.owners.map(owner => owner.file)])].sort();
  assert.deepEqual([...files].sort(), wanted, 'Source image inventory must cover exactly every module and owner');
  const asts = new Map<string, ts.SourceFile>();
  for (const image of proof.sourceImages) {
    assert.match(image.file, /^src\/migrations\/[A-Za-z][A-Za-z0-9]*\.ts$/);
    assert.equal(digest(image.rawUtf8), image.sha256, `Invalid frozen source digest: ${image.file}`);
    assert.equal(Buffer.byteLength(image.rawUtf8), image.bytes, `Invalid frozen source length: ${image.file}`);
    const source = readSource(image.file);
    assert.equal(digest(source), image.sha256, `Post-merge declaration source differs: ${image.file}`);
    // Hash plus full comparison binds every byte, including comments and owner
    // guards outside the bounded table/entry inspection below.
    assert.ok(source === image.rawUtf8, `Post-merge declaration bytes differ: ${image.file}`);
    asts.set(image.file, parseSource(source, image.file));
  }
  for (const module of proof.modules) {
    inspectModule(asts.get(module.file)!, module);
    for (const ownerFile of module.ownerFiles) {
      const owner = proof.owners.find(row => row.file === ownerFile);
      assert.ok(owner, `Missing owner mapping: ${module.file}`);
      assert.ok(owner.executions.some(execution => new RegExp(`\\b${module.sqlSymbol}\\b`).test(execution.text)),
        `Owner must execute the declared SQL symbol: ${module.file}`);
      if (ownerFile !== module.file) {
        const importsSql = asts.get(ownerFile)!.statements.some(node => ts.isImportDeclaration(node)
          && ts.isStringLiteral(node.moduleSpecifier)
          && resolve(workerRoot, dirname(ownerFile), node.moduleSpecifier.text + '.ts') === resolve(workerRoot, module.file)
          && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          && node.importClause.namedBindings.elements.some(element => element.name.text === module.sqlSymbol
            && (element.propertyName?.text ?? element.name.text) === module.sqlSymbol));
        assert.ok(importsSql, `Owner must import the named declaration from its actual module: ${module.file}`);
      }
    }
  }
  for (const owner of proof.owners) inspectOwner(asts.get(owner.file)!, owner);
  const tableNames = proof.modules.flatMap(module => module.tables.map(table => table.name)).sort();
  const sourceNames = proof.modules.map(module => basename(module.file)).sort();
  assert.equal(tableNames.length, 41); assert.equal(new Set(tableNames).size, 41);
  assert.deepEqual(tableNames, proof.declarationTableNames);
  assert.deepEqual(sourceNames, proof.declarationSourceNames);
  for (const bundle of proof.atomicOwnerBundles) {
    const modules = proof.modules.filter(module => bundle.moduleFiles.includes(module.file));
    assert.equal(modules.length, bundle.moduleFiles.length);
    assert.ok(modules.every(module => module.ownerFiles.includes(bundle.ownerFile)));
    assert.deepEqual(modules.flatMap(module => module.tables.map(table => table.name)).sort(), [...bundle.tableNames].sort());
  }
  return { sourceNames, tableNames, modules: proof.modules, owners: proof.owners,
    atomicOwnerBundles: proof.atomicOwnerBundles, installationEquivalenceProven: false as const,
    runAllRegistrationProven: false as const, completeSqlEvaluation: false as const, unresolvedListExhaustive: false as const };
}

export function assertPostMergeDeclarationCohort(root: string = workerRoot) {
  return verifyPostMergeDeclarationCohort(file => readFileSync(resolve(root, file), 'utf8'));
}

// Only these exact, verified basenames may leave a historical declaration view.
// New/unrecognized directory entries are never silently classified or filtered.
export function reviewedPostMergeDeclarationSources(root: string = workerRoot): string[] {
  return assertPostMergeDeclarationCohort(root).sourceNames;
}

export function reviewedPostMergeDeclarationTableNames(root: string = workerRoot): string[] {
  return assertPostMergeDeclarationCohort(root).tableNames;
}
