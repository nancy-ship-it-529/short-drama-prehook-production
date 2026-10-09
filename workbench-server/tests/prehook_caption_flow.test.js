const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');

const serverFile = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverFile, 'utf8');
const context = { require: require('module').createRequire(serverFile), __dirname: path.dirname(serverFile), process, Buffer, console };
vm.runInNewContext(`${source.split('const server = http.createServer')[0]}\nglobalThis.testing = { MODES, buildPrompt, normalizePrehookCaptions };`, context, { filename: serverFile });
const { MODES, buildPrompt, normalizePrehookCaptions } = context.testing;
const input = { dramaTitle: '测试剧', summary: '成年主角发现隐藏秘密。', source: '', count: 3, notes: '' };
for (const mode of Object.values(MODES)) {
  const prompt = buildPrompt(input, mode);
  assert(prompt.includes('吸睛画面文案（无声备选）'), `${mode.label} 缺少预生成文案规则`);
  assert(prompt.includes('不写进Seedance提示词代码块'), `${mode.label} 未隔离Seedance提示词`);
}
assert.equal(normalizePrehookCaptions([{ text: '秘密就在门后', yellow: '秘密', red: '门后' }, { text: 'x'.repeat(29) }]).length, 1);

const captions = [
  { text: '他以为门后没人，秘密却在里面', yellow: '门后', red: '秘密' },
  { text: '婚房的门一开，藏着的人现身', yellow: '婚房', red: '藏着的人' },
  { text: '一声开门声，让他看清了真相', yellow: '开门声', red: '真相' }
];
const markdown = `## 方案一\n钩子：门被推开。\n### Seedance提示词（片段1）\n\`\`\`text\n成年男人推开门，低声说：“里面有人？”\n衔接完整原片：《测试.mp4》00:00:00.000\n\`\`\`\n生成参数建议：8秒｜9:16｜720p｜生成对白和环境音｜无水印\n### 吸睛画面文案（无声备选）\n${captions.map((item, index) => `- 文案${index + 1}：${item.text}｜黄色重点：${item.yellow}｜红色反转：${item.red}`).join('\n')}`;

(async () => {
  const browser = await chromium.launch(require('./browser-options'));
  try {
    const page = await browser.newPage();
    const errors = [];
    let submitted = null;
    let draftCalls = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:3217/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const fulfill = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8') });
      if (pathname === '/api/tasks/test-task/artifact') return fulfill({ name: '测试脚本', content: markdown });
      if (pathname === '/api/batches') return fulfill({ batches: [{ id: 'test-batch', createdAt: '2026-10-08T00:00:00Z', dramaTitle: '测试剧', state: 'completed', progress: 100, modes: ['short'], tasks: [{ id: 'test-task', mode: 'short', state: 'completed', progress: 100, result: '已生成' }] }] });
      if (pathname === '/api/seedance/prepare') { submitted = route.request().postDataJSON(); return fulfill({ id: 'mock-prepare', payload: { model: 'test' }, preparedImages: [] }); }
      if (pathname === '/api/library') return fulfill({ items: [{ id: 'test-video', dramaTitle: '测试剧', sourceTaskId: 'test-task', sourceMode: 'single', state: 'final_succeeded', createdAt: '2026-10-08T00:00:00Z', finalOutput: 'C:\\test.mp4', finalVideoUrl: '/test.mp4', prompt: '测试提示词', prehookCaptions: captions }] });
      if (pathname === '/api/narration/draft') { draftCalls += 1; return fulfill({ id: 'unexpected-draft' }); }
      return fulfill({});
    });
    await page.goto('http://127.0.0.1:3217/#tasks', { waitUntil: 'domcontentloaded' });
    await page.locator('.view-case[data-task="test-task"]').first().dispatchEvent('click');
    await page.locator('.generate-seedance').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.case-section .copy-prompt').count(), 1);
    assert.equal(await page.locator('.case-section').first().getByText(captions[0].text).count(), 1);
    await page.locator('.generate-seedance').first().dispatchEvent('click');
    assert(!(await page.locator('#seedancePrompt').inputValue()).includes('吸睛画面文案'));
    await page.locator('#prepareSeedance').dispatchEvent('click');
    await page.waitForFunction(() => !document.querySelector('#seedancePayload').hidden);
    assert.deepEqual(submitted.prehookCaptions, captions);
    await page.locator('#closeSeedance').dispatchEvent('click');
    await page.locator('.page-tab[data-page="library"]').dispatchEvent('click');
    await page.locator('[data-open-drama="0"]').dispatchEvent('click');
    await page.locator('.add-library-narration').dispatchEvent('click');
    assert.equal(await page.locator('.library-narration-candidate').count(), 3);
    assert.equal(draftCalls, 0, '已有预生成文案时不应再次消耗 Codex 额度');
    await page.locator('.library-narration-candidate').first().dispatchEvent('click');
    assert.equal(await page.locator('#libraryNarrationText').inputValue(), `“${captions[0].text}”`);
    assert.equal(await page.locator('.library-narration-select:checked').count(), 1);
    assert.deepEqual(errors, []);
    console.log('四类脚本预生成文案、Seedance隔离、成片库复用均通过');
  } finally {
    await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
