// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * FM-7 Keyboard Handler
 *
 * The key encoder: turns host key events into key codes in the current
 * input mode (ASCII-style or scan code; see _useScanCodes /
 * _enableBreakCodes), repeats held keys by itself, and holds the key data
 * that both CPUs read. The key interrupt goes to the sub CPU or the main
 * CPU as $FD02 bit 0 selects.
 */

// =====================================================================
// FM-7 key code constants (scan code format)
//
// The ASCII-style codes, including the 9-bit PF key codes, are defined
// in CODE_TO_FM7_ASCII below.
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

// HOME
const FM7_KEY_HOME    = 0x4E;

// Function keys PF1-PF10 (scan codes)
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
// Key caps: one record per FM-7 key, built from the layout
// =====================================================================
//
// The FM-7 key matrix numbers the keys row by row, left to right, from $01.
// The rows below list
// the host keys (KeyboardEvent.code) in that order; each run of keys takes
// consecutive scan codes from its first one. `null` in a `graph` array
// means the key gives no GRAPH code.
//
// Alongside each row are the characters printed on the key caps, in the
// same order (a space = nothing on that layer):
//   plain / shifted  ASCII characters
//   kana / kana+sh   half-width katakana
//   graph            GRAPH mode codes. Each `graph` array holds the codes
//                    for the row's keys in the same left to right order;
//                    RETURN opens the third array because its scan code
//                    $1D follows the last key of the row before ($1C).
//
// Host keys are named after a Japanese keyboard: BracketLeft is the @ key
// right of P, BracketRight the [ key, IntlBackslash the ] key next to
// RETURN, IntlYen the ¥ key and IntlRo the key right of / (" and _).

/** Main typewriter block, one entry per matrix row. */
const MAIN_ROWS = [
    {
        firstScan: 0x01,
        keys:  ['Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
                'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'IntlYen', 'Backspace'],
        plain:   ' 1234567890-^¥ ',
        shifted: ' !"#$%&\'() =~| ',
        kana:    ' ﾇﾌｱｳｴｵﾔﾕﾖﾜﾎﾍｰ ',
        kanaSh:  '   ｧｩｪｫｬｭｮｦ    ',
        graph: [0x1B, 0xF9, 0xFA, 0xFB, 0xFC, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7,
                0x8C, 0x8B, 0xF1, 0x08],
    },
    {
        firstScan: 0x10,
        keys:  ['Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI',
                'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
        plain:   ' qwertyuiop@[',
        shifted: ' QWERTYUIOP`{',
        kana:    ' ﾀﾃｲｽｶﾝﾅﾆﾗｾﾞﾟ',
        kanaSh:  '   ｨ        ｢',
        graph: [0x09, 0xFD, 0xF8, 0xE4, 0xE5, 0x9C, 0x9D, 0xF0, 0xE8, 0xE9, 0x8D,
                0x8A, 0xED],
    },
    {
        firstScan: 0x1D,
        keys:  ['Enter', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK',
                'KeyL', 'Semicolon', 'Quote', 'IntlBackslash'],
        plain:   ' asdfghjkl;:]',
        shifted: ' ASDFGHJKL+*}',
        kana:    ' ﾁﾄｼﾊｷｸﾏﾉﾘﾚｹﾑ',
        kanaSh:  '            ｣',
        graph: [0x0D, 0x95, 0x96, 0xE6, 0xE7, 0x9E, 0x9F, 0xEA, 0xEB, 0x8E,
                0x89, 0x94, 0xEC],
    },
    {
        firstScan: 0x2A,
        keys:  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period',
                'Slash', 'IntlRo', 'Space'],
        plain:   'zxcvbnm,./" ',
        shifted: 'ZXCVBNM<>?_ ',
        kana:    'ﾂｻｿﾋｺﾐﾓﾈﾙﾒﾛ ',
        kanaSh:  'ｯ      ､｡･  ',
        graph: [0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x97, 0xE0, null],
    },
];

/**
 * Numeric keypad, from $36. GRAPH: the codes row by row, left to right,
 * the same order as `keys`; `NO_CODE` marks the keys that give no code.
 */
const NO_CODE = -1;
const KEYPAD = {
    firstScan: 0x36,
    keys:  ['NumpadMultiply', 'NumpadDivide', 'NumpadAdd', 'NumpadSubtract',
            'Numpad7', 'Numpad8', 'Numpad9', 'NumpadEqual',
            'Numpad4', 'Numpad5', 'Numpad6', 'NumpadComma',
            'Numpad1', 'Numpad2', 'Numpad3', 'NumpadEnter',
            'Numpad0', 'NumpadDecimal'],
    plain: '*/+-789=456,123\r0.',
    graph: [0x98, 0x91, 0x99, 0xEE, 0xE1, 0xE2, 0xE3, 0xEF,
            0x93, 0x8F, 0x92, NO_CODE, 0x9A, 0x90, 0x9B, 0x0D, NO_CODE, NO_CODE],
};

/**
 * Editing and cursor keys, from $48. ASCII codes (EL = CTRL + E, CLS = CTRL + L, DUP = CTRL + Q, HOME = $0B,
 * INS = $12, DEL = $7F, cursor $1C-$1F). GRAPH: INS and DEL keep their
 * codes; the cursor keys with SHIFT give the upper codes.
 */
const EDIT_KEYS = {
    firstScan: 0x48,
    keys:    ['Insert', 'End', 'PageUp', 'Delete', 'PageDown',
              'ArrowUp', 'Home', 'ArrowLeft', 'ArrowDown', 'ArrowRight'],
    ascii:   [0x12, 0x05, 0x0C, 0x7F, 0x11, 0x1E, 0x0B, 0x1D, 0x1F, 0x1C],
    graph:   [0x12, null, null, 0x7F, null, null, null, null, null, null],
    graphSh: [null, null, null, null, null, 0x19, null, 0x02, 0x1A, 0x06],
};

/**
 * Keys from $52: CTRL, left SHIFT, right SHIFT, CAP and GRAPH ($52-$56),
 * which only change the others. The left and middle parts of the FM77AV
 * three-part space bar ($57, $58; the right part is SPACE) follow them in
 * the matrix but are ordinary keys (see below). In scan code mode they all
 * send make and break codes of their own.
 */
const SHIFT_KEYS = {
    firstScan: 0x52,
    keys: ['ControlLeft', 'ShiftLeft', 'ShiftRight', 'CapsLock', 'AltLeft',
           'NonConvert', 'Convert'],
};

/** Scan code of the BREAK key. */
const SCAN_BREAK_KEY = 0x5C;

/**
 * Scan code of the kana key, the right end of the bottom row.
 */
const SCAN_KANA_KEY = 0x5A;

/** PF1-PF10: scan codes from $5D; in ASCII mode the 9-bit codes $101-$10A. */
const PF_FIRST_SCAN = 0x5D;
const PF_ASCII_BASE = 0x100;

/** Host keys that stand for another key (the same key cap on the FM-7). */
const HOST_ALIASES = new Map([
    ['Backquote', 'Escape'],        // left of 1 on a Japanese keyboard, where ESC is
    ['Backslash', 'IntlYen'],       // \ key of a US keyboard
    ['ControlRight', 'ControlLeft'],
    ['AltRight', 'KanaMode'],       // the kana key on keyboards without one
]);

/** ASCII code of a key cap character ('¥' is $5C). */
function asciiOf(ch) {
    return ch === '¥' ? 0x5C : ch.charCodeAt(0);
}

/** 8-bit code of a half-width katakana character. */
function kanaCodeOf(ch) {
    return 0xA1 + (ch.codePointAt(0) - 0xFF61);
}

/**
 * CTRL with a key cap character: the lower-case letters and @ [ ¥ ] ^ _
 * ($40-$5F) give the control code that keeps their low five
 * bits.
 */
function controlCodeOf(ascii) {
    const lower = ascii >= 0x61 && ascii <= 0x7A;
    const upperBlock = ascii >= 0x40 && ascii <= 0x5F;
    return (lower || upperBlock) ? (ascii & 0x1F) : undefined;
}

/** @type {Map<string, object>} host key → key cap record */
const KEYCAPS = new Map();

function cap(code) {
    let rec = KEYCAPS.get(code);
    if (!rec) { rec = {}; KEYCAPS.set(code, rec); }
    return rec;
}

for (const row of MAIN_ROWS) {
    const kana = Array.from(row.kana);
    const kanaSh = Array.from(row.kanaSh);
    row.keys.forEach((code, i) => {
        const rec = cap(code);
        rec.scan = row.firstScan + i;
        if (row.plain[i] !== ' ') {
            rec.ascii = asciiOf(row.plain[i]);
            const c = controlCodeOf(rec.ascii);
            if (c !== undefined) rec.ctrl = c;
        }
        if (row.shifted[i] !== ' ') {
            rec.shift = asciiOf(row.shifted[i]);
            // The key right of / has _ on its upper layer: CTRL with it
            // keeps giving $1F.
            if (rec.ctrl === undefined) {
                const c = controlCodeOf(rec.shift);
                if (c !== undefined) rec.ctrl = c;
            }
        }
        if (kana[i] !== ' ') rec.kana = kanaCodeOf(kana[i]);
        if (kanaSh[i] !== ' ') rec.kanaShift = kanaCodeOf(kanaSh[i]);
        if (row.graph[i] !== null) rec.graph = row.graph[i];
    });
}
// Keys of the main rows whose ASCII code is not their cap character.
Object.assign(cap('Escape'), { ascii: 0x1B });
Object.assign(cap('Backspace'), { ascii: 0x08 });
Object.assign(cap('Tab'), { ascii: 0x09 });
Object.assign(cap('Enter'), { ascii: 0x0D });
Object.assign(cap('Space'), { ascii: 0x20 });
// CTRL + / types _ as well, for layouts without the key right of /.
cap('Slash').ctrl = 0x5F;

KEYPAD.keys.forEach((code, i) => {
    const rec = cap(code);
    rec.scan = KEYPAD.firstScan + i;
    rec.ascii = asciiOf(KEYPAD.plain[i]);
    rec.graph = KEYPAD.graph[i] === NO_CODE ? FM7_KEY_NONE : KEYPAD.graph[i];
});

EDIT_KEYS.keys.forEach((code, i) => {
    const rec = cap(code);
    rec.scan = EDIT_KEYS.firstScan + i;
    rec.ascii = EDIT_KEYS.ascii[i];
    if (EDIT_KEYS.graph[i] !== null) rec.graph = EDIT_KEYS.graph[i];
    if (EDIT_KEYS.graphSh[i] !== null) rec.graphShift = EDIT_KEYS.graphSh[i];
});

SHIFT_KEYS.keys.forEach((code, i) => { cap(code).modifierScan = SHIFT_KEYS.firstScan + i; });
cap('KanaMode').modifierScan = SCAN_KANA_KEY;
// The space bar parts are ordinary keys: SPACE in ASCII mode.
for (const code of ['NonConvert', 'Convert']) {
    const rec = cap(code);
    rec.scan = rec.modifierScan;
    delete rec.modifierScan;
    rec.ascii = 0x20;
}

for (let n = 1; n <= 10; n++) {
    Object.assign(cap(`F${n}`), { scan: PF_FIRST_SCAN + n - 1, ascii: PF_ASCII_BASE + n });
}

for (const [alias, target] of HOST_ALIASES) KEYCAPS.set(alias, KEYCAPS.get(target));

// CTRL: only the keys with a code in control mode give one.
for (const rec of KEYCAPS.values()) {
    if (rec.ctrl === undefined && rec.ascii !== undefined) rec.ctrl = FM7_KEY_NONE;
}

/** One layer of the key caps as a Map (host key → code). */
function layer(field, { skip = null } = {}) {
    const m = new Map();
    for (const [code, rec] of KEYCAPS) {
        if (rec[field] !== undefined && rec[field] !== skip) m.set(code, rec[field]);
    }
    return m;
}

/** ASCII-style codes (FM-7 mode), including the 9-bit PF key codes. */
const CODE_TO_FM7_ASCII = layer('ascii');
/** Scan codes (key matrix positions) of the ordinary keys. */
const CODE_TO_FM7_SCAN = layer('scan');
/** SHIFT layer (ASCII mode only; scan codes do not change with SHIFT). */
const SHIFTED_OVERRIDE = layer('shift');
/** CTRL layer (ASCII mode only). */
const CTRL_OVERRIDE = layer('ctrl', { skip: FM7_KEY_NONE });
/** Scan codes of CTRL, SHIFT, CAP, GRAPH and kana. */
const MODIFIER_SCAN = layer('modifierScan');
/** CTRL + / in scan code mode: the scan code of the key right of / (" _). */
const CTRL_SLASH_SCAN = KEYCAPS.get('IntlRo').scan;
/** Kana layers. */
const KANA_OVERRIDE = layer('kana');
const KANA_SHIFT_OVERRIDE = layer('kanaShift');
/**
 * GRAPH layer; keys not in it give their
 * usual codes, except the keypad keys marked NO_CODE, which give nothing in
 * GRAPH mode.
 */
const GRAPH_MODE_CODES = layer('graph', { skip: FM7_KEY_NONE });
/** Cursor keys with SHIFT in GRAPH mode. */
const GRAPH_MODE_SHIFT_CODES = layer('graphShift');
// -----------------------------------------------------------------------------
// WebM7 greeting
// -----------------------------------------------------------------------------
// Typed into the key data one character at a time, as 8-bit codes
// (a voiced sound mark is a character of its own, $DE).
const GREETING_TEXT =
    'WebM7ﾃﾞｱｿﾝﾃﾞｸﾚﾃｱﾘｶﾞﾄｳ｡FM-7ﾉﾀﾉｼｲｾｶｲｦｺﾞﾕｯｸﾘﾄﾞｳｿﾞ!!';
const GREETING_CODES = Array.from(GREETING_TEXT, (ch) => {
    const u = ch.codePointAt(0);
    return (u >= 0xFF61 && u <= 0xFF9F) ? 0xA1 + (u - 0xFF61) : u;
});
/** At least this long between two greeting characters. */
const GREETING_INTERVAL_US = 100000;
/** Keys of the combination CTRL + SHIFT + GRAPH + 7. */
const GREETING_CHORD_KEYS = new Set(
    ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'Digit7']);

// -----------------------------------------------------------------------------
// Auto repeat
// -----------------------------------------------------------------------------
/**
 * The FM-7 standard repeat: the first repeat 0.7 s after the press, then
 * one every 0.07 s. Held in milliseconds.
 */
const STANDARD_REPEAT = Object.freeze({ delayMs: 700, periodMs: 70 });
/** Unit of the repeat times given by KEYBOARD CONTROL sub command $05. */
const REPEAT_UNIT_MS = 10;
/** Room in the scan code outbox; a code beyond it pushes out the oldest. */
const OUTBOX_SLOTS = 16;

/**
 * Scan code mode: a ring of codes on their way to the key data, oldest
 * first. When every slot is taken, a new code overwrites the oldest one.
 */
class ScanCodeOutbox {
    constructor(slots) {
        this._ring = new Uint16Array(slots);
        this._head = 0;
        this.count = 0;
    }

    put(code) {
        const slots = this._ring.length;
        if (this.count === slots) {
            this._head = (this._head + 1) % slots;
            this.count--;
        }
        this._ring[(this._head + this.count) % slots] = code;
        this.count++;
    }

    take() {
        const code = this._ring[this._head];
        this._head = (this._head + 1) % this._ring.length;
        this.count--;
        return code;
    }

    clear() {
        this._head = 0;
        this.count = 0;
    }
}
/** Keys that never repeat (shift and lock keys). */
const NEVER_REPEAT = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
    'AltLeft', 'AltRight', 'CapsLock', 'KanaMode', 'Insert']);
/** Host keys of the kana key. */
const KANA_KEYS = new Set(['AltRight', 'KanaMode']);
/** Host keys of the keys that lock on a press and send no code in ASCII mode. */
const LOCK_KEYS = new Set(['CapsLock', ...KANA_KEYS]);
/** Physical keys whose modifier state is tracked here. */
const TRACKED_MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);

/**
 * ASCII mode: the key cap fields to try, indexed by the held state
 * (bit 3 CTRL, bit 2 GRAPH mode, bit 1 kana mode, bit 0 SHIFT). The
 * first field the key has gives the code; a key without it falls through
 * to the next. The plain code is always last.
 * Order of the modes: control, graphic, kana, then alphanumeric; when
 * several are selected the highest one applies.
 */
const FIELDS_BY_HELD_STATE = Array.from({ length: 16 }, (_, state) => {
    const shifted = (state & 1) !== 0;
    const fields = [];
    if (state & 8) fields.push('ctrl');
    if (state & 4) fields.push(...(shifted ? ['graphShift', 'graph'] : ['graph']));
    if (state & 2) fields.push(...(shifted ? ['kanaShift', 'kana'] : ['kana']));
    if (shifted) fields.push('shift');
    fields.push('ascii');
    return Object.freeze(fields);
});

export class Keyboard {
    constructor() {
        /**
         * Whether the scan code format is in use (instead of ASCII-style
         * codes). Initial value is false on every machine; switched by the
         * input mode setting (see fm7.js).
         */
        this._useScanCodes = false;
        /**
         * FM77AV break code support: key releases send make code | $80.
         * Enabled together with the scan code input mode (see fm7.js).
         */
        this._enableBreakCodes = false;

        // --- Encoder output ---
        /**
         * The 9-bit key data both CPUs read ($FD00 bit 7 / $FD01, $D400 /
         * $D401). It holds the last code sent; the
         * type-ahead buffer is software in the sub CPU. In
         * the 9-bit modes a new code replaces one not yet read.
         */
        this._keyData = 0x000;
        /** Key strobe: a code waits to be read; drives the key interrupt. */
        this._strobe = false;
        /**
         * Scan code mode: every code passes through here on its way to the
         * key data. A released key leaves no other trace, so codes are not
         * replaced; after a read the next one goes out on the encoder tick.
         */
        this._outbox = new ScanCodeOutbox(OUTBOX_SLOTS);
        /** $FD02 bit 0: false = sub CPU FIRQ (reset), true = main CPU IRQ. */
        this._toMainCPU = false;
        /** Called when a key interrupt is raised towards the main CPU. */
        this.onMainInterrupt = null;
        /** Called to sound one single beep (end of the greeting). */
        this.onSingleBeep = null;

        // Track currently held keys for release handling.
        /** @type {Set<string>} set of KeyboardEvent.code values currently held */
        this._heldKeys = new Set();
        /** Physical SHIFT / CTRL keys held (they have no code of their own). */
        this._heldModifiers = new Set();

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
        /** @type {Array<{code:number, gap:number}>} micro-second gaps */
        this._autoQueue = [];
        this._autoWaitUs = 0;   // emulated microseconds left before next key

        // --- Auto repeat ---
        this._repeatOn = true;
        /** Current repeat times in ms ({delayMs, periodMs}). */
        this._repeatTimes = STANDARD_REPEAT;
        /** The key being repeated: {code, keyCode, waitUs} or null. */
        this._repeating = null;

        // --- Greeting: {next, waitUs} while sending, else null ---
        this._greeting = null;

        /**
         * True once a key that exists only on a Japanese keyboard (¥ or ろ)
         * has been seen. A Japanese keyboard reports its ] key (next to
         * RETURN) as 'Backslash', the code of the \ key on a US keyboard, so
         * the flag decides whether 'Backslash' means ] or ¥. The physical
         * layout does not change while the page is open, so reset() keeps it.
         */
        this._jisLayout = false;

        /**
         * CTRL set from a virtual keyboard (pressKey('ControlLeft')). It is
         * sticky; releaseKey() clears it.
         */
        this._ctrlSticky = false;
        /** The make code of the virtual CTRL went out; its break code is due. */
        this._stickyCtrlSent = false;
        /** The virtual SHF whose make code went out, or null. */
        this._virtualShift = null;
    }

    /** True while CTRL is held (physical key or sticky virtual key). */
    get ctrlHeld() {
        return this._ctrlSticky
            || this._heldModifiers.has('ControlLeft') || this._heldModifiers.has('ControlRight');
    }

    // ------------------------------------------------------------------
    // Browser event interface
    // ------------------------------------------------------------------

    /**
     * Handle a keydown event (a KeyboardEvent-like object with `code`,
     * `key`, `shiftKey` ...). The host forwards its keydown events here.
     * The host's own key repeat is ignored; the encoder repeats by itself.
     *
     * @param {KeyboardEvent} event
     */
    keyDown(event) {
        const code = this.physicalKeyCode(event.code);
        if (TRACKED_MODIFIERS.has(code)) this._heldModifiers.add(code);
        const ctrl = event.ctrlKey || this.ctrlHeld;

        // A key that is not part of the combination ends the greeting.
        if (this._greeting && !GREETING_CHORD_KEYS.has(code)) this.stopGreeting();

        // CTRL + SHIFT + a digit operates the encoder itself (ASCII mode).
        if (ctrl && event.shiftKey && !this._useScanCodes && this._encoderChord(code)) {
            if (event.preventDefault) event.preventDefault();
            return;
        }

        // Scan code mode: CTRL / SHIFT / CAP / GRAPH / kana send their own make code.
        if (this._useScanCodes && MODIFIER_SCAN.has(code)) {
            if (event.preventDefault) event.preventDefault();
            if (this._heldKeys.has(code)) return;   // host key repeat
            if (code === 'CapsLock') this.capsLock = !this.capsLock;
            else if (KANA_KEYS.has(code)) this.kanaMode = !this.kanaMode;
            else if (code === 'AltLeft') this.graphMode = true;
            this._heldKeys.add(code);
            this._emit(MODIFIER_SCAN.get(code));
            return;
        }

        if (this._heldKeys.has(code) || (event.repeat && LOCK_KEYS.has(code))) {   // host key repeat
            if (event.preventDefault) event.preventDefault();
            return;
        }

        // Toggle LED keys and the GRPH modifier before mapping.
        if (code === 'CapsLock') {
            this.capsLock = !this.capsLock;
        } else if (code === 'Insert') {
            this.insMode = !this.insMode;
        } else if (KANA_KEYS.has(code)) {
            this.kanaMode = !this.kanaMode;
        } else if (code === 'AltLeft') {
            this.graphMode = true;
            if (event.preventDefault) event.preventDefault();
            this._heldKeys.add(code);
            return;
        }

        const keyCode = this._mapKey(code, event.shiftKey, ctrl);
        if (keyCode === FM7_KEY_NONE) return;

        // Also suppresses the browser's own CTRL + letter shortcuts.
        if (event.preventDefault) event.preventDefault();
        this._heldKeys.add(code);
        const sent = keyCode & (this._useScanCodes ? 0x7F : 0x1FF);
        this._emit(sent);
        this._armRepeat(code, sent);
    }

    /**
     * Handle a browser keyup event. Ends the repeat of that key and, when
     * break codes are enabled, sends the break code (make code | 0x80).
     *
     * @param {KeyboardEvent} event
     */
    keyUp(event) {
        let code = this.physicalKeyCode(event.code);
        if (TRACKED_MODIFIERS.has(code)) this._heldModifiers.delete(code);
        if (code === 'AltLeft') this.graphMode = false;

        if (!this._heldKeys.has(code)) {
            // The layout flag may have been set while this key was held.
            if (!this._heldKeys.has(event.code)) return;
            code = event.code;
        }
        this._heldKeys.delete(code);
        if (this._repeating && this._repeating.code === code) this._repeating = null;

        const remapped = this._customMap.get(code) || code;
        const tbl = this._useScanCodes ? CODE_TO_FM7_SCAN : CODE_TO_FM7_ASCII;
        if ((tbl.has(remapped) || (event.ctrlKey && CTRL_OVERRIDE.has(remapped)))
            && event.preventDefault) {
            event.preventDefault();
        }

        if (this._enableBreakCodes) {
            const keyCode = this._mapKey(code, event.shiftKey, event.ctrlKey || this.ctrlHeld);
            if (keyCode !== FM7_KEY_NONE) this._emit((keyCode & 0x7F) | FM7_KEY_BREAK);
        }
    }

    /**
     * Turn a browser event.code into the key it stands for on the user's
     * keyboard. A Japanese keyboard has keys a US keyboard lacks (¥ = IntlYen,
     * ろ = IntlRo); seeing one of them tells us the layout, and from then on
     * 'Backslash' is the ] key next to RETURN rather than the \ key of a US
     * keyboard.
     *
     * @param {string} code - KeyboardEvent.code
     * @returns {string} code as used by the mapping tables
     */
    physicalKeyCode(code) {
        if (code === 'IntlYen' || code === 'IntlRo') this._jisLayout = true;
        if (this._jisLayout && code === 'Backslash') return 'IntlBackslash';
        return code;
    }

    /**
     * Release the tracked keys and physical modifiers — call this when the
     * host page loses focus, since the browser does not deliver keyup for
     * keys that were down at focus-loss. Toggle states (CAPS / KANA / INS)
     * and the virtual CTRL are preserved.
     */
    releaseAllHeld() {
        this.graphMode = false;
        if (this._enableBreakCodes) {
            for (const code of this._heldKeys) {
                const keyCode = this._mapKey(code, false);
                if (keyCode !== FM7_KEY_NONE) this._emit((keyCode & 0x7F) | FM7_KEY_BREAK);
            }
        }
        this._heldKeys.clear();
        this._heldModifiers.clear();
        this._repeating = null;
    }

    // ------------------------------------------------------------------
    // Synthetic input API (for virtual keyboard / programmatic use)
    // ------------------------------------------------------------------

    /**
     * Simulate a key press from a virtual keyboard (same mapping as keyDown).
     *
     * @param {string}  code    - KeyboardEvent.code string (e.g. 'KeyA', 'Enter')
     * @param {boolean} shifted - true if Shift should be considered held
     */
    pressKey(code, shifted = false) {
        if (this._heldKeys.has(code)) return; // already held
        if (this._greeting) this.stopGreeting();

        if (code === 'CapsLock') {
            this.capsLock = !this.capsLock;
        } else if (code === 'Insert') {
            this.insMode = !this.insMode;
        } else if (KANA_KEYS.has(code)) {
            this.kanaMode = !this.kanaMode;
        } else if (code === 'AltLeft') {
            this.graphMode = true;
            this._heldKeys.add(code);
            // GRPH emits a code only in scan code mode.
            if (this._useScanCodes) this._emit(MODIFIER_SCAN.get(code));
            return;
        } else if (code === 'ControlLeft' || code === 'ControlRight') {
            // Sticky CTRL: toggled by the virtual key, released after the
            // next key (see releaseKey). In scan code mode it reads as held
            // from its make code to its break code.
            this._ctrlSticky = !this._ctrlSticky;
            if (this._ctrlSticky) this._stickyCtrlMake();
            else this._stickyCtrlBreak();
            return;
        }

        // The virtual CAP and kana keys are toggles with no release event: in
        // scan code mode they send the make code and then the break code, which
        // waits in the outbox until the make code has been read.
        if (code === 'CapsLock' || KANA_KEYS.has(code)) {
            if (this._useScanCodes) {
                this._emit(MODIFIER_SCAN.get(code));
                if (this._enableBreakCodes) this._emit(MODIFIER_SCAN.get(code) | FM7_KEY_BREAK);
            }
            return;
        }

        const keyCode = this._mapKey(code, shifted, this.ctrlHeld);
        if (keyCode === FM7_KEY_NONE) return;
        this._heldKeys.add(code);
        const sent = keyCode & (this._useScanCodes ? 0x7F : 0x1FF);
        this._emit(sent);
        this._armRepeat(code, sent);
    }

    /**
     * Simulate a key release from a virtual keyboard.
     *
     * @param {string} code - KeyboardEvent.code string
     */
    releaseKey(code) {
        if (code === 'AltLeft') this.graphMode = false;
        if (!this._heldKeys.has(code)) return;
        this._heldKeys.delete(code);
        if (this._repeating && this._repeating.code === code) this._repeating = null;

        const ctrl = this.ctrlHeld;
        // Sticky CTRL from a virtual keyboard lasts for one (non-GRPH) key.
        if (code !== 'AltLeft') this._ctrlSticky = false;

        if (this._enableBreakCodes) {
            const keyCode = this._mapKey(code, false, ctrl);
            if (keyCode !== FM7_KEY_NONE) this._emit((keyCode & 0x7F) | FM7_KEY_BREAK);
        }
        if (code !== 'AltLeft') this._stickyCtrlBreak();
    }

    /** Scan code mode: the make code of the virtual CTRL. */
    _stickyCtrlMake() {
        if (!this._useScanCodes) return;
        this._emit(MODIFIER_SCAN.get('ControlLeft'));
        this._stickyCtrlSent = true;
    }

    /** The break code of the virtual CTRL. */
    _stickyCtrlBreak() {
        if (!this._stickyCtrlSent) return;
        this._stickyCtrlSent = false;
        if (this._enableBreakCodes) {
            this._emit(MODIFIER_SCAN.get('ControlLeft') | FM7_KEY_BREAK);
        }
    }

    /**
     * The sticky SHF of a virtual keyboard. In scan code mode it reads as
     * held from its make code to its break code.
     *
     * @param {string}  code - 'ShiftLeft' or 'ShiftRight'
     * @param {boolean} held - true when SHF was set, false when it ended
     */
    setVirtualShift(code, held) {
        if (held) {
            if (!this._useScanCodes) return;
            this._virtualShift = code;
            this._emit(MODIFIER_SCAN.get(code));
        } else if (this._virtualShift) {
            const make = MODIFIER_SCAN.get(this._virtualShift);
            this._virtualShift = null;
            if (this._enableBreakCodes) this._emit(make | FM7_KEY_BREAK);
        }
    }

    /**
     * BREAK key press / release. The host calls this alongside its BREAK
     * handling (FIRQ); it sends the BREAK make / break code in scan code
     * mode and nothing in ASCII mode.
     *
     * @param {boolean} pressed - true on press, false on release
     */
    breakKeyEvent(pressed) {
        if (!this._useScanCodes) return;
        if (pressed) {
            this._emit(SCAN_BREAK_KEY);
        } else if (this._enableBreakCodes) {
            this._emit(SCAN_BREAK_KEY | FM7_KEY_BREAK);
        }
    }

    // ------------------------------------------------------------------
    // Time (called by the machine every few milliseconds of emulated time)
    // ------------------------------------------------------------------

    /**
     * Advance the encoder's own timing: the codes held back in scan code
     * mode, the auto repeat and the greeting.
     * @param {number} us - emulated microseconds since the last call
     */
    advanceTime(us) {
        this._sendFromOutbox();
        const r = this._repeating;
        if (r && this._repeatOn && !this._useScanCodes) {
            r.waitUs -= us;
            if (r.waitUs <= 0 && !this._strobe) {
                this._emit(r.keyCode);
                const periodUs = this._repeatTimes.periodMs * 1000;
                r.waitUs = Math.max(r.waitUs + periodUs, 0) || periodUs;
            }
        }
        const g = this._greeting;
        if (g) {
            g.waitUs -= us;
            // The next character goes out only after the last one was read.
            if (g.waitUs <= 0 && !this._strobe) {
                this._emit(GREETING_CODES[g.next++]);
                g.waitUs = GREETING_INTERVAL_US;
                if (g.next >= GREETING_CODES.length) {
                    this._greeting = null;
                    if (this.onSingleBeep) this.onSingleBeep();
                }
            }
        }
    }

    /**
     * Repeat timing from KEYBOARD CONTROL sub command $05: each time is the value x 10 ms; $00 for either selects the
     * standard 0.7 s / 0.07 s.
     */
    setRepeatTiming(start, every) {
        const standard = [start, every].includes(0x00);
        this._repeatTimes = standard ? STANDARD_REPEAT : {
            delayMs: start * REPEAT_UNIT_MS,
            periodMs: every * REPEAT_UNIT_MS,
        };
    }

    /**
     * KEYBOARD CONTROL sub command $04: PARAM
     * upper byte $00 = do auto repeat, $01 = do not. Any other value
     * changes nothing.
     */
    selectRepeat(param) {
        if (param === 0x00) this._repeatOn = true;
        else if (param === 0x01) {
            this._repeatOn = false;
            this._repeating = null;
        }
    }

    /**
     * Start repeating a key just pressed, unless it is one that never
     * repeats. The PF keys (bit 8 set in the 9-bit code) do not repeat.
     */
    _armRepeat(code, keyCode) {
        if (NEVER_REPEAT.has(code) || (keyCode & 0x100) || this._useScanCodes) {
            this._repeating = null;
            return;
        }
        this._repeating = { code, keyCode, waitUs: this._repeatTimes.delayMs * 1000 };
    }

    /**
     * CTRL + SHIFT + a digit key: 0 stops and 1 resumes the auto repeat. With
     * GRAPH also held, 7 types the greeting. Returns true when the key was taken by the encoder.
     */
    _encoderChord(code) {
        if (code === 'Digit7' && this.graphMode) {
            this._startGreeting();
            return true;
        }
        const repeat = { Digit0: false, Digit1: true }[code];
        if (repeat === undefined) return false;
        this._repeatOn = repeat;
        this._repeating = null;
        return true;
    }

    // ------------------------------------------------------------------
    // Greeting
    // ------------------------------------------------------------------

    /** True while the greeting is being typed. */
    get greetingActive() {
        return this._greeting !== null;
    }

    _startGreeting() {
        if (this._greeting || this._autoQueue.length > 0) return;
        this._repeating = null;
        this._greeting = { next: 0, waitUs: 0 };
    }

    /** Drop the rest of the greeting (no beep). */
    stopGreeting() {
        this._greeting = null;
    }

    // ------------------------------------------------------------------
    // Auto-type: TXT paste / BASIC program load (via key injection)
    // ------------------------------------------------------------------

    /**
     * Queue text to be auto-typed into the machine. Printable ASCII and TAB
     * are sent as their FM-7 ASCII key codes; newlines become RETURN (0x0D).
     * Other characters are skipped. Nothing is queued while the greeting is
     * being typed.
     *
     * @param {string} text
     * @param {object} [opts]
     * @param {number} [opts.charGap=2]  gap after a normal key (60 Hz frames)
     * @param {number} [opts.lineGap=12] gap after RETURN (60 Hz frames)
     */
    queueText(text, { charGap = 2, lineGap = 12 } = {}) {
        if (this._greeting) return this._autoQueue.length;
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
     * Advance the auto-typer: release the next queued key once the previous
     * one has been consumed and the gap has elapsed.
     *
     * @param {number} [elapsedUs=16667] emulated microseconds since the last
     *        call (one 60 Hz frame by default).
     * @param {boolean} [canRelease=true] false = do not release a key on this
     *        tick (the gap countdown still advances).
     */
    advanceAutoType(elapsedUs = 16667, canRelease = true) {
        if (this._autoWaitUs > 0) {
            this._autoWaitUs -= elapsedUs;
            if (this._autoWaitUs > 0) return;
            this._autoWaitUs = 0;
        }
        if (this._autoQueue.length === 0 || !canRelease) return;
        // The key data register keeps one code and a read
        // drops the key interrupt, so hold the next code
        // until the one before it has been taken.
        if (this._strobe || this._outbox.count > 0) return;
        const next = this._autoQueue.shift();
        this._emit(next.code);
        this._autoWaitUs = next.gap;
    }

    // ------------------------------------------------------------------
    // Key data and the key interrupt
    // ------------------------------------------------------------------

    /** $FD00 / $D400 bit 7: bit 8 of the key data (other bits read 1). */
    readKeyUpper() {
        return (this._keyData & 0x100) ? 0xFF : 0x7F;
    }

    /** $FD01 / $D401: the low 8 bits of the key data. Reading clears the key interrupt. */
    readKeyData() {
        this._strobe = false;
        return this._keyData & 0xFF;
    }

    /** $FD02 bit 0: route the key interrupt to the main CPU (true) or the sub CPU. */
    setInterruptToMain(toMain) {
        this._toMainCPU = !!toMain;
        // A key still unread is signalled at its new destination.
        if (this._toMainCPU && this._strobe && this.onMainInterrupt) this.onMainInterrupt();
    }

    get interruptToMain() {
        return this._toMainCPU;
    }

    /** Main CPU IRQ request ($FD03 bit 0 reads 0 while true). */
    get mainInterrupt() {
        return this._strobe && this._toMainCPU;
    }

    /** Sub CPU FIRQ request (key strobe). */
    get subInterrupt() {
        return this._strobe && !this._toMainCPU;
    }

    /** Forget the codes not yet sent (reset, change of code mode). */
    dropPendingCodes() {
        this._outbox.clear();
    }

    /** True when a key waits to be read. */
    hasKey() {
        return this._strobe;
    }

    /** Key data latch, for display. */
    latchedKeyData() {
        return this._keyData;
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

    /** Clear all custom key remappings. */
    clearCustomMap() {
        this._customMap.clear();
    }

    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------

    /**
     * Reset the key input state (the auto-type queue is kept). The key
     * interrupt goes to the sub CPU ($FD02 = $00 at power on).
     * A key still held down keeps its code in the key data, without the
     * strobe, so the program started by the reset can see which key is held.
     */
    reset() {
        const held = [...this._heldKeys];
        const shifted = this._heldModifiers.has('ShiftLeft') || this._heldModifiers.has('ShiftRight');
        const ctrl = this._heldModifiers.has('ControlLeft') || this._heldModifiers.has('ControlRight');
        this._keyData = 0x000;
        this._strobe = false;
        this.dropPendingCodes();
        this._toMainCPU = false;
        this._heldKeys.clear();
        this._heldModifiers.clear();
        this.capsLock = false;
        this.kanaMode = false;
        this.insMode = false;
        this.graphMode = false;
        this._ctrlSticky = false;
        this._stickyCtrlSent = false;
        this._virtualShift = null;
        this._repeatOn = true;
        this._repeatTimes = STANDARD_REPEAT;
        this._repeating = null;
        this._greeting = null;
        this._keyData = this._codeOfKeyHeldAtReset(held, shifted, ctrl);
    }

    /** Code of the last pressed key in `held` (modes already reset), or 0. */
    _codeOfKeyHeldAtReset(held, shifted, ctrl) {
        for (let i = held.length - 1; i >= 0; i--) {
            const keyCode = this._mapKey(held[i], shifted, ctrl);
            if (keyCode !== FM7_KEY_NONE) return keyCode & (this._useScanCodes ? 0x7F : 0x1FF);
        }
        return 0x000;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    /**
     * Map a PC KeyboardEvent.code to an FM-7 key code.
     *
     * @param {string}  code     - KeyboardEvent.code
     * @param {boolean} shifted  - true if Shift is held
     * @param {boolean} [ctrl]   - true if CTRL is held
     * @returns {number} FM-7 key code, or FM7_KEY_NONE if unmapped
     */
    _mapKey(code, shifted, ctrl = false) {
        const host = this._customMap.get(code) || code;
        if (this._useScanCodes) return this._scanCodeOf(code, host, ctrl);

        const rec = KEYCAPS.get(host);
        if (!rec) return FM7_KEY_NONE;
        const state = (ctrl ? 8 : 0) | (this.graphMode ? 4 : 0)
            | (this.kanaMode ? 2 : 0) | (shifted ? 1 : 0);
        for (const field of FIELDS_BY_HELD_STATE[state]) {
            if (rec[field] === undefined) continue;
            return field === 'ascii' ? this._withCaps(rec.ascii) : rec[field];
        }
        return FM7_KEY_NONE;
    }

    /**
     * Scan code mode: the code is the key's matrix position whatever the
     * modifiers, except that CTRL + / gives the key right of / (" _; US
     * layouts lack it).
     */
    _scanCodeOf(code, host, ctrl) {
        if (ctrl && host === 'Slash') return CTRL_SLASH_SCAN;
        if (MODIFIER_SCAN.has(code)) return MODIFIER_SCAN.get(code);
        return CODE_TO_FM7_SCAN.get(host) ?? FM7_KEY_NONE;
    }

    /** CAP: lower-case letters are sent as capitals. */
    _withCaps(ascii) {
        const lower = ascii >= 0x61 && ascii <= 0x7A;
        return (this.capsLock && lower) ? ascii - 0x20 : ascii;
    }

    /**
     * The encoder sends a code. In the 9-bit modes the key data takes it at
     * once, over a code not yet read. In scan code mode it joins the outbox,
     * and goes on to the key data straight away only when it is alone there.
     */
    _emit(keyCode) {
        if (!this._useScanCodes) {
            this._latch(keyCode);
            return;
        }
        this._outbox.put(keyCode);
        if (this._outbox.count === 1) this._sendFromOutbox();
    }

    /** The oldest code in the outbox moves on once the key data has been read. */
    _sendFromOutbox() {
        if (this._outbox.count === 0 || this._strobe) return;
        this._latch(this._outbox.take());
    }

    /** A code reaches the key data. */
    _latch(keyCode) {
        this._keyData = keyCode;
        this._strobe = true;
        if (this._toMainCPU && this.onMainInterrupt) this.onMainInterrupt();
    }
}

// Export key code constants for external use
export {
    FM7_KEY_NONE, FM7_KEY_BREAK,
    FM7_KEY_SPACE, FM7_KEY_RETURN, FM7_KEY_ESC, FM7_KEY_BS, FM7_KEY_TAB, FM7_KEY_DEL,
    FM7_KEY_LEFT, FM7_KEY_RIGHT, FM7_KEY_UP, FM7_KEY_DOWN, FM7_KEY_HOME,
    FM7_KEY_F1, FM7_KEY_F2, FM7_KEY_F3, FM7_KEY_F4, FM7_KEY_F5,
    FM7_KEY_F6, FM7_KEY_F7, FM7_KEY_F8, FM7_KEY_F9, FM7_KEY_F10,
    CODE_TO_FM7_ASCII, CODE_TO_FM7_SCAN, SHIFTED_OVERRIDE, CTRL_OVERRIDE,
    GRAPH_MODE_CODES, GRAPH_MODE_SHIFT_CODES,
    KANA_OVERRIDE, KANA_SHIFT_OVERRIDE,
};
