// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * FM-7 Keyboard Handler
 *
 * The FM-7 keyboard encoder produces 7-bit key codes (not standard ASCII).
 * Main CPU accesses keyboard through I/O ports:
 *   $FD00 (read)  - bit 7: key data available (active low: 0=yes, 1=no)
 *   $FD01 (read)  - key code (7-bit); reading clears the interrupt flag
 *   $FD02 (write) - bit 0: main-CPU keyboard IRQ enable
 *                          (1=enabled, 0=masked → routed to sub-CPU FIRQ;
 *                           reset default = 0)
 *
 * A key press pushes a make code into the buffer.
 * A key release pushes a break code (make code | 0x80) into the buffer.
 *
 * The FM-7 keyboard generates an IRQ to the main CPU when a key event
 * is available and the IRQ mask allows it.
 */

// =====================================================================
// FM-7 key code table
//
// These are the FM-7 native key codes (7-bit, 0x00-0x7F).
// They loosely resemble ASCII for printable characters but diverge
// for control keys and special keys.
// =====================================================================

const FM7_KEY_NONE    = 0xFF;  // sentinel: no key

// FM-7 hardware scan codes (key matrix positions)
const FM7_KEY_SPACE   = 0x35;
const FM7_KEY_RETURN  = 0x1D;
const FM7_KEY_ESC     = 0x01;
const FM7_KEY_BS      = 0x0F;
const FM7_KEY_TAB     = 0x10;
const FM7_KEY_DEL     = 0x4B;

// Arrow keys (hardware scan codes)
const FM7_KEY_LEFT    = 0x4F;
const FM7_KEY_RIGHT   = 0x51;
const FM7_KEY_UP      = 0x4D;
const FM7_KEY_DOWN    = 0x50;

// Home / Cls
const FM7_KEY_HOME    = 0x4B;  // HOME → same as DEL scan code

// Function keys PF1-PF10 (hardware scan codes, real-hardware compliant)
const FM7_KEY_F1      = 0x5D;
const FM7_KEY_F2      = 0x5E;
const FM7_KEY_F3      = 0x5F;
const FM7_KEY_F4      = 0x60;
const FM7_KEY_F5      = 0x61;
const FM7_KEY_F6      = 0x62;
const FM7_KEY_F7      = 0x63;
const FM7_KEY_F8      = 0x64;
const FM7_KEY_F9      = 0x65;
const FM7_KEY_F10     = 0x66;

// Break flag for key-up (release) events
const FM7_KEY_BREAK   = 0x80;

// =====================================================================
// PC key (KeyboardEvent.code) -> FM-7 key code mapping
// =====================================================================

/**
 * FM-7 mode: ASCII-based key codes.
 * The FM-7 keyboard encoder converts scan codes to ASCII internally.
 * $FD01 returns ASCII character codes.
 */
const CODE_TO_FM7_ASCII = new Map([
    // Letters (FM-7: lowercase by default, CAPS OFF = lowercase)
    ['KeyA', 0x61], ['KeyB', 0x62], ['KeyC', 0x63], ['KeyD', 0x64],
    ['KeyE', 0x65], ['KeyF', 0x66], ['KeyG', 0x67], ['KeyH', 0x68],
    ['KeyI', 0x69], ['KeyJ', 0x6A], ['KeyK', 0x6B], ['KeyL', 0x6C],
    ['KeyM', 0x6D], ['KeyN', 0x6E], ['KeyO', 0x6F], ['KeyP', 0x70],
    ['KeyQ', 0x71], ['KeyR', 0x72], ['KeyS', 0x73], ['KeyT', 0x74],
    ['KeyU', 0x75], ['KeyV', 0x76], ['KeyW', 0x77], ['KeyX', 0x78],
    ['KeyY', 0x79], ['KeyZ', 0x7A],
    // Digits
    ['Digit0', 0x30], ['Digit1', 0x31], ['Digit2', 0x32], ['Digit3', 0x33],
    ['Digit4', 0x34], ['Digit5', 0x35], ['Digit6', 0x36], ['Digit7', 0x37],
    ['Digit8', 0x38], ['Digit9', 0x39],
    // Numpad
    ['Numpad0', 0x30], ['Numpad1', 0x31], ['Numpad2', 0x32], ['Numpad3', 0x33],
    ['Numpad4', 0x34], ['Numpad5', 0x35], ['Numpad6', 0x36], ['Numpad7', 0x37],
    ['Numpad8', 0x38], ['Numpad9', 0x39],
    // Symbols (JIS physical layout: P's right neighbor = @, then [, then ])
    //   BracketLeft  = @ key  (P's right neighbor)
    //   BracketRight = [ key
    //   IntlBackslash = ] key (home row)
    ['Minus', 0x2D], ['Equal', 0x3D], ['BracketLeft', 0x40],
    ['BracketRight', 0x5B], ['IntlBackslash', 0x5D], ['Backslash', 0x5C],
    ['Semicolon', 0x3B],
    ['Quote', 0x3A], ['Comma', 0x2C], ['Period', 0x2E], ['Slash', 0x2F],
    ['NumpadAdd', 0x2B], ['NumpadSubtract', 0x2D], ['NumpadMultiply', 0x2A],
    ['NumpadDivide', 0x2F], ['NumpadDecimal', 0x2E], ['NumpadEnter', 0x0D],
    // Control keys
    // FM77AV 3分割スペース(左/中/右)。ASCIIでは全てSPACE、SCANでは各別コード。
    ['NonConvert', 0x20], ['Convert', 0x20],
    ['Enter', 0x0D], ['Space', 0x20], ['Escape', 0x1B], ['Backquote', 0x1B], ['Backspace', 0x08],
    ['Tab', 0x09], ['Delete', 0x7F], ['Insert', 0x12], ['Home', 0x0B],
    // Arrow keys
    ['ArrowLeft', 0x1D], ['ArrowRight', 0x1C], ['ArrowUp', 0x1E], ['ArrowDown', 0x1F],
    // Function keys (PF1-PF10): real-hardware 9-bit FM-7 ASCII codes.
    // Low byte = PF number (1-10); bit 8 (0x100) marks "PF/extended key",
    // surfaced via $FD00 bit 7 so software can distinguish PF1 from Ctrl-A.
    ['F1', 0x0101], ['F2', 0x0102], ['F3', 0x0103], ['F4', 0x0104], ['F5', 0x0105],
    ['F6', 0x0106], ['F7', 0x0107], ['F8', 0x0108], ['F9', 0x0109], ['F10', 0x010A],
]);

/**
 * FM77AV mode: Hardware scan codes (key matrix positions).
 * FM77AV can operate in scan code mode where $FD01 returns raw
 * keyboard matrix positions instead of ASCII.
 */
const CODE_TO_FM7_SCAN = new Map([
    // Row 0: ESC, digits, symbols
    ['Escape',     0x01],
    ['Backquote',  0x01],   // 半角/全角キーの位置を ESC に割り当てる（Escape キーは BREAK）
    ['Digit1',     0x02], ['Digit2', 0x03], ['Digit3', 0x04], ['Digit4', 0x05],
    ['Digit5',     0x06], ['Digit6', 0x07], ['Digit7', 0x08], ['Digit8', 0x09],
    ['Digit9',     0x0A], ['Digit0', 0x0B],
    ['Minus',      0x0C],  // -
    ['Equal',      0x0D],  // ^ (JIS) / = (US)
    ['Backslash',  0x0E],  // ¥ / backslash
    ['Backspace',  0x0F],  // BS

    // Row 1: TAB, QWERTYUIOP, @, [
    ['Tab',        0x10],
    ['KeyQ', 0x11], ['KeyW', 0x12], ['KeyE', 0x13], ['KeyR', 0x14],
    ['KeyT', 0x15], ['KeyY', 0x16], ['KeyU', 0x17], ['KeyI', 0x18],
    ['KeyO', 0x19], ['KeyP', 0x1A],
    ['BracketLeft',  0x1B],  // @ (P's right neighbor, JIS)
    ['BracketRight', 0x1C],  // [

    // Row 2: RETURN, ASDFGHJKL, ;, :, ]
    ['Enter',      0x1D],  // RETURN
    ['KeyA', 0x1E], ['KeyS', 0x1F], ['KeyD', 0x20], ['KeyF', 0x21],
    ['KeyG', 0x22], ['KeyH', 0x23], ['KeyJ', 0x24], ['KeyK', 0x25],
    ['KeyL', 0x26],
    ['Semicolon',    0x27],  // ;
    ['Quote',        0x28],  // : (JIS) / ' (US)
    ['IntlBackslash', 0x29],  // ] (home row, JIS)

    // Row 3: ZXCVBNM, symbols, SPACE
    ['KeyZ', 0x2A], ['KeyX', 0x2B], ['KeyC', 0x2C], ['KeyV', 0x2D],
    ['KeyB', 0x2E], ['KeyN', 0x2F], ['KeyM', 0x30],
    ['Comma',      0x31],  // ,
    ['Period',     0x32],  // .
    ['Slash',      0x33],  // /
    ['IntlRo',     0x34],  // _ (JIS underscore key)
    // FM77AV 3分割スペース(左/中/右)。ASCIIでは全てSPACE、SCANでは各別コード。
    ['NonConvert', 0x57], ['Convert', 0x58],
    ['Space',      0x35],  // SPACE

    // Numpad
    ['Numpad7',        0x3A], ['Numpad8',    0x3B], ['Numpad9',        0x3C],
    ['NumpadDivide',   0x3D],
    ['Numpad4',        0x3E], ['Numpad5',    0x3F], ['Numpad6',        0x40],
    ['NumpadMultiply', 0x41],
    ['Numpad1',        0x42], ['Numpad2',    0x43], ['Numpad3',        0x44],
    ['NumpadSubtract', 0x45],
    ['Numpad0',        0x46],
    ['NumpadDecimal',  0x47],
    ['Insert',         0x48],  // INS
    ['NumpadEnter',    0x49],
    ['Delete',         0x4B],  // DEL
    ['Home',           0x4B],  // HOME → DEL (FM-7 CLS/HOME)

    // Cursor keys
    ['ArrowUp',    0x4D],
    ['ArrowLeft',  0x4F],
    ['ArrowDown',  0x50],
    ['ArrowRight', 0x51],

    // Function keys (PF1-PF10)
    ['F1',  0x5D], ['F2',  0x5E], ['F3',  0x5F], ['F4',  0x60],
    ['F5',  0x61], ['F6',  0x62], ['F7',  0x63], ['F8',  0x64],
    ['F9',  0x65], ['F10', 0x66],
]);

/**
 * Shifted key code overrides (FM-7 ASCII mode only).
 * In scan code mode (FM77AV), Shift is a separate key and doesn't
 * change the scan code, so these are not used.
 */
const SHIFTED_OVERRIDE = new Map([
    // Letters: Shift produces uppercase on FM-7 (default is lowercase)
    ['KeyA', 0x41], ['KeyB', 0x42], ['KeyC', 0x43], ['KeyD', 0x44],
    ['KeyE', 0x45], ['KeyF', 0x46], ['KeyG', 0x47], ['KeyH', 0x48],
    ['KeyI', 0x49], ['KeyJ', 0x4A], ['KeyK', 0x4B], ['KeyL', 0x4C],
    ['KeyM', 0x4D], ['KeyN', 0x4E], ['KeyO', 0x4F], ['KeyP', 0x50],
    ['KeyQ', 0x51], ['KeyR', 0x52], ['KeyS', 0x53], ['KeyT', 0x54],
    ['KeyU', 0x55], ['KeyV', 0x56], ['KeyW', 0x57], ['KeyX', 0x58],
    ['KeyY', 0x59], ['KeyZ', 0x5A],
    // Shifted digit row
    ['Digit1', 0x21], ['Digit2', 0x22], ['Digit3', 0x23], ['Digit4', 0x24],
    ['Digit5', 0x25], ['Digit6', 0x26], ['Digit7', 0x27], ['Digit8', 0x28],
    ['Digit9', 0x29],
    // Shifted symbols (JIS physical layout)
    //   BracketLeft  = @ key → ` (0x60)
    //   BracketRight = [ key → { (0x7B)
    //   IntlBackslash = ] key → } (0x7D)
    ['Minus', 0x3D], ['Equal', 0x2B], ['Semicolon', 0x2B], ['Quote', 0x2A],
    ['Comma', 0x3C], ['Period', 0x3E], ['Slash', 0x3F],
    ['BracketLeft', 0x60], ['BracketRight', 0x7B], ['IntlBackslash', 0x7D],
    ['Backslash', 0x7C],
]);

/**
 * KANA mode key mapping (JIS X 0201 half-width katakana).
 * FM-7 standard JIS keyboard layout.
 */
const KANA_OVERRIDE = new Map([
    ['Digit1', 0xC7], ['Digit2', 0xCC], ['Digit3', 0xB1], ['Digit4', 0xB3],
    ['Digit5', 0xB4], ['Digit6', 0xB5], ['Digit7', 0xD4], ['Digit8', 0xD5],
    ['Digit9', 0xD6], ['Digit0', 0xDC],
    ['Minus', 0xCE], ['Equal', 0xCD], ['Backslash', 0xB0],
    ['KeyQ', 0xC0], ['KeyW', 0xC3], ['KeyE', 0xB2], ['KeyR', 0xBD],
    ['KeyT', 0xB6], ['KeyY', 0xDD], ['KeyU', 0xC5], ['KeyI', 0xC6],
    ['KeyO', 0xD7], ['KeyP', 0xBE],
    // JIS physical layout: BracketLeft = @ key, BracketRight = [ key,
    // IntlBackslash = ] key.
    ['BracketLeft', 0xDE], ['BracketRight', 0xDF], ['IntlBackslash', 0xD1],
    ['KeyA', 0xC1], ['KeyS', 0xC4], ['KeyD', 0xBC], ['KeyF', 0xCA],
    ['KeyG', 0xB7], ['KeyH', 0xB8], ['KeyJ', 0xCF], ['KeyK', 0xC9],
    ['KeyL', 0xD8],
    ['Semicolon', 0xDA], ['Quote', 0xB9],
    ['KeyZ', 0xC2], ['KeyX', 0xBB], ['KeyC', 0xBF], ['KeyV', 0xCB],
    ['KeyB', 0xBA], ['KeyN', 0xD0], ['KeyM', 0xD3],
    ['Comma', 0xC8], ['Period', 0xD9], ['Slash', 0xD2],
    ['IntlRo', 0xDB],
]);

/**
 * KANA + Shift overrides (small kana and symbols).
 */
const KANA_SHIFT_OVERRIDE = new Map([
    ['Digit0', 0xA6],  // ヲ
    ['Digit3', 0xA7],  // ァ
    ['Digit4', 0xA9],  // ゥ
    ['Digit5', 0xAA],  // ェ
    ['Digit6', 0xAB],  // ォ
    ['Digit7', 0xAC],  // ャ
    ['Digit8', 0xAD],  // ュ
    ['Digit9', 0xAE],  // ョ
    ['KeyE',   0xA8],  // ィ
    ['KeyZ',   0xAF],  // ッ
    ['Comma',  0xA4],  // 、
    ['Period', 0xA1],  // 。
    ['Slash',  0xA5],  // ・
    // JIS physical layout: 「 is on the [ key (BracketRight), 」 on the
    // ] key (IntlBackslash). The @ key (BracketLeft) has no kana-shift glyph.
    ['BracketRight',  0xA2],  // 「
    ['IntlBackslash', 0xA3],  // 」
]);

/**
 * GRPH mode key mapping.
 * GRPH is a momentary modifier (held like Shift). While held, keys
 * produce FM-7 graphic character codes ($80-$FF range).
 * Key assignments follow the GRPH character layout in the FM-7 user's manual.
 */
const GRPH_OVERRIDE = new Map([
    // Top row
    ['Escape', 0x1B], ['Backquote', 0x1B],
    ['Digit1', 0xF9], ['Digit2', 0xFA], ['Digit3', 0xFB], ['Digit4', 0xFC],
    ['Digit5', 0xF2], ['Digit6', 0xF3], ['Digit7', 0xF4], ['Digit8', 0xF5],
    ['Digit9', 0xF6], ['Digit0', 0xF7],
    ['Minus', 0x8C], ['Equal', 0x8B], ['Backslash', 0xF1], ['Backspace', 0x08],
    // QWERTY row
    ['Tab', 0x09],
    ['KeyQ', 0xFD], ['KeyW', 0xF8], ['KeyE', 0xE4], ['KeyR', 0xE5],
    ['KeyT', 0x9C], ['KeyY', 0x9D], ['KeyU', 0xF0], ['KeyI', 0xE8],
    ['KeyO', 0xE9], ['KeyP', 0x8D],
    ['BracketLeft', 0x8A], ['BracketRight', 0xED], ['Enter', 0x0D],
    // ASDF row
    ['KeyA', 0x95], ['KeyS', 0x96], ['KeyD', 0xE6], ['KeyF', 0xE7],
    ['KeyG', 0x9E], ['KeyH', 0x9F], ['KeyJ', 0xEA], ['KeyK', 0xEB],
    ['KeyL', 0x8E],
    ['Semicolon', 0x99], ['Quote', 0x94], ['IntlBackslash', 0xEC],
    // ZXCV row
    ['KeyZ', 0x80], ['KeyX', 0x81], ['KeyC', 0x82], ['KeyV', 0x83],
    ['KeyB', 0x84], ['KeyN', 0x85], ['KeyM', 0x86],
    ['Comma', 0x87], ['Period', 0x88], ['Slash', 0x97], ['IntlRo', 0xE0],
    // Cursor / editing
    ['Insert', 0x12], ['Delete', 0x7F],
]);

const GRPH_SHIFT_OVERRIDE = new Map([
    ['ArrowUp', 0x19], ['ArrowLeft', 0x02], ['ArrowDown', 0x1A], ['ArrowRight', 0x06],
]);

const GRPH_CURSOR = new Map([
    ['ArrowUp', 0x1E], ['ArrowLeft', 0x1D], ['ArrowDown', 0x1F], ['ArrowRight', 0x1C],
]);

/**
 * Maximum number of key events in the buffer.
 * FM-7 hardware has a small buffer; 16 is generous.
 */
const KEY_BUFFER_SIZE = 16;

// 独自メッセージの自動送出。半角カタカナと ASCII を通常のキー入力経路へ送る。
const ORIGINAL_MSG_TEXT =
    'WebM7ﾃﾞｱｿﾝﾃﾞｸﾚﾃｱﾘｶﾞﾄｳ｡FM-7ﾉﾀﾉｼｲｾｶｲｦｺﾞﾕｯｸﾘﾄﾞｳｿﾞ!!';
const ORIGINAL_MSG_BYTES = (() => {
    const out = [];
    for (const ch of ORIGINAL_MSG_TEXT) {
        const c = ch.codePointAt(0);
        out.push((c >= 0xFF61 && c <= 0xFF9F) ? (c - 0xFEC0) : (c & 0xFF));
    }
    out.push(0x00); // 終端(最後のキーとして送出)
    return out;
})();
const ORIGINAL_MSG_GAP_US = 122880; // 文字間隔(自己ペーシングと併用, 約123ms)
const ORIGINAL_MSG_MOD_CODES = new Set(
    ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);

export class Keyboard {
    constructor() {
        /**
         * Use hardware scan codes instead of ASCII.
         * FM-7: false (ASCII mode), FM77AV: true (scan code mode).
         * Set by fm7.js based on machine type.
         */
        this._useScanCodes = false;

        // --- Key event FIFO buffer ---
        /** @type {number[]} circular buffer of FM-7 key codes (7-bit + break bit) */
        this._buffer = [];

        // --- I/O register state ---
        /**
         * The most recently dequeued key code.
         * $FD01 returns this value.  Bit 7 doubles as break flag.
         * Power-on idle value is non-zero (low byte 0xFF, 9th bit clear):
         * $FD00 reads 0x7F and $FD01 reads 0xFF before the first key, so
         * software that samples the key register at boot never mistakes the
         * idle state for a real "code 0x00" key event.
         */
        this._currentKey = 0x00FF;

        /**
         * True when an unread key is in the data register.
         * Cleared when CPU reads $FD01 (and advanced from buffer if any).
         * Drives IRQ line and distinguishes "pending to consume" state.
         */
        this._keyAvailable = false;

        /**
         * Keyboard IRQ mask.  Written via $FD02 bit 0.
         * 0 = IRQ enabled, 1 = IRQ masked.
         */
        this._irqMask = 1; // key IRQ masked on init (keyboard via sub CPU FIRQ)

        /**
         * Internal IRQ flag.  Set when a new key event arrives and
         * the IRQ mask is clear.  Cleared when the CPU reads $FD01.
         */
        this._irqFlag = false;

        /**
         * Callback invoked when the keyboard wants to assert IRQ on the
         * main CPU.  Set this externally:
         *   keyboard.onIRQ = () => mainCPU.assertIRQ('keyboard');
         */
        this.onIRQ = null;

        // Track currently held keys to avoid auto-repeat flooding
        /** @type {Set<string>} set of KeyboardEvent.code values currently held */
        this._heldKeys = new Set();

        /**
         * FM77AV break code support.
         * When true, key-up events generate break codes (make code | 0x80).
         * FM-7 does not generate break codes; FM77AV does.
         */
        this._enableBreakCodes = false;

        // --- LED toggle states ---
        this.capsLock = false;
        this.kanaMode = false;
        this.insMode = false;
        // GRPH: momentary modifier (true while held)
        this.graphMode = false;

        // --- Custom key remapping ---
        /** @type {Map<string, string>} PC event.code → PC event.code remap */
        this._customMap = new Map();

        // --- Auto-type (TXT paste / program load) ---
        // Text is fed into the buffer one key at a time, self-paced: the next
        // character is released only once the hardware key buffer has drained,
        // AND a minimum amount of EMULATED time has passed (so the BASIC line
        // editor — which keeps reading the keyboard via IRQ while it is still
        // tokenizing/scrolling the previous line — has time to become ready
        // before the next line's leading characters arrive).
        //
        // The gap is tracked in emulated microseconds rather than call counts:
        // autoTypeTick() is driven from the render loop (once per RAF), so on a
        // 120/144 Hz display it fires ~2x per emulated 60 Hz frame.  Counting
        // gaps in calls would halve the effective pacing on high-refresh
        // monitors and drop the start of each line after a scroll.
        /** @type {Array<{code:number, gap:number}>} micro-second gaps */
        this._autoQueue = [];
        this._autoWaitUs = 0;   // emulated microseconds left before next key

        // --- 独自メッセージ ---
        this._origMsgFired = false;   // リセットまでに再生済み
        this._origMsgActive = false;  // 送出中
        this._origMsgEnabled = false; // FM77AV系でホストが有効化
        this._modHeld = new Set();       // Shift/Ctrlの物理押下(コード表に無い)
        this.onKeyEncBeep = null;        // 送出中の各文字でホストがBEEPを鳴らす
    }

    // ------------------------------------------------------------------
    // Browser event interface
    // ------------------------------------------------------------------

    /**
     * Handle a keydown event (a KeyboardEvent-like object with `code`,
     * `key`, `shiftKey` ...). The host forwards its keydown events here:
     *   keyboard.keyDown(e)
     *
     * @param {KeyboardEvent} event
     */
    keyDown(event) {
        const code = event.code;

        if (ORIGINAL_MSG_MOD_CODES.has(code)) this._modHeld.add(code);
        // 送出中は物理キー入力を無視する。
        if (this._origMsgActive) { event.preventDefault(); return; }
        // 独自メッセージを送る条件を判定する。
        if (code === 'KeyT' && this._origMessageChord(event)) {
            event.preventDefault();
            this._startOrigMessage();
            return;
        }

        // 101 US keyboard shortcut: Ctrl+/ → _
        // The underscore has no dedicated key on US layouts.
        const ctrlAlt = this._matchCtrlShortcut(event, code);
        if (ctrlAlt !== FM7_KEY_NONE) {
            event.preventDefault();
            this._heldKeys.add(code);
            // ASCII mode preserves all 9 bits (bit 8 = PF/extended flag),
            // matching the physical keyDown path. Scan-code mode keeps 7 bits.
            const mask = this._useScanCodes ? 0x7F : 0x1FF;
            this._pushKey(ctrlAlt & mask);
            return;
        }

        // Toggle LED keys (handle before mapping to prevent browser default)
        if (code === 'CapsLock') {
            this.capsLock = !this.capsLock;
        } else if (code === 'Insert') {
            this.insMode = !this.insMode;
        } else if (code === 'AltRight' || code === 'KanaMode') {
            // Alt-Right or Kana key → カナ toggle
            this.kanaMode = !this.kanaMode;
        } else if (code === 'AltLeft') {
            // GRPH: momentary (set on press, cleared on release)
            this.graphMode = true;
            event.preventDefault();
            this._heldKeys.add(code);
            return;
        }

        const fm7Code = this._mapKey(code, event.shiftKey);
        if (fm7Code === FM7_KEY_NONE) return;

        event.preventDefault();
        // Track by original code so keyUp can match correctly
        this._heldKeys.add(code);
        // ASCII mode: preserve full 9 bits (bit 8 = PF/extended key flag,
        // surfaced via $FD00 bit 7). Scan-code mode: 7 bits (break bit
        // applied separately).
        const mask = this._useScanCodes ? 0x7F : 0x1FF;
        this._pushKey(fm7Code & mask);
    }

    /**
     * Handle a browser keyup event.
     *
     * FM-7: no break codes — only releases the held key tracking.
     * FM77AV: generates break codes (make code | 0x80) on key release.
     *
     * @param {KeyboardEvent} event
     */
    keyUp(event) {
        const code = event.code;

        if (ORIGINAL_MSG_MOD_CODES.has(code)) this._modHeld.delete(code);

        if (code === 'AltLeft') {
            this.graphMode = false;
        }

        if (!this._heldKeys.has(code)) return;
        this._heldKeys.delete(code);

        // Ctrl+[ / Ctrl+/ shortcut: emit break code for @ / _
        const ctrlAlt = this._matchCtrlShortcut(event, code);
        if (ctrlAlt !== FM7_KEY_NONE) {
            event.preventDefault();
            if (this._enableBreakCodes) {
                this._pushKey((ctrlAlt & 0x7F) | FM7_KEY_BREAK);
            }
            return;
        }

        // Check remapped code for preventDefault
        const remapped = this._customMap.get(code) || code;
        const tbl = this._useScanCodes ? CODE_TO_FM7_SCAN : CODE_TO_FM7_ASCII;
        if (tbl.has(remapped)) {
            event.preventDefault();
        }

        // FM77AV: send break code (key release)
        if (this._enableBreakCodes) {
            const fm7Code = this._mapKey(code, event.shiftKey);
            if (fm7Code !== FM7_KEY_NONE) {
                this._pushKey((fm7Code & 0x7F) | FM7_KEY_BREAK);
            }
        }
    }

    /**
     * Release everything currently held — call this when the host page loses
     * focus (e.g. Alt+Tab, minimize, tab switch).  The browser does not deliver
     * keyup for keys that were down at focus-loss, so without this the GRPH
     * modifier (mapped to Alt, whose keyup Alt+Tab eats) and any held keys stay
     * stuck on.  Toggle states (CAPS / KANA / INS) are intentionally preserved.
     */
    releaseAllHeld() {
        // GRPH is the momentary modifier that actually gets stuck.
        this.graphMode = false;
        // In scan/break-code mode (FM77AV native), inform the machine that the
        // held keys were released so it does not see them stuck down.
        if (this._enableBreakCodes) {
            for (const code of this._heldKeys) {
                const fm7Code = this._mapKey(code, false);
                if (fm7Code !== FM7_KEY_NONE) {
                    this._pushKey((fm7Code & 0x7F) | FM7_KEY_BREAK);
                }
            }
        }
        this._heldKeys.clear();
        this._modHeld.clear();
    }

    /**
     * Match Ctrl+[ / Ctrl+/ shortcuts for US keyboards that lack @ and _ keys.
     * Returns FM-7 key code (ASCII or scan code depending on mode), or
     * FM7_KEY_NONE if the event is not one of these shortcuts.
     *
     * @param {KeyboardEvent} event
     * @param {string} code
     * @returns {number}
     */
    _matchCtrlShortcut(event, code) {
        if (!event.ctrlKey) return FM7_KEY_NONE;
        if (code === 'Slash') {
            return this._useScanCodes ? 0x34 : 0x5F;  // _
        }
        return FM7_KEY_NONE;
    }

    // ------------------------------------------------------------------
    // Synthetic input API (for virtual keyboard / programmatic use)
    // ------------------------------------------------------------------

    /**
     * Simulate a key press from a virtual keyboard.
     * Uses the same mapping tables as physical keyDown, but does not
     * require a real KeyboardEvent.
     *
     * @param {string}  code    - KeyboardEvent.code string (e.g. 'KeyA', 'Enter')
     * @param {boolean} shifted - true if Shift should be considered held
     */
    pressKey(code, shifted = false) {
        if (this._heldKeys.has(code)) return; // already held

        // LED toggles
        if (code === 'CapsLock') {
            this.capsLock = !this.capsLock;
        } else if (code === 'Insert') {
            this.insMode = !this.insMode;
        } else if (code === 'AltRight' || code === 'KanaMode') {
            this.kanaMode = !this.kanaMode;
        } else if (code === 'AltLeft') {
            this.graphMode = true;
            this._heldKeys.add(code);
            return; // GRPH is modifier-only, no key code emitted
        }

        const fm7Code = this._mapKey(code, shifted);
        if (fm7Code === FM7_KEY_NONE) return;

        this._heldKeys.add(code);
        // ASCII mode preserves all 9 bits (bit 8 = PF/extended flag),
        // matching the physical keyDown path. Scan-code mode keeps 7 bits.
        const mask = this._useScanCodes ? 0x7F : 0x1FF;
        this._pushKey(fm7Code & mask);
    }

    /**
     * Simulate a key release from a virtual keyboard.
     *
     * @param {string} code - KeyboardEvent.code string
     */
    releaseKey(code) {
        if (code === 'AltLeft') {
            this.graphMode = false;
        }

        if (!this._heldKeys.has(code)) return;
        this._heldKeys.delete(code);

        if (this._enableBreakCodes) {
            const fm7Code = this._mapKey(code, false);
            if (fm7Code !== FM7_KEY_NONE) {
                this._pushKey((fm7Code & 0x7F) | FM7_KEY_BREAK);
            }
        }
    }

    /** 独自メッセージを送る条件を判定する。 */
    _origMessageChord(event) {
        return this._origMsgEnabled
            && !this._origMsgFired
            && this.capsLock && this.kanaMode && this.graphMode
            && this._modHeld.has('ShiftLeft') && this._modHeld.has('ShiftRight')
            && (event.ctrlKey || this._modHeld.has('ControlLeft')
                || this._modHeld.has('ControlRight'));
    }

    /** 独自メッセージの自動送出を開始する。 */
    _startOrigMessage() {
        this._origMsgFired = true;
        this._origMsgActive = true;
        this.clearAutoType();
        for (const code of ORIGINAL_MSG_BYTES) {
            this._autoQueue.push({ code, gap: ORIGINAL_MSG_GAP_US });
        }
    }

    // ------------------------------------------------------------------
    // Auto-type: TXT paste / BASIC program load (ROM-free, via key injection)
    // ------------------------------------------------------------------

    /**
     * Queue text to be auto-typed into the machine. Each character is sent
     * as its FM-7 ASCII key code (printable ASCII == FM-7 key code in the
     * default keyboard mode); newlines become RETURN (0x0D).
     *
     * @param {string} text
     * @param {object} [opts]
     * @param {number} [opts.charGap=2]  60 Hz-frame-equivalents to wait after a
     *                                   normal key (converted to emulated time)
     * @param {number} [opts.lineGap=12] 60 Hz-frame-equivalents to wait after
     *                                   RETURN (lets the BASIC line editor
     *                                   tokenize/scroll the line before the next
     *                                   line's leading characters arrive)
     */
    queueText(text, { charGap = 2, lineGap = 12 } = {}) {
        const FRAME_US = 16667;                 // one 60 Hz frame in emulated us
        const charUs = charGap * FRAME_US;
        const lineUs = lineGap * FRAME_US;
        for (const ch of String(text)) {
            if (ch === '\r') continue;                 // CRLF → handled by \n
            if (ch === '\n') { this._autoQueue.push({ code: 0x0D, gap: lineUs }); continue; }
            if (ch === '\t') { this._autoQueue.push({ code: 0x09, gap: charUs }); continue; }
            const c = ch.charCodeAt(0);
            if (c >= 0x20 && c <= 0x7E) this._autoQueue.push({ code: c, gap: charUs });
        }
        return this._autoQueue.length;
    }

    /** Cancel any pending auto-type. */
    clearAutoType() {
        this._autoQueue = [];
        this._autoWaitUs = 0;
    }

    /** @returns {number} characters still waiting to be typed. */
    get autoTypePending() {
        return this._autoQueue.length;
    }

    /**
     * Advance the auto-typer. Releases the next queued key only when the
     * previous one has been consumed (hardware buffer drained) AND the
     * per-key emulated-time gap has elapsed.  Pacing is in emulated time, so
     * it is independent of the host display refresh rate.
     *
     * @param {number} [elapsedUs=16667] emulated microseconds since the last
     *        call (one 60 Hz frame by default).
     */
    autoTypeTick(elapsedUs = 16667) {
        if (this._autoWaitUs > 0) {
            this._autoWaitUs -= elapsedUs;
            if (this._autoWaitUs > 0) return;
            this._autoWaitUs = 0;
        }
        if (this._autoQueue.length === 0) return;
        // Self-pace: wait until the hardware key buffer has drained.
        if (this._keyAvailable || this._buffer.length > 0) return;
        const next = this._autoQueue.shift();
        this._pushKey(next.code);
        this._autoWaitUs = next.gap;
        if (this._origMsgActive) {
            if (this._autoQueue.length === 0) {
                // 終端(0x00)を送り終えた — 完了。BEEPは鳴らさない。
                this._origMsgActive = false;
                this.graphMode = false;
                this._modHeld.delete('ShiftLeft');
                this._modHeld.delete('ShiftRight');
            } else if (this.onKeyEncBeep) {
                // 各文字ごとにキーエンコーダの単音BEEP。
                this.onKeyEncBeep();
            }
        }
    }

    // ------------------------------------------------------------------
    // I/O port interface (main CPU reads/writes)
    // ------------------------------------------------------------------

    /**
     * Read from keyboard I/O port.
     *
     * @param {number} addr - address ($FD00 or $FD01)
     * @returns {number} byte value
     */
    readIO(addr) {
        switch (addr) {
            case 0xFD00:
                // bit 7 = 9th bit of the current key code (PF/extended keys
                // are 9-bit values 0x101-0x10A; ordinary 8-bit keys clear
                // bit 7).
                return (this._currentKey & 0x100) ? 0xFF : 0x7F;

            case 0xFD01: {
                // Keyboard data register: low 8 bits of the current key
                // code. Clears IRQ flag and advances buffer.
                this._irqFlag = false;
                const data = this._currentKey & 0xFF;
                if (this._buffer.length > 0) {
                    this._currentKey = this._buffer.shift();
                    this._keyAvailable = true;
                    this._assertIRQ();
                } else {
                    this._keyAvailable = false;
                }
                return data;
            }

            default:
                return 0xFF;  // unmapped
        }
    }

    /**
     * Write to keyboard I/O port.
     *
     * @param {number} addr  - address ($FD02)
     * @param {number} value - byte value
     */
    writeIO(addr, value) {
        switch (addr) {
            case 0xFD02:
                // Bit 0: main-CPU keyboard IRQ enable.
                //   bit0 = 1 → _irqMask = 0 (main-CPU IRQ enabled)
                //   bit0 = 0 → _irqMask = 1 (masked; routed to sub-CPU FIRQ,
                //                            reset default)
                this._irqMask = (value & 0x01) ? 0 : 1;
                if (this._irqMask === 0 && this._keyAvailable) {
                    this._assertIRQ();
                }
                break;
        }
    }

    // ------------------------------------------------------------------
    // Query interface
    // ------------------------------------------------------------------

    /**
     * Check whether key data is available for the CPU to read.
     * @returns {boolean}
     */
    hasKey() {
        return this._keyAvailable;
    }

    /**
     * Peek at the current key code without consuming it.
     * @returns {number} FM-7 key code (7-bit + break bit), or 0 if none
     */
    getKeyData() {
        return this._keyAvailable ? this._currentKey : 0x00FF;
    }

    /**
     * Return true if the keyboard IRQ line is asserted.
     */
    /**
     * Check if keyboard IRQ is active (for $FD03 status and CPU IRQ line).
     * Requires BOTH: flag set AND mask clear.
     */
    isIRQActive() {
        return this._irqFlag && (this._irqMask === 0);
    }

    /**
     * Current key code for display purposes.
     * @returns {number}
     */
    currentKey() {
        return this._currentKey;
    }

    /**
     * Number of keys waiting in the buffer.
     * @returns {number}
     */
    bufferCount() {
        return this._buffer.length;
    }

    // ------------------------------------------------------------------
    // Custom key remapping
    // ------------------------------------------------------------------

    /**
     * Set custom key remappings.
     * @param {Map<string, string>|Object} map - PC event.code → PC event.code
     */
    setCustomMap(map) {
        this._customMap.clear();
        if (map instanceof Map) {
            for (const [k, v] of map) this._customMap.set(k, v);
        } else if (map && typeof map === 'object') {
            for (const [k, v] of Object.entries(map)) this._customMap.set(k, v);
        }
    }

    /**
     * Clear all custom key remappings.
     */
    clearCustomMap() {
        this._customMap.clear();
    }

    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------

    /**
     * Reset the keyboard to power-on state.
     */
    reset() {
        this._buffer.length = 0;
        this._currentKey = 0x00FF; // non-zero idle value (see constructor)
        this._keyAvailable = false;
        this._irqMask = 1; // key IRQ masked on init (keyboard via sub CPU FIRQ)
        this._irqFlag = false;
        this._heldKeys.clear();
        this.capsLock = false;
        this.kanaMode = false;
        this.insMode = false;
        this.graphMode = false;
        this._modHeld.clear();
        this._origMsgActive = false;
        this._origMsgFired = false;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Map a PC KeyboardEvent.code to an FM-7 key code.
     *
     * @param {string}  code     - KeyboardEvent.code
     * @param {boolean} shifted  - true if Shift is held
     * @returns {number} FM-7 key code, or FM7_KEY_NONE if unmapped
     */
    _mapKey(code, shifted) {
        // Apply custom remap: PC code → PC code
        const remapped = this._customMap.get(code) || code;

        // Scan code mode (FM77AV): CAPS/KANA are separate modifier keys,
        // they don't alter the scan code itself. OS reads LED state.
        if (this._useScanCodes) {
            return CODE_TO_FM7_SCAN.has(remapped)
                ? CODE_TO_FM7_SCAN.get(remapped) : FM7_KEY_NONE;
        }

        // ASCII mode: GRPH has highest priority (momentary modifier).
        if (this.graphMode) {
            if (shifted && GRPH_SHIFT_OVERRIDE.has(remapped)) {
                return GRPH_SHIFT_OVERRIDE.get(remapped);
            }
            if (GRPH_CURSOR.has(remapped)) {
                return GRPH_CURSOR.get(remapped);
            }
            if (GRPH_OVERRIDE.has(remapped)) {
                return GRPH_OVERRIDE.get(remapped);
            }
        }

        // ASCII mode: apply KANA → SHIFT → CAPS in priority order.
        if (this.kanaMode) {
            if (shifted && KANA_SHIFT_OVERRIDE.has(remapped)) {
                return KANA_SHIFT_OVERRIDE.get(remapped);
            }
            if (KANA_OVERRIDE.has(remapped)) {
                return KANA_OVERRIDE.get(remapped);
            }
        }

        if (shifted && SHIFTED_OVERRIDE.has(remapped)) {
            return SHIFTED_OVERRIDE.get(remapped);
        }

        if (CODE_TO_FM7_ASCII.has(remapped)) {
            let c = CODE_TO_FM7_ASCII.get(remapped);
            // CAPS ON: lowercase letters → uppercase
            if (this.capsLock && c >= 0x61 && c <= 0x7A) {
                c -= 0x20;
            }
            return c;
        }
        return FM7_KEY_NONE;
    }

    /**
     * Push a key code into the FIFO buffer and potentially fire IRQ.
     *
     * @param {number} keyCode - 8-bit value (7-bit code + break flag)
     */
    _pushKey(keyCode) {
        if (this._buffer.length >= KEY_BUFFER_SIZE) {
            // Buffer full - drop oldest event
            this._buffer.shift();
        }
        this._buffer.push(keyCode);

        // If no key is currently staged, load immediately
        if (!this._keyAvailable) {
            this._currentKey = this._buffer.shift();
            this._keyAvailable = true;
            this._assertIRQ();
        }
    }

    /**
     * Assert keyboard IRQ if the mask allows it.
     */
    _assertIRQ() {
        // Flag is ALWAYS set when a key event arrives (regardless of mask)
        this._irqFlag = true;

        // But only trigger CPU IRQ line if mask allows it
        if (this._irqMask !== 0) return;
        if (typeof this.onIRQ === 'function') {
            this.onIRQ();
        }
    }
}

// Export key code constants for external use
export {
    FM7_KEY_NONE, FM7_KEY_BREAK,
    FM7_KEY_SPACE, FM7_KEY_RETURN, FM7_KEY_ESC, FM7_KEY_BS, FM7_KEY_TAB, FM7_KEY_DEL,
    FM7_KEY_LEFT, FM7_KEY_RIGHT, FM7_KEY_UP, FM7_KEY_DOWN, FM7_KEY_HOME,
    FM7_KEY_F1, FM7_KEY_F2, FM7_KEY_F3, FM7_KEY_F4, FM7_KEY_F5,
    FM7_KEY_F6, FM7_KEY_F7, FM7_KEY_F8, FM7_KEY_F9, FM7_KEY_F10,
    CODE_TO_FM7_ASCII, CODE_TO_FM7_SCAN, SHIFTED_OVERRIDE,
    GRPH_OVERRIDE, GRPH_SHIFT_OVERRIDE, GRPH_CURSOR,
    KANA_OVERRIDE, KANA_SHIFT_OVERRIDE,
};
