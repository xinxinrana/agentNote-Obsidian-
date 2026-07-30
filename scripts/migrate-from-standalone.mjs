/**
 * One-shot migration: standalone agentNote desktop service → Obsidian plugin.
 *
 * Pulls every node's CURRENT state, the collection tree, and node-type
 * shares from a running standalone service (default http://127.0.0.1:8321)
 * and writes them into a vault's agentNote store using the SAME core engine
 * as the plugin — so the result is indistinguishable from data created
 * through the plugin itself.
 *
 * History is NOT imported: version management is delegated to git, so only
 * the latest state of each node is migrated.
 *
 * Usage:
 *   npm run build          # produces test/core-bundle.cjs
 *   node scripts/migrate-from-standalone.mjs [--from http://127.0.0.1:8321] --vault <path>
 *
 * Field mapping (standalone → plugin):
 *   background  → boundary.background
 *   applicable  → boundary.scenarios
 *   caveats     → boundary.caveats
 *   description + content → content (joined, lossless)
 *   source "user" → "user"; anything else (e.g. "WorkBuddy") → "agent"
 *   collection tree → groups; node.collections → membership
 *   shares: target_type "node" imported (revoked state preserved);
 *           collection/bundle shares have no plugin equivalent and are skipped (logged)
 *
 * Idempotency: refuses to run if the vault already has nodes (pass --force
 * to wipe existing agentNote node data first).
 */

import { createRequire } from "module";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

const require = createRequire(import.meta.url);
const { VaultStore, parseNode, serializeNode } = require("../test/core-bundle.cjs");

// ---------- args ----------

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const FROM = arg("from", "http://127.0.0.1:8321");
const VAULT = arg("vault", null);
const FORCE = args.includes("--force");
if (!VAULT) {
  console.error("usage: node scripts/migrate-from-standalone.mjs --vault <vault-path> [--from url] [--force]");
  process.exit(1);
}

// ---------- lenient JSON ----------

/**
 * The standalone service emits INVALID JSON when values contain Windows
 * paths: backslashes are not escaped ("D:\季令\..." → invalid \escape).
 * Fix by escaping every backslash that isn't already a valid JSON escape.
 */
function parseLenient(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const fixed = raw.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    return JSON.parse(fixed);
  }
}

async function get(p) {
  const res = await fetch(FROM + p);
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}`);
  return parseLenient(await res.text());
}

// ---------- main ----------

const store = new VaultStore(VAULT);
await store.init();

const nodesDir = path.join(VAULT, "agentNote", "nodes");
const existing = fs.existsSync(nodesDir) ? fs.readdirSync(nodesDir).filter((f) => f.endsWith(".md")) : [];
if (existing.length > 0 && !FORCE) {
  console.error(`vault already has ${existing.length} agentNote node(s); re-run with --force to wipe and re-import`);
  process.exit(1);
}
if (existing.length > 0 && FORCE) {
  await fsp.rm(path.join(VAULT, "agentNote", "nodes"), { recursive: true, force: true });
  await store.init();
  console.log(`wiped ${existing.length} existing node(s)`);
}

console.log(`source: ${FROM}`);
console.log(`target vault: ${path.resolve(VAULT)}\n`);

// 1. nodes (latest state only — history belongs to git now)
const nodeList = await get("/api/nodes");
const idMap = new Map(); // old id → new id

for (const summary of nodeList) {
  const old = await get(`/api/nodes/${summary.id}`);

  const created = await store.createNode({
    type: old.type,
    title: old.title ?? "(untitled)",
    content: [old.description, old.content].filter((s) => s && String(s).trim()).join("\n\n"),
    boundary: {
      background: old.background ?? "",
      scenarios: old.applicable ?? "",
      caveats: old.caveats ?? "",
    },
    tags: old.tags ?? [],
    path: old.path ?? undefined,
    source: old.source === "user" ? "user" : "agent",
  });

  // restore original timestamps on the (title-named) node file
  const nodeFile = path.join(VAULT, await store.nodeFilePath(created.id));
  const node = parseNode(await fsp.readFile(nodeFile, "utf8"));
  node.created = old.created_at ?? node.created;
  node.updated = old.updated_at ?? node.updated;
  await fsp.writeFile(nodeFile, serializeNode(node), "utf8");

  idMap.set(old.id, created.id);
  console.log(`✓ ${old.id} → ${created.id}  [${old.type}] ${old.title}`);
}

// 2. collections → groups
const collections = await get("/api/collections");
const groupMap = new Map();
const membership = new Map(); // newNodeId → [newGroupId]

async function importCollection(c, parentGroupId) {
  const g = await store.createGroup(c.name, parentGroupId);
  groupMap.set(c.id, g.id);
  for (const nid of c.node_ids ?? []) {
    const mapped = idMap.get(nid);
    if (mapped) {
      if (!membership.has(mapped)) membership.set(mapped, []);
      membership.get(mapped).push(g.id);
    }
  }
  for (const child of c.children ?? []) await importCollection(child, g.id);
}
for (const c of collections) await importCollection(c, null);
for (const [nodeId, gids] of membership) await store.setNodeGroups(nodeId, gids);
console.log(`✓ ${groupMap.size} collection(s) → groups, ${membership.size} node(s) assigned`);

// 3. shares (node-type only)
const shares = await get("/api/shares");
let importedShares = 0;
for (const s of shares) {
  if (s.target_type === "node" && idMap.get(s.target_id)) {
    const created = await store.createShare(idMap.get(s.target_id));
    if (s.revoked) await store.revokeShare(created.id);
    console.log(`✓ share ${s.id} → ${created.id}${s.revoked ? " (revoked)" : ""} → ${s.target_id}`);
    importedShares++;
  } else {
    console.log(`⚠ share ${s.id} (${s.target_type}) skipped — no plugin equivalent`);
  }
}

console.log(
  `\ndone: ${idMap.size} nodes, ${groupMap.size} groups, ${importedShares} shares imported`
);
