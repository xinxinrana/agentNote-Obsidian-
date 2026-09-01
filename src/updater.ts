/**
 * Self-update from GitHub Releases.
 *
 * The release carries the built artifacts (main.js / manifest.json /
 * styles.css); updating means downloading them into the plugin folder and
 * reloading the plugin. Network goes through Obsidian's requestUrl.
 */
import * as fsp from "fs/promises";
import * as path from "path";
import { requestUrl } from "obsidian";

export const UPDATE_REPO = "xinxinrana/agentNote-Obsidian-";
export const RELEASE_FILES = ["main.js", "manifest.json", "styles.css"];
const HEADERS = { "User-Agent": "agentnote-obsidian", Accept: "application/vnd.github+json" };

export interface ReleaseInfo {
  version: string;
  url: string;
  /** asset name -> download url */
  assets: Record<string, string>;
}

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const response = await requestUrl({ url: `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, headers: HEADERS });
  const data = response.json as { html_url?: string; tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  const assets: Record<string, string> = {};
  for (const asset of data.assets ?? []) assets[asset.name] = asset.browser_download_url;
  if (!assets["manifest.json"]) throw new Error("最新 Release 中没有 manifest.json 构建产物，无法更新。");
  const manifest = (await requestUrl({ url: assets["manifest.json"], headers: HEADERS })).json as { version?: string };
  const version = manifest.version ?? (data.tag_name ?? "").replace(/^v/i, "");
  if (!version) throw new Error("无法确定最新版本号。");
  return { version, url: data.html_url ?? `https://github.com/${UPDATE_REPO}/releases/latest`, assets };
}

export async function installRelease(dir: string, release: ReleaseInfo): Promise<void> {
  for (const file of RELEASE_FILES) {
    const url = release.assets[file];
    if (!url) throw new Error(`最新 Release 缺少 ${file}，请先发布带构建产物的 Release。`);
    const buffer = (await requestUrl({ url, headers: HEADERS })).arrayBuffer;
    await fsp.writeFile(path.join(dir, file), Buffer.from(buffer));
  }
}
