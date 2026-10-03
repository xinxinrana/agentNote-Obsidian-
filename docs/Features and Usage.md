# agentNote Features and Usage

> 中文主文档：[功能与使用](功能与使用.md)

## The one idea to understand first

agentNote is not another cloud note app and does not take ownership of your files. While Obsidian is open, it starts a local service that gives selected vault content a live address an agent can read.

Instead of repeatedly copying paths, uploading files, pasting content, and explaining context, share the right local material with an agent once and continue from there.

## Three-minute start

1. Open the **agentNote connection panel** and confirm the green local-service light.
2. Connect one installed agent and restart it once.
3. Right-click a file, select **agentNote: Share with agent**, paste the copied address into a conversation, and state the desired task.

For the illustrated walkthrough, read [How to Use agentNote](How%20to%20Use.md).

## 1. Share local content

### Share a file or folder

Right-click the item in Obsidian's file explorer and select **agentNote: Share with agent**. The address is copied automatically.

| Target | What the agent receives |
| --- | --- |
| File | Local file address, background, and current content |
| Folder | Local folder address, background, and first-level entries |

Folders do not expand recursively, so unrelated material is not handed over accidentally.

### Share selected text

Select text in the editor, then run **agentNote: Share selected content** from the command palette or editor context menu. The link is copied automatically.

### Use a shared address

Send the full address to an agent:

```text
Please read this material and summarize it:
http://127.0.0.1:27182/api/shares/s-xxxx/resolve
```

The address is live: changes to the original file appear on the same link. Agents read through the link first, then update the shared content through the share API.

## 2. Let an agent write notes

After connecting an agent, use natural language:

- “Write this to Obsidian.”
- “Save this to my agent notes.”
- “Remember this in my notes.”

You can add a desired title, tags, or background. The agent writes a normal note to the vault and receives a permanent link. Later, “update the note we just made” updates the same note instead of creating a duplicate.

## 3. Connect an agent

Open the **agentNote connection panel** in the Obsidian sidebar.

### Connection flow

Claude Code, Codex, and WorkBuddy always appear. Select **接入其他 Agent** for another tool. Every entry copies the same task: the agent downloads the local `SKILL.md`, configures its fixed identity, and reports the actual installation path. Once reported, the card shows a green **已接入** button. You can then share a link or ask the agent to write a note naturally.

Select **已接入** to preview the full installed Skill. The additional-instructions box below changes only that agent's local file, and saving immediately updates the preview. You can also select **直接编辑全文** and accept the existing warning before editing the full document. The agent may need a new conversation to load changes.

**删除** backs up and moves agentNote's `SKILL.md` out of the active Skill location. The dashboard retains earlier collaboration activity.

### Feedback

Select **Author Evan · Feedback** at the bottom of the connection panel. Complete the structured form in agentNote; it copies the report and opens a pre-filled GitHub Issue in the system default browser. GitHub authentication is handled by that browser account.

## 4. Archive and protect notes

The Cleanup tab considers both agentNote notes and vault documents with recorded activity. Material that has never been read, referenced, or accessed through a share link may be suggested after seven quiet days; previously used material has at least 30 days, or 90 days if reused across weeks. New reading, editing, linking, or share access restarts the quiet period. Suggestions never move files automatically. You can protect a document, archive it individually, or undo a recent archive. Regular vault documents move to `agentNote/归档文件/`, while their existing share links remain usable.

Archiving moves a note into the vault's archive folder. It is not deletion: the note and any existing share link remain usable.

**Protect from archiving** keeps a note out of archive suggestions. It does not modify the note or its links.

## 5. Knowledge profile and sharing

Select **View full insights** in the connection panel to review local activity. The profile includes recent work, weekly rhythm, all-time contributions, agent activity, a timeline, and cleanup suggestions. All data stays in the vault.

In **Recent activity**, click a row with a source file to open it in Obsidian. The row gains a subtle theme-colored hover state. Deletion events and folder records have no open action; if the original file is missing, the plugin shows a notice.

### Knowledge contribution records

agentNote records local actions that put knowledge to work: user-created files, completed edit sessions, reading for more than 20 seconds, agent use, adding a new note link, moving, renaming, archiving, and deleting. Existing genuine collaboration records remain available; the plugin starts listening only after initialization, so it does not treat pre-existing files as newly created. It does not rate people or upload activity. A day's knowledge activity value is simply the combined value of those actions.

When more than three local actions of the same kind, or more than ten local actions of any kind, occur within one second, the plugin asks whether to count the batch. Ignoring a batch still updates document records and moved share targets. The choice can be remembered or set in agentNote settings.

Each document has a reviewable contribution breakdown: construction, reuse, connection, and organization. Deletion records remain in the local ledger, while the timeline displays only the most recent 30 days so recent cleanup remains visible without making the history endless.

Local creation, editing, reading, and organization reflect the user's own work first; share access and agent updates also contribute to each document. Select **View activity records** on a document card to see the dated events and their contribution values.

Material titles appear as text links in the knowledge profile. Click one to open its original file in a new Obsidian tab and close the insights window. In **Privacy view**, titles are anonymized and the open-file action is hidden.

Each successful share-link request counts as one use. If the request has no agent identity, the timeline shows an unidentified visitor rather than a local action. Local reading is recorded only after a file remains open in Obsidian for more than 20 seconds. Existing records are preserved.

- **Profile**: a seven-day overview and reusable-note ranking.
- **This week**: daily knowledge activity, reused material, and a document ranking that includes local work.
- **All time**: totals and note rankings retain the full history. The contribution grid shows a rolling 40 weeks, opens at the latest dates, and keeps breathing room on the right; deeper color represents more knowledge work that day.
- **Agent and timeline**: filter local and agent activity by construction, reuse, connection, and organization.
- **Cleanup**: low-use notes that may be archived; protected notes never appear here.

Use **Generate sharing image** in the profile to preview and copy a PNG summary. Enable **Privacy view** first to anonymize note titles.

## 6. Service status and troubleshooting

| Situation | What to do |
| --- | --- |
| An agent cannot open a link | Keep Obsidian open and start the local service. |
| An agent does not understand writing requests | Confirm it is connected, then restart it. |
| The port is occupied | Change the port in agentNote settings and update the agent connection. |
| You need to share with another device or person | agentNote is local-only and is not a public or cross-device sharing service. |
| Data fails to load after a Git sync | Inspect the affected JSON file in `agentNote/data/` for conflicts or corruption; resolve it before retrying instead of overwriting existing data with an empty file. |

## 7. Updates and boundaries

Check the installed version and select **Check for updates** in Obsidian's agentNote settings. Updates download `main.js`, `manifest.json`, and `styles.css` from GitHub Releases and reload the plugin.

agentNote does not upload content, provide cloud accounts or synchronization, or replace Obsidian's editing, file management, backup, or Git workflows. Your original content always remains in your vault.

### Activity-log cold backups

In agentNote settings, keep automatic backups on, choose a 1–60 minute startup delay, or select **Back up now**. Automatic backup is enabled by default and starts three minutes after startup. It processes eligible days in sequence without delaying plugin startup.

Cold backups copy past-day activity from this device's log and the legacy `events.json` into one JSON file per source and local calendar day in `agentNote/data/cold-backups/`. The plugin never reads these copies for statistics and never overwrites an existing copy or the source log. Each device should run its own backups.

This is not a full-vault backup. It does not cover note contents, shared configuration, or other devices' unsynced logs. A late event for an already backed-up day does not change the immutable snapshot. Resolve Git conflicts without deleting the original data. See [Git Activity Sync](Git%20Activity%20Sync.md).
