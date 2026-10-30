/** Render current plugin components with a disposable public demo vault.
 * CHROME_PATH=/path/to/chromium node scripts/build-readme-assets.mjs
 * No running Obsidian instance, personal vault, or installed Skill is accessed.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/img/readme');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentnote-readme-'));
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const run = promisify(execFile);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const host = `
export class Element {
  constructor(tag = 'div', options = {}) { this.tag = tag; this.children = []; this.text = String(options.text ?? ''); this.attrs = { ...options.attr }; if (options.cls) this.attrs.class = options.cls; }
  createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  empty() { this.text = ''; this.children = []; }
  addClass(...names) { this.attrs.class = [...new Set((this.attrs.class || '').split(' ').concat(names))].join(' '); }
  removeClass(name) { this.attrs.class = (this.attrs.class || '').split(' ').filter(x => x !== name).join(' '); }
  setText(text) { this.text = String(text); }
  setAttribute(name, value) { this.attrs[name] = value; }
  setCssProps(props) { this.attrs.style = Object.entries(props).map(([key, value]) => key + ':' + value).join(';'); }
  querySelector() { return null; }
}
export class ItemView { constructor(leaf) { this.app = leaf.app; this.contentEl = new Element(); } registerEvent() {} }
export class Modal { constructor(app) { this.app = app; this.contentEl = new Element('div', { cls: 'modal-content' }); this.modalEl = new Element('div', { cls: 'modal' }); this.modalEl.children.push(this.contentEl); } }
export class Menu {} export class Notice {} export class App {} export class TFile {} export class WorkspaceLeaf {} export class Setting {}
export function setIcon() {}
`;
function html(element) {
  const attrs = Object.entries(element.attrs).map(([name, value]) => ` ${name}="${escape(value)}"`).join('');
  if (['img', 'input', 'br'].includes(element.tag)) return `<${element.tag}${attrs}>`;
  return `<${element.tag}${attrs}>${escape(element.text)}${element.children.map(html).join('')}</${element.tag}>`;
}
const base = `
:root { color-scheme: dark; --background-primary:#1d1b23; --background-secondary:#24212b; --background-modifier-border:#3a3445; --background-modifier-hover:#312a3e; --text-normal:#ece8f2; --text-muted:#a9a2b5; --text-faint:#7d748b; --text-accent:#bd97f0; --text-on-accent:#fff; --interactive-accent:#8652cf; --interactive-accent-hover:#9564d8; --interactive-normal:#302a3b; --text-success:#6fc99d; --color-green:#6fc99d; --color-red:#f28c8c; --text-warning:#e1b979; --font-interface:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif; --font-text:var(--font-interface); --font-monospace:monospace; --font-ui-small:13px; --font-ui-smaller:12px; --font-ui-medium:14px; }
* { box-sizing:border-box; } body { margin:0; font-family:var(--font-interface); font-size:14px; line-height:1.5; background:#111015; color:var(--text-normal); } h1,h2,h3,h4,p { margin:0 0 12px; } h2 { font-size:26px; } button { border:1px solid var(--background-modifier-border); border-radius:7px; padding:6px 12px; background:var(--interactive-normal); color:var(--text-normal); font:inherit; } button.mod-cta { background:var(--interactive-accent); color:#fff; border-color:transparent; } a { color:var(--text-accent); } code { font-size:12px; } small { color:var(--text-muted); } .frame { width:1440px; height:940px; padding:32px 42px 38px; background:radial-gradient(ellipse at 80% 20%,#30203f,transparent 65%),#131117; } .meta { height:44px; display:flex; justify-content:space-between; color:#b6a4cf; font-size:12px; letter-spacing:1px; } .window { height:826px; border:1px solid #4a3c5d; border-radius:16px; overflow:hidden; box-shadow:0 25px 70px #0007; background:var(--background-primary); } .bar { height:42px; display:flex; align-items:center; gap:8px; padding:0 18px; border-bottom:1px solid #393041; background:#24202b; color:#b6a4cf; font-size:11px; } .dot { width:8px; height:8px; border-radius:50%; background:#63536f; } .bar .label { margin-left:12px; } .workspace { display:grid; grid-template-columns:190px 1fr 430px; height:784px; } .files { padding:26px 14px; border-right:1px solid #393041; background:#201c27; color:#a99bb9; font-size:12px; } .files h4 { margin:0 10px 24px; letter-spacing:1px; color:#e9e0f3; } .file { padding:10px; border-radius:6px; margin:4px 0; } .file.active { background:#3a2c4b; color:#eee5fa; } .note { padding:32px; overflow:hidden; } .note .kicker { font-size:10px; letter-spacing:1.5px; color:#ba97e4; margin-bottom:10px; } .note h1 { font-size:25px; line-height:1.35; letter-spacing:-.5px; margin-bottom:10px; } .note .sub { color:#b2a7bd; font-size:12px; } .note img { width:100%; height:224px; object-fit:cover; margin:15px 0 20px; border-radius:9px; border:1px solid #47374f; } .note h3 { font-size:15px; color:#e4d5f7; } .note p,.note li { font-size:13px; color:#bcb1c8; } .note ul { padding-left:20px; } .callout { padding:14px 16px; border-left:3px solid #a575dd; border-radius:4px; background:#2a2235; margin-top:18px; } .callout strong { display:block; color:#eadcf9; margin-bottom:4px; } .panel { overflow:hidden; border-left:1px solid #393041; } .agentnote-panel { height:100%; overflow:hidden; } .modal { margin:28px auto; background:var(--background-primary); border:1px solid #45394f; border-radius:14px; overflow:hidden; } .agentnote-insights-modal .modal-content { max-height:none; } .agentnote-insights-modal .agentnote-modal-body { max-height:600px; } .demo-caption { text-align:center; font-size:11px; color:#9c8bac; margin-top:16px; }
`;
try {
  await fs.access(chrome);
  await fs.mkdir(out, { recursive:true });
  await esbuild.build({ stdin:{ contents:'export { AgentNoteView, InsightsModal } from "./src/ui/panel"; export { VaultStore } from "./src/core/store"; export { setLanguage } from "./src/i18n";', resolveDir:root, loader:'ts' }, bundle:true, platform:'node', format:'cjs', external:['electron'], outfile:path.join(temp,'ui.cjs'), loader:{'.png':'dataurl','.svg':'dataurl','.ico':'dataurl'}, plugins:[{name:'readme-host', setup(build) {
    build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'demo'}));
    build.onLoad({filter:/.*/,namespace:'demo'},()=>({contents:host,loader:'js'}));
    build.onLoad({filter:/[/\\]src[/\\]ui[/\\]panel\.ts$/},async args=>({contents:await fs.readFile(args.path,'utf8')+'\nexport { InsightsModal };',loader:'ts'}));
  }}] });
  const { AgentNoteView, InsightsModal, VaultStore, setLanguage } = createRequire(import.meta.url)(path.join(temp,'ui.cjs'));
  globalThis.window = { setTimeout:()=>0, clearTimeout() {} };
  const css = base + await fs.readFile(path.join(root,'styles.css'),'utf8');
  const art = `data:image/png;base64,${(await fs.readFile(path.join(out,'knowledge-in-motion.png'))).toString('base64')}`;
  for (const lang of ['zh','en']) {
    setLanguage(lang);
    const zh = lang === 'zh';
    const titles = zh ? ['研究笔记 ｜ 个人知识库','方法 ｜ 做出下一步判断','方案 ｜ 让积累继续生长'] : ['Research | Personal knowledge','Method | Make the next decision','Plan | Build on what you know'];
    const store = new VaultStore(path.join(temp,lang),'.obsidian',{deviceIdFile:path.join(temp,lang+'-device'),referencesFile:path.join(temp,lang+'-references.json')});
    await store.init();
    const nodes=[];
    for (const title of titles) nodes.push(await store.createNode({title,content:zh?'公开演示资料。':'Public demo material.'}));
    const actor={actor:{name:'Codex'}};
    for (const node of nodes) { const share=await store.createShare(node.id); await store.resolveShare(share.id,actor); }
    await store.updateNode(nodes[2].id,{content:zh?'已有的判断，成为下一次工作的起点。':'Past decisions become the starting point for the next task.'},actor);
    const app={workspace:{getActiveFile:()=>({basename:titles[2],path:'plan.md'})}};
    const plugin={store,settings:{showQuickStart:false},server:{port:27182},connectedAgents:async()=>[]};
    const panel=new AgentNoteView({app},plugin); await panel.refresh();
    const modal=new InsightsModal(app,plugin); modal.modalEl.addClass('agentnote-insights-modal'); await modal.render();
    const note=`<div class="note"><div class="kicker">${zh?'已保存到我的笔记库':'SAVED TO MY VAULT'}</div><h1>${escape(titles[2])}</h1><p class="sub">${zh?'从已有研究和方法笔记，整理出下一步。':'The next step, built from existing research and methods.'}</p><img src="${art}" alt=""><h3>${zh?'让旧知识参与新工作':'Bring past knowledge into the next task'}</h3><p>${zh?'资料提供背景，Agent 帮助整理，成果成为下一次可以继续使用的笔记。':'Your notes provide the context. An agent helps you work through it. The result becomes a note you can use again.'}</p><ul><li>${zh?'选出这次任务需要的资料':'Choose the context for this task'}</li><li>${zh?'结合过去的判断，形成下一步行动':'Build the next action from past decisions'}</li><li>${zh?'把结果写回 Obsidian，接着积累':'Save the result in Obsidian and build on it'}</li></ul><div class="callout"><strong>${zh?'下一次，从这里继续。':'Next time, start from here.'}</strong><p>${zh?'已有知识 → Agent 工作 → 新的知识':'Existing knowledge → Agent work → New knowledge'}</p></div></div>`;
    const files=`<div class="files"><h4>${zh?'我的知识库':'MY VAULT'}</h4><div class="file">${zh?'研究':'Research'}</div><div class="file">${zh?'方法与判断':'Methods & decisions'}</div><div class="file active">${zh?'让积累继续生长':'Build on what you know'}</div><div class="file">agentNote</div></div>`;
    for (const kind of ['workspace','profile']) {
      const content=kind==='workspace'?`<div class="workspace">${files}${note}<div class="panel">${html(panel.contentEl)}</div></div>`:html(modal.modalEl);
      const page=`<!doctype html><meta charset="utf-8"><style>${css}</style><div class="frame"><div class="meta"><span>AGENTNOTE / ${kind==='workspace'?'KNOWLEDGE AT WORK':'KNOWLEDGE PROFILE'}</span><span>${zh?'当前界面 · 公开演示数据':'CURRENT COMPONENTS · PUBLIC DEMO DATA'}</span></div><div class="window"><div class="bar"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="label">${kind==='workspace'?'Obsidian + agentNote':'agentNote / '+(zh?'知识工作档案':'Knowledge profile')}</span></div>${content}</div></div>`;
      const source=path.join(temp,`${kind}-${lang}.html`); await fs.writeFile(source,page);
      const screenshot=path.join(out,`${kind}-demo-${lang}.png`);
      await run(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--hide-scrollbars','--force-device-scale-factor=1.5','--window-size=1440,940','--virtual-time-budget=1000',`--user-data-dir=${path.join(temp,'chrome-'+lang+'-'+kind)}`,`--screenshot=${screenshot}`,pathToFileURL(source).href],{timeout:60000,maxBuffer:1024*1024});
      console.log(path.relative(root,screenshot));
    }
  }
} finally { await fs.rm(temp,{recursive:true,force:true}); }
