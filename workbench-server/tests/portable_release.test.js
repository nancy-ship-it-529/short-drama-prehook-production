const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('clean recipient can open four-mode UI and empty library without shared credentials', async () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prehook-release-'));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  fs.mkdirSync(path.join(temp, 'public'));
  for (const file of ['server.js', 'runtime-config.js']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  fs.copyFileSync(path.join(root, 'public/index.html'), path.join(temp, 'public/index.html'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ZLHUB_|TOS_|WORKBENCH_|PYTHON_BIN|OCR_PYTHON|CODEX_BIN)/.test(key)) delete env[key];
  Object.assign(env, { WORKBENCH_PORT: String(port), WORKBENCH_WORKSPACE: temp, PYTHON_BIN: process.execPath, OCR_PYTHON: process.execPath, CODEX_BIN: process.execPath, FFMPEG_BIN: path.join(temp, 'missing-ffmpeg') });
  const child = spawn(process.execPath, [path.join(temp, 'server.js')], { cwd: temp, env, stdio: 'ignore', windowsHide: true });
  try {
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { health = await (await fetch(base + '/api/health')).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 150)); }
    }
    assert.equal(health?.ok, true);
    assert.equal(health.version, '3.4.0');
    assert.deepEqual(health.modes, ['short', 'long', 'remake', 'curious']);
    assert.equal(health.ocrInstalled, false);
    const page = await (await fetch(base + '/')).text();
    assert(page.includes('data-mode="curious"') && page.includes('四个流程同时开始制作'));
    assert(page.includes('3.4.0') && page.includes('成片库'));
    assert.deepEqual((await (await fetch(base + '/api/library')).json()).items, []);
    assert.deepEqual((await (await fetch(base + '/api/batches')).json()).batches, []);
    const capabilities = await (await fetch(base + '/api/pipeline/capabilities')).json();
    assert.equal(capabilities.seedance.available, false);
    assert.equal(capabilities.geminiReview.available, false);
    assert.equal(capabilities.delivery.available, false);
    assert.equal(capabilities.autoEdit.available, false);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert(path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('prehook-release-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
