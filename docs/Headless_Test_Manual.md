# WebM7 ヘッドレステスト マニュアル

WebM7 のシミュレータコアは、ブラウザなしで **Node.js から直接** 動かせます。コア（`core/` のエンジン部）はブラウザの API（`document` / `window` / Web Audio / Canvas）を一切参照しないので、スタブを用意することなく CPU・メモリ・FDC・キーボード・表示ロジックをそのまま実行できます。

この仕組みを使うと、次のような自動テストが書けます。

- ディスクや BASIC プログラムを起動し、一定フレーム後の状態（CPU レジスタ・メモリ・VRAM）を検査する
- 任意のフレームの画面を画像（PPM）として書き出し、表示結果を目視・差分比較する
- キー入力を流し込んで操作を再現し、期待した動作になるか確かめる

本書は、その書き方とコア API をまとめたものです。本書だけで完結するように書いてありますので、上から順に読めばそのまま動かせます。

---

## 1. ヘッドレスとは

「ヘッドレス（headless）」とは、**画面（head）なしでプログラムを動かすこと**です。WebM7 は本来ブラウザで動くシミュレータですが、その心臓部であるシミュレータコア（`core/`）は「画面に絵を出す」「音を鳴らす」部分と切り離して作られています。そのため、ブラウザの代わりに Node.js でコアだけを動かす、ということができます。

![図: ブラウザ実行とヘッドレス実行の対比](images/headless_01_browser_vs_headless.svg)

入力と出力をブラウザからテストスクリプトに置き換えるだけで、中で動くシミュレータ本体（`core/`）は同一です。

ヘッドレステストで、ブラウザと共通のコア処理を検証できます。ブラウザ固有の入出力はブラウザで確認してください（第10章参照）。

テスト 1 本の全体の流れは次のとおりです。本書の章立てもこの順番に対応しています。

![図: ヘッドレステスト 1 本の流れ](images/headless_02_test_flow.svg)

コアの読み込みから状態検査まで 7 ステップ。各ステップの詳細は右側に示した章で説明します。

---

## 2. 前提環境

- **Node.js**（ES Modules 対応バージョン。新しめの LTS を推奨）
- WebM7 のソース一式（`core/` ディレクトリ。エンジン部だけを読み込みます）
- 同梱の互換 ROM イメージ、またはご自身で用意した ROM イメージ（第4章）
- 必要に応じてディスクイメージ（`.d77` など）やテープイメージ（`.t77` / `.wav`）

WebM7 のコアは ES Modules (`import`) で書かれています。テストスクリプトの拡張子は **`.mjs`** とすれば、Node.js がそれを ES Module として実行します（`package.json` などの追加設定は不要です）。

---

## 3. セットアップ（clone からテスト実行まで）

### 3.1 リポジトリを clone する

```bash
git clone https://github.com/7032JP/WebM7.git
cd WebM7
```

clone 直後のディレクトリ構成は次のとおりです。シミュレータコア `core/` がそのまま含まれており、これがヘッドレステストの実行対象になります。

```
WebM7/
├── core/                  ← 共有エンジン（テストはここを読み込む）
│   ├── index.js           公開 API の窓口（FM7 / 機種定数を再エクスポート）
│   ├── fm7.js             システム統合クラス（メモリマップ・I/O・スケジューラ連携）
│   ├── cpu6809.js         MC6809 CPU
│   ├── scheduler.js       タイミング制御（デュアル CPU 同期）
│   ├── fdc.js             フロッピーディスクコントローラ（D77/2D/HFE）
│   ├── keyboard.js        キーボード入力
│   ├── display.js         画面描画（VRAM・パレット・ライン描画）
│   ├── cmt.js             カセットテープ（T77/WAV）
│   ├── …                  hfe.js / opn.js / psg.js（以上がエンジン部。ブラウザ API 非依存）
│   └── …                  fm7_browser.js / display_canvas.js / audio_output.js / softkbd.js /
│                          cgrom_glyph.js / fdd_sound.js / audio-worklet-processor.js
│                          （ブラウザ結合部。ヘッドレスでは読み込みません）
├── assets/
│   └── altroms/           同梱の互換 ROM セット（LICENSE / SHA256SUMS 等を含む）
├── css/                   スタイルシート
├── icons/                 PWA アイコン
├── docs/                  ドキュメント（本書を含む）
├── index.html             ブラウザのメイン画面・UI
├── manifest.webmanifest   PWA マニフェスト
├── sw.js                  サービスワーカー
├── CHANGELOG.md  LICENSE  LICENSE-*.md
```

> ヘッドレステストでは `core/` のエンジン部を読み込みます。ROM と必要なメディアイメージは第4章の手順で指定してください。テスト用のディレクトリやスクリプトは含まれていませんので、下記のとおり**ご自身で作成**します。

### 3.2 テスト用ディレクトリを作る

`core/` を相対パス `../core/` から読み込めるよう、リポジトリ直下に作業用ディレクトリ（例: `test/`）を作り、その中に `.mjs` を置きます。

```bash
mkdir test
# test/your_test.mjs を作成（中身は第6章の最小サンプルを参照）
```

```
WebM7/
├── core/
│   └── index.js …
└── test/                  ← 自分で作る
    └── your_test.mjs      ← ここにテストを書く（../core/ を読み込む）
```

スクリプト内では次のようにコアを読み込みます（公開窓口の `index.js` 経由が便利です）。

```javascript
const { FM7 } = await import('../core/index.js');
```

### 3.3 実行する

リポジトリルート（`WebM7/`）から実行します。

```bash
node test/your_test.mjs
# もしくは
cd test && node your_test.mjs
```

> ディスクイメージは clone した中には含まれません。ROM は独立実装の互換 ROM セットが `assets/altroms/` に同梱されています（漢字系 ROM を含む。第4章参照）。パスはスクリプト内で各自の環境に合わせて指定します。

---

## 4. ROM の用意

シミュレータの起動には ROM イメージが必要です。WebM7 には独立実装の互換 ROM セット（MIT License）を `assets/altroms/` に同梱しており、漢字系 ROM（漢字 ROM `kanji.rom` / `kanji2.rom`・辞書 ROM `dicrom.rom`）を含む基本 ROM はそのまま使えます。純正 ROM は同梱・配信しません。**互換 ROM セットに含まれない ROM を使う場合は、ご自身で適法に用意し、任意のフォルダに置いてください。**テストスクリプトでは、そのフォルダを定数にして読み込みます。漢字系 ROM の字形の条件は `LICENSE-Shinonome.md` を参照してください。

必要な ROM は機種により異なります。読み込みメソッドと、本書のサンプルコードで使う**ファイル名の例**は次のとおりです（ファイル名は各自の ROM に合わせてください。同梱互換 ROM の BASIC は `7tbasic3.rom` です）。

| 区分 | 読み込みメソッド | サンプルでの名前例 | サイズの目安 | 主な対象機種 |
|---|---|---|---|---|
| BASIC ROM | `loadFBasicROM()` | `7tbasic3.rom`（同梱の 7T-BASIC） | 約 31KB | 全機種（常に必須。本体搭載 BASIC ROM に対応） |
| DOS ブート ROM | `loadBootROM()` | `boot_dos.rom` | 512 バイト | FM-7 系（Boot Mode: DOS で必須） |
| BASIC ブート ROM | `loadBootBasROM()` | `boot_bas.rom` | 512 バイト | FM-7 系（Boot Mode: BASIC で必須） |
| サブシステム ROM (Type-C) | `loadSubROM()` | `subsys_c.rom` | 約 10KB | 全機種（常に必須。サブ CPU 用） |
| イニシエータ ROM | `loadInitiateROM()` | `initiate.rom` | 8KB | FM77AV 系（起動に必須） |
| サブシステム ROM (Type-A) | `loadSubROM_A()` | `subsys_a.rom` | 8KB | FM77AV 系 |
| サブシステム ROM (Type-B) | `loadSubROM_B()` | `subsys_b.rom` | 8KB | FM77AV 系 |
| CG ROM | `loadCGROM()` | `subsyscg.rom` | 最大 8KB | FM77AV 系（必須） |
| 漢字 ROM（第1水準） | `loadKanjiROM()` | `kanji.rom` | 128KB | FM-7 では任意（漢字表示用）、FM77AV 以降は必須 |
| 漢字 ROM（第2水準） | `loadKanji2ROM()` | `kanji2.rom` | 128KB | FM77AV40EX/SX（必須） |
| 辞書 ROM | `loadDicromROM()` | `dicrom.rom` | 256KB | FM77AV40EX/SX（必須） |
| 拡張サブ ROM | `loadExtSubROM()` | `extsub.rom` | 48KB | FM77AV40EX（必須） |

機種ごとに読み込むべき ROM の目安は次のとおりです（ブラウザ WebM7 本体の必須／任意の区分と同じです）。

- **FM-7** … BASIC ROM＋サブシステム Type-C＋Boot Mode に対応するブート ROM（BASIC なら BASIC ブート ROM、DOS なら DOS ブート ROM）が必須です。
- **FM77AV / FM77AV20 / FM77AV20EX / FM77AV40 / FM77AV40EX/SX** … BASIC ROM・サブシステム Type-C に加えてイニシエータ ROM・サブシステム Type-A / Type-B・CG ROM・漢字 ROM（第1水準）が必須です（ブート ROM（DOS / BASIC）は不要です）。
- **FM77AV40EX/SX** … さらに漢字 ROM（第2水準）・辞書 ROM・拡張サブ ROM が必須です。

![図: 機種と必要 ROM のマトリクス](images/headless_03_rom_matrix.svg)

機種ごとの必須 ROM・任意 ROM を色分けしたマトリクスです。緑がその機種で必ず読み込むもの（ブート ROM は選択した Boot Mode に対応する方）、橙は用途に応じて読み込むものです。

> ヘッドレス実行でも、選択した機種と起動モードに対応する ROM 一式を読み込んでください。

> ROM 読み込みメソッドはいずれも `ArrayBuffer`（または `Uint8Array.buffer`）を引数に取ります。`readFileSync()` で読んだバッファをそのまま渡せます。

### 4.1 素材の置き場所

ROM やディスクイメージの置き場所は、スクリプトに絶対パスで書き込まず、環境変数などで指定できるようにしておくと、環境が変わってもテストを書き換えずに済みます（第6章のサンプルの `WEBM7_ROM_DIR` を参照）。

---

## 5. ブラウザ API スタブは不要

コアのエンジン部はブラウザのグローバル（`document` / `window` / `AudioContext` / `requestAnimationFrame` 等）を参照しません。画面への描画や音の出力は `core/fm7_browser.js` などのブラウザ結合部が受け持ち、ヘッドレスではそれらを読み込まないため、**スタブを置く前処理は不要**です。`import` 文をファイル先頭に書いて構いません。

```javascript
import { FM7 } from '../core/index.js';
```

---

## 6. 最小サンプル

FM-7 として起動し、フレームを回して BASIC のプロンプトまで進め、CPU の状態を表示する最小例です。このまま写して動かせます（ROM のパスとファイル名だけ各自の環境に合わせてください）。

```javascript
#!/usr/bin/env node
import { readFileSync } from 'fs';

// --- 1) コア読み込み（公開窓口の index.js 経由。スタブは不要） ---
import { FM7 } from '../core/index.js';

// --- 3) ROM フォルダ（各自のパスに置き換える） ---
const ROM_DIR = process.env.WEBM7_ROM_DIR || './roms';
const rom = (name) => new Uint8Array(readFileSync(`${ROM_DIR}/${name}`));

// --- 4) インスタンス生成・ROM 読み込み・機種設定 ---
const fm7 = new FM7();
fm7.loadFBasicROM(rom('7tbasic3.rom'));   // ファイル名は各自の用意したものに合わせる
fm7.loadBootROM(rom('boot_dos.rom'));
fm7.loadBootBasROM(rom('boot_bas.rom'));
fm7.loadSubROM(rom('subsys_c.rom'));
fm7.setMachineType('fm7');                // 'fm7' | 'fm77av' | 'fm77av40' | 'fm77av40ex'

// --- 5) ディスク挿入（任意。ディスクなしなら ROM BASIC が起動します） ---
// const disk = readFileSync('./disk.d77');
// fm7.fdc.loadDisk(0, new Uint8Array(disk).buffer);   // ドライブ 0 に挿入

// --- 6) リセットして起動 ---
fm7.reset();

// --- 7) 1 フレーム = 16667 マイクロ秒（60Hz）。600 フレーム実行して起動を待つ ---
const FRAME_US = 16667;
const runFrames = (n) => { for (let i = 0; i < n; i++) fm7.scheduler.exec(FRAME_US); };
runFrames(600);

// --- 8) キー入力を流し込む（BASIC のプロンプト到達後） ---
fm7.keyboard.queueText('PRINT 123\n');
while (fm7.keyboard.autoTypePending) runFrames(1);
runFrames(60);   // 最後のキーが処理されるまで少し余分に回す

// --- 9) 状態を表示 ---
console.log(`Main PC = $${fm7.mainCPU.pc.toString(16)}`);
console.log(`Sub  PC = $${fm7.subCPU.pc.toString(16)}`);
```

> `ROM_DIR` とファイル名は、ご自身が用意した ROM の置き場所・名前に合わせて書き換えてください。本書はサンプルとして汎用的なパス・名前を示しています。

---

## 7. コア API リファレンス

### 7.1 生成・リセット

```javascript
const fm7 = new FM7();
fm7.setMachineType('fm77av');   // 機種を設定（ROM 読み込み後・reset 前に）
fm7.reset();                    // 全システムリセット。ブート経路を機種・メディアから自動判定
```

機種定数（`core/index.js` から re-export）:

| 文字列 | 機種 |
|---|---|
| `'fm7'` | FM-7 |
| `'fm77av'` | FM77AV |
| `'fm77av40'` | FM77AV40 |
| `'fm77av40ex'` | FM77AV40EX |

#### 7.1.1 起動経路の指定（ブートモード）

`reset()` が選ぶ起動経路は、機種と **ブートモード**（`'basic'` / `'dos'`）で決まります。ブラウザで機種別ハードウェアパネル（DIP スイッチ / BOOT ボタン / BASIC・DOS ボタン）から選ぶ起動モードに相当する設定は、ヘッドレスでは次のフィールドで行います（`reset()` の**前**に設定）。

```javascript
fm7._bootModeOverride = 'basic';   // 'basic' または 'dos'
fm7._bootModeExplicit = true;      // 明示選択（FM77AV 系でもこの値を優先させる）
fm7.reset();
```

| 機種 | ブートモード | 起動経路 |
|---|---|---|
| FM-7 | `'basic'` | BASIC ブート ROM（`loadBootBasROM()`）を実行します。 |
| FM-7 | `'dos'` | DOS ブート ROM（`loadBootROM()`）を実行します。 |
| FM77AV 系 | どちらでも | イニシエータ ROM（`loadInitiateROM()`）を実行します。`_bootModeExplicit` を `true` にしない場合は、ドライブ 0 にディスクがあれば `'dos'`、無ければ `'basic'` として扱われます。 |

FM-7 では選択するモードのブート ROM、FM77AV 系ではイニシエータ ROM を読み込んでおきます。選択した機種に合う ROM を指定してください。

### 7.2 実行（時間を進める）

スケジューラにマイクロ秒を渡して、その分だけエミュレーションを進めます。

```javascript
fm7.scheduler.exec(16667);   // 約 1 フレーム（60Hz = 16,667 マイクロ秒）進める
fm7.scheduler.step();        // メイン CPU を 1 命令だけ実行（戻り値 = 消費サイクル数）
```

FM-7 系はメイン CPU とサブ CPU の 2 つの MC6809 を持つデュアル CPU 構成です。スケジューラが両者の同期を保ちながら進めるため、テスト側は `exec()` を呼ぶだけでかまいません。

![図: 2 つの CPU とスケジューラの関係](images/headless_05_dual_cpu_scheduler.svg)

`exec(16667)` を 1 回呼ぶと、メイン CPU とサブ CPU の両方がそろって 1 フレーム（16,667 マイクロ秒 = 60Hz）ぶん進みます。

複数フレームを回すヘルパー例:

```javascript
const runFrames = (n) => { for (let i = 0; i < n; i++) fm7.scheduler.exec(16667); };
runFrames(300);
```

![図: フレーム実行ループのタイミングチャート](images/headless_06_frame_loop_timing.svg)

`exec(16667)` を繰り返すほど実機時間が進みます。60 フレームで実機 1 秒、300 フレームで実機 5 秒ぶんです。

### 7.3 ディスク

```javascript
fm7.fdc.loadDisk(driveNum, arrayBuffer);   // driveNum: 0〜3、D77/2D/HFE を自動判別
fm7.fdc.selectDisk(driveNum, diskIdx);     // 連結された複数ディスクから選択
```

`loadDisk` には `ArrayBuffer` を渡します（`new Uint8Array(buf).buffer`）。

![図: ディスク挿入と FDC](images/headless_07_disk_fdc.svg)

`loadDisk` で渡したイメージは形式（D77 / 2D / HFE）が自動判別されて指定ドライブに入ります。複数枚を連結した D77 では `selectDisk` で挿入中の 1 枚を切り替えます。

### 7.4 キー入力

**(a) テキスト自動入力 `queueText`（推奨）**

```javascript
fm7.keyboard.queueText('LOAD"PROG"\n', { charGap: 2, lineGap: 12 });
```

- `\n` は RETURN として扱われます
- `charGap` … 通常キー間の間隔（フレーム数。既定 2）
- `lineGap` … RETURN 後の間隔（フレーム数。既定 12。BASIC が前の行を処理する時間を確保します）

`queueText` はキューに文字を積みます。送出はスケジューラが自動で行います。コア内部で、エミュレーション時間が 1 フレームぶん（16,667 マイクロ秒）進むごとにオートタイプが 1 回進むよう配線されているため、**テスト側は `scheduler.exec()` でフレームを回し続けるだけ**でキーが順に送られます。

![図: queueText 自動送出のタイミングチャート](images/headless_08_queuetext_timing.svg)

キューに積んだキーは、スケジューラが毎フレーム自動で進めるオートタイプにより `charGap`（既定 2 フレーム）間隔で送出され、RETURN の後だけ `lineGap`（既定 12 フレーム）待ちます。手動の tick は不要です。

送出が終わったかどうかは `autoTypePending` で確認できます。

```javascript
fm7.keyboard.queueText('FILES\n');
while (fm7.keyboard.autoTypePending) fm7.scheduler.exec(16667);
runFrames(60);   // 最後のキーが BASIC に処理されるまで少し余分に回す
```

- `autoTypePending` … 送出待ちのキーが残っていれば真
- `clearAutoType()` … 送出待ちのキューを破棄する
- `autoTypeTick(elapsedUs)` … オートタイプを手動で進める低レベルメソッド。スケジューラが自動で呼ぶため通常は不要です（追加で呼ぶと送出ペースがその分速まります）

なお、オートタイプは「前のキーが消費されてから次を送る」自動ペース制御つきです。それでも、起動直後など**入力受付前に送ると取りこぼす**ことがあるため、BASIC の `OK`（Ready）プロンプト到達を待ってから送ってください（先にフレームを十分回しておきます）。

**(b) 単発キーコード送出 `_pushKey`（低レベル API・上級者向け）**

```javascript
fm7.keyboard._pushKey(0x0D);   // RETURN（カーソルキーやファンクションキー等の単発送出に）
```

`_pushKey` はハードウェアのキーバッファへ **FM-7 のキーコード** を 1 つ直接積みます。コードの解釈は現在のキーボードモード（FM-7 の ASCII モード / FM77AV 系のスキャンコードモード）に依存し、スキャンコードモードではビット 7 を立てるとブレイク（離す）コードになります。送出ペースの調整や BASIC 側の受付待ちは一切行われないため、**文字列やコマンドの入力には向きません**。通常のテキスト入力には `queueText` を使ってください。

### 7.5 ジョイスティック入力

ジョイスティックは通常ブラウザの Gamepad API から読み取られ、そのポーリングは描画ループの中でだけ動きます。ヘッドレスでは描画ループが回らないためポーリングも走りません。そこで、プログラムから方向・トリガを直接与えるための公開 API を使います。

**(a) 状態の設定 `setJoystickState`（推奨）**

```javascript
// 名前付きで指定（押しているものだけ true。省略したものは離した扱い）
fm7.setJoystickState(0, { right: true, trigger1: true });   // ポート1: 右＋トリガ1

// 生バイト（active-low: 0xFF＝全解放）でも指定可
fm7.setJoystickState(0, 0xF7);   // bit3(右)だけ 0 ＝右
```

- 第1引数 … FM ポート（`0`＝ジョイスティック1、`1`＝ジョイスティック2）
- 第2引数 … 次のフィールドを持つオブジェクト、または active-low の生バイト

| フィールド | ビット | 生バイト（そのボタンだけ押下時） |
|---|---|---|
| `up` | bit0 | `0xFE` |
| `down` | bit1 | `0xFD` |
| `left` | bit2 | `0xFB` |
| `right` | bit3 | `0xF7` |
| `trigger1` | bit4 | `0xEF` |
| `trigger2` | bit5 | `0xDF` |

押している状態は次に変更するまで保持されます（描画ループが無いため上書きされません）。設定値は OPN のポート（`$FD15`／`$FD16`）経由でプログラムから読み戻されます。

**(b) 解放 `clearJoystickState`**

```javascript
fm7.clearJoystickState(0);   // ポート1を全解放（0xFF）へ
fm7.clearJoystickState();    // 引数省略で両ポートを解放
```

入力を与えたら、対象プログラムが読み取れるよう `scheduler.exec()` でフレームを進めてください。押しっぱなし・離しの表現は、設定→数フレーム実行→解放、の順で書けます。

```javascript
fm7.setJoystickState(0, { trigger1: true });   // 押す
runFrames(3);                                  // 数フレーム保持
fm7.clearJoystickState(0);                      // 離す
runFrames(3);
```

### 7.6 状態の参照（検査用）

| プロパティ | 内容 |
|---|---|
| `fm7.mainCPU.pc` | メイン CPU プログラムカウンタ |
| `fm7.subCPU.pc` | サブ CPU プログラムカウンタ |
| `fm7.mainRAM` | メイン RAM（`Uint8Array`） |
| `fm7.display.vram` | VRAM（`Uint8Array`） |
| `fm7.display.displayMode` | 表示モード |
| `fm7.display.crtOn` | CRT 出力の有効フラグ |
| `fm7.scheduler.mainCyclesTotal` | 実行済みメイン CPU サイクル総数 |

![図: 状態検査の見取り図](images/headless_09_state_inspection.svg)

`fm7` インスタンスの中の CPU・メモリ・VRAM などを、テストスクリプトから普通のプロパティとして直接読めます。

メモリやレジスタ、VRAM を直接読めるので、「指定フレーム後に特定アドレスが期待値か」「PC が想定ルーチンに入ったか」といった検査が書けます。

---

## 8. 画面のキャプチャ（PPM 出力）

`display.render()` は画面を RGBA のフレームバッファへ描きます。ブラウザではこのフレームが Canvas の `ImageData` に直結していますが、ヘッドレスではコアが自前で持つメモリ上のフレーム（`display.frame`）に描かれるので、Canvas のシムを用意する必要はありません。受け取った RGB を **PPM (P6)** として書き出すと、画像ビューア（ImageMagick・GIMP 等）で確認できます。

流れは次のとおりです。

![図: 画面キャプチャの流れ](images/headless_10_ppm_capture.svg)

`render(true)` で全面を描画し、`display.frame` の `width` / `height` / `data`（RGBA、左上から順）を読み出して PPM (P6) に変換します。幅・高さは表示モード（640×200 / 640×400）に応じて `render()` が決めます。

```javascript
import { writeFileSync } from 'fs';

function savePPM(fm7, path) {
    fm7.display.render(true);                  // 引数 true = 強制再描画（全面）
    const img = fm7.display.frame;             // { width, height, data: Uint8ClampedArray (RGBA) }
    const W = img.width, H = img.height;       // サイズは frame から取るのが確実
    const header = `P6\n${W} ${H}\n255\n`;
    const buf = Buffer.alloc(header.length + W * H * 3);
    buf.write(header, 0);
    let off = header.length;
    const data = img.data;
    for (let i = 0; i < W * H; i++) {
        buf[off++] = data[i * 4];      // R
        buf[off++] = data[i * 4 + 1];  // G
        buf[off++] = data[i * 4 + 2];  // B
    }
    writeFileSync(path, buf);
}

// 使用例
runFrames(180);
savePPM(fm7, './out/frame_180.ppm');
```

> 出力先は任意です。`test/out/` のように作業ディレクトリ内へまとめると整理しやすいです。PPM はそのままでも開けますが、`magick frame.ppm frame.png` などで PNG に変換すると扱いやすくなります。

書き出される PPM (P6) ファイルの中身は、次のような単純な構造です。

![図: PPM (P6) ファイルの構造](images/headless_11_ppm_format.svg)

テキストのヘッダ 3 行（形式 `P6`・幅と高さ・最大輝度値 255）の後に、1 ピクセル 3 バイトの RGB データが左上から順に並びます。

---

## 9. テープ（参考）

```javascript
fm7.cmt.loadT77(new Uint8Array(readFileSync('./tape.t77')).buffer);   // T77 形式
fm7.cmt.loadWAV(new Uint8Array(readFileSync('./tape.wav')).buffer);   // WAV 形式
```

その後 BASIC 側で `RUN"CAS:"` / `LOAD"CAS:"` / `LOADM"CAS:",,R` 等を `queueText` で送り、フレームを進めて読み込ませます。

> **既知の制約** … ヘッドレス実行ではテープ LOAD が完了しない場合があります。テープの動作確認はブラウザで行ってください。SAVE の自動テストは利用できます。

![図: テープ機能の制約](images/headless_12_tape_limitation.svg)

図は、テープ機能の確認方法をまとめたものです。

---

## 10. 既知の制約・注意点

- **ブラウザ結合部は読み込まない** … `core/index.js` が公開するのはエンジン部だけです。`fm7_browser.js` / `display_canvas.js` / `audio_output.js` / `softkbd.js` などはブラウザ専用で、Node.js から読み込むと `document` 等が無いため失敗します。
- **`setMachineType` → `reset` の順** … 機種を設定し ROM を読み込んでから `reset()` します。`reset()` がブート経路を機種・メディアから判定します。
- **テープの動作確認** … 制限と確認方法は第9章を参照してください。
- **オートタイプは受付開始を待ってから** … `queueText` 後はフレームを回し続ければ自動送出されますが、ROM ローダ実行中など入力受付前に送ると取りこぼすことがあります。`OK`（Ready）プロンプト到達を待ってから送ってください。
- **画面サイズは表示モードで変わる** … 幅・高さは `render()` 後に確定します。PPM 書き出しは `display.frame` の `width` / `height` を使ってください（第8章のサンプルはそうなっています）。
- **リセット後の NMI 受け付け開始条件** … MC6809 はリセット後、S をプログラムで設定するまで NMI を受け付けません。自作のコードを動かす場合は、リセット直後に `LDS #imm` で S を設定してください。

---

## 11. テストのひな型として

新しいテストを書くときは、本書の構成をそのままひな型にできます。

1. **第6章の最小サンプル**のセットアップ部（生成 → ROM 読み込み → `setMachineType` → `reset`）を流用する
2. 検証したい内容に応じて、**第7章の状態参照**（メモリ・レジスタ・VRAM）や**第8章の PPM 出力**を組み合わせる

セットアップは毎回ほぼ同じです。自分用の共通ヘルパー（例: `test/harness.mjs`）に切り出して `import` すると、各テストが短く書けます。

---

## まとめ

1. `core/index.js` から `FM7` を読み込む（スタブは不要）
2. `FM7` を生成し、ROM 読み込み → `setMachineType` → `reset`
3. `scheduler.exec(16667)` でフレームを進める
4. メモリ・レジスタ・VRAM を読んで検査、または `display.frame` から PPM 画像を書き出す
5. キー入力は `queueText` で積み、フレームを回して自動送出させる

これだけで、ブラウザを開かずに WebM7 の動作を自動検証できます。
