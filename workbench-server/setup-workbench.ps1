param([switch]$SkipDependencies)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$nativeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$python = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } elseif ($pythonCommand) { $pythonCommand.Source } else { Join-Path $nativeRoot 'python\python.exe' }
if (-not $SkipDependencies) {
  if (-not (Test-Path -LiteralPath $python)) { throw '未找到 Python 3.10+；请安装或设置 PYTHON_BIN' }
  $venv = Join-Path $root '.venv'
  if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) {
    & $python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw '创建独立 Python 环境失败' }
  }
  & (Join-Path $venv 'Scripts\python.exe') -m pip install -r (Join-Path $root 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，未声明安装完成' }
}
$credentials = Join-Path $root 'credentials.env'
if (-not (Test-Path -LiteralPath $credentials)) {
  Copy-Item -LiteralPath (Join-Path $root 'credentials.example.env') -Destination $credentials
}
Write-Output '工作台安装准备完成。请配置自己的 credentials.env、FFmpeg 和 Codex 登录，然后运行 start-workbench.ps1。'
