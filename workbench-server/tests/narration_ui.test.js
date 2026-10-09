const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch(require('./browser-options'));
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:3217/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if(pathname==='/')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8')});
      if(pathname==='/api/library')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{id:'test-video',dramaTitle:'测试剧',sourceMode:'single',state:'final_succeeded',createdAt:'2026-10-08T00:00:00Z',finalOutput:'C:\\test.mp4',finalVideoUrl:'/test.mp4',prehookCaptions:[{text:'她没想到，秘密就在眼前。',yellow:'秘密',red:'眼前'},{text:'他藏了三年的身份，今天露馅。',yellow:'身份',red:'露馅'},{text:'这次开门，她看见了那个人。',yellow:'开门',red:'那个人'}]}]})});
      return route.continue();
    });
    await page.route('**/api/narration/draft', route => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: 'ui-test-draft' }) }));
    await page.route('**/api/narration/draft/ui-test-draft', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'completed', candidates: ['她没想到，秘密就在眼前。', '他藏了三年的身份，今天露馅。', '这次开门，她看见了那个人。'], highlights: [{ yellow: '秘密', red: '眼前' }, { yellow: '身份', red: '露馅' }, { yellow: '开门', red: '那个人' }], evidence: '测试候选', uncertainty: '需预览' }) }));
    const submitted=[];
    await page.route('**/api/narration/create', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: `ui-test-create-${submitted.length}` }) }); });
    await page.route(/\/api\/narration\/ui-test-create-\d+$/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'succeeded', narrationEnd: 7.5, videoUrl: '/test.mp4', output: 'C:\\test.mp4' }) }));
    await page.goto('http://127.0.0.1:3217/#library', { waitUntil: 'domcontentloaded' });
    await page.locator('.add-library-narration').first().waitFor({ state: 'attached', timeout: 30000 });
    assert.equal(await page.locator('.page-tab[data-page="narration"]').count(), 0, '不应保留独立旁白导航');
    await page.locator('.add-library-narration').first().dispatchEvent('click');
    await page.locator('.library-narration-candidate').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.library-narration-candidate').first().dispatchEvent('click');
    assert.equal(await page.locator('#libraryNarrationText').inputValue(), '“她没想到，秘密就在眼前。”');
    assert.equal(await page.locator('#libraryNarrationYellow').inputValue(), '秘密');
    assert.equal(await page.locator('#libraryNarrationRed').inputValue(), '眼前');
    await page.locator('.library-narration-select').nth(1).check();
    await page.locator('#createLibraryNarration').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#libraryNarrationStatus').textContent.includes('完成 2/2 条'), { timeout: 15000 });
    assert.equal(submitted.length,2);
    assert(submitted[0].libraryMode && submitted[0].sourceSeedanceId, '必须绑定成片库来源');
    assert.equal(submitted[0].displayOnly, true, '不能生成配音');
    assert(submitted[0].maxEndSeconds > 0 && submitted[0].maxEndSeconds <= 10);
    assert.equal(submitted[0].voice, undefined);
    assert.equal(submitted[0].accentYellow, '秘密');
    assert.equal(submitted[0].speedFactor,1);
    assert.equal(submitted[1].speedFactor,1.1);
    assert.deepEqual(errors, []);
    console.log('成片库画面文案入口、三句候选、强调词及保留原声参数正常');
  } finally {
    await Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
