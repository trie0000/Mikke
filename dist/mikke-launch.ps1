# mikke-launch.ps1 — relay 起動 → /health 待機 → Mikke を自動起動 (CDP ワンクリック)
#
# 起動の流れ:
#   1) relay が起動していなければ別ウィンドウ (-NoExit) で起動し、/health を待つ
#   2) ★ CDP ワンクリック: 専用プロファイルの Edge を --remote-debugging-port 付きで
#      起動し、SharePoint の認証を検知したら CDP 経由で **同じフォルダの
#      mikke.bundle.js をそのまま注入** する (= ブックマークレット不要。
#      SharePoint ライブラリへのバンドル配置も不要で、手元のビルドが即起動する)
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
#   MIKKE_CDP_PORT      : CDP のデバッグポート (既定 9339)
#                         ★ 他の CDP を使うツールと重なると、そちらのブラウザに
#                           注入してしまうので既定値をずらしてある。重なった場合も
#                           ポートの持ち主を判定して空きポートに退避する。
#   MIKKE_EDGE_PATH     : msedge.exe のパス (未設定なら既定の場所を自動探索)
#   MIKKE_EDGE_USERDATA : 専用プロファイルの置き場所 (既定 %LOCALAPPDATA%\mikke-edge)
#                         ★ 新規作成時だけ、既存 Edge から SharePoint のサインインを
#                           引き継ぐ。既存プロファイルは作り直さない (再サインイン防止)。
#   MIKKE_EDGE_SOURCE_PROFILE : 引き継ぎ元の Edge プロファイル名 (既定 Default)
#   MIKKE_SEED_COOKIES  : '0' でサインインの引き継ぎを無効化 (毎回手動サインイン)
#   MIKKE_INJECT        : 'loader' で従来どおりローダを注入し、バンドルは SharePoint
#                         から読む (サイレント自動更新を使いたい運用向け)。
#                         既定は同じフォルダの mikke.bundle.js を直接注入。
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
$cdpPort = 9339   # 既定。他の CDP ツールと衝突しにくい値にしている
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

# 使用中でも読めるようにファイル共有モードでコピーする (Edge が掴んだままの Cookie DB 用)。
function Copy-MikkeFileShared {
    param([string]$Src, [string]$Dst)
    if (-not (Test-Path -LiteralPath $Src)) { return }
    $dir = Split-Path -Parent $Dst
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $in = New-Object System.IO.FileStream($Src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $out = New-Object System.IO.FileStream($Dst, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $in.CopyTo($out) } finally { $out.Dispose() }
    } finally { $in.Dispose() }
}

# ディレクトリ直下のファイルを共有読み取りコピー (leveldb 等のフラット構成向け)。
function Copy-MikkeDirShared {
    param([string]$SrcDir, [string]$DstDir)
    if (-not (Test-Path -LiteralPath $SrcDir)) { return }
    New-Item -ItemType Directory -Force -Path $DstDir | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $SrcDir -File -ErrorAction SilentlyContinue)) {
        try { Copy-MikkeFileShared -Src $f.FullName -Dst (Join-Path $DstDir $f.Name) } catch { }
    }
}

# ★ 専用プロファイルを新規作成するとき、既存 Edge から「必要なものだけ」引き継ぐ。
#   (a) Cookie + Local State … SharePoint のサインイン (復号鍵が Local State にあるので両方要る)
#   (b) Local Storage        … Mikke の画面状態 (選択サイト等)
#   これをやらないと専用プロファイルは未サインイン状態で始まり、起動のたびに
#   手動サインインが必要になる (= 「サインインを待っています」で止まる)。
#   キャッシュ / 履歴 / パスワード / ブックマークは持ち込まない。
#   すべて best-effort。失敗しても「初回サインインが必要」になるだけ。
function Copy-MikkeProfileSeed {
    param([string]$DestUserData)   # = 専用プロファイルの --user-data-dir

    $srcUserData = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
    $srcProfName = if ($env:MIKKE_EDGE_SOURCE_PROFILE) { $env:MIKKE_EDGE_SOURCE_PROFILE } else { 'Default' }
    $srcProf = Join-Path $srcUserData $srcProfName
    if (-not (Test-Path -LiteralPath $srcProf)) {
        Write-Host "コピー元の Edge プロファイルが見つかりません ($srcProf) → 空で開始します" -ForegroundColor DarkGray
        return
    }
    $dstProf = Join-Path $DestUserData 'Default'
    Write-Host 'サインイン情報を専用プロファイルへ引き継いでいます...' -ForegroundColor Cyan

    Copy-MikkeDirShared -SrcDir (Join-Path $srcProf 'Local Storage\leveldb') -DstDir (Join-Path $dstProf 'Local Storage\leveldb')

    if ($env:MIKKE_SEED_COOKIES -ne '0') {
        try {
            Copy-MikkeFileShared -Src (Join-Path $srcUserData 'Local State') -Dst (Join-Path $DestUserData 'Local State')
            $ckNew = Join-Path $srcProf 'Network\Cookies'
            $ckOld = Join-Path $srcProf 'Cookies'
            if (Test-Path -LiteralPath $ckNew) {
                Copy-MikkeFileShared -Src $ckNew -Dst (Join-Path $dstProf 'Network\Cookies')
                foreach ($sfx in @('-wal', '-journal')) {
                    $s = $ckNew + $sfx
                    if (Test-Path -LiteralPath $s) { Copy-MikkeFileShared -Src $s -Dst (Join-Path $dstProf ('Network\Cookies' + $sfx)) }
                }
            } elseif (Test-Path -LiteralPath $ckOld) {
                Copy-MikkeFileShared -Src $ckOld -Dst (Join-Path $dstProf 'Cookies')
            }
        } catch {
            Write-Host "Cookie の引き継ぎをスキップしました (初回サインインが必要): $($_.Exception.Message)" -ForegroundColor DarkGray
        }
    }
    Write-Host '引き継ぎ完了' -ForegroundColor Green
}

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

# 指定ポートで CDP が応答するか (= 何かのブラウザが listen しているか)。
function Test-CdpUp {
    param([int]$CdpPort)
    try {
        # ループバックはプロキシを迂回させたいので Invoke-RestMethod を使う
        Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 1 | Out-Null
        return $true
    } catch { return $false }
}

# そのポートを listen しているのが「自分が起動したブラウザ」か。
# ★ CDP には「どの --user-data-dir で動いているか」を返す API が無いので、
#   ポートの所有プロセスのコマンドラインを見る。判定できない場合は false を
#   返す (= 他人のものとして扱う)。誤って別ツールのブラウザに注入するより、
#   ブラウザがもう 1 つ開く方が害が小さい。
function Test-CdpPortOwnedByUs {
    param([int]$CdpPort, [string]$UserDataDir)
    if (-not $UserDataDir) { return $false }
    try {
        $conn = Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction Stop |
                Select-Object -First 1
        if (-not $conn) { return $false }
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction Stop
        if (-not $proc) { return $false }
        # -like はパス中の [ ] をワイルドカード扱いするので Contains で literal 比較する
        return ([string]$proc.CommandLine).Contains($UserDataDir)
    } catch {
        Write-Host "  (CDP ポートの持ち主を判定できませんでした: $($_.Exception.Message))" -ForegroundColor DarkGray
        return $false
    }
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
        # サイト URL から origin / サイトルート (/sites/<x> or /teams/<x>) を導出する。
        # ★ 設定に入っている URL はページやライブラリまで含むことがある。そのまま
        #   REST のベースにすると誤った URL を叩くので、必ずサイトルートに正規化する。
        $u = $null
        try { $u = New-Object System.Uri($siteUrl) } catch { }
        if (-not $u) { throw "サイト URL を解釈できません: $siteUrl" }
        $origin = $u.Scheme + '://' + $u.Authority
        $webRel = ''
        $mm = [regex]::Match($u.AbsolutePath, '(?i)/(?:sites|teams)/[^/]+')
        if ($mm.Success) { $webRel = $mm.Value }
        $webAbs = $origin + $webRel

        # ★ 既存の専用プロファイルは絶対に作り直さない (作り直すと再サインインになる)。
        #   MIKKE_EDGE_USERDATA(明示) > 既存の %LOCALAPPDATA%\mikke-edge > 新規作成
        if (-not $edgeUserData) { $edgeUserData = Join-Path $env:LOCALAPPDATA 'mikke-edge' }
        $profileExisted = Test-Path -LiteralPath $edgeUserData
        if (-not $profileExisted) {
            # 新規作成時だけ、既存 Edge からサインイン情報を引き継ぐ。
            try { Copy-MikkeProfileSeed -DestUserData $edgeUserData }
            catch { Write-Host "サインイン情報の引き継ぎをスキップ (初回サインインが必要): $($_.Exception.Message)" -ForegroundColor DarkGray }
        }
        try {
            # 既に CDP 付きで起動済みなら再起動しない (SingletonLock のレース回避)。
            # ★ ただし「起動済み」= 自分のブラウザとは限らない。CDP を使う別ツールが
            #   同じポートを使っていると、そちらのブラウザに Mikke を注入してしまう。
            #   ポートを listen しているプロセスのコマンドラインに自分の
            #   --user-data-dir が含まれるかで持ち主を判定し、他人のものなら
            #   空きポートを探して自前のブラウザを起動する。
            $alreadyUp = (Test-CdpUp -CdpPort $cdpPort)
            if ($alreadyUp -and -not (Test-CdpPortOwnedByUs -CdpPort $cdpPort -UserDataDir $edgeUserData)) {
                $taken = $cdpPort
                $found = 0
                for ($p = $taken + 1; $p -le $taken + 20; $p++) {
                    if (-not (Test-CdpUp -CdpPort $p)) { $found = $p; break }
                }
                if ($found -eq 0) {
                    throw ("CDP ポート $taken は別のツールが使用中で、代わりの空きポートも見つかりませんでした。" +
                           "mikke-relay.env の MIKKE_CDP_PORT で別のポートを指定してください。")
                }
                Write-Host "port $taken は別のツールの CDP が使用中です。port $found で自前のブラウザを起動します。" -ForegroundColor Yellow
                $cdpPort = $found
                $alreadyUp = $false
            }

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
                    # ★ 引用符で括ること。SharePoint の URL は空白を含むことがあり
                    #   (例: /Shared Documents)、括らないと空白で分割されて 2 タブ開き、
                    #   注入先のタブを取り違える。
                    "`"$webAbs`""
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

            # 認証待ち (awaitPromise + retry。ログイン中は Failed to fetch → 握って継続)。
            # JS は $ を含むので PS の単一引用符文字列で組み立てる ($select が展開されないように)。
            $probe = '(async()=>{try{const r=await fetch("' + $webAbs + '/_api/web?$select=Title",' +
                     '{headers:{Accept:"application/json;odata=nometadata"},credentials:"include"});' +
                     'return r.ok;}catch(e){return false;}})()'
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
            $prelude = 'window._spPageContextInfo=Object.assign({},window._spPageContextInfo,{' +
                       'webServerRelativeUrl:"' + $webRel + '",webAbsoluteUrl:"' + $webAbs + '",' +
                       'siteServerRelativeUrl:"' + $webRel + '",siteAbsoluteUrl:"' + $webAbs + '"});true'
            $cdp.Eval($prelude, $false) | Out-Null

            # ★ 中継サーバの接続先をブラウザに教える。
            #   ブラウザ側の既定は 18080 固定なので、-Port や MIKKE_RELAY_PORT で
            #   別ポートにしていると「中継サーバが起動していません」になる。
            #   専用プロファイルは localStorage が空のことが多く、設定画面から
            #   入れ直す運用も現実的でないため、起動時にこちらから確定させる。
            $relayJs = 'try{localStorage.setItem("mikke.relay.base","http://127.0.0.1:' + $Port + '/mikke");}catch(e){};true'
            try { $cdp.Eval($relayJs, $false) | Out-Null } catch { }

            # ★ バンドル注入 (既定)
            #   CDP が繋がっているので、ローカルの mikke.bundle.js をそのまま
            #   Runtime.evaluate に流し込む。SharePoint ライブラリへの配置も
            #   relay 経由の取得も不要で、手元のビルドがそのまま起動する
            #   (開発中はこれが最短。SP に古いバンドルがあっても影響を受けない)。
            #   MIKKE_INJECT=loader を指定すると、従来どおりローダ (SP からの
            #   サイレント自動更新つき) を注入する。
            $injectMode = [Environment]::GetEnvironmentVariable('MIKKE_INJECT')
            $bundleFile = Join-Path $scriptDir 'mikke.bundle.js'
            $loaderFile = Join-Path $scriptDir 'mikke.loader.js'
            $useBundle = ($injectMode -ne 'loader') -and (Test-Path -LiteralPath $bundleFile)

            if ($useBundle) {
                $js = Get-Content -LiteralPath $bundleFile -Raw -Encoding UTF8
                $srcLabel = "ローカルのバンドル ($([math]::Round((Get-Item $bundleFile).Length / 1KB)) KB)"
            } else {
                if (-not (Test-Path -LiteralPath $loaderFile)) {
                    throw ("mikke.bundle.js も mikke.loader.js も見つかりません: $scriptDir`n" +
                           '        配布物 (dist) の mikke.bundle.js を、このフォルダ (mikke-launch.bat と同じ場所) に' +
                           'コピーしてください。これが無いと自動起動できません。')
                }
                $js = Get-Content -LiteralPath $loaderFile -Raw -Encoding UTF8
                $srcLabel = 'ローダ (SharePoint からバンドルを取得)'
            }
            Write-Host "注入します: $srcLabel" -ForegroundColor Cyan
            $res = $cdp.Eval($js, $false)
            if ($res -match '"exceptionDetails"') { throw "注入に失敗しました ($srcLabel): $res" }

            # ★ 注入できた = 画面が出た、ではない。バンドル直挿しなら起動は同期的だが、
            #   ローダ経由だと SharePoint から **非同期に** 取りに行き、失敗しても
            #   console.warn するだけ。確認しないと「ブラウザは上がるが画面が出ない」
            #   状態のまま「起動しました」と表示してしまう。
            Write-Host 'Mikke の画面が出るのを待っています...' -ForegroundColor Cyan
            $waitJs = '(async()=>{for(var i=0;i<40;i++){' +
                      'if(document.getElementById("mikke-root"))return "ok";' +
                      'await new Promise(function(r){setTimeout(r,500);});}return "timeout";})()'
            $mounted = ''
            try {
                $wr = $cdp.Eval($waitJs, $true) | ConvertFrom-Json
                $mounted = [string]$wr.result.result.value
            } catch { $mounted = 'unknown' }

            if ($mounted -ne 'ok') {
                if ($useBundle) {
                    # 直挿しで出ないのは、バンドル自体が実行時エラーになっているケース。
                    # ページ内に残っているエラーを拾って出す。
                    $errJs = '(function(){try{return (window.Mikke?"window.Mikke あり":"window.Mikke なし")' +
                             '+" / root="+(document.getElementById("mikke-root")?"あり":"なし");}' +
                             'catch(e){return "probe error: "+(e&&e.message||e);}})()'
                    $diag = ''
                    try {
                        $dr = $cdp.Eval($errJs, $false) | ConvertFrom-Json
                        $diag = [string]$dr.result.result.value
                    } catch { $diag = '(取得できませんでした)' }
                    throw ("バンドルは注入できましたが Mikke の画面が出ませんでした。`n" +
                           "        $diag`n" +
                           "        ブラウザの F12 → Console にエラーが出ていないか確認してください。")
                }
                # ローダに焼き込まれているバンドル配置パスを取り出して、実際に取得を試す。
                $libPath = '/Shared%20Documents/Mikke'
                $mLib = [regex]::Match($js, 'return r\?r\+"([^"]+)"')
                if ($mLib.Success) { $libPath = $mLib.Groups[1].Value }
                $diagJs = '(async()=>{try{' +
                          'var c=window._spPageContextInfo||{};' +
                          'var rel=(c.webServerRelativeUrl||"").replace(/\/$/,"");' +
                          'var u=rel+"' + $libPath + '/mikke.bundle.js";' +
                          'var r=await fetch(u,{credentials:"same-origin",cache:"no-store"});' +
                          'var t=await r.text();' +
                          'return u+" -> HTTP "+r.status+" / "+t.length+" bytes";' +
                          '}catch(e){return "fetch error: "+(e&&e.message||e);}})()'
                $diag = ''
                try {
                    $dr = $cdp.Eval($diagJs, $true) | ConvertFrom-Json
                    $diag = [string]$dr.result.result.value
                } catch { $diag = '(取得できませんでした)' }
                throw ("ローダは注入できましたが Mikke の画面が出ませんでした。" +
                       "SharePoint 上のバンドル配置を確認してください。`n" +
                       "        $diag`n" +
                       "        HTTP 404 ならドキュメント ライブラリの Mikke フォルダに " +
                       "mikke.bundle.js / version.txt が置かれていません。")
            }

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
