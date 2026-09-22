// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// WebM7 Service Worker — PWA オフライン対応 (GitHub Pages 単体動作)
//   全パス相対。SW の置かれたディレクトリがスコープになるため、project pages の
//   サブパス公開でも独自ドメインのルート公開でも同じく動く。
//   アプリシェル(HTML/エンジン/CSS/アイコン/必須md)を install 時にプリキャッシュし、
//   それ以外は cache-first + ネットワークフォールバックで応答。
//   ただしエンジン (core/*.js) と同梱 ROM (assets/altroms/*) だけは配備直後の
//   1 回目から新しいバージョンを配るためネット優先とし、取れなければキャッシュへ落とす
//   (オフライン起動は従来どおり成立する)。
// =============================================================================
const CACHE = 'webm7-20260922200629';

// 同じオリジンに複数の WebM7 が置かれても衝突しないよう、
// キャッシュ名にスコープを含めて区別する。
const CACHE_PREFIX = 'webm7-';
const SCOPE = self.registration.scope;
const CACHE_NAME = CACHE + '@' + SCOPE;

// 相対 URL でプリキャッシュ (SW スコープ基準で解決される)
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './css/softkbd.css',
  // エンジン (core/)
  './core/index.js',
  './core/fm7.js',
  './core/cpu6809.js',
  './core/scheduler.js',
  './core/fdc.js',
  './core/hfe.js',
  './core/cmt.js',
  './core/fdd_sound.js',
  './core/opn.js',
  './core/psg.js',
  './core/audio-worklet-processor.js',
  './core/keyboard.js',
  './core/cgrom_glyph.js',
  './core/display.js',
  './core/softkbd.js',
  // ブラウザ結合 (FM7Browser / Canvas / Web Audio 出力段)
  './core/fm7_browser.js',
  './core/guide_balloons.js',
  './core/display_canvas.js',
  './core/audio_output.js',
  // アイコン
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  // UI テクスチャ（自前生成の御影石風タイル — AV40SX スキン背景）
  './assets/granite.png',
  // 実行時に取得するドキュメント
  './CHANGELOG.md',
  './docs/Tape_Manual.md',
  './docs/Tutorial.md',
  './docs/Keyboard_Manual.md',
  './docs/Headless_Test_Manual.md',
  // 同梱互換 ROM セット (assets/altroms/)。
  // 条件は同梱の LICENSE / LICENSE-MIT.md / LICENSE-FONT.md を参照。
  './assets/altroms/7tbasic3.rom',
  './assets/altroms/boot_bas.rom',
  './assets/altroms/boot_dos.rom',
  './assets/altroms/subsys_c.rom',
  './assets/altroms/subsyscg.rom',
  './assets/altroms/subsys_a.rom',
  './assets/altroms/subsys_b.rom',
  './assets/altroms/initav1.rom',
  './assets/altroms/initbase.rom',
  './assets/altroms/initiate.rom',
  './assets/altroms/initex.rom',
  './assets/altroms/extsub.rom',
  './assets/altroms/kanji.rom',
  './assets/altroms/kanji2.rom',
  './assets/altroms/dicrom.rom',
  // ROM 本体の動作には不要だが、ROM を配る以上その権利表示も同じ配布物として
  // オフラインでたどれるようにする (LICENSE と同じ扱い。計 10KB 程度)
  './assets/altroms/LICENSE',
  './assets/altroms/LICENSE-MIT.md',
  './assets/altroms/LICENSE-FONT.md',
  // docs/images/*.svg は点数が多いためプリキャッシュせず実行時キャッシュに任せる
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // addAll は1つでも失敗すると全体が失敗するため、個別に best-effort で入れる
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

// 同じオリジンの他のキャッシュ (別のスコープの WebM7、他のページ) は消さない。
// 消すのは、同じスコープの古いバージョンと、スコープを名前に持たない旧形式のうち
// このスコープの資源を収めているものだけ (旧形式は別のスコープのバージョンかもしれない
// ため、中身で見分ける。見分けられなければ残す)。
function isOwnLegacyCache(name) {
  return caches.open(name)
    .then((c) => c.keys())
    .then((reqs) => reqs.some((r) => r.url.startsWith(SCOPE)))
    .catch(() => false);
}

function isObsoleteCache(name) {
  if (!name.startsWith(CACHE_PREFIX) || name === CACHE_NAME) return Promise.resolve(false);
  if (name.endsWith('@' + SCOPE)) return Promise.resolve(true);
  if (!name.includes('@')) return isOwnLegacyCache(name);
  return Promise.resolve(false);
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) =>
        isObsoleteCache(k).then((old) => (old ? caches.delete(k) : false)))))
      .then(() => self.clients.claim())
  );
});

// ローカル開発(localhost/127.0.0.1/file)では cache-first が古いファイルを
// 配信し続け開発を阻害するため、ネット優先(network-first)で常に最新を取得。
const DEV = self.location.hostname === 'localhost'
         || self.location.hostname === '127.0.0.1'
         || self.location.hostname === '';

// バージョンごとに必ず最新を配りたい資源 (エンジンと同梱 ROM)。
const FRESH_RE = /\/(?:core\/[^/]+\.js|assets\/altroms\/[^/]+)$/;

function isFreshTarget(req) {
  try {
    const u = new URL(req.url);
    return u.origin === self.location.origin && FRESH_RE.test(u.pathname);
  } catch (err) { return false; }
}

// バージョンのクエリ (?v=...) を落とした URL。プリキャッシュはクエリ無しで入るため、
// キャッシュの参照・格納はこの正規化した URL に揃える。
function baseUrl(req) {
  const u = new URL(req.url);
  u.search = '';
  u.hash = '';
  return u.href;
}

// バージョンのクエリの有無に関わらずキャッシュを引く (オフライン時の取りこぼし防止)。
function cacheLookup(req) {
  return caches.match(req).then((hit) => hit || caches.match(req, { ignoreSearch: true }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // 開発時: 常にネットから取得(取れなければキャッシュ)。古い資産を掴まない。
  if (DEV) {
    e.respondWith(fetch(req).catch(() => cacheLookup(req)));
    return;
  }

  // ページ遷移はキャッシュした index.html にフォールバック (オフライン起動)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // エンジンと同梱 ROM: ネット優先 → 失敗時はキャッシュ (オフライン起動を維持)。
  // 格納はクエリを落とした URL へ行い、プリキャッシュ分と二重持ちしない。
  if (isFreshTarget(req)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          if (res.type === 'basic') {
            const copy = res.clone();
            const key = baseUrl(req);
            caches.open(CACHE_NAME).then((c) => c.put(key, copy));
          }
          return res;
        }
        // 5xx 等でネットが正常に応答しないときはキャッシュを優先する。
        // 任意 ROM の 404 のようにキャッシュにも無い場合はその応答を返す。
        return cacheLookup(req).then((hit) => hit || res);
      }).catch(() => cacheLookup(req))
    );
    return;
  }

  // それ以外は cache-first → ネット取得しキャッシュへ
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => hit))
  );
});
