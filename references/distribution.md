# 更新与分发

本文件夹是制作规则的发布源，版本写在 `SKILL.md` 的 `metadata.version`。工作台 `server.js` 与它目前是两份独立实现：修改 Skill 不会自动改变服务器行为；如要求工作台同步执行新规则，需另改代码并跑相关测试。其他人安装 Skill 后获得的是判断和写作规则，不会自动获得本机视频、账户、付费权限或已生成任务。

## 发布新版

1. 根据用户的新要求只改相关规则，避免把单条素材的偶然问题推广成通用禁令；若改变默认四路、各模式的原片边界、收费门禁或验收条件，同步核对工作台实现。
2. 提升 `metadata.version`：兼容措辞修正用 patch，新能力用 minor，破坏性流程变化用 major。
3. 用 `skill-creator/scripts/quick_validate.py` 验证 Skill，并检查默认四路各自的原片边界、字幕、付费门禁；改过工作台代码时另跑其单元测试。
4. 在此文件夹的 `scripts/package-skill.ps1` 运行打包，得到带版本号且不含 `.git` 的 ZIP。若有共享 Git 仓库，只提交本 Skill 的说明与脚本，推送后让同事 `git pull --ff-only`；发布者应明确告诉同事版本号。

## 接收者更新

使用共享 Git 仓库时，同事把仓库克隆到自己的 `~/.codex/skills/short-drama-prehook-production`，以后在该目录执行 `git pull --ff-only`。使用 ZIP 时，先解压，再运行包内的 `scripts/install-update.ps1 -Package <ZIP绝对路径>`；默认安装到当前用户 Codex Skills 目录，项目级安装可额外传 `-TargetSkillsDir <项目\.agents\skills>`。脚本会先验证包结构，旧版保留为同目录时间戳备份，再装新版。重启或刷新会话后用 `$short-drama-prehook-production` 调用。

当前远端为私有仓库 `https://github.com/nancy-ship-it-529/short-drama-prehook-production`。同事须先被邀请并接受访问；发布者推送新版后，同事执行 `git pull --ff-only` 才会更新。Git 更新只同步 Skill，不会同步工作台代码、视频、账号或密钥；仍需确认各自工作台版本匹配。
