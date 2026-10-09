param([switch]$NoOpen, [int]$Port)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$node = if ($env:NODE_BIN) { $env:NODE_BIN } elseif ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $node)) { throw '未找到 Node.js 20+；请安装或设置 NODE_BIN' }
if ($Port) { $env:WORKBENCH_PORT = [string]$Port }
Push-Location -LiteralPath $root
try {
  $configRaw = & $node -e 'const c=require("./runtime-config");const instance=require("crypto").createHash("sha256").update(process.cwd()).digest("hex").slice(0,16);console.log(JSON.stringify({port:c.port,instance}));'
  if ($LASTEXITCODE -ne 0) { throw '工作台配置无效' }
  $startupConfig = $configRaw | ConvertFrom-Json
  $url = "http://127.0.0.1:$($startupConfig.port)"
  $health = $null
  try { $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 15 } catch {}
  if ($health -and ($health.version -ne '3.5.0' -or $health.instance -ne $startupConfig.instance)) { throw '该端口已有另一工作台，请使用 -Port 3218，不要误打开旧版。' }
  if (-not $health) {
    Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $root 'server.js') + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'server.log') -RedirectStandardError (Join-Path $root 'server-error.log')
    foreach ($attempt in 1..20) {
      try { $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 15; break } catch { Start-Sleep -Milliseconds 300 }
    }
  }
  if (-not $health.ok -or $health.version -ne '3.5.0' -or $health.instance -ne $startupConfig.instance) { throw '启动未通过健康检查；请查看 server-error.log' }
  if (-not $NoOpen) { Start-Process "$url/#workbench" }
  [pscustomobject]@{ URL = "$url/#workbench"; Version = $health.version; Modes = $health.modes -join ',' }
} finally { Pop-Location }
