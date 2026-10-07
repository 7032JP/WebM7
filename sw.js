// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// WebM7 Service Worker — PWA オフライン対応 (GitHub Pages 単体動作)
//   全パス相対。SW の置かれたディレクトリがスコープになるため、project pages の
//   サブパス公開でも独自ドメインのルート公開でも同じく動く。
//   オフライン起動に必要な資源をキャッシュし、取得できないときはキャッシュで応答する。
// =============================================================================
const CACHE = 'webm7-20261007201858';

// 同じオリジンに複数の WebM7 が置かれても衝突しないよう、配置先ごとにキャッシュを管理する。
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
  // UI テクスチャ（自前生成の御影石風タイル — AV40SX スキンの前面パネル用）
  './assets/granite.png',
  // 実行時に取得する主なドキュメント
  './CHANGELOG.md',
  './docs/Tape_Manual.md',
  './docs/Tutorial.md',
  './docs/Keyboard_Manual.md',
  './docs/Headless_Test_Manual.md',
  // 同梱互換 ROM セット (assets/altroms/)。
  // 条件は同梱の LICENSE / LICENSE-MIT.md / LICENSE-FONT.md / docs/LEGAL.md を参照。
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
  // オフラインでたどれるようにする (LICENSE と同じ扱い。計 40KB 程度)
  './assets/altroms/LICENSE',
  './assets/altroms/LICENSE-MIT.md',
  './assets/altroms/LICENSE-FONT.md',
  './assets/altroms/docs/LEGAL.md',
  // docs/images/*.svg は閲覧時にキャッシュする
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // 取得できた資源だけをキャッシュする
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

// 古いキャッシュを整理する。消すのは、同じスコープの古いバージョンと、このスコープに
// 属すると判断できる旧形式のキャッシュだけ (見分けられなければ残す)。
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

// ローカル環境ではネット優先 (network-first) とする。
const DEV = self.location.hostname === 'localhost'
         || self.location.hostname === '127.0.0.1'
         || self.location.hostname === '';

// バージョンごとに必ず最新を配りたい資源 (エンジンと同梱 ROM)。
const FRESH_RE = /\/(?:core\/[^/]+\.js|assets\/altroms\/(?:docs\/)?[^/]+)$/;

function isFreshTarget(req) {
  try {
    const u = new URL(req.url);
    return u.origin === self.location.origin && FRESH_RE.test(u.pathname);
  } catch (err) { return false; }
}

// キャッシュ用に正規化した URL。
function baseUrl(req) {
  const u = new URL(req.url);
  u.search = '';
  u.hash = '';
  return u.href;
}

// オフライン時の取りこぼしを防ぐためのキャッシュ検索。
function cacheLookup(req) {
  return caches.match(req).then((hit) => hit || caches.match(req, { ignoreSearch: true }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // ローカル環境: ネット優先 (取れなければキャッシュ)。
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
        // 取得に失敗したときはキャッシュを利用し、無ければその応答を返す。
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
