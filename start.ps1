# 一键启动园区数字孪生（前后端同端口）
# 用法: .\start.ps1        (默认 8000)
#       .\start.ps1 -Port 8080
#
# 前台运行, 日志直接打在终端, Ctrl+C 停止。
# 想常驻可以考虑 README 里的 Windows 服务 / systemd 方案。

param([int]$Port = 8000)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    Write-Host "缺少虚拟环境，请先执行:" -ForegroundColor Yellow
    Write-Host "  python -m venv .venv"
    Write-Host "  .\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt"
    exit 1
}

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "端口 $Port 已被占用 (pid $($busy.OwningProcess))" -ForegroundColor Yellow
    Write-Host "先停止: Stop-Process -Id $($busy.OwningProcess) -Force"
    exit 1
}

# 演示数据 / 外壳瓦片缺失时自动补齐
if (-not (Test-Path (Join-Path $root 'data\park.json'))) {
    Write-Host "生成演示数据 ..." -ForegroundColor DarkGray
    & $python (Join-Path $root 'tools\gen_demo_data.py')
}
if (-not (Test-Path (Join-Path $root 'data\tileset\tileset.json'))) {
    Write-Host "生成演示外壳瓦片 ..." -ForegroundColor DarkGray
    & $python (Join-Path $root 'tools\gen_demo_tileset.py')
}
if (-not (Test-Path (Join-Path $root 'frontend\dist\index.html'))) {
    Write-Host "前端尚未构建，请执行: cd frontend; npm install; npm run build" -ForegroundColor Yellow
    exit 1
}

Write-Host "园区数字孪生 -> http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "接口文档     -> http://127.0.0.1:$Port/docs" -ForegroundColor DarkGray
& $python -m uvicorn app.main:app --app-dir (Join-Path $root 'backend') --host 127.0.0.1 --port $Port
