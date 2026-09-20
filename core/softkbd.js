// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * FM-7 Virtual (Software) Keyboard for mobile/tablet.
 *
 * Uses the exact same layout as the PC Keyboard debug panel
 * (FM7_KBD_LAYOUT: 20-column grid with main keys + numpad).
 * Keytop glyph rendering matches the Keyboard panel exactly:
 * composite 4-corner CG ROM glyphs that update on modifier changes.
 */

import { GRPH_OVERRIDE, KANA_OVERRIDE } from './keyboard.js';
import { getCGKeyCompositeDataURL } from './cgrom_glyph.js';

const BREAK_CODE = '_BREAK_';

// --- Typewriter key glyph tables (same as Keyboard panel in index.html) ---

const TYPEWRITER_CODES = new Set([
    'Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0',
    'Minus','Equal','Backslash',
    'KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP',
    'BracketLeft',
    'KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL',
    'Semicolon','Quote','IntlBackslash',
    'KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM',
    'Comma','Period','Slash','IntlRo',
]);

const LABEL_SHIFT = new Map([
    ['1','!'], ['2','"'], ['3','#'], ['4','$'], ['5','%'],
    ['6','&'], ['7','\''], ['8','('], ['9',')'],
    ['-','='], ['^','~'], ['\u00A5','|'],
    ['@','`'], ['[','{'], [']','}'],
    [';','+'], [':','*'],
    [',','<'], ['.','>'], ['/','?'],
]);

const LABEL_FM7_CODE = new Map([
    ['\u00A5', 0x5C],
]);

function _labelCodeUnshifted(label) {
    if (!label || label.length !== 1) return null;
    if (/^[A-Z]$/.test(label)) return label.toLowerCase().charCodeAt(0);
    return LABEL_FM7_CODE.get(label) ?? label.charCodeAt(0);
}
function _labelCodeShifted(label) {
    if (!label || label.length !== 1) return null;
    if (/^[A-Z]$/.test(label)) return label.charCodeAt(0);
    const s = LABEL_SHIFT.get(label);
    if (!s) return null;
    return LABEL_FM7_CODE.get(s) ?? s.charCodeAt(0);
}
function _glyphCodesFor(code, label) {
    return {
        left:   _labelCodeUnshifted(label),
        top:    _labelCodeShifted(label),
        right:  GRPH_OVERRIDE.get(code) ?? null,
        bottom: KANA_OVERRIDE.get(code) ?? null,
    };
}
function _activePosition(shift, caps, graph, kana, label) {
    if (graph) return 'right';
    if (kana)  return 'bottom';
    if (label && /^[A-Z]$/.test(label)) {
        return (shift !== caps) ? 'top' : 'left';
    }
    return shift ? 'top' : 'left';
}

// --- Layout definition ---

const K = (label, code, ...cls) => [label, code, ...cls];
const _ = ['', ''];
const LAYOUT = [
    // --- Top row 1 ---
    [_,_,_,_,_,_,_,_,_,_,_,_,_,K('EL','End'),K('CLS','PageUp'),_,K('INS','Insert'),K('\u25B2','ArrowUp'),K('DEL','Delete')],
    // --- Top row 2 ---
    [K('BRK',BREAK_CODE,'break-key'),_,K('PF1','F1'),K('PF2','F2'),K('PF3','F3'),K('PF4','F4'),K('PF5','F5'),K('PF6','F6'),K('PF7','F7'),K('PF8','F8'),K('PF9','F9'),K('PF10','F10'),_,K('DUP','PageDown'),K('HOM','Home'),_,K('\u25C0','ArrowLeft'),K('\u25BC','ArrowDown'),K('\u25B6','ArrowRight')],
    // --- Main row 1: ESC~BS + numpad 789* ---
    [K('ESC','Escape'),K('1','Digit1'),K('2','Digit2'),K('3','Digit3'),K('4','Digit4'),K('5','Digit5'),K('6','Digit6'),K('7','Digit7'),K('8','Digit8'),K('9','Digit9'),K('0','Digit0'),K('-','Minus'),K('^','Equal'),K('\u00A5','Backslash'),K('BS','Backspace'),_,K('7','Numpad7'),K('8','Numpad8'),K('9','Numpad9'),K('*','NumpadMultiply')],
    // --- Main row 2: TAB~RET + numpad 456/ ---
    [K('TAB','Tab'),K('Q','KeyQ'),K('W','KeyW'),K('E','KeyE'),K('R','KeyR'),K('T','KeyT'),K('Y','KeyY'),K('U','KeyU'),K('I','KeyI'),K('O','KeyO'),K('P','KeyP'),K('@','BracketLeft'),K('[','BracketRight'),K('RET','Enter'),_,K('4','Numpad4'),K('5','Numpad5'),K('6','Numpad6'),K('/','NumpadDivide')],
    // --- Main row 3: CTR~] + numpad 123= ---
    [K('CTR','ControlLeft','ctrl'),K('A','KeyA'),K('S','KeyS'),K('D','KeyD'),K('F','KeyF'),K('G','KeyG'),K('H','KeyH'),K('J','KeyJ'),K('K','KeyK'),K('L','KeyL'),K(';','Semicolon'),K(':','Quote'),K(']','IntlBackslash'),_,_,_,K('1','Numpad1'),K('2','Numpad2'),K('3','Numpad3'),K('=','NumpadEqual')],
    // --- Main row 4: SHF~SHF + numpad 0.+RT ---
    [K('SHF','ShiftLeft','shift'),K('Z','KeyZ'),K('X','KeyX'),K('C','KeyC'),K('V','KeyV'),K('B','KeyB'),K('N','KeyN'),K('M','KeyM'),K(',','Comma'),K('.','Period'),K('/','Slash'),K('_','IntlRo'),K('SHF','ShiftRight'),_,_,_,K('0','Numpad0'),K('.','NumpadDecimal'),K('+','NumpadAdd'),K('RT','NumpadEnter')],
    // --- Main row 5: CAP/GRP/(無変換)/SPACE/(変換)/カナ ---
    // 無変換 / 変換 は FM77AV 以降のみ表示（body.machine-fm7 で CSS が隠し、
    // SPACE 幅も 8 セル ⇔ 6 セルで切り替えて カナ の位置を揃える）
    [K('CAP','CapsLock','led'),K('GRP','AltLeft'),K('\u7121\u5909\u63DB','NonConvert','av-key'),K('SPACE','Space','space'),K('\u5909\u63DB','Convert','av-key'),K('\u30AB\u30CA','AltRight','led')],
];

// --- Portrait (tall phone) layout ---
// Same key set as LAYOUT, but the cursor / edit cluster and the numeric
// keypad are stacked BELOW the main typewriter block instead of sitting to
// its right. This keeps the keyboard narrow (fits a portrait phone width) so
// each key can be drawn larger. Widest rows are the main block = 15 columns.
const PORTRAIT_LAYOUT = [
    // --- Function keys ---
    [K('BRK',BREAK_CODE,'break-key'),K('PF1','F1'),K('PF2','F2'),K('PF3','F3'),K('PF4','F4'),K('PF5','F5'),K('PF6','F6'),K('PF7','F7'),K('PF8','F8'),K('PF9','F9'),K('PF10','F10')],
    // --- Main row 1: ESC~BS ---
    [K('ESC','Escape'),K('1','Digit1'),K('2','Digit2'),K('3','Digit3'),K('4','Digit4'),K('5','Digit5'),K('6','Digit6'),K('7','Digit7'),K('8','Digit8'),K('9','Digit9'),K('0','Digit0'),K('-','Minus'),K('^','Equal'),K('\u00A5','Backslash'),K('BS','Backspace')],
    // --- Main row 2: TAB~RET ---
    [K('TAB','Tab'),K('Q','KeyQ'),K('W','KeyW'),K('E','KeyE'),K('R','KeyR'),K('T','KeyT'),K('Y','KeyY'),K('U','KeyU'),K('I','KeyI'),K('O','KeyO'),K('P','KeyP'),K('@','BracketLeft'),K('[','BracketRight'),K('RET','Enter')],
    // --- Main row 3: CTR~] ---
    [K('CTR','ControlLeft','ctrl'),K('A','KeyA'),K('S','KeyS'),K('D','KeyD'),K('F','KeyF'),K('G','KeyG'),K('H','KeyH'),K('J','KeyJ'),K('K','KeyK'),K('L','KeyL'),K(';','Semicolon'),K(':','Quote'),K(']','IntlBackslash')],
    // --- Main row 4: SHF~SHF ---
    [K('SHF','ShiftLeft','shift'),K('Z','KeyZ'),K('X','KeyX'),K('C','KeyC'),K('V','KeyV'),K('B','KeyB'),K('N','KeyN'),K('M','KeyM'),K(',','Comma'),K('.','Period'),K('/','Slash'),K('_','IntlRo'),K('SHF','ShiftRight')],
    // --- Main row 5: CAP/GRP/(\u7121\u5909\u63DB)/SPACE/(\u5909\u63DB)/\u30AB\u30CA ---
    [K('CAP','CapsLock','led'),K('GRP','AltLeft'),K('\u7121\u5909\u63DB','NonConvert','av-key'),K('SPACE','Space','space'),K('\u5909\u63DB','Convert','av-key'),K('\u30AB\u30CA','AltRight','led')],
    // --- Cursor / edit cluster (left) + numeric keypad (right), below main ---
    [K('CLS','PageUp'),K('\u25B2','ArrowUp'),K('INS','Insert'),_,K('7','Numpad7'),K('8','Numpad8'),K('9','Numpad9'),K('*','NumpadMultiply')],
    [K('\u25C0','ArrowLeft'),K('\u25BC','ArrowDown'),K('\u25B6','ArrowRight'),_,K('4','Numpad4'),K('5','Numpad5'),K('6','Numpad6'),K('/','NumpadDivide')],
    [K('HOM','Home'),K('DEL','Delete'),K('EL','End'),_,K('1','Numpad1'),K('2','Numpad2'),K('3','Numpad3'),K('=','NumpadEqual')],
    [K('DUP','PageDown'),_,_,_,K('0','Numpad0'),K('.','NumpadDecimal'),K('+','NumpadAdd'),K('RT','NumpadEnter')],
];

// Use the portrait layout on narrow, portrait-oriented touch screens (phones).
function _portraitMode() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(orientation: portrait) and (max-width: 600px)').matches;
}

class SoftKeyboard {
    constructor(container, keyboard, fm7) {
        this._container = container;
        this._keyboard = keyboard;
        this._fm7 = fm7;
        this._shiftHeld = false;
        this._grphHeld = false;
        this._keyElements = new Map();
        this._prevGlyphState = '';
        this._portrait = _portraitMode();
        this._build();
        this._startLabelRefresh();
        this._watchOrientation();
    }

    _build() {
        const el = this._container;
        el.innerHTML = '';
        this._keyElements = new Map();
        this._prevGlyphState = '';
        const layout = this._portrait ? PORTRAIT_LAYOUT : LAYOUT;
        el.classList.toggle('portrait', this._portrait);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'skb-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            this.hide();
            const kbdBtn = document.getElementById('mobileKbdBtn');
            if (kbdBtn) kbdBtn.classList.remove('active');
            localStorage.setItem('webm7.ui.vkbd', '0');
        });
        closeBtn.addEventListener('contextmenu', e => e.preventDefault());
        el.appendChild(closeBtn);

        layout.forEach((row, ri) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'skb-row';
            // Add a small gap above the main block (wide: row 2, portrait: row 1).
            if (ri === (this._portrait ? 1 : 2)) rowEl.style.marginTop = '2px';

            row.forEach(([label, code, ...extra]) => {
                if (!label && !code) {
                    const sp = document.createElement('div');
                    sp.className = 'skb-spacer';
                    rowEl.appendChild(sp);
                    return;
                }

                const btn = document.createElement('button');
                let cls = 'skb-key';
                extra.forEach(c => { if (c) cls += ' ' + c; });
                if (code === 'Enter') cls += ' enter-wide';
                btn.className = cls;
                btn.dataset.code = code || '';
                btn.dataset.label = label;

                const labelSpan = document.createElement('span');
                labelSpan.className = 'skb-label';
                labelSpan.textContent = label;
                btn.appendChild(labelSpan);

                if (code) this._keyElements.set(code, btn);

                this._attachEvents(btn, code, extra);
                rowEl.appendChild(btn);
            });

            el.appendChild(rowEl);
        });
    }

    _attachEvents(btn, code, extra) {
        const isBreak = code === BREAK_CODE;
        const isShift = code === 'ShiftLeft' || code === 'ShiftRight';
        const isGrph = code === 'AltLeft';
        const isToggle = code === 'CapsLock' || code === 'AltRight'
            || code === 'KanaMode' || code === 'ControlLeft';

        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (typeof navigator.vibrate === 'function') navigator.vibrate(10);

            if (isBreak) { this._fm7.pressBreak(); btn.classList.add('active'); return; }
            if (isShift) {
                this._shiftHeld = !this._shiftHeld;
                this._updateShiftState();
                this._refreshKeyLabels(true);
                return;
            }
            if (isGrph) {
                this._grphHeld = true;
                this._keyboard.pressKey(code, false);
                btn.classList.add('active');
                this._refreshKeyLabels(true);
                return;
            }
            if (isToggle) {
                this._keyboard.pressKey(code, false);
                this._updateModState();
                this._refreshKeyLabels(true);
                return;
            }

            btn.classList.add('active');
            this._keyboard.pressKey(code, this._shiftHeld);
        });

        btn.addEventListener('pointerup', (e) => {
            e.preventDefault();
            if (isBreak) { this._fm7.releaseBreak(); btn.classList.remove('active'); return; }
            if (isShift || isToggle) return;
            if (isGrph) {
                this._grphHeld = false;
                this._keyboard.releaseKey(code);
                btn.classList.remove('active');
                this._refreshKeyLabels(true);
                return;
            }
            btn.classList.remove('active');
            this._keyboard.releaseKey(code);
            if (this._shiftHeld) {
                this._shiftHeld = false;
                this._updateShiftState();
                this._refreshKeyLabels(true);
            }
        });

        btn.addEventListener('pointercancel', (e) => {
            if (isBreak) { this._fm7.releaseBreak(); btn.classList.remove('active'); return; }
            if (isGrph) {
                this._grphHeld = false;
                this._keyboard.releaseKey(code);
                btn.classList.remove('active');
                this._refreshKeyLabels(true);
                return;
            }
            btn.classList.remove('active');
            this._keyboard.releaseKey(code);
        });

        btn.addEventListener('contextmenu', e => e.preventDefault());
    }

    // Modifier display
    _updateShiftState() {
        const sl = this._keyElements.get('ShiftLeft');
        const sr = this._keyElements.get('ShiftRight');
        if (sl) sl.classList.toggle('active', this._shiftHeld);
        if (sr) sr.classList.toggle('active', this._shiftHeld);
    }

    _updateModState() {
        const cap = this._keyElements.get('CapsLock');
        const kana = this._keyElements.get('AltRight');
        if (cap) cap.classList.toggle('active', this._keyboard.capsLock);
        if (kana) kana.classList.toggle('active', this._keyboard.kanaMode);
    }

    // --- CG ROM composite glyph system (matches Keyboard panel exactly) ---

    _refreshKeyLabels(force = false) {
        const shift = this._shiftHeld;
        const caps  = !!this._keyboard.capsLock;
        const graph = this._grphHeld;
        const kana  = !!this._keyboard.kanaMode;
        const rom   = this._fm7.cgROM;
        const romReady = rom && rom.length >= 0x800;
        const key = `${shift ? 1 : 0}|${caps ? 1 : 0}|${graph ? 1 : 0}|${kana ? 1 : 0}|${romReady ? 1 : 0}`;
        if (!force && key === this._prevGlyphState) return;
        this._prevGlyphState = key;

        for (const [code, btn] of this._keyElements) {
            if (!TYPEWRITER_CODES.has(code)) continue;
            const label = btn.dataset.label;
            const glyphs = _glyphCodesFor(code, label);
            const active = _activePosition(shift, caps, graph, kana, label);
            const url = getCGKeyCompositeDataURL(rom, glyphs, active);
            const img = btn.querySelector('img.skb-glyph');
            const labelSpan = btn.querySelector('.skb-label');
            if (url) {
                if (img) {
                    if (img.src !== url) img.src = url;
                } else {
                    const g = document.createElement('img');
                    g.className = 'skb-glyph';
                    g.src = url;
                    g.alt = '';
                    btn.appendChild(g);
                }
                if (labelSpan) labelSpan.style.display = 'none';
            } else {
                if (img) img.remove();
                if (labelSpan) labelSpan.style.display = '';
            }
        }
    }

    _startLabelRefresh() {
        setInterval(() => {
            this._updateModState();
            this._refreshKeyLabels();
        }, 100);
    }

    // Rebuild the keyboard when the device rotates between portrait/landscape
    // so the layout (wide vs. stacked) matches the current orientation.
    _watchOrientation() {
        const onChange = () => {
            const portrait = _portraitMode();
            if (portrait === this._portrait) return;
            this._portrait = portrait;
            this._build();
            // Re-apply held / toggled modifier visuals and refresh keytop glyphs.
            this._updateShiftState();
            this._updateModState();
            this._refreshKeyLabels(true);
        };
        if (window.matchMedia) {
            const mq = window.matchMedia('(orientation: portrait)');
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }
        window.addEventListener('orientationchange', onChange);
        window.addEventListener('resize', onChange);
    }

    show() { this._container.hidden = false; }
    hide() { this._container.hidden = true; }
    get visible() { return !this._container.hidden; }
}

// =====================================================================
// Auto-initialize
// =====================================================================
function isTouchDevice() {
    if (window.matchMedia('(any-pointer: coarse)').matches) return true;
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function init() {
    const container = document.getElementById('softKbd');
    if (!container) return;

    const checkReady = () => {
        if (!window.fm7) { setTimeout(checkReady, 200); return; }
        const fm7 = window.fm7;
        const softKbd = new SoftKeyboard(container, fm7.keyboard, fm7);
        window.softKbd = softKbd;

        // Auto-show on touch devices (user can toggle via button)
        const pref = localStorage.getItem('webm7.ui.vkbd');
        if (isTouchDevice() && pref !== '0') {
            container.hidden = false;
            const kbdBtn = document.getElementById('mobileKbdBtn');
            if (kbdBtn) kbdBtn.classList.add('active');
        }
    };
    checkReady();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}

export { SoftKeyboard };
