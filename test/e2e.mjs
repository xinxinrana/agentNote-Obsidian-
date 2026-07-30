/**
 * agentNote black-box e2e tests.
 *
 * No Obsidian involved: builds a real VaultStore on a temp directory and
 * starts the real AgentServer on a real port, then drives the acceptance
 * flow from PRD §9 purely over HTTP.
 *
 *   node test/e2e.mjs
 */

import { createRequire } from "module";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import assert from "assert/strict";

const require = createRequire(import.meta.url);
const { VaultStore, AgentServer, installSkill, renderSkillMd, defaultSkillDir, detectAgents, KNOWN_AGENTS } = require("./core-bundle.cjs");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

async function main() {
  const vault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-e2e-"));
  const store = new VaultStore(vault);
  const server = new AgentServer(store, { port: 0 }); // ephemeral port
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  console.log(`server up at ${base}, vault: ${vault}\n`);

  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, ...json };
  };

  let nodeId;
  let shareId;

  // ---- PRD §9 acceptance flow ---------------------------------------------

  await test("§9.1 agent writes a memory with boundary info", async () => {
    const r = await api("POST", "/api/nodes", {
      type: "snippet",
      title: "payments-service retry policy",
      content: "The payments service retries at most 3 times with exponential backoff, starting at 200ms.",
      boundary: {
        background: "Decided in the 2026-06 incident review after duplicate charges.",
        scenarios: "Any change touching the payments retry logic or its client SDK.",
        caveats: "Invalid if the gateway gains its own retry layer (planned Q4).",
      },
      tags: ["payments", "retry"],
      source: "agent",
    });
    assert.equal(r.status, 201, JSON.stringify(r));
    assert.equal(r.ok, true);
    assert.match(r.data.id, /^n-/);
    assert.deepEqual(r.data.warnings, []); // boundary complete → no warning
    nodeId = r.data.id;
  });

  await test("node file is named after its title, not the id", async () => {
    const files = await fsp.readdir(path.join(vault, "agentNote", "nodes"));
    assert.deepEqual(files, ["payments-service retry policy.md"]);
  });

  await test("node file on disk is plain readable markdown (原则 4)", async () => {
    const raw = await fsp.readFile(
      path.join(vault, "agentNote", "nodes", "payments-service retry policy.md"),
      "utf8"
    );
    assert.match(raw, /^---\n/);
    assert.match(raw, /agentnote: true/);
    assert.match(raw, /payments-service retry policy/);
    assert.equal(/^version:/m.test(raw), false); // history is git's job
  });

  await test("§9.2 user modifies the memory", async () => {
    const r = await api("PUT", `/api/nodes/${nodeId}`, {
      content: "The payments service retries at most 5 times with exponential backoff, starting at 200ms.",
      source: "user",
    });
    assert.equal(r.status, 200);
    assert.match(r.data.content, /at most 5 times/);
  });

  await test("§9.3 agent reads latest content (history delegated to git — no versions API)", async () => {
    const latest = await api("GET", `/api/nodes/${nodeId}`);
    assert.match(latest.data.content, /at most 5 times/);
    assert.equal("version" in latest.data, false);
    // the old version/rollback endpoints are gone
    assert.equal((await api("GET", `/api/nodes/${nodeId}/versions`)).status, 404);
    assert.equal((await api("POST", `/api/nodes/${nodeId}/rollback`, { version: 1 })).status, 404);
  });

  await test("renaming a title renames the file; shares/groups keep working (stable id)", async () => {
    const r = await api("PUT", `/api/nodes/${nodeId}`, { title: "payments 重试策略: v2?" });
    assert.equal(r.status, 200);
    const files = await fsp.readdir(path.join(vault, "agentNote", "nodes"));
    // illegal filename chars are sanitized
    assert.deepEqual(files, ["payments 重试策略- v2-.md"]);
    // id unchanged, still resolvable
    const again = await api("GET", `/api/nodes/${nodeId}`);
    assert.equal(again.data.title, "payments 重试策略: v2?");
    // rename back for the rest of the flow
    await api("PUT", `/api/nodes/${nodeId}`, { title: "payments-service retry policy" });
  });

  await test("duplicate titles get a numeric suffix, not an overwrite", async () => {
    const a = await api("POST", "/api/nodes", { type: "snippet", title: "dup title" });
    const b = await api("POST", "/api/nodes", { type: "snippet", title: "dup title" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const files = (await fsp.readdir(path.join(vault, "agentNote", "nodes"))).sort();
    assert.ok(files.includes("dup title.md"));
    assert.ok(files.includes("dup title 2.md"));
    // both nodes survive independently
    assert.notEqual(a.data.id, b.data.id);
    assert.equal((await api("GET", `/api/nodes/${a.data.id}`)).status, 200);
    assert.equal((await api("GET", `/api/nodes/${b.data.id}`)).status, 200);
  });

  await test("§9.4 user shares a selected span of text", async () => {
    const r = await api("POST", "/api/shares", {
      nodeId,
      selection: "retries at most 5 times",
    });
    assert.equal(r.status, 201);
    assert.match(r.data.id, /^s-x-/);
    shareId = r.data.id;
  });

  await test("§9.5 agent resolves the share reference and gets live content", async () => {
    const r = await api("GET", `/api/shares/${shareId}/resolve`);
    assert.equal(r.status, 200);
    assert.equal(r.data.scope, "selection");
    assert.equal(r.data.content, "retries at most 5 times");
    assert.equal(r.data.boundary.scenarios.length > 0, true);
  });

  await test("share URL with ?raw=1 returns plain text directly (agent-friendly)", async () => {
    const res = await fetch(`${base}/api/shares/${shareId}/resolve?raw=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/plain/);
    assert.equal(await res.text(), "retries at most 5 times");
  });

  await test("share resolution is LIVE: edits are visible without re-sharing (FR-5)", async () => {
    const cur = await api("GET", `/api/nodes/${nodeId}`);
    await api("PUT", `/api/nodes/${nodeId}`, {
      content: cur.data.content.replace("at most 5 times", "at most 7 times"),
    });
    const r = await api("GET", `/api/shares/${shareId}/resolve`);
    // the old selection text is gone now → live resolution must say so
    assert.equal(r.status, 410);
    const whole = await api("POST", "/api/shares", { nodeId });
    const full = await api("GET", `/api/shares/${whole.data.id}/resolve`);
    assert.match(full.data.content, /at most 7 times/);
  });

  await test("§9.6 user revokes the share", async () => {
    const r = await api("POST", `/api/shares/${shareId}/revoke`);
    assert.equal(r.status, 200);
    assert.equal(r.data.revoked, true);
  });

  await test("§9.7 resolving a revoked share fails clearly", async () => {
    const r = await api("GET", `/api/shares/${shareId}/resolve`);
    assert.equal(r.status, 410);
    assert.equal(r.ok, false);
    assert.match(r.error, /吊销/);
  });

  // ---- Universal sharing: any vault file/folder is shareable ---------------

  await test("share a plain vault file by path → live content, loose-coupled result", async () => {
    await fsp.writeFile(path.join(vault, "random-note.md"), "# 随便一篇笔记\n\nsome body text here\n");
    const r = await api("POST", "/api/shares", { path: "random-note.md" });
    assert.equal(r.status, 201);
    assert.match(r.data.id, /^s-x-/);
    assert.deepEqual(r.data.target, { kind: "file", path: "random-note.md" });

    const got = await api("GET", `/api/shares/${r.data.id}/resolve`);
    assert.equal(got.status, 200);
    assert.equal(got.data.scope, "full");
    assert.match(got.data.content, /some body text here/);
    assert.equal(got.data.title, "random-note"); // ext stripped, light context
    assert.ok(got.data.updated); // mtime, not node.updated
    // loose coupling: a plain file has no boundary/warnings — nothing forced
    assert.equal(got.data.boundary, undefined);
    assert.equal(got.data.warnings, undefined);

    // live: edit the file, resolve again, see the edit
    await fsp.appendFile(path.join(vault, "random-note.md"), "\nappended later\n");
    const again = await api("GET", `/api/shares/${r.data.id}/resolve`);
    assert.match(again.data.content, /appended later/);
  });

  await test("file share with selection resolves the live span", async () => {
    const r = await api("POST", "/api/shares", {
      path: "random-note.md",
      selection: "appended later",
    });
    assert.equal(r.status, 201);
    const got = await api("GET", `/api/shares/${r.data.id}/resolve`);
    assert.equal(got.data.scope, "selection");
    assert.equal(got.data.content, "appended later");
    assert.equal(got.data.title, "random-note");
  });

  await test("file share rejects a selection not in the file (400)", async () => {
    const r = await api("POST", "/api/shares", {
      path: "random-note.md",
      selection: "no such text anywhere",
    });
    assert.equal(r.status, 400);
  });

  await test("share a folder → live recursive listing", async () => {
    await fsp.mkdir(path.join(vault, "kb", "sub"), { recursive: true });
    await fsp.writeFile(path.join(vault, "kb", "a.md"), "A");
    await fsp.writeFile(path.join(vault, "kb", "sub", "b.md"), "B");
    const r = await api("POST", "/api/shares", { path: "kb" });
    assert.equal(r.status, 201);
    assert.deepEqual(r.data.target, { kind: "folder", path: "kb" });
    const got = await api("GET", `/api/shares/${r.data.id}/resolve`);
    assert.equal(got.data.scope, "listing");
    assert.equal(got.data.title, "kb");
    const lines = got.data.content.split("\n");
    assert.deepEqual(lines, ["a.md", "sub/b.md"]); // sorted, vault-relative-to-folder

    // live: add a file, listing changes
    await fsp.writeFile(path.join(vault, "kb", "c.md"), "C");
    const again = await api("GET", `/api/shares/${r.data.id}/resolve`);
    assert.match(again.data.content, /^c\.md$/m);
  });

  await test("folder share + selection → 400 (a folder has no text span)", async () => {
    const r = await api("POST", "/api/shares", { path: "kb", selection: "x" });
    assert.equal(r.status, 400);
  });

  await test("deleted file / folder → resolve returns 410 gone", async () => {
    const fs1 = await api("POST", "/api/shares", { path: "random-note.md" });
    await fsp.unlink(path.join(vault, "random-note.md"));
    const g1 = await api("GET", `/api/shares/${fs1.data.id}/resolve`);
    assert.equal(g1.status, 410);

    const fs2 = await api("POST", "/api/shares", { path: "kb" });
    await fsp.rm(path.join(vault, "kb"), { recursive: true });
    const g2 = await api("GET", `/api/shares/${fs2.data.id}/resolve`);
    assert.equal(g2.status, 410);
  });

  await test("path validation: absolute path and ../ escape → 400", async () => {
    const r1 = await api("POST", "/api/shares", { path: "../outside.md" });
    assert.equal(r1.status, 400);
    const r2 = await api("POST", "/api/shares", { path: "a/../../b" });
    assert.equal(r2.status, 400);
    const r3 = await api("POST", "/api/shares", { path: "" });
    assert.equal(r3.status, 400);
  });

  await test("POST /api/shares with neither nodeId nor path → 400", async () => {
    const r = await api("POST", "/api/shares", { selection: "x" });
    assert.equal(r.status, 400);
    assert.match(r.error, /nodeId 或 path/);
  });

  // ---- FR-3: listing & filtering -------------------------------------------

  await test("FR-3 list nodes with tag / keyword / type filters", async () => {
    await api("POST", "/api/nodes", {
      type: "snippet",
      title: "frontend deploy checklist",
      content: "build, tag, upload, purge CDN",
      tags: ["deploy"],
    });
    const all = await api("GET", "/api/nodes");
    assert.equal(all.data.length, 4); // payments + dup×2 + frontend
    const byTag = await api("GET", "/api/nodes?tag=payments");
    assert.equal(byTag.data.length, 1);
    assert.equal(byTag.data[0].id, nodeId);
    const byQ = await api("GET", "/api/nodes?q=CDN");
    assert.equal(byQ.data.length, 1);
    const byType = await api("GET", "/api/nodes?type=file");
    assert.equal(byType.data.length, 0);
  });

  // ---- FR-1: file/folder nodes index, never copy ---------------------------

  await test("FR-1 file node indexes a disk path without copying it", async () => {
    const target = path.join(vault, "..", `target-${Date.now()}.txt`);
    await fsp.writeFile(target, "real file on disk", "utf8");
    const r = await api("POST", "/api/nodes", {
      type: "file",
      title: "indexed file",
      path: target,
      boundary: { background: "b", scenarios: "s", caveats: "c" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.path, target);
    // nothing was copied into the vault besides the node note itself
    const nodes = await fsp.readdir(path.join(vault, "agentNote", "nodes"));
    assert.equal(nodes.length, 5);
    assert.ok(nodes.includes("indexed file.md"));
    await fsp.rm(target, { force: true });
  });

  await test("file/folder node requires a path", async () => {
    const r = await api("POST", "/api/nodes", { type: "folder", title: "x" });
    assert.equal(r.status, 400);
  });

  // ---- FR-6: groups ---------------------------------------------------------

  await test("FR-6 many-to-many groups with tree structure", async () => {
    const root = await api("POST", "/api/groups", { name: "work" });
    const child = await api("POST", "/api/groups", { name: "payments", parentId: root.data.id });
    const other = await api("POST", "/api/groups", { name: "infra" });
    const r = await api("PUT", `/api/nodes/${nodeId}/groups`, {
      groupIds: [child.data.id, other.data.id], // one node, two groups
    });
    assert.equal(r.status, 200);
    const data = await api("GET", "/api/groups");
    assert.equal(data.data.groups.length, 3);
    assert.deepEqual(new Set(data.data.membership[nodeId]), new Set([child.data.id, other.data.id]));
    assert.equal(data.data.groups.find((g) => g.id === child.data.id).parentId, root.data.id);
    // deleting a parent removes descendants and membership
    await api("DELETE", `/api/groups/${root.data.id}`);
    const after = await api("GET", "/api/groups");
    assert.equal(after.data.groups.length, 1);
    assert.deepEqual(after.data.membership[nodeId], [other.data.id]);
  });

  // ---- FR-7: snapshots ------------------------------------------------------

  await test("FR-7 file-node snapshot is a read-only copy linked to the version", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-snap-src-"));
    await fsp.writeFile(path.join(dir, "a.txt"), "snapshot me", "utf8");
    const node = await api("POST", "/api/nodes", {
      type: "folder",
      title: "snapshotted folder",
      path: dir,
    });
    const r = await api("POST", `/api/nodes/${node.data.id}/snapshots`, { note: "before refactor" });
    assert.equal(r.status, 201);
    const copied = path.join(vault, r.data.dir, path.basename(dir), "a.txt");
    assert.equal(await fsp.readFile(copied, "utf8"), "snapshot me");
    // original untouched
    assert.equal(await fsp.readFile(path.join(dir, "a.txt"), "utf8"), "snapshot me");
    const list = await api("GET", `/api/nodes/${node.data.id}/snapshots`);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].note, "before refactor");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // ---- FR-8: quality warnings -----------------------------------------------

  await test("FR-8 agent-written node with missing boundary raises warnings", async () => {
    const r = await api("POST", "/api/nodes", {
      type: "snippet",
      title: "half-baked conclusion",
      content: "I think the cache TTL is 60s",
      source: "agent",
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.warnings.length, 1);
    assert.equal(r.data.warnings[0].code, "missing-boundary");
    assert.deepEqual(r.data.warnings[0].missing, ["background", "scenarios", "caveats"]);
    // user-written nodes without boundary don't warn (user is the authority)
    const u = await api("POST", "/api/nodes", { type: "snippet", title: "my own note" });
    assert.deepEqual(u.data.warnings, []);
    // share resolution carries the warning too
    const share = await api("POST", "/api/shares", { nodeId: r.data.id });
    const resolved = await api("GET", `/api/shares/${share.data.id}/resolve`);
    assert.equal(resolved.data.warnings.length, 1);
  });

  // ---- error hygiene ---------------------------------------------------------

  await test("unknown node / share / version → clean 404, invalid JSON → 400", async () => {
    assert.equal((await api("GET", "/api/nodes/n-deadbeef00")).status, 404);
    assert.equal((await api("GET", "/api/shares/s-x-deadbeef/resolve")).status, 404);
    const res = await fetch(`${base}/api/nodes`, { method: "POST", body: "{nope" });
    assert.equal(res.status, 400);
  });

  // ---- skill installer -------------------------------------------------------

  await test("installSkill writes a SKILL.md that teaches agents the live API", async () => {
    const dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-skill-")), "agentnote");
    const result = installSkill(dir, { port, prefs: "Prefer Chinese summaries." });
    assert.equal(result.file, path.join(dir, "SKILL.md"));
    const md = await fsp.readFile(result.file, "utf8");
    // frontmatter: name + trigger description
    assert.match(md, /^---\nname: agentnote\ndescription: .*\n---/);
    // live port baked into the API examples
    assert.ok(md.includes(`http://127.0.0.1:${port}/api/nodes`));
    // share references stay discoverable (实时解析、raw 纯文本)
    assert.ok(md.includes("/api/shares/s-x-"));
    assert.ok(md.includes("?raw=1"));
    // quality red lines + user prefs carried over
    assert.match(md, /boundary/);
    assert.ok(md.includes("Prefer Chinese summaries."));
    // re-install overwrites cleanly (e.g. after a port change)
    installSkill(dir, { port: 29999 });
    const again = await fsp.readFile(result.file, "utf8");
    assert.ok(again.includes("http://127.0.0.1:29999/api/nodes"));
    assert.ok(!again.includes(`http://127.0.0.1:${port}/api/nodes`));
    // default location follows the Claude Code user-level layout
    assert.equal(
      defaultSkillDir(path.join(os.tmpdir(), "fakehome")),
      path.join(os.tmpdir(), "fakehome", ".claude", "skills", "agentnote")
    );
    await fsp.rm(path.dirname(dir), { recursive: true, force: true });
  });

  await test("renderSkillMd works without prefs", async () => {
    const md = renderSkillMd({ port: 27182 });
    assert.ok(md.includes("http://127.0.0.1:27182/api/health"));
    assert.ok(!md.includes("## 用户偏好"));
  });

  await test("detectAgents finds installed agents by their home dirs", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-home-"));
    // registry covers at least the three common agents
    const ids = KNOWN_AGENTS.map((a) => a.id);
    for (const id of ["claude-code", "codex", "workbuddy"]) assert.ok(ids.includes(id), `missing ${id}`);
    // nothing installed → nothing detected
    assert.deepEqual(detectAgents(home), []);
    // pretend claude-code + workbuddy are installed (their marker dirs exist)
    await fsp.mkdir(path.join(home, ".claude"), { recursive: true });
    await fsp.mkdir(path.join(home, ".workbuddy"), { recursive: true });
    const found = detectAgents(home);
    assert.deepEqual(found.map((a) => a.id).sort(), ["claude-code", "workbuddy"]);
    // skill dirs are absolute, point at the right layout, nothing installed yet
    const claude = found.find((a) => a.id === "claude-code");
    assert.equal(claude.skillDir, path.join(home, ".claude", "skills", "agentnote"));
    assert.equal(claude.alreadyInstalled, false);
    // installing flips the alreadyInstalled flag on the next detection
    installSkill(claude.skillDir, { port });
    assert.equal(detectAgents(home).find((a) => a.id === "claude-code").alreadyInstalled, true);
    await fsp.rm(home, { recursive: true, force: true });
  });

  // ---- legacy layout migration ----------------------------------------------
  await test("init migrates legacy layout: id-named files → title names, versions/ moved aside", async () => {
    const legacy = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-legacy-"));
    const nodesDir = path.join(legacy, "agentNote", "nodes");
    await fsp.mkdir(nodesDir, { recursive: true });
    await fsp.mkdir(path.join(legacy, "agentNote", "versions", "n-aaaaaaaaaaaa"), { recursive: true });
    await fsp.writeFile(
      path.join(nodesDir, "n-aaaaaaaaaaaa.md"),
      [
        "---",
        "agentnote: true",
        "id: n-aaaaaaaaaaaa",
        "type: snippet",
        "title: 旧布局节点",
        "tags: []",
        "source: agent",
        "version: 7",
        "created: '2026-07-01T00:00:00.000Z'",
        "updated: '2026-07-02T00:00:00.000Z'",
        "boundary:",
        "  background: b",
        "  scenarios: s",
        "  caveats: c",
        "---",
        "",
        "old content",
        "",
      ].join("\n"),
      "utf8"
    );
    const s2 = new VaultStore(legacy);
    const info = await s2.init();
    assert.equal(info.migratedNodes, 1);
    assert.equal(info.legacyVersionsBackup, "agentNote/versions.legacy-backup");
    // renamed + version key stripped
    const files = await fsp.readdir(nodesDir);
    assert.deepEqual(files, ["旧布局节点.md"]);
    const raw = await fsp.readFile(path.join(nodesDir, files[0]), "utf8");
    assert.equal(/^version:/m.test(raw), false);
    assert.match(raw, /old content/);
    // old versions dir moved, not deleted
    assert.ok(fs.existsSync(path.join(legacy, "agentNote", "versions.legacy-backup", "n-aaaaaaaaaaaa")));
    assert.ok(!fs.existsSync(path.join(legacy, "agentNote", "versions")));
    // node fully usable under the new engine
    const node = await s2.getNode("n-aaaaaaaaaaaa");
    assert.equal(node.title, "旧布局节点");
    assert.equal(node.created, "2026-07-01T00:00:00.000Z");
    await fsp.rm(legacy, { recursive: true, force: true });
  });

  // ---- teardown --------------------------------------------------------------

  await server.stop();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`\nFAILED: ${f.name}\n${f.error.stack}`);
    process.exit(1);
  }
  await fsp.rm(vault, { recursive: true, force: true });
  console.log("all green ✔");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
