# mikke-launch.ps1 — relay 起動 → /health 待機 → Mikke を自動起動 (CDP ワンクリック)
#
# 起動の流れ:
#   1) relay が起動していなければ別ウィンドウ (-NoExit) で起動し、/health を待つ
#   2) ★ CDP ワンクリック: 専用プロファイルの Edge を --remote-debugging-port 付きで
#      起動し、SharePoint の認証を検知したら CDP 経由でローダを注入する
#      (= ブックマークレットのクリックが不要になる)
#   3) CDP が使えない / 失敗した場合は従来フローにフォールバック:
#      既定ブラウザで SharePoint を開き「ブックマークレットを押してください」と案内する
#
# 設計方針: CDP は「純粋な追加」。既存のブックマークレット / relay / バンドルは無改変で、
#   CDP 経路が落ちても従来どおり使える (動いている経路に必須依存を足さない)。
#
# 変更点 (Windows でのトラブル対策):
#   - relay は「別ウィンドウ + -NoExit」で起動する。これにより
#       * このランチャを閉じても relay は生き続ける
#       * relay が起動に失敗しても、そのウィンドウが残るのでエラーが読める
#   - 起動前に /health を確認し、既に起動済みなら二重起動しない (ポート競合回避)
#   - .bat 側の pause で、このウィンドウも自動では閉じない
#
# CDP 関連の設定 (mikke-relay.env / いずれも任意):
#   MIKKE_CDP           : '0' で CDP を無効化し従来フロー固定 (既定は有効)
#   MIKKE_CDP_PORT      : CDP のデバッグポート (既定 9333)
#   MIKKE_EDGE_PATH     : msedge.exe のパス (未設定なら既定の場所を自動探索)
#   MIKKE_EDGE_USERDATA : 専用プロファイルの置き場所 (既定 %LOCALAPPDATA%\mikke-edge)
#
# 設定 (従来どおり):
#   MIKKE_SITE_URL  : SharePoint サイトの URL (未設定なら起動時に入力)
#   MIKKE_RELAY_PORT: relay の listen ポート (既定 18080)
param([int]$Port = 0)  # 0 = 未指定。-Port 引数 > .env(MIKKE_RELAY_PORT) > 既定 18080

$scriptDir = $PSScriptRoot
$envFile = Join-Path $scriptDir 'mikke-relay.env'

# ─── env 読込 (SP サイト URL / ポート / CDP 設定) ────────────────────────────
$siteUrl = $null
$envPort = 0
$cdpEnabled = $true
$cdpPort = 9333
$edgePath = ''
$edgeUserData = ''
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in (Get-Content -LiteralPath $envFile -Encoding UTF8)) {
        if ($line -match '^\s*MIKKE_SITE_URL\s*=\s*(.+)$') {
            $siteUrl = $Matches[1].Trim().Trim('"').Trim("'")
        } elseif ($line -match '^\s*MIKKE_RELAY_PORT\s*=\s*(\d+)') {
            $envPort = [int]$Matches[1]
        } elseif ($line -match '^\s*MIKKE_CDP\s*=\s*(.+)$') {
            $v = $Matches[1].Trim().Trim('"').Trim("'")
            if ($v -eq '0' -or $v -eq 'false') { $cdpEnabled = $false }
        } elseif ($line -match '^\s*MIKKE_CDP_PORT\s*=\s*(\d+)') {
            $cdpPort = [int]$Matches[1]
        } elseif ($line -match '^\s*MIKKE_EDGE_PATH\s*=\s*(.+)$') {
            $edgePath = $Matches[1].Trim().Trim('"').Trim("'")
        } elseif ($line -match '^\s*MIKKE_EDGE_USERDATA\s*=\s*(.+)$') {
            $edgeUserData = $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
}
# ポート優先順位: -Port 引数 (>0) > .env(MIKKE_RELAY_PORT) > 既定 18080
if ($Port -le 0) { if ($envPort -gt 0) { $Port = $envPort } else { $Port = 18080 } }

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

# ─── 従来フロー (CDP が使えない時のフォールバック) ───────────────────────────
function Invoke-LegacyFlow {
    param([string]$Url)
    if ($Url) {
        Write-Host "SharePoint を開きます: $Url" -ForegroundColor Cyan
        try {
            Start-Process $Url | Out-Null
        } catch {
            Write-Host "ブラウザの起動に失敗しました。手動で開いてください: $Url" -ForegroundColor Yellow
        }
    }
    Write-Host ''
    Write-Host 'ブックマークバーの「Mikke」をクリックしてアプリを起動してください。' -ForegroundColor Green
}

# ─── CDP ワンクリック起動 ────────────────────────────────────────────────────
# ★ 実機で確認済みの要点 (コードを読むだけでは分からないので消さないこと):
#   - Chromium 111+ は Origin ヘッダが許可リストに無い CDP 接続を 403 で拒否する。
#     → Edge に --remote-allow-origins=* を渡す (ClientWebSocket は既定で Origin を送らない)。
#   - 既存の Edge が起動中だと --remote-debugging-port は無視される (新プロセスが吸収される)。
#     → 専用 --user-data-dir が必須。これで通常の Edge にも干渉しない。
#   - http://127.0.0.1:<port>/json を .NET の HttpClient/WebClient で叩くと社内プロキシに
#     流れて失敗する。Invoke-RestMethod はループバックを自動迂回するのでこちらを使う。
#   - モダン SP の CSP には 'unsafe-inline' が無いのでインライン <script> の append は不可。
#     'unsafe-eval' はあるので CDP の Runtime.evaluate 経由の実行は通る。
#     ローダは同一オリジンの SP からバンドルを読むので本番経路と一致する。

function Find-EdgeExe {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return ''
}

function Get-CdpTargetWs {
    param([int]$CdpPort, [int]$TimeoutSec = 30)
    for ($i = 0; $i -lt ($TimeoutSec * 2); $i++) {
        try {
            # ループバックはプロキシを迂回させたいので Invoke-RestMethod を使う
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json" -TimeoutSec 2
            $page = $targets |
                Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } |
                Sort-Object { if ($_.url -match 'sharepoint|login|/_forms/') { 0 } else { 1 } } |
                Select-Object -First 1
            if ($page) { return $page.webSocketDebuggerUrl }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return ''
}

$cdpDone = $false
if (-not $cdpEnabled) {
    Write-Host 'CDP は無効化されています (MIKKE_CDP=0)。従来フローで起動します。' -ForegroundColor DarkGray
} elseif (-not $siteUrl) {
    Write-Host 'サイト URL 未設定のため CDP 起動をスキップします。' -ForegroundColor DarkGray
} else {
    $edge = Find-EdgeExe -Explicit $edgePath
    if (-not $edge) {
        Write-Host 'Edge が見つかりませんでした。従来フローに切り替えます。' -ForegroundColor Yellow
    } else {
        if (-not $edgeUserData) { $edgeUserData = Join-Path $env:LOCALAPPDATA 'mikke-edge' }
        try {
            # 既に CDP 付きで起動済みなら再起動しない (SingletonLock のレース回避)
            $alreadyUp = $false
            try {
                Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/version" -TimeoutSec 1 | Out-Null
                $alreadyUp = $true
            } catch { }

            if ($alreadyUp) {
                Write-Host "CDP ブラウザは起動済みです (port $cdpPort)" -ForegroundColor Green
            } else {
                Write-Host 'Mikke 専用ブラウザを起動します...' -ForegroundColor Cyan
                Start-Process -FilePath $edge -ArgumentList @(
                    "--remote-debugging-port=$cdpPort",
                    '--remote-allow-origins=*',
                    "--user-data-dir=`"$edgeUserData`"",
                    '--no-first-run',
                    '--no-default-browser-check',
                    $siteUrl
                ) | Out-Null
            }

            $wsUrl = Get-CdpTargetWs -CdpPort $cdpPort -TimeoutSec 30
            if (-not $wsUrl) { throw 'CDP のページターゲットを取得できませんでした' }

            # ClientWebSocket を C# でコンパイルして CDP に接続する。
            # ※ 同梱 csc で通るよう C#5 の範囲で書く (文字列補間 / ?. / 式本体メンバは使わない)
            if (-not ('MikkeCdp' -as [type])) {
                Add-Type -ReferencedAssemblies 'System' -TypeDefinition @'
using System; using System.Net.WebSockets; using System.Text; using System.Threading;
public class MikkeCdp {
  ClientWebSocket ws; int id = 0;
  public void Connect(string url){ ws = new ClientWebSocket();
    ws.ConnectAsync(new Uri(url), CancellationToken.None).GetAwaiter().GetResult(); }
  string Recv(){ StringBuilder sb = new StringBuilder(); byte[] b = new byte[65536];
    CancellationTokenSource cts = new CancellationTokenSource(60000);
    while(true){ WebSocketReceiveResult r = ws.ReceiveAsync(new ArraySegment<byte>(b), cts.Token).GetAwaiter().GetResult();
      sb.Append(Encoding.UTF8.GetString(b,0,r.Count)); if(r.EndOfMessage) break; } return sb.ToString(); }
  public string Send(string method, string prms){ int my = ++id;
    string msg = "{\"id\":"+my+",\"method\":\""+method+"\",\"params\":"+(prms==null?"{}":prms)+"}";
    byte[] bb = Encoding.UTF8.GetBytes(msg);
    ws.SendAsync(new ArraySegment<byte>(bb), WebSocketMessageType.Text, true, CancellationToken.None).GetAwaiter().GetResult();
    string w1="\"id\":"+my+",\"result\""; string w2="\"id\":"+my+",\"error\"";
    for(int k=0;k<2000;k++){ string r=Recv(); if(r.IndexOf(w1)>=0||r.IndexOf(w2)>=0) return r; } return ""; }
  public string Eval(string expr, bool awaitPromise){
    string p="{\"expression\":"+JsonStr(expr)+",\"returnByValue\":true,\"awaitPromise\":"+(awaitPromise?"true":"false")+"}";
    return Send("Runtime.evaluate", p); }
  public static string JsonStr(string s){ StringBuilder sb=new StringBuilder(); sb.Append('"');
    for(int i=0;i<s.Length;i++){ char c=s[i];
      if(c=='"')sb.Append("\\\""); else if(c=='\\')sb.Append("\\\\"); else if(c=='\n')sb.Append("\\n");
      else if(c=='\r')sb.Append("\\r"); else if(c=='\t')sb.Append("\\t");
      else if(c<0x20)sb.Append("\\u"+((int)c).ToString("x4")); else sb.Append(c); }
    sb.Append('"'); return sb.ToString(); }
}
'@
            }

            $cdp = New-Object MikkeCdp
            $cdp.Connect($wsUrl)

            # 認証待ち: ログイン中はクロスオリジンで fetch が失敗するので握って retry する
            $probe = '(async()=>{try{const r=await fetch(' + "'" + $siteUrl + "/_api/web?" + '$select=Title' + "'" +
                     ",{headers:{Accept:'application/json;odata=nometadata'},credentials:'include'});return r.ok;}catch(e){return false;}})()"
            Write-Host 'SharePoint へのサインインを待っています (初回のみ手動サインインが必要です)...' -ForegroundColor Cyan
            $authed = $false
            for ($i = 0; $i -lt 180; $i++) {
                try {
                    $j = $cdp.Eval($probe, $true) | ConvertFrom-Json
                    if ($j.result.result.value -eq $true) { $authed = $true; break }
                } catch { }
                Start-Sleep -Milliseconds 1000
            }
            if (-not $authed) { throw 'サインインを検知できませんでした (タイムアウト)' }

            # ローダのベース解決を確定させる (モダンページで _spPageContextInfo が無い対策)。
            # ローダ自身も location.pathname から /sites/<x> を推定できるが、確実にしておく。
            $webRel = ([Uri]$siteUrl).AbsolutePath.TrimEnd('/')
            $prelude = 'window._spPageContextInfo=Object.assign({},window._spPageContextInfo,{' +
                       "webServerRelativeUrl:'$webRel',webAbsoluteUrl:'$siteUrl'," +
                       "siteServerRelativeUrl:'$webRel',siteAbsoluteUrl:'$siteUrl'});true"
            $cdp.Eval($prelude, $false) | Out-Null

            # ローダ注入。バンドルではなく「ローダ」を入れることで、
            # バンドルは従来どおり SP から読まれ、サイレント自動更新が温存される。
            # ★ ローダはランチャーと同じフォルダに必要。無いと CDP 注入ができず、
            #   ブックマークレット手動クリックの従来フローに落ちる (= 自動で起動しない)。
            #   dist/mikke.loader.js をこのフォルダにコピーすれば解決する。
            $loaderFile = Join-Path $scriptDir 'mikke.loader.js'
            if (-not (Test-Path -LiteralPath $loaderFile)) {
                throw ("mikke.loader.js が見つかりません: $scriptDir`n" +
                       '        配布物 (dist) の mikke.loader.js を、このフォルダ (mikke-launch.bat と同じ場所) に' +
                       'コピーしてください。これが無いと自動起動できません。')
            }
            $loaderJs = Get-Content -LiteralPath $loaderFile -Raw -Encoding UTF8
            $res = $cdp.Eval($loaderJs, $false)
            if ($res -match '"exceptionDetails"') { throw "ローダの注入に失敗しました: $res" }

            Write-Host ''
            Write-Host 'Mikke を起動しました (ブックマークレット不要)。このウィンドウのブラウザをそのままお使いください。' -ForegroundColor Green
            $cdpDone = $true
        } catch {
            Write-Host "CDP 起動に失敗しました: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host '従来フロー (ブックマークレット) に切り替えます。' -ForegroundColor Yellow
        }
    }
}

if (-not $cdpDone) { Invoke-LegacyFlow -Url $siteUrl }
