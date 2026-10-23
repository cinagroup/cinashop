import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { createCheckoutApi } from "../../../view/common/checkoutApi";

// Vue belongs to the actual UniApp installation, not the Worker dependencies.
const uniRequire = createRequire(new URL("../../../view/uniapp-ts/package.json", import.meta.url).href);
const uniVue = uniRequire("vue") as Record<string, unknown>;

export interface UniRequestCall {
  url: string; method: string; data: Record<string, unknown>; header: Record<string, string>;
  withCredentials?: boolean;
  success(response: { data: unknown; statusCode: number; header?: Record<string, unknown> }): void;
  fail(error: { errMsg: string }): void;
}
export interface UniRequestModule {
  http: {
    get<T>(url: string, data?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
    getResponse<T>(url: string, data?: Record<string, unknown>): Promise<{ data: T; headers: Record<string, string> }>;
    post<T>(url: string, data?: Record<string, unknown>): Promise<T>;
  };
  RequestError: new (message: string, status?: number, data?: unknown, httpStatus?: number) => Error & { status?: number; data?: unknown; httpStatus?: number };
}

/** Execute production Uni modules, replacing only native I/O and the authenticated store. */
export function uniCheckoutRuntime(send: (call: UniRequestCall) => void) {
  const auth = { uid: 11, token: "local-synthetic-token", sessionVersion: 0, clear() { this.sessionVersion++; this.uid = 0; this.token = ""; } };
  const navigations: string[] = [];
  const uni = { request: send, navigateTo({ url }: { url: string }) { navigations.push(url); } };
  const modules: Record<string, unknown> = {
    "vue": uniVue,
    "@/stores/auth": { useAuthStore: () => auth },
    "../../../common/checkoutApi": { createCheckoutApi },
  };
  function load(path: string): Record<string, unknown> {
    const source = readFileSync(path, "utf8");
    const output = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("require", "exports", "uni", output)((id: string) => {
      if (!(id in modules)) throw new Error(`Unmocked platform module: ${id}`);
      return modules[id];
    }, exports, uni);
    return exports;
  }
  // Execute the real mutation module once per runtime; its ref remains isolated.
  modules["@/stores/cartMutation"] = load("../view/uniapp-ts/src/stores/cartMutation.ts");
  const request = load("../view/uniapp-ts/src/utils/request.ts") as unknown as UniRequestModule;
  modules["@/utils/request"] = request;
  const { checkoutApi } = load("../view/uniapp-ts/src/api/checkout.ts") as unknown as { checkoutApi: ReturnType<typeof createCheckoutApi> };
  return { request, checkoutApi, auth, navigations };
}
