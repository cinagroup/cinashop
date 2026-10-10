"use strict";

// Preserve DCloud's original argv layout: its bin checks argv[2] for "build".
// This guards repository-managed H5 scripts only; direct `uni` is outside it.
const args = process.argv.slice(2);

if (args.some((arg) => /^--?ssr(?:=|$)/i.test(arg))) {
  console.error("H5 SSR mode is disabled for repository-managed scripts");
  process.exitCode = 2;
} else {
  const cli = require.resolve("@dcloudio/vite-plugin-uni/bin/uni.js");
  process.argv[1] = cli;
  require(cli);
}
