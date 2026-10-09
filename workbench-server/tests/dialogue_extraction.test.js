const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const match = source.match(/function extractExactDialogue\([\s\S]*?\n}\n\nfunction extractSpliceTarget/);
assert.ok(match, 'extractExactDialogue function exists');
const fn = vm.runInNewContext(`${match[0].replace(/\n\nfunction extractSpliceTarget$/, '')}\nextractExactDialogue`);

const prompt = '女主说：“我叫盛楠。” 后接原片“C:\\测试\\番茄\\重生后谁还嫁富二代\\TX16.mp4”，男主说：“赶紧跳啊。”';
assert.equal(fn(prompt), '我叫盛楠。\n赶紧跳啊。');
assert.equal(fn('字幕时码：00:00.100 --> 00:01.300｜盛楠｜我叫盛楠。'), '[0.100-1.300]我叫盛楠。');
console.log('Dialogue extraction checks passed');
