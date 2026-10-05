import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
const revision = 'a'.repeat(64);
const profile = () => ({
  id: 1, supplier_name: '原供应商', avatar: '', name: '原联系人',
  phone: '13800138000', email: 'owner@example.com', address: '原地址',
  province: 1, city: 2, area: 3, street: 4, detailed_address: '门牌一',
  sort: 0, is_show: 1, mark: '管理员备注', account: 'primary-a', revision,
});

let runtime: any;
beforeAll(async () => {
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/Profile.vue';
      export { apiState } from '@/api/supplier';
      export { messageState } from 'element-plus';
      export { ApiError } from '@/api/http';
      export { createRenderer, nextTick } from 'vue';
    ` },
    alias: { '@': resolve(root, 'src') },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'supplier-profile-revision-fixtures', setup(builder) {
      builder.onLoad({ filter: /[.]vue$/, }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'),
          { filename: path }).descriptor, { id: 'supplier-profile-revision' }).content,
        loader: 'ts',
      }));
      builder.onResolve({ filter: /^@[/]api[/]supplier$/ }, () =>
        ({ path: 'supplier-api', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@[/]api[/]http$/ }, () =>
        ({ path: 'supplier-http', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@[/]stores[/]auth$/ }, () =>
        ({ path: 'supplier-auth', namespace: 'fixture' }));
      builder.onResolve({ filter: /^vue-router$/ }, () =>
        ({ path: 'router', namespace: 'fixture' }));
      builder.onResolve({ filter: /^element-plus$/ }, () =>
        ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /^supplier-api$/, namespace: 'fixture' }, () => ({
        contents: `
          export const apiState = { profile: null, writes: [], failure: null };
          export async function getProfile() { return { ...apiState.profile }; }
          export async function updateProfile(payload) {
            apiState.writes.push(payload);
            if (apiState.failure) throw apiState.failure;
            return null;
          }
          export async function updatePassword() { return null; }
        `,
      }));
      builder.onLoad({ filter: /^supplier-http$/, namespace: 'fixture' }, () => ({
        contents: `
          export class ApiError extends Error {
            constructor(message, status) { super(message); this.status = status; }
          }
        `,
      }));
      builder.onLoad({ filter: /^supplier-auth$/, namespace: 'fixture' }, () =>
        ({ contents: 'export function useAuthStore() { return { signOut: async () => {} }; }' }));
      builder.onLoad({ filter: /^router$/, namespace: 'fixture' }, () =>
        ({ contents: 'export function useRouter() { return { replace: async () => {} }; }' }));
      builder.onLoad({ filter: /^messages$/, namespace: 'fixture' }, () => ({
        contents: `
          export const messageState = { info: [], warnings: [], errors: [], successes: [] };
          export const ElMessage = {
            info: value => messageState.info.push(value),
            warning: value => messageState.warnings.push(value),
            error: value => messageState.errors.push(value),
            success: value => messageState.successes.push(value),
          };
        `,
      }));
    } }],
  });
  runtime = await import('data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64'));
});

beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { href: '' } }));
  runtime.apiState.profile = profile();
  runtime.apiState.writes = [];
  runtime.apiState.failure = null;
  for (const key of ['info', 'warnings', 'errors', 'successes']) runtime.messageState[key] = [];
});

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await new Promise(done => setTimeout(done, 1));
    await runtime.nextTick();
  }
};

async function mount() {
  let view: any;
  const renderer = runtime.createRenderer({
    createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {},
  });
  const app = renderer.createApp({
    setup(props: unknown, context: unknown) {
      view = runtime.Page.setup(props, context);
      return () => null;
    },
  });
  app.mount({ children: [] });
  await flush();
  return { view, close: () => app.unmount() };
}

it('sends only the changed field with the displayed opaque revision', async () => {
  const mounted = await mount();
  try {
    mounted.view.form.value.name = '供应商改名';
    mounted.view.form.value.province = 99;
    await mounted.view.save();
    expect(runtime.apiState.writes).toEqual([
      { name: '供应商改名', expected_revision: revision },
    ]);
    expect(runtime.messageState.successes).toContain('供应商资料已保存');
  } finally { mounted.close(); }
});

it('keeps the edited form after 409 and asks for a refresh', async () => {
  const mounted = await mount();
  try {
    mounted.view.form.value.name = '尚未保存的改名';
    runtime.apiState.failure = new runtime.ApiError('资料已变更', 409);
    await mounted.view.save();
    expect(runtime.apiState.writes).toEqual([
      { name: '尚未保存的改名', expected_revision: revision },
    ]);
    expect(mounted.view.form.value.name).toBe('尚未保存的改名');
    expect(mounted.view.loadedProfile.value.revision).toBe(revision);
    expect(runtime.messageState.warnings.at(-1)).toContain('当前输入已保留');
    expect(runtime.messageState.warnings.at(-1)).toContain('刷新页面');
    expect(runtime.messageState.errors).toEqual([]);
  } finally { mounted.close(); }
});
