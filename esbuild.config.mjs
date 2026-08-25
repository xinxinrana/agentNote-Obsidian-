import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...builtins,
];

/** Plugin bundle (Obsidian entry). */
const pluginConfig = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  loader: { ".svg": "dataurl", ".png": "dataurl" },
  outfile: "main.js",
};

/**
 * Core-only bundle for the black-box e2e test: no `obsidian` import,
 * runs on plain Node. Exposes the store + server factories.
 */
const coreConfig = {
  entryPoints: ["src/core/index.ts"],
  bundle: true,
  external: [...builtins],
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "info",
  sourcemap: false,
  minify: false,
  treeShaking: true,
  outfile: "test/core-bundle.cjs",
};

if (watch) {
  const ctx = await esbuild.context(pluginConfig);
  const coreCtx = await esbuild.context(coreConfig);
  await Promise.all([ctx.watch(), coreCtx.watch()]);
  console.log("watching...");
} else {
  await esbuild.build(pluginConfig);
  await esbuild.build(coreConfig);
}
