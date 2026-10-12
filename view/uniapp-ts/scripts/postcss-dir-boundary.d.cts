import type { Plugin as VitePlugin } from "vite";
import type { Plugin as PostcssPlugin } from "postcss";

export function createPostcssDirBoundary(sourceRoot: string): PostcssPlugin;
export function createPostcssConfigurationGuard(boundary: PostcssPlugin): VitePlugin;
