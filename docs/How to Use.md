# How to Use agentNote

agentNote has one simple loop: **start the local service → connect an agent → share a local item → continue the work in natural language**. This guide gets you through the first loop in about three minutes.

> Looking for Chinese instructions? Read [功能与使用](功能与使用.md).
>
> 中文快速上手：[如何使用 agentNote](如何使用.md)

## Before you start

- Use Obsidian Desktop. agentNote needs the local filesystem and a local HTTP service.
- Keep Obsidian open while an agent reads or writes through agentNote.
- Start with one agent and one file. You do not need to reorganize your vault first.

## Your first workflow

### 1. Open the connection panel and check the service

Open **agentNote connection panel** from the ribbon icon or the command palette. In **Local service**, confirm the green status light and `Service is running`.

If it is not running, select **Start service**. The service stays on your computer at `127.0.0.1`; it does not publish your vault to the internet.

<p align="center">
  <img src="img/how-to/01-local-service.png" alt="agentNote local service running with a green status light" width="520">
  <br>
  <sub>Step 1 — the green light confirms that a connected agent can reach the local service.</sub>
</p>

### 2. Connect one agent

In **Connect an agent**, find Claude Code, Codex, or WorkBuddy and select **Connect agentNote**. Restart that agent once so it can load the installed skill.

If your agent is not listed, choose **Connect any agent manually**, copy the generated task, and send it to that agent. The task tells it how to install and verify its own long-term instruction.

<p align="center">
  <img src="img/how-to/02-connect-agent.png" alt="agentNote panel showing Claude Code, Codex, and WorkBuddy connected" width="520">
  <br>
  <sub>Step 2 — a connected state means the agent has agentNote instructions in its long-term skill directory.</sub>
</p>

### 3. Share one file, folder, or text selection

Use the smallest useful piece of context:

| What you want to share | In Obsidian |
| --- | --- |
| A file or folder | Right-click it and choose **agentNote: Share with agent**. |
| Part of a note | Select the text, then run **agentNote: Share selected content**. |

agentNote copies a local URL to your clipboard. Paste the complete URL into the conversation with your agent.

<p align="center">
  <img src="img/how-to/03-share-from-obsidian.png" alt="Obsidian file context menu with agentNote Share with agent highlighted" width="780">
  <br>
  <sub>Step 3 — share directly from the file context menu without moving or uploading the original file.</sub>
</p>

### 4. Give the agent one clear instruction

Start with either of these prompts:

```text
Read this material, summarize the decisions, and tell me what still needs attention:
<paste the agentNote link>
```

```text
Please save the conclusions from this conversation to my Obsidian notes.
Give the note a concise title and include why it matters.
```

An agentNote link is live: when the original file changes, the same link resolves to the latest content. When the agent writes a note, it returns a permanent link that it can use for later updates.

<p align="center">
  <img src="img/how-to/04-send-link-to-agent.png" alt="WorkBuddy conversation with an agentNote local share link ready to send" width="780">
  <br>
  <sub>Step 4 — paste the local link, then say exactly what you want the agent to do with the material.</sub>
</p>

## What to do next

Once the first workflow works, use agentNote for these repeatable jobs:

- Share a project folder before asking an agent to plan or review work.
- Share a selected paragraph when only one decision needs discussion.
- Say “write this to Obsidian” after a meeting, research task, or planning session.
- Open **View full insights** to see what was created, shared, updated, and reused.

<p align="center">
  <img src="img/how-to/05-review-knowledge-profile.png" alt="agentNote knowledge profile showing contribution history and high-value notes" width="800">
  <br>
  <sub>Use the knowledge profile to review useful material after you have started sharing and writing.</sub>
</p>

## If something does not work

| Situation | What to check |
| --- | --- |
| The agent cannot open a link | Keep Obsidian open and confirm the local service is running. |
| The agent does not know how to write notes | Connect or update the agent, then restart it once. |
| The agent is not listed | Use **Connect any agent manually**. |
| You shared too much context | Share a text selection instead of the full file or folder. |
| You want to keep a note out of cleanup suggestions | Select **Protect from archiving**. This never changes the note or its share link. |

## Privacy in one sentence

agentNote runs locally: there is no account, cloud sync, telemetry service, or public sharing endpoint. You choose each item that an agent can read.
