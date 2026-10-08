param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$TargetSkillsDir
)

$ErrorActionPreference = 'Stop'
$sourceZip = (Resolve-Path -LiteralPath $Package).Path
if (-not $sourceZip.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package 必须是 ZIP 文件' }
if (-not $TargetSkillsDir) {
  $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  $TargetSkillsDir = Join-Path $codexRoot 'skills'
}
$targetRoot = [IO.Path]::GetFullPath($TargetSkillsDir)
if ([IO.Path]::GetPathRoot($targetRoot) -eq $targetRoot) { throw '不能把磁盘根目录作为 Skills 目录' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = [IO.Path]::GetFullPath((Join-Path $tempRoot ("prehook-skill-" + [guid]::NewGuid().ToString('N'))))
if (-not $temporary.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '临时目录越界' }
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  Expand-Archive -LiteralPath $sourceZip -DestinationPath $temporary
  $source = Join-Path $temporary 'short-drama-prehook-production'
  $skillFile = Join-Path $source 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) { throw '压缩包缺少正确的 Skill 文件夹' }
  $raw = Get-Content -LiteralPath $skillFile -Raw -Encoding UTF8
  if ($raw -notmatch '(?m)^name:\s*short-drama-prehook-production\s*$') { throw '压缩包中的 Skill 名称不符' }
  $incomingVersion = [regex]::Match($raw, '(?m)^\s*version:\s*(\d+\.\d+\.\d+)\s*$').Groups[1].Value
  if (-not $incomingVersion) { throw '压缩包缺少版本号' }
  New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
  $destination = [IO.Path]::GetFullPath((Join-Path $targetRoot 'short-drama-prehook-production'))
  if (-not $destination.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装目录越界' }
  if (Test-Path -LiteralPath $destination) {
    $existing = Get-Content -LiteralPath (Join-Path $destination 'SKILL.md') -Raw -Encoding UTF8
    $existingVersion = [regex]::Match($existing, '(?m)^\s*version:\s*(\d+\.\d+\.\d+)\s*$').Groups[1].Value
    if ($existingVersion -and ([version]$existingVersion -ge [version]$incomingVersion)) { throw "目标版本 $existingVersion 不低于安装包 $incomingVersion；请使用更新的包" }
    $backup = Join-Path $targetRoot ("short-drama-prehook-production.backup." + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    if (Test-Path -LiteralPath $backup) { throw "备份路径已存在：$backup" }
    Move-Item -LiteralPath $destination -Destination $backup
  }
  try { Copy-Item -LiteralPath $source -Destination $destination -Recurse }
  catch {
    if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath $backup -Destination $destination }
    throw
  }
  $installed = Get-Content -LiteralPath (Join-Path $destination 'SKILL.md') -Raw -Encoding UTF8
  $version = [regex]::Match($installed, '(?m)^\s*version:\s*(\d+\.\d+\.\d+)\s*$').Groups[1].Value
  [pscustomobject]@{ Installed = $destination; Version = $version; Backup = $backup }
} finally {
  if ((Test-Path -LiteralPath $temporary) -and $temporary.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $temporary).StartsWith('prehook-skill-')) {
    Remove-Item -LiteralPath $temporary -Recurse -Force
  }
}
