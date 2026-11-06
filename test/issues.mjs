import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {VaultStore, AgentServer, parseExcludedFolders, isExcludedFolder, readMobileHistory} = createRequire(import.meta.url)('./core-bundle.cjs');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentnote-issues-'));
const store=new VaultStore(path.join(dir,'vault'),'.obsidian',{deviceIdFile:path.join(dir,'device'),referencesFile:path.join(dir,'references')});
const server=new AgentServer(store,{port:0});const base='http://127.0.0.1:'+await server.start();
try {
  await fs.writeFile(path.join(store.root,'example.md'),'root content');
  for(const root of ['', '/', '.', '\\']) {
    const response=await fetch(base+'/api/shares',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:root})});
    assert.equal(response.status,201);const {data:share}=await response.json();
    const data=(await(await fetch(`${base}/api/shares/${share.id}/resolve?format=json&detail=1`)).json()).data;
    assert.equal(data.kind,'folder');assert.equal(data.filePath,store.root);assert.equal(data.title,path.basename(store.root));assert.ok(data.entries.includes('example.md'));
  }
  await assert.rejects(store.createPathShare('../'),/相对路径/);
  console.log('PASS #8 root shares persist and resolve; parent traversal rejected');
  assert.deepEqual(parseExcludedFolders('daily\\drafts; archive, daily/drafts\n folder with spaces/'),['daily/drafts','archive','folder with spaces']);
  assert.equal(isExcludedFolder('archive-2026/a.md',['archive']),false);
  for(const invalid of ['../outside','a/../b','/absolute','C:\\outside','.','/'])assert.throws(()=>parseExcludedFolders(invalid));
  await fs.mkdir(path.join(store.root,'ignored'),{recursive:true});
  await fs.writeFile(path.join(store.root,'ignored/a.md'),'ignored');
  await store.recordLocalActivity('local-created','ignored/a.md');
  const before=await store.activityLog.read();
  store.setExcludedFolders(['ignored']);
  for(const type of ['local-created','local-edited','local-read','local-deleted','local-moved'])await store.recordLocalActivity(type,'ignored/a.md', type==='local-moved'?'ignored/old.md':undefined);
  await store.recordDocumentReferences('ignored/a.md',['example.md']);
  await store.recordDocumentReferences('example.md',[]);
  await store.recordDocumentReferences('example.md',['ignored/a.md']);
  assert.equal((await store.activityLog.read()).length,before.length);
  assert.ok((await store.listActivity()).every(e=>e.path!=='ignored/a.md'));
  const insights=await store.getDashboardInsights();
  assert.ok(insights.timeline.every(e=>!e.path?.startsWith('ignored/')));
  assert.ok(insights.documents.every(e=>!e.document.path.startsWith('ignored/')));
  store.setExcludedFolders([]);assert.ok((await store.listActivity()).some(e=>e.path==='ignored/a.md'));
  console.log('PASS #10 nested folder exclusions affect tracking, backlinks and reports without rewriting history');

  const sample={eventId:'event-1',at:new Date().toISOString(),type:'local-edited',path:'example.md',title:'Example'};
  const data=new Map([['agentNote/data/events.json',JSON.stringify([sample])],['agentNote/data/events/2026-11/a.json',JSON.stringify(sample)],['agentNote/data/events/2026-11/b.json','broken'],['agentNote/data/cold-backups/copy.json',JSON.stringify([{...sample,eventId:'backup'}])]]);
  const adapter={exists:async p=>[...data.keys()].some(key=>key===p||key.startsWith(p+'/')),read:async p=>data.get(p),list:async p=>({files:[...data.keys()].filter(key=>path.posix.dirname(key)===p),folders:[...new Set([...data.keys()].filter(key=>key.startsWith(p+'/')).map(key=>key.slice(p.length+1).split('/')).filter(parts=>parts.length>1).map(parts=>p+'/'+parts[0]))]})};
  const report=await readMobileHistory(adapter,[]);assert.equal(report.events.length,1);assert.equal(report.issues.length,1);
  assert.equal((await readMobileHistory(adapter,['example.md'])).events.length,0);
  data.set('agentNote/data/events/2026-11/conflict.json',JSON.stringify({...sample,title:'Conflict'}));
  assert.equal((await readMobileHistory(adapter,[])).events.length,0);
  assert.deepEqual(await readMobileHistory({exists:async()=>false},[]),{events:[],issues:[]});
  assert.equal((await readMobileHistory({exists:async()=>{throw Error('offline');}},[])).issues.length,1);
  data.delete('agentNote/data/events/2026-11/conflict.json');
  const loaded=[];const commands=[];const opened=[];
  class Element {
    constructor(tag='div', options={}) {this.tag=tag;this.text=String(options.text??'');this.value=options.value??'';this.children=[];}
    createEl(tag,options){const child=new Element(tag,options);this.children.push(child);return child;}
    createDiv(options){return this.createEl('div',options);}
    empty(){this.text='';this.children=[];} addClass(){}
    get textContent(){return this.text+this.children.map(child=>child.textContent).join(' ');}
    all(){return [this,...this.children.flatMap(child=>child.all())];}
  }
  class TFile {}
  const note=new TFile();note.path='example.md';
  const app={vault:{adapter,getAbstractFileByPath:p=>p==='example.md'?note:null},workspace:{getLeaf:()=>({openFile:async file=>opened.push(file.path)})}};
  class ItemView {constructor(leaf){this.app=leaf.app;this.contentEl=new Element();}}
  class Plugin {async loadData(){return null;}registerView(id,fn){this.view=fn;}addRibbonIcon(){}addCommand(command){commands.push(command.id);}}
  const sandbox={module:{exports:{}},exports:{},console,require(name){loaded.push(name);if(name==='obsidian')return{Platform:{isDesktopApp:false},Plugin,ItemView,TFile,getLanguage:()=> 'zh'};throw new Error('Mobile attempted '+name);}};
  vm.runInNewContext(await fs.readFile('main.js','utf8'),sandbox);
  const Mobile=sandbox.module.exports.default;const mobile=new Mobile();mobile.app=app;await mobile.onload();
  const view=mobile.view({app});await view.onOpen();
  assert.match(view.contentEl.textContent,/Example/);
  const noteButton=view.contentEl.all().find(element=>element.tag==='button'&&element.text==='Example');
  noteButton.onclick();assert.deepEqual(opened,['example.md']);
  const search=view.contentEl.all().find(element=>element.tag==='input');search.value='missing';search.oninput();
  assert.match(view.contentEl.textContent,/暂无活动记录/);
  await view.onClose();
  assert.ok(loaded.every(name=>name==='obsidian'));assert.deepEqual(commands,['open-panel']);
  console.log('PASS #9 mobile logs deduplicate, report corruption, omit backups and exclusions; mobile entry loads no Node modules or sharing commands');
} finally {await server.stop();await fs.rm(dir,{recursive:true,force:true});}
