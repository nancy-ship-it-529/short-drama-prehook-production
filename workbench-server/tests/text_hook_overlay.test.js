const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runtime = require('../runtime-config');
const ffmpeg = runtime.ffmpeg;
const python = runtime.python;
const script = path.join(__dirname, '..', 'scripts', 'text_hook_overlay.py');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prehook-text-test-'));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function audioHash(file) {
  return run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'SHA256', '-']).trim();
}

try {
  const source = path.join(testDir, 'source.mp4');
  run(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=0x233047:s=640x360:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source]);
  const outputDir = path.join(testDir, 'out');
  const request = path.join(testDir, 'request.json');
  fs.writeFileSync(request, JSON.stringify({ source_video: source, output_dir: outputDir, narration: '女子发现王府秘密，真相竟在眼前', accent_yellow: '王府秘密', accent_red: '真相', start_seconds: 0, max_end_seconds: 8.5 }));
  const result = JSON.parse(run(python, [script, '--request-file', request]));
  assert.equal(result.display_only, true);
  assert.equal(result.audio_mode, 'copy');
  assert(Math.abs(result.duration - 12) < 0.25);
  assert(result.layout_sample_count >= 2, '须先从底片抽帧排版');
  assert(fs.existsSync(result.layout_preview), '须保留截图选位预览');
  const layout = JSON.parse(fs.readFileSync(result.layout_report, 'utf8'));
  assert.deepEqual(layout.selected_box, result.layout_box);
  assert(layout.selected_box[3] < 360 * 0.7, '文案不能进入常见底部字幕区');
  const selected = layout.candidates.find(item => item.box.join(',') === layout.selected_box.join(','));
  assert(selected && !selected.text_collisions && !selected.face_collisions && !selected.subject_risk, '选位不能覆盖已检出的原文字或人物安全区');
  assert.equal(audioHash(source), audioHash(result.output), '原声音轨不得改变');
  const ass = fs.readFileSync(path.join(outputDir, 'hook_text.ass'), 'utf8');
  assert(ass.includes('王府秘密') && ass.includes('真相'), '强调词不能被拆行');
  assert(ass.includes('0:00:08.50'), '文案应在8.5秒消失');
  const fastDir = path.join(testDir, 'fast-out');
  fs.writeFileSync(request, JSON.stringify({ source_video: source, output_dir: fastDir, narration: '“女子发现王府秘密，真相竟在眼前”', accent_yellow: '王府秘密', accent_red: '真相', start_seconds: 0, max_end_seconds: 8.5, speed_factor: 1.1 }));
  run(python, [script, '--request-file', request]);
  const fast = JSON.parse(fs.readFileSync(path.join(fastDir, 'manifest.json'), 'utf8'));
  assert.equal(fast.narration, '女子发现王府秘密，真相竟在眼前');
  assert.equal(fast.audio_mode, 'atempo');
  assert.equal(fast.speed_factor, 1.1);
  assert(Math.abs(fast.duration - 12 / 1.1) < 0.3, '倍速版本须压缩完整底片而非随意截断');
  assert(audioHash(fast.output), '倍速版本须保留音轨');
  if (process.env.KEEP_TEXT_HOOK_TEST === '1') {
    const frame = path.join(testDir, 'preview-2s.png');
    run(ffmpeg, ['-hide_banner', '-y', '-ss', '2', '-i', result.output, '-frames:v', '1', frame]);
    console.log('预览帧：' + frame);
  }
  console.log('文字叠加成片可读，原音轨未改，文字按指定秒数消失');
} finally {
  const normalized = path.resolve(testDir);
  assert(normalized.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(normalized).startsWith('prehook-text-test-'));
  if (process.env.KEEP_TEXT_HOOK_TEST !== '1') fs.rmSync(normalized, { recursive: true, force: true });
}
