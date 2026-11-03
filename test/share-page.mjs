import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { VaultStore, AgentServer, setLanguage } = createRequire(import.meta.url)('./core-bundle.cjs');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentnote-share-page-'));
const root = path.join(temp, '演示 & 笔记库');
const store = new VaultStore(root, '.obsidian', { deviceIdFile: path.join(temp, 'device'), referencesFile: path.join(temp, 'references.json') });
const server = new AgentServer(store, { port: 0 });
const base = `http://127.0.0.1:${await server.start()}`;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const metadata = html => JSON.parse(/<script type="application\/json" id="agentnote-context">([\s\S]*?)<\/script>/.exec(html)[1]);
const openLink = html => /<a class="open" href="([^"]+)">/.exec(html)?.[1].replaceAll('&amp;', '&');
const resolve = id => `${base}/api/shares/${id}/resolve`;

try {
  await fs.mkdir(path.join(root, 'myNote'), { recursive: true });
  const file = 'myNote/好 软件 #1.md';
  const content = '# 本周计划\n\n已有资料参与新工作。\n\n- [ ] 整理资料\n- [x] 写回笔记\n\n| 工作 | 状态 |\n| --- | --- |\n| 下一步 | 已整理 |\n\n```js\nconst value = "<safe>";\n```\n\n<script>globalThis.compromised = true</script>\n\n[危险链接](javascript:alert(1))';
  await fs.writeFile(path.join(root, file), content);
  const share = await store.createPathShare(file, '来自项目讨论的背景。');
  const url = resolve(share.id);
  const full = await store.resolveShare(share.id);
  setLanguage('zh');

  await test('default share is readable Markdown HTML with an encoded native Obsidian link', async () => {
    const response = await fetch(url);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vary'), 'Accept');
    const html = await response.text();
    assert.match(html, /<h1>好 软件 #1\.md<\/h1>/);
    assert.match(html, /<h1>本周计划<\/h1>/);
    assert.match(html, /<table>/);
    assert.match(html, /<pre><code class="language-js">/);
    assert.match(html, /来自项目讨论的背景。/);
    assert.match(html, /在 Obsidian 中打开/);
    const open = new URL(openLink(html));
    assert.equal(open.protocol, 'obsidian:');
    assert.equal(open.hostname, 'open');
    assert.equal(open.searchParams.get('vault'), path.basename(root));
    assert.equal(open.searchParams.get('file'), file);
    const meta = metadata(html);
    assert.equal(meta.kind, 'file');
    assert.equal(meta.api.read, new URL(url).pathname);
    assert.equal(meta.api.update, `/api/shares/${share.id}`);
    assert.match(meta.hint, /PATCH/);
    assert.equal(Object.hasOwn(meta, 'content'), false);
    assert.equal(Object.hasOwn(meta, 'background'), false);
    assert.equal(Object.hasOwn(meta, 'updated'), false);
    assert.equal(Object.hasOwn(meta, 'filePath'), false);
    assert.ok(!html.includes(full.updated));
    assert.ok(!html.includes(root));
    assert.match(html, /\?detail=1/);
  });

  await test('copied share URLs and returned write links stay HTML regardless of Accept headers', async () => {
    const created = await (await fetch(base + '/api/nodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '展示链接', content: '写入后的正文' }) })).json();
    for (const link of [url, created.data.link]) {
      for (const accept of ['application/json', 'application/json, text/plain, */*', 'text/html', '*/*']) {
        const response = await fetch(link, { headers: { accept } });
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(await response.text(), /<article>/);
      }
      const json = await fetch(link + '?format=json', { headers: { accept: 'text/html' } });
      assert.match(json.headers.get('content-type'), /application\/json/);
      assert.equal((await json.json()).ok, true);
    }
  });

  await test('raw HTML, links and metadata cannot inject active page content', async () => {
    const response = await fetch(url);
    const html = await response.text();
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /base-uri 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(html, /&lt;script&gt;globalThis\.compromised/);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.equal((html.match(/<script\b/g) || []).length, 1);
    assert.equal((html.match(/<\/script>/g) || []).length, 1);
    const node = await store.createNode({ title: '</title><script>alert(1)</script>', content: '<iframe src="http://evil.invalid"></iframe>', background: '<img src=x onerror=alert(1)>' });
    const nodeShare = await store.createShare(node.id);
    const attack = await (await fetch(resolve(nodeShare.id))).text();
    assert.ok(!attack.includes('<iframe'));
    assert.ok(!attack.includes('<img src=x'));
    assert.match(attack, /&lt;\/title&gt;/);
    assert.equal((attack.match(/<script\b/g) || []).length, 1);
  });

  await test('JSON negotiation is compact by default and detail=1 restores complete metadata', async () => {
    for (const options of [{ suffix: '?format=json', headers: { accept: 'text/html' } }, { suffix: '?format=json', headers: { accept: 'application/json' } }]) {
      const response = await fetch(url + options.suffix, { headers: options.headers });
      assert.match(response.headers.get('content-type'), /application\/json/);
      const { data } = await response.json();
      assert.equal(data.content, content);
      assert.equal(data.updated, undefined);
      assert.equal(data.filePath, undefined);
    }
    const detailed = await (await fetch(url + '?format=json&detail=1')).json();
    assert.equal(detailed.data.updated, full.updated);
    assert.equal(detailed.data.filePath, path.join(root, file));
    const response = await fetch(url + '?detail=1');
    const html = await response.text();
    assert.equal(metadata(html).updated, full.updated);
    assert.equal(metadata(html).filePath, path.join(root, file));
    assert.match(html, /<dt>更新时间<\/dt>/);
    const forcedHtml = await fetch(url + '?format=html', { headers: { accept: 'application/json' } });
    assert.match(forcedHtml.headers.get('content-type'), /text\/html/);
    const raw = await fetch(url + '?raw=1&format=json', { headers: { accept: 'application/json' } });
    assert.match(raw.headers.get('content-type'), /text\/plain/);
    assert.equal(await raw.text(), content);
  });

  await test('excerpts retain scope and position without disclosing unshared surrounding text', async () => {
    const source = 'not-shared-before\n\nSelected **content**\n\nnot-shared-after';
    await fs.writeFile(path.join(root, 'excerpt.md'), source);
    const selected = await store.createPathShare('excerpt.md', '', 'Selected **content**');
    const html = await (await fetch(resolve(selected.id))).text();
    assert.match(html, /这是分享的选段，不是全文。/);
    assert.match(html, /Selected <strong>content<\/strong>/);
    assert.doesNotMatch(html, /not-shared-before|not-shared-after/);
    const meta = metadata(html);
    assert.equal(meta.selection.scope, 'selection');
    assert.equal(meta.selection.position.startLine, 3);
    assert.ok(meta.selection.coverage < 1);
    assert.match(meta.hint, /PATCH 只替换该片段/);
    assert.equal(new URL(openLink(html)).searchParams.get('file'), 'excerpt.md');
  });

  await test('folder and file-set pages preserve their scope and omit absolute paths unless detailed', async () => {
    await fs.writeFile(path.join(root, 'myNote', 'odd<svg onload=alert(1)>.md'), 'content');
    const folder = await store.createPathShare('myNote');
    const page = await (await fetch(resolve(folder.id))).text();
    assert.match(page, /这里只列出文件夹的第一层内容。/);
    assert.ok(page.includes('odd&lt;svg onload=alert(1)&gt;.md'));
    assert.equal(openLink(page), undefined);
    assert.equal(metadata(page).api.update, undefined);
    assert.ok(!/<svg onload/.test(page));
    assert.ok(page.includes('\\u003csvg'));
    const set = await store.createFilesShare([file, 'excerpt.md']);
    const html = await (await fetch(resolve(set.id))).text();
    assert.match(html, /这是多文件清单，不包含文件正文。/);
    assert.equal(openLink(html), undefined);
    assert.equal(metadata(html).files.length, 2);
    assert.ok(metadata(html).files.every(item => !Object.hasOwn(item, 'filePath')));
    const detailed = metadata(await (await fetch(resolve(set.id) + '?detail=1')).text());
    assert.ok(detailed.files.every(item => path.isAbsolute(item.filePath)));
    assert.doesNotMatch(html, /Selected \*\*content\*\*|已有资料参与新工作/);
  });

  await test('native links follow renamed and archived nodes and do not target files outside this vault', async () => {
    const node = await store.createNode({ title: '旧标题', content: 'same note' });
    const link = resolve((await store.createShare(node.id)).id);
    const before = openLink(await (await fetch(link)).text());
    await store.updateNode(node.id, { title: '新标题', archived: true });
    const after = new URL(openLink(await (await fetch(link)).text()));
    assert.notEqual(after.href, before);
    assert.equal(after.searchParams.get('file'), await store.nodeFilePath(node.id));
    const externalFile = path.join(temp, 'external.md');
    await fs.writeFile(externalFile, 'external content');
    const external = await store.createNode({ title: '外部文件', type: 'file', path: externalFile, content: '' });
    const externalShare = await store.createShare(external.id);
    assert.equal(openLink(await (await fetch(resolve(externalShare.id))).text()), undefined);
  });

  await test('English page labels and activity attribution survive HTML reads', async () => {
    setLanguage('en');
    const before = (await store.listActivity()).length;
    const html = await (await fetch(url, { headers: { 'x-agentnote-agent-name': 'Codex', 'x-agentnote-session-title': encodeURIComponent('Share page test') } })).text();
    assert.match(html, /lang="en"/);
    assert.match(html, />Open in Obsidian<\/a>/);
    assert.match(html, />Details<\/a>/);
    assert.match(html, /本周计划/);
    const events = await store.listActivity();
    assert.equal(events.length, before + 1);
    assert.equal(events[0].actor.name, 'Codex');
    assert.equal(events[0].actor.sessionTitle, 'Share page test');
    if (process.env.AGENTNOTE_SHARE_PREVIEW) {
      await fs.mkdir(process.env.AGENTNOTE_SHARE_PREVIEW, { recursive: true });
      setLanguage('zh');
      const previewNode = await store.createNode({ title: '项目行动计划', content: '把已有的研究和方法，整理成下一步可以执行的行动。\n\n## 本周重点\n\n- 整理项目背景与已有判断\n- 确认需要补充的资料\n- 把讨论结论写回笔记库\n\n## 行动清单\n\n| 事项 | 状态 |\n| --- | --- |\n| 复用已有研究 | 已完成 |\n| 形成下一步方案 | 进行中 |', background: '结合项目研究与讨论记录形成，供本周推进时参考。' });
      const previewUrl = resolve((await store.createShare(previewNode.id)).id);
      for (const [name, suffix] of [['compact', ''], ['detail', '?detail=1']]) {
        await fs.writeFile(path.join(process.env.AGENTNOTE_SHARE_PREVIEW, name + '.html'), await (await fetch(previewUrl + suffix)).text());
      }
    }
  });
  console.log(`${passed} share-page checks passed`);
} finally {
  setLanguage('zh');
  await server.stop();
  await fs.rm(temp, { recursive: true, force: true });
}
