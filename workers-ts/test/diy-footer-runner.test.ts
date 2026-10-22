import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..'), script = resolve(root, 'scripts/run-local-finance-postgres.mjs');
function admission(file: string) {
  const r = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', file], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(r.error).toBeUndefined(); expect(r.status).not.toBe(0); expect(r.stdout).toBe(''); return r.stderr;
}
function literal(text: string) {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); let admitted = false;
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Set'
      && node.arguments?.some(x => ts.isArrayLiteralExpression(x) && x.elements.some(y => ts.isStringLiteral(y) && y.text === 'test/diy-footer-postgres.test.ts'))) admitted = true;
    ts.forEachChild(node, visit);
  }
  visit(file); return admitted;
}
describe('owned footer native runner exact admission', () => {
  it('admits its exact native file up to trusted-bin lookup', () => { expect(admission('test/diy-footer-postgres.test.ts')).toContain('ENOENT'); });
  it.each(['test/diy-footer-postgres.test.ts.extra', 'test/diy-footer-extra-postgres.test.ts', 'test/../test/diy-footer-postgres.test.ts'])('rejects nonliteral file %s before native command work', file => { expect(admission(file)).not.toContain('ENOENT'); });
  it('requires executable Set membership, not a commented name', () => {
    const source = readFileSync(script, 'utf8'); expect(literal(source)).toBe(true);
    expect(literal(source.replace("    'test/diy-footer-postgres.test.ts',", "    // 'test/diy-footer-postgres.test.ts',"))).toBe(false);
  });
});

// Follow executable nodes from the admitted literal to the child process.
// A detached string/import/comment never satisfies this Browser contract.
function footerBrowserWiring(text: string): boolean {
  const file = ts.createSourceFile(script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string, ts.VariableDeclaration[]>();
  function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const values = declarations.get(node.name.text) ?? []; values.push(node); declarations.set(node.name.text, values);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  const variable = (name: string) => { const values = declarations.get(name); return values?.length === 1 ? values[0].initializer : undefined; };
  const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const identifier = (node: ts.Expression, name: string) => ts.isIdentifier(unwrap(node)) && (unwrap(node) as ts.Identifier).text === name;
  const string = (node: ts.Expression, value: string) => ts.isStringLiteral(unwrap(node)) && (unwrap(node) as ts.StringLiteral).text === value;
  const number = (node: ts.Expression, value: number) => ts.isNumericLiteral(unwrap(node)) && Number((unwrap(node) as ts.NumericLiteral).text) === value;
  const terms = (input: ts.Expression, operator: ts.BinaryOperator): ts.Expression[] => {
    const node = unwrap(input); return ts.isBinaryExpression(node) && node.operatorToken.kind === operator ? [...terms(node.left, operator), ...terms(node.right, operator)] : [node];
  };
  const equal = (input: ts.Expression, left: (node: ts.Expression) => boolean, right: (node: ts.Expression) => boolean) => {
    const node = unwrap(input); return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && left(node.left) && right(node.right);
  };
  const mode = variable('diyFooterBrowser'), allow = variable('allowed'), umbrella = variable('productPurchaseAdmissionBrowser'), command = variable('commandArgs'), child = variable('testRun');
  if (!mode || !allow || !umbrella || !command || !child) return false;
  const guards = terms(mode, ts.SyntaxKind.AmpersandAmpersandToken);
  if (guards.length !== 3 || !identifier(guards[0], 'schemaMaintenance') || !equal(guards[1], node => {
    node = unwrap(node); return ts.isPropertyAccessExpression(node) && identifier(node.expression, 'tests') && node.name.text === 'length';
  }, node => number(node, 1)) || !equal(guards[2], node => {
    node = unwrap(node); return ts.isElementAccessExpression(node) && identifier(node.expression, 'tests') && !!node.argumentExpression && number(node.argumentExpression, 0);
  }, node => string(node, 'audit:diy-footer-browser'))) return false;
  const allowed = unwrap(allow);
  if (!ts.isNewExpression(allowed) || !identifier(allowed.expression, 'Set') || allowed.arguments?.length !== 1
    || !ts.isArrayLiteralExpression(allowed.arguments[0]) || !allowed.arguments[0].elements.some(node => ts.isStringLiteral(node) && node.text === 'audit:diy-footer-browser')) return false;
  let checkedMembership = false;
  function membership(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && identifier(node.expression.expression, 'assert') && node.expression.name.text === 'ok') {
      const every = node.arguments[0];
      if (every && ts.isCallExpression(every) && ts.isPropertyAccessExpression(every.expression) && identifier(every.expression.expression, 'tests') && every.expression.name.text === 'every') {
        const callback = every.arguments[0];
        if (callback && ts.isArrowFunction(callback) && callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name) && !ts.isBlock(callback.body)) {
          const check = unwrap(callback.body);
          if (ts.isCallExpression(check) && ts.isPropertyAccessExpression(check.expression) && identifier(check.expression.expression, 'allowed') && check.expression.name.text === 'has'
            && check.arguments.length === 1 && identifier(check.arguments[0], callback.parameters[0].name.text)) checkedMembership = true;
        }
      }
    }
    ts.forEachChild(node, membership);
  }
  membership(file); if (!checkedMembership) return false;
  if (!terms(umbrella, ts.SyntaxKind.BarBarToken).some(node => identifier(node, 'diyFooterBrowser'))) return false;
  const branch = (input: ts.Expression): ts.Expression | undefined => {
    const node = unwrap(input); if (!ts.isConditionalExpression(node)) return undefined;
    return identifier(node.condition, 'diyFooterBrowser') ? node.whenTrue : branch(node.whenFalse);
  };
  const dispatched = branch(command), wanted = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.diy-footer-browser.config.ts', '--maxWorkers=1'];
  if (!dispatched || !ts.isArrayLiteralExpression(dispatched) || dispatched.elements.length !== wanted.length
    || dispatched.elements.some((node, index) => !ts.isStringLiteral(node) || node.text !== wanted[index])) return false;
  const spawned = unwrap(child);
  if (!ts.isCallExpression(spawned) || !identifier(spawned.expression, 'spawnSync') || spawned.arguments.length !== 3
    || !ts.isPropertyAccessExpression(spawned.arguments[0]) || !identifier(spawned.arguments[0].expression, 'process') || spawned.arguments[0].name.text !== 'execPath'
    || !identifier(spawned.arguments[1], 'commandArgs') || !ts.isObjectLiteralExpression(spawned.arguments[2])) return false;
  const options = spawned.arguments[2], property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name)?.initializer;
  const timeout = property(options, 'timeout'), env = property(options, 'env');
  if (!timeout || !env) return false;
  const multiplied = unwrap(timeout);
  if (!ts.isBinaryExpression(multiplied) || multiplied.operatorToken.kind !== ts.SyntaxKind.AsteriskToken || !number(multiplied.right, 60_000)) return false;
  const duration = branch(multiplied.left); if (!duration || !number(duration, 40)) return false;
  const environment = unwrap(env);
  if (!ts.isConditionalExpression(environment) || !identifier(environment.condition, 'unitGate') || !ts.isObjectLiteralExpression(environment.whenFalse)) return false;
  return environment.whenFalse.properties.some(node => {
    if (!ts.isSpreadAssignment(node)) return false; const value = unwrap(node.expression);
    return ts.isConditionalExpression(value) && identifier(value.condition, 'diyFooterBrowser') && ts.isObjectLiteralExpression(value.whenTrue)
      && !!property(value.whenTrue, 'TEST_DIY_FOOTER_BROWSER') && string(property(value.whenTrue, 'TEST_DIY_FOOTER_BROWSER')!, '1')
      && ts.isObjectLiteralExpression(value.whenFalse) && value.whenFalse.properties.length === 0;
  });
}

describe('owned footer Browser runner executable AST contract', () => {
  const source = readFileSync(script, 'utf8');
  it('connects its exact literal, bounded mode, umbrella, dedicated config, live environment and outer40min spawn', () => { expect(footerBrowserWiring(source)).toBe(true); });
  it.each([
    ['commented admission', "    'audit:diy-footer-browser',", "    // 'audit:diy-footer-browser',"],
    ['detached boolean', "const diyFooterBrowser = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:diy-footer-browser';", 'const diyFooterBrowser = false;'],
    ['detached umbrella', 'const productPurchaseAdmissionBrowser = diyFooterBrowser ||', 'const productPurchaseAdmissionBrowser ='],
    ['wrong dispatch config', "vitest.diy-footer-browser.config.ts", 'vitest.diy-navigation-browser.config.ts'],
    ['wrong environment', "TEST_DIY_FOOTER_BROWSER: '1'", "TEST_DIY_FOOTER_BROWSER_WRONG: '1'"],
    ['removed outer timeout', 'diyFooterBrowser ? 40 :', ''],
  ])('rejects %s even when the original bytes remain in a comment', (_name, before, after) => {
    expect(source).toContain(before); expect(footerBrowserWiring(source.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});

/** Parse the actual emitted shell, not comments or a detached fixture copy. */
function footerShellReadiness(text: string): boolean {
  try {
    const acceptance = ts.createSourceFile('diy-footer.acceptance.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const nodes = (root: ts.Node): ts.Node[] => { const out: ts.Node[] = []; function visit(node: ts.Node) { out.push(node); ts.forEachChild(node, visit); } visit(root); return out; };
    const declarations = nodes(acceptance).filter(ts.isVariableDeclaration).filter(node => ts.isIdentifier(node.name) && node.name.text === 'shell');
    if (declarations.length !== 1 || !declarations[0].initializer || !ts.isArrowFunction(declarations[0].initializer)) return false;
    const html = new Script('(' + declarations[0].initializer.getText(acceptance) + ')()').runInNewContext({ f: { token:'owned11', otherToken:'owned22', adminToken:'ownedAdmin', adminSession:{} }, control:'/owned-footer', plans:[], instructions:{} }) as string;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; if (scripts.length !== 1) return false;
    new Script(scripts[0][1]);
    const file = ts.createSourceFile('actual-footer-shell.js', scripts[0][1], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const printer = ts.createPrinter({ removeComments: true }), compact = (node: ts.Node | undefined) => node ? printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, '') : '';
    const variable = (scope: ts.Node, name: string) => { const rows = nodes(scope).filter(ts.isVariableDeclaration).filter(node => ts.isIdentifier(node.name) && node.name.text === name); return rows.length === 1 ? rows[0].initializer : undefined; };
    const functions = file.statements.filter(ts.isFunctionDeclaration), readiness = functions.find(node => node.name?.text === 'frameReady'), observe = functions.find(node => node.name?.text === 'observe'), navigate = functions.find(node => node.name?.text === 'navigateFrame');
    if (!readiness?.body || !observe?.body || compact(variable(file, 'frame')) !== "document.querySelector('iframe')") return false;
    if (readiness.parameters.map(node => compact(node.name)).join(',') !== 'w,d') return false;
    if (compact(readiness.body.statements[0]) !== "if(w!==frame.contentWindow||d!==frame.contentDocument||!d||d.readyState!=='complete')returnfalse;") return false;
    if (compact(variable(readiness.body, 'location')) !== 'w.location') return false;
    const admitted = readiness.body.statements.filter(ts.isReturnStatement);
    if (admitted.length !== 1 || compact(admitted[0].expression) !== "location.origin===window.location.origin&&((location.pathname==='/__h5'&&(location.hash==='#/'||location.hash.startsWith('#/pages/')))||location.pathname==='/content/dise')") return false;
    const loads = file.statements.filter(ts.isExpressionStatement).map(node => node.expression).filter(ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken && compact(node.left) === 'frame.onload');
    if (loads.length !== 1 || !ts.isArrowFunction(loads[0].right) || !ts.isBlock(loads[0].right.body)) return false;
    const body = loads[0].right.body;
    if (compact(body.statements[0]) !== 'removeFrameListeners();' || compact(variable(body, 'w')) !== 'frame.contentWindow' || compact(variable(body, 'd')) !== 'frame.contentDocument') return false;
    const ready = variable(body, 'ready'); if (!ready || !ts.isArrowFunction(ready) || compact(ready.body) !== '{loaded=frameReady(w,d);}') return false;
    const expressions = body.statements.filter(ts.isExpressionStatement).map(node => node.expression);
    for (const [event, callback] of [['hashchange','ready'],['error','error'],['unhandledrejection','rejection']]) {
      if (!expressions.some(node => compact(node) === `w.addEventListener('${event}',${callback})`)) return false;
    }
    const removals = expressions.filter(ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken && compact(node.left) === 'removeFrameListeners');
    if (removals.length !== 1 || !ts.isArrowFunction(removals[0].right) || !ts.isBlock(removals[0].right.body)) return false;
    const cleanup = removals[0].right.body.statements.filter(ts.isExpressionStatement).map(node => compact(node.expression));
    if (!['hashchange,ready','error,error','unhandledrejection,rejection'].every(pair => { const [event, callback] = pair.split(','); return cleanup.includes(`w.removeEventListener('${event}',${callback})`); })) return false;
    if (compact(body.statements.at(-1)) !== 'ready();') return false;
    const observed = observe.body.statements.filter(ts.isReturnStatement); if (observed.length !== 1 || !observed[0].expression || !ts.isObjectLiteralExpression(observed[0].expression)) return false;
    const loaded = observed[0].expression.properties.find((node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node) && compact(node.name) === 'loaded');
    if (!loaded || compact(loaded.initializer) !== 'loaded&&frameReady(w,d)') return false;
    if (!navigate?.body || navigate.parameters.length !== 1 || compact(navigate.parameters[0].name) !== 'target'
      || compact(variable(navigate.body, 'destination')) !== 'newURL(target,window.location.href).href') return false;
    if (compact(variable(navigate.body, 'current')) !== 'frame.contentWindow.location'
      || compact(variable(navigate.body, 'rootAlias')) !== "current.origin===window.location.origin&&current.pathname==='/__h5'&&current.search===''&&current.hash==='#/'&&destination===newURL('/__h5#/pages/index/index',window.location.href).href") return false;
    const same = navigate.body.statements.filter(ts.isIfStatement);
    if (same.length !== 1 || compact(same[0].expression) !== 'frame.contentWindow.location.href===destination||rootAlias'
      || compact(same[0].thenStatement) !== 'frame.contentWindow.location.reload();' || compact(same[0].elseStatement) !== 'frame.src=destination;') return false;
    const routes = file.statements.filter(ts.isForOfStatement).filter(node => compact(node.expression) === "document.querySelectorAll('[data-route]')");
    if (routes.length !== 1) return false;
    const clicked = nodes(routes[0]).filter(ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken && compact(node.left) === 'button.onclick');
    if (clicked.length !== 1 || !ts.isArrowFunction(clicked[0].right) || !ts.isBlock(clicked[0].right.body)) return false;
    const routeBody = clicked[0].right.body, routeCalls = nodes(routeBody).filter(ts.isCallExpression);
    if (compact(routeBody.statements[0]) !== 'loaded=false;' || !routeCalls.some(node => compact(node) === "navigateFrame('/content/dise')")
      || compact(routeBody.statements.at(-1)) !== "navigateFrame('/__h5#/pages/'+(kind==='micro'?'diy/detail?id=2':'index/index'));") return false;
    if (!['uni_token','uni_uid'].every(key => routeCalls.some(node => compact(node).startsWith(`localStorage.setItem('${key}',`)) && routeCalls.some(node => compact(node) === `localStorage.removeItem('${key}')`))) return false;
    const cacheEviction = "for(constkeyofObject.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);";
    if (!routeBody.statements.some(node => ts.isForOfStatement(node) && compact(node) === cacheEviction)) return false;
    const reloads = file.statements.filter(ts.isExpressionStatement).map(node => node.expression).filter(ts.isBinaryExpression).filter(node => node.operatorToken.kind === ts.SyntaxKind.EqualsToken && compact(node.left) === "document.getElementById('reload').onclick");
    if (reloads.length !== 1 || !ts.isArrowFunction(reloads[0].right) || !ts.isBlock(reloads[0].right.body)) return false;
    const reloadBody = reloads[0].right.body;
    if (compact(reloadBody.statements[0]) !== 'loaded=false;' || compact(reloadBody.statements[2]) !== cacheEviction || compact(reloadBody.statements.at(-1)) !== 'frame.contentWindow.location.reload();') return false;
    const checkpoint = nodes(acceptance).filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'checkpoint');
    const footer = nodes(acceptance).filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'assertFooter');
    const serverCompact = (node: ts.Node | undefined) => node ? printer.printNode(ts.EmitHint.Unspecified, node, acceptance).replace(/\s+/g, '') : '';
    if (!footer?.body || !checkpoint?.body || serverCompact(variable(footer.body, 'pagePath')) !== 'canonicalPagePath(data.href)'
      || serverCompact(variable(footer.body, 'selected')) !== "pagePath?.split('?')[0]===expectedPath" || serverCompact(variable(checkpoint.body, 'pagePath')) !== 'canonicalPagePath(data.href)') return false;
    const calls = nodes(checkpoint.body).filter(ts.isCallExpression).map(node => serverCompact(node));
    return calls.includes('expect(data.loaded).toBe(true)') && calls.includes("expect(pagePath).toBe(name==='nativeCategory'?'/pages/goods/cate':'/pages/index/index')")
      && calls.includes("expect(pagePath).toBe('/pages/index/index')") && calls.some(call => call.startsWith('evidence.push({stage:name,...data,canonical_page_path:pagePath,'));
  } catch { return false; }
}

describe('actual footer shell document and hash-route readiness', () => {
  const source = readFileSync(resolve(root, 'test/browser/diy-footer.acceptance.ts'), 'utf8');
  it('binds live document/hash readiness and reloads an identical actual frame URL after real session bootstrap', () => { expect(footerShellReadiness(source)).toBe(true); });
  it.each([
    ['missing live hash listener', "w.addEventListener('hashchange',ready);", "/* w.addEventListener('hashchange',ready); */"],
    ['unconditional readiness', 'loaded=frameReady(w,d);', 'loaded=true;'],
    ['missing complete document gate', "d.readyState!=='complete'", 'false'],
    ['missing route gate', "location.hash.startsWith('#/pages/')", 'true'],
    ['missing current document identity', 'd!==frame.contentDocument', 'false'],
    ['old listeners not retired before load', 'frame.onload=()=>{removeFrameListeners();', 'frame.onload=()=>{'],
    ['hash listener not removed', "w.removeEventListener('hashchange',ready);", ''],
    ['observation bypasses live readiness', 'loaded:loaded&&frameReady(w,d)', 'loaded:loaded'],
    ['server loaded assertion bypassed', 'expect(data.loaded).toBe(true);', 'expect(true).toBe(true);'],
    ['same URL comparison reversed', 'frame.contentWindow.location.href===destination', 'frame.contentWindow.location.href!==destination'],
    ['same URL compares attribute instead of actual location', 'frame.contentWindow.location.href===destination', 'frame.src===destination'],
    ['same URL fake reload', 'if(frame.contentWindow.location.href===destination||rootAlias)frame.contentWindow.location.reload();', 'if(frame.contentWindow.location.href===destination||rootAlias)loaded=true;'],
    ['normal navigation bypasses absolute destination', 'else frame.src=destination;', 'else frame.src=target;'],
    ['H5 route bypasses reload helper', "navigateFrame('/__h5#/pages/'+(kind==='micro'?'diy/detail?id=2':'index/index'));", "frame.src='/__h5#/pages/'+(kind==='micro'?'diy/detail?id=2':'index/index');"],
    ['session route no longer invalidates loaded', "button.onclick=()=>{loaded=false;errors=[];const kind=button.dataset.route;", "button.onclick=()=>{errors=[];const kind=button.dataset.route;"],
    ['reload omits explicit DIY cache eviction', "document.getElementById('reload').onclick=()=>{loaded=false;errors=[];for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);", "document.getElementById('reload').onclick=()=>{loaded=false;errors=[];"],
    ['reload broadens the evicted cache domain', "document.getElementById('reload').onclick=()=>{loaded=false;errors=[];for(const key of Object.keys(localStorage))if(key.startsWith('cinashop_diy_page_v1_'))localStorage.removeItem(key);", "document.getElementById('reload').onclick=()=>{loaded=false;errors=[];for(const key of Object.keys(localStorage))if(key.startsWith('uni_'))localStorage.removeItem(key);"],
    ['root alias readiness detached', "location.hash==='#/'||", ''],
    ['root alias reload broadens to non-root', "current.hash==='#/'", "current.hash.startsWith('#/')"],
    ['footer selection bypasses canonical path', "const selected = pagePath?.split('?')[0] === expectedPath;", 'const selected = data.href.includes(expectedPath);'],
    ['native route bypasses canonical path', "expect(pagePath).toBe(name === 'nativeCategory' ? '/pages/goods/cate' : '/pages/index/index');", "expect(data.href).toContain(name === 'nativeCategory' ? '/pages/goods/cate' : '/pages/index/index');"],
  ])('rejects %s even with original code left in a comment', (_name, before, after) => {
    expect(source).toContain(before); expect(footerShellReadiness(source.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});

function actualCanonicalPagePath() {
  const source = readFileSync(resolve(root, 'test/browser/diy-footer.acceptance.ts'), 'utf8'), file = ts.createSourceFile('diy-footer.acceptance.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = file.statements.filter(ts.isFunctionDeclaration).find(item => item.name?.text === 'canonicalPagePath');
  if (!node) throw Error('Missing actual owned H5 canonicalPagePath');
  const code = ts.transpileModule(node.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Script(code + ';canonicalPagePath').runInNewContext({ URL }) as (value: string) => string | null;
}
describe('actual owned H5 root alias projection', () => {
  it('maps exact root alias only and preserves ordinary routes and query text', () => {
    const path = actualCanonicalPagePath();
    expect(path('http://127.0.0.1:40779/__h5#/')).toBe('/pages/index/index');
    expect(path('http://127.0.0.1:40779/__h5#/pages/index/index')).toBe('/pages/index/index');
    expect(path('http://127.0.0.1:40779/__h5#/pages/diy/detail?id=2')).toBe('/pages/diy/detail?id=2');
    expect(path('http://127.0.0.1:40779/__h5#/pages/user/index')).toBe('/pages/user/index');
  });
  it('rejects foreign, credentialed, unrelated and non-exact root lookalikes', () => {
    const path = actualCanonicalPagePath();
    for (const value of ['https://foreign.invalid/__h5#/', 'http://127.0.0.1:40780/__h5#/', 'http://user@127.0.0.1:40779/__h5#/', 'http://127.0.0.1:40779/other#/', 'http://127.0.0.1:40779/__h5?other=1#/', 'http://127.0.0.1:40779/__h5#/?other=1', 'http://127.0.0.1:40779/__h5#/other', 'http://127.0.0.1:40779/__h5#%2F', '/__h5#/']) expect(path(value)).toBeNull();
  });
});
