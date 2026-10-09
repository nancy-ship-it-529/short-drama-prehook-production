# 更新与分发

本文件夹是制作规则的发布源，版本写在 `SKILL.md` 的 `metadata.version`。自 3.4.0 起，`workbench-server/` 包含配套工作台源码；规则与程序仍需分别修改和验证，不能仅改文档就称服务已更新。接收者不会获得发布者的视频、账户、付费权限或历史任务。

## 发布新版

1. 根据用户的新要求只改相关规则，避免把单条素材的偶然问题推广成通用禁令；若改变默认四路、各模式的原片边界、收费门禁或验收条件，同步核对工作台实现。
2. 提升 `metadata.version`：兼容措辞修正用 patch，新能力用 minor，破坏性流程变化用 major。
3. 用 `skill-creator/scripts/quick_validate.py` 验证 Skill，并检查默认四路各自的原片边界、字幕、付费门禁；改过工作台代码时另跑其单元测试。
4. 在此文件夹的 `scripts/package-skill.ps1` 运行打包，得到带版本号且不含 `.git` 的 ZIP。共享仓库只提交 Skill 与配套工作台源码，不提交运行数据、凭证或内置账号资源。推送后让接收者 `git pull --ff-only`，并明确版本号。

## 接收者更新

使用共享 Git 仓库时，同事把仓库克隆到自己的 `~/.codex/skills/short-drama-prehook-production`，以后在该目录执行 `git pull --ff-only`。使用 ZIP 时，先解压，再运行包内的 `scripts/install-update.ps1 -Package <ZIP绝对路径>`；默认安装到当前用户 Codex Skills 目录，项目级安装可额外传 `-TargetSkillsDir <项目\.agents\skills>`。脚本会先验证包结构，旧版保留为同目录时间戳备份，再装新版。重启或刷新会话后用 `$short-drama-prehook-production` 调用。

当前远端为公开仓库 `https://github.com/nancy-ship-it-529/short-drama-prehook-production`。任何人可直接查看、下载和克隆，无需邀请；写入主仓库仍需维护者授权。接收者执行 `git pull --ff-only` 后，规则和本仓库工作台源码一起更新；需重启本仓库服务，依赖变化时重新运行安装脚本。另一目录的旧工作台不会自动替换；核对健康接口与页面的版本号。不要删除自己的配置、任务和成片来更新程序。

公开发布前检查本次文件与 Git 历史，不提交密钥、认证数据、用户原片、任务记录或非公开业务资料。分享规则不等于分享模型额度或素材使用权。
