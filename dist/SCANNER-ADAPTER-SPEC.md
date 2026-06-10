# Mikke 検査ツール API アダプタ実装仕様

**成果物: `mikke-scanner-adapter.ps1`（PowerShell スクリプト 1 ファイル）**

この文書は、脆弱性管理ツール Mikke の中継サーバ（relay）が呼び出す「検査ツール API アダプタ」の実装仕様である。この仕様に沿って、検査ツール（ASM）の API から Issue 1 件の最新ステータスを取得して返すスクリプトを実装してほしい。API の具体的な仕様（エンドポイント・認証・レスポンス形式）は実装側の環境で確認できるものを使用する。

---

## 1. 全体像（どこで呼ばれるか）

```
[ブラウザ UI]  詳細画面の「最新状態を取得」ボタン
   │  POST http://127.0.0.1:18080/mikke/issue   body: {"issueInstanceId":"<ID>"}
   ▼
[mikke-relay.ps1]  ローカル中継サーバ（HttpListener / 編集禁止・自動更新で管理）
   │  毎リクエスト  . mikke-scanner-adapter.ps1  を dot-source し、
   │  Invoke-MikkeScannerFetch -IssueInstanceId <ID>  を呼ぶ
   ▼
[mikke-scanner-adapter.ps1]  ★今回実装するファイル
   │  検査ツール API を呼び、結果を正規化して hashtable で返す
   ▼
[検査ツール API]
```

- relay が受けた結果は JSON でブラウザへ返り、SharePoint リストの該当 Issue が更新される。
- **relay 本体（mikke-relay.ps1 / *.bat）は編集しないこと**。自動更新で上書きされる。アダプタはこのファイル 1 つで完結させる。

## 2. 成果物の要件

| 項目 | 要件 |
| --- | --- |
| ファイル名 | `mikke-scanner-adapter.ps1`（固定） |
| 置き場所 | `mikke-relay.ps1` と同じフォルダ |
| エンコーディング | **UTF-8（BOM 付き）**。BOM が無いと PowerShell 5.1 で日本語が文字化けする |
| 実行環境 | **Windows PowerShell 5.1**（Windows 標準。PowerShell 7 ではない） |
| 依存 | 追加モジュール禁止。標準の `Invoke-RestMethod` / `Invoke-WebRequest` / .NET クラスのみ |
| 配布 | git 等のリポジトリに**置かない**（API の固有情報を含むため）。実装環境内でのみ管理 |

### PowerShell 5.1 互換の禁止構文（重要）

以下は PS7 専用のため**使用禁止**（5.1 で構文エラーになる）:

- `?.`（null 条件演算子） / `??`（null 合体） / 三項演算子 `a ? b : c`
- `ConvertFrom-Json -AsHashtable`
- `&&` / `||` によるコマンド連結

また HTTPS API を呼ぶ場合、5.1 は既定で TLS 1.2 が無効なことがあるため、関数内の先頭で次を実行すること:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
```

## 3. 契約（インターフェース — 変更不可）

### 3-1. 定義する関数

スクリプトのトップレベルには**関数定義のみ**を書く（毎リクエスト dot-source されるため、トップレベルに副作用のある処理を書くと毎回実行される）。

```powershell
function Invoke-MikkeScannerFetch {
    param([Parameter(Mandatory = $true)][string]$IssueInstanceId)
    # ...実装...
    return @{ ... }   # 下記スキーマの hashtable
}
```

### 3-2. 入力

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `IssueInstanceId` | string | 検査ツールの Issue Instance ID（CSV の「Issue Instance ID」列と同じ値） |

### 3-3. 戻り値（hashtable）

```powershell
@{
    scannerStatus = '<string>'   # 検査ツール側の最新ステータス (例: open / fixed / ...)
    severity      = '<string>'   # 深刻度 (例: Critical / High / ...)
    lastSeen      = '<string>'   # 最終検出日時。ISO 8601 推奨 (例: 2026-06-10T12:34:56)
    scanFields    = @{           # 任意。省略可 (省略時は @{} 扱い)
        '<CSV列名>' = '<string値>'
    }
}
```

- すべて**文字列**で返す（数値・日付も文字列化する）。
- `scanFields` のキーは**検査ツール CSV のヘッダ列名そのまま**（例: `Status`、`First Seen`）。`Scan_` 接頭辞は付けない。
  - Mikke 側で管理項目（F6）にチェックされている列だけが SharePoint に反映される。それ以外のキーは無視される（エラーにはならない）。
- 該当データが無い項目は空文字 `''` でよい。

### 3-4. エラー

**`throw` で投げる**。relay が catch して HTTP 502 + メッセージとして UI のトーストに表示する。利用者が読んで原因が分かるメッセージにすること。区別して投げてほしいケース:

| ケース | throw メッセージの例 |
| --- | --- |
| 設定不足 | `'MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)'` |
| 認証失敗 | `'検査ツール API の認証に失敗しました (API キーを確認してください)'` |
| 該当 ID なし | `'Issue が見つかりません: <ID>'` |
| タイムアウト/接続不可 | `'検査ツール API に接続できません: <理由>'` |

タイムアウトは `Invoke-RestMethod -TimeoutSec 30` 程度を設定すること（無限待ちにしない）。

## 4. 設定値の受け渡し

接続先 URL・API キー等の**固有情報はスクリプトに直書きしない**。relay が起動時に読み込む `mikke-relay.env`（`KEY=VALUE` 形式、同フォルダ）に置き、アダプタからは**環境変数**で参照する:

```powershell
$apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
$apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')
```

| 環境変数 | 用途 |
| --- | --- |
| `MIKKE_SCANNER_API_BASE` | API のベース URL（例: `https://scanner.example.com/api/v1`） |
| `MIKKE_SCANNER_API_KEY` | API キー / トークン |

追加の設定が必要な場合は `MIKKE_SCANNER_` 接頭辞で `mikke-relay.env` に追加してよい（relay が全キーを環境変数として読み込む）。**env を変更した場合のみ relay の再起動が必要**（アダプタ本体の変更は再起動不要）。

## 5. 動作上の前提

- **ホットリロード**: relay は毎リクエスト dot-source するため、アダプタを保存すれば次の呼び出しから反映される（relay 再起動不要）。
- **呼び出し頻度**: 詳細画面でユーザが 1 件ずつ手動実行する想定（低頻度・単発）。一括同期は別機能なので考慮不要。
- **ログ**: `Write-Host` は relay のコンソールに出る。デバッグに使ってよいが、**API キー等の秘密情報は出力しないこと**。
- relay 側のエンドポイント仕様（参考。アダプタ実装には直接関係しない）:
  - `POST /mikke/issue`、入力 `{"issueInstanceId": "<ID>"}`
  - 成功: `200 {"ok":true, "scannerStatus":..., "severity":..., "lastSeen":..., "scanFields":{...}}`
  - 失敗: `400`(ID なし) / `501`(アダプタ未配置) / `500`(関数未定義) / `502`(アダプタが throw)

## 6. 実装の雛形

同梱の `mikke-scanner-adapter.example.ps1` をコピーして実装する。骨組み:

```powershell
# mikke-scanner-adapter.ps1 — 検査ツール API アダプタ (この環境専用・リポジトリに置かない)
# 保存: UTF-8 (BOM 付き) / Windows PowerShell 5.1 互換

function Invoke-MikkeScannerFetch {
    param([Parameter(Mandatory = $true)][string]$IssueInstanceId)

    # TLS 1.2 (PS5.1 対策)
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # 設定 (mikke-relay.env 由来の環境変数)
    $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE')
    $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY')
    if (-not $apiBase) { throw 'MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)' }

    # ── API 呼び出し (実際のエンドポイント/認証方式に合わせて実装) ──
    $headers = @{ Authorization = "Bearer $apiKey" }
    try {
        $r = Invoke-RestMethod `
            -Uri "$apiBase/issues/$([uri]::EscapeDataString($IssueInstanceId))" `
            -Headers $headers -Method Get -TimeoutSec 30
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 401 -or $status -eq 403) { throw '検査ツール API の認証に失敗しました (API キーを確認してください)' }
        if ($status -eq 404) { throw "Issue が見つかりません: $IssueInstanceId" }
        throw "検査ツール API に接続できません: $($_.Exception.Message)"
    }

    # ── 正規化して返す (フィールド名は実際のレスポンスに合わせる) ──
    return @{
        scannerStatus = [string]$r.status
        severity      = [string]$r.severity
        lastSeen      = [string]$r.last_seen
        scanFields    = @{
            'Status' = [string]$r.status
            # 必要に応じて CSV 列名 = 値 を追加
        }
    }
}
```

## 7. テスト方法

### 7-1. 単体（relay なし）

```powershell
powershell -NoProfile -Command ". .\mikke-scanner-adapter.ps1; Invoke-MikkeScannerFetch -IssueInstanceId '<実在するID>' | ConvertTo-Json"
```

→ §3-3 のスキーマの JSON が出れば OK。エラー系（存在しない ID 等）も throw メッセージを確認する。

### 7-2. relay 経由

relay（`mikke-launch.bat`）を起動した状態で:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:18080/mikke/issue' -Method Post `
  -ContentType 'application/json' -Body '{"issueInstanceId":"<実在するID>"}'
```

→ `ok: true` と正規化済みの値が返れば OK。relay のコンソールに `[issue] <ID> -> OK` が出る。

### 7-3. UI から

Mikke の詳細画面 →「最新状態を取得」→ 値が更新され「最新状態を取得しました」トーストが出れば完了。

## 8. チェックリスト

- [ ] ファイル名は `mikke-scanner-adapter.ps1`、relay と同じフォルダに配置
- [ ] UTF-8 (BOM 付き) で保存
- [ ] PowerShell **5.1** で動作（禁止構文なし / TLS 1.2 明示）
- [ ] トップレベルは関数定義のみ（副作用コードなし）
- [ ] 戻り値は §3-3 のスキーマ（すべて文字列値）
- [ ] エラーは利用者が読める日本語メッセージで throw / タイムアウト設定あり
- [ ] API キー・URL はスクリプトに直書きせず `mikke-relay.env` 参照
- [ ] 秘密情報をログ (`Write-Host`) に出していない
- [ ] §7 のテスト 3 段階がすべて通る
