import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
const require = createRequire(import.meta.url);
const { VaultStore } = require("../test/core-bundle.cjs");

const vault = process.argv[2] ?? String.raw`C:\Users\ASUS\Documents\测试`;
const store = new VaultStore(vault);
const initInfo = await store.init();
if (initInfo.migratedNodes > 0 || initInfo.legacyVersionsBackup) {
  console.log(
    `init migrated ${initInfo.migratedNodes} legacy node(s)` +
      (initInfo.legacyVersionsBackup ? `; old versions/ moved to ${initInfo.legacyVersionsBackup}` : "")
  );
}

const nodes = await store.listNodes();
console.log(`nodes: ${nodes.length}`);
for (const n of nodes) {
  const rel = await store.nodeFilePath(n.id);
  const b = n.boundary;
  const bx = [b.background, b.scenarios, b.caveats].map((s) => (s ? "✓" : "✗")).join("");
  console.log(`  ${n.id} [${n.type}] src=${n.source} 边界:${bx}  ${n.title}\n    → ${rel}`);
}
const groups = await store.listGroups();
console.log(`groups: ${groups.groups.length}`);
for (const g of groups.groups) console.log(`  ${g.id} ${g.name}${g.parentId ? ` (parent ${g.parentId})` : ""}`);
console.log(`memberships: ${Object.keys(groups.membership).length} node(s)`);
const shares = await store.listShares();
for (const s of shares) {
  try {
    await store.resolveShare(s.id);
    console.log(`share ${s.id}: live → ${s.nodeId}`);
  } catch (e) {
    console.log(`share ${s.id}: resolve → HTTP ${e.statusCode} (revoked, expected)`);
  }
}
// no legacy leftovers expected after init
const legacyVersions = path.join(vault, "agentNote", "versions");
console.log(fs.existsSync(legacyVersions) ? "⚠ legacy versions/ dir still present" : "✓ no legacy versions/ dir");
