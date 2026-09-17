# agentNote Product Design

> 中文主文档：[核心产品设计](product-design.md)

## Positioning

agentNote is a local knowledge relay for Obsidian. It lets users direct a selected piece of their local second brain, with its background and boundaries, to the right agent across sessions and over time.

It is neither another note system nor a way for AI to search an entire vault indiscriminately. A user chooses a note, file, folder, or selection; agentNote turns it into a live local HTTP address. Agent output can then return to the same local working memory.

## Product principles

### Sharing is the product core

Local content becomes a live address. The agent reads current content at that address; users do not migrate ownership of their files to agentNote. Obsidian and the vault remain the source of truth.

### Agents should be easy to use

Users should not need to learn APIs, manage paths, or repeat mechanical steps. Once connected, an agent understands requests such as “write this to Obsidian” and handles the local write itself.

### A second brain is working memory, not a warehouse

The goal is not to expose the entire vault to AI. The user supplies the small, relevant body of knowledge for the present task, including enough background for the agent to understand it.

### Knowledge belongs to the user

Conversations end and models change. Valuable knowledge should return to the user's vault, where it stays editable, movable, backup-friendly, and available to future agents.

### Correct context matters more than more context

Giving an agent an entire vault makes drafts and unrelated material compete for attention. Sharing a file, folder, or selected passage states the intended knowledge boundary for the task.

### The user directs; the agent understands and executes

agentNote removes repetitive copying and uploading while preserving the user's decision about who may see which material. Links make content accessible, background makes it understandable, and scope keeps it controlled.

## How knowledge flows

| Target | Agent output | Purpose |
| --- | --- | --- |
| Text | Body and background | Understand and use a focused passage |
| File | Address, background, and current content | Read current material and locate the original |
| Folder | Address, background, and first-level entries | Understand the entry point without expanding the vault |

Background answers: what is this, where did it come from, and why is it being shared now? Every share also includes a local `filePath`: read through the link, then update the shared content through the share API.

### Writing

1. The user asks an agent to save something to notes.
2. The installed instruction recognizes the intent.
3. The agent writes content and background through agentNote.
4. A regular note is saved in the vault and receives a permanent link.
5. Later updates use the same link, avoiding duplicate notes.

### Reading and handoff

1. A user or agent creates a share address.
2. The address is handed to an agent.
3. That agent reads the current content and background.
4. The same address resolves to the latest content after updates.

## Control panel and maintenance

The connection panel helps agents recognize and use agentNote. It installs and manages long-term prompts, shows service status and connected agents, and provides a manual connection flow for agents outside the built-in list.

Background, tags, search, protection, and archiving are maintenance aids, not ends in themselves. Their only standard is whether they help users maintain local content that agents can understand and reuse over time.

## Boundaries

- Data remains Markdown and JSON inside the user's vault.
- The service listens only locally; there is no cloud sync, account system, or public sharing layer.
- agentNote does not replace Obsidian editing, file management, version control, or backups.
- When Obsidian closes, the local relay is unavailable, but the original files remain untouched.
