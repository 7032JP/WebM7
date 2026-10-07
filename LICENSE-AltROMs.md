# 同梱の互換 ROM セットのライセンス（MIT License）

| 項目 | 内容 |
| --- | --- |
| 上流の名前 | [7032 Alternative ROMs](https://github.com/7032JP/7032AltROMs/tree/v1.0.8) |
| 作者 | Naomitsu Tsugiiwa |
| バージョン | v1.0.8 |
| ライセンス | MIT License（原文は [`assets/altroms/LICENSE`](assets/altroms/LICENSE)。適用範囲は [`assets/altroms/LICENSE-MIT.md`](assets/altroms/LICENSE-MIT.md)） |
| 本プロジェクトでの範囲 | `assets/altroms/` 配下の ROM イメージと、互換 ROM セットの権利表示文書・ハッシュ一覧（`README.md` は本プロジェクトの文書） |
| 改変の有無 | なし |

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

ROM 本体と併せて、次の文書を `assets/altroms/` に同梱しています。`LICENSE`・
`LICENSE-MIT.md`・`LICENSE-FONT.md`・`SHA256SUMS` は互換 ROM セットのものをそのまま、
`README.md` は本プロジェクトが添えた説明です。互換 ROM セットの `docs/LEGAL.md` も、
`assets/altroms/docs/LEGAL.md` にそのまま同梱しています。

- `LICENSE` — 互換 ROM セットの MIT License
- `LICENSE-MIT.md` — MIT License の適用範囲（ROM のソースとバイナリ、独自字形など）
- `LICENSE-FONT.md` — 漢字フォント素材の由来（素材名・バージョン・作者・取得元・改変内容）、
  MIT License との区分、および原ライセンス文の写し
- `docs/LEGAL.md` — 利用条件・免責・来歴と、漢字系 ROM の字形の区分の詳細
- `SHA256SUMS` — ROM 本体と権利表示文書の検証用ハッシュ
- `README.md` — 互換 ROM セットの説明

## 改変について

互換 ROM セットは改変せずに同梱しています。
`(cd assets/altroms && sha256sum -c SHA256SUMS)` でいつでも検証できます。

## 相対パスの注記

`assets/altroms/LICENSE`・`assets/altroms/LICENSE-MIT.md`・
`assets/altroms/LICENSE-FONT.md`・`assets/altroms/docs/LEGAL.md` に現れる相対パス
（`fonts/`、`roms/`、`scripts/`、`src/`、`docs/` 等）は、互換 ROM セット側の配布物
（ソース一式）内のパスであり、本プロジェクトのパスではありません。ただし `docs/LEGAL.md` と、
`docs/LEGAL.md` から見た `../LICENSE`・`../LICENSE-MIT.md`・`../LICENSE-FONT.md` は、
`assets/altroms/` の中でそのまま辿れます。
`docs/LEGAL.md` から見た `../README.md`（申告窓口など）は、`assets/altroms/README.md` ではなく配布元の [README](https://github.com/7032JP/7032AltROMs/blob/v1.0.8/README.md) を指します。

これらの文書中の「本リポジトリ」「本プロジェクト」「this repository / this project」は互換 ROM セット側の配布物を指し、
本プロジェクト（WebM7）全体を指すものではありません。
