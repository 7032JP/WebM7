# 互換 ROM セット (assets/altroms)

このフォルダには、独立実装の互換 ROM セット 7032 Alternative ROMs v1.0.8（<https://github.com/7032JP/7032AltROMs/tree/v1.0.8>）を同梱しています。
互換 ROM セットは本プロジェクトとは別の配布物です。

## ライセンス

- 互換 ROM セット本体は **MIT License** です（同梱の `LICENSE`）。`LICENSE` の
  末尾には、どのファイルにどの条件が適用されるかの案内表があります。
- 互換 ROM セットの成果物（ROM 本体と、漢字系 ROM に含まれる独自字形）に適用される
  MIT License の適用範囲は、同梱の `LICENSE-MIT.md` に記されています。
- ただし**漢字系 ROM に含まれる第三者素材由来の字形は、上記 MIT License の対象ではありません。** 独自字形の条件は `LICENSE-MIT.md` を参照してください。素材名・バージョン・作者・入手先・変更内容と原ライセンス文は、同梱の `LICENSE-FONT.md` を参照してください。
- 利用条件・免責・来歴と、漢字系 ROM の字形の区分の詳細（独自字形の符号位置の一覧など）は、
  同梱の `docs/LEGAL.md` に記されています。`LICENSE` などが参照する `docs/LEGAL.md` は、
  配布元と同じ相対位置に同梱しているので、そのまま辿れます。
- `docs/LEGAL.md` から見た `../README.md`（申告窓口など）は、このファイルではなく配布元の README（<https://github.com/7032JP/7032AltROMs/blob/v1.0.8/README.md>）を指します。
- 同梱の `LICENSE` / `LICENSE-MIT.md` / `LICENSE-FONT.md` / `docs/LEGAL.md` に現れる
  それ以外の相対パス（`fonts/`・`roms/`・`scripts/`・`src/`、`docs/LEGAL.md` 以外の
  `docs/` の文書など）は**互換 ROM セット側の配布物（ソース一式）内のパス**です。このフォルダには
  ROM と権利表示文書、検証用のハッシュ一覧（と本説明）を置き、ソース一式は含みません。

## 検証

ROM 本体と権利表示文書 (LICENSE / LICENSE-MIT.md / LICENSE-FONT.md / docs/LEGAL.md) は次のコマンドで検証できます。

```bash
sha256sum -c SHA256SUMS
```
