import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const dictionary = ts.createSourceFile("en.ts", fs.readFileSync("src/i18n/en.ts", "utf8"), ts.ScriptTarget.Latest, true);
const translations = new Map();
function readTranslations(node) {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer)) {
    assert.ok(!translations.has(node.name.text), `Duplicate translation: ${node.name.text}`);
    translations.set(node.name.text, node.initializer.text);
  }
  ts.forEachChild(node, readTranslations);
}
readTranslations(dictionary);
const placeholders = (value) => [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
for (const [source, translated] of translations) {
  assert.ok(translated.trim(), `Empty translation: ${source}`);
  assert.doesNotMatch(translated, /\p{Script=Han}/u, `Chinese text in English translation: ${source}`);
  assert.deepEqual(placeholders(source), placeholders(translated), `Placeholder mismatch: ${source}`);
}
let count = 0;
const exceptions = new Set(["agentNote/归档文件", "问题反馈"]); // Stable paths and feedback type IDs.
for (const file of fs.readdirSync("src", { recursive: true }).filter((file) => file.endsWith(".ts") && !file.startsWith(`i18n${path.sep}`))) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join("src", file), "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const key = node.arguments[0];
      if (key && ts.isStringLiteralLike(key)) {
        assert.ok(translations.has(key.text), `${file}: Missing English translation: ${key.text}`);
        const indices = [...key.text.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
        assert.ok(indices.every((index) => index < node.arguments.length - 1), `${file}: Missing interpolation value: ${key.text}`);
        count++;
      }
    }
    if ((file.startsWith(`ui${path.sep}`) || file === "main.ts" || file === "updater.ts") && ts.isStringLiteralLike(node) && /\p{Script=Han}/u.test(node.text)) {
      const translated = ts.isCallExpression(node.parent) && node.parent.expression.getText(source) === "t" && node.parent.arguments[0] === node;
      const propertyKey = node.parent.name === node && ts.isPropertyAssignment(node.parent);
      const resourceUrl = /^https:\/\//.test(node.text);
      assert.ok(translated || propertyKey || resourceUrl || exceptions.has(node.text), `${file}: Untranslated interface text: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log(`Localization coverage passed: ${translations.size} English messages, ${count} translated call sites.`);
