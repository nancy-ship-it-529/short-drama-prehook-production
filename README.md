# 短剧二创前贴制作 Skill

此仓库只分享制作规则与更新脚本，不包含原片、任务、模型密钥或工作台程序。

共享仓库：`https://github.com/nancy-ship-it-529/short-drama-prehook-production`（公开）。任何人均可查看、下载和克隆，无需邀请；向主仓库写入仍需维护者授权。

首次使用：把本仓库克隆到自己的 Codex Skills 目录，文件夹名保持 `short-drama-prehook-production`；随后在 Codex 中使用 `$short-drama-prehook-production`。Windows PowerShell 示例：

```powershell
git clone https://github.com/nancy-ship-it-529/short-drama-prehook-production.git "$env:USERPROFILE\.codex\skills\short-drama-prehook-production"
```

项目级使用也可克隆到项目的 `.agents/skills/` 下。

更新：在克隆目录执行 `git pull --ff-only`，刷新 Codex 会话，核对 `SKILL.md` 的版本号。发布者修改规则后应提升版本、验证并推送；同事拉取后才会得到新版。

工作台程序与本 Skill 独立；更新规则不会自动更新别人电脑上的程序或既有视频。
