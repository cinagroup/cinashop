# UniApp H5 SSR Express and qs boundary

Scope: locked `@dcloudio/vite-plugin-uni` `3.0.0-4020920240930001` → `express` `4.22.2` → `qs` `6.15.3`. Express also loads `body-parser` `1.20.6`, which resolves the same `qs` version. This audit changes no dependency or runtime code.

## Current reachability

The DCloud H5 `runDev` action calls `createServer` for ordinary development and `createSSRServer` only when its `-ssr` option is enabled. The current `dev:h5` script is `uni`, the `build:h5` script is `uni build`, the CLI option defaults to false, the H5 manifest does not opt into SSR, and the source has no `entry-server.js`. The ordinary H5 development entrypoint invokes Vite without loading Express, body-parser or qs. Current build scripts also omit SSR; the H5 build action chooses ordinary `build`, not `buildSSR`. Existing H5, Weixin and App CI builds do not start the Express SSR server. This is an **untriggered developer-server path** in the current repository, not an observed app runtime endpoint.

The fail-fast test checks the exact current scripts, manifest, entrypoint absence, locked dependency versions and DCloud CLI branch. Enabling SSR, changing these locked versions, or changing the entrypoint requires a fresh review.

## Conditional SSR behavior

If a future H5 development run enables SSR, DCloud dynamically loads Express. Its SSR handler installs Vite middleware and a catch-all page handler; it does not install an Express URL-encoded body parser. Express itself defaults to the extended query parser, which calls qs for request query strings. Thus qs is relevant to SSR request input even though the body-parser package is only loaded as an Express dependency.

In this locked DCloud version, `createSSRServer` derives its listen hostname from CLI `options.host`, **not** the resolved Vite `server.host`. With no CLI host, it passes `undefined` to `app.listen`, which Node treats as a bind to available interfaces. Our `vite.config.ts` has `server.host: "127.0.0.1"` for ordinary Vite development, but it does not protect this SSR listener. The test intercepts the real Express `app.listen` before any socket binds: with a fake resolved Vite host of `127.0.0.1`, the default SSR call passes `undefined`; an explicit `host: "127.0.0.1"` passes loopback. Before enabling SSR, review the actual listener bind, network access, and the handling and limits of untrusted qs query input. Do not infer safety from this audit or from the absence of a known exploit reproduction.

From `view/uniapp-ts`, run `npm run test:express-qs`. The test uses the actual locked DCloud and Express code, stubs Vite startup, and blocks HTTP requests and socket listening. CI runs this gate before normal H5, Weixin and App builds. A passing test documents the current boundary; it does not exercise an exposed SSR endpoint, clear Express/qs advisories, or close TEST-004D3.
