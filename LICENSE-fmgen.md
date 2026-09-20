# FM 音源の移植部のライセンス（fmgen）

| 項目 | 内容 |
| --- | --- |
| 上流の名前 | FM Sound Generator with OPN/OPM interface（"fmgen"） |
| 作者 | cisc |
| 著作権表示 | Copyright (C) by cisc 1998, 2003. |
| バージョン | 008（2003-09-02。同梱の原文 readme の変更点に記載の最終バージョン） |
| ライセンス文 | 原文は [`core/fmgen_readme.txt`](core/fmgen_readme.txt)（EUC-JP。上流の条件に従い、一切改変せずそのまま同梱） |
| 本プロジェクトでの範囲 | `core/opn.js` の FM 合成部 |
| 改変の有無 | あり（下記） |

## 適用範囲

`core/opn.js` の FM 合成部は fmgen の JavaScript への移植であり、本プロジェクトの
MIT License（[`LICENSE`](LICENSE)）の対象ではありません。この部分には上流の
fmgen の利用条件が適用されます。`core/opn.js` の先頭には
`SPDX-License-Identifier: LicenseRef-fmgen AND MIT` を記しています。

同じ `core/opn.js` に含まれる SSG 部と、それが用いる `core/psg.js` は
本プロジェクトの独自実装で、MIT License が適用されます。

## ライセンス文の要旨

原文（`core/fmgen_readme.txt`）の「著作権、免責規定」の要旨は次のとおりです。
正文は原文です。

- 由来（作者・著作権）を明記すること。
- 配布する際にはフリーソフトとすること。
- 改変したソースコードを配布する際は改変内容を明示すること。
- ソースコードを配布する際には原文の readme を一切改変せずそのまま添付すること。
- 商用ソフト（シェアウェアを含む）に組み込む際は、事前に作者の合意を得ること。
- 無保証であり、作者は損害について一切責任を負わない。

## 本プロジェクトでの改変内容

- C++ から JavaScript への翻訳。
- YM2203（OPN）の機能範囲への縮小。
- 本シミュレータの AudioWorklet 出力段への結合。

## 同梱について

上流の条件に従い、原文の readme を `core/fmgen_readme.txt` として、ソース
配布物（公開イメージ）にそのまま同梱しています。
