# 互換 ROM セット (assets/altroms)

このフォルダには、独立実装の互換 ROM セット 7032 Alternative ROMs（https://github.com/7032JP/7032AltROMs/tree/v1.0.0、v1.0.0）を同梱しています。
互換 ROM セットは本プロジェクトとは別の配布物です。

## ライセンス

- 互換 ROM セット本体は **MIT License** です（同梱の `LICENSE`）。`LICENSE` の
  末尾には、どのファイルにどの条件が適用されるかの案内表があります。
- 互換 ROM セットの成果物（ROM 本体と、漢字系 ROM に含まれる独自字形）に適用される
  MIT License の適用範囲は、同梱の `LICENSE-MIT.md` に記されています。
- ただし**漢字系 ROM（`kanji.rom` / `kanji2.rom`）の字形は第三者素材に由来し、上記 MIT License の対象ではありません。** 素材名・バージョン・作者・入手先・変更内容と原ライセンス文は、同梱の `LICENSE-FONT.md` を参照してください。
- 同梱の `LICENSE` / `LICENSE-MIT.md` / `LICENSE-FONT.md` に現れる相対パス
  （`fonts/`・`roms/`・`docs/`・`scripts/` など）は**互換 ROM セット側の配布物
  （ソース一式）内のパス**です。このフォルダには ROM と権利表示文書のみを
  置いています。

## 検証

ROM 本体と権利表示文書 (LICENSE / LICENSE-MIT.md / LICENSE-FONT.md) は次のコマンドで検証できます。

```bash
sha256sum -c SHA256SUMS
```
