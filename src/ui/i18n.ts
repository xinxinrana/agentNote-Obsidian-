import { getLanguage } from "obsidian";

const messages = {
  panelTitle: ["agentNote 接入台", "agentNote Workspace"],
  quickStartTitle: ["第一次使用？三步开始", "New here? Start in three steps"],
  viewGuide: ["查看教程", "View guide"],
  hideGuide: ["隐藏快速教程", "Hide quick start"],
  quickStartHidden: ["快速教程已隐藏；可在“设置 → 插件设置 → 使用教程”中直接查看。", "Quick start hidden. You can reopen it from the plugin settings."],
  stepConnect: ["接入一个 agent", "Connect an agent"],
  stepConnectHint: ["在下方选择已安装的 agent 并完成接入。", "Choose an installed agent below and connect it."],
  stepShare: ["分享一份资料", "Share a file"],
  stepShareHint: ["右键文件或文件夹，复制 agentNote 地址。", "Right-click a file or folder and copy its agentNote link."],
  stepTalk: ["直接开始对话", "Start a conversation"],
  stepTalkHint: ["把地址发给 agent，或说“写到 Obsidian”。", "Send the link to your agent, or ask it to write to Obsidian."],
  localInsights: ["本地知识洞察", "Local knowledge insights"],
  heroTitle: ["知识正在持续进入工作流", "Your knowledge at work"],
  weekSummary: ["本周完成 {count} 次知识活动：建设 {created}、维护与整理 {updated}、分享 {shares}、使用 {resolves}。", "This week: {count} knowledge activities — {created} created, {updated} maintained, {shares} shared, and {resolves} reads."],
  emptySummary: ["创建、维护、使用或整理资料后，这里会留下完整的知识活动。", "Your knowledge activity will appear here as you create, maintain, use, and organize files."],
  activityScore: ["知识活跃分", "Knowledge activity"],
  weekUpdates: ["本周更新", "Updates this week"],
  weekReuse: ["本周复用", "Reads this week"],
  recentActivity: ["最近动态", "Recent activity"],
  viewInsights: ["查看完整洞察", "View insights"],
  activityEmpty: ["创建并分享资料给 agent 后，这里会留下它进入工作流的记录。", "Once you share files with an agent, their activity will appear here."],
  localService: ["本地服务", "Local service"],
  serviceRunning: ["服务正在运行", "Service running"],
  serviceStopped: ["服务未运行", "Service stopped"],
  serviceRunningHint: ["agent 可以读取分享和写入笔记", "Agents can read shares and write notes"],
  serviceStoppedHint: ["启动后，agent 才能读取分享和写入笔记", "Start the service to let agents read shares and write notes"],
  serviceAddress: ["本地服务地址 {address}", "Local service address {address}"],
  stopService: ["停止服务", "Stop service"],
  startService: ["启动服务", "Start service"],
  connectAgent: ["接入 agent", "Connect agents"],
  connectAgentHint: ["接入会在该 agent 的长期 skill 目录写入一份 agentNote 使用说明。", "Connecting writes agentNote instructions to the agent's skills directory."],
  manualConnect: ["手动接入任意 agent", "Connect another agent manually"],
} as const;

export type UiLanguage = "zh" | "en";
export function languageFor(code: string | null | undefined): UiLanguage {
  return !code || code.toLowerCase().startsWith("zh") ? "zh" : "en";
}
export function uiLanguage(): UiLanguage {
  return languageFor(typeof getLanguage === "function" ? getLanguage() : null);
}
export function t(key: keyof typeof messages, values: Record<string, string | number> = {}): string {
  const template = messages[key][uiLanguage() === "zh" ? 0 : 1] as string;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name]?.toString() ?? match);
}
