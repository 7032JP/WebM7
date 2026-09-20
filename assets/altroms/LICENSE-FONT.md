# Bundled font: provenance and license / 同梱するフォントの由来とライセンス

This file covers the one third-party material bundled in this repository:
the bitmap font in fonts/shinonome/. Everything else in the repository is
this project's own work under the MIT License (see LICENSE).

本ファイルは、本リポジトリが同梱する唯一の第三者素材である fonts/shinonome/
のビットマップフォントについて述べます。それ以外はすべて本プロジェクトの
成果物で、MIT License (LICENSE) の対象です。

--------------------------------------------------------------------------
1. Upstream / 上流

  Name        : Shinonome font family, 16-dot kanji gothic (shnmk16)
  Version     : 0.9.11
  Author      : Yasuyuki Furukawa
  Distributor : The Electronic Font Open Laboratory (/efont/)
  Source      : http://openlab.ring.gr.jp/efont/dist/shinonome/shinonome-0.9.11p1.tar.bz2
  License     : Public domain, as declared in the upstream LICENSE (copied in
                section 4). Because copyright cannot be abandoned under
                Japanese law, the declaration is made by the authors listed in
                the upstream AUTHORS stating that they will not exercise their
                rights. The license permits modification, conversion to other
                formats, embedding and redistribution, with no warranty.

  素材名      : 東雲フォントファミリー 16 ドット 漢字ゴシック体 (shnmk16)
  バージョン  : 0.9.11
  原作者      : 古川泰之 氏
  一次配布元  : The Electronic Font Open Laboratory (/efont/)
  取得元      : 上記 URL
  ライセンス  : パブリックドメイン。上流の LICENSE (第 4 節に写しを置く) が
                宣言するもので、日本では著作権の放棄が制度上できないため、
                上流の AUTHORS に列挙された作者が権利を行使しないと宣言する
                形を採っています。改造・他フォーマットへの変換・組込み・
                再配布が許され、無保証です。

--------------------------------------------------------------------------
2. What is bundled, and how / 同梱の形

  fonts/shinonome/shnmk16.bdf
      Modified BDF (CHARS 6772). From the upstream bdf/shnmk16.bdf
      (CHARS 6879) the CHAR records of 107 code positions in JIS X 0208
      rows 1-8 are removed; they are the characters the upstream AUTHORS
      lists as taken from the X11 jiskan16 font. The CHARS line is updated
      and a COMMENT describing the change is added to the header. The
      remaining glyph records are byte-for-byte as distributed upstream.
      The modification is done by scripts/strip_bdf_chars.py; how to
      reproduce the bundled BDF from the upstream archive is in
      docs/BUILD.md section 3.1.
  fonts/shinonome/LICENSE
      The upstream license text, byte-for-byte (EUC-JP).
  fonts/shinonome/LICENSE.utf8.txt
      The same text converted to UTF-8 for readability.
  fonts/shinonome/UPSTREAM_SHA256SUMS
      SHA-256 of the upstream archive and of the unmodified bdf/shnmk16.bdf
      (this project's own file).
  fonts/SHA256SUMS
      SHA-256 of the bundled BDF and license text (this project's own file).

  The upstream archive itself, the unmodified BDF, and the other fonts,
  sizes and scripts in the archive are not bundled.

  fonts/shinonome/shnmk16.bdf
      改変した BDF (CHARS 6772)。上流の bdf/shnmk16.bdf (CHARS 6879) から、
      JIS X 0208 の 1〜8 区の 107 符号位置の CHAR レコードを取り除いて
      あります。取り除いたのは、上流の AUTHORS が X11 の jiskan16 フォント
      から採ったと列挙する文字です。CHARS 行を更新し、ヘッダに改変内容を
      述べる COMMENT を入れています。残る字形レコードは上流のバイト列の
      ままです。改変は scripts/strip_bdf_chars.py が行い、上流のアーカイブ
      から同梱の BDF を再現する手順は docs/BUILD.md §3.1 にあります。
  fonts/shinonome/LICENSE
      上流のライセンス文 (バイト列のまま。文字コードは EUC-JP)。
  fonts/shinonome/LICENSE.utf8.txt
      同じ本文を可読性のために UTF-8 へ文字コード変換したもの。
  fonts/shinonome/UPSTREAM_SHA256SUMS
      上流のアーカイブと、改変前の bdf/shnmk16.bdf の SHA-256
      (本プロジェクトの文書)。
  fonts/SHA256SUMS
      同梱する BDF とライセンス文の SHA-256 (本プロジェクトの文書)。

  上流のアーカイブそのもの、改変前の BDF、アーカイブ中の他のフォント・
  サイズ・スクリプトは同梱していません。

--------------------------------------------------------------------------
3. Use in this project, and what is MIT / 用途と区分

  The bundled BDF is the glyph source of roms/kanji.rom and roms/kanji2.rom.
  The glyphs taken from it remain public domain; the MIT License does not
  apply to them. If you redistribute those two ROM images, please keep this
  file with them so that the origin of the glyphs is passed on.

  The following are this project's own work under the MIT License:
    - the independent replacement glyphs for the removed 107 code positions
      (scripts/kanji_glyph_overrides.py; the list of the code positions is
      in docs/LEGAL.md section 9.2),
    - the layout rule implementation and the conversion script that build
      the ROM images from the font (scripts/genkanji.py).

  What this project does with the font -- removing 107 code positions,
  converting the BDF into the ROM image format, embedding the glyphs, and
  redistributing the modified BDF and its products -- is within the
  permission the upstream license grants in writing.

  同梱の BDF は roms/kanji.rom と roms/kanji2.rom の字形 (グリフ) の入力
  です。そこから採った字形はパブリックドメインのままで、MIT License は
  適用されません。この 2 本の ROM イメージを再配布されるときは、字形の
  出所が伝わるよう本ファイルを添えてください。

  次のものは本プロジェクトの成果物で、MIT License の対象です。
    - 除去した 107 符号位置を補う独自字形 (scripts/kanji_glyph_overrides.py。
      符号位置の一覧は docs/LEGAL.md §9.2)
    - フォントから ROM イメージを組み上げる配置規則の実装と変換スクリプト
      (scripts/genkanji.py)

  本プロジェクトが本素材に対して行っているのは、107 符号位置の除去・BDF
  から ROM イメージ形式への変換・字形の組込み・改変した BDF とその生成物の
  再配布で、いずれも上流のライセンスが明文で認める範囲に含まれます。

--------------------------------------------------------------------------
4. Upstream license text / 上流のライセンス文
   (copy of fonts/shinonome/LICENSE.utf8.txt)

●東雲フォントライセンス
                                                                    2001
                                     The Electronic Font Open Laboratory
                                        http://openlab.ring.gr.jp/efont/

このアーカイブに含まれるすべてのフォントデータ、ドキュメント、スクリプ
ト類はすべて Public Domain で提供されています 。

但し、日本に於いては現時点で著作権を放棄することは法律上不可能であり、
AUTHORS に列挙されている作者がその権利を行使しないと宣言することで実質
的な Public Domain であるとします。

自由な改造、他フォーマットへの変換、組込み、再配布を行うことができます。
同時に、これらはすべて完全に無保証です。
