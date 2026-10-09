# 短剧二创前贴制作 Skill

自 **3.4.0** 起，此仓库同时提供制作 Skill 和配套四路工作台源码，不包含原片、历史任务、账号、模型密钥或内置凭证。

共享仓库：`https://github.com/nancy-ship-it-529/short-drama-prehook-production`（公开）。任何人均可查看、下载和克隆，无需邀请；向主仓库写入仍需维护者授权。

首次使用：把本仓库克隆到自己的 Codex Skills 目录，文件夹名保持 `short-drama-prehook-production`；随后在 Codex 中使用 `$short-drama-prehook-production`。Windows PowerShell 示例：

```powershell
git clone https://github.com/nancy-ship-it-529/short-drama-prehook-production.git "$env:USERPROFILE\.codex\skills\short-drama-prehook-production"
```

项目级使用也可克隆到项目的 `.agents/skills/` 下。

更新：在克隆目录执行 `git pull --ff-only`，刷新 Codex 会话，核对 `SKILL.md` 的版本号。发布者修改规则后应提升版本、验证并推送；同事拉取后才会得到新版。

## 安装并打开配套工作台（Windows）

前提：Node.js 20+、Python 3.10+、支持 libass 的 FFmpeg、已安装并登录的 Codex CLI。Codex 桌面内置的 Node/Python 可自动检测；缺少时安装各自官方运行时。第一次安装会下载 Python 依赖，但不会生成视频、上传素材或发起付费调用。

在上述克隆目录运行：

```powershell
& .\workbench-server\setup-workbench.ps1
& .\workbench-server\start-workbench.ps1
```

浏览器打开 `http://127.0.0.1:3217/#workbench`。界面版本应为 **3.7.0**，含单爆点、递进、复刻、猎奇四路、脚本及付费前规则检查，以及任务栏和按剧名分类的成片库；猎奇首段须写明前三秒三拍强视觉钩子；吸睛画面文案按简介与画面写，最多36字、两行排版；支持 9:16、16:9、1:1 画幅，后期保持所选画幅；剧名和警示语包装须对照实际原片版式，识别不出时停止而非套用固定坐标。若旧程序占用端口，运行 `start-workbench.ps1 -Port 3218`，不要继续使用旧页面。

### 自己的配置

启动空工作台无需模型密钥；生成脚本需要自己的 Codex 登录。视频生成与审片需要在本机 `workbench-server/credentials.env` 填写自己的 `ZLHUB_API_BASE`、`ZLHUB_API_KEY`，密钥不要发在公开仓库或聊天中。其他素材送审/TOS字段按自己的账号填写；参考图未获授权或送审配置缺失时不得提交。每条收费生成与返修都要先确认。

FFmpeg、Codex 可直接在 PATH 中，也可用环境变量 `FFMPEG_BIN`、`CODEX_BIN` 指定可执行文件。其他路径可在忽略提交的 `workbench-server/.local-config.json` 中配置：`PYTHON_BIN`、`OCR_PYTHON`、`WORKBENCH_WORKSPACE`、`WORKBENCH_PORT`、`ZLHUB_SCRIPTS`、`TOS_SCRIPT`、`TOS_PYTHON`。虚拟环境 `.venv` 自动检测，通常不用填路径。Windows 若 PATH 中的 Codex 只是 `.cmd` 启动器，请配置可直接执行的 Codex 程序路径。素材应位于配置的工作区，才能在页面预览。

TOS交付使用自己的桶及权限；上传源码随包提供，但不会共享发布者账号。需配置 `TOS_AK`、`TOS_SK`、`TOS_BUCKET`、`TOS_REGION`、`TOS_ENDPOINT`；长期公开链接表示对象允许匿名读取，不保证永久保存。首次 OCR/ASR/人脸检测可能下载开源模型；程序不包含这些权重或付费额度。未配置能力在页面显示待配置，不等于完整生产已可用。

### 更新、停止与测试

在仓库目录 `git pull --ff-only`；停止本目录服务后重新运行启动脚本。必要时重跑安装脚本，保留自己的 credentials.env 和任务目录。Skill、同仓库工作台源码一起更新；其他目录的旧程序和既有成片不会自动修改。ZIP 安装脚本会保留旧目录备份，旧目录中的配置和任务需按需迁移，不能直接删备份。

```powershell
& .\workbench-server\stop-workbench.ps1 -Port 3217
# 源码健康/空库测试，不调用付费模型
cd .\workbench-server
npm test
# 可选浏览器回归测试
npm install
npx playwright install chromium
npm run test:ui
# 已配置 FFmpeg/Python/OCR 后的合成测试：仅用合成测试片
npm run test:media
```

本程序只绑定 `127.0.0.1`，不要直接部署成公网服务。安装/公开源码不构成素材肖像和版权授权。验片仍须查看实际画面、声音与字幕，不能仅凭模型评分或进度判定合格。
