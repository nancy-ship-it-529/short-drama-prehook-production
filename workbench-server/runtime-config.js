const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const root = __dirname;
const localFile = path.join(root, '.local-config.json');
const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {};
const value = (key, fallback) => process.env[key] || local[key] || fallback;
const nativeRuntime = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies');
const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const bundledPython = path.join(nativeRuntime, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
const magicFFmpeg = path.join(process.env.ProgramFiles || 'C:/Program Files', 'magic-cut', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

// Only explicit recipient configuration is read. No bundled credential defaults.
const credentialFile = value('ZLHUB_CONFIG_PATH', path.join(root, 'credentials.env'));
if (fs.existsSync(credentialFile)) {
  for (const line of fs.readFileSync(credentialFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && /^(ZLHUB_|TOS_)/.test(match[1]) && match[2] && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
process.env.ZLHUB_CONFIG_PATH = credentialFile;
const python = value('PYTHON_BIN', value('ZLHUB_PYTHON', fs.existsSync(venvPython) ? venvPython : fs.existsSync(bundledPython) ? bundledPython : 'python'));
const ocrVenv = path.join(root, '.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const ffmpeg = value('FFMPEG_BIN', fs.existsSync(magicFFmpeg) ? magicFFmpeg : 'ffmpeg');
const ocrPython = value('OCR_PYTHON', fs.existsSync(ocrVenv) ? ocrVenv : python);
const zlhubScripts = value('ZLHUB_SCRIPTS', path.join(root, 'connectors'));
const tosScript = value('TOS_SCRIPT', path.join(root, 'connectors', 'tos_upload.py'));
if (process.env.TOS_AK && !process.env.TOS_ACCESS_KEY) process.env.TOS_ACCESS_KEY = process.env.TOS_AK;
if (process.env.TOS_SK && !process.env.TOS_SECRET_KEY) process.env.TOS_SECRET_KEY = process.env.TOS_SK;
const config = {
  port: Number(value('WORKBENCH_PORT', 3217)),
  workspace: path.resolve(value('WORKBENCH_WORKSPACE', path.join(root, '..'))),
  codex: value('CODEX_BIN', 'codex'), python, ocrPython, ffmpeg, zlhubScripts,
  tosPython: value('TOS_PYTHON', python), tosScript,
};
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('WORKBENCH_PORT 无效');
Object.assign(process.env, { FFMPEG_BIN: ffmpeg, OCR_PYTHON: ocrPython, ZLHUB_SCRIPTS: zlhubScripts });
function binaryReady(command, args = ['--version']) {
  const result = spawnSync(command, args, { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  return !result.error && result.status === 0;
}
function capabilities() {
  const modelReady = Boolean(process.env.ZLHUB_API_BASE && process.env.ZLHUB_API_KEY);
  const pythonReady = binaryReady(python);
  const ocrReady = pythonReady && binaryReady(ocrPython, ['-c', 'import rapidocr_onnxruntime, cv2']);
  return {
    seedance: { available: modelReady && pythonReady && fs.existsSync(path.join(zlhubScripts, 'run_seedance_task.py')), provider: 'ZLHub', configured: modelReady },
    geminiReview: { available: modelReady && pythonReady, provider: 'doubao-seed-2.1-pro', threshold: 80, maxRetries: 2 },
    batchVoice: { available: pythonReady && binaryReady(python, ['-c', 'import edge_tts']), provider: 'Edge TTS' },
    autoEdit: { available: binaryReady(ffmpeg, ['-version']), provider: 'FFmpeg' },
    ocr: { available: ocrReady, provider: 'RapidOCR' },
    delivery: { available: pythonReady && fs.existsSync(tosScript) && Boolean(process.env.TOS_ACCESS_KEY && process.env.TOS_SECRET_KEY && process.env.TOS_BUCKET), provider: '自行配置的TOS组件', mode: 'permanent-public-link' },
  };
}
module.exports = { ...config, capabilities };
