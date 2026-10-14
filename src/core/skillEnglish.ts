/** Keep the API structure and capabilities aligned with DEFAULT_SKILL_TEMPLATE. */
export const ENGLISH_SKILL_TEMPLATE = `---
name: agentnote
description: The user's local Obsidian note and file relay. When the user says "write to Obsidian", "save to agent notes", or "remember this in my notes", use it to write notes. When the user provides a URL on port 27182, read it through this Skill; do not access it with web scraping tools.
---

# agentNote

agentNote connects content in the user's vault to agents through local HTTP. Service URL: {{baseUrl}}. It is available only on this computer. If the connection is refused, ask the user to open Obsidian and start the agentNote service.

## Write from natural language

When the user says "write to Obsidian", "save to agent notes", "remember this in my notes", or an equivalent phrase, create a note without asking for a file path or API parameters.

\`\`\`json
POST {{baseUrl}}/api/nodes
{
  "title": "Short topic",
  "content": "Organized note content",
  "background": "What this is, where it came from, and why it matters",
  "tags": ["optional-tag"],
  "source": "agent"
}

\`\`\`

Use "Type ｜ Document title" (a full-width vertical bar) for new note titles, such as "Meeting notes ｜ Project review". Follow an explicitly requested title instead. Content may use Obsidian Markdown, including wikilinks, task lists, and callouts.

Organize the title, content, background, and tags from the user's intent. Leave unclear background or tags empty. You do not need to search for old notes before writing.

A successful write returns \`status\` and \`link\`. The \`link\` is the note's permanent address. Send it to the user immediately and use it to refer to this note in subsequent conversation. If the user asks to edit the note you just wrote, use that link directly instead of searching again.

## Share links

When the user provides \`{{baseUrl}}/api/shares/s-x-.../resolve\`, GET it directly and use the response.
For \`[file name]({{baseUrl}}/api/shares/s-x-.../resolve)\`, extract the URL in parentheses and GET it directly.
If the user provides multiple share links, read each one and then perform the task.
Return share links as \`[document title](full URL)\`; use the original URL for API requests.

- \`kind: text\`: content and background.
- \`kind: file\`: file address, background, and current file content.
- \`kind: folder\`: folder address, background, and first-level file names.

Append \`?raw=1\` to get only the content text. Do not ask the user to copy the original file or paste its content again.

Read wikilink targets when needed: GET \`{{baseUrl}}/api/shares/<id>/links\` for \`targetPath\`, then POST \`{{baseUrl}}/api/shares\` with \`{"path":"<targetPath>"}\` and GET the returned \`/resolve\` URL.

## Fixed identity and activity tracking (required)

The \`agentnote.identity.json\` file in this Skill directory contains this agent's default identity. Read it before calling the API and always use its \`id\` and \`name\`. Do not change names based on the model, task, or conversation. The service prefers the registered identity to keep the agent's activity history consistent.

Include these headers with every agentNote HTTP API request so the local dashboard can show which agent used or modified which document and when:

\`\`\`
X-AgentNote-Agent-Id: {{encodedAgentId}}
X-AgentNote-Agent-Name: {{encodedAgentName}}
X-AgentNote-Session-Title: <encodeURIComponent(a short title describing the current work)>
\`\`\`

Encode header values with \`encodeURIComponent\`; the service decodes them for display. Reuse the same \`X-AgentNote-Session-Title\` throughout one task, such as "Improve database analysis SOP". Use a new specific title when starting another task. This locally reported identity is for activity tracking, not authentication.

## Reading and updating

The share response's \`filePath\` is the actual local content path; \`hint\` explains how to use it:

- Prefer reading through the link to get current content and background.
- Update shared content with PATCH \`/api/shares/<shareId>\` and \`{ "content": "updated full content" }\`.

## Activity queries and summaries

- GET \`{{baseUrl}}/api/insights/overview\`: this week's overview, trends, and document rankings.
- GET \`{{baseUrl}}/api/insights/activity?from=<start>&to=<end>\`: activity in a time range. Optionally filter by \`agent\`, \`action\`, \`nodeId\`, or \`documentId\`. Use UTC ISO timestamps such as \`2026-09-20T16:00:00.000Z\` and URL-encode parameters. Both endpoints of the range are included. Calculate the start of the week as Monday midnight in the user's local timezone, then convert to UTC.
- GET \`{{baseUrl}}/api/insights/agents\`: each agent's cumulative share reads, creations, and updates.
- GET \`{{baseUrl}}/api/insights/documents\`: document share-read totals, agents that used them, and most recent use.

The response's \`data\` contains the query result. Statistics queries do not add activity. To summarize this week's key work, query the week's activity, then read relevant content as needed and prepare the share. Activity counts are clues, not measures of effort or achievement.

You may also read \`agentNote/data/events*.json\` activity logs under \`data.vault\` returned by \`GET {{baseUrl}}/api/health\` for reviews and summaries. The plugin maintains these logs; do not modify them.

## Available endpoints

\`\`\`
GET  {{baseUrl}}/api/health
GET  {{baseUrl}}/api/nodes?q=
GET  {{baseUrl}}/api/nodes/<id>
POST {{baseUrl}}/api/nodes
PATCH {{baseUrl}}/api/nodes/<id>
POST {{baseUrl}}/api/shares
PATCH {{baseUrl}}/api/shares/<shareId>
GET  {{baseUrl}}/api/shares/<id>/resolve
GET  {{baseUrl}}/api/shares/<id>/links
\`\`\`
`;

export const ENGLISH_INSTALL_PROMPT = `Please install the agentNote Skill. It is the user's local Obsidian note and file relay for reading shares, finding notes, and writing notes.

1. Download the Skill from {{baseUrl}}/api/skill.md and save it as agentnote/SKILL.md in your actual skills directory. Complete any Skill configuration required by your agent.
2. Create agentnote.identity.json in the same directory with your fixed id and name, for example {"id":"your-agent-id","name":"Your Agent Name"}. Use this identity as described in the Skill.
3. After installation, POST {{baseUrl}}/api/agents/register with {"name":"Your Agent Name","skillPath":"<absolute path to SKILL.md>"}. Use the same name as in the identity file so Obsidian can manage this Skill. The optional iconPath reports this Agent's own icon, not the agentNote icon. Prefer an official PNG, ICO, or SVG icon from this Agent's own website; if unavailable, use an official icon from its local installation. Copy the confirmed icon into the same Skill directory and include "iconPath":"<absolute path to that icon>". If you cannot confirm or obtain one, omit iconPath and the panel will show a default icon.

If your agent supports Skill icons, you may use {{baseUrl}}/api/skill-icon.svg for the agentNote Skill itself. This is the agentNote product icon, not your agent's logo; never report it as iconPath. Otherwise, skip it.

Finally, briefly confirm that a new conversation can use the Skill. If the local URL is unavailable, ask the user to start the agentNote service in Obsidian.`;
