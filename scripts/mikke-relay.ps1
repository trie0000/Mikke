#Requires -Version 5.1
# ============================================================================
# mikke-relay.ps1 — Mikke ローカル中継サーバ (PowerShell + HttpListener)
#
# 役割:
#   - /mikke/health        起動確認
#   - /mikke/csv-parse     大容量 CSV (約2万件/100MB) のサーバ側解析 (主経路)
#   - /mikke/issue         脆弱性検査ツール API の Issue 単位中継 (雛形 / スタブ)
#   - /mikke/relay/version relay スクリプト群のバージョン
#   - /mikke/relay/self-update  ps1/bat の自己更新
#
# 動作環境:
#   - Windows PowerShell 5.1 以上 / PowerShell 7+ どちらでも動く。
#     委託先 PC は Windows 標準の 5.1 で起動する想定 (Spira relay と同じ)。
#     .bat は `powershell.exe` を呼ぶ (= 5.1)。開発時の mac は pwsh(7) で検証。
#   - 7 専用構文 (?. / ?? / 三項 ?: / ConvertFrom-Json -AsHashtable) は不使用。
#   - HttpListener が 127.0.0.1 で listen するので管理者権限は不要。Python 不要。
#   - ★ CSV/JSON の文字コード: 5.1 既定は CP932。本実装で CSV を読む際は
#     -Encoding を明示し、出力 JSON は UTF-8 で書き出すこと (Spira 踏襲)。
# ============================================================================
param(
    [int]$Port = 18080,
    [string]$EnvFile
)

# ★ relay スクリプト群のバージョン (= self-update で更新検知に使う)。
#   .ps1 / .bat を編集したら手で +1 する。build.js が正規表現で抽出する。
$MIKKE_RELAY_VERSION = '1.0.1'

# self-update で管理対象のファイル一覧 (env は意図的に含めない)。
$MIKKE_RELAY_MANAGED_FILES = @(
    'mikke-relay.ps1',
    'mikke-launch.ps1',
    'mikke-relay.bat',
    'mikke-launch.bat'
)

$ErrorActionPreference = 'Stop'

# ─── .env 読み込み ──────────────────────────────────────────────────────────
function Import-EnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try { $lines = Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop }
    catch { Write-Warning ".env を読めませんでした: $Path"; return $false }
    foreach ($raw in $lines) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $val = $line.Substring($eq + 1).Trim()
        if ($val -match '^"(.*)"$' -or $val -match "^'(.*)'$") { $val = $Matches[1] }
        # 既に OS 環境変数があれば上書きしない (引数 > OS env > .env)
        if (-not [Environment]::GetEnvironmentVariable($key)) {
            [Environment]::SetEnvironmentVariable($key, $val)
        }
    }
    return $true
}
if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot 'mikke-relay.env' }
Import-EnvFile -Path $EnvFile | Out-Null

# 検査ツール API の接続先 (社内確認後に設定)。雛形では未設定でも起動する。
$script:ScannerApiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
$script:ScannerApiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')

# ─── HttpListener ───────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try { $listener.Start() }
catch {
    Write-Host "エラー: ポート $Port を listen できません。別ポートを -Port で指定してください。" -ForegroundColor Red
    Write-Host "詳細: $($_.Exception.Message)"
    exit 1
}

$script:BundleDir = if ($env:MIKKE_BUNDLE_DIR) { $env:MIKKE_BUNDLE_DIR } else { Join-Path $PSScriptRoot '..\dist' }

Write-Host ('-' * 72)
Write-Host "  Mikke relay (PowerShell)  [v$MIKKE_RELAY_VERSION]"
Write-Host ('-' * 72)
Write-Host "  listen  : http://127.0.0.1:$Port"
Write-Host "  scanner : $(if ($script:ScannerApiBase) { $script:ScannerApiBase } else { '(API 未設定 = 雛形/スタブ)' })"
Write-Host "  bundle  : $script:BundleDir"
Write-Host ('-' * 72)
Write-Host 'エンドポイント:'
Write-Host "  GET  http://localhost:$Port/mikke/health"
Write-Host "  POST http://localhost:$Port/mikke/csv-parse"
Write-Host "  POST http://localhost:$Port/mikke/issue"
Write-Host "  GET  http://localhost:$Port/mikke/relay/version"
Write-Host "  POST http://localhost:$Port/mikke/relay/self-update"
Write-Host "  GET  http://localhost:$Port/mikke/mikke.bundle.js (テスト配信)"
Write-Host "  GET  http://localhost:$Port/mikke/version.txt     (テスト配信)"
Write-Host ('-' * 72)
Write-Host 'Ctrl+C で終了' -ForegroundColor DarkGray
Write-Host ''

# ─── helpers ────────────────────────────────────────────────────────────────
function Add-CorsHeaders {
    param([System.Net.HttpListenerResponse]$Response)
    $Response.Headers.Add('Access-Control-Allow-Origin', '*')
    $Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $Response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Requested-With')
    $Response.Headers.Add('Access-Control-Allow-Private-Network', 'true')
    $Response.Headers.Add('Access-Control-Max-Age', '86400')
}

function Send-Json {
    param([System.Net.HttpListenerResponse]$Response, [int]$Status = 200, $Body)
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $Status
    $Response.ContentType = 'application/json; charset=utf-8'
    Add-CorsHeaders -Response $Response
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Send-Error {
    param([System.Net.HttpListenerResponse]$Response, [int]$Status, [string]$Code, [string]$Detail)
    Send-Json -Response $Response -Status $Status -Body @{ ok = $false; error = @{ code = $Code; detail = $Detail } }
}

# ─── CSV パーサ (RFC4180、PowerShell 5.1 互換) ──────────────────────────────
# 役割分担: 中継サーバは「CSV → 行配列(JSON)」のパースのみ担う。差分判定
#   (検知ステータス遷移 / 条件評価 / 個別指定) はブラウザの import.ts で行う
#   (ロジックの二重実装を避けるため)。100MB 級のメモリ負荷をサーバ側に逃がす
#   のが目的。ConvertFrom-Csv を使わず手書きパーサにしているのは、クォート内
#   改行・BOM・区切り推定を import.ts (csv.ts) と完全一致させるため。
function ConvertFrom-CsvText {
    param([string]$Text)
    if (-not $Text) { return @{ headers = @(); rows = @() } }
    # BOM 除去
    if ($Text.Length -gt 0 -and [int]$Text[0] -eq 0xFEFF) { $Text = $Text.Substring(1) }

    $records = New-Object System.Collections.ArrayList
    $record = New-Object System.Collections.ArrayList
    $field = New-Object System.Text.StringBuilder
    $inQuotes = $false
    $i = 0; $n = $Text.Length
    while ($i -lt $n) {
        $c = $Text[$i]
        if ($inQuotes) {
            if ($c -eq '"') {
                if (($i + 1) -lt $n -and $Text[$i + 1] -eq '"') { [void]$field.Append('"'); $i += 2; continue }
                $inQuotes = $false; $i++; continue
            }
            [void]$field.Append($c); $i++; continue
        }
        if ($c -eq '"') { $inQuotes = $true; $i++; continue }
        if ($c -eq ',') { [void]$record.Add($field.ToString()); [void]$field.Clear(); $i++; continue }
        if ($c -eq "`r") {
            if (($i + 1) -lt $n -and $Text[$i + 1] -eq "`n") { $i++ }
            [void]$record.Add($field.ToString()); [void]$field.Clear()
            [void]$records.Add($record.ToArray()); $record.Clear(); $i++; continue
        }
        if ($c -eq "`n") {
            [void]$record.Add($field.ToString()); [void]$field.Clear()
            [void]$records.Add($record.ToArray()); $record.Clear(); $i++; continue
        }
        [void]$field.Append($c); $i++
    }
    if ($field.Length -gt 0 -or $record.Count -gt 0) {
        [void]$record.Add($field.ToString())
        [void]$records.Add($record.ToArray())
    }
    # 空レコード (末尾改行由来) を除去
    $nonEmpty = @($records | Where-Object { -not ($_.Count -eq 1 -and $_[0] -eq '') })
    if ($nonEmpty.Count -eq 0) { return @{ headers = @(); rows = @() } }
    $headers = @($nonEmpty[0] | ForEach-Object { $_.Trim() })
    $rows = New-Object System.Collections.ArrayList
    for ($r = 1; $r -lt $nonEmpty.Count; $r++) {
        $cols = $nonEmpty[$r]
        $obj = [ordered]@{}
        for ($h = 0; $h -lt $headers.Count; $h++) {
            $val = if ($h -lt $cols.Count) { [string]$cols[$h] } else { '' }
            $obj[$headers[$h]] = $val.Trim()
        }
        [void]$rows.Add($obj)
    }
    return @{ headers = $headers; rows = $rows }
}

# multipart/form-data から最初のファイルパートの生バイトを取り出す。
function Get-MultipartFileBytes {
    param([byte[]]$Body, [string]$Boundary)
    $enc = [System.Text.Encoding]::ASCII
    $delim = $enc.GetBytes("--$Boundary")
    # ヘッダ終端 (CRLFCRLF) を探す簡易実装
    $crlf2 = [byte[]](13, 10, 13, 10)
    # 最初の boundary 後のパート開始位置
    $idx = (Find-Bytes -Haystack $Body -Needle $delim -Start 0)
    if ($idx -lt 0) { return $null }
    $headEnd = (Find-Bytes -Haystack $Body -Needle $crlf2 -Start $idx)
    if ($headEnd -lt 0) { return $null }
    $contentStart = $headEnd + 4
    # 次の boundary 直前 (CRLF + --boundary) までが本体
    $nextDelim = [byte[]]((13, 10) + $delim)
    $contentEnd = (Find-Bytes -Haystack $Body -Needle $nextDelim -Start $contentStart)
    if ($contentEnd -lt 0) { $contentEnd = $Body.Length }
    $len = $contentEnd - $contentStart
    if ($len -le 0) { return $null }
    $out = New-Object byte[] $len
    [Array]::Copy($Body, $contentStart, $out, 0, $len)
    return $out
}

function Find-Bytes {
    param([byte[]]$Haystack, [byte[]]$Needle, [int]$Start = 0)
    $hl = $Haystack.Length; $nl = $Needle.Length
    if ($nl -eq 0 -or $hl -lt $nl) { return -1 }
    for ($i = $Start; $i -le ($hl - $nl); $i++) {
        $match = $true
        for ($j = 0; $j -lt $nl; $j++) { if ($Haystack[$i + $j] -ne $Needle[$j]) { $match = $false; break } }
        if ($match) { return $i }
    }
    return -1
}

# バイト列の文字コードを推定してデコード (UTF-8 BOM / UTF-8 / CP932)。
function ConvertTo-DecodedText {
    param([byte[]]$Bytes)
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
    # UTF-8 BOM
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        return [System.Text.Encoding]::UTF8.GetString($Bytes, 3, $Bytes.Length - 3)
    }
    # UTF-8 として厳密デコードを試み、失敗したら CP932 にフォールバック
    try {
        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        return $strict.GetString($Bytes)
    } catch {
        try {
            $cp932 = [System.Text.Encoding]::GetEncoding(932)
            return $cp932.GetString($Bytes)
        } catch {
            return [System.Text.Encoding]::UTF8.GetString($Bytes)
        }
    }
}

# ─── /mikke/csv-parse — 大容量 CSV 解析 (主経路) ────────────────────────────
# 入力: multipart/form-data (file=CSV)。
# 出力: { ok, headers, rows, rowCount }。差分判定はブラウザ側 import.ts が行う。
function Invoke-CsvParse {
    param([System.Net.HttpListenerContext]$Context)
    $request = $Context.Request
    $response = $Context.Response

    $ctype = $request.ContentType
    if (-not $ctype -or $ctype -notmatch 'multipart/form-data') {
        Send-Error $response 400 'bad_content_type' 'multipart/form-data が必要です'
        return
    }
    $m = [regex]::Match($ctype, 'boundary=(?:"([^"]+)"|([^;]+))')
    if (-not $m.Success) { Send-Error $response 400 'no_boundary' 'boundary がありません'; return }
    $boundary = if ($m.Groups[1].Value) { $m.Groups[1].Value } else { $m.Groups[2].Value.Trim() }

    # 生バイトを読む (テキスト化前に file パートを抽出する必要があるため)
    $ms = New-Object System.IO.MemoryStream
    $request.InputStream.CopyTo($ms)
    $body = $ms.ToArray()
    $ms.Dispose()

    $fileBytes = Get-MultipartFileBytes -Body $body -Boundary $boundary
    if ($null -eq $fileBytes) { Send-Error $response 400 'no_file' 'ファイルパートが見つかりません'; return }

    $text = ConvertTo-DecodedText -Bytes $fileBytes
    $parsed = ConvertFrom-CsvText -Text $text

    if ($parsed.headers.Count -eq 0) {
        Send-Error $response 400 'empty_csv' '空の CSV です'
        return
    }

    Send-Json -Response $response -Status 200 -Body @{
        ok = $true
        headers = $parsed.headers
        rows = $parsed.rows
        rowCount = $parsed.rows.Count
        relayVersion = $MIKKE_RELAY_VERSION
    }
}

# ─── /mikke/issue — 検査ツール API 中継 (雛形・スタブ) ──────────────────────
# 入力: { issueInstanceId }。出力: 正規化済み Issue。
# ※ API 仕様は社内限定のため、ここはスタブ。社内確認後に実 API 呼び出しを実装。
function Invoke-IssueFetch {
    param([System.Net.HttpListenerContext]$Context)
    $response = $Context.Response
    if (-not $script:ScannerApiBase) {
        Send-Json -Response $response -Status 501 -Body @{
            ok = $false
            error = @{ code = 'scanner_api_not_configured'; detail = 'MIKKE_SCANNER_API_BASE 未設定 (雛形)。' }
        }
        return
    }
    # TODO: 実 API 呼び出し → CSV と同じスキーマに正規化して返す。
    Send-Json -Response $response -Status 501 -Body @{
        ok = $false; error = @{ code = 'not_implemented'; detail = 'issue 中継は実装フェーズで接続します。' }
    }
}

# ─── /mikke/relay/self-update ───────────────────────────────────────────────
function Invoke-RelaySelfUpdate {
    param([System.Net.HttpListenerContext]$Context)
    $request = $Context.Request
    $response = $Context.Response

    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    $payload = $null
    try { if ($bodyText) { $payload = $bodyText | ConvertFrom-Json } }
    catch { Send-Error $response 400 'bad_json' $_.Exception.Message; return }
    if (-not $payload -or -not $payload.files) { Send-Error $response 400 'no_files' 'files 配列が必要です'; return }

    $allowedNames = $script:MIKKE_RELAY_MANAGED_FILES | ForEach-Object { $_.ToLower() }
    $scriptDir = $PSScriptRoot
    $staged = @()
    foreach ($file in $payload.files) {
        $name = [string]$file.name
        $b64 = [string]$file.contentBase64
        if (-not $name -or -not $b64) { Send-Error $response 400 'invalid_file' "空: $name"; return }
        if ($name.ToLower() -notin $allowedNames) { Send-Error $response 400 'not_allowed' "管理対象外: $name"; return }
        if ($name -match '[\\/:]') { Send-Error $response 400 'invalid_name' "パス区切り: $name"; return }
        try { $bytes = [Convert]::FromBase64String($b64) }
        catch { Send-Error $response 400 'invalid_base64' "デコード失敗: $name"; return }
        if ($bytes.Length -lt 100) { Send-Error $response 400 'too_small' "$name が小さすぎる"; return }
        if ($bytes.Length -gt 5MB) { Send-Error $response 400 'too_large' "$name が大きすぎる"; return }
        if ($bytes[0] -lt 9) { Send-Error $response 400 'binary_detected' "$name がバイナリらしい"; return }
        $newPath = Join-Path $scriptDir ($name + '.new')
        try { [System.IO.File]::WriteAllBytes($newPath, $bytes); $staged += @{ name = $name; size = $bytes.Length } }
        catch { Send-Error $response 500 'write_failed' "$name 書込失敗: $($_.Exception.Message)"; return }
    }
    Write-Host "[self-update] staged $($staged.Count) files" -ForegroundColor Cyan

    $updaterBat = Join-Path $scriptDir 'mikke-updater.bat'
    $managedListBat = ($script:MIKKE_RELAY_MANAGED_FILES -join ' ')
    $batContent = @"
@echo off
REM mikke-updater.bat (自動生成 - mikke-relay.ps1 self-update が出力)
setlocal
set RELAY_PID=%1
set SCRIPT_DIR=%~dp0
set MANAGED=$managedListBat
echo [updater] relay PID %RELAY_PID% の終了を待機中...
set /a TRIES=0
:wait
if "%RELAY_PID%"=="" goto :killport
tasklist /FI "PID eq %RELAY_PID%" 2>nul | find "%RELAY_PID%" >nul
if errorlevel 1 goto :killport
set /a TRIES+=1
if %TRIES% GEQ 8 ( taskkill /F /PID %RELAY_PID% >nul 2>&1 & goto :killport )
timeout /t 1 /nobreak >nul
goto :wait
:killport
powershell -NoProfile -Command "& { try { (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id ``$_ -Force -ErrorAction SilentlyContinue } } catch { } }" >nul 2>&1
echo [updater] ファイル置換中...
for %%F in (%MANAGED%) do (
    if exist "%SCRIPT_DIR%%%F.new" (
        if exist "%SCRIPT_DIR%%%F" copy /Y "%SCRIPT_DIR%%%F" "%SCRIPT_DIR%%%F.bak" >nul
        move /Y "%SCRIPT_DIR%%%F.new" "%SCRIPT_DIR%%%F" >nul
        echo   updated: %%F
    )
)
echo [updater] relay を再起動中...
start "" /D "%SCRIPT_DIR%" "%SCRIPT_DIR%mikke-relay.bat"
timeout /t 1 /nobreak >nul
exit /b 0
"@
    try { [System.IO.File]::WriteAllText($updaterBat, $batContent, [System.Text.UTF8Encoding]::new($false)) }
    catch { Send-Error $response 500 'updater_write_failed' $_.Exception.Message; return }

    try {
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$updaterBat`"", $PID) `
            -WorkingDirectory $scriptDir -WindowStyle Hidden | Out-Null
    } catch { Send-Error $response 500 'updater_spawn_failed' $_.Exception.Message; return }

    Send-Json -Response $response -Status 200 -Body @{
        ok = $true; started = $true; staged = $staged.Count
        relayVersion = $script:MIKKE_RELAY_VERSION; message = '更新を開始しました。relay は再起動します。'
    }
    Write-Host '[self-update] updater を spawn。relay は 1 秒後に exit します...' -ForegroundColor Yellow
    Start-Sleep -Seconds 1
    [Environment]::Exit(0)
}

function Send-LocalFile {
    param([System.Net.HttpListenerResponse]$Response, [string]$Path, [string]$ContentType)
    if (-not (Test-Path -LiteralPath $Path)) { Send-Error $Response 404 'not_found' $Path; return }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $Response.StatusCode = 200
    $Response.ContentType = $ContentType
    Add-CorsHeaders -Response $Response
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

# ─── request loop ───────────────────────────────────────────────────────────
while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    $path = $req.Url.AbsolutePath

    try {
        if ($req.HttpMethod -eq 'OPTIONS') {
            Add-CorsHeaders -Response $res; $res.StatusCode = 204; $res.OutputStream.Close(); continue
        }
        switch -Regex ($path) {
            '^/mikke/health$'              { Send-Json -Response $res -Body @{ ok = $true; version = $MIKKE_RELAY_VERSION }; break }
            '^/mikke/relay/version$'       { Send-Json -Response $res -Body @{ version = $MIKKE_RELAY_VERSION; files = $MIKKE_RELAY_MANAGED_FILES }; break }
            '^/mikke/relay/self-update$'   { Invoke-RelaySelfUpdate -Context $context; break }
            '^/mikke/csv-parse$'           { Invoke-CsvParse -Context $context; break }
            '^/mikke/issue$'               { Invoke-IssueFetch -Context $context; break }
            '^/mikke/mikke\.bundle\.js$'   { Send-LocalFile -Response $res -Path (Join-Path $script:BundleDir 'mikke.bundle.js') -ContentType 'application/javascript; charset=utf-8'; break }
            '^/mikke/version\.txt$'        { Send-LocalFile -Response $res -Path (Join-Path $script:BundleDir 'version.txt') -ContentType 'text/plain; charset=utf-8'; break }
            default                        { Send-Error -Response $res -Status 404 -Code 'not_found' -Detail $path }
        }
    } catch {
        try { Send-Error -Response $res -Status 500 -Code 'internal' -Detail $_.Exception.Message } catch { }
        Write-Host "[error] $($_.Exception.Message)" -ForegroundColor Red
    }
}
