# 変更依頼: アダプタが接続情報を「引数」で受け取るようにする

**対象ファイル: `mikke-scanner-adapter.ps1` のみ**

この文書は、既に実装済みの `mikke-scanner-adapter.ps1` に対する **変更の依頼書**（差分だけ）である。

- **これから新規に実装する場合**は、この文書ではなく `SCANNER-ADAPTER-SPEC.md` を読むこと。
  そちらは既に新しい契約で書かれており、単独で完結している。
- **中継サーバ (`mikke-relay.ps1`) は対応済み**。触る必要はない（自動更新で配られる）。
  必要なのはアダプタ側の受け取り口を増やすことだけ。

---

## 1. 何を変えるか（1 行で）

検査ツール API の **ベース URL と API キーを、環境変数ではなく関数の引数で受け取る**ようにする。

## 2. なぜ変えるか

API キーを `mikke-relay.env` に置くと、配布物やバックアップに秘密情報が残る。
利用者ごとにブラウザ（各自の端末）へ保存し、実行のたびに渡す方式に変更した。

```
[ブラウザ]  設定 → 個人設定 → 接続 → 検査ツール API
   │  (端末の localStorage にのみ保存。SharePoint には保存しない)
   │
   │  POST http://127.0.0.1:18120/mikke/issues
   │  body: { …, "apiBase": "https://…", "apiKey": "…" }
   ▼
[mikke-relay.ps1]  ★対応済み。受け取ってアダプタへ渡すだけ（保存しない・ログに出さない）
   │  Invoke-MikkeScannerFetch -IssueInstanceId <ID> -ApiBase <URL> -ApiKey <KEY>
   ▼
[mikke-scanner-adapter.ps1]  ★今回直すファイル
   ▼
[検査ツール API]
```

## 3. 変更内容（3 つの関数すべて）

引数を 2 つ足し、**引数を優先して、無ければ従来どおり環境変数を見る**。

```powershell
function Invoke-MikkeScannerFetch {
    param(
        [Parameter(Mandatory = $true)][string]$IssueInstanceId,
        [string]$ApiBase,     # ← 追加（Mandatory を付けないこと）
        [string]$ApiKey       # ← 追加
    )
    # 引数を優先し、無ければ環境変数（後方互換）
    if (-not $ApiBase) { $ApiBase = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_BASE') }
    if (-not $ApiKey)  { $ApiKey  = [Environment]::GetEnvironmentVariable('MIKKE_SCANNER_API_KEY') }
    if (-not $ApiBase) { throw '検査ツール API のベース URL が指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }
    if (-not $ApiKey)  { throw '検査ツール API のキーが指定されていません (Mikke の 設定 → 個人設定 → 検査ツール API で設定してください)' }

    # 以降は $ApiBase / $ApiKey を使って API を呼ぶ（既存の実装のまま）
}
```

同じ形で次の 2 つにも足す:

- `Invoke-MikkeScannerIssueReport -IssueInstanceId <id> -ApiBase <url> -ApiKey <key>`
- `Invoke-MikkeScannerDownload -Types <string[]> -ApiBase <url> -ApiKey <key>`

**未設定時のエラーメッセージは上記の文言にすること。** ブラウザにそのまま出るので、
利用者が「どこで設定するか」を読み取れる必要がある。

## 4. 守ってほしい条件

- **`Write-Host` / ログに `$ApiKey` を出さない。** リクエストや応答をまるごと出力しない。
- **ファイルに保存しない。** トークンのキャッシュをファイルに書かない（並列実行で競合する）。
- **`$script:` / グローバル変数に入れない。** 最大 5 本が同時に別 runspace で走るため、
  別の呼び出しの値と混ざる。**関数のローカル変数だけで完結させる。**
- **エラーメッセージに含めない。** API の応答本文をそのまま `throw` している箇所があれば、
  キーが混ざらないか確認する。

## 5. 動作確認の手順

1. `mikke-relay.env` から `MIKKE_SCANNER_API_BASE` / `MIKKE_SCANNER_API_KEY` を**消す**。relay を再起動する。
2. Mikke の 設定 → 個人設定 → 接続 → 検査ツール API に、ベース URL と API キーを入力して保存する。
3. 管理対象一覧で 1 件選び「情報更新(選択・固定)」を実行する。
   - **期待**: 従来どおり更新される。
4. 手順 2 の設定を空にして保存し、もう一度実行する。
   - **期待**: 「検査ツール API のベース URL が指定されていません (Mikke の 設定 → …)」が画面に出る。
5. relay のコンソール出力に **API キーが 1 文字も出ていない**ことを確認する。
6. 後方互換の確認: 手順 2 を空のままにして `mikke-relay.env` に環境変数を書き、relay を再起動 →
   従来どおり動くこと。

単体で確かめる場合（relay を通さない）:

```powershell
. .\mikke-scanner-adapter.ps1
Invoke-MikkeScannerFetch -IssueInstanceId 'IID-1' -ApiBase 'https://<host>' -ApiKey '<key>'
```

## 6. 補足

- ブラウザ → relay は `http://127.0.0.1` の同一端末内通信なので、キーが外部へ出ることはない。
- 中継サーバ側は **v1.0.28 で対応済み**（4 エンドポイントで受け取り、並列実行の runspace へも
  引数で渡している）。自動更新で配られるので、こちらで何かする必要はない。
- **急がなくてよい。** 中継サーバは、アダプタが `-ApiBase` / `-ApiKey` を**宣言しているときだけ**
  渡す作りにしてある（PowerShell は宣言の無いパラメータを渡すとエラーになるため、
  関数の定義を見て判定している）。**アダプタが古いままでも従来どおり環境変数で動く。**
  この変更を入れた時点から、ブラウザ側の設定が効くようになる。
