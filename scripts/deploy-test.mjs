import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);

async function deploy() {
  if (args.includes("--help")) {
    console.log("Usage: npm run deploy:test -- [vault-path] [--config-dir <directory>] [--dry-run]\nAlternatively, set AGENTNOTE_TEST_VAULT in the environment or .env.local. Default config directory: .obsidian");
    return;
  }

  try { loadEnvFile(path.join(projectRoot, ".env.local")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let vaultPath = process.env.AGENTNOTE_TEST_VAULT;
  let configDir = ".obsidian";
  let positionalPath = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--config-dir") {
      configDir = args[++i];
      if (!configDir || configDir.startsWith("--")) throw new Error("--config-dir requires a directory.");
    } else if (!args[i].startsWith("--") && !positionalPath) {
      vaultPath = args[i];
      positionalPath = true;
    } else {
      throw new Error(`Unexpected argument: ${args[i]}`);
    }
  }
  if (!vaultPath?.trim()) throw new Error("Provide a vault path: npm run deploy:test -- <vault-path>, or set AGENTNOTE_TEST_VAULT.");
  const vaultRoot = path.resolve(vaultPath);
  if (!(await fs.stat(vaultRoot)).isDirectory()) throw new Error("Vault path must be an existing directory.");
  const configPath = path.resolve(vaultRoot, configDir);
  const relativeConfig = path.relative(vaultRoot, configPath);
  if (!relativeConfig || relativeConfig === ".." || relativeConfig.startsWith(`..${path.sep}`) || path.isAbsolute(relativeConfig)) {
    throw new Error("Config directory must be inside the vault.");
  }

  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, "manifest.json"), "utf8"));
  const pluginPath = path.join(configPath, "plugins", manifest.id);
  const artifacts = ["main.js", "manifest.json", "styles.css"];
  // Read every artifact before changing the destination, so missing builds fail early.
  const contents = await Promise.all(artifacts.map((name) => fs.readFile(path.join(projectRoot, name))));
  if (dryRun) {
    console.log(`Deployment target: ${pluginPath}\nArtifacts: ${artifacts.join(", ")}\nDry run: no files written.`);
    return;
  }
  await fs.mkdir(pluginPath, { recursive: true });
  for (let i = 0; i < artifacts.length; i++) {
    await fs.writeFile(path.join(pluginPath, artifacts[i]), contents[i]);
  }
  console.log(`agentNote installed to: ${pluginPath}\nReload the plugin in Obsidian to use the new build.`);
}

deploy().catch((error) => {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
});
