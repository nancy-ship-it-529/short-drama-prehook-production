param([int]$Port = 3217)
$ErrorActionPreference = 'Stop'
$targetScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'server.js'))
foreach ($listener in (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  $service = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($service -and $service.CommandLine -match [regex]::Escape($targetScript)) { Stop-Process -Id $listener.OwningProcess }
  else { Write-Warning '该端口进程的启动路径不能确认属于本工作台，未停止。' }
}
