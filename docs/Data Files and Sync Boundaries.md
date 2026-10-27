# Data Files and Multi-Device Sync Boundaries

> 中文主文档：[数据文件与多设备同步边界](数据文件与同步边界.md)

agentNote does not sync your vault; your Git configuration determines which files are tracked. Markdown remains the source of note content. Keep the complete `agentNote/` directory when syncing, and do not delete damaged files merely to dismiss an error.

## Data Inside the Vault

Paths below are relative to the vault root.

| File | Purpose and write boundary |
| --- | --- |
| `agentNote/nodes/*.md` | agentNote note content and metadata. Concurrent edits to one note remain the responsibility of your Obsidian/Git workflow. |
| `agentNote/data/shares/<share ID>.json` | One definition per link. Creating different links does not rewrite one shared file; concurrent edits to one link or moves of its target can still conflict. Other sound links remain available. |
| `agentNote/data/shares.json` | Read-only compatibility source for legacy links. |
| `agentNote/data/events/<year-month>/<event ID>.json` | One immutable file per activity, with time, device, operation, title/path snapshot, and available note, document, share, and Agent IDs. Reads deduplicate by event ID. A damaged record does not hide other sources; the dashboard marks statistics as incomplete. |
| `agentNote/data/events.json`, `events.<device ID>.json` | Read-only legacy activity arrays. They are neither migrated in place nor rewritten. If one source is damaged, its bytes remain intact and other sources remain visible. Older plugin versions may still rewrite these files, so devices syncing one vault should upgrade together. |
| `agentNote/data/documents.json` | Read-only legacy document IDs, paths, and protection state. New operations derive document views from events and vault files. Reading does not update document timestamps; protection changes become independent activity records. If the old file is damaged, content service and timeline continue, archive suggestions stop, and related statistics are marked incomplete. |
| `agentNote/data/references.json` | Read-only legacy link-comparison baseline. Current links still come from notes and Obsidian's index; the active local baseline is not a shared Git write target. |
| `agentNote/data/agents.json` | Read-only legacy Agent identities. Damage falls back to the identity reported by the request instead of blocking content routes. |
| `agentNote/data/agents/<ID hash>.json` | Independent registration per Agent. Different Agents do not contend for one file; conflicting offline names for the same ID remain possible. |
| `agentNote/data/idempotency.json` | Read-only legacy keyed-create index. Damage affects only creates that require an idempotency decision, not ordinary creation or other services. |
| `agentNote/data/idempotency/<key hash>.json` | One note ID association per idempotency key. Different keys do not contend; using the same key offline on two devices cannot guarantee global exactly-once creation. |

## Local State and Backups

| File | Purpose and boundary |
| --- | --- |
| `.agentnote/device-id` in the user's home directory | Local writer identity, not synced with the vault. Sharing a device ID does not make new activities write the same file. |
| `.agentnote/references.<vaultHash>.json` in the user's home directory | Local link-comparison baseline per vault path. First observation establishes the baseline without counting new links; unchanged observations do not write. A standalone Git-synced link change cannot always be distinguished from a local edit. |
| `.agentnote/connections.json` in the user's home directory | Locally connected Agents and Skill paths, one file per machine instead of per vault path; absolute paths are generally not useful on another device. Legacy `.agentnote/connections.<vaultHash>.json` files are merged on first read and left in place. |
| `agentNote/data/cold-backups/` | Write-once backups of activity older than today. They do not contribute to live statistics and are not a full vault backup. |
| `agentNote/data/repair-backups/*.bak` | Exact original bytes saved before an automatic repair; excluded from live statistics. |
| `data.json` in the Obsidian plugin directory | Language, port, startup, and other preferences. The actual plugin directory follows the vault's `configDir`. |

## Failure and Sync Boundaries

1. Keep the plugin and sound content available for reading, sharing, and writing first. If activity storage fails, do not fabricate history; show that the activity was not recorded.
2. Preserve data next. Do not create empty legacy indexes merely because optional files are absent. Save exact bytes before an unambiguous repair; leave uncertain outcomes for the user.
3. Keep readable history visible. If a legacy log or one new event is damaged, totals are **partial results**, not complete totals, and the dashboard identifies the source.
4. Archive suggestions require complete history and document state, and stop when those sources are incomplete. Opposing document operations, concurrent edits to one share, offline reuse of one idempotency key, and Markdown content conflicts cannot be eliminated merely by splitting files.

Obsidian file notifications do not identify whether a change came from a user or Git sync. The plugin does not claim to infer that origin reliably from notifications alone; a Git pull can still produce an additional observed local activity.

**Check and repair** inspects existing legacy document/reference indexes, old logs, and new event files. It automatically repairs only document-index conflicts with an unambiguous result; it does not clear damaged files.
