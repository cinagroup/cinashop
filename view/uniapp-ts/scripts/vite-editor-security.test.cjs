const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const test = require('node:test');
const builder = require('./build-vite-safety-backport.cjs');

// Execute the real bundled editor/path/position functions with inert filesystem
// and process sinks. This is portable policy proof, not a native Windows shell claim.
function editor(platform, wsl = false) {
  const chunk = builder.readArchive(readFileSync(builder.OUTPUT_PATH)).find(entry => entry.name === builder.CHUNK).bytes.toString('utf8');
  const start = chunk.indexOf('var getArgs = function getArgumentsForPosition ('), end = chunk.indexOf('var launchEditor_1 = launchEditor;', start);
  assert.ok(start >= 0 && end > start, 'review the real bundled editor boundary when upgrading');
  const nativePath = platform === 'win32' ? path.win32 : path.posix;
  const cwd = platform === 'win32' ? 'C:\\editor-fixture' : '/mnt/c/editor-fixture';
  const paths = { ...nativePath, resolve: (...parts) => nativePath.resolve(cwd, ...parts),
    relative: (from, to) => nativePath.relative(from || cwd, to) };
  const calls = [], probes = [], errors = []; let kills = 0;
  const child = { on() { return this; }, kill() { kills++; } };
  const processes = { exec: (...args) => (calls.push({ kind: 'exec', args }), child),
    spawn: (...args) => (calls.push({ kind: 'spawn', args }), child) };
  const context = { process: { platform, env: {} }, console: { log() {} }, path$6: paths,
    require$$0__default: { existsSync(file) { probes.push(file); return true; } },
    require$$2: { release: () => wsl ? 'Microsoft WSL fixture' : 'Linux fixture' }, require$$0$4: paths,
    picocolorsExports: { red: value => value }, require$$2$1: processes, guess: () => ['vim'] };
  runInNewContext(chunk.slice(start, end) + '\nglobalThis.probe = { parseFile, launchEditor };', context, { timeout: 1000 });
  return { ...context.probe, calls, probes, errors, kills: () => kills,
    launch: file => context.probe.launchEditor(file, 'vim', (_file, error) => errors.push(error)) };
}

test('Windows bundled editor rejects percent expansions and CR/LF before execution or killing an existing editor', () => {
  const probe = editor('win32'); probe.launch('C:\\editor-fixture\\normal file.ts:12:3');
  assert.equal(probe.calls.length, 1); assert.equal(probe.calls[0].kind, 'exec');
  assert.match(probe.calls[0].args[0], /normal file\.ts/);
  for (const file of ['100%/file.ts', '%VAR:old=new%', 'line\rbreak.ts', 'line\nbreak.ts']) {
    probe.launch('C:\\editor-fixture\\' + file); assert.equal(probe.calls.length, 1); assert.equal(probe.kills(), 0);
    assert.match(probe.errors.at(-1), /argument containing/);
  }
});

test('position stripping resolves a parent component before the real existence probe and preserves an empty filename', () => {
  const probe = editor('win32');
  assert.equal(probe.parseFile(':1:1').fileName, '');
  const file = 'C:\\editor-fixture\\attacker%NAME%\\..:1:1';
  assert.equal(probe.parseFile(file).fileName, 'C:\\editor-fixture');
  probe.launch(file); assert.deepEqual(probe.probes, ['C:\\editor-fixture']);
  assert.equal(probe.calls.length, 1); assert.equal(probe.calls[0].args[0].includes('%'), false);
});

test('option-like files are absolute on Linux and explicitly relative in WSL, including positioned editor arguments', () => {
  for (const wsl of [false, true]) {
    const probe = editor('linux', wsl);
    for (const name of ['+inert-option.ts', '-inert-option.ts']) {
      probe.launch(`${name}:12:3`);
      const [program, args] = probe.calls.at(-1).args;
      assert.equal(program, 'vim'); assert.equal(args[0], '+call cursor(12, 3)');
      assert.equal(args.at(-1), wsl ? `./${name}` : `/mnt/c/editor-fixture/${name}`);
      assert.equal(probe.probes.at(-1), `/mnt/c/editor-fixture/${name}`);
    }
  }
});
