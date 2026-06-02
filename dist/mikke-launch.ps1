# mikke-launch.ps1 — relay 起動 → /health 待機 → SP サイトを既定ブラウザで開く
param([int]$Port = 18080)

$scriptDir = $PSScriptRoot
$envFile = Join-Path $scriptDir 'mikke-relay.env'

# SP サイト URL を env から取得 (なければプロンプト → env に保存)
$siteUrl = $null
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
        if ($line -match '^\s*MIKKE_SITE_URL\s*=\s*(.+)$') { $siteUrl = $Matches[1].Trim().Trim('"').Trim("'") }
    }
}
if (-not $siteUrl) {
    $siteUrl = Read-Host 'Mikke を開く SharePoint サイト URL を入力してください'
    if ($siteUrl) { Add-Content -LiteralPath $envFile -Value "MIKKE_SITE_URL=$siteUrl" -Encoding UTF8 }
}

# relay をバックグラウンド起動
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$(Join-Path $scriptDir 'mikke-relay.bat')`"") `
    -WorkingDirectory $scriptDir -WindowStyle Minimized | Out-Null

# /health 待機
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/mikke/health" -TimeoutSec 1
        if ($r.ok) { $ok = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
}
if ($ok) { Write-Host 'relay 起動 OK' -ForegroundColor Green } else { Write-Host 'relay 起動を確認できませんでした' -ForegroundColor Yellow }

if ($siteUrl) { Start-Process $siteUrl }
Write-Host 'ブックマークの Mikke をクリックして起動してください。'
