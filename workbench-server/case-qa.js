'use strict';

const SCHEME_HEADING = /^##\s*方案[一二三四五六七八九十\d]+(?:\s*[｜：:].*)?\s*$/gm;
const PROMPT_HEADING = /^###\s*Seedance提示词（片段\d+）\s*$/gm;
const CUE = /字幕时码[：:]\s*(\d{2}):(\d{2}(?:\.\d{1,3})?)\s*-->\s*(\d{2}):(\d{2}(?:\.\d{1,3})?)\s*[｜|]\s*([^｜|\r\n]+)[｜|]\s*([^\r\n]+)/g;
const FULL_ORIGINAL = new Set(['short', 'long', 'curious']);

function chunks(text, heading) {
  const matches = [...String(text || '').matchAll(heading)];
  return matches.map((match, index) => ({ body: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length) }));
}

function validateCuriousOpening(prompt) {
  const line = String(prompt || '').match(/^前三秒钩子[：:]\s*0(?:\.0+)?[-–—~至到]3(?:\.0+)?秒[｜|]\s*(.+)$/m)?.[1];
  const beats = line?.split('→').map(item => item.trim()).filter(Boolean) || [];
  if (beats.length !== 3 || beats.some(item => item.length < 4 || /^(震惊|悬疑|猎奇|反转)$/.test(item))) {
    return ['猎奇首段须写“前三秒钩子：0.00-3.00秒｜具体异变→可见后果→人物动作”，三拍均为可拍画面'];
  }
  return [];
}

function validateGenerationPrompt(prompt, duration, mode) {
  const errors = [], text = String(prompt || '').trim();
  if (!text) return ['Seedance提示词为空'];
  if (/\?{4,}|�/.test(text)) errors.push('提示词包含疑似乱码');
  if (/@图片\s*\d+/.test(text)) errors.push('正式提示词不得带入原片人物参考图');
  if (!/无字幕|干净无字|禁止字幕/.test(text)) errors.push('未写明生成无字幕画面');
  if (!/对白|台词|说话/.test(text)) errors.push('未写明同期对白和说话人');
  if (!/配乐|音乐|BGM/i.test(text)) errors.push('未写明低音量配乐及对白期间压低');
  const cues = [...text.matchAll(CUE)].map(match => ({ start: Number(match[1]) * 60 + Number(match[2]), end: Number(match[3]) * 60 + Number(match[4]), speaker: match[5].trim(), text: match[6].trim() }));
  if (!cues.length) errors.push('缺少“字幕时码｜说话人｜准确对白”');
  cues.forEach((cue, index) => {
    if (!cue.speaker || !cue.text || cue.end <= cue.start || cue.start < 0 || cue.end > duration + 0.05) errors.push(`第${index + 1}句字幕时码、说话人或对白无效`);
    if (index && cue.start < cues[index - 1].end - 0.05) errors.push(`第${index + 1}句字幕与上一句重叠`);
  });
  if (FULL_ORIGINAL.has(mode) && !/衔接完整原片[：:]\s*《[^》]+\.(?:mp4|mov|mkv|webm)》\s*00:00:00\.000\s*｜\s*首句[：:]\s*[^｜\r\n]+\s*｜\s*首帧[：:]\s*[^\r\n]+/i.test(text)) errors.push('缺少唯一原片0秒的文件、首句和首帧衔接信息');
  if (mode === 'remake' && !/接回原片[：:]\s*00:\d{2}\.\d{3}/.test(text)) errors.push('复刻提示词缺少精确接回原片时码');
  return [...new Set(errors)];
}

function validateCase(content, input = {}) {
  const errors = [], warnings = [];
  const schemes = chunks(String(content || ''), SCHEME_HEADING);
  const expected = Number(input.count || 3);
  if (schemes.length !== expected) errors.push(`需要${expected}条方案，实际只有${schemes.length}条`);
  const hooks = [];
  schemes.forEach((scheme, schemeIndex) => {
    const label = `方案${schemeIndex + 1}`;
    const hook = scheme.body.match(/^钩子[：:]\s*(.+)$/m)?.[1]?.trim();
    if (!hook) errors.push(`${label}缺少钩子`); else hooks.push(hook);
    const blocks = chunks(scheme.body, PROMPT_HEADING);
    if (!blocks.length) errors.push(`${label}缺少完整Seedance提示词代码块`);
    blocks.forEach((block, blockIndex) => {
      const prefix = `${label}片段${blockIndex + 1}`;
      const prompt = block.body.match(/```(?:text)?\s*\r?\n([\s\S]*?)\r?\n```/)?.[1]?.trim() || '';
      if (!prompt) { errors.push(`${prefix}提示词代码块为空`); return; }
      const params = block.body.match(/生成参数建议[：:]\s*(\d+)秒\s*｜\s*(?:9:16|16:9|1:1)\s*｜\s*720p\s*｜\s*生成对白和环境音\s*｜\s*无水印/);
      if (!params) { errors.push(`${prefix}生成参数不完整`); return; }
      const duration = Number(params[1]);
      if (duration < 4 || duration > 15) errors.push(`${prefix}时长必须在4至15秒之间`);
      if (input.mode === 'curious' && blockIndex === 0) errors.push(...validateCuriousOpening(prompt).map(item => `${prefix}：${item}`));
      errors.push(...validateGenerationPrompt(prompt, duration, input.mode).map(item => `${prefix}：${item}`));
    });
    const captions = [...scheme.body.matchAll(/^\s*-\s*文案[123][：:]\s*(.+)$/gm)];
    if (captions.length !== 3) errors.push(`${label}需要3句独立的无声吸睛文案`);
    captions.forEach((line, index) => {
      const item = line[1].match(/^(.+?)\s*｜\s*黄色重点[：:]\s*([^｜]*)\s*｜\s*红色反转[：:]\s*([^｜]*)\s*$/);
      if (!item) { errors.push(`${label}文案${index + 1}格式不完整`); return; }
      const caption = item[1].trim(), yellow = item[2].trim(), red = item[3].trim();
      if (caption.length > 28 || (yellow && !caption.includes(yellow)) || (red && !caption.includes(red))) errors.push(`${label}文案${index + 1}超长或强调词不在原句中`);
    });
  });
  if (new Set(hooks).size !== hooks.length) errors.push('不同方案的钩子重复');
  if (!input.source && !input.remakeOriginalVideo) warnings.push('未提供可读原片，仅为脚本草案；不得进入付费生成或标记衔接已核验');
  return { ok: errors.length === 0, errors, warnings, schemeCount: schemes.length };
}

module.exports = { validateCase, validateGenerationPrompt, validateCuriousOpening };
