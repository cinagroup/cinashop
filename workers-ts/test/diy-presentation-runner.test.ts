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
      && node.arguments?.some(x => ts.isArrayLiteralExpression(x) && x.elements.some(y => ts.isStringLiteral(y) && y.text === 'test/diy-presentation-postgres.test.ts'))) admitted = true;
    ts.forEachChild(node, visit);
  }
  visit(file); return admitted;
}
describe('owned presentation native runner exact admission', () => {
  it('admits its exact native file up to trusted-bin lookup', () => { expect(admission('test/diy-presentation-postgres.test.ts')).toContain('ENOENT'); });
  it.each(['test/diy-presentation-postgres.test.ts.extra', 'test/diy-presentation-extra-postgres.test.ts', 'test/../test/diy-presentation-postgres.test.ts'])('rejects nonliteral file %s before native command work', file => { expect(admission(file)).not.toContain('ENOENT'); });
  it('requires executable Set membership, not a commented name', () => {
    const source = readFileSync(script, 'utf8'); expect(literal(source)).toBe(true);
    expect(literal(source.replace("    'test/diy-presentation-postgres.test.ts',", "    // 'test/diy-presentation-postgres.test.ts',"))).toBe(false);
  });
});

// Follow executable nodes from the admitted literal to the child process.
// A detached string/import/comment never satisfies this Browser contract.
function presentationBrowserWiring(text: string): boolean {
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
  const mode = variable('diyPresentationBrowser'), allow = variable('allowed'), umbrella = variable('productPurchaseAdmissionBrowser'), command = variable('commandArgs'), child = variable('testRun');
  if (!mode || !allow || !umbrella || !command || !child) return false;
  const guards = terms(mode, ts.SyntaxKind.AmpersandAmpersandToken);
  if (guards.length !== 3 || !identifier(guards[0], 'schemaMaintenance') || !equal(guards[1], node => {
    node = unwrap(node); return ts.isPropertyAccessExpression(node) && identifier(node.expression, 'tests') && node.name.text === 'length';
  }, node => number(node, 1)) || !equal(guards[2], node => {
    node = unwrap(node); return ts.isElementAccessExpression(node) && identifier(node.expression, 'tests') && !!node.argumentExpression && number(node.argumentExpression, 0);
  }, node => string(node, 'audit:diy-presentation-browser'))) return false;
  const allowed = unwrap(allow);
  if (!ts.isNewExpression(allowed) || !identifier(allowed.expression, 'Set') || allowed.arguments?.length !== 1
    || !ts.isArrayLiteralExpression(allowed.arguments[0]) || !allowed.arguments[0].elements.some(node => ts.isStringLiteral(node) && node.text === 'audit:diy-presentation-browser')) return false;
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
  if (!terms(umbrella, ts.SyntaxKind.BarBarToken).some(node => identifier(node, 'diyPresentationBrowser'))) return false;
  const branch = (input: ts.Expression): ts.Expression | undefined => {
    const node = unwrap(input); if (!ts.isConditionalExpression(node)) return undefined;
    return identifier(node.condition, 'diyPresentationBrowser') ? node.whenTrue : branch(node.whenFalse);
  };
  const dispatched = branch(command), wanted = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.diy-presentation-browser.config.ts', '--maxWorkers=1'];
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
    return ts.isConditionalExpression(value) && identifier(value.condition, 'diyPresentationBrowser') && ts.isObjectLiteralExpression(value.whenTrue)
      && !!property(value.whenTrue, 'TEST_DIY_PRESENTATION_BROWSER') && string(property(value.whenTrue, 'TEST_DIY_PRESENTATION_BROWSER')!, '1')
      && ts.isObjectLiteralExpression(value.whenFalse) && value.whenFalse.properties.length === 0;
  });
}

describe('owned presentation Browser runner executable AST contract', () => {
  const source = readFileSync(script, 'utf8');
  it('connects its exact literal, bounded mode, umbrella, dedicated config, live environment and outer40min spawn', () => { expect(presentationBrowserWiring(source)).toBe(true); });
  it.each([
    ['commented admission', "    'audit:diy-presentation-browser',", "    // 'audit:diy-presentation-browser',"],
    ['detached boolean', "const diyPresentationBrowser = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:diy-presentation-browser';", 'const diyPresentationBrowser = false;'],
    ['detached umbrella', 'diyPresentationBrowser ||', ''],
    ['wrong dispatch config', "vitest.diy-presentation-browser.config.ts", 'vitest.diy-navigation-browser.config.ts'],
    ['wrong environment', "TEST_DIY_PRESENTATION_BROWSER: '1'", "TEST_DIY_PRESENTATION_BROWSER_WRONG: '1'"],
    ['removed outer timeout', 'diyPresentationBrowser ? 40 :', ''],
  ])('rejects %s even when the original bytes remain in a comment', (_name, before, after) => {
    expect(source).toContain(before); expect(presentationBrowserWiring(source.replace(before, after) + '\n// ' + before)).toBe(false);
  });
});

function actualShell(text: string): string | null {
  try {
    const file = ts.createSourceFile('diy-presentation.acceptance.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); let shell: ts.ArrowFunction | undefined;
    function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'shell' && node.initializer && ts.isArrowFunction(node.initializer)) shell = node.initializer; ts.forEachChild(node, visit); }
    visit(file); if (!shell) return null;
    const html = new Script('(' + shell.getText(file) + ')()').runInNewContext({ f: { token: 'owned11', otherToken: 'owned22', adminToken: 'ownedAdmin', adminSession: {} }, plans: [], instructions: {}, control: '/owned-presentation' }) as string;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]; if (scripts.length !== 1) return null; new Script(scripts[0][1]); return scripts[0][1];
  } catch { return null; }
}
function shellBoundary(text: string): boolean {
  const source = actualShell(text); if (!source) return false;
  const file = ts.createSourceFile('actual-presentation-shell.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), nodes: ts.Node[] = [];
  function visit(node: ts.Node) { nodes.push(node); ts.forEachChild(node, visit); } visit(file);
  const print = ts.createPrinter({ removeComments: true }), compact = (node: ts.Node) => print.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/gu, '');
  const readiness = nodes.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'frameReady');
  const navigate = nodes.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'navigateFrame');
  const evict = nodes.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'evictPageCache');
  if (!readiness || !navigate || !evict) return false;
  const ready = compact(readiness), navigation = compact(navigate), eviction = compact(evict);
  if (!ready.includes("w!==frame.contentWindow||d!==frame.contentDocument||!d||d.readyState!=='complete'") || !ready.includes("l.origin===location.origin") || !ready.includes("l.hash==='#/'||l.hash.startsWith('#/pages/')")) return false;
  if (!navigation.includes('frame.contentWindow.location.reload()') || !navigation.includes('frame.src=destination')) return false;
  if (!eviction.includes("key.startsWith('cinashop_diy_page_v1_')") || !eviction.includes('localStorage.removeItem(key)')) return false;
  const calls = nodes.filter(ts.isCallExpression).map(compact);
  if (!calls.some(call => call === "w.addEventListener('hashchange',ready)")) return false;
  if (!calls.includes('watchFrameVideos(w,d)') || !calls.includes('stopVideos()') ||
      !calls.includes('observer.observe(d,{childList:true,subtree:true})') ||
      !calls.includes('observer.disconnect()')) return false;
  if (!calls.some(call => call === "video.addEventListener('play',()=>{record.everPlaying=true;record.events.push({kind:'play',at:Date.now(),time:video.currentTime});})")) return false;
  // Observing genuine media events is allowed; invoking media or app actions is not.
  if (nodes.some(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['play','pause','click','dispatchEvent'].includes(node.expression.name.text))) return false;
  return calls.some(call => call === 'evictPageCache()');
}
describe('real presentation shell observes loading/media without driving application methods', () => {
  const path = resolve(root, 'test/browser/diy-presentation.acceptance.ts'), source = readFileSync(path, 'utf8');
  it('compiles the actual served shell and binds exact real readiness, canonical-root reload, cache eviction, native media events and responsive CSS dimensions', () => {
    const shell = actualShell(source); expect(shell).not.toBeNull(); expect(shellBoundary(source)).toBe(true);
    const file = ts.createSourceFile('actual-presentation-shell.js', shell!, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const oracle = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'cssRpxOracle');
    expect(oracle).toBeDefined();
    // DCloud upx2px caches its first deviceWidth. CSS normalizeRpx uses rem and
    // useRem updates that root rem on actual resize; the oracle must follow CSS.
    const cssRpx = new Script('(' + oracle!.getText(file) + ')').runInNewContext() as
      (w: { getComputedStyle: () => { fontSize: string }; rpx2px: () => number }, d: { documentElement: object }) => { rem: number; rpx: Record<number, number> };
    for (const width of [375, 414, 375]) {
      const measured = cssRpx({ getComputedStyle: () => ({ fontSize: String(width / 23.4375) + 'px' }), rpx2px: () => 18 }, { documentElement: {} });
      expect(measured.rem).toBe(width / 23.4375);
      expect(measured.rpx[36]).toBeCloseTo(36 * width / 750, 10);
      expect(measured.rpx[700]).toBeCloseTo(700 * width / 750, 10);
    }
  });
  it.each([
    ['detached ready event', "w.addEventListener('hashchange',ready)", "w.addEventListener('hashchange',()=>{})"],
    ['unconditional ready', "d.readyState!=='complete'", 'false'],
    ['overbroad eviction', "key.startsWith('cinashop_diy_page_v1_')", 'true'],
    ['synthetic media play', "trackVideos(d);", "trackVideos(d);d.querySelector('video').play();"],
  ])('rejects %s executable mutations despite comments retaining original source', (_name, before, after) => { expect(source).toContain(before); expect(shellBoundary(source.replace(before, after)+'\n// '+before)).toBe(false); });
  it('observes real media events from delayed mount and replacement documents before any checkpoint, while retaining old DOM pause records', () => {
    const shell = actualShell(source)!;
    const file = ts.createSourceFile('actual-presentation-shell.js', shell, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const functions = file.statements.filter((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && ['watchFrameVideos', 'trackVideos'].includes(node.name?.text ?? ''));
    expect(functions).toHaveLength(2);
    const observers: Observer[] = [];
    class Observer {
      disconnected = false;
      constructor(readonly callback: () => void) { observers.push(this); }
      observe(_target: object, options: { childList: boolean; subtree: boolean }) {
        expect(options).toEqual({ childList: true, subtree: true });
      }
      disconnect() { this.disconnected = true; }
    }
    function video() {
      const target = new EventTarget();
      return { paused: true, currentTime: 0, addEventListener: target.addEventListener.bind(target),
        event: (name: string) => target.dispatchEvent(new Event(name)) };
    }
    const firstVideo = video(), secondVideo = video(), ignoredVideo = video();
    let firstElements: ReturnType<typeof video>[] = [];
    const firstDocument = { querySelectorAll: () => firstElements };
    const firstWindow = { MutationObserver: Observer };
    const frame: { contentWindow: object; contentDocument: object } = { contentWindow: firstWindow, contentDocument: firstDocument };
    const actual = new Script('(()=>{let videoSequence=0;const seenVideos=new Map();const frame=actualFrame;' +
      functions.map(node => node.getText(file)).join('\n') +
      ';return {watch:watchFrameVideos,records:()=>[...seenVideos.values()]};})()').runInNewContext({ actualFrame: frame }) as {
        watch(w: object, d: object): () => void;
        records(): Array<{ id: number; everPlaying: boolean; maxTime: number; events: Array<{ kind: string }> }>;
      };
    const stopFirst = actual.watch(firstWindow, firstDocument);
    expect(actual.records()).toEqual([]);
    firstElements = [firstVideo]; observers[0].callback();
    firstVideo.paused = false; firstVideo.event('play'); firstVideo.currentTime = 2;
    firstVideo.event('timeupdate'); firstVideo.paused = true; firstVideo.event('ended');
    expect(actual.records()[0]).toMatchObject({ id: 1, everPlaying: true, maxTime: 2 });
    stopFirst(); expect(observers[0].disconnected).toBe(true);
    const secondDocument = { querySelectorAll: () => [secondVideo] };
    const secondWindow = { MutationObserver: Observer };
    frame.contentWindow = secondWindow; frame.contentDocument = secondDocument;
    firstElements = [firstVideo, ignoredVideo]; observers[0].callback();
    const stopSecond = actual.watch(secondWindow, secondDocument);
    secondVideo.paused = false; secondVideo.event('play'); secondVideo.currentTime = 1;
    secondVideo.event('timeupdate'); secondVideo.paused = true; secondVideo.event('ended');
    firstVideo.event('pause');
    expect(actual.records()).toHaveLength(2);
    expect(actual.records()[0].events.map(event => event.kind)).toEqual(['play', 'ended', 'pause']);
    expect(actual.records()[1]).toMatchObject({ id: 2, everPlaying: true, maxTime: 1 });
    stopSecond(); expect(observers[1].disconnected).toBe(true);
  });
});
