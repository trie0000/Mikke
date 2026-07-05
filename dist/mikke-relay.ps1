#Requires -Version 5.1
# ============================================================================
# mikke-relay.ps1 — Mikke ローカル中継サーバ (PowerShell + HttpListener)
#
# 役割:
#   - /mikke/health        起動確認
#   - /mikke/csv-parse     大容量 CSV (約2万件/100MB) のサーバ側解析 (主経路)
#   - /mikke/issue         脆弱性検査ツール API の Issue 単位中継 (雛形 / スタブ)
#   - /mikke/download      脆弱性/資産データの一括ダウンロード中継 (種別ごと並列・アダプタ委譲)
#   - /mikke/relay/version relay スクリプト群のバージョン
#   - /mikke/relay/self-update  ps1/bat の自己更新
#
# 動作環境:
#   - Windows PowerShell 5.1 以上 / PowerShell 7+ どちらでも動く。
#     委託先 PC は Windows 標準の 5.1 で起動する想定 (既存の内製ツールの relay と同じ)。
#     .bat は `powershell.exe` を呼ぶ (= 5.1)。開発時の mac は pwsh(7) で検証。
#   - 7 専用構文 (?. / ?? / 三項 ?: / ConvertFrom-Json -AsHashtable) は不使用。
#   - HttpListener が 127.0.0.1 で listen するので管理者権限は不要。Python 不要。
#   - ★ CSV/JSON の文字コード: 5.1 既定は CP932。本実装で CSV を読む際は
#     -Encoding を明示し、出力 JSON は UTF-8 で書き出すこと (既存の内製ツール踏襲)。
# ============================================================================
param(
    # 0 = 未指定。優先順位 = -Port 引数 > .env(MIKKE_RELAY_PORT) > 既定 18080。
    [int]$Port = 0,
    [string]$EnvFile
)

# ★ relay スクリプト群のバージョン (= self-update で更新検知に使う)。
#   .ps1 / .bat を編集したら手で +1 する。build.js が正規表現で抽出する。
$MIKKE_RELAY_VERSION = '1.0.9'

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

# ポート決定: -Port 引数 (>0) > .env/OS env(MIKKE_RELAY_PORT) > 既定 18080。
if ($Port -le 0) {
    $Port = 18080
    $envPort = [Environment]::GetEnvironmentVariable('MIKKE_RELAY_PORT')
    if ($envPort) { $p = 0; if ([int]::TryParse($envPort, [ref]$p) -and $p -gt 0) { $Port = $p } }
}

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
Write-Host "  POST http://localhost:$Port/mikke/download"
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

    Write-Host ("[csv-parse] {0} rows / {1} cols 解析完了" -f $parsed.rows.Count, $parsed.headers.Count) -ForegroundColor Green

    Send-Json -Response $response -Status 200 -Body @{
        ok = $true
        headers = $parsed.headers
        rows = $parsed.rows
        rowCount = $parsed.rows.Count
        relayVersion = $MIKKE_RELAY_VERSION
    }
}

# ─── /mikke/bundle-dir — 配信ディレクトリの照会(GET)/変更(POST) ──────────────
# UI(設定→開発者) から、relay が mikke.bundle.js / version.txt を読むフォルダを
# 指定できるようにする。開発中にビルド先(dist 等)を差し替えて即反映する用途。
function Invoke-BundleDir {
    param([System.Net.HttpListenerContext]$Context)
    $request = $Context.Request
    $response = $Context.Response

    if ($request.HttpMethod -eq 'POST') {
        $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
        $bodyText = $reader.ReadToEnd(); $reader.Close()
        $payload = $null
        try { if ($bodyText) { $payload = $bodyText | ConvertFrom-Json } }
        catch { Send-Error $response 400 'bad_json' $_.Exception.Message; return }
        $dir = if ($payload) { [string]$payload.dir } else { '' }
        $dir = $dir.Trim()
        if (-not $dir) { Send-Error $response 400 'no_dir' 'dir を指定してください'; return }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
            Send-Error $response 400 'not_found' "ディレクトリが存在しません: $dir"
            return
        }
        $script:BundleDir = (Resolve-Path -LiteralPath $dir).Path
        Write-Host "[bundle-dir] -> $script:BundleDir" -ForegroundColor Green
    }

    $bundlePath = Join-Path $script:BundleDir 'mikke.bundle.js'
    Send-Json -Response $response -Status 200 -Body @{
        ok = $true
        dir = $script:BundleDir
        bundleExists = (Test-Path -LiteralPath $bundlePath -PathType Leaf)
    }
}

# ─── /mikke/issue — 検査ツール API 中継 (アダプタ委譲) ──────────────────────
# 入力: { issueInstanceId }。出力: 正規化済み Issue。
#
# ★ API 仕様は委託先環境でのみ確認できるため、実装は別ファイル
#   mikke-scanner-adapter.ps1 に委譲する (このファイルと同じフォルダに置く)。
#   - アダプタは self-update の管理外 (MIKKE_RELAY_MANAGED_FILES に含めない) &
#     git 管理外。委託先環境で自由に作成・更新してよい。relay 本体は触らない。
#   - 契約: Invoke-MikkeScannerFetch -IssueInstanceId <string> を定義し、
#     @{ scannerStatus=<string>; severity=<string>; lastSeen=<ISO8601>;
#        scanFields=@{ '<列名>'='<値>' } } を返す (scanFields は任意)。
#   - 雛形: mikke-scanner-adapter.example.ps1 をコピーして実装する。
function Invoke-IssueFetch {
    param([System.Net.HttpListenerContext]$Context)
    $request = $Context.Request
    $response = $Context.Response

    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    $iid = $null
    try { if ($bodyText) { $iid = ([string](($bodyText | ConvertFrom-Json).issueInstanceId)).Trim() } } catch { }
    if (-not $iid) { Send-Error $response 400 'no_issue_id' 'issueInstanceId を指定してください'; return }

    $adapterPath = Join-Path $PSScriptRoot 'mikke-scanner-adapter.ps1'
    if (-not (Test-Path -LiteralPath $adapterPath)) {
        Send-Json -Response $response -Status 501 -Body @{
            ok = $false
            error = @{ code = 'adapter_not_installed'
                       detail = 'mikke-scanner-adapter.ps1 が未配置です。mikke-scanner-adapter.example.ps1 をコピーして委託先環境で実装し、relay と同じフォルダに置いてください。' }
        }
        return
    }
    try {
        # 毎リクエスト dot-source する (開発中の差し替えを relay 再起動なしで反映)。
        # F3 は単発 API 用途なので読み込みコストは軽微。
        . $adapterPath
        if (-not (Get-Command Invoke-MikkeScannerFetch -ErrorAction SilentlyContinue)) {
            Send-Error $response 500 'adapter_invalid' 'アダプタに Invoke-MikkeScannerFetch 関数が定義されていません'
            return
        }
        $result = Invoke-MikkeScannerFetch -IssueInstanceId $iid
        Write-Host "[issue] $iid -> OK" -ForegroundColor Green
        $scanFields = @{}
        if ($result.scanFields) { $scanFields = $result.scanFields }
        $body = @{
            ok = $true
            scannerStatus = [string]$result.scannerStatus
            severity = [string]$result.severity
            lastSeen = [string]$result.lastSeen
            scanFields = $scanFields
        }
        # detected (現在も検出されているか): アダプタが返した場合のみ含める。
        # UI 側はこれが true/false の時だけ検知ステータスを遷移させる (省略=変更なし)。
        if ($null -ne $result.detected) { $body.detected = [bool]$result.detected }
        Send-Json -Response $response -Status 200 -Body $body
    } catch {
        # 原因特定のため、例外の詳細 (型 / 発生箇所 / HTTP 情報 / 応答ボディ) を出す。
        # ※ アダプタが元の WebException を握りつぶして文字列 throw した場合、HTTP
        #   詳細はここでは取れない (アダプタ側の診断ログ規約 = SPEC §5-1 を参照)。
        Write-Host "[issue] $iid -> ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "  type : $($_.Exception.GetType().FullName)" -ForegroundColor DarkGray
        if ($_.InvocationInfo -and $_.InvocationInfo.ScriptName) {
            Write-Host ("  at   : {0}:{1}" -f (Split-Path -Leaf $_.InvocationInfo.ScriptName), $_.InvocationInfo.ScriptLineNumber) -ForegroundColor DarkGray
        }
        if ($_.ScriptStackTrace) {
            Write-Host "  stack: $($_.ScriptStackTrace -replace "`r?`n", ' <- ')" -ForegroundColor DarkGray
        }
        if ($_.Exception.Response) {
            try { Write-Host ("  http : {0}" -f [int]$_.Exception.Response.StatusCode) -ForegroundColor DarkGray } catch { }
        }
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $snip = $_.ErrorDetails.Message
            if ($snip.Length -gt 500) { $snip = $snip.Substring(0, 500) + '…' }
            Write-Host "  body : $snip" -ForegroundColor DarkGray
        }
        Send-Error $response 502 'adapter_error' $_.Exception.Message
    }
}

# ─── /mikke/download — 脆弱性/資産データの一括ダウンロード中継 (アダプタ委譲) ──
# 入力: { types: ["vuln","ip","iprange","domain","cert","webapps"] }
# 出力: { ok:true, items:[ { type, fileName, contentBase64, scannerDownloadTime, itemCount } ] }
#
# ★ /mikke/issue と同じくアダプタ (mikke-scanner-adapter.ps1) に委譲する。
#   契約: Invoke-MikkeScannerDownload -Types <string[]> を定義し、上記 items を返す。
#   contentBase64 はファイル内容の Base64 (CSV/xlsx 等バイナリ安全)。zip 化・SP 保存は
#   ブラウザ側 (SP 認証あり) が行う。relay は取得の中継のみ。
#
# ★ 並列ダウンロード: 要求された種別を runspace プールで**種別ごとに並列取得**する。
#   1 種別 = 1 runspace で adapter を dot-source し Invoke-MikkeScannerDownload -Types @(<種別>)
#   を呼ぶ (各 runspace は隔離。共有状態なし)。全体の所要 ≒ 最も遅い 1 種別 (直列の総和ではない)。
#   1 種別の失敗は他を巻き込まない (部分成功を許容)。全滅時のみ 502。
$MIKKE_DOWNLOAD_MAX_PARALLEL = 6

function Invoke-Download {
    param([System.Net.HttpListenerContext]$Context)
    $request = $Context.Request
    $response = $Context.Response

    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
    $bodyText = $reader.ReadToEnd(); $reader.Close()
    $types = @()
    try {
        if ($bodyText) {
            $parsed = ($bodyText | ConvertFrom-Json).types
            if ($parsed) { $types = @($parsed | ForEach-Object { [string]$_ }) }
        }
    } catch { }
    if (-not $types -or $types.Count -eq 0) { Send-Error $response 400 'no_types' 'types を 1 つ以上指定してください'; return }

    $adapterPath = Join-Path $PSScriptRoot 'mikke-scanner-adapter.ps1'
    if (-not (Test-Path -LiteralPath $adapterPath)) {
        Send-Json -Response $response -Status 501 -Body @{
            ok = $false
            error = @{ code = 'adapter_not_installed'
                       detail = 'mikke-scanner-adapter.ps1 が未配置です。mikke-scanner-adapter.example.ps1 をコピーして委託先環境で実装し、relay と同じフォルダに置いてください。' }
        }
        return
    }

    # 1 種別を取得する worker (隔離 runspace 内で実行される)。adapter を dot-source し
    # 1 種別ぶんの items を返す。診断ログ (Write-Host) は Information ストリームに溜まる。
    $worker = {
        param($AdapterPath, $Type)
        . $AdapterPath
        if (-not (Get-Command Invoke-MikkeScannerDownload -ErrorAction SilentlyContinue)) {
            throw 'アダプタに Invoke-MikkeScannerDownload 関数が定義されていません'
        }
        $r = Invoke-MikkeScannerDownload -Types @($Type)
        if ($r -and $r.items) { return @($r.items) }
        return @()
    }

    $cap = [Math]::Min($types.Count, $MIKKE_DOWNLOAD_MAX_PARALLEL)
    $pool = [RunspaceFactory]::CreateRunspacePool(1, $cap)
    $pool.Open()
    $jobs = @()
    foreach ($t in $types) {
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($worker).AddArgument($adapterPath).AddArgument($t)
        $jobs += [pscustomobject]@{ Type = $t; PS = $ps; Handle = $ps.BeginInvoke() }
    }

    $items = @()
    $errors = @()
    foreach ($j in $jobs) {
        try {
            $out = $j.PS.EndInvoke($j.Handle)
            # adapter の診断ログ (Write-Host → Information) を relay コンソールへ再出力。
            foreach ($info in $j.PS.Streams.Information) {
                Write-Host ("[download:{0}] {1}" -f $j.Type, $info.ToString()) -ForegroundColor DarkGray
            }
            if ($out) {
                foreach ($it in $out) {
                    $items += @{
                        type                = [string]$it.type
                        fileName            = [string]$it.fileName
                        contentBase64       = [string]$it.contentBase64
                        scannerDownloadTime = [string]$it.scannerDownloadTime
                        itemCount           = [int]$it.itemCount
                    }
                }
            }
        } catch {
            # EndInvoke は worker が throw すると再スローする。1 種別の失敗は記録して継続。
            $errors += ("{0}: {1}" -f $j.Type, $_.Exception.Message)
            Write-Host ("[download:{0}] ERROR: {1}" -f $j.Type, $_.Exception.Message) -ForegroundColor Red
        } finally {
            $j.PS.Dispose()
        }
    }
    $pool.Close(); $pool.Dispose()

    $errNote = ''
    if ($errors.Count -gt 0) { $errNote = " / errors: $($errors.Count)" }
    Write-Host ("[download] {0} -> {1} file(s){2}" -f ($types -join ','), $items.Count, $errNote) -ForegroundColor Green

    # 全種別が失敗した時のみエラー応答。一部でも取得できればそれを返す (部分成功)。
    if ($items.Count -eq 0 -and $errors.Count -gt 0) {
        Send-Error $response 502 'adapter_error' ($errors -join ' | ')
        return
    }
    Send-Json -Response $response -Status 200 -Body @{ ok = $true; items = $items }
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

    # リクエストログ (健全性確認・診断用)。これが無いと「取り込んでも relay の
    # コンソールに何も出ない」= 届いてるのか判別できず原因切り分けができない。
    Write-Host ("[{0}] {1} {2}  (origin: {3})" -f (Get-Date -Format 'HH:mm:ss'), $req.HttpMethod, $path, $req.Headers['Origin']) -ForegroundColor DarkGray

    try {
        if ($req.HttpMethod -eq 'OPTIONS') {
            Add-CorsHeaders -Response $res; $res.StatusCode = 204; $res.OutputStream.Close(); continue
        }
        switch -Regex ($path) {
            '^/mikke/health$'              { Send-Json -Response $res -Body @{ ok = $true; version = $MIKKE_RELAY_VERSION }; break }
            '^/mikke/relay/version$'       { Send-Json -Response $res -Body @{ version = $MIKKE_RELAY_VERSION; files = $MIKKE_RELAY_MANAGED_FILES }; break }
            '^/mikke/relay/self-update$'   { Invoke-RelaySelfUpdate -Context $context; break }
            '^/mikke/csv-parse$'           { Invoke-CsvParse -Context $context; break }
            '^/mikke/bundle-dir$'          { Invoke-BundleDir -Context $context; break }
            '^/mikke/issue$'               { Invoke-IssueFetch -Context $context; break }
            '^/mikke/download$'            { Invoke-Download -Context $context; break }
            '^/mikke/mikke\.bundle\.js$'   { Send-LocalFile -Response $res -Path (Join-Path $script:BundleDir 'mikke.bundle.js') -ContentType 'application/javascript; charset=utf-8'; break }
            '^/mikke/version\.txt$'        { Send-LocalFile -Response $res -Path (Join-Path $script:BundleDir 'version.txt') -ContentType 'text/plain; charset=utf-8'; break }
            default                        { Send-Error -Response $res -Status 404 -Code 'not_found' -Detail $path }
        }
    } catch {
        try { Send-Error -Response $res -Status 500 -Code 'internal' -Detail $_.Exception.Message } catch { }
        Write-Host "[error] $($_.Exception.Message)" -ForegroundColor Red
    }
}
