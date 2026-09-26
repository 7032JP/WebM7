# 同梱の互換 ROM セットのライセンス（MIT License）

| 項目 | 内容 |
| --- | --- |
| 上流の名前 | [7032 Alternative ROMs](https://github.com/7032JP/7032AltROMs/tree/v1.0.3) |
| 作者 | Naomitsu Tsugiiwa |
| バージョン | v1.0.3（署名付きタグ）。同梱の `assets/altroms/SHA256SUMS` の ROM 行は同タグの `SHA256SUMS` と同じ値 |
| ライセンス | MIT License（原文は [`assets/altroms/LICENSE`](assets/altroms/LICENSE)。適用範囲は [`assets/altroms/LICENSE-MIT.md`](assets/altroms/LICENSE-MIT.md)） |
| 本プロジェクトでの範囲 | `assets/altroms/` 配下の ROM イメージと付属文書 |
| 改変の有無 | なし（取得時に SHA-256 で検証して同梱） |

## 適用範囲

`assets/altroms/` に同梱する互換 ROM セットは、本プロジェクトとは別に配布される
独立した著作物です。その条件は同梱の `assets/altroms/LICENSE` に記された
MIT License であり、本プロジェクトの [`LICENSE`](LICENSE) の MIT License とは
別のものです。

漢字系 ROM（`kanji.rom` / `kanji2.rom`）に含まれる第三者素材由来の字形は、
MIT License の対象外です。詳細は [`LICENSE-Shinonome.md`](LICENSE-Shinonome.md) を参照してください。
独自字形と変換処理の適用条件は、互換 ROM セットの
[`LICENSE-MIT.md`](assets/altroms/LICENSE-MIT.md) /
[`LICENSE-FONT.md`](assets/altroms/LICENSE-FONT.md) を参照してください。

## 同梱ファイル

ROM 本体と併せて、次の権利表示文書と検証用ハッシュを `assets/altroms/` に
そのまま同梱しています。

- `LICENSE` — 互換 ROM セットの MIT License（末尾に、成果物と第三者素材の
  どちらにどの文書が対応するかの案内表がある）
- `LICENSE-MIT.md` — MIT License の適用範囲（ROM のソースとバイナリ、独自字形など）
- `LICENSE-FONT.md` — 漢字フォント素材の由来（素材名・バージョン・作者・取得元・改変内容）、
  MIT License との区分、および原ライセンス文の写し
- `SHA256SUMS` — ROM 本体と権利表示文書の検証用ハッシュ
- `README.md` — 互換 ROM セットの説明

## 改変について

互換 ROM セットは改変せずに同梱しています。同梱時に SHA-256 で検証しており、
`(cd assets/altroms && sha256sum -c SHA256SUMS)` でいつでも再検証できます。

## 相対パスの注記

`assets/altroms/LICENSE`・`assets/altroms/LICENSE-MIT.md`・
`assets/altroms/LICENSE-FONT.md` に現れる相対パス（`fonts/`、`roms/`、`scripts/`、
`docs/` 等）は、互換 ROM セット側の配布物（ソース一式）内のパスであり、
本プロジェクトのパスではありません。

これらの文書中の「本リポジトリ」「this repository / this project」は互換 ROM セット側の配布物を指し、
本プロジェクト（WebM7）全体を指すものではありません。
