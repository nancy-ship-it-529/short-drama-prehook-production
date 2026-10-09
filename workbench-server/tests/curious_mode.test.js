const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');

const serverFile = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverFile, 'utf8');
const beforeServer = source.split('const server = http.createServer')[0];
const context = { require: require('module').createRequire(serverFile), __dirname: path.dirname(serverFile), process, Buffer, console };
vm.runInNewContext(`${beforeServer}\nglobalThis.testing = { MODES, MODE_ORDER, buildPrompt, extractSpliceTarget };`, context, { filename: serverFile });
const { MODES, MODE_ORDER, buildPrompt, extractSpliceTarget } = context.testing;
assert.equal(MODES.curious.skill, 'curious-prehook');
assert.deepEqual(Array.from(MODE_ORDER), ['short', 'long', 'remake', 'curious'], '猎奇应成为默认第四路');
const prompt = buildPrompt({ dramaTitle: '测试剧', summary: '成年主角发现一个反常线索并查明真相。', source: '', genre: '都市悬疑', count: 3, notes: '' }, MODES.curious);
assert(prompt.includes('$short-drama-prehook-production'));
assert(prompt.includes('不要套用递进栏固定的动物施救报恩模板'));
assert(prompt.includes('前三秒钩子：0.00-3.00秒'));
assert(prompt.includes('道具指甲片') && prompt.includes('发束瞬间散落') && prompt.includes('黄鼠狼灵影'));
assert(prompt.includes('00:00:00.000'));
assert(!prompt.includes('递进剧情紧凑告知固定使用'));
assert.throws(() => extractSpliceTarget('衔接完整原片：《C:\\素材\\测试.mp4》00:00:03.000', '', 'curious'), /不能裁剪原片/);

(async () => {
  const browser = await chromium.launch(require('./browser-options'));
  try {
    const page = await browser.newPage();
    const errors = [];
    const submitted = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:3217/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8') });
      if (pathname === '/api/batches' && route.request().method() === 'POST') {
        submitted.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: 'curious-test-batch' }) });
      }
      const data = pathname === '/api/batches' ? { batches: [] } : pathname === '/api/library' ? { items: [] } : pathname === '/api/health' ? { codexLoggedIn: true, ocrInstalled: true } : {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto('http://127.0.0.1:3217/#workbench', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('.modes .mode.active').count(), 4);
    assert.equal(await page.locator('#workflow').count(), 0, '不再单独选择猎奇流程');
    assert.equal(await page.locator('#run').innerText(), '四个流程同时开始制作');
    await page.locator('#dramaTitle').fill('测试剧');
    await page.locator('#summary').fill('成年主角发现一个反常线索并查明真相。');
    await page.locator('#run').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('curious-test-batch'));
    assert.equal(submitted[0].mode, 'default');
    assert.deepEqual(errors, []);
    console.log('猎奇默认并列入口、提示词路由与原片边界均通过');
  } finally {
    await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
