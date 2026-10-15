# Availability and History Under Git Sync

> 中文主文档：[Git 同步下的可用性与历史改造方案](Git同步可靠性改造方案.md) · [Data Files and Sync Boundaries](Data%20Files%20and%20Sync%20Boundaries.md)

## Goals and Boundaries

In order: **keep the plugin and its read/share/write service working; keep existing history viewable; keep contributions and archive suggestions available where possible**. One damaged index or log must not disable the first two. agentNote does not resolve conflicts in user Markdown or take over Git synchronization.

Viewable history includes honest completeness reporting. If a source cannot be read, show the other records and identify the affected file; never present a partial total as complete. Preserve the original bytes before repair. Do not automatically delete, reset, or overwrite history.

## Data Boundaries

| Type | Role during sync | Write rule |
| --- | --- | --- |
| Markdown, agentNote notes, and share definitions | Sources of content and link truth | Keep existing files and APIs; concurrent edits to one content file are outside this plan. |
| New activity records | Syncable operation facts and the source of timeline/statistics | Write one uniquely named file per operation; never change it after publication; deduplicate by `eventId`. |
| `events.json`, `events.<deviceId>.json` | Existing history | Read-only in the new version; never migrate in place, delete, or rewrite. Clearly warn about mixed old/new versions. |
| `documents.json` | Compatibility source for old IDs and protection state | Preserve it, but remove it from required service/history paths and stop writing new operations into it. |
| `references.json` | Legacy link-comparison baseline | Preserve it; move comparison state to local data and continue resolving current links from notes/Obsidian. |
| Dashboard indexes and statistics caches | Derived views for display speed | Rebuildable local data, not common Git write targets. |

Activity records do not duplicate note bodies. They contain operation type, time, unique ID, device, title/path snapshots, available note/share IDs, and Agent identity. A move also records the old path. Protection changes record explicit user choices but need not increase activity scores. History renders from event snapshots first, without requiring the document index or share list.

## Implementation Order

### 1. Decouple Service and History from Indexes

- `src/core/server.ts`: If `agents.json` cannot be read, retain and report the error, but use the identity supplied by the request rather than failing before every content route. A registration or keyed create that cannot be checked safely fails on that operation alone, not on unrelated requests.
- `src/core/store.ts`: Record local create/edit/read/move/delete activity from event paths and titles without requiring `documents.json`. Successful note and share operations must not depend on contribution indexes or activity writes; if history writing fails, report it explicitly rather than claiming the event was recorded.
- `src/core/store.ts`: Separate activity summaries from document contributions and archive calculations. Timeline, recent activity, daily activity, and Agent activity depend on logs alone. A broken old document index degrades only document/archival sections, with a visible explanation.
- `src/ui/panel.ts`: Handle connection-panel and profile-modal failures independently. Keep timeline and activity overview accessible when an index fails. Diagnostics identify the file and allow retry after repair.

### 2. Use Immutable Activity Records

- `src/core/activityLog.ts`: Write new events to `agentNote/data/events/<year-month>/<eventId>.json`. Generate a random ID, write a temporary file, and atomically publish only if the target does not exist. Never overwrite an existing event. Keep both older array formats read-only.
- Return events with a list of source problems. For conflict markers, invalid JSON, or invalid structure, omit **only that source from display**, preserve its bytes, and report it. Identical content with one `eventId` appears once; differing content with the same ID is reported, not silently resolved.
- Label totals complete only when every source is readable. Otherwise display known records/partial results. Partition files by month and use a rebuildable local index so opening the profile does not parse every event on every occasion.
- Extend cold backups to new records. Backups preserve data but do not contribute to normal statistics or automatically overwrite sources.

### 3. Retire Shared Mutable Indexes

- `src/core/store.ts`: Keep `documents.json` read-only for old IDs/protection. Derive new document views from vault files and operations; retain old `documentId` associations and fall back to event title/path snapshots when an index is missing. Reading is not a document update. Derive `updated` from meaningful maintenance activity, not from rewriting a shared array.
- Record protection/unprotection as immutable choices; honor valid legacy protection. Preserve and surface irreconcilable opposite actions on one document in the auxiliary UI without blocking service or history.
- Stop writing shared `references.json`. Initialize the local link-comparison baseline without creating fake link-addition events; do not write unchanged state or claim that an uncertain Git-synced change was a local user action.
- Remove global-object contention from `agents.json` and `idempotency.json`: isolate Agent registration by Agent and keyed-create state by request key. Do not claim global exactly-once behavior for an unverified damaged key or offline cross-device reuse.
- Keep existing `shares/<share ID>.json` links and URLs. Surface concurrent edits to one link separately without disrupting new links.

### 4. Compatibility, Recovery, and Release Gate

- Do not rewrite or delete old document/reference indexes, log arrays, or share records. Do not recreate an empty file merely because it is temporarily missing during sync. Save exact original bytes before repair; automate only provably unambiguous results.
- New versions read old and new history. Old versions do not know the new format, so a downgrade may temporarily hide newer history; upgrading again restores it because the files remain. All devices syncing one vault should update; mixed versions cannot promise conflict-free plugin data.
- Verify with temporary Git repositories and a separate test vault first. Deploy locally only to the “测试” vault. Discuss commit, push, and release after hands-on confirmation.

## Regression and Acceptance

| Scenario | Required result |
| --- | --- |
| A reads/shares offline; B creates/updates offline; then Git merges both | New activity files do not contend for one path; both histories appear once; shares still work. |
| Two copies of a vault on one computer record activity | A shared device ID does not cause new records to write the same path. |
| `documents.json` is damaged or contains conflict markers | Service, sharing, writing, and the existing timeline work; only related auxiliary sections degrade; original bytes are unchanged. |
| `references.json` or `agents.json` is damaged | Unrelated content APIs and history work; identity/reference functions show the specific issue. |
| One legacy log or new event file is damaged | Other records remain visible; totals are marked partial; bad bytes remain untouched. |
| An activity write fails | The content operation reports its real outcome and clearly states that this activity was not recorded; no successful history is fabricated. |
| Git sync triggers file notifications | A remote operation already recorded elsewhere is not counted again as a definite local operation; uncertain provenance is not invented. |
| Old history, protection, share URLs, and repairable conflicts | They remain readable after upgrade; ambiguous state is neither merged nor deleted automatically. |
| Large history and repeated profile opens | Service startup does not wait for full aggregation; deleting the local index and rebuilding it yields the same results as a direct read. |

Acceptance uses disposable files, two vault copies, and real Git branch merges—not destructive experiments on the user's actual vault. Archive recommendation accuracy is verified after service availability, history completeness, and preservation pass.
