'use client';

import { useMemo, useState } from 'react';

type Topic = {
  title: string;
  reason: string;
  angle: string;
  titles: string[];
  cover: string;
  body: string[];
  tags: string[];
};

const initialTopics: Topic[] = [
  {
    title: '别再把笔记复制给 AI：让它在 Obsidian 里直接工作',
    reason: '这是一个高频、具体且令人厌烦的动作。读者能立刻判断它是否值得自己花 5 分钟解决。',
    angle: '面向已经在用 Obsidian 和 Claude / Codex 的知识工作者，展示一次真实的「读笔记—给建议—写回本地」闭环。',
    titles: ['Obsidian 终于不用再复制笔记给 AI 了', '我把 200 篇笔记交给 AI 后，少做了这些重复劳动', '让 AI 读懂 Obsidian，但只给它该看的部分'],
    cover: '小红书竖版封面，真实 Obsidian 深色界面截图风格，左侧是凌乱的笔记复制粘贴，右侧是 AI 直接读取并写回笔记；醒目大字「不用再复制笔记给 AI」；橙红色重点标记，专业科技感，留白清晰，无人物，无水印，4:5',
    body: ['每次问 AI 一个问题，都要把相关笔记重新复制进去，真的很消耗人。', '我现在让 AI 直接在 Obsidian 里读取指定笔记：先选范围，再提问；它只能看到我授权的内容。', '它的答案可以直接写回本地笔记。整理会议记录、串联研究资料、起草周报，终于不用在多个窗口来回搬运。', '如果你也把 Obsidian 当第二大脑，这个工作流可能会省下很多无意义的复制粘贴。'],
    tags: ['#Obsidian', '#AI工具', '#知识管理', '#效率工具', '#Claude', '#Codex'],
  },
  {
    title: '用会议记录生成周报：一个可复用的 AI 工作流',
    reason: '周报是明确、重复、可验证的工作任务。展示前后差异，比抽象讲 AI 效率更容易建立信任。',
    angle: '用一周的会议记录演示：选中笔记 → 让 AI 提炼进展、风险和下周计划 → 人工确认后写入周报。',
    titles: ['开周会前 10 分钟，我用 AI 写完周报', '把会议记录丢给 AI，它帮我生成了这份周报', '一周 12 场会，怎么不漏掉任何一个待办？'],
    cover: '小红书竖版封面，真实办公桌面与笔记应用界面组合，会议记录卡片流向一张结构清晰的周报，中央大字「会议记录 → 周报」和小字「10 分钟完成初稿」，暖白底、深蓝文字、荧光黄强调，干净克制，无人物，无水印，4:5',
    body: ['我以前写周报最难的不是写，而是翻完一周的会议记录。', '现在我把本周会议笔记限定给 AI，让它只做三件事：提炼进展、列出风险、归纳下周动作。', '得到初稿后，我只需要核对关键事实和优先级，再写回自己的周报模板。', '它不替我做判断，但帮我省掉了最机械的整理过程。'],
    tags: ['#周报', '#会议记录', '#AI办公', '#职场效率', '#Obsidian', '#知识管理'],
  },
];

export default function Home() {
  const [topics, setTopics] = useState(initialTopics);
  const [active, setActive] = useState(0);
  const [stage, setStage] = useState<'reason' | 'package'>('reason');
  const [checked, setChecked] = useState(false);
  const [copied, setCopied] = useState('');
  const current = topics[active];
  const readiness = useMemo(() => checked && current.reason.length > 30, [checked, current.reason]);

  function addTopic() {
    const fresh: Topic = { title: '未命名选题', reason: '先写下这篇内容能解决的具体问题，以及读者为什么愿意停下来读。', angle: '明确目标读者、他们的现状和这篇内容给出的确定收获。', titles: ['待拟标题'], cover: '描述封面中的真实使用场景、核心卖点和视觉风格。', body: ['痛点：', '方法：', '结果：', '互动问题：'], tags: ['#待补充'] };
    setTopics([...topics, fresh]); setActive(topics.length); setStage('reason'); setChecked(false);
  }
  function copy(text: string, label: string) { navigator.clipboard?.writeText(text); setCopied(label); setTimeout(() => setCopied(''), 1800); }

  return <main className="studio">
    <aside className="sidebar">
      <div className="brand"><span className="brand-dot">点</span><div><b>点点工作台</b><small>CONTENT STUDIO</small></div></div>
      <button className="new-btn" onClick={addTopic}>＋ 新建选题</button>
      <p className="side-label">本周选题</p>
      <nav>{topics.map((topic, i) => <button key={i} onClick={() => {setActive(i); setChecked(false);}} className={`topic-nav ${i === active ? 'active' : ''}`}><span>{i + 1}</span>{topic.title}</button>)}</nav>
      <div className="principle"><span>✦ 内容原则</span><p>如果不能说服自己，这篇就不该发。</p></div>
    </aside>

    <section className="content">
      <header className="topbar"><div><p className="eyebrow">小红书 · 内容策划</p><h1>{current.title}</h1></div><button className="outline" onClick={() => copy(JSON.stringify(current, null, 2), '内容方案')}>{copied === '内容方案' ? '已复制' : '复制方案'}</button></header>
      <div className="steps"><button className={stage === 'reason' ? 'selected' : ''} onClick={() => setStage('reason')}><i>01</i>前置判断</button><span/><button className={stage === 'package' ? 'selected' : ''} onClick={() => stage === 'package' && readiness ? null : setStage('reason')}><i>02</i>发布设计</button></div>
      {stage === 'reason' ? <section className="reason-page">
        <div className="gate"><div className="gate-icon">？</div><div><p className="eyebrow">先过这一关</p><h2>为什么值得写这篇？</h2><p>不是为了“发一篇”，而是确认它能为读者解决一个真实、具体的问题。</p></div></div>
        <article className="card"><label>说服自己的理由</label><textarea value={current.reason} onChange={e => {const next=[...topics]; next[active]={...current,reason:e.target.value};setTopics(next);}} /><div className="test"><b>自检问题</b><p>读者能在 3 秒内明白：这篇和我有什么关系吗？</p><p>看完后，他能获得一个具体的方法、判断或结果吗？</p></div></article>
        <article className="card"><label>读者与内容角度</label><textarea value={current.angle} onChange={e => {const next=[...topics]; next[active]={...current,angle:e.target.value};setTopics(next);}} /></article>
        <label className="confirm"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/><span>我确认：这个选题解决的是具体问题，而非单纯表达自己。</span></label>
        <button disabled={!readiness} className="primary" onClick={() => setStage('package')}>通过判断，开始设计发布内容 →</button>
      </section> : <section className="package-page">
        <div className="section-title"><div><p className="eyebrow">一键发布包</p><h2>把选题变成可发布内容</h2></div><span className="ready">已通过前置判断</span></div>
        <article className="card"><div className="card-head"><label>标题备选</label><button onClick={()=>copy(current.titles.join('\n'), '标题')}>{copied === '标题' ? '已复制' : '复制'}</button></div><ol className="titles">{current.titles.map((t,i)=><li key={t}><span>{i+1}</span>{t}</li>)}</ol></article>
        <article className="card"><div className="card-head"><label>封面设计提示词</label><button onClick={()=>copy(current.cover, '封面提示词')}>{copied === '封面提示词' ? '已复制' : '复制'}</button></div><p className="prompt">{current.cover}</p></article>
        <article className="card"><div className="card-head"><label>正文框架</label><button onClick={()=>copy(current.body.join('\n\n'), '正文')}>{copied === '正文' ? '已复制' : '复制'}</button></div>{current.body.map((p,i)=><p className="body-line" key={i}>{p}</p>)}</article>
        <article className="card"><div className="card-head"><label>发布 Tags</label><button onClick={()=>copy(current.tags.join(' '), '标签')}>{copied === '标签' ? '已复制' : '复制'}</button></div><div className="tags">{current.tags.map(t=><span key={t}>{t}</span>)}</div></article>
      </section>}
    </section>
  </main>;
}
