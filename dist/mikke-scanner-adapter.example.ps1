# =============================================================================
# mikke-scanner-adapter.example.ps1 — 検査ツール API アダプタの雛形
# =============================================================================
#
# ★ 実装仕様の詳細は SCANNER-ADAPTER-SPEC.md を参照 (契約・制約・テスト方法)。
#
# 使い方 (委託先環境):
#   1) このファイルを mikke-scanner-adapter.ps1 という名前でコピーする
#        copy mikke-scanner-adapter.example.ps1 mikke-scanner-adapter.ps1
#   2) 下の Invoke-MikkeScannerFetch に実 API 呼び出しを実装する
#   3) relay (mikke-relay.ps1) と同じフォルダに置く。relay の再起動は不要
#      (毎リクエスト読み込まれるため、保存すれば次の呼び出しから反映される)
#
# 注意:
#   - mikke-scanner-adapter.ps1 (実装版) は relay の自動更新 (self-update) の
#     管理外・git 管理外。委託先環境で自由に実装・更新してよい。
#     relay 本体 (mikke-relay.ps1 / .bat) は直接編集しないこと (自動更新で上書きされる)。
#   - Windows PowerShell 5.1 互換で書くこと (7 専用構文 `?.` `??` 三項 `?:`
#     `ConvertFrom-Json -AsHashtable` は使わない)。ファイルは UTF-8 (BOM 付き) で保存。
#   - 接続先・認証情報は mikke-relay.env に置く (relay が起動時に環境変数として
#     読み込むので、ここからは環境変数で参照できる):
#       MIKKE_SCANNER_API_BASE=https://<scanner-api-host>
#       MIKKE_SCANNER_API_KEY=<api-key>
#
# 契約 (relay が呼び出す I/F — 変更しないこと):
#   関数名:  Invoke-MikkeScannerFetch
#   入力:    -IssueInstanceId <string>   (CSV の Issue Instance ID)
#   戻り値:  hashtable
#     @{
#       scannerStatus = <string>    # 検査ツール側の最新ステータス
#       severity      = <string>    # 深刻度
#       lastSeen      = <string>    # 最終検出日時 (ISO8601 推奨)
#       detected      = <bool>      # 任意。現在も検出されているか (返すと検知ステータスが自動遷移)
#       scanFields    = @{ '<CSV列名>' = '<値>' }   # 任意。動的列の更新に使う
#     }
#   エラー:  throw する (relay が 502 + メッセージで UI に返す)
# =============================================================================

function Invoke-MikkeScannerFetch {
    param([Parameter(Mandatory = $true)][string]$IssueInstanceId)

    # HTTPS API 用: PS5.1 は既定で TLS1.2 が無効なことがあるため明示する
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
    $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')
    if (-not $apiBase) { throw 'MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)' }

    # ── TODO: ここに実 API 呼び出しを実装する (以下は骨組みの例) ──────────────
    # ★ 診断ログ規約 (SPEC §5-1): リクエスト URL を呼び出し前にログし、失敗時は
    #   HTTP status と応答ボディ (先頭500文字) をログすること。404 等の「理由」は
    #   応答ボディに入っていることが多い。Authorization 等の秘密はログに出さない。
    #
    # $headers = @{ Authorization = "Bearer $apiKey" }
    # $url = "$apiBase/issues/$([uri]::EscapeDataString($IssueInstanceId))"
    # Write-Host "[adapter] GET $url" -ForegroundColor DarkGray
    # try {
    #     $r = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 30
    # } catch {
    #     # HTTP status と応答ボディを取り出してログ (原因特定の要)
    #     $status = $null
    #     if ($_.Exception.Response) { try { $status = [int]$_.Exception.Response.StatusCode } catch { } }
    #     $respBody = ''
    #     if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $respBody = $_.ErrorDetails.Message }
    #     elseif ($_.Exception.Response) {
    #         try {
    #             $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    #             $respBody = $sr.ReadToEnd(); $sr.Close()
    #         } catch { }
    #     }
    #     if ($respBody.Length -gt 500) { $respBody = $respBody.Substring(0, 500) + '…' }
    #     Write-Host "[adapter] -> HTTP $status" -ForegroundColor Yellow
    #     if ($respBody) { Write-Host "[adapter] response: $respBody" -ForegroundColor Yellow }
    #
    #     if ($status -eq 401 -or $status -eq 403) { throw "検査ツール API の認証に失敗しました (HTTP $status)" }
    #     if ($status -eq 404) { throw "Issue が見つかりません (HTTP 404): $IssueInstanceId / API応答: $respBody" }
    #     throw "検査ツール API の呼び出しに失敗 (HTTP $status): $($_.Exception.Message)"
    # }
    # return @{
    #     scannerStatus = [string]$r.status
    #     severity      = [string]$r.severity
    #     lastSeen      = [string]$r.last_seen
    #     # detected: 現在も検出されているか。API のステータス値から正規化する
    #     # (例: open/active → $true、resolved/fixed/closed → $false)。
    #     # 判定できない場合はキーごと省略 (Mikke は検知ステータスを変更しない)。
    #     detected      = ($r.status -in @('open', 'active'))
    #     scanFields    = @{ 'Status' = [string]$r.status }
    # }
    # ──────────────────────────────────────────────────────────────────────────

    throw 'mikke-scanner-adapter: 未実装です。example をコピーして実 API 呼び出しを実装してください。'
}

# =============================================================================
# 契約 (一括ダウンロード — /mikke/download が呼び出す I/F。変更しないこと):
#   関数名:  Invoke-MikkeScannerDownload
#   入力:    -Types <string[]>   ('vuln','ip','iprange','domain','cert','webapps' の部分集合)
#   戻り値:  hashtable
#     @{
#       items = @(
#         @{
#           type                = <string>   # 'vuln' / 'ip' / 'iprange' / 'domain' / 'cert' / 'webapps'
#           fileName            = <string>   # 元ファイル名 (例: 'vulnerabilities.csv')
#           contentBase64       = <string>   # ファイル内容の Base64 (CSV/xlsx 等バイナリ安全)
#           scannerDownloadTime = <string>   # 任意。検査ツール側のエクスポート日時 (ISO8601 推奨)
#           itemCount           = <int>      # 任意。件数 (参考表示用)
#         }, ...
#       )
#     }
#   ・zip 圧縮・SP ドキュメントライブラリへの保存はブラウザ側が行う。アダプタは
#     「検査ツールからデータを取得し Base64 で返す」中継のみを担う。
#   ・1 種別につき複数ファイルを返してもよい (同 type の items が複数)。ブラウザ側で
#     種別ごとに 1 つの zip にまとめる。
#   ・エラーは throw する (relay が 502 + メッセージで UI に返す)。診断ログ規約は
#     Fetch と同じ (SPEC §5-1)。詳細は SCANNER-ADAPTER-SPEC.md §9 を参照。
# =============================================================================

function Invoke-MikkeScannerDownload {
    param([Parameter(Mandatory = $true)][string[]]$Types)

    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
    $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')
    if (-not $apiBase) { throw 'MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)' }

    # ── TODO: 種別ごとに検査ツールからエクスポートを取得して Base64 で返す ──────
    # $items = @()
    # foreach ($t in $Types) {
    #     # 種別 → 検査ツールのエンドポイント/エクスポート種別へのマッピングは環境依存。
    #     $url = "$apiBase/export/$([uri]::EscapeDataString($t))"
    #     Write-Host "[adapter] GET $url" -ForegroundColor DarkGray   # 秘密は出さない
    #     $headers = @{ Authorization = "Bearer $apiKey" }
    #     # バイナリで受けたい場合は Invoke-WebRequest を使い .Content (byte[]) を Base64 化する。
    #     $resp  = Invoke-WebRequest -Uri $url -Headers $headers -Method Get -TimeoutSec 120
    #     $bytes = $resp.Content
    #     if ($bytes -is [string]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($bytes) }
    #     $items += @{
    #         type                = $t
    #         fileName            = "$t.csv"
    #         contentBase64       = [Convert]::ToBase64String($bytes)
    #         scannerDownloadTime = (Get-Date).ToString('s')
    #         itemCount           = 0
    #     }
    # }
    # return @{ items = $items }
    # ──────────────────────────────────────────────────────────────────────────

    throw 'mikke-scanner-adapter: Invoke-MikkeScannerDownload は未実装です。example をコピーして実装してください。'
}
