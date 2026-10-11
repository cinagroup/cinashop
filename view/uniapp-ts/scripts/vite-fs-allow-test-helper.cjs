const assert = require("node:assert/strict");
const { lstatSync, realpathSync } = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");

function inside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertDefaultViteFsAllow(actual, root) {
  const project = resolve(root);
  const client = resolve(dirname(require.resolve("vite/package.json")), "dist", "client");
  const expected = [project];

  // Vite includes its own client directory when a lock-matched node_modules
  // junction puts the physical package outside the checkout. Keep the
  // assertion exact: no other external allow entry is accepted.
  if (!inside(project, client)) {
    const modules = join(project, "node_modules");
    assert.equal(lstatSync(modules).isSymbolicLink(), true,
      "an external Vite client requires a node_modules junction");
    assert.equal(realpathSync(join(modules, "vite", "dist", "client")), realpathSync(client));
    assert.ok(inside(realpathSync(modules), realpathSync(client)));
    expected.push(client);
  }
  assert.deepEqual(actual.map(path => resolve(path)), expected);
}

module.exports = { assertDefaultViteFsAllow };
