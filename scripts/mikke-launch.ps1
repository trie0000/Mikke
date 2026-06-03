# mikke-launch.ps1 — relay 起動 → /health 待機 → SP サイトを既定ブラウザで開く
#
# 変更点 (Windows でのトラブル対策 / Spira の実績パターンに準拠):
#   - relay は「別ウィンドウ + -NoExit」で起動する。これにより
#       * このランチャを閉じても relay は生き続ける
#       * relay が起動に失敗しても、そのウィンドウが残るのでエラーが読める
#     (従来は -WindowStyle Minimized で隠れて起動失敗が確認できなかった)
#   - 起動前に /health を確認し、既に起動済みなら二重起動しない (ポート競合回避)
#   - .bat 側の pause で、このウィンドウも自動では閉じない
param([int]$Port = 18080)

$scriptDir = $PSScriptRoot
$envFile = Join-Path $scriptDir 'mikke-relay.env'

# ─── SP サイト URL を env から取得 (なければプロンプト → env に保存) ──────────
$siteUrl = $null
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
        if ($line -match '^\s*MIKKE_SITE_URL\s*=\s*(.+)$') {
            $siteUrl = $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
}
if (-not $siteUrl) {
    $siteUrl = Read-Host 'Mikke を開く SharePoint サイト URL を入力してください (空 Enter でスキップ)'
    if ($siteUrl) { Add-Content -LiteralPath $envFile -Value "MIKKE_SITE_URL=$siteUrl" -Encoding UTF8 }
}

$healthUrl = "http://127.0.0.1:$Port/mikke/health"

function Test-RelayUp {
    param([string]$Url)
    try {
        $r = Invoke-WebRequest -Uri $Url -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# ─── relay 起動 (既に上がっていれば再利用) ──────────────────────────────────
if (Test-RelayUp -Url $healthUrl) {
    Write-Host "relay は既に起動済みです (port $Port)" -ForegroundColor Green
} else {
    $relayPs1 = Join-Path $scriptDir 'mikke-relay.ps1'
    if (-not (Test-Path -LiteralPath $relayPs1)) {
        Write-Host "エラー: $relayPs1 が見つかりません" -ForegroundColor Red
    } else {
        Write-Host "relay を新しいウィンドウで起動します (port $Port)..." -ForegroundColor Cyan
        try {
            # -NoExit: relay が落ちてもウィンドウを残してログを読めるようにする
            Start-Process -FilePath 'powershell.exe' -ArgumentList @(
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
                '-File', "`"$relayPs1`"", '-Port', "$Port"
            ) -WorkingDirectory $scriptDir | Out-Null
        } catch {
            Write-Host "relay の起動に失敗しました: $($_.Exception.Message)" -ForegroundColor Red
        }

        # /health を最大 10 秒待機
        $ok = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-RelayUp -Url $healthUrl) { $ok = $true; break }
        }
        if ($ok) {
            Write-Host 'relay 起動 OK' -ForegroundColor Green
        } else {
            Write-Host 'relay の起動を確認できませんでした。別ウィンドウのエラーを確認してください。' -ForegroundColor Yellow
            Write-Host '(よくある原因: ポート競合 → mikke-launch.bat -Port 18081 のように別ポートを指定)' -ForegroundColor DarkGray
        }
    }
}

# ─── SharePoint を既定ブラウザで開く ────────────────────────────────────────
if ($siteUrl) {
    Write-Host "SharePoint を開きます: $siteUrl" -ForegroundColor Cyan
    try {
        Start-Process $siteUrl | Out-Null
    } catch {
        Write-Host "ブラウザの起動に失敗しました。手動で開いてください: $siteUrl" -ForegroundColor Yellow
    }
}
Write-Host ''
Write-Host 'ブックマークバーの「Mikke」をクリックしてアプリを起動してください。' -ForegroundColor Green
