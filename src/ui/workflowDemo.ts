const steps = [
  {
    title: "接入 Agent",
    caption: "点击“接入”复制任务，发给 Agent；安装并上报后，状态会变成“已接入”。",
  },
  {
    title: "分享笔记",
    caption: "右键一份笔记，选择“agentNote: 分享给 agent”，地址会自动复制。",
  },
  {
    title: "发送地址",
    caption: "把地址粘贴到 Agent 对话并发送，Agent 就能读取这份资料。",
  },
  {
    title: "写回笔记",
    caption: "继续说“写到 Obsidian”，新笔记会出现在你的本地库中。",
  },
] as const;

function createApp(parent: HTMLElement, title: string, extraClass = ""): HTMLElement {
  const app = parent.createDiv({ cls: `agentnote-demo-app ${extraClass}`.trim() });
  const bar = app.createDiv({ cls: "agentnote-demo-bar" });
  bar.createSpan({ cls: "agentnote-demo-dots" });
  bar.createSpan({ text: title });
  return app;
}

function createFile(parent: HTMLElement, name: string, extraClass = ""): void {
  const file = parent.createDiv({ cls: `agentnote-demo-file ${extraClass}`.trim() });
  file.createSpan({ cls: "agentnote-demo-file-icon" });
  file.createSpan({ text: name });
}

function createCursor(parent: HTMLElement): void {
  parent.createSpan({ cls: "agentnote-demo-cursor", attr: { "aria-hidden": "true" } });
}

function renderScene(parent: HTMLElement, index: number): void {
  if (index === 0) {
    const connection = createApp(parent, "agentNote · 接入台");
    const card = connection.createDiv({ cls: "agentnote-demo-agent-card" });
    card.createEl("strong", { text: "Codex" });
    card.createSpan({ cls: "agentnote-demo-before", text: "未接入" });
    card.createSpan({ cls: "agentnote-demo-after", text: "已接入" });
    card.createEl("b", { text: "接入" });
    connection.createDiv({ cls: "agentnote-demo-toast", text: "✓ 安装任务已复制" });
    createCursor(connection);
    const chat = createApp(parent, "Codex 对话", "agentnote-demo-chat");
    chat.createDiv({ cls: "agentnote-demo-message", text: "请安装 agentNote Skill" });
    chat.createDiv({ cls: "agentnote-demo-reply", text: "安装完成，已上报接入信息。" });
  } else if (index === 1) {
    const notes = createApp(parent, "Obsidian · 我的笔记", "agentnote-demo-app-wide");
    createFile(notes, "产品讨论.md", "agentnote-demo-target");
    createFile(notes, "会议纪要.md");
    const menu = notes.createDiv({ cls: "agentnote-demo-menu" });
    menu.createDiv({ text: "打开文件" });
    menu.createEl("strong", { text: "agentNote: 分享给 agent" });
    notes.createDiv({ cls: "agentnote-demo-toast", text: "✓ 分享地址已复制" });
    createCursor(notes);
  } else if (index === 2) {
    const notes = createApp(parent, "Obsidian");
    createFile(notes, "产品讨论.md");
    notes.createDiv({ cls: "agentnote-demo-link", text: "127.0.0.1:27182/…/resolve" });
    const chat = createApp(parent, "Agent 对话", "agentnote-demo-chat");
    chat.createDiv({ cls: "agentnote-demo-message", text: "请读取这份资料并整理重点" });
    const compose = chat.createDiv({ cls: "agentnote-demo-compose" });
    compose.createSpan({ text: "粘贴 agentNote 地址" });
    compose.createEl("b", { text: "➜" });
    chat.createDiv({ cls: "agentnote-demo-reply", text: "已读取「产品讨论.md」，找到 3 个重点。" });
    createCursor(chat);
  } else {
    const chat = createApp(parent, "Agent 对话", "agentnote-demo-chat");
    chat.createDiv({ cls: "agentnote-demo-message", text: "把结论写到 Obsidian" });
    chat.createDiv({ cls: "agentnote-demo-reply", text: "已写入「产品讨论结论」，可以继续修改。" });
    createCursor(chat);
    const notes = createApp(parent, "Obsidian · 我的笔记");
    createFile(notes, "产品讨论.md");
    createFile(notes, "产品讨论结论.md", "agentnote-demo-created");
  }
}

export function renderWorkflowDemo(parent: HTMLElement): () => void {
  const demo = parent.createDiv({ cls: "agentnote-workflow-demo" });
  const viewport = demo.createDiv({ cls: "agentnote-demo-viewport", attr: { "aria-label": "agentNote 分享、读取与写回流程演示" } });
  const caption = demo.createEl("p", { cls: "agentnote-demo-caption", attr: { "aria-live": "polite" } });
  const controls = demo.createDiv({ cls: "agentnote-demo-controls", attr: { "aria-label": "选择演示步骤" } });
  let current = 0;
  let timer: number | null = null;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const buttons = steps.map((step, index) => {
    const button = controls.createEl("button", { text: `${index + 1} ${step.title}`, attr: { type: "button" } });
    button.onclick = () => { show(index); schedule(); };
    return button;
  });
  function show(index: number): void {
    current = index;
    viewport.dataset.step = steps[index].title;
    viewport.empty();
    renderScene(viewport, index);
    caption.setText(steps[index].caption);
    buttons.forEach((button, buttonIndex) => {
      button.classList.toggle("is-active", buttonIndex === index);
      button.setAttribute("aria-pressed", String(buttonIndex === index));
    });
  }
  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = motion.matches ? null : window.setTimeout(() => { show((current + 1) % steps.length); schedule(); }, 5_600);
  }
  show(0);
  schedule();
  motion.addEventListener("change", schedule);
  return () => { if (timer !== null) window.clearTimeout(timer); motion.removeEventListener("change", schedule); };
}
