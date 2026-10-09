param(
  [string]$OutputDir = (Join-Path (Get-Location) 'dist\skills')
)

$ErrorActionPreference = 'Stop'
$skillDir = Split-Path -Parent $PSScriptRoot
$skillFile = Join-Path $skillDir 'SKILL.md'
if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) { throw '缺少 SKILL.md' }
$raw = Get-Content -LiteralPath $skillFile -Raw -Encoding UTF8
if ($raw -notmatch '(?m)^name:\s*short-drama-prehook-production\s*$') { throw 'Skill 名称不符' }
$match = [regex]::Match($raw, '(?m)^\s*version:\s*(\d+\.\d+\.\d+)\s*$')
if (-not $match.Success) { throw '缺少语义版本号' }
$version = $match.Groups[1].Value
$output = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archive = Join-Path $output "short-drama-prehook-production-$version.zip"
if (Test-Path -LiteralPath $archive) { throw "该版本包已存在，请先提升版本号：$archive" }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$staging = [IO.Path]::GetFullPath((Join-Path $tempRoot ("prehook-package-" + [guid]::NewGuid().ToString('N'))))
if (-not $staging.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '打包临时目录越界' }
$stagedSkill = Join-Path $staging 'short-drama-prehook-production'
New-Item -ItemType Directory -Path $stagedSkill -Force | Out-Null
try {
  foreach ($item in @('SKILL.md', 'README.md', '.gitignore', 'references', 'scripts')) {
    $source = Join-Path $skillDir $item
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $stagedSkill -Recurse }
  }
  # Package release source by allowlist, never recursively copy runtime/job directories.
  $appRoot = Join-Path $skillDir 'workbench-server'
  if (Test-Path -LiteralPath $appRoot) {
    $sourceFiles = @('server.js','runtime-config.js','start-workbench.ps1','stop-workbench.ps1','setup-workbench.ps1','requirements.txt','package.json','credentials.example.env','public\index.html')
    foreach ($sourceDir in @('scripts','connectors','tests')) {
      foreach ($entry in (Get-ChildItem -LiteralPath (Join-Path $appRoot $sourceDir) -Recurse -File)) {
        $relative = $entry.FullName.Substring($appRoot.Length + 1)
        if ($entry.Extension -in @('.py','.js') -and $relative -notmatch '(^|[\\/])(resources|__pycache__|node_modules)([\\/]|$)') { $sourceFiles += $relative }
      }
    }
    foreach ($relative in $sourceFiles) {
      $destination = Join-Path $stagedSkill ('workbench-server\' + $relative)
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $appRoot $relative) -Destination $destination
    }
  }
  Compress-Archive -LiteralPath $stagedSkill -DestinationPath $archive
} finally {
  if ((Test-Path -LiteralPath $staging) -and $staging.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $staging).StartsWith('prehook-package-')) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
Get-Item -LiteralPath $archive | Select-Object FullName,Length
