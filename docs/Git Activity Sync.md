# Git Activity Sync Across Devices

> 中文主文档：[Git 活动记录同步](Git活动记录同步.md)

Activity logs are stored per device, and new share records are stored per link. Notes, document indexes, and references still require normal synchronization. The plugin does not automatically merge the whole vault.

## Per-device logs

Each device appends to its own JSON array at `agentNote/data/events.<deviceId>.json`. Its events have random `eventId` values and the local `deviceId`. Statistics read all `events.*.json` files and deduplicate matching event IDs. Independent actions remain separate events.

The device ID is stored in the local user's home directory at `.agentnote/device-id`, not in the vault. Do not copy this file to another device. After a restart, the same installation retains its ID.

The legacy `agentNote/data/events.json` remains read-only history. The plugin neither moves nor deletes it; old events receive deterministic IDs in memory when read.

Writes to a device log run in order and replace the file via a temporary file. A damaged local log is not silently reset; a damaged log also causes statistics to report an error rather than hide history.

## Git boundaries

Settings offer a delayed automatic cold backup and a manual **Back up now** action. They save past local-calendar days from the local device log and legacy `events.json` as separate, immutable files under `agentNote/data/cold-backups/`. The plugin does not use these files for statistics. Each device backs up its own activity. Note contents and shared configuration are outside this backup, and late events cannot be inserted into an existing snapshot.

A device-log snapshot is named `events.<deviceId>.<YYYY-MM-DD>.json`; a legacy-log snapshot is named `events.legacy.<deviceId>.<YYYY-MM-DD>.json`. The middle ID identifies the computer that created it. Each computer backs up its own new log; copies of the shared legacy log may exist under multiple device IDs. Recovery needs event-ID deduplication, and legacy records without IDs need a content and source check.

The plugin skips an existing snapshot rather than regenerating or overwriting it, and it leaves the source log untouched. This protects against plugin rewrites, not manual edits, Git changes, or storage failure. Keep Git history or another independent backup for verification and recovery.

Keep `events.*.json` and any existing `events.json` when syncing a vault. Different devices write different log paths, reducing conflicts between activity logs. Update the plugin on every syncing device; older versions may still write to the shared legacy log.

New links are stored in `agentNote/data/shares/<share ID>.json` instead of repeatedly rewriting `shares.json`. The existing `shares.json` remains read-only history; legacy links still work. Updating a legacy link or moving its target creates a separate record for that link without changing the old file. Keep the entire `shares/` directory and any existing `shares.json` when syncing. Concurrent edits to the same link can still conflict.

If the legacy `shares.json` is damaged, its original bytes remain untouched while new and independent shares continue to work. Legacy-only links report an error until that file is repaired. A damaged per-link file affects only that link. Share listings omit damaged records and log the error; an omitted record is not necessarily deleted.

Conflicts in Markdown, `documents.json`, `references.json`, `agents.json`, and `idempotency.json` are not automatically merged. If a shared JSON file is unreadable or invalid, dependent operations report an error rather than replacing old data with empty values. Inspect and resolve conflicts; do not delete the original file to dismiss the error.

Git pulls may still trigger Obsidian file activity. Event-ID deduplication only merges the same recorded event; it cannot infer that two independently observed file changes were a single action. Avoid concurrent writes to the same vault from multiple processes on one device, and pause vault activity during synchronization where practical.

## Verification

`npm test` covers identity persistence, merged logs, legacy history, deduplication, serialized appends, and corrupt-log protection. `npm run test:git-sync` uses a temporary Git repository to merge activity and independent share records from two devices and verifies both links. Git must be installed locally.
