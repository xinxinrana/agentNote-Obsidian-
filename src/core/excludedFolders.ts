import { t } from "../i18n";

export function parseExcludedFolders(value: string): string[] {
  const result = new Set<string>();
  for (const part of value.split(/[\n,;，；]+/)) {
    const folder = part.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!part.trim()) continue;
    if (!folder) throw new Error(t("排除目录必须是仓库内的相对路径"));
    if (folder.startsWith("/") || /^[a-z]:/i.test(folder) || folder.split("/").some(p => p === ".." || p === ".")) throw new Error(t("排除目录必须是仓库内的相对路径"));
    result.add(folder);
  }
  return [...result];
}
export function isExcludedFolder(filePath: string, folders: readonly string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return folders.some(folder => normalized === folder || normalized.startsWith(folder + "/"));
}
