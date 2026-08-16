# 変更依頼: 検査ツール API の接続情報を「リクエスト引数」で受け取る

**対象ファイル: `mikke-relay.ps1`（中継サーバ本体）と `mikke-scanner-adapter.ps1`（アダプタ）**

この文書は、既存の中継サーバとアダプタに対する **変更の依頼書**（差分だけ）である。

- **これから新規に実装する場合**は、この文書ではなく `SCANNER-ADAPTER-SPEC.md` を読むこと。
  そちらは既に新しい契約（引数で受け取る方式）で書かれており、単独で完結している。
- **既に動いているものを直す場合**だけ、この文書の差分に従う。

---

## 1. 何を変えるか（1 行で）

検査ツール API の **ベース URL と API キーを、環境変数 (`mikke-relay.env`) ではなく、ブラウザから来るリクエストの引数で受け取る**ようにする。

## 2. なぜ変えるか

- API キーを `mikke-relay.env` に置くと、配布物やバックアップに秘密情報が混ざる。運用ルール上、**秘密情報はファイルに残さない**。
- 接続情報は利用者ごとにブラウザ（この端末だけ）に保存する方式へ変更済み。中継サーバは**受け取って使うだけで、保存しない**。

```
[ブラウザ]  設定 → 個人設定 → 接続 → 検査ツール API
   │  (端末の localStorage にのみ保存。SharePoint には保存しない)
   │
   │  POST http://127.0.0.1:18120/mikke/issues
   │  body: { "issueInstanceIds": [...], "includeReport": true,
   │          "apiBase": "https://…", "apiKey": "…" }      ← ★ 今回追加される
   ▼
[mikke-relay.ps1]   受け取った値をアダプタに渡すだけ（保存しない・ログに出さない）
   ▼
[mikke-scanner-adapter.ps1]   その値で検査ツール API を呼ぶ
```

## 3. 変更するエンドポイント（4 つ）

ブラウザは次の 4 つに `apiBase` / `apiKey` を **body の項目として追加**して送る。
他のエンドポイント（`/health` `/csv-parse` `/merge` `/bundle-dir` など）は変更不要。

| エンドポイント | 既存の body | 追加される項目 |
| --- | --- | --- |
| `POST /mikke/issue` | `{ issueInstanceId }` | `apiBase`, `apiKey` |
| `POST /mikke/issue-report` | `{ issueInstanceId }` | `apiBase`, `apiKey` |
| `POST /mikke/issues` | `{ issueInstanceIds, includeReport }` | `apiBase`, `apiKey` |
| `POST /mikke/download` | `{ types }` | `apiBase`, `apiKey` |

- 型はどちらも文字列。
- **未設定のときは項目自体が来ない**（空文字では来ない）。この場合は従来どおり環境変数を使う（後方互換。次章）。

## 4. `mikke-relay.ps1` の変更内容

### 4.1 受け取ってアダプタへ渡す

各エンドポイントの処理で body から読み、アダプタ呼び出しの引数に足す。

```powershell
# body の読み取り（既存の ConvertFrom-Json の直後あたり）
$apiBase = $null
$apiKey  = $null
try {
    $b = $bodyText | ConvertFrom-Json
    if ($b.apiBase) { $apiBase = [string]$b.apiBase }
    if ($b.apiKey)  { $apiKey  = [string]$b.apiKey }
} catch { }

# ★ 引数が無いときだけ環境変数にフォールバック（後方互換）
if (-not $apiBase) { $apiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE') }
if (-not $apiKey)  { $apiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY') }

# アダプタ呼び出し
$result = Invoke-MikkeScannerFetch -IssueInstanceId $iid -ApiBase $apiBase -ApiKey $apiKey
```

### 4.2 並列取得 (`/mikke/issues`) の runspace へも渡す

`/mikke/issues` は 1 脆弱性 = 1 runspace で並列に処理している。runspace には
**引数として明示的に渡す**こと（runspace は呼び出し元の変数を引き継がない）。

```powershell
$ps.AddScript($script).AddArgument($adapterPath).AddArgument($iid).AddArgument($withReport).
    AddArgument($apiBase).AddArgument($apiKey) | Out-Null
```

```powershell
# runspace 側の param も合わせて増やす
param($AdapterPath, $Iid, $WithReport, $ApiBase, $ApiKey)
```

### 4.3 秘密情報を残さない（重要）

- **`Write-Host` / ログに `apiKey` を出さない。** 既存の `[issue] <ID> -> OK` のような行はそのままでよいが、body をまるごと出力する処理を足さないこと。
- **ファイルに保存しない。** `$script:` のグローバル変数に入れて使い回すのも不可（別の利用者のリクエストに混ざる）。**リクエストごとにローカル変数で受け渡す**。
- エラー応答 (`detail`) に API キーを含めない。API のレスポンス本文をそのまま `detail` に入れている箇所があれば、キーが含まれ得ないか確認する。
- 起動時のバナー表示は現状どおり（環境変数の有無を出すだけ）。値は出さない。

### 4.4 変えないこと

- `mikke-relay.env` の `MIKKE_SCANNER_API_BASE` / `MIKKE_SCANNER_API_KEY` の読み取りは **残す**（引数が無いときのフォールバック）。既存環境をいきなり壊さないため。
- エンドポイントの URL・レスポンス形式・エラーコードは変更しない。
- ポート番号、CORS、その他の挙動は変更しない。

## 5. `mikke-scanner-adapter.ps1` の変更内容

3 つの関数すべてに、省略可能なパラメータを 2 つ足す。

```powershell
function Invoke-MikkeScannerFetch {
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,
        [string]$ApiKey
    )
    # ★ 引数を優先し、無ければ環境変数（後方互換）
    if (-not $ApiBase) { $ApiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE') }
    if (-not $ApiKey)  { $ApiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY') }
    if (-not $ApiBase) { throw '検査ツール API のベース URL が指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }
    if (-not $ApiKey)  { throw '検査ツール API のキーが指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }
    # 以降は $ApiBase / $ApiKey を使って API を呼ぶ（既存の実装のまま）
}
```

同様に:

- `Invoke-MikkeScannerIssueReport -IssueInstanceId <id> -ApiBase <url> -ApiKey <key>`
- `Invoke-MikkeScannerDownload -Types <string[]> -ApiBase <url> -ApiKey <key>`

**未設定時のエラーメッセージは上記の文言にすること。** ブラウザにそのまま出るので、利用者が「どこで設定するか」を読み取れる必要がある。

## 6. 動作確認の手順

1. `mikke-relay.env` から `MIKKE_SCANNER_API_BASE` / `MIKKE_SCANNER_API_KEY` を**消す**（またはコメントアウト）。relay を再起動する。
2. Mikke の 設定 → 個人設定 → 接続 → 検査ツール API に、ベース URL と API キーを入力して保存する。
3. 管理対象一覧で 1 件選び「情報更新(選択・固定)」を実行する。
   - **期待**: 従来どおり更新される。
4. 手順 2 の設定を空にして保存し、もう一度実行する。
   - **期待**: 「検査ツール API のベース URL が指定されていません (Mikke の 設定 → …)」というエラーが画面に出る。
5. relay のコンソール出力に **API キーが 1 文字も出ていない**ことを確認する。
6. 逆方向の確認（後方互換）: 手順 2 を空のままにして `mikke-relay.env` に環境変数を書いて relay を再起動 → 実行すると従来どおり動くこと。

## 7. 補足

- ブラウザ → relay は `http://127.0.0.1` の同一端末内通信なので、キーが外部ネットワークに出ることはない。
- relay は 127.0.0.1 のみで listen していること（現状どおり）。他ホストから叩けるようにしないこと。
- 本変更を入れる前のブラウザ（古いバンドル）から呼ばれても、引数が来ないだけでフォールバックが効くため壊れない。逆に、新しいブラウザから古い relay を呼んだ場合は、余分な body 項目が無視されるだけで従来どおり環境変数で動く。**どちらの順で更新しても止まらない。**
