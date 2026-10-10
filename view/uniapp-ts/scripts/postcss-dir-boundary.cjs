const { readdirSync, realpathSync } = require("node:fs");
const { isAbsolute, relative, resolve, sep, dirname } = require("node:path");

const GUARD_NAME = "cinashop-postcss-dir-boundary";
// DCloud concatenates dir and glob before invoking fast-glob. A flat style
// pattern is enough for the current app; new pattern forms need review first.
const FLAT_STYLE_GLOB = /^\*\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)$/u;

function inside(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateDirectoryMessage(message, cssFile, sourceRoot) {
  if (typeof message.dir !== "string" || !message.dir) {
    throw new Error("PostCSS dir-dependency requires a directory");
  }
  const glob = message.glob ?? "**";
  if (typeof glob !== "string" || !FLAT_STYLE_GLOB.test(glob)) {
    throw new Error("PostCSS dir-dependency glob must be one flat style-file pattern");
  }

  const sourcePath = resolve(sourceRoot);
  const source = realpathSync(sourcePath);
  const cssPath = resolve(cssFile.split(/[?#]/u, 1)[0]);
  const css = realpathSync(cssPath);
  if (!inside(sourcePath, cssPath) || !inside(source, css)) {
    throw new Error("PostCSS dir-dependency CSS input is outside src");
  }
  // Match the lexical path DCloud will scan, then also check its physical
  // target. Resolving from the real CSS path could miss a symlink-depth escape.
  const scanPath = resolve(dirname(cssPath), message.dir);
  if (!inside(sourcePath, scanPath)) {
    throw new Error("PostCSS dir-dependency directory is outside src");
  }
  const directory = realpathSync(scanPath);
  if (!inside(source, directory)) {
    throw new Error("PostCSS dir-dependency directory is outside src");
  }
  // fast-glob follows links by default. No link in a flat scan directory may
  // redirect its matching CSS file to an unapproved tree.
  if (readdirSync(directory, { withFileTypes: true }).some(entry => entry.isSymbolicLink())) {
    throw new Error("PostCSS dir-dependency directory contains a symbolic link");
  }
}

function createPostcssDirBoundary(sourceRoot) {
  if (typeof sourceRoot !== "string") throw new TypeError("sourceRoot is required");
  return {
    postcssPlugin: GUARD_NAME,
    OnceExit(_root, { result }) {
      for (const message of result.messages) {
        if (message.type === "dir-dependency") {
          validateDirectoryMessage(message, result.opts.from, sourceRoot);
        }
      }
    },
  };
}

function createPostcssConfigurationGuard(boundary) {
  let configuredPlugins;
  function assertLast() {
    if (!Array.isArray(configuredPlugins) || configuredPlugins.at(-1) !== boundary ||
        configuredPlugins.filter(plugin => plugin === boundary).length !== 1) {
      throw new Error("PostCSS boundary must be the last configured PostCSS plugin");
    }
  }
  return {
    name: "cinashop:postcss-boundary-configuration",
    enforce: "post",
    configResolved(config) {
      const plugins = config.css?.postcss?.plugins;
      if (!Array.isArray(plugins) || plugins.filter(plugin => plugin === boundary).length !== 1) {
        throw new Error("PostCSS boundary is missing or duplicated");
      }
      // DCloud appends uni-app and autoprefixer in its configResolved hook.
      // Move the policy after them so their messages are checked before the
      // locked CSS compiler expands any dir-dependency with fast-glob.
      plugins.splice(plugins.indexOf(boundary), 1);
      plugins.push(boundary);
      configuredPlugins = plugins;
      assertLast();
    },
    buildStart: assertLast,
    configureServer: assertLast,
  };
}

module.exports = { createPostcssDirBoundary, createPostcssConfigurationGuard };
