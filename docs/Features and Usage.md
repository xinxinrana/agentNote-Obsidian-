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

### Recognized agents

When Claude Code, Codex, or WorkBuddy is detected:

1. Select **Connect agentNote**.
2. agentNote writes its long-term usage instructions to that agent's skill directory.
3. Restart the agent once.
4. Share a link or ask it to write a note naturally.

Use **Manage prompt** to review the complete installed prompt. Select **Unlock editing**, acknowledge the risk, then make changes in the same editor. Saving and updating the installation locks the prompt again. Existing agent-specific instructions remain part of the complete prompt. Changes may require restarting the agent or opening a new conversation. **Remove connection** removes only agentNote's skill. No other skills, settings, conversations, or files are deleted.

### Any other agent

Select **Connect any agent manually**, copy the generated task, and send it to the target agent. It is instructed to find its own persistent instruction mechanism, install agentNote, and verify the local service.

### Feedback

Select **Author Evan · Feedback** at the bottom of the connection panel. Complete the structured form in agentNote; it copies the report and opens a pre-filled GitHub Issue in the system default browser. GitHub authentication is handled by that browser account.

## 4. Archive and protect notes

Archiving moves a note into the vault's archive folder. It is not deletion: the note and any existing share link remain usable.

**Protect from archiving** keeps a note out of archive suggestions. It does not modify the note or its links.

## 5. Knowledge profile and sharing

Select **View full insights** in the connection panel to review local activity. The profile includes recent work, weekly rhythm, all-time contributions, agent activity, a timeline, and cleanup suggestions. All data stays in the vault.

- **Profile**: a seven-day overview and reusable-note ranking.
- **This week**: daily knowledge activity and the most reused material.
- **All time**: contribution history from the first record onward.
- **Agent and timeline**: local reads, writes, updates, sharing, and attribution.
- **Cleanup**: low-use notes that may be archived; protected notes never appear here.

Use **Generate sharing image** in the profile to preview and copy a PNG summary. Enable **Privacy view** first to anonymize note titles.

## 6. Service status and troubleshooting

| Situation | What to do |
| --- | --- |
| An agent cannot open a link | Keep Obsidian open and start the local service. |
| An agent does not understand writing requests | Confirm it is connected, then restart it. |
| The port is occupied | Change the port in agentNote settings and update the agent connection. |
| You need to share with another device or person | agentNote is local-only and is not a public or cross-device sharing service. |

## 7. Updates and boundaries

Check the installed version and select **Check for updates** in Obsidian's agentNote settings. Updates download `main.js`, `manifest.json`, and `styles.css` from GitHub Releases and reload the plugin.

agentNote does not upload content, provide cloud accounts or synchronization, or replace Obsidian's editing, file management, backup, or Git workflows. Your original content always remains in your vault.
