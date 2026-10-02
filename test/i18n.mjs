import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";

const source = readFileSync(new URL("../src/ui/i18n.ts", import.meta.url), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;

function loadFor(language) {
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: () => ({ getLanguage: language === null ? undefined : () => language }) });
  return module.exports;
}

assert.equal(loadFor("zh-cn").t("heroTitle"), "知识正在持续进入工作流");
assert.equal(loadFor("en").t("heroTitle"), "Your knowledge at work");
assert.equal(loadFor("en").t("weekSummary", { count: 2, created: 1, updated: 0, shares: 1, resolves: 0 }), "This week: 2 knowledge activities — 1 created, 0 maintained, 1 shared, and 0 reads.");
assert.equal(loadFor(null).t("heroTitle"), "知识正在持续进入工作流");
console.log("i18n language selection and fallback passed");
