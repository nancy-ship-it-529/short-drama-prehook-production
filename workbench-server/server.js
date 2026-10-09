const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const runtime = require('./runtime-config');
const { validateCase, validateGenerationPrompt } = require(path.join(__dirname, 'case-qa'));

const HOST = '127.0.0.1';
const PORT = runtime.port;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const TASKS = path.join(ROOT, 'tasks');
const BATCHES = path.join(ROOT, 'batches');
const LEARNINGS = path.join(ROOT, 'learnings');
const WORKSPACE = runtime.workspace;
const CODEX = runtime.codex;
const PYTHON = runtime.python;
const ZLHUB_SCRIPTS = runtime.zlhubScripts;
const SEEDANCE_JOBS = path.join(ROOT, 'seedance-jobs');
const SEEDANCE_TEMP = path.join(os.tmpdir(), 'zlhub-workbench');
const POST_JOBS = path.join(ROOT, 'post-jobs');
const POST_OUTPUTS = path.join(WORKSPACE, 'outputs', 'workbench-post');
const NARRATION_JOBS = path.join(ROOT, 'narration-jobs');
const NARRATION_DRAFTS = path.join(ROOT, 'narration-drafts');
const NARRATION_OUTPUTS = path.join(WORKSPACE, 'outputs', 'workbench-narration');
const LIBRARY_OUTPUTS = path.join(WORKSPACE, 'outputs', 'workbench-library');
const REVIEW_JOBS = path.join(ROOT, 'review-jobs');
const BRAND_JOBS = path.join(ROOT, 'brand-jobs');
const BRAND_OUTPUTS = path.join(WORKSPACE, 'outputs', '已选前贴');
const TOS_PYTHON = runtime.tosPython;
const TOS_SCRIPT = runtime.tosScript;
const OCR_PYTHON = runtime.ocrPython;
const OCR_SCRIPT = path.join(ROOT, 'scripts', 'ocr_subtitles.py');
const BRANDING_SCRIPT = path.join(ROOT, 'scripts', 'apply_drama_branding.py');
const FFMPEG = runtime.ffmpeg;
const seedanceProcesses = new Map();

const MODES = {
  short: { skill: 'plot-under-10s', label: '单爆点紧凑告知', duration: '不预设固定总时长；用最短篇幅完成异常画面、直接告知、主角反应和原片衔接' },
  long: { skill: 'plot-over-10s', label: '递进剧情紧凑告知', duration: '通常10至15秒；完整呈现主角救助动物、动物脱困、动物报恩告知、主角立即行动与原片衔接，超过单段生成上限时按完整动作节点拆段' },
  curious: { skill: 'curious-prehook', label: '猎奇类前贴', duration: '默认10至18秒；反常事件、人物行动、后果升级和揭示必须形成紧凑因果，超过Seedance单段15秒时按动作节点拆段' },
  remake: { skill: 'highlight-remake', label: '起量高光复刻去重', duration: '完整复刻起量素材前10秒、15秒或指定区间；时长跟随原高光，超过15秒按完整台词和动作节点拆段' }
};
const MODE_ORDER = ['short', 'long', 'remake', 'curious'];

const UNIFIED_PRODUCTION_RULES = `统一成片规则（所有方案必须执行）：
- 合理合法合规：只设计适合公开展示的文明行为，人物默认使用成年人；不得新增未成年人或婴儿承担告密、受困、受伤、救助、惊吓或危险动作；不得出现低俗、排泄、羞辱、骚扰、恶意泼洒或可模仿的危险行为。
- 剧情逻辑：人物出现、救助、告知、赶路、进门和衔接必须符合真实空间、时间与行动因果。室外偶遇必须发生在合理室外环境；获知家中危机后必须表现回家行动，再衔接原片验证画面，不能为省镜头把不相关人物或动物塞进卧室。
- 剧情紧凑：每条只讲一个爆点，首秒出现冲突或异常，每1至2秒产生一次有效信息变化，删除空镜、重复反应和解释性废话；结尾必须落到行动并能无缝衔接原片。
- 对白与声音：把说话人、逐字对白、语气、语速、停顿和实际开口/结束时码写进Seedance提示词，默认生成Seedance同期原声并保持口型同步。
- 表演情绪：不得只写“急促、愤怒、震惊”等空泛形容词。每句对白必须写清开口前的呼吸或动作、音量强弱、语速、重读词、停顿位置、尾音和说完后的表情动作；同一段至少有一次明确情绪转折。告密者不能机械念稿，主角不能只瞪眼，必须以攥紧道具、压低声音、后退、截断对方或立即行动兑现情绪。
- 音乐与节奏：除非用户明确要求纯环境声，Seedance提示词必须生成与题材匹配的低音量情绪配乐。首秒用短促音效抓注意，对白期间自动压低配乐，反转或行动点增强鼓点，结尾留出可与原片声音衔接的收束；配乐不得盖住对白。
- 前贴加速：Seedance先按完整剧情正常生成，成片后只加速AI前贴，原片保持原速。短促单爆点且对白密度允许时使用1.5倍；递进剧情、猎奇前贴、起量高光复刻、情绪停顿较多或对白密度较高时使用1.2倍。声音、口型和字幕时码必须同步缩放，不能截断台词。
- 字幕声画锁定：Seedance画面默认要求无内置字幕，后期字幕必须使用固定格式“字幕时码：00:02.000 --> 00:05.500｜说话人｜准确对白”。最终时码不得照抄提示词预估值，必须在变速完成后根据最终音轨的ASR/VAD与词级时间重新对齐：首字只能在实际开口后出现，尾字说完即消失；动物叫声、吸气、反应、静音和奔跑区间不得提前挂出下一句字幕。同一句按逗号分句展示，逐句校对说话人和准确对白，OCR与目标文本不一致则不得标记完成。若Seedance意外生成字幕，文字完全正确才保留且不叠第二层；只有个别错字时只定位并修补错字区域；不得用整条黑带或整句重复字幕覆盖画面。
- 原片边界绝不能混用：单爆点、递进剧情、猎奇类前贴只在所选起量高光视频完整文件之前新增AI前贴；高光视频从00:00:00.000开始原样接入，不截掉任何开头画面或声音。先实际查看该完整高光视频的首帧、首句和开场事件，再倒推前贴的结尾动作；如果AI不能接上0秒开头，就重写前贴方案，不能把原片改从中段播放。只有起量高光复刻去重允许用AI重生段替换原片开头，原片从被替换区间的真实结束点接回。
- 原片衔接核验：每个方案必须先实际查看候选原片，再锁定唯一视频、完整绝对路径、模式允许的精确切入时码，以及该点第一句完整台词和首帧画面。多条原片时逐条比对剧情和人物，绝不能选目录第一条或按文件名猜。单爆点/递进/猎奇提示词必须写“衔接完整原片：《文件名.mp4》00:00:00.000｜首句：……｜首帧：……”；复刻提示词写明替换区间与接回原片的毫秒时码。生成前校验实际采用的文件与提示词一致；成片后查看切点前后画面与声音，排除错片、重复句、跳帧、冻帧、黑帧和音频抢入。不确定时停止自动拼接并标记待复核。
- 直接制作：每个方案都必须给出可直接生成的完整Seedance提示词、准确时长、9:16、720p、Seedance原声、无水印和明确的原片衔接动作；只生成付费前确认单，未经用户确认不得创建付费视频任务。`;

fs.mkdirSync(TASKS, { recursive: true });
fs.mkdirSync(BATCHES, { recursive: true });
fs.mkdirSync(LEARNINGS, { recursive: true });
fs.mkdirSync(SEEDANCE_JOBS, { recursive: true });
fs.mkdirSync(SEEDANCE_TEMP, { recursive: true });
fs.mkdirSync(POST_JOBS, { recursive: true });
fs.mkdirSync(POST_OUTPUTS, { recursive: true });
fs.mkdirSync(NARRATION_JOBS, { recursive: true });
fs.mkdirSync(NARRATION_DRAFTS, { recursive: true });
fs.mkdirSync(NARRATION_OUTPUTS, { recursive: true });
fs.mkdirSync(LIBRARY_OUTPUTS, { recursive: true });
fs.mkdirSync(REVIEW_JOBS, { recursive: true });
fs.mkdirSync(BRAND_JOBS, { recursive: true });
fs.mkdirSync(BRAND_OUTPUTS, { recursive: true });

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

let loginStatusPending = null;
let loginStatusCached = null;
let loginStatusCheckedAt = 0;
function codexLoginStatus() {
  if (loginStatusCached && Date.now() - loginStatusCheckedAt < 15000) return Promise.resolve(loginStatusCached);
  if (loginStatusPending) return loginStatusPending;
  loginStatusPending = new Promise(resolve => {
    let child, timer, done = false, stdout = '', stderr = '';
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      loginStatusCached = result;
      loginStatusCheckedAt = Date.now();
      loginStatusPending = null;
      resolve(result);
    };
    try { child = spawn(CODEX, ['login', 'status'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ codexInstalled: false, codexLoggedIn: false, loginMessage: error.message }); return; }
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-2048); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
    child.on('error', error => finish({ codexInstalled: false, codexLoggedIn: false, loginMessage: error.message }));
    child.on('close', code => finish({ codexInstalled: true, codexLoggedIn: code === 0, loginMessage: `${stdout}${stderr}`.trim() }));
    timer = setTimeout(() => { child.kill(); finish({ codexInstalled: true, codexLoggedIn: false, loginCheckTimedOut: true, loginMessage: 'Codex 登录状态检查超时' }); }, 5000);
  });
  return loginStatusPending;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('请求内容过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('JSON格式无效')); }
    });
    req.on('error', reject);
  });
}

function safeWrite(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

const PREHOOK_CAPTION_RULES = `每个“## 方案”在全部Seedance片段和生成参数之后，追加“### 吸睛画面文案（无声备选）”，恰好写三行，格式固定：
- 文案1：一句文案｜黄色重点：文案中的原词｜红色反转：文案中的原词
- 文案2：一句文案｜黄色重点：文案中的原词｜红色反转：文案中的原词
- 文案3：一句文案｜黄色重点：文案中的原词｜红色反转：文案中的原词
每句不超过28个汉字，一句讲清本方案真实呈现的处境、身份反差或悬念；可用剧名，但不能虚构未核实的画面、人物和结局，不照抄人物对白。强调词必须是该句连续原词；不合适时留空。文案只供后期在成片库预选和修改，默认片头显示、最晚第10秒消失，实际时码须看成片核对。它不是画外音，不配音、不压低原声、不写进Seedance提示词代码块或对白字幕时码，也不在生成AI画面时自动烧录。`;

function buildPrompt(input, mode) {
  if (mode.skill === 'highlight-remake') return `使用 $short-drama-prehook-production 的复刻规则完成“${mode.label}”。

剧名：${input.dramaTitle || '未填写，不要自行杜撰剧名'}
作品简介：${input.summary}
仅供反推的开头片段（只分析这个文件）：${input.remakeAnalysisClip || input.source || '未提供，必须明确标为待补素材，不能虚构反推结果。'}
完整原片（禁止分析整片，只用于接回后半段）：${input.remakeOriginalVideo || input.source || '未提供'}
固定替换区间：00:00.000 → 00:${String(Number(input.remakeCutSeconds || 15)).padStart(2, '0')}.000
题材 / 受众：${input.genre || '请根据简介判断'}
方案数量：${input.count}条
复刻时长原则：${mode.duration}
补充要求：${input.notes || '默认优先分析素材开头15秒；如果10秒已经形成完整对话和动作闭环，则以10秒为界。'}

${UNIFIED_PRODUCTION_RULES}

模式优先级：这是“原高光复刻”，若补充要求中含有会说话动物、灵魂告密、救助报恩、另编台词、另做前贴等旧创意要求，一律只视为其他模式的历史备注，在本模式中忽略。不得新编告密角色或新台词；必须复刻源素材目标区间里真实出现的人物、真实对白和真实场景。

这是起量高光画面去重，不是重新编剧情。只读取上面的“仅供反推的开头片段”，不得扫描、抽帧或分析完整原片。逐镜反推该片段内的完整人物、逐字对白、场景、动作、景别、运镜、情绪、节奏和声音入口。人物、对白原意、场景功能、动作因果和悬念落点保持一致；只允许改变构图微差、景别组合、运镜方式、背景陈设和光影细节，不能新增反转或删改关键台词。禁止只用裁切、镜像、滤镜、换字幕或变速冒充去重。

先输出“原高光逐秒还原表”，再输出可直接送入Seedance的重生成提示词。人物参考图必须从开头片段实际截图，但只用于内部核验并明确标为“内部核验图”；环境不编号。默认Seedance提示词不得使用@图片引用，也不得上传原片真人脸，必须把人物改写为虚构成年角色的年龄、发型、脸型、服装和体态文字描述。AI只重生成00:00.000至00:${String(Number(input.remakeCutSeconds || 15)).padStart(2, '0')}.000；成片时用AI片段完整替换原片同一区间，然后从完整原片00:${String(Number(input.remakeCutSeconds || 15)).padStart(2, '0')}.000开始直接接回，绝不重做后续剧情。必须写出一行“接回原片：00:${String(Number(input.remakeCutSeconds || 15)).padStart(2, '0')}.000”。

为了让工作台可以一键带入Seedance，Markdown格式必须严格遵守：
0. 按要求输出恰好${input.count}条“## 方案一/二/三”方案；每个方案正文第一行必须是“钩子：一句来自已核实原片开头的视觉冲突”，不同方案的镜头钩子不得完全重复。
1. 每张人物截图单独一行，写“内部核验图1”和已验证存在的绝对路径，路径必须放在单个反引号内；例如：内部核验图1｜林明远｜人物与服装核验｜原片00:02.4｜\`C:\\绝对路径\\林明远.jpg\`。不得把内部核验图写成正式Seedance的@图片素材。
2. 每个可独立生成的片段必须使用三级标题“### Seedance提示词（片段1）”，标题下只放该片段可以直接复制使用的完整提示词；提示词不得包含任何@图片引用，角色外观全部用文字描述。
3. 每段提示词后使用固定格式“生成参数建议：X秒｜9:16｜720p｜生成对白和环境音｜无水印”，X为4至15的整数；参数不要混入提示词代码块。
4. 内部核验图必须截取并保存到当前任务目录或工作区可访问目录，不能只给时间码、不能写待生成路径、不能用环境图充当人物图；它们不进入正式生成请求。
5. 对白必须写进Seedance提示词，包含说话人、原句、情绪、语速与停顿；禁止只在提示词外另列对白。
5a. 每句对白还须在同一提示词代码块内逐句列出“字幕时码：00:02.000 --> 00:05.500｜说话人｜准确对白”；这些仅为生成目标，不是最终字幕时码，变速后须按实声重对齐。
 6. 最终Seedance提示词只使用正向、文明、可生成的描述；不要为了表达“禁止”而在提示词中重复任何低俗、危险或平台敏感词，统一改写为“画面整洁、自然、适合公开展示，不新增无关元素”。

${PREHOOK_CAPTION_RULES}

遵守文明合规：不得加入贴身衣物投掷、身体废弃物、排泄物、恶意泼洒、羞辱、骚扰或危险模仿。人物素材优先使用成年人，不得为了吸睛新增未成年人、婴儿，不得让未成年人或婴儿承担告密、受困、受伤、救助、惊吓或危险动作，也不要截取其人物参考图。若原高光确有无法替代的未成年人或婴儿，停止直接生成并明确标记“需人工确认”，同时优先提供不改变剧情功能的成年角色替代方案。所有本地路径必须实际存在。只生成脚本与素材清单，不创建付费任务。把结果写入当前任务目录可访问的Markdown文件，并在最终回复中给出路径。`;
  if (mode.skill === 'curious-prehook') return `使用 $short-drama-prehook-production 的猎奇规则制作“猎奇类前贴”，借鉴10S以上告知剧情二创的行动递进和完整对白，但不要套用递进栏固定的动物施救报恩模板。

剧名：${input.dramaTitle || '未填写，不要杜撰剧名'}
作品简介：${input.summary}
原片或高光素材：${input.source || '未提供；只能交脚本草案，不得声称衔接已验证，也不得虚构视频路径。'}
题材 / 受众：${input.genre || '依据简介判断'}
方案数量：${input.count}条
补充要求：${input.notes || '无'}

先按 $short-drama-prehook-production 的猎奇规则，从接收者已授权的案例库检索同题材、同受众的样片；没有案例库则按当前素材创作并明确未做案例比对，不虚构历史案例。仅学习镜头信息量、行动因果和转场节奏，不照搬人物、道具或违法低俗情节。每条方案的异常载体和人物行动应有差异；不得机械安排动物说话、神秘人预言或无来由的全知路人。

核心结构：第一帧出现可辨的反常结果或人物反常举动 → 主角立即处理 → 处理引发更大后果或关键线索 → 人物以口语化的一句揭示或对白作出选择 → 用动作、视线、道具或问题接完整原片开头。猎奇来自剧情反常和信息反差，不来自脏污、排泄物、身体废弃物、羞辱、骚扰或危险模仿。默认近零空镜，每1–2秒有有效变化；多余走路、风景、重复震惊和无关特效都删除。是否出现动物取决于剧情，不强塞救助桥段。优先10–18秒，真有两次有效升级才可更长；Seedance单段只能4–15秒，长剧本按完整动作节点拆段，不压缩对白。

${UNIFIED_PRODUCTION_RULES}

只新增AI前贴，不替换或裁剪原高光；原片必须从00:00:00.000完整接入。若提供多条素材，逐条看首帧、首句和关键动作，锁定唯一文件；反推AI尾镜时写清“前贴末动作 → 原片00:00.000首画面/首句”的逻辑，不匹配就改前贴。没有可读原片时明确标“待核片”，不要伪造衔接点。人物默认虚构成年人，外观用文字描述；真人原片截图只做内部核验，不上传Seedance。角色对白需明确说话人、情绪和开口时码；Seedance生成同期人声与自然口型，画面无字幕、无标题、无角标、无Logo、无水印；后期字幕依实际音频对齐，不可提前挂字。

案例Markdown只保留“## 方案一/二/三”等方案。每方案先写“钩子：……”及“样片参考：编号/标题｜保留结构｜替换剧情”（若无可用样片须写“规则创作”）；再以“### Seedance提示词（片段1）”和text代码块给出完整可复制提示词。每段代码块后写“生成参数建议：X秒｜9:16｜720p｜生成对白和环境音｜无水印”。超过15秒续写片段2，清楚写前段末帧与后段首帧。对白行用“字幕时码：00:02.000 --> 00:05.500｜说话人｜准确台词”列出预估起止，后期仍以实声校准。已核实的内部人物截图可在末尾列路径，不写@图片引用。写出“衔接完整原片：《准确文件名.mp4》00:00:00.000｜首句：……｜首帧：……”，此行也要在Seedance提示词内，供工作台校验。

${PREHOOK_CAPTION_RULES}

只报告实际核验的素材。把结果保存为当前任务目录可访问的Markdown文件并返回路径；只制作脚本，不发起付费生成。`;

  const creativeRules = mode.skill === 'plot-over-10s' ? `递进剧情紧凑告知固定使用“主角发现受困动物→主角实际施救→动物明确脱困→动物为报恩开口提醒一件关键事情→主角产生情绪转折并立即行动→硬切原片高光验证”的结构。救助过程必须真实展示，不能只靠旁白带过；必须先救助成功，动物才能开口，声音必须明确来自该动物，不能替换成无归属旁白。动物只说一句口语化的关键提醒，不复述全剧。若告知的是家中危机，主角听完必须立即奔跑或驾车回家，再衔接原片进门、开门、开柜或当面对质的画面。三个方案可以更换合理的成年主角施救动作、动物种类和地点，但每条都必须保留完整的“救助换来告知”因果。

都市环境只选合理出现的猫、狗、鹦鹉、乌鸦、鸽子等普通动物；救助发生在街边、小区花园、公园、停车场或院外等合理地点。不得把受困动物无缘无故放进卧室、婚房或密室，不渲染伤害，不设计危险模仿。` : `单爆点紧凑告知不得连续套用动物告密。方案应从原片人物说破、物证出现、亲眼撞见、电话录音或确有必要的动物/超自然告知中选择最贴题的一种；三条方案的开场主体、信息来源和行动落点必须不同，不能只替换动物、职业或道具。`;

  return `使用 $short-drama-prehook-production，按“${mode.label}”工作流完成任务。

剧名：${input.dramaTitle || '未填写，不要自行杜撰剧名'}

作品简介：
${input.summary}

原片或前10秒素材：
${input.source || '未提供。先基于简介输出创意草案，并明确说明尚未完成硬切连续性验证。'}

题材 / 受众：${input.genre || '请根据简介判断'}
方案数量：${input.count}条
时长原则：${mode.duration}
图片参考规则：环境、场景、光线仅文字描述。原片人物截图只作为内部核验图，不进入Seedance请求；正式提示词不得写@图片，也不得上传原片真人脸，人物外观统一改写为虚构成年人的年龄、发型、脸型、服装和体态文字描述。缺少原片时标注待补，不能虚构路径。

补充要求：${input.notes || '无'}

${UNIFIED_PRODUCTION_RULES}

${creativeRules}

选材前必须对照已学习案例库，只借鉴其节奏、信息密度和转折方式，不能机械复制案例里的动物。输出每个方案前先自检：开场主体是否不同、信息来源是否不同、动作落点是否不同；任意两条相同则重写。

要求：先保证剧情紧凑，再根据内容决定时长，禁止为了凑5秒、8秒、10秒或15秒删掉必要的因果，也禁止为了拉长时长加入空镜、重复反应和解释性旁白。开头0.5秒必须直接出现可辨识的异常、冲突或身份反差；0.5至3秒用短句说出具体事实；3至5秒必须出现主角态度转折或新证据；最后立即转身、推门、夺物、质问或奔赴现场，并在动作峰值硬切原片。对白必须口语化且一句只传递一个信息，能用12个字说清就不用20个字。每0.8至1.5秒至少发生一次有效信息变化，禁止一个人物站着说完整段长台词、连续两次同类震惊反应或无意义走路。单条只讲一个爆点，至少包含“首帧视觉钩子→告知/证据→主角立即行动”三个清晰节拍；镜头使用近景钩子、中近景对白、动态跟拍衔接，不得全程单一景别。先写画面和对白，再写必要的一致性限制。如完整微剧情超过Seedance单段4至15秒限制，按动作连续性拆成多段提示词，并明确上一段末帧与下一段首帧如何衔接；不得强行压缩成信息堆叠。

空间与行动逻辑硬规则：救助鸟类、流浪动物、陌生人等事件必须发生在合理的公共或室外环境，如小区花园、街边、停车场、公园、院外；不得为了省镜头把偶遇救助硬塞进卧室、婚房或密室。若告知内容指向家中的危机，角色听完必须立即转身奔跑或驾车回家，结尾用相同运动方向、动作或声音硬切原片进门、开门、开柜等验证画面。

文明合规硬规则：所有创意、分镜、台词和Seedance提示词必须符合公共文明与正常社会行为。禁止把贴身衣物扔向他人，禁止展示或利用脚皮、脚趾甲、尿液、排泄物、呕吐物、吐痰、恶意泼洒、侮辱性投掷等低俗或不文明行为吸睛；禁止羞辱、猥亵、骚扰和危险模仿。需要表现背叛证据时，改用密封证据袋、监控照片、门禁卡、酒店账单、聊天记录或其他干净、合理、可公开展示的物证。猎奇只能来自剧情反常和信息反差，不能来自脏污、身体废弃物或不文明动作。

年龄素材硬规则：人物和参考图默认只使用成年人。不得为了视觉钩子新增未成年人或婴儿，不得安排未成年人或婴儿告密、受困、受伤、被救助、被惊吓或参与危险动作，也不要从原片截取其人物参考图。若作品核心剧情确实离不开未成年人或婴儿，只能在结果中标为“需人工确认”，并优先给出由成年亲属、成年路人、动物或非人物线索承担同一剧情功能的替代方案；未经确认不得进入一键Seedance生成。

如已提供原片，先在内部检查原片高光、天气、光线、场景、服装、人物位置和运动方向，但不要把分析过程堆进案例Markdown。

案例Markdown必须精简，并严格使用以下结构，方便工作台像“起量高光复刻去重”一样直接制作Seedance：
1. 只输出“## 方案一”“## 方案二”“## 方案三”（若用户要求5或10条则顺延），不要输出基础信息、创作思路、剧情分析、规则解释、总结、推荐理由或重复清单。
2. 每个方案先用一行写“钩子：……”；再写三级标题“### Seedance提示词（片段1）”，标题下用text代码块只放可直接生成的完整提示词。
3. 提示词内必须包含人物设定、场景、情绪、动作、逐句对白、镜头节奏、原片衔接画面，以及“无字幕、无标题、无角标、无Logo、无水印”；人物对白由Seedance同期生成，不能移到提示词外。
4. 每句需要后期添加的对白，在提示词中另起一行使用固定格式：\`字幕时码：00:02.000 --> 00:05.500｜鹦鹉｜林先生，你老婆把男人藏在婚房柜子后面！\`。字幕起点必须是该角色实际开口的时刻，终点必须是尾字说完的时刻；没有说话的救助动作、奔跑和衔接画面不得出现这句字幕。
5. 代码块后只保留一行“生成参数建议：X秒｜9:16｜720p｜生成对白和环境音｜无水印”。时长必须根据该方案真实节奏填写，4至15秒；超过15秒拆成片段2，并分别提供可生成提示词。
6. 如有已验证的内部核验图，只在方案末尾用一行列出，不写成@图片，不带入生成；没有就省略。
 7. 不单独输出秒级时间表、参考图表或衔接说明表；这些信息全部压缩进Seedance提示词。无声画面文案按下方独立于提示词代码块的固定格式输出。

${PREHOOK_CAPTION_RULES}

只报告已验证存在的本地资产。把最终结果写入当前任务目录可访问的 Markdown 文件，并在最终回复中给出路径。`;
}

function learningRecords() {
  return fs.readdirSync(LEARNINGS, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const file = path.join(LEARNINGS, entry.name, 'profile.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function recommend(input) {
  const text = `${input.genre || ''} ${input.summary || ''}`.toLowerCase();
  const scores = { short: 0, long: 0 };
  const reasons = [];
  const rules = [
    ['short', /身份|危机|反转|秘密|马甲|重生|穿越|闪婚|替嫁|复仇|真假/, 3, '适合快速揭示身份、危机或反转'],
    ['long', /递进|追逐|营救|冲突|调查|发现|对抗|行动|升级|悬疑/, 3, '需要行动和冲突递进后再揭示信息']
  ];
  for (const [mode, pattern, weight, reason] of rules) if (pattern.test(text)) { scores[mode] += weight; reasons.push(reason); }
  for (const record of learningRecords()) {
    const tokens = `${record.genre || ''} ${(record.tags || []).join(' ')}`.toLowerCase().split(/[\s,，/、|]+/).filter(token => token.length > 1);
    const hits = tokens.filter(token => text.includes(token)).length;
    if (hits && scores[record.recommendedMode] !== undefined) scores[record.recommendedMode] += hits * 3;
  }
  const mode = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
  return { mode, label: MODES[mode].label, scores, reason: reasons[0] || '根据已学习样片与题材相似度推荐', learnedSamples: learningRecords().length };
}

function startLearning(input) {
  normalizeInput(input);
  if (!input.source) throw new Error('样片学习必须填写本地视频路径');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(LEARNINGS, id); fs.mkdirSync(dir, { recursive: true });
  const statusFile = path.join(dir, 'status.json'), resultFile = path.join(dir, 'analysis.json'), logFile = path.join(dir, 'codex.log');
  safeWrite(statusFile, { id, state: 'running', createdAt: new Date().toISOString() });
  const prompt = `分析本地视频样片并建立二创工作流分类档案。视频路径：${input.source}\n简介：${input.summary}\n题材/受众：${input.genre || '未填写'}\n补充：${input.notes || '无'}\n请实际检查可读取的视频元数据、前段关键画面和叙事节奏，不要仅凭文件名判断。在 short、long 中选出最适合的一个：short=10秒内快速告知核心身份/危机/反转；long=10秒以上通过行动和冲突递进告知。最终回复必须仅为合法 JSON，结构：{"recommendedMode":"short|long","genre":"题材","audience":"受众","tags":["标签"],"visualHooks":["视觉钩子"],"narrativePattern":"叙事结构","pace":"节奏","reason":"选择原因"}。`;
  const child = spawn(CODEX, ['exec', '-', '-C', WORKSPACE, '--sandbox', 'workspace-write', '--output-last-message', resultFile, '--color', 'never'], { cwd: WORKSPACE, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(logFile, { flags: 'a' }); child.stdout.pipe(log); child.stderr.pipe(log); child.stdin.end(prompt, 'utf8');
  child.on('error', error => safeWrite(statusFile, { id, state: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  child.on('close', code => {
    log.end();
    try {
      const raw = fs.readFileSync(resultFile, 'utf8').trim().replace(/^```json\s*|\s*```$/g, '');
      const profile = JSON.parse(raw); if (!MODES[profile.recommendedMode]) throw new Error('分类结果无效');
      safeWrite(path.join(dir, 'profile.json'), { ...profile, id, dramaTitle: input.dramaTitle, source: input.source, summary: input.summary, createdAt: new Date().toISOString() });
      safeWrite(statusFile, { id, state: 'completed', recommendedMode: profile.recommendedMode, finishedAt: new Date().toISOString() });
    } catch (error) { safeWrite(statusFile, { id, state: 'failed', error: code === 0 ? `无法解析分类结果：${error.message}` : 'Codex分析失败', finishedAt: new Date().toISOString() }); }
  });
  return { id, state: 'running' };
}

function learningState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const dir = path.join(LEARNINGS, id), file = path.join(dir, 'status.json'); if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8')); const profile = path.join(dir, 'profile.json');
  if (fs.existsSync(profile)) state.profile = JSON.parse(fs.readFileSync(profile, 'utf8'));
  return state;
}

function resolveRemakeVideo(source) {
  const value = String(source || '').trim();
  if (!value || !fs.existsSync(value)) return '';
  const stat = fs.statSync(value);
  if (stat.isFile() && /\.(mp4|mov|mkv|webm)$/i.test(value)) return path.resolve(value);
  if (!stat.isDirectory()) return '';
  return fs.readdirSync(value, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(mp4|mov|mkv|webm)$/i.test(entry.name))
    .map(entry => path.join(value, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))[0] || '';
}

function prepareRemakeInput(input, taskDir) {
  if (input.mode !== 'remake') return { ...input };
  const original = resolveRemakeVideo(input.source);
  if (!original) return { ...input, remakeCutSeconds: 15 };
  const cutSeconds = Number(input.remakeCutSeconds) === 10 ? 10 : 15;
  const clip = path.join(taskDir, `source-first-${cutSeconds}s.mp4`);
  if (fs.existsSync(FFMPEG)) {
    const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', original, '-t', String(cutSeconds), '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', clip], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0 || !fs.existsSync(clip) || fs.statSync(clip).size < 1024) {
      try { if (fs.existsSync(clip)) fs.unlinkSync(clip); } catch {}
    }
  }
  return {
    ...input,
    remakeOriginalVideo: original,
    remakeAnalysisClip: fs.existsSync(clip) ? clip : original,
    remakeCutSeconds: cutSeconds
  };
}

function startTask(input, batchId = null) {
  const mode = MODES[input.mode];
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(TASKS, id);
  fs.mkdirSync(dir, { recursive: true });
  const statusFile = path.join(dir, 'status.json');
  const resultFile = path.join(dir, 'result.md');
  const logFile = path.join(dir, 'codex.log');
  const promptFile = path.join(dir, 'prompt.txt');
  const effectiveInput = prepareRemakeInput(input, dir);
  const prompt = `${buildPrompt(effectiveInput, mode)}

交付前逐条自查方案数量、对白时码、原片边界和三句画面文案；把全部方案正文直接写入最终回复供工作台保存为 result.md。缺可读原片时明确标脚本草案，不得伪造核片或付费准备。`;
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(effectiveInput, null, 2), 'utf8');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  const createdAt = new Date().toISOString();
  safeWrite(statusFile, { id, batchId, state: 'queued', mode: input.mode, label: mode.label, createdAt });

  const args = ['exec', '-', '-C', WORKSPACE, '--sandbox', 'workspace-write', '--output-last-message', resultFile, '--color', 'never'];
  const child = spawn(CODEX, args, { cwd: WORKSPACE, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  safeWrite(statusFile, { id, batchId, state: 'running', mode: input.mode, label: mode.label, createdAt, startedAt: new Date().toISOString(), pid: child.pid, stage: input.mode === 'remake' ? '正在反推开头10–15秒' : '正在生成脚本' });
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.stdin.end(prompt, 'utf8');
  child.on('error', error => {
    log.end(`\n${error.stack || error.message}\n`);
    safeWrite(statusFile, { id, batchId, state: 'failed', mode: input.mode, label: mode.label, createdAt, error: error.message, finishedAt: new Date().toISOString() });
  });
  child.on('close', code => {
    log.end();
    const result = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '';
    const qa = validateCase(result, effectiveInput);
    fs.writeFileSync(path.join(dir, '规则检查.json'), JSON.stringify(qa, null, 2), 'utf8');
    const state = code === 0 && result.trim() && qa.ok ? 'completed' : 'failed';
    safeWrite(statusFile, { id, batchId, state, mode: input.mode, label: mode.label, createdAt, exitCode: code, finishedAt: new Date().toISOString(), qaPassed: qa.ok, qaErrors: qa.errors, qaWarnings: qa.warnings, stage: qa.ok ? (qa.warnings.length ? '脚本草案（未核片）' : '脚本规则检查通过') : '脚本规则检查未通过', error: state === 'failed' ? (qa.errors.length ? `规则检查未通过：${qa.errors.slice(0, 5).join('；')}` : 'Codex执行失败，请查看日志或登录状态。') : undefined });
  });
  return { id, state: 'running', label: mode.label };
}

function taskState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const dir = path.join(TASKS, id);
  const statusFile = path.join(dir, 'status.json');
  if (!fs.existsSync(statusFile)) return null;
  let status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  if (status.state === 'running') {
    const logPath = path.join(dir, 'codex.log');
    const lastActivity = fs.existsSync(logPath) ? fs.statSync(logPath).mtimeMs : new Date(status.startedAt || status.createdAt).getTime();
    let alive = true;
    if (status.pid) {
      try { process.kill(Number(status.pid), 0); } catch { alive = false; }
    } else if (Date.now() - lastActivity > 15 * 60 * 1000) {
      alive = false;
    }
    if (!alive) {
      status = { ...status, state: 'failed', stage: '已中断', error: '本地脚本任务已中断或服务重启后失去执行进程。未创建Seedance付费任务，可按新的“仅反推开头10–15秒”规则重新生成。', finishedAt: new Date().toISOString() };
      safeWrite(statusFile, status);
    }
  }
  status.result = fs.existsSync(path.join(dir, 'result.md')) ? fs.readFileSync(path.join(dir, 'result.md'), 'utf8') : '';
  status.log = fs.existsSync(path.join(dir, 'codex.log')) ? fs.readFileSync(path.join(dir, 'codex.log'), 'utf8').slice(-5000) : '';
  if (status.state === 'completed' || status.state === 'failed') status.progress = 100;
  else if (status.state === 'queued') status.progress = 5;
  else {
    const elapsed = Math.max(0, Date.now() - new Date(status.startedAt || status.createdAt).getTime());
    status.progress = Math.min(85, 15 + (status.log.trim() ? 20 : 0) + Math.floor(elapsed / 30000));
    status.progressEstimated = true;
    status.stage = status.stage || '正在生成脚本';
  }
  return status;
}

function taskArtifact(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const resultFile = path.join(TASKS, id, 'result.md');
  if (!fs.existsSync(resultFile)) return null;
  const result = fs.readFileSync(resultFile, 'utf8');
  const matches = [...result.matchAll(/(?:<)?(\/?[A-Za-z]:[\\/][^\r\n<>]*?\.md)(?:>)?/g)];
  for (const match of matches) {
    const candidate = match[1].replace(/^\/(?=[A-Za-z]:)/, '').replace(/\\/g, path.sep);
    const resolved = path.resolve(candidate);
    if ((resolved === WORKSPACE || resolved.startsWith(`${WORKSPACE}${path.sep}`)) && fs.existsSync(resolved)) {
      return { path: resolved, name: path.basename(resolved), content: fs.readFileSync(resolved, 'utf8') };
    }
  }
  return { name: '任务结果', content: result };
}

function normalizeInput(input) {
  if (typeof input.summary !== 'string' || !input.summary.trim()) throw new Error('请填写作品简介');
  input.summary = input.summary.trim();
  input.dramaTitle = typeof input.dramaTitle === 'string' ? input.dramaTitle.trim() : '';
  input.source = typeof input.source === 'string' ? input.source.trim() : '';
  input.genre = typeof input.genre === 'string' ? input.genre.trim() : '';
  input.notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  input.count = [3, 5, 10].includes(Number(input.count)) ? Number(input.count) : 3;
  return input;
}

function batchState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const file = path.join(BATCHES, id, 'batch.json');
  if (!fs.existsSync(file)) return null;
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  batch.tasks = batch.taskIds.map(taskState).filter(Boolean);
  batch.progress = batch.tasks.length ? Math.round(batch.tasks.reduce((sum, task) => sum + task.progress, 0) / batch.tasks.length) : 0;
  const terminal = batch.tasks.every(task => task.state === 'completed' || task.state === 'failed');
  batch.state = terminal ? (batch.tasks.some(task => task.state === 'failed') ? 'failed' : 'completed') : 'running';
  return batch;
}

function createBatch(input) {
  normalizeInput(input);
  const recommendation = input.mode === 'curious' ? null : recommend(input);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(BATCHES, id);
  fs.mkdirSync(dir, { recursive: true });
  const selectedModes = MODES[input.mode] ? [input.mode] : MODE_ORDER;
  const tasks = selectedModes.map(mode => startTask({ ...input, mode }, id));
  const batch = { id, createdAt: new Date().toISOString(), dramaTitle: input.dramaTitle, summary: input.summary, source: input.source, genre: input.genre, count: input.count, notes: input.notes, modes: selectedModes, recommendation, taskIds: tasks.map(task => task.id) };
  safeWrite(path.join(dir, 'batch.json'), batch);
  return batchState(id);
}

function addModeToBatch(batchId, modeName, force = false) {
  if (!/^[a-zA-Z0-9-]+$/.test(batchId)) throw new Error('批次ID无效');
  if (!MODES[modeName]) throw new Error('工作流无效');
  const file = path.join(BATCHES, batchId, 'batch.json');
  if (!fs.existsSync(file)) throw new Error('批次不存在');
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  const existing = (batch.taskIds || []).map(taskState).filter(Boolean).find(task => task.mode === modeName);
  if (existing && !force) return batchState(batchId);
  if (existing && force) batch.taskIds = (batch.taskIds || []).filter(taskId => taskState(taskId)?.mode !== modeName);
  const input = normalizeInput({
    dramaTitle: batch.dramaTitle || '',
    summary: batch.summary || '',
    source: batch.source || '',
    genre: batch.genre || '',
    count: batch.count || 3,
    notes: modeName === 'remake'
      ? '严格复刻源素材开头已验证高光：保持原人物、原对白、原场景功能、原动作因果和原节奏，只重新生成画面实现去重。忽略该批次为其他前贴模式填写的动物、灵魂、救助、告密等创意备注。'
      : (batch.notes || ''),
    mode: modeName
  });
  const task = startTask(input, batchId);
  batch.taskIds = [...(batch.taskIds || []), task.id];
  safeWrite(file, batch);
  return batchState(batchId);
}

function normalizeSeedanceRequest(input) {
  let prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('Seedance提示词不能为空');
  if (/\?{4,}|�/.test(prompt)) throw new Error('提示词疑似包含乱码，请修正后再提交');
  if (/(?:(?:扔|甩|抛).{0,12}(?:内裤|贴身衣物)|(?:内裤|贴身衣物).{0,12}(?:扔|甩|抛))|脚皮|脚趾甲|尿液|排泄物|呕吐物|吐痰|恶意泼洒/.test(prompt)) throw new Error('提示词包含低俗或不文明行为，请改用密封证据袋、门禁记录、照片等文明表达后再提交');
  prompt = prompt
    .replace(/严格复刻原高光的真实人物、真实对白、动作因果和节奏，只重新生成画面。?/g, '使用虚构成年人物原创演绎同类剧情节奏，保留动作因果与情绪推进，人物外观、场景细节和镜头表现均为原创。')
    .replace(/严格复刻(?:原片|源素材|原高光)/g, '原创演绎既定剧情结构')
    .replace(/原片中的成年人/g, '上述虚构成年人')
    .replace(/真实人物/g, '虚构成年人物');
  const generateAudio = Boolean(input.generateAudio);
  if (!generateAudio) {
    prompt = prompt
      .replace(/[“"]([^”"\r\n]{1,160})[”"]/g, '（具体对白由后期添加）')
      .replace(/音频必须生成[^。！？]*[。！？]?/g, '')
      .replace(/生成(?:上述|中文)?同期对白/g, '只生成自然说话口型动作')
      .replace(/生成对白音频[:：]?\s*(?:是|否)/g, '画面静音生成');
  }
  const cleanFrameRule = generateAudio
    ? '全程生成干净无字画面：禁止字幕、标题、角标、Logo、水印及任何可读字符；纸张、手机、门牌和屏幕内容保持空白或完全虚化。只保留人物口型、对白声音、动作和环境声，中文字幕统一由后期添加。'
    : '全程生成干净无字的静音画面：禁止字幕、标题、角标、Logo、水印及任何可读字符；纸张、手机、门牌和屏幕内容保持空白或完全虚化。人物保持自然说话口型、表情、停顿与动作，具体对白、环境音和中文字幕全部由后期准确添加。';
  if (!/(全程无字幕|干净无字画面|禁止字幕)/.test(prompt)) prompt = `${prompt}\n\n【无字画面硬性要求】${cleanFrameRule}`;
  const model = ['doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini', 'doubao-seedance-2.0'].includes(input.model) ? input.model : 'doubao-seedance-2.0-fast';
  const resolution = ['480p', '720p', '1080p'].includes(input.resolution) ? input.resolution : '720p';
  if (model === 'doubao-seedance-2.0-fast' && resolution === '1080p') throw new Error('Seedance 2.0 Fast不支持1080p');
  const duration = Number(input.duration);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error('时长必须是4至15秒的整数');
  const ratio = ['9:16', '16:9', '1:1'].includes(input.ratio) ? input.ratio : '9:16';
  const images = Array.isArray(input.referenceImages) ? input.referenceImages.map(value => String(value).trim()).filter(Boolean) : [];
  const referencedImageIds = [...prompt.matchAll(/@图片\s*(\d+)/g)].map(match => match[1]);
  if (referencedImageIds.length && !images.length) throw new Error(`提示词引用了${new Set(referencedImageIds).size}张@图片，但没有带入参考图。请关闭窗口后从完整案例重新点击“生成Seedance视频”。`);
  for (const image of images) {
    if (!path.isAbsolute(image) || !fs.existsSync(image) || !fs.statSync(image).isFile()) throw new Error(`参考图不存在：${image}`);
  }
  return { prompt, images, model, duration, resolution, ratio, generate_audio: generateAudio, watermark: Boolean(input.watermark) };
}

function extractExactDialogue(prompt) {
  const timed = [...String(prompt || '').matchAll(/字幕时码[：:]\s*\d{2}:(\d{2}(?:\.\d{1,3})?)\s*-->\s*\d{2}:(\d{2}(?:\.\d{1,3})?)\s*[｜|]\s*[^｜|\r\n]+[｜|]\s*([^\r\n]+)/g)]
    .map(match => `[${Number(match[1]).toFixed(3)}-${Number(match[2]).toFixed(3)}]${match[3].trim()}`);
  if (timed.length) return timed.join('\n');
  const values = [...String(prompt || '').matchAll(/[“"]([^”"\r\n]{1,160})[”"]/g)]
    .map(match => match[1].trim()).filter(value => value
      && !/^(?:[A-Za-z]:[\\/]|\\\\|https?:\/\/)/i.test(value)
      && !/\.(?:mp4|mov|mkv|webm|jpg|jpeg|png|srt)(?:\?.*)?$/i.test(value));
  const unique = [...new Set(values)];
  return unique.filter(value => !unique.some(other => other !== value && other.includes(value))).join('\n');
}

function extractSpliceTarget(prompt, sourceTaskId, sourceMode = '') {
  const text = String(prompt || '');
  let sourceInput = null;
  if (sourceTaskId && /^[a-zA-Z0-9-]+$/.test(sourceTaskId)) {
    const sourceInputFile = path.join(TASKS, sourceTaskId, 'input.json');
    if (fs.existsSync(sourceInputFile)) {
      sourceInput = JSON.parse(fs.readFileSync(sourceInputFile, 'utf8'));
      if (sourceInput.mode === 'remake' && sourceInput.remakeOriginalVideo && fs.existsSync(sourceInput.remakeOriginalVideo)) {
        return { video: sourceInput.remakeOriginalVideo, start: Number(sourceInput.remakeCutSeconds || 15) };
      }
    }
  }
  const fullOriginalMode = ['short', 'long', 'curious', 'single', 'progressive'].includes(String(sourceInput?.mode || sourceMode));
  const targets = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/(?:硬切|接回|衔接)[^\r\n]*(?:mp4|mov|mkv|webm)/i.test(line)) continue;
    const quoted = line.match(/[《「“`"]([^》」”`"\r\n]+?\.(?:mp4|mov|mkv|webm))[》」”`"]?/i);
    const bare = line.match(/([A-Za-z]:\\[^\r\n《》「」“”`"|]+?\.(?:mp4|mov|mkv|webm))/i);
    const fileMatch = quoted || bare;
    if (!fileMatch) continue;
    const afterFile = line.slice((fileMatch.index || 0) + fileMatch[0].length);
    const time = afterFile.match(/(?:^|[^\d])(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?!\d)/);
    if (!time || Number(time[3]) >= 60 || Number(time[2]) >= 60) continue;
    const start = Number(time[1] || 0) * 3600 + Number(time[2]) * 60 + Number(time[3]) + Number(`0.${(time[4] || '').padEnd(3, '0')}`);
    targets.push({ name: path.win32.basename(fileMatch[1]), direct: fileMatch[1], start });
  }
  if (!targets.length) {
    if (sourceInput?.source) throw new Error('未找到可核验的原片文件和完整切入时码。请在提示词中写“衔接原片：《准确文件名.mp4》00:02:41.700”。');
    return { video: '', start: 0 };
  }
  const unique = new Set(targets.map(target => `${target.name.toLowerCase()}|${target.start}`));
  if (unique.size !== 1) throw new Error('提示词包含互相冲突的原片或切入时码，请只保留一个准确衔接点。');
  const target = targets[0];
  if (fullOriginalMode && target.start !== 0) throw new Error('单爆点、递进与猎奇前贴必须接所选高光视频的00:00:00.000完整开头，不能裁剪原片；请改写前贴结尾以衔接首帧。');
  const source = String(sourceInput?.source || '').trim();
  let video = '';
  if (source && fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    const matches = fs.readdirSync(source).filter(name => name.toLowerCase() === target.name.toLowerCase());
    if (matches.length === 1) video = path.join(source, matches[0]);
  } else if (source && fs.existsSync(source) && fs.statSync(source).isFile()) {
    if (path.win32.basename(source).toLowerCase() === target.name.toLowerCase()) video = source;
  } else if (path.win32.isAbsolute(target.direct) && fs.existsSync(target.direct)) {
    video = target.direct;
  }
  if (!video) throw new Error(`原片与提示词不一致，找不到指定视频：${target.name}。不会改用文件夹里的其他视频。`);
  return { video, start: target.start };
}

function runJsonProcess(file, args, cwd = ZLHUB_SCRIPTS, executable = PYTHON) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [file, ...args], { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `处理失败，退出码${code}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('无法解析ZLHub处理结果')); }
    });
  });
}

function normalizePrehookCaptions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map(item => ({
    text: String(item?.text || '').trim(),
    yellow: String(item?.yellow || '').trim(),
    red: String(item?.red || '').trim()
  })).filter(item => item.text && item.text.length <= 28 && !/[\r\n]/.test(item.text) && (!item.yellow || item.text.includes(item.yellow)) && (!item.red || item.text.includes(item.red)));
}

async function prepareSeedance(input) {
  const sourceTaskId = String(input.sourceTaskId || '').trim();
  const sourceMode = String(input.sourceMode || '').trim();
  if (sourceTaskId) {
    if (!/^[a-zA-Z0-9-]+$/.test(sourceTaskId)) throw new Error('来源任务ID无效');
    const sourceInputFile = path.join(TASKS, sourceTaskId, 'input.json');
    if (!fs.existsSync(sourceInputFile)) throw new Error('来源任务不存在，不能核对原片');
    const sourceInput = JSON.parse(fs.readFileSync(sourceInputFile, 'utf8'));
    if (sourceMode && sourceInput.mode !== sourceMode) throw new Error('生成模式与来源任务不一致，请从对应案例重新打开');
    if (input.ratio !== '9:16' || input.resolution !== '720p' || input.generateAudio !== true || input.watermark === true) throw new Error('当前前贴只能按9:16、720p、Seedance同期原声、无水印准备');
    if (sourceInput.mode === 'remake') {
      const declared = String(input.prompt || '').match(/接回原片[：:]\s*00:(\d{2})\.(\d{3})/);
      const expected = Number(sourceInput.remakeCutSeconds || 15);
      if (!declared || Math.abs(Number(declared[1]) + Number(declared[2]) / 1000 - expected) > 0.001) throw new Error(`复刻接回时码必须与已核定替换区间一致：00:${String(expected).padStart(2, '0')}.000`);
    }
    const promptErrors = validateGenerationPrompt(input.prompt, Number(input.duration), sourceInput.mode);
    if (promptErrors.length) throw new Error(`付费前规则检查未通过：${promptErrors.join('；')}`);
  }
  const postDialogue = extractExactDialogue(input.prompt);
  const splice = extractSpliceTarget(input.prompt, sourceTaskId, sourceMode);
  if (sourceTaskId && !splice.video) throw new Error('来源原片尚未核验，不能创建付费确认单');
  const request = normalizeSeedanceRequest(input);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const tempDir = path.join(SEEDANCE_TEMP, id); fs.mkdirSync(tempDir, { recursive: true });
  const requestFile = path.join(tempDir, 'prepare-request.json');
  const payloadFile = path.join(tempDir, 'payload.json');
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), 'utf8');
  try {
    const prepared = await runJsonProcess(path.join(ZLHUB_SCRIPTS, 'prepare_seedance_inputs.py'), ['--request-file', requestFile]);
    fs.writeFileSync(payloadFile, JSON.stringify(prepared.seedance_payload, null, 2), 'utf8');
    const jobDir = path.join(SEEDANCE_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
    const sourceDuration = Number(prepared.seedance_payload?.duration || request.duration || 8);
    const dialogueChars = postDialogue.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, '').length;
    const dialogueDensity = sourceDuration > 0 ? dialogueChars / sourceDuration : 99;
    const speedFactor = sourceMode === 'short' && dialogueDensity <= 6.5 ? 1.5 : 1.2;
    safeWrite(path.join(jobDir, 'status.json'), { id, rootId: id, retryCount: 0, state: 'awaiting_confirmation', createdAt: new Date().toISOString(), payloadFile, generationPayload: prepared.seedance_payload, preparedImages: prepared.prepared_images || [], postDialogue, autoPostProcess: Boolean(postDialogue), spliceVideo: splice.video, spliceStart: splice.start, speedFactor, dramaTitle: String(input.dramaTitle || '').trim(), sourceTaskId: String(input.sourceTaskId || '').trim(), sourceMode, prehookCaptions: normalizePrehookCaptions(input.prehookCaptions) });
    return { id, state: 'awaiting_confirmation', payload: prepared.seedance_payload, preparedImages: prepared.prepared_images || [], speedFactor, spliceVideo: splice.video, spliceStart: splice.start };
  } finally {
    if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile);
  }
}

function seedanceState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const file = path.join(SEEDANCE_JOBS, id, 'status.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function cacheSeedanceVideo(id, videoUrl) {
  if (!videoUrl) return;
  const dir = path.join(LIBRARY_OUTPUTS, id); fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, 'seedance-raw.mp4');
  try {
    const response = await fetch(videoUrl); if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
    fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
    const statusFile = path.join(SEEDANCE_JOBS, id, 'status.json'); const state = seedanceState(id);
    if (state) safeWrite(statusFile, { ...state, cachedRaw: output, cachedAt: new Date().toISOString() });
  } catch (error) {
    const statusFile = path.join(SEEDANCE_JOBS, id, 'status.json'); const state = seedanceState(id);
    if (state) safeWrite(statusFile, { ...state, cacheError: error.message });
  }
}

function confirmSeedance(id) {
  const status = seedanceState(id);
  if (!status) throw new Error('Seedance预备任务不存在');
  if (status.state !== 'awaiting_confirmation') throw new Error('该任务已经确认或已开始执行');
  if (!status.payloadFile || !fs.existsSync(status.payloadFile)) throw new Error('Seedance临时参数文件不存在，请重新准备');
  if (['short', 'long', 'curious'].includes(status.sourceMode) && Number(status.spliceStart || 0) !== 0) throw new Error('该旧确认单会裁剪高光原片，不符合新规则；请重写AI前贴并重新生成免费确认单。');
  const statusFile = path.join(SEEDANCE_JOBS, id, 'status.json');
  const outputFile = path.join(SEEDANCE_JOBS, id, 'result.json');
  const logFile = path.join(SEEDANCE_JOBS, id, 'run.log');
  safeWrite(statusFile, { ...status, state: 'running', confirmedAt: new Date().toISOString() });
  const child = spawn(PYTHON, [path.join(ZLHUB_SCRIPTS, 'run_seedance_task.py'), '--payload-file', status.payloadFile], { cwd: ZLHUB_SCRIPTS, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  seedanceProcesses.set(id, child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8'); stderr += text;
    const match = stderr.match(/"event"\s*:\s*"task_created"[\s\S]*?"task_id"\s*:\s*"([^"]+)"/);
    if (match) safeWrite(statusFile, { ...seedanceState(id), taskId: match[1], state: 'running' });
  });
  child.on('error', error => safeWrite(statusFile, { ...seedanceState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  child.on('close', code => {
    seedanceProcesses.delete(id);
    if (seedanceState(id)?.state === 'cancelled_local') return;
    try {
      if (code !== 0) throw new Error(stderr.trim() || `Seedance执行失败，退出码${code}`);
      const result = JSON.parse(stdout); fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
      const upstreamError = result?.result?.data?.error;
      const nextState = { ...seedanceState(id), state: result.status === 'succeeded' ? 'succeeded' : result.status || 'failed', taskId: result.task_id, videoUrl: result.video_url, previewPath: result.preview_path, totalCost: result.total_cost_display, error: upstreamError ? `${upstreamError.code || '生成失败'}：${upstreamError.message || ''}` : undefined, finishedAt: new Date().toISOString() };
      if (result.status === 'succeeded' && nextState.autoPostProcess && nextState.postDialogue) {
        if (['short', 'long', 'curious'].includes(nextState.sourceMode) && Number(nextState.spliceStart || 0) !== 0) {
          nextState.state = 'succeeded';
          nextState.postBlockedReason = '已保留Seedance原始视频；单爆点/递进/猎奇禁止裁剪原高光开头，请重写衔接后再制作。';
        } else {
          const hasSeedanceAudio = Boolean(nextState.generationPayload?.generate_audio);
          const post = startPostPipeline({ aiVideo: result.video_url, highlightVideo: nextState.spliceVideo || '', highlightStart: nextState.spliceStart || 0, speedFactor: nextState.speedFactor || 1.2, narration: hasSeedanceAudio ? '' : nextState.postDialogue, subtitleText: nextState.postDialogue, voice: 'zh-CN-YunxiNeural', burnSubtitles: true, coverExistingSubtitles: true });
          nextState.postJobId = post.id;
          nextState.state = 'post_processing';
        }
      }
      safeWrite(statusFile, nextState);
      if (result.status === 'succeeded' && result.video_url) cacheSeedanceVideo(id, result.video_url);
    } catch (error) { safeWrite(statusFile, { ...seedanceState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }); }
    try { if (fs.existsSync(status.payloadFile)) fs.unlinkSync(status.payloadFile); } catch {}
  });
  return seedanceState(id);
}

function prepareSeedanceCopies(sourceId, count) {
  const source = seedanceState(sourceId);
  if (!source) throw new Error('原Seedance任务不存在');
  if (!source.generationPayload) throw new Error('原任务没有可复制的生成参数');
  const total = Math.max(1, Math.min(10, Number.parseInt(count, 10) || 1));
  const jobs = [];
  for (let index = 0; index < total; index += 1) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const tempDir = path.join(SEEDANCE_TEMP, id); fs.mkdirSync(tempDir, { recursive: true });
    const payloadFile = path.join(tempDir, 'payload.json');
    fs.writeFileSync(payloadFile, JSON.stringify(source.generationPayload, null, 2), 'utf8');
    const jobDir = path.join(SEEDANCE_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
    const state = {
      id, rootId: source.rootId || source.id, cloneOf: source.id, copyIndex: index + 1, copyCount: total,
      retryCount: 0, state: 'awaiting_confirmation', createdAt: new Date().toISOString(), payloadFile,
      generationPayload: source.generationPayload, preparedImages: source.preparedImages || [],
      postDialogue: source.postDialogue || '', autoPostProcess: Boolean(source.autoPostProcess),
      spliceVideo: source.spliceVideo || '', spliceStart: Number(source.spliceStart) || 0,
      speedFactor: Number(source.speedFactor) || 1.2, dramaTitle: source.dramaTitle || '',
      sourceTaskId: source.sourceTaskId || '', sourceMode: source.sourceMode || ''
    };
    safeWrite(path.join(jobDir, 'status.json'), state);
    jobs.push({ id, state: state.state, copyIndex: index + 1 });
  }
  return { sourceId, count: total, jobs, payload: source.generationPayload };
}

function confirmSeedanceCopies(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!unique.length || unique.length > 10) throw new Error('请选择1至10个复刻任务');
  return { count: unique.length, jobs: unique.map(id => confirmSeedance(id)) };
}

function cancelSeedance(id) {
  const status = seedanceState(id); if (!status) throw new Error('Seedance任务不存在');
  const statusFile = path.join(SEEDANCE_JOBS, id, 'status.json');
  if (status.state === 'awaiting_confirmation') {
    try { if (status.payloadFile && fs.existsSync(status.payloadFile)) fs.unlinkSync(status.payloadFile); } catch {}
    safeWrite(statusFile, { ...status, state: 'cancelled', cancelledAt: new Date().toISOString(), cancellationNote: '尚未创建付费任务，已取消。' });
    return seedanceState(id);
  }
  if (status.state === 'running') {
    const child = seedanceProcesses.get(id); if (child && !child.killed) child.kill();
    safeWrite(statusFile, { ...status, state: 'cancelled_local', cancelledAt: new Date().toISOString(), cancellationNote: '已停止本地轮询。ZLHub未提供取消接口，上游任务可能继续执行并产生费用。' });
    return seedanceState(id);
  }
  throw new Error('当前状态不能取消');
}

function retrySeedancePost(id, directSubtitles = false) {
  const status = seedanceState(id);
  if (!status) throw new Error('Seedance任务不存在');
  if (!status.cachedRaw || !fs.existsSync(status.cachedRaw)) throw new Error('本地原始视频不存在，无法重新处理字幕');
  if (!status.postDialogue) throw new Error('该任务没有可用的准确字幕文本');
  if (['short', 'long', 'curious'].includes(status.sourceMode) && Number(status.spliceStart || 0) !== 0) throw new Error('该旧任务从高光中段切入，不符合非复刻前贴完整接入原片的新规则；不能原样重做后期。');
  const hasSeedanceAudio = Boolean(status.generationPayload?.generate_audio);
  const prompt = status.generationPayload?.content?.find(item => item.type === 'text')?.text || '';
  const correctedSplice = status.spliceLocked ? { video: status.spliceVideo, start: Number(status.spliceStart || 0) } : extractSpliceTarget(prompt, status.sourceTaskId || '', status.sourceMode || '');
  const post = startPostPipeline({ aiVideo: status.cachedRaw, highlightVideo: correctedSplice.video || status.spliceVideo || '', highlightStart: correctedSplice.start || status.spliceStart || 0, speedFactor: status.speedFactor || 1.2, narration: hasSeedanceAudio ? '' : status.postDialogue, subtitleText: status.postDialogue, voice: 'zh-CN-YunxiNeural', burnSubtitles: true, coverExistingSubtitles: true, smartOcrRepair: !directSubtitles });
  const statusFile = path.join(SEEDANCE_JOBS, id, 'status.json');
  safeWrite(statusFile, { ...status, state: 'post_processing', postJobId: post.id, spliceVideo: correctedSplice.video || status.spliceVideo || '', spliceStart: correctedSplice.start || status.spliceStart || 0, speedFactor: status.speedFactor || 1.2, cacheError: '', repostedAt: new Date().toISOString() });
  return seedanceState(id);
}

function postState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const file = path.join(POST_JOBS, id, 'status.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function applyBrandingToLibrary(ids) {
  const selected = [...new Set((Array.isArray(ids) ? ids : []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!selected.length) throw new Error('请至少选择一条视频');
  const states = selected.map(id => {
    const state = seedanceState(id);
    if (!state) throw new Error(`视频记录不存在：${id}`);
    if (!state.postJobId) throw new Error(`视频尚无最终成片：${id}`);
    const post = postState(state.postJobId);
    if (!post || post.state !== 'succeeded') throw new Error(`视频尚未完成后期：${id}`);
    return { id, state, post };
  });
  const dramaTitles = [...new Set(states.map(item => String(item.state.dramaTitle || '').trim()).filter(Boolean))];
  if (dramaTitles.length !== 1) throw new Error('一次只能选择同一部剧的视频');
  const dramaTitle = dramaTitles[0];
  const sharedHighlight = states.map(item => path.join(POST_OUTPUTS, item.state.postJobId, '_work', '02-highlight.mp4')).find(fs.existsSync) || '';
  const results = [];
  for (const item of states) {
    const outputDir = path.join(POST_OUTPUTS, item.state.postJobId);
    const work = path.join(outputDir, '_work');
    const ai = ['01-ai-统一字幕版.mp4', '01-ai-字幕修正版.mp4', '01-ai.mp4'].map(name => path.join(work, name)).find(fs.existsSync);
    if (!ai) throw new Error(`找不到可包装的前贴文件：${item.id}`);
    const ownHighlight = path.join(work, '02-highlight.mp4');
    const highlight = fs.existsSync(ownHighlight) ? ownHighlight : sharedHighlight;
    if (!highlight) throw new Error(`该剧尚无可复用的原片衔接文件：${item.id}`);
    const output = path.join(outputDir, 'final-剧名警示语版.mp4');
    const completed = spawnSync(PYTHON, [BRANDING_SCRIPT, '--ai', ai, '--highlight', highlight, '--title', dramaTitle, '--output', output], { cwd: ROOT, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (completed.status !== 0 || !fs.existsSync(output)) throw new Error((completed.stderr || completed.stdout || `包装失败：${item.id}`).trim());
    const postFile = path.join(POST_JOBS, item.state.postJobId, 'status.json');
    safeWrite(postFile, { ...item.post, output, brandedOutput: output, brandedAt: new Date().toISOString() });
    const manifestFile = path.join(outputDir, 'manifest.json');
    if (fs.existsSync(manifestFile)) {
      try { const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); safeWrite(manifestFile, { ...manifest, output, branded_output: output }); } catch {}
    }
    results.push({ id: item.id, output, finalVideoUrl: `/api/local-video?path=${encodeURIComponent(output)}` });
  }
  return { ok: true, dramaTitle, count: results.length, items: results };
}

function brandingJobState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const file = path.join(BRAND_JOBS, id, 'status.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function runBrandingProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [BRANDING_SCRIPT, ...args], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `包装进程退出码 ${code}`)));
  });
}

function startBrandingBatch(selections) {
  const picked = Array.isArray(selections) ? selections.map(item => typeof item === 'string' ? { id: item, code: '' } : { id: String(item?.id || '').trim(), code: String(item?.code || '').trim() }).filter(item => item.id) : [];
  if (!picked.length) throw new Error('请至少选择一条视频');
  const states = picked.map(selection => {
    const state = seedanceState(selection.id);
    if (!state || !state.postJobId) throw new Error(`视频尚无最终成片：${selection.id}`);
    const post = postState(state.postJobId);
    if (!post || post.state !== 'succeeded') throw new Error(`视频尚未完成后期：${selection.id}`);
    return { ...selection, state, post };
  });
  const dramaTitles = [...new Set(states.map(item => String(item.state.dramaTitle || '').trim()).filter(Boolean))];
  if (dramaTitles.length !== 1) throw new Error('一次只能选择同一部剧的视频');
  const dramaTitle = dramaTitles[0];
  const sharedHighlight = states.map(item => path.join(POST_OUTPUTS, item.state.postJobId, '_work', '02-highlight.mp4')).find(fs.existsSync) || '';
  if (!sharedHighlight) throw new Error('该剧尚无可复用的原片衔接文件');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(BRAND_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
  const safeDrama = dramaTitle.replace(/[<>:"/\\|?*]/g, '_');
  const outputFolder = path.join(BRAND_OUTPUTS, `${safeDrama}-${id.slice(0, 19).replace('T', '-')}`);
  fs.mkdirSync(outputFolder, { recursive: true });
  const statusFile = path.join(jobDir, 'status.json');
  safeWrite(statusFile, { id, state: 'running', dramaTitle, total: states.length, completed: 0, progress: 0, current: '', outputFolder, outputs: [], createdAt: new Date().toISOString() });
  (async () => {
    const outputs = [];
    try {
      for (let index = 0; index < states.length; index += 1) {
        const item = states[index];
        const outputDir = path.join(POST_OUTPUTS, item.state.postJobId);
        const work = path.join(outputDir, '_work');
        const ai = ['01-ai-统一字幕版.mp4', '01-ai-字幕修正版.mp4', '01-ai.mp4'].map(name => path.join(work, name)).find(fs.existsSync);
        if (!ai) throw new Error(`找不到可包装的前贴文件：${item.id}`);
        const ownHighlight = path.join(work, '02-highlight.mp4');
        const highlight = fs.existsSync(ownHighlight) ? ownHighlight : sharedHighlight;
        const packaged = path.join(outputDir, 'final-剧名警示语版.mp4');
        const code = item.code || `视频-${String(index + 1).padStart(2, '0')}`;
        safeWrite(statusFile, { ...brandingJobState(id), current: code, progress: Math.round(index / states.length * 100) });
        await runBrandingProcess(['--ai', ai, '--highlight', highlight, '--title', dramaTitle, '--output', packaged]);
        const localOutput = path.join(outputFolder, `${code}-${safeDrama}.mp4`);
        fs.copyFileSync(packaged, localOutput);
        const postFile = path.join(POST_JOBS, item.state.postJobId, 'status.json');
        safeWrite(postFile, { ...postState(item.state.postJobId), output: packaged, brandedOutput: packaged, brandedAt: new Date().toISOString(), localDelivery: localOutput });
        outputs.push(localOutput);
        safeWrite(statusFile, { ...brandingJobState(id), completed: index + 1, progress: Math.round((index + 1) / states.length * 100), outputs });
      }
      safeWrite(statusFile, { ...brandingJobState(id), state: 'succeeded', progress: 100, current: '', finishedAt: new Date().toISOString() });
      const explorer = spawn('explorer.exe', [outputFolder], { detached: true, windowsHide: false, stdio: 'ignore' }); explorer.unref();
    } catch (error) {
      safeWrite(statusFile, { ...brandingJobState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() });
    }
  })();
  return brandingJobState(id);
}

function subtitleEndNearTen(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const content = fs.readFileSync(file, 'utf8');
    const ends = [...content.matchAll(/-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g)].map(match => Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000).filter(value => value >= 5 && value <= 10);
    return ends.length ? Math.round(Math.max(...ends) * 10) / 10 : null;
  } catch { return null; }
}

function cachedCaptionDrafts() {
  const bySource = new Map();
  if (!fs.existsSync(NARRATION_DRAFTS)) return bySource;
  for (const entry of fs.readdirSync(NARRATION_DRAFTS, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const draft = narrationDraftState(entry.name);
    if (draft?.state !== 'completed' || !draft.source || !Array.isArray(draft.candidates)) continue;
    const captions = normalizePrehookCaptions(draft.candidates.map((text, index) => ({ text, yellow: draft.highlights?.[index]?.yellow, red: draft.highlights?.[index]?.red })));
    if (!captions.length) continue;
    const key = path.resolve(draft.source).toLowerCase();
    const previous = bySource.get(key);
    if (!previous || String(draft.finishedAt || '') > String(previous.finishedAt || '')) bySource.set(key, { captions, finishedAt: draft.finishedAt || '' });
  }
  return bySource;
}

function mediaLibrary() {
  const items = [];
  const cachedCaptions = cachedCaptionDrafts();
  for (const entry of fs.readdirSync(SEEDANCE_JOBS, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const state = seedanceState(entry.name); if (!state) continue;
    const prompt = state.generationPayload?.content?.find(item => item.type === 'text')?.text || '';
    const post = state.postJobId ? postState(state.postJobId) : null;
    const finalOutput = post?.state === 'succeeded' && post.output && fs.existsSync(post.output) ? post.output : '';
    const postCachedRaw = state.postJobId ? path.join(POST_OUTPUTS, state.postJobId, '_work', 'ai-source.mp4') : '';
    const cachedRaw = state.cachedRaw && fs.existsSync(state.cachedRaw) ? state.cachedRaw : (postCachedRaw && fs.existsSync(postCachedRaw) ? postCachedRaw : '');
    const inferredDramaTitle = state.dramaTitle || (/林明远|婚房暗室|婚房柜/.test(prompt) ? '我的婚房不对劲' : '未归类剧目');
    const rawMode = state.sourceMode || '';
    const inferredMode = rawMode === 'short' ? 'single' : rawMode === 'long' ? 'progressive' : rawMode === 'curious' ? 'curious' : rawMode === 'remake' ? 'remake' : (/严格复刻原高光|起量高光/.test(prompt) ? 'remake' : Number(state.generationPayload?.duration || 0) > 10 ? 'progressive' : 'single');
    const scriptedCaptions = normalizePrehookCaptions(state.prehookCaptions);
    const fallbackCaptions = finalOutput ? cachedCaptions.get(path.resolve(finalOutput).toLowerCase())?.captions || [] : [];
    items.push({
      id: state.id, createdAt: post?.finishedAt || state.finishedAt || state.createdAt, submittedAt: state.createdAt, finishedAt: state.finishedAt, videoAt: post?.finishedAt || state.finishedAt || state.createdAt, state: post?.state === 'succeeded' ? 'final_succeeded' : post?.state === 'failed' ? 'post_failed' : state.state,
      dramaTitle: inferredDramaTitle, sourceTaskId: state.sourceTaskId || '', sourceMode: inferredMode, spliceVideo: state.spliceVideo || '', spliceStart: Number(state.spliceStart || 0), spliceAudioStart: Number(post?.splice?.audio_start ?? state.spliceAudioStart ?? state.spliceStart ?? 0), spliceCorrectionReason: state.spliceCorrectionReason || '', splicePolicyWarning: ['short', 'long', 'curious'].includes(rawMode) && Number(state.spliceStart || 0) !== 0 ? '历史成片裁剪了高光原片开头，不符合当前非复刻前贴规则；需重写前贴后复核。' : '',
      title: prompt.replace(/\s+/g, ' ').slice(0, 55) || 'Seedance视频', model: state.generationPayload?.model || '', duration: state.generationPayload?.duration || '', resolution: state.generationPayload?.resolution || '', cost: state.totalCost || '',
      finalOutput, finalVideoUrl: finalOutput ? `/api/local-video?path=${encodeURIComponent(finalOutput)}&v=${Math.trunc(fs.statSync(finalOutput).mtimeMs)}` : '', subtitle: post?.subtitle || '', suggestedNarrationEnd: subtitleEndNearTen(post?.subtitle), spliceReviewUrl: post?.splice?.review_clip && fs.existsSync(post.splice.review_clip) ? `/api/local-video?path=${encodeURIComponent(post.splice.review_clip)}` : '', rawVideoUrl: cachedRaw ? `/api/local-video?path=${encodeURIComponent(cachedRaw)}&v=${Math.trunc(fs.statSync(cachedRaw).mtimeMs)}` : (state.videoUrl || ''), cachedRaw,
      error: post?.error || state.error || state.cacheError || '', cancellationNote: state.cancellationNote || '', taskId: state.taskId || '', prompt, dialogue: state.postDialogue || '', prehookCaptions: scriptedCaptions.length ? scriptedCaptions : fallbackCaptions, captionSource: scriptedCaptions.length ? 'script' : fallbackCaptions.length ? 'cached_draft' : '', cancelledAt: state.cancelledAt || '', ocrReport: post?.correctedOcrReport || post?.ocrReport || null
    });
  }
  for (const entry of fs.readdirSync(NARRATION_JOBS, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const state = narrationState(entry.name); if (!state) continue;
    const output = state.state === 'succeeded' && state.output && fs.existsSync(state.output) ? state.output : '';
    items.push({ id: state.id, createdAt: state.finishedAt || state.createdAt, videoAt: state.finishedAt || state.createdAt, state: output ? 'final_succeeded' : state.state, dramaTitle: state.dramaTitle || '未归类剧目', sourceTaskId: state.sourceSeedanceId || '', sourceMode: state.displayOnly ? 'text_hook' : 'narration', title: state.displayOnly ? `“${state.narration || '吸睛文案版'}”` : state.narration || '吸睛文案版', model: state.displayOnly ? `画面文字·${Number(state.speedFactor || 1).toFixed(1)}倍·原声同步` : state.voiceFile ? '自带旁白音频' : 'Edge TTS', duration: state.duration || '', resolution: '', cost: '无 Seedance 费用', finalOutput: output, finalVideoUrl: output ? `/api/local-video?path=${encodeURIComponent(output)}&v=${Math.trunc(fs.statSync(output).mtimeMs)}` : '', subtitle: state.subtitle || '', rawVideoUrl: '', cachedRaw: state.sourceVideo || '', error: state.error || '', prompt: `${state.displayOnly ? '画面文案' : '配音旁白'}：“${state.narration || ''}”\n展示：${state.startSeconds || 0}–${state.narrationEnd ?? state.maxEndSeconds ?? '?'}秒\n倍速：${state.speedFactor || 1}\n底片：${state.sourceVideo || ''}`, dialogue: state.narration || '' });
  }
  return items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function narrationState(id) {
  const file = path.join(NARRATION_JOBS, id, 'status.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function narrationDraftState(id) {
  const file = path.join(NARRATION_DRAFTS, id, 'status.json');
  if (!/^[a-zA-Z0-9-]+$/.test(id) || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function startNarrationDraft(input) {
  const dramaTitle = String(input.dramaTitle || '').trim();
  const summary = String(input.summary || '').trim();
  const displayOnly = input.displayOnly === true;
  const seedId = String(input.sourceSeedanceId || '').trim();
  const item = seedId ? mediaLibrary().find(entry => entry.id === seedId && !['narration', 'text_hook'].includes(entry.sourceMode)) : null;
  const source = item?.finalOutput || String(input.sourceVideo || '').trim();
  if (!dramaTitle && !summary) throw new Error('请先填写剧名或剧情简介');
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) throw new Error('请先选择可播放的本地底片，再按实际画面拟旁白');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(NARRATION_DRAFTS, id); fs.mkdirSync(dir, { recursive: true });
  const statusFile = path.join(dir, 'status.json'), resultFile = path.join(dir, 'result.json'), logFile = path.join(dir, 'codex.log');
  const createdAt = new Date().toISOString();
  safeWrite(statusFile, { id, state: 'running', dramaTitle, source, createdAt });
  const prompt = `用 $short-drama-prehook-production 的${displayOnly ? '成片库吸睛画面文案' : '旁白制作'}规则，为一条已获授权的短剧底片写3句${displayOnly ? '只显示在画面上、不朗读的左下角吸睛文案' : '吸睛画外音'}候选。必须实际检查底片开头至少关键画面和声音；不能只凭简介虚构事实。\n剧名：${dramaTitle || '未提供'}\n作品简介（仅供理解，和底片不一致时以底片为准）：${summary || '未提供'}\n底片：${source}\n要求：第一句可概括剧名/主角处境，第二句抓身份反差，第三句抓一个已证实的悬念；每句不超过${displayOnly ? 28 : 30}个汉字，口语化、文明、避免剧透终局；不得照抄片中对白，不得新增片中不存在的动作、人物或危机。首个画面或对白不足以支持具体剧情时，候选只能使用已知的剧名与中性悬念，不得猜测。${displayOnly ? '每句再挑一个黄色重点词和一个红色反转词，二者都必须是该句中的连续原文片段，不重叠；不合适可以留空。此文案是画面文字，不要安排语音、TTS或原声压低。' : ''}仅输出严格 JSON：{"candidates":["句1","句2","句3"],"highlights":[{"yellow":"词","red":"词"},{"yellow":"词","red":"词"},{"yellow":"词","red":"词"}],"evidence":"实际核对到的底片开头简述","uncertainty":"尚待人工核对的地方"}。不要发起任何视频生成、上传或付费调用。`;
  const child = spawn(CODEX, ['exec', '-', '-C', WORKSPACE, '--sandbox', 'workspace-write', '--output-last-message', resultFile, '--color', 'never'], { cwd: WORKSPACE, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(logFile, { flags: 'a' }); child.stdout.pipe(log); child.stderr.pipe(log); child.stdin.end(prompt, 'utf8');
  child.on('error', error => safeWrite(statusFile, { ...narrationDraftState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  child.on('close', code => {
    log.end();
    try {
      if (code !== 0 || !fs.existsSync(resultFile)) throw new Error('Codex 未产出有效旁白候选');
      const raw = fs.readFileSync(resultFile, 'utf8').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      const result = JSON.parse(raw);
      if (!Array.isArray(result.candidates) || result.candidates.length !== 3 || result.candidates.some(value => typeof value !== 'string' || !value.trim() || value.length > (displayOnly ? 28 : 70))) throw new Error('画面文案候选格式或长度无效');
      const highlights = Array.isArray(result.highlights) ? result.highlights.slice(0, 3).map((item, index) => ({ yellow: result.candidates[index].includes(String(item?.yellow || '')) ? String(item?.yellow || '') : '', red: result.candidates[index].includes(String(item?.red || '')) ? String(item?.red || '') : '' })) : [];
      safeWrite(statusFile, { ...narrationDraftState(id), state: 'completed', candidates: result.candidates, highlights, evidence: String(result.evidence || ''), uncertainty: String(result.uncertainty || ''), finishedAt: new Date().toISOString() });
    } catch (error) { safeWrite(statusFile, { ...narrationDraftState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }); }
  });
  return narrationDraftState(id);
}

function startNarrationOverlay(input) {
  const libraryMode = input.libraryMode === true;
  const displayOnly = input.displayOnly === true;
  const sourceSeedanceId = String(input.sourceSeedanceId || '').trim();
  if (libraryMode && !sourceSeedanceId) throw new Error('请从成片库选择一条已完成视频');
  let sourceVideo = String(input.sourceVideo || '').trim();
  if (sourceSeedanceId) {
    const item = mediaLibrary().find(entry => entry.id === sourceSeedanceId && !['narration', 'text_hook'].includes(entry.sourceMode));
    if (!item || !item.finalOutput || !fs.existsSync(item.finalOutput)) throw new Error('所选 AI 前贴尚无可用的本地最终成片');
    sourceVideo = item.finalOutput;
  }
  if (!sourceVideo || !path.isAbsolute(sourceVideo) || !fs.existsSync(sourceVideo) || !fs.statSync(sourceVideo).isFile() || !/\.(?:mp4|mov|mkv)$/i.test(sourceVideo)) throw new Error('请选择成片库视频，或填写存在的本地原片路径');
  let narration = String(input.narration || '').trim();
  if (displayOnly && narration.startsWith('“') && narration.endsWith('”')) narration = narration.slice(1, -1).trim();
  if (!narration || narration.length > 120) throw new Error('请填写不超过120字的旁白文案');
  if (displayOnly && !libraryMode) throw new Error('画面文案请从成片库选择已完成视频');
  if (libraryMode && (narration.length > (displayOnly ? 28 : 70) || /[\r\n]/.test(narration) || (narration.match(/[。！？!?]/g) || []).length > 1)) throw new Error(displayOnly ? '成片库画面文案请保持一句话、28字以内' : '成片库配音旁白请保持一句话、70字以内');
  const startSeconds = Number(input.startSeconds);
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error('旁白起声秒数无效');
  const maxEndSeconds = libraryMode ? Number(input.maxEndSeconds) : null;
  if (libraryMode && (!Number.isFinite(maxEndSeconds) || maxEndSeconds > 10 || maxEndSeconds <= 0 || startSeconds >= maxEndSeconds)) throw new Error('旁白必须从片头进入，最晚在第10秒前结束；请调整起止秒数');
  const voiceFile = String(input.voiceFile || '').trim();
  if (displayOnly && voiceFile) throw new Error('画面文案不需要配音文件');
  const accentYellow = displayOnly ? String(input.accentYellow || '').trim() : '';
  const accentRed = displayOnly ? String(input.accentRed || '').trim() : '';
  if ((accentYellow && !narration.includes(accentYellow)) || (accentRed && !narration.includes(accentRed))) throw new Error('强调词必须完整出现在画面文案里');
  const speedFactor = displayOnly ? Number(input.speedFactor ?? 1) : 1;
  if (!Number.isFinite(speedFactor) || speedFactor < 1 || speedFactor > 1.2) throw new Error('画面文案版倍速只能在1.0至1.2之间');
  if (voiceFile && (!path.isAbsolute(voiceFile) || !fs.existsSync(voiceFile) || !fs.statSync(voiceFile).isFile() || !/\.(?:mp3|wav|m4a)$/i.test(voiceFile))) throw new Error('自带旁白音频路径无效');
  if (voiceFile && input.burnSubtitles === true) throw new Error('自带旁白音频尚无可信词级时码，请关闭旁白字幕后生成');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(NARRATION_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
  const outputDir = path.join(NARRATION_OUTPUTS, id); fs.mkdirSync(outputDir, { recursive: true });
  const request = { source_video: sourceVideo, narration, start_seconds: startSeconds, max_end_seconds: maxEndSeconds, display_only: displayOnly, accent_yellow: accentYellow, accent_red: accentRed, speed_factor: speedFactor, voice: String(input.voice || 'zh-CN-XiaoxiaoNeural'), voice_file: voiceFile, burn_subtitles: !displayOnly && input.burnSubtitles === true, output_dir: outputDir };
  const requestFile = path.join(jobDir, 'request.json'); safeWrite(requestFile, request);
  const statusFile = path.join(jobDir, 'status.json');
  safeWrite(statusFile, { id, state: 'running', dramaTitle: String(input.dramaTitle || '未归类剧目').trim(), sourceSeedanceId, sourceVideo, narration, startSeconds, maxEndSeconds, displayOnly, accentYellow, accentRed, speedFactor, voiceFile, burnSubtitles: request.burn_subtitles, createdAt: new Date().toISOString() });
  const child = spawn(PYTHON, [path.join(ROOT, 'scripts', displayOnly ? 'text_hook_overlay.py' : 'narration_overlay.py'), '--request-file', requestFile], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('error', error => safeWrite(statusFile, { ...narrationState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  child.on('close', code => {
    try {
      if (code !== 0) throw new Error(stderr.trim() || `旁白合成失败，退出码 ${code}`);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).pop());
      safeWrite(statusFile, { ...narrationState(id), state: 'succeeded', output: result.output, duration: result.duration, subtitle: result.subtitle, subtitleStatus: result.subtitle_status, narrationEnd: result.narration_end, audioMode: result.audio_mode || '', layoutReport: result.layout_report || '', layoutPreview: result.layout_preview || '', layoutBox: result.layout_box || null, layoutSampleCount: result.layout_sample_count || 0, finishedAt: new Date().toISOString() });
    } catch (error) { safeWrite(statusFile, { ...narrationState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }); }
  });
  return narrationState(id);
}

function startPostPipeline(input) {
  const aiVideo = typeof input.aiVideo === 'string' ? input.aiVideo.trim() : '';
  if (!aiVideo) throw new Error('请填写Seedance视频地址或本地路径');
  const highlightVideo = typeof input.highlightVideo === 'string' ? input.highlightVideo.trim() : '';
  if (highlightVideo && !/^https?:\/\//i.test(highlightVideo) && (!path.isAbsolute(highlightVideo) || !fs.existsSync(highlightVideo))) throw new Error('原片高光文件不存在');
  const bgm = typeof input.bgm === 'string' ? input.bgm.trim() : '';
  if (bgm && (!path.isAbsolute(bgm) || !fs.existsSync(bgm))) throw new Error('BGM文件不存在');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(POST_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
  const outputDir = path.join(POST_OUTPUTS, id); fs.mkdirSync(outputDir, { recursive: true });
  const speedFactor = Number(input.speedFactor) === 1.5 ? 1.5 : 1.2;
  const request = { ai_video: aiVideo, highlight_video: highlightVideo, highlight_start: Math.max(0, Number(input.highlightStart) || 0), speed_factor: speedFactor, narration: typeof input.narration === 'string' ? input.narration.trim() : '', subtitle_text: typeof input.subtitleText === 'string' ? input.subtitleText.trim() : '', voice: input.voice || 'zh-CN-XiaoxiaoNeural', bgm, burn_subtitles: input.burnSubtitles !== false, cover_existing_subtitles: input.coverExistingSubtitles === true, smart_ocr_repair: input.smartOcrRepair !== false, output_dir: outputDir };
  const requestFile = path.join(os.tmpdir(), `post-pipeline-${id}.json`); fs.writeFileSync(requestFile, JSON.stringify(request, null, 2), 'utf8');
  const statusFile = path.join(jobDir, 'status.json'); safeWrite(statusFile, { id, state: 'running', createdAt: new Date().toISOString(), stages: { voice: request.narration ? 'running' : 'skipped', edit: 'queued', upload: 'not_requested' } });
  const child = spawn(PYTHON, [path.join(ROOT, 'scripts', 'post_pipeline.py'), '--request-file', requestFile], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('error', error => safeWrite(statusFile, { ...postState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  child.on('close', code => {
    try {
      if (code !== 0) throw new Error(stderr.trim() || `自动后期失败，退出码${code}`);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).pop());
      safeWrite(statusFile, { ...postState(id), state: 'succeeded', output: result.output, duration: result.duration, narrationAudio: result.narration_audio, subtitle: result.subtitle, ocrReport: result.ocr_report || null, splice: result.splice || null, stages: { voice: request.narration ? 'succeeded' : 'skipped', ocr: result.ocr_report ? 'succeeded' : 'skipped', edit: 'succeeded', upload: 'not_requested' }, finishedAt: new Date().toISOString() });
    } catch (error) { safeWrite(statusFile, { ...postState(id), state: 'failed', error: error.message, log: stderr.slice(-4000), finishedAt: new Date().toISOString() }); }
    try { if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile); } catch {}
  });
  return postState(id);
}

function startDelivery(id) {
  const status = postState(id);
  if (!status || status.state !== 'succeeded' || !status.output || !fs.existsSync(status.output)) throw new Error('成片尚未生成或文件不存在');
  if (!runtime.capabilities().delivery.available) throw new Error('TOS交付未配置：请使用自己的账号、桶和Python依赖');
  const statusFile = path.join(POST_JOBS, id, 'status.json');
  const reportRoot = path.join(POST_JOBS, id, 'delivery'); fs.mkdirSync(reportRoot, { recursive: true });
  safeWrite(statusFile, { ...status, stages: { ...status.stages, upload: 'running' } });
  const child = spawn(TOS_PYTHON, [TOS_SCRIPT, 'upload', status.output, '--media-type', 'video', '--link-mode', 'permanent', '--public-read', '--output', reportRoot], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('close', code => {
    try {
      if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `上传失败，退出码${code}`);
      const events = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const manifestPath = [...events].reverse().find(event => event.manifest)?.manifest;
      if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error('上传完成但未找到交付清单');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); const item = (manifest.items || [])[0];
      if (!item || !item.url || item.verification?.status !== 'passed') throw new Error('上传后匿名下载验证未通过');
      safeWrite(statusFile, { ...postState(id), stages: { ...postState(id).stages, upload: 'succeeded' }, deliveryUrl: item.url, deliveryManifest: manifestPath, deliveredAt: new Date().toISOString() });
    } catch (error) { safeWrite(statusFile, { ...postState(id), stages: { ...postState(id).stages, upload: 'failed' }, deliveryError: error.message }); }
  });
  return postState(id);
}

function reviewState(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  const file = path.join(REVIEW_JOBS, id, 'status.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function prepareReview(seedanceId) {
  const source = seedanceState(seedanceId);
  if (!source || source.state !== 'succeeded' || !source.videoUrl) throw new Error('Seedance视频尚未生成成功');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const prompt = source.generationPayload?.content?.find(item => item.type === 'text')?.text || '';
  const rubric = `你是短剧AI视频审片导演。请观看视频，结合原始生成提示词进行严格评分。总分100分：开头吸引力20、人物与服装一致性15、动作和物理合理性15、剧情信息清晰度20、口型音频与字幕15、尾镜衔接可用性15。任何明显乱码、畸形肢体、人物跳变、对白缺失、画面水印均需扣分。只返回JSON，不要Markdown。格式：{"total_score":0,"dimensions":{"hook":0,"character_consistency":0,"motion_physics":0,"story_clarity":0,"audio_lipsync_subtitle":0,"ending_continuity":0},"issues":["问题"],"repair_prompt":"可直接追加到原提示词的具体返修要求","summary":"结论"}。原始提示词：${prompt}`;
  const payload = { model: 'doubao-seed-2.1-pro', messages: [{ role: 'user', content: [{ type: 'text', text: rubric }, { type: 'video_url', video_url: { url: source.videoUrl } }] }], response_format: { type: 'json_object' }, temperature: 0.1 };
  const tempDir = path.join(SEEDANCE_TEMP, `review-${id}`); fs.mkdirSync(tempDir, { recursive: true });
  const payloadFile = path.join(tempDir, 'payload.json'); fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2), 'utf8');
  const jobDir = path.join(REVIEW_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
  safeWrite(path.join(jobDir, 'status.json'), { id, seedanceId, rootId: source.rootId || seedanceId, retryCount: source.retryCount || 0, threshold: 80, maxRetries: 2, state: 'awaiting_confirmation', endpoint: '/v1/chat/completions', payloadFile, payload, createdAt: new Date().toISOString() });
  return { id, state: 'awaiting_confirmation', endpoint: '/v1/chat/completions', payload, threshold: 80, maxRetries: 2, retryCount: source.retryCount || 0 };
}

function confirmReview(id) {
  const status = reviewState(id);
  if (!status) throw new Error('审片确认单不存在');
  if (status.state !== 'awaiting_confirmation') throw new Error('审片任务已经确认或执行');
  if (!status.payloadFile || !fs.existsSync(status.payloadFile)) throw new Error('审片临时参数已失效，请重新准备');
  const statusFile = path.join(REVIEW_JOBS, id, 'status.json');
  safeWrite(statusFile, { ...status, state: 'running', confirmedAt: new Date().toISOString() });
  const child = spawn(PYTHON, [path.join(ROOT, 'scripts', 'run_video_review.py'), '--payload-file', status.payloadFile], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); }); child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  child.on('close', code => {
    try {
      if (code !== 0) throw new Error(stderr.trim() || `审片失败，退出码${code}`);
      const result = JSON.parse(stdout.trim().split(/\r?\n/).pop());
      safeWrite(statusFile, { ...reviewState(id), state: 'succeeded', review: result.review, totalCost: result.total_cost_display, finishedAt: new Date().toISOString() });
    } catch (error) { safeWrite(statusFile, { ...reviewState(id), state: 'failed', error: error.message, finishedAt: new Date().toISOString() }); }
    try { if (fs.existsSync(status.payloadFile)) fs.unlinkSync(status.payloadFile); } catch {}
  });
  return reviewState(id);
}

function prepareRetry(reviewId) {
  const review = reviewState(reviewId);
  if (!review || review.state !== 'succeeded' || !review.review) throw new Error('审片尚未完成');
  if (Number(review.review.total_score) >= 80) throw new Error('评分已达到80分，无需返修');
  if (Number(review.retryCount) >= 2) throw new Error('已经达到最多2次返修限制');
  const source = seedanceState(review.seedanceId);
  if (!source?.generationPayload) throw new Error('原始Seedance参数不存在，无法保持参考素材返修');
  const payload = JSON.parse(JSON.stringify(source.generationPayload));
  const textItem = payload.content.find(item => item.type === 'text');
  if (!textItem) throw new Error('原始提示词不存在');
  textItem.text = `${textItem.text}\n\n返修要求（必须逐条执行）：${review.review.repair_prompt || (review.review.issues || []).join('；')}`;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const tempDir = path.join(SEEDANCE_TEMP, id); fs.mkdirSync(tempDir, { recursive: true });
  const payloadFile = path.join(tempDir, 'payload.json'); fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2), 'utf8');
  const jobDir = path.join(SEEDANCE_JOBS, id); fs.mkdirSync(jobDir, { recursive: true });
  safeWrite(path.join(jobDir, 'status.json'), { id, rootId: source.rootId || source.id, parentSeedanceId: source.id, retryCount: Number(source.retryCount || 0) + 1, state: 'awaiting_confirmation', createdAt: new Date().toISOString(), payloadFile, generationPayload: payload, preparedImages: source.preparedImages || [], dramaTitle: source.dramaTitle || '', sourceTaskId: source.sourceTaskId || '', sourceMode: source.sourceMode || '', prehookCaptions: normalizePrehookCaptions(source.prehookCaptions) });
  return { id, state: 'awaiting_confirmation', payload, retryCount: Number(source.retryCount || 0) + 1, maxRetries: 2 };
}

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const login = await codexLoginStatus();
    json(res, 200, { ok: true, version: '3.4.1', instance: crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 16), modes: MODE_ORDER, ...login, ocrInstalled: runtime.capabilities().ocr.available && fs.existsSync(OCR_SCRIPT) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    try {
      const input = await readBody(req);
      if (!MODES[input.mode]) return json(res, 400, { error: '工作流无效' });
      normalizeInput(input);
      return json(res, 202, startTask(input));
    } catch (error) { if (res.headersSent) { res.destroy(); return; } return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/batches') {
    try { return json(res, 202, createBatch(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/batches') {
    const batches = fs.readdirSync(BATCHES, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => batchState(entry.name)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
    return json(res, 200, { batches });
  }
  const addBatchModeMatch = url.pathname.match(/^\/api\/batches\/([a-zA-Z0-9-]+)\/modes\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'POST' && addBatchModeMatch) {
    try {
      const body = await readBody(req);
      return json(res, 202, addModeToBatch(addBatchModeMatch[1], addBatchModeMatch[2], body.force === true));
    }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/learn') {
    try { return json(res, 202, startLearning(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/recommend') {
    try { return json(res, 200, recommend(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/ocr/image') {
    try {
      const body = await readBody(req);
      const requested = path.resolve(String(body.path || ''));
      const relative = path.relative(WORKSPACE, requested);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OCR图片必须位于工作区内');
      if (!/\.(?:jpe?g|png|webp|bmp)$/i.test(requested) || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error('OCR图片不存在或格式不支持');
      if (!runtime.capabilities().ocr.available) throw new Error('中文OCR组件尚未安装');
      const args = ['--image', requested]; if (body.subtitleRegion !== false) args.push('--subtitle-region');
      return json(res, 200, await runJsonProcess(OCR_SCRIPT, args, ROOT, OCR_PYTHON));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/seedance/prepare') {
    try { return json(res, 200, await prepareSeedance(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/seedance/confirm') {
    try {
      const body = await readBody(req);
      return json(res, 202, confirmSeedance(String(body.id || '')));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/seedance/cancel') {
    try { const body = await readBody(req); return json(res, 200, cancelSeedance(String(body.id || ''))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/seedance/repost') {
    try { const body = await readBody(req); return json(res, 202, retrySeedancePost(String(body.id || ''), body.directSubtitles === true)); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/seedance/copies/prepare') {
    try { const body = await readBody(req); return json(res, 200, prepareSeedanceCopies(String(body.id || ''), body.count)); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/seedance/copies/confirm') {
    try { const body = await readBody(req); return json(res, 202, confirmSeedanceCopies(body.ids)); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/post/create') {
    try { return json(res, 202, startPostPipeline(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/narration/create') {
    try { return json(res, 202, startNarrationOverlay(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/narration/draft') {
    try { return json(res, 202, startNarrationDraft(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/narration/sources') {
    const items = mediaLibrary().filter(item => !['narration', 'text_hook'].includes(item.sourceMode) && item.finalOutput).map(item => ({ id: item.id, dramaTitle: item.dramaTitle, mode: item.sourceMode, title: item.title, videoUrl: item.finalVideoUrl }));
    return json(res, 200, { items });
  }
  if (req.method === 'POST' && url.pathname === '/api/library/brand') {
    try { const body = await readBody(req); return json(res, 202, startBrandingBatch(body.items || body.ids)); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/library/brand/')) {
    const state = brandingJobState(url.pathname.split('/').pop());
    return state ? json(res, 200, state) : json(res, 404, { error: '批量包装任务不存在' });
  }
  if (req.method === 'POST' && url.pathname === '/api/delivery/upload') {
    try { const body = await readBody(req); return json(res, 202, startDelivery(String(body.id || ''))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/review/prepare') {
    try { const body = await readBody(req); return json(res, 200, prepareReview(String(body.seedanceId || ''))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/review/confirm') {
    try { const body = await readBody(req); return json(res, 202, confirmReview(String(body.id || ''))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/retry/prepare') {
    try { const body = await readBody(req); return json(res, 200, prepareRetry(String(body.reviewId || ''))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/pipeline/capabilities') {
    return json(res, 200, { ...runtime.capabilities(), version: '3.4.1' });
  }
  if (req.method === 'GET' && url.pathname === '/api/library') return json(res, 200, { items: mediaLibrary() });
  if (req.method === 'GET' && url.pathname === '/api/local-image') {
    try {
      const requested = path.resolve(url.searchParams.get('path') || '');
      const relative = path.relative(WORKSPACE, requested);
      if (!requested || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('图片路径不在工作区内');
      if (!/\.(?:jpe?g|png|webp)$/i.test(requested) || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error('参考图不存在');
      const ext = path.extname(requested).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const data = fs.readFileSync(requested);
      res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store' });
      return res.end(data);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/open-path') {
    try {
      const body = await readBody(req);
      if (typeof body.path !== 'string' || !path.isAbsolute(body.path)) return json(res, 400, { error: '本地路径无效' });
      const target = path.resolve(body.path);
      if (!fs.existsSync(target)) return json(res, 404, { error: '文件或文件夹不存在' });
      const stat = fs.statSync(target);
      const args = stat.isDirectory() ? [target] : ['/select,', target];
      const explorer = spawn('explorer.exe', args, { windowsHide: false, detached: true, stdio: 'ignore' });
      explorer.unref();
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/local-video') {
    try {
      const requested = path.resolve(url.searchParams.get('path') || '');
      const inPost = (() => { const relative = path.relative(POST_OUTPUTS, requested); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })();
      const inLibrary = (() => { const relative = path.relative(LIBRARY_OUTPUTS, requested); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })();
      const inNarration = (() => { const relative = path.relative(NARRATION_OUTPUTS, requested); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })();
      if (!requested || (!inPost && !inLibrary && !inNarration)) throw new Error('视频路径不在成片库内');
      if (!/\.mp4$/i.test(requested) || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error('成片不存在');
      const stat = fs.statSync(requested); const range = req.headers.range;
      let stream;
      if (range) {
        const [startText, endText] = range.replace(/bytes=/, '').split('-');
        const start = Number(startText); const end = Math.min(endText ? Number(endText) : stat.size - 1, stat.size - 1);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= stat.size || end < start) throw new Error('视频分段范围无效');
        stream = fs.createReadStream(requested, { start, end });
        stream.on('error', error => res.headersSent ? res.destroy(error) : json(res, 500, { error: error.message }));
        res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
        return stream.pipe(res);
      }
      stream = fs.createReadStream(requested);
      stream.on('error', error => res.headersSent ? res.destroy(error) : json(res, 500, { error: error.message }));
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      return stream.pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      return json(res, 400, { error: error.message });
    }
  }
  const learningMatch = url.pathname.match(/^\/api\/learn\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && learningMatch) {
    const state = learningState(learningMatch[1]); return state ? json(res, 200, state) : json(res, 404, { error: '学习任务不存在' });
  }
  const seedanceMatch = url.pathname.match(/^\/api\/seedance\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && seedanceMatch) {
    const state = seedanceState(seedanceMatch[1]);
    if (!state) return json(res, 404, { error: 'Seedance任务不存在' });
    if (state.postJobId) {
      const post = postState(state.postJobId);
      if (post?.state === 'succeeded') return json(res, 200, { ...state, state: 'succeeded', finalOutput: post.output, finalVideoUrl: `/api/local-video?path=${encodeURIComponent(post.output)}&v=${Math.trunc(fs.statSync(post.output).mtimeMs)}`, subtitle: post.subtitle, postState: post.state });
      if (post?.state === 'failed') return json(res, 200, { ...state, state: 'post_failed', error: post.error || '自动配音字幕合成失败', postState: post.state });
      return json(res, 200, { ...state, state: 'post_processing', postState: post?.state || 'running' });
    }
    return json(res, 200, state);
  }
  const postMatch = url.pathname.match(/^\/api\/post\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && postMatch) {
    const state = postState(postMatch[1]); return state ? json(res, 200, state) : json(res, 404, { error: '自动后期任务不存在' });
  }
  const narrationMatch = url.pathname.match(/^\/api\/narration\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && narrationMatch) {
    const state = narrationState(narrationMatch[1]);
    return state ? json(res, 200, { ...state, videoUrl: state.output && fs.existsSync(state.output) ? `/api/local-video?path=${encodeURIComponent(state.output)}&v=${Math.trunc(fs.statSync(state.output).mtimeMs)}` : '' }) : json(res, 404, { error: '旁白任务不存在' });
  }
  const narrationDraftMatch = url.pathname.match(/^\/api\/narration\/draft\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && narrationDraftMatch) {
    const state = narrationDraftState(narrationDraftMatch[1]);
    return state ? json(res, 200, state) : json(res, 404, { error: '旁白候选任务不存在' });
  }
  const reviewMatch = url.pathname.match(/^\/api\/review\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && reviewMatch) {
    const state = reviewState(reviewMatch[1]); return state ? json(res, 200, state) : json(res, 404, { error: '审片任务不存在' });
  }
  const batchMatch = url.pathname.match(/^\/api\/batches\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && batchMatch) {
    const batch = batchState(batchMatch[1]);
    return batch ? json(res, 200, batch) : json(res, 404, { error: '批次不存在' });
  }
  const match = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && match) {
    const status = taskState(match[1]);
    return status ? json(res, 200, status) : json(res, 404, { error: '任务不存在' });
  }
  const artifactMatch = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/artifact$/);
  if (req.method === 'GET' && artifactMatch) {
    const artifact = taskArtifact(artifactMatch[1]);
    return artifact ? json(res, 200, artifact) : json(res, 404, { error: '案例文件不存在' });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveFile(res, path.join(PUBLIC, 'index.html'));
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`二创工作台已启动：http://${HOST}:${PORT}`);
  console.log(`任务目录：${TASKS}`);
  for (const entry of fs.readdirSync(SEEDANCE_JOBS, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const state = seedanceState(entry.name);
    if (state?.videoUrl && (!state.cachedRaw || !fs.existsSync(state.cachedRaw))) cacheSeedanceVideo(state.id, state.videoUrl);
  }
});
