# サードパーティ ライセンス表記 (Third-Party Notices)

Mikke の配布物 (`dist/mikke.bundle.js`) には以下のオープンソースライブラリが同梱
されています。いずれも商用利用可能なパーミッシブライセンスです。各ライセンス全文は
それぞれの配布パッケージ (`node_modules/<name>/LICENSE`) を参照してください。

| ライブラリ | ライセンス | 著作権 |
|---|---|---|
| [DOMPurify](https://github.com/cure53/DOMPurify) | MPL-2.0 OR Apache-2.0 | © Cure53 and contributors |
| [@kenjiuno/msgreader](https://github.com/HiraokaHyperTools/msgreader) | Apache-2.0 | © HiraokaHyperTools / kenjiuno |
| [@kenjiuno/decompressrtf](https://github.com/HiraokaHyperTools/DeCompressRTF) | BSD-2-Clause | © 2019 kenjiuno |
| [iconv-lite](https://github.com/ashtuchkin/iconv-lite) | MIT | © 2011 Alexander Shtuchkin |

補足:
- iconv-lite は @kenjiuno/msgreader の依存ですが、ブラウザビルドでは `build.js` の
  esbuild alias により空スタブへ差し替えており、実バンドルには含まれません
  (念のため表記のみ掲載)。
- 上記いずれのライブラリにも Apache-2.0 §4(d) が要求する `NOTICE` ファイルは
  含まれていないため、追加の NOTICE 同梱義務はありません。保持義務は本ファイルの
  著作権・ライセンス表記のみです。
- ビルドツール (esbuild=MIT / TypeScript=Apache-2.0 / Vitest=MIT) は開発時のみ使用し、
  配布物には含まれません。
