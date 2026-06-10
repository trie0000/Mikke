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
    # $headers = @{ Authorization = "Bearer $apiKey" }
    # $r = Invoke-RestMethod -Uri "$apiBase/issues/$([uri]::EscapeDataString($IssueInstanceId))" `
    #         -Headers $headers -TimeoutSec 30
    # return @{
    #     scannerStatus = [string]$r.status
    #     severity      = [string]$r.severity
    #     lastSeen      = [string]$r.last_seen
    #     scanFields    = @{ 'Status' = [string]$r.status }
    # }
    # ──────────────────────────────────────────────────────────────────────────

    throw 'mikke-scanner-adapter: 未実装です。example をコピーして実 API 呼び出しを実装してください。'
}
