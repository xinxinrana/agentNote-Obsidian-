const steps = [
  {
    title: "接入 Agent",
    caption: "点击“接入”复制任务，发给 Agent；安装并上报后，状态会变成“已接入”。",
    scene: `<div class="agentnote-demo-app">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>agentNote · 接入台</div>
      <div class="agentnote-demo-agent-card"><strong>Codex</strong><span class="agentnote-demo-before">未接入</span><span class="agentnote-demo-after">已接入</span><b>接入</b></div>
      <div class="agentnote-demo-toast">✓ 安装任务已复制</div>
      <span class="agentnote-demo-cursor" aria-hidden="true"></span>
    </div>
    <div class="agentnote-demo-app agentnote-demo-chat">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>Codex 对话</div>
      <div class="agentnote-demo-message">请安装 agentNote Skill</div>
      <div class="agentnote-demo-reply">安装完成，已上报接入信息。</div>
    </div>`,
  },
  {
    title: "分享笔记",
    caption: "右键一份笔记，选择“agentNote: 分享给 agent”，地址会自动复制。",
    scene: `<div class="agentnote-demo-app agentnote-demo-app-wide">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>Obsidian · 我的笔记</div>
      <div class="agentnote-demo-file agentnote-demo-target"><span class="agentnote-demo-file-icon"></span>产品讨论.md</div>
      <div class="agentnote-demo-file"><span class="agentnote-demo-file-icon"></span>会议纪要.md</div>
      <div class="agentnote-demo-menu"><div>打开文件</div><strong>agentNote: 分享给 agent</strong></div>
      <div class="agentnote-demo-toast">✓ 分享地址已复制</div>
      <span class="agentnote-demo-cursor" aria-hidden="true"></span>
    </div>`,
  },
  {
    title: "发送地址",
    caption: "把地址粘贴到 Agent 对话并发送，Agent 就能读取这份资料。",
    scene: `<div class="agentnote-demo-app">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>Obsidian</div>
      <div class="agentnote-demo-file"><span class="agentnote-demo-file-icon"></span>产品讨论.md</div>
      <div class="agentnote-demo-link">127.0.0.1:27182/…/resolve</div>
    </div>
    <div class="agentnote-demo-app agentnote-demo-chat">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>Agent 对话</div>
      <div class="agentnote-demo-message">请读取这份资料并整理重点</div>
      <div class="agentnote-demo-compose">粘贴 agentNote 地址 <b>➜</b></div>
      <div class="agentnote-demo-reply">已读取「产品讨论.md」，找到 3 个重点。</div>
      <span class="agentnote-demo-cursor" aria-hidden="true"></span>
    </div>`,
  },
  {
    title: "写回笔记",
    caption: "继续说“写到 Obsidian”，新笔记会出现在你的本地库中。",
    scene: `<div class="agentnote-demo-app agentnote-demo-chat">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>Agent 对话</div>
      <div class="agentnote-demo-message">把结论写到 Obsidian</div>
      <div class="agentnote-demo-reply">已写入「产品讨论结论」，可以继续修改。</div>
      <span class="agentnote-demo-cursor" aria-hidden="true"></span>
    </div>
    <div class="agentnote-demo-app">
      <div class="agentnote-demo-bar"><span class="agentnote-demo-dots"></span>Obsidian · 我的笔记</div>
      <div class="agentnote-demo-file"><span class="agentnote-demo-file-icon"></span>产品讨论.md</div>
      <div class="agentnote-demo-file agentnote-demo-created"><span class="agentnote-demo-file-icon"></span>产品讨论结论.md</div>
    </div>`,
  },
] as const;

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
    viewport.innerHTML = steps[index].scene;
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
