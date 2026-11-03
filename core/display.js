// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// FM-7 / FM77AV / FM77AV40 Display System for Web Simulator
// Handles VRAM, TTL/analog palette, sub CPU memory, and RGBA frame rendering (output goes to a frame sink).
// Includes the FM77AV logic unit ($D410-$D41E), the line engine ($D420-$D42B),
// the VRAM offset registers, and the 400-line / 262,144-color formats.
// Shared RAM is handled in fm7.js.

// ---------------------------------------------------------------------------
//  Memory layout
// ---------------------------------------------------------------------------
const BANK_SIZE       = 0xC000;  // one VRAM bank: 48KB as seen at sub $0000-$BFFF
const MAX_BANKS       = 4;       // AV40 family carries 192KB = 4 banks
const WORK_RAM_BASE   = 0xC000;
const WORK_RAM_END    = 0xD37F;
const IO_BASE         = 0xD400;
const IO_LAST         = 0xD43F;

const SCREEN_WIDTH    = 640;
const SCREEN_HEIGHT   = 200;
const SCREEN_HEIGHT_400 = 400;
const ROW_BYTES      = 80;  // 640 dots / 8
const ROW_BYTES_320  = 40;  // 320 dots / 8

// Display formats
const DISPLAY_MODE_640  = 0;  // 640x200, 8 colors
const DISPLAY_MODE_320  = 1;  // 320x200, 4096 colors
const DISPLAY_MODE_262K = 2;  // 320x200, 262,144 colors
const DISPLAY_MODE_400  = 3;  // 640x400, 8 colors

// VRAM offset register: OA13-OA0, of which OA4-OA0 are gated by OA.
const OFFSET_COARSE    = 0x3FE0;

// One VRAM cycle: 8 periods of the 16.128 MHz reference clock (FM77AV
// Hardware Manual 8.4.2 (1), the VRAM access timing figure; about 0.5 us).
const VRAM_CYCLE_US = 8 / 16.128;

// Physical RGB colors for TTL 8-color mode (GRB bit order)
// Index = (G << 2) | (R << 1) | B
const PHYSICAL_COLORS = [
    0xFF000000, // 0: Black    (ABGR for little-endian Uint32Array)
    0xFFFF0000, // 1: Blue
    0xFF0000FF, // 2: Red
    0xFFFF00FF, // 3: Magenta
    0xFF00FF00, // 4: Green
    0xFFFFFF00, // 5: Cyan
    0xFF00FFFF, // 6: Yellow
    0xFFFFFFFF, // 7: White
];

// Logic unit commands, $D410 bits 2-0
const LOGIC_PSET    = 0;
// Command 1 is marked prohibited in FM77AV Hardware Manual 8.4.1; here it
// writes 0 to the unmasked bits.
const LOGIC_COMMAND_1 = 1;
const LOGIC_OR      = 2;
const LOGIC_AND     = 3;
const LOGIC_XOR     = 4;
const LOGIC_NOT     = 5;
const LOGIC_TILE    = 6;
const LOGIC_COMPARE = 7;

/**
 * Default frame sink: keeps one RGBA frame in memory. Used when no host
 * (browser) sink is attached, e.g. headless tests that inspect pixels.
 */
export class MemoryFrameSink {
    constructor() { this._frame = null; }
    acquireFrame(w, h) {
        if (!this._frame || this._frame.width !== w || this._frame.height !== h) {
            this._frame = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        return this._frame;
    }
    present(_frame, _x, _y, _w, _h) { /* nothing to do: the frame is the output */ }
}

export {
    SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_HEIGHT_400,
    DISPLAY_MODE_640, DISPLAY_MODE_320, DISPLAY_MODE_262K, DISPLAY_MODE_400,
};

export class Display {
    constructor() {
        // VRAM: up to four 48KB banks. How many the machine has is
        // set by setMachineFeatures(); the arrays always exist.
        this.vramBanks = [];
        for (let i = 0; i < MAX_BANKS; i++) this.vramBanks.push(new Uint8Array(BANK_SIZE));

        // Sub CPU work RAM $C000-$D37F (4992 bytes), and the separate block
        // at $D500-$D7FF (768 bytes) that only the FM77AV series has.
        this.workRam     = new Uint8Array(WORK_RAM_END - WORK_RAM_BASE + 1);
        this.workRamD500 = new Uint8Array(0x0300);

        // TTL Palette: 8 entries, each maps logical color -> physical color
        this.palette = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }

        // Resolved palette: logical index -> ABGR uint32
        this._resolvedPalette = new Uint32Array(8);
        this._rebuildResolvedPalette();

        // FM77AV analog palette: 4096 entries, stored externally in fm7.js
        this.palette4096 = null;       // Uint16Array(4096), set by fm7.js
        this._resolvedAnalogPalette = new Uint32Array(4096);
        this._analogDirty = true;        // Rebuild _resolvedAnalogPalette only when palette changed

        // ---- Machine features (setMachineFeatures) ----
        this.hasLogicUnit = false;   // $D410-$D42B present (FM77AV and later)
        this.bankCount    = 1;       // VRAM banks fitted
        this.has262kColor = false;   // AV40 family
        this.has400Line   = false;   // AV40 family
        this.hasExRegisters = false; // $D433, $D438-$D43F

        // ---- $D430 write side, display part ----
        this.pageControl      = 0;     // last value written to $D430
        this.shownPage        = 0;     // DB: page shown in 640x200
        this.cpuPage          = 0;     // AB: bank the CPU reads/writes; offset register target
        this.fineOffsetEnable = false; // OA: OA4-OA0 take effect

        // ---- VRAM offset registers, one per bank 0/1 ----
        this.offsetRegister = new Uint16Array(2);

        // ---- $D42F VRAM bank ----
        this.planeBank = 0;

        // ---- Display format inputs ----
        this.columns320  = false;   // $FD12 bit 6
        this.formatByte  = 0x08;    // last $FD04 write seen by the display (bit 3 = 1: 200 lines)
        this.displayMode = DISPLAY_MODE_640;

        // ---- $D433: while bit 0 is 1, drawing is kept off the screen ----
        this.holdPicture = false;
        // ---- hardware window $D438-$D43F: stored only ----
        this.windowRegisters = new Uint8Array(8);

        // Multi-page register ($FD37, written by fm7.js).
        // bits 2-0: CPU access to B/R/G disabled; bits 6-4: B/R/G hidden on screen.
        this.planeMaskBits = 0;

        // ---- Logic unit $D410-$D41E ----
        this.logicCommand  = 0;                    // $D410
        this.logicColor    = 0;                    // $D411
        this.logicMask     = 0;                    // $D412
        this.colorMatchBits = 0;                   // $D413 (read)
        this.compareRegisters = new Uint8Array(8); // $D413-$D41A (write)
        this.bankDisable   = 0;                    // $D41B
        this.tilePattern   = new Uint8Array(3);    // $D41C-$D41E (B, R, G)
        // scratch: the three plane positions of one logic operation
        this._opBank  = new Int32Array(3);
        this._opIndex = new Int32Array(3);

        // ---- Line engine $D420-$D42B ----
        this.lineAddressOffset = 0;   // byte offset (register value x 2)
        this.lineStylePattern  = 0;
        this.lineStartX = 0;
        this.lineStartY = 0;
        this.lineEndX   = 0;
        this.lineEndY   = 0;
        this.lineRemainingUs = 0;     // BUSY time left

        // CRT and VRAM access flags (sub CPU I/O side effects)
        // The CRT display turns on when $D408 is read and off when it is
        // written; a reset and a sub CPU reset ($FD13) also turn it off.
        // vramAccessEnabled: VRAM access from the sub CPU ($D409 read enables,
        // write disables).  It is separate from the CRT on/off and does not
        // affect drawing.
        this.crtOn = false;
        this.vramAccessEnabled = false;
        // insLedOn: the keyboard INS LED ($D40D read turns it on, write turns
        // it off; a reset and a sub CPU reset turn it off).
        this.insLedOn = false;
        // $D405 bit 0: the sub CPU's VRAM access uses the
        // second half of each CPU cycle instead of waiting for blanking.
        // Only machines with hasSubVramModeSelect have the register.
        this.subVramFastAccess = false;

        // Dirty tracking (50 bands = 400 lines / 8; 200-line modes use first 25)
        this._dirtyBands = new Uint8Array(50);
        this._fullDirty = true;

        // VSync frame counter
        this.frameCount = 0;

        // Frame output. render() draws RGBA pixels into a frame obtained from
        // `frameSink` ({ acquireFrame(w, h), present(frame, x, y, w, h) }).
        // The default sink keeps the frame in memory (headless / tests); the
        // browser UI supplies a sink backed by a canvas ImageData.
        this.frameSink = new MemoryFrameSink();
        this._frame = null;      // current frame ({ width, height, data: Uint8ClampedArray })
        this._pixelBuf = null;   // Uint32 view over _frame.data
    }

    /** The most recently rendered frame ({ width, height, data }) or null. */
    get frame() { return this._frame; }

    /**
     * Make sure the current frame has the requested size. A new frame (from
     * the sink) forces a full redraw.
     */
    _acquireFrame(w, h) {
        const frame = this.frameSink.acquireFrame(w, h);
        if (frame !== this._frame || !this._pixelBuf) {
            this._frame = frame;
            this._pixelBuf = new Uint32Array(frame.data.buffer, frame.data.byteOffset, w * h);
            this._fullDirty = true;
        }
    }

    /** Hand a rectangle of the current frame to the sink. */
    _present(x, y, w, h) {
        this.frameSink.present(this._frame, x, y, w, h);
    }

    /** Hand the whole current frame to the sink. */
    _presentFull() {
        const f = this._frame;
        this.frameSink.present(f, 0, 0, f.width, f.height);
    }

    // ---------------------------------------------------------------
    //  Resolved palette cache
    // ---------------------------------------------------------------

    _rebuildResolvedPalette() {
        for (let i = 0; i < 8; i++) {
            this._resolvedPalette[i] = PHYSICAL_COLORS[this.palette[i] & 7];
        }
        this._fullDirty = true;
    }

    // ---------------------------------------------------------------
    //  Machine features
    // ---------------------------------------------------------------

    /**
     * Declare what the machine carries.
     * @param {object} f
     * @param {boolean} f.logicUnit  - logic unit and line engine ($D410-$D42B)
     * @param {number}  f.banks      - VRAM banks of 48KB (1..4)
     * @param {boolean} f.color262k  - 320x200 262,144-color format
     * @param {boolean} f.line400    - 640x400 format and $D433/$D438-$D43F
     */
    setMachineFeatures({ logicUnit = false, banks = 1, color262k = false, line400 = false } = {}) {
        this.hasLogicUnit = !!logicUnit;
        this.bankCount = Math.max(1, Math.min(MAX_BANKS, banks | 0));
        this.has262kColor = !!color262k && this.bankCount >= 3;
        this.has400Line = !!line400 && this.bankCount >= 3;
        this.hasExRegisters = !!line400;
        this._updateDisplayMode();
    }

    // ---------------------------------------------------------------
    //  Display format
    // ---------------------------------------------------------------

    /** $FD12 bit 6: 1 = 320x200 4096 colors, 0 = 640x200. */
    setColumns320(on) {
        this.columns320 = !!on;
        this._updateDisplayMode();
    }

    /** $FD04 write on machines with the extended formats. */
    writeFormatByte(value) {
        this.formatByte = value & 0xFF;
        this._updateDisplayMode();
    }

    _updateDisplayMode() {
        const lines200 = (this.formatByte & 0x08) !== 0;
        let mode;
        if (this.has262kColor && lines200 && (this.formatByte & 0x10)) {
            mode = DISPLAY_MODE_262K;
        } else if (this.has400Line && !lines200) {
            mode = DISPLAY_MODE_400;
        } else {
            mode = this.columns320 ? DISPLAY_MODE_320 : DISPLAY_MODE_640;
        }
        if (mode !== this.displayMode) {
            this.displayMode = mode;
            this._fullDirty = true;
            this._frame = null;   // frame size may change
        }
    }

    // ---------------------------------------------------------------
    //  $D430 write side, display bits
    // ---------------------------------------------------------------

    /** Take DB (bit 6), AB (bit 5) and OA (bit 2) from a $D430 write. */
    writePageControl(value) {
        this.pageControl = value & 0xFF;
        this.selectPages((value >> 5) & 1, (value >> 6) & 1);
        this.fineOffsetEnable = (value & 0x04) !== 0;
    }

    /** Set AB and DB directly (AB on a single-bank machine stays 0). */
    selectPages(cpu, shown) {
        this.cpuPage = (this.bankCount > 1) ? (cpu & 1) : 0;
        shown &= 1;
        if (shown !== this.shownPage) {
            this.shownPage = shown;
            this._fullDirty = true;
        }
    }

    // ---------------------------------------------------------------
    //  VRAM offset
    // ---------------------------------------------------------------

    /** Stored offset of `bank`; changing OA does not rewrite either register. */
    _effectiveOffset(bank) {
        return this.offsetRegister[bank];
    }

    /** $D40E: OA13-OA8 into the register of the bank chosen by AB. */
    _writeOffsetUpper(value) {
        const b = this.cpuPage;
        this.offsetRegister[b] = ((value & 0x3F) << 8) | (this.offsetRegister[b] & 0xFF);
        this._fullDirty = true;
    }

    /** $D40F: OA7-OA0 into the register of the bank chosen by AB. */
    _writeOffsetLower(value) {
        const b = this.cpuPage;
        // FM77AV Hardware Manual 8.4.2 (2): OA controls OA4-OA0 in $D40F (W).
        const low = value & (this.fineOffsetEnable ? 0xFF : OFFSET_COARSE);
        this.offsetRegister[b] = (this.offsetRegister[b] & 0x3F00) | (low & 0xFF);
        this._fullDirty = true;
    }

    // ---------------------------------------------------------------
    //  CPU view of VRAM
    // ---------------------------------------------------------------

    /**
     * Bank and index that a sub CPU address $0000-$BFFF reaches. The index
     * is returned; the bank is left in this._hitBank.
     */
    _locate(a) {
        switch (this.displayMode) {
            case DISPLAY_MODE_400:
                // $D42F picks the plane; offset counts 2 bytes per unit
                this._hitBank = this.planeBank;
                if (a >= 0x8000) return a;
                return (a + this._effectiveOffset(0) * 2) & 0x7FFF;
            case DISPLAY_MODE_262K:
                // $D42F picks the bank; 8KB planes wrap like 320 mode
                this._hitBank = this.planeBank;
                return (a & 0xE000) | ((a + this._effectiveOffset(0)) & 0x1FFF);
            case DISPLAY_MODE_320: {
                // 8KB planes, OA13 unused
                const b = this.cpuPage;
                this._hitBank = b;
                return (a & 0xE000) | ((a + this._effectiveOffset(b)) & 0x1FFF);
            }
            default: {
                // 16KB planes
                const b = this.cpuPage;
                this._hitBank = b;
                return (a & 0xC000) | ((a + this._effectiveOffset(b)) & 0x3FFF);
            }
        }
    }

    /** Color plane (0 = B, 1 = R, 2 = G) addressed by a CPU access, for the $FD37 access mask. */
    _accessPlane(a) {
        if (this.displayMode === DISPLAY_MODE_400) return this.planeBank;
        return a >> 14;
    }

    /** Sub CPU read of VRAM $0000-$BFFF. */
    cpuReadVram(a) {
        a &= 0xFFFF;
        if (a >= BANK_SIZE) return 0xFF;
        const i = this._locate(a);
        const before = this.vramBanks[this._hitBank][i];
        // with EST = 1 a read is the dummy read that runs the operation
        if ((this.logicCommand & 0x80) && this.hasLogicUnit) {
            this._operateAt(a, ~this.logicMask & 0xFF);
        }
        if (this._planeClosed(this._accessPlane(a))) return 0xFF;
        return before;
    }

    /** Sub CPU write of VRAM $0000-$BFFF; EST selects an operation instead of CPU data. */
    cpuWriteVram(a, value) {
        a &= 0xFFFF;
        if (a >= BANK_SIZE) return;
        if ((this.logicCommand & 0x80) && this.hasLogicUnit && this.displayMode !== DISPLAY_MODE_262K) {
            this._operateAt(a, ~this.logicMask & 0xFF);
            return;
        }
        if (this._planeClosed(this._accessPlane(a))) return;
        const i = this._locate(a);
        const bank = this._hitBank;
        const mem = this.vramBanks[bank];
        if (mem[i] !== value) {
            mem[i] = value;
            this._touch(bank, i);
        }
    }

    /**
     * $FD37 bits 2-0 close plane B, R, G to the CPU side (FM-7 system spec
     * 1.7): a closed plane reads "FF" and its data cannot be changed.
     */
    _planeClosed(plane) {
        return ((this.planeMaskBits >> plane) & 1) !== 0;
    }

    /** CPU-side read of one plane byte: "FF" while the plane is closed (FM-7 system spec 1.7). */
    _planeRead(plane, bank, i) {
        return this._planeClosed(plane) ? 0xFF : this.vramBanks[bank][i];
    }

    /** CPU-side write of one plane byte: dropped while the plane is closed (FM-7 system spec 1.7). */
    _planeWrite(plane, bank, i, value) {
        if (this._planeClosed(plane)) return;
        const mem = this.vramBanks[bank];
        if (mem[i] === value) return;
        mem[i] = value;
        this._touch(bank, i);
    }

    /** Mark the screen band that shows bank/index for redraw. */
    _touch(bank, i) {
        let line;
        switch (this.displayMode) {
            case DISPLAY_MODE_400:
                if (bank > 2 || i >= 0x8000) return;
                line = ((i - this._effectiveOffset(0) * 2) & 0x7FFF) / ROW_BYTES;
                if (line >= SCREEN_HEIGHT_400) return;
                break;
            case DISPLAY_MODE_262K:
                if (bank > 2) return;
                line = ((i - this._effectiveOffset(0)) & 0x1FFF) / ROW_BYTES_320;
                break;
            case DISPLAY_MODE_320:
                if (bank > 1) return;
                line = ((i - this._effectiveOffset(bank)) & 0x1FFF) / ROW_BYTES_320;
                break;
            default:
                if (bank !== this._shownBank()) return;
                line = ((i - this._effectiveOffset(bank)) & 0x3FFF) / ROW_BYTES;
                break;
        }
        line |= 0;
        if (line < SCREEN_HEIGHT || (this.displayMode === DISPLAY_MODE_400 && line < SCREEN_HEIGHT_400)) {
            this._dirtyBands[line >> 3] = 1;
        }
    }

    /** Bank shown in 640x200 (DB; single-bank machines always show bank 0). */
    _shownBank() {
        return this.bankCount > 1 ? this.shownPage : 0;
    }

    // ---------------------------------------------------------------
    //  Logic unit
    // ---------------------------------------------------------------

    /**
     * Run the current $D410 command on the three color planes behind
     * address `a`. `writeMask` has 1 for each dot that may change:
     * the inverse of $D412 for a CPU access, a single dot for the line engine.
     */
    _operateAt(a, writeMask) {
        const cmd = this.logicCommand & 7;
        const banks = this._opBank, idx = this._opIndex;
        switch (this.displayMode) {
            case DISPLAY_MODE_262K:
                return;                                // no logic operation
            case DISPLAY_MODE_400: {
                const i = ((a & 0x7FFF) + this._effectiveOffset(0) * 2) & 0x7FFF;
                for (let p = 0; p < 3; p++) { banks[p] = p; idx[p] = i; }
                break;
            }
            case DISPLAY_MODE_320: {
                const b = this.cpuPage;
                const i = (a & 0x2000) | ((a + this._effectiveOffset(b)) & 0x1FFF);
                for (let p = 0; p < 3; p++) { banks[p] = b; idx[p] = p * 0x4000 + i; }
                break;
            }
            default: {
                const b = this.cpuPage;
                const i = (a + this._effectiveOffset(b)) & 0x3FFF;
                for (let p = 0; p < 3; p++) { banks[p] = b; idx[p] = p * 0x4000 + i; }
                break;
            }
        }
        const vb = this.vramBanks;
        // The unit works through CPU accesses to the three planes, so it
        // reads and writes them with _planeRead / _planeWrite, which apply the
        // $FD37 access flags of any CPU access.
        const planeByte = [0, 1, 2].map((p) => this._planeRead(p, banks[p], idx[p]));
        let mask = writeMask & 0xFF;

        // compare for command 111, or before any command when M1 = 1
        const m1 = (this.logicCommand & 0x40) !== 0;
        if (cmd === LOGIC_COMPARE || m1) {
            const eq = this._matchColors(planeByte[0], planeByte[1], planeByte[2]);
            this.colorMatchBits = eq;
            if (cmd === LOGIC_COMPARE) return;
            mask &= (this.logicCommand & 0x20) ? ~eq : eq;
        }
        if (mask === 0) return;

        for (let p = 0; p < 3; p++) {
            // $D41B leaves a plane out of the operation.
            if ((this.bankDisable >> p) & 1) continue;
            const i = idx[p];
            const v = vb[banks[p]][i];
            const c = (this.logicColor & (1 << p)) ? 0xFF : 0x00;
            let n;
            switch (cmd) {
                case LOGIC_PSET: n = c; break;
                case LOGIC_COMMAND_1: n = 0; break;
                case LOGIC_OR:   n = v | c; break;
                case LOGIC_AND:  n = v & c; break;
                case LOGIC_XOR:  n = v ^ c; break;
                case LOGIC_NOT:  n = ~v; break;
                case LOGIC_TILE: n = this.tilePattern[p]; break;
                default: return;
            }
            this._planeWrite(p, banks[p], i, ((v & ~mask) | (n & mask)) & 0xFF);
        }
    }

    /**
     * One bit per dot, 1 when the dot's color
     * (G, R, B taken from all three planes) equals the color of any compare
     * register whose MSK bit is 0.
     */
    _matchColors(b, r, g) {
        let hits = 0;
        for (let k = 0; k < 8; k++) {
            const reg = this.compareRegisters[k];
            if (reg & 0x80) continue;
            const blue  = (reg & 1) ? b : ~b;
            const red   = (reg & 2) ? r : ~r;
            const green = (reg & 4) ? g : ~g;
            hits |= blue & red & green;
        }
        return hits & 0xFF;
    }

    // ---------------------------------------------------------------
    //  Line engine
    // ---------------------------------------------------------------

    /** LINE bit of $D430 (1 = READY). */
    get lineReady() {
        return this.lineRemainingUs <= 0;
    }

    /** Let `us` microseconds of BUSY time pass. */
    advanceLineEngine(us) {
        if (this.lineRemainingUs > 0) {
            this.lineRemainingUs -= us;
            if (this.lineRemainingUs < 0) this.lineRemainingUs = 0;
        }
    }

    /** Draw from (X0,Y0) to (X1,Y1) inclusive, started by the $D42B write. */
    _drawLine() {
        const wide = this.displayMode === DISPLAY_MODE_640 || this.displayMode === DISPLAY_MODE_400;
        const width  = wide ? SCREEN_WIDTH : 320;
        const height = this.displayMode === DISPLAY_MODE_400 ? SCREEN_HEIGHT_400 : SCREEN_HEIGHT;
        const stride = wide ? ROW_BYTES : ROW_BYTES_320;
        const base = this.lineAddressOffset;
        const style = this.lineStylePattern;

        let x = this.lineStartX, y = this.lineStartY;
        const tx = this.lineEndX, ty = this.lineEndY;
        const dx = Math.abs(tx - x), dy = Math.abs(ty - y);
        const sx = tx >= x ? 1 : -1, sy = ty >= y ? 1 : -1;
        let err = dx - dy;
        // The line engine steps through every position of the line and runs
        // the logic unit there; the line style only decides whether the dot
        // is written (Hardware Manual 8.4.1 (2)). Each step takes one VRAM
        // cycle of BUSY time.
        let busyUs = 0;
        let dots = 0;
        for (;;) {
            busyUs += VRAM_CYCLE_US;
            // P15 first, one bit per dot
            if ((style >> (15 - (dots & 15))) & 1) {
                // dots off the screen are not drawn
                if (x < width && y < height) {
                    // address offset + y * line bytes + x / 8, $D412 not used
                    this._operateAt(base + y * stride + (x >> 3), 0x80 >> (x & 7));
                }
            }
            dots++;
            if (x === tx && y === ty) break;
            const e2 = err * 2;
            if (e2 > -dy) { err -= dy; x += sx; }
            if (e2 < dx)  { err += dx; y += sy; }
        }
        this.lineRemainingUs = busyUs;
    }

    // ---------------------------------------------------------------
    //  Logic unit / line engine / extension registers: $D410-$D43F
    // ---------------------------------------------------------------

    /** Reads of $D410-$D43F that belong to the display. */
    _readExtension(addr) {
        if (this.hasLogicUnit) {
            switch (addr) {
                case 0xD410: return this.logicCommand;
                case 0xD411: return this.logicColor;
                case 0xD412: return this.logicMask;
                case 0xD413: return this.colorMatchBits;
                case 0xD41B: return this.bankDisable;
            }
        }
        // write-only registers, $D42F, $D433 and the window read as $FF
        return 0xFF;
    }

    /** Writes of $D410-$D43F that belong to the display. */
    _writeExtension(addr, value) {
        if (addr <= 0xD42B) {
            if (this.hasLogicUnit) this._writeLogicOrLine(addr, value);
            return;
        }
        if (addr === 0xD42F) {
            // bits 1-0 pick a 48KB bank; a bank the machine lacks is ignored
            if (this.bankCount >= 3) {
                const b = value & 3;
                if (b < this.bankCount && b !== this.planeBank) {
                    this.planeBank = b;
                }
            }
            return;
        }
        if (!this.hasExRegisters) return;
        if (addr === 0xD433) {
            // bit 0 = 1 holds the picture; going back to 0 shows
            // everything drawn meanwhile (the dirty bands are kept)
            this.holdPicture = (value & 0x01) !== 0;
            return;
        }
        if (addr >= 0xD438) {
            this.windowRegisters[addr - 0xD438] = value;   // stored only
        }
    }

    _writeLogicOrLine(addr, value) {
        if (addr >= 0xD413 && addr <= 0xD41A) {
            this.compareRegisters[addr - 0xD413] = value;
            return;
        }
        switch (addr) {
            case 0xD410: this.logicCommand = value; return;
            case 0xD411: this.logicColor = value; return;
            case 0xD412: this.logicMask = value; return;
            case 0xD41B: this.bankDisable = value; return;
            case 0xD41C: this.tilePattern[0] = value; return;
            case 0xD41D: this.tilePattern[1] = value; return;
            case 0xD41E: this.tilePattern[2] = value; return;
            // Line address offset: $D420 bits 4-0 = A13-A9, $D421 = A8-A1,
            // kept as a byte offset. Source: FM77AV Hardware Manual, chapter 4
            // (sub system I/O address map) and chapter 8 (line interpolation
            // registers; the write to $D42B starts the line).
            case 0xD420:
                this.lineAddressOffset = ((value & 0x1F) << 9) | (this.lineAddressOffset & 0x01FE);
                return;
            case 0xD421:
                this.lineAddressOffset = (this.lineAddressOffset & 0x3E00) | (value << 1);
                return;
            case 0xD422: this.lineStylePattern = (value << 8) | (this.lineStylePattern & 0xFF); return;
            case 0xD423: this.lineStylePattern = (this.lineStylePattern & 0xFF00) | value; return;
            case 0xD424: this.lineStartX = ((value & 0x03) << 8) | (this.lineStartX & 0xFF); return;
            case 0xD425: this.lineStartX = (this.lineStartX & 0x300) | value; return;
            case 0xD426: this.lineStartY = ((value & 0x01) << 8) | (this.lineStartY & 0xFF); return;
            case 0xD427: this.lineStartY = (this.lineStartY & 0x100) | value; return;
            case 0xD428: this.lineEndX = ((value & 0x03) << 8) | (this.lineEndX & 0xFF); return;
            case 0xD429: this.lineEndX = (this.lineEndX & 0x300) | value; return;
            case 0xD42A: this.lineEndY = ((value & 0x01) << 8) | (this.lineEndY & 0xFF); return;
            case 0xD42B:
                this.lineEndY = (this.lineEndY & 0x100) | value;
                this._drawLine();                       // starts on this write
                return;
        }
    }

    // ---------------------------------------------------------------
    //  Sub CPU memory read/write  ($0000 - $D43F)
    // ---------------------------------------------------------------

    read(addr) {
        addr &= 0xFFFF;
        if (addr < BANK_SIZE) {
            return this.cpuReadVram(addr);
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            return this.workRam[addr - WORK_RAM_BASE];
        }
        if (addr >= IO_BASE && addr <= IO_LAST) {
            const result = this.readIO(addr);
            return result.value;
        }
        return 0xFF;
    }

    write(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;
        if (addr < BANK_SIZE) {
            this.cpuWriteVram(addr, value);
            return;
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            this.workRam[addr - WORK_RAM_BASE] = value;
            return;
        }
        if (addr >= IO_BASE && addr <= IO_LAST) {
            this.writeIO(addr, value);
            return;
        }
    }

    // ---------------------------------------------------------------
    //  I/O register read ($D400 - $D43F)
    // ---------------------------------------------------------------

    readIO(addr) {
        addr &= 0xFFFF;

        switch (addr) {
            case 0xD403:
                return { value: 0xFF, sideEffect: 'beep' };
            case 0xD408:
                // CRT display on (read of $D408).
                if (!this.crtOn) {
                    this.crtOn = true;
                    this._lastBlank = false;
                    this._fullDirty = true;
                }
                return { value: 0xFF };
            case 0xD409:
                // VRAM access enabled (read).  Separate from crtOn; it does not
                // decide whether the screen is drawn.
                this.vramAccessEnabled = true;
                return { value: 0xFF };
            case 0xD40D:
                this.insLedOn = true;
                return { value: 0xFF };
        }
        if (addr >= 0xD410 && addr <= IO_LAST) {
            return { value: this._readExtension(addr) };
        }
        // $D40E / $D40F and the rest read as $FF
        return { value: 0xFF };
    }

    // ---------------------------------------------------------------
    //  I/O register write ($D400 - $D43F)
    // ---------------------------------------------------------------

    writeIO(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;

        switch (addr) {
            case 0xD408:
                // CRT display off (write)
                this.crtOn = false;
                this._lastBlank = false;
                return {};
            case 0xD409:
                // VRAM access disabled (write).  crtOn is left alone.
                this.vramAccessEnabled = false;
                return {};
            case 0xD40D:
                this.insLedOn = false;
                return {};
            case 0xD40E:
                this._writeOffsetUpper(value);
                return {};
            case 0xD40F:
                this._writeOffsetLower(value);
                return {};
        }
        if (addr >= 0xD410 && addr <= IO_LAST) {
            this._writeExtension(addr, value);
        }
        return {};
    }

    // ---------------------------------------------------------------
    //  Palette
    // ---------------------------------------------------------------

    readPalette(index) {
        index &= 7;
        return this.palette[index];
    }

    writePalette(index, value) {
        index &= 7;
        // bits 2-0 are G, R, B.
        value &= 0x07;
        if (this.palette[index] !== value) {
            this.palette[index] = value;
            this._rebuildResolvedPalette();
        }
    }

    resetPalette() {
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }
        this._rebuildResolvedPalette();
    }

    // ---------------------------------------------------------------
    //  Border color
    // ---------------------------------------------------------------

    /**
     * Color of the border area around the VRAM display area, as a CSS
     * "#rrggbb" string. It is the color of palette number 0 (FM77AV
     * Hardware Manual 8.3.1), or of analog palette number 0 in the
     * 320 x 200 4096-color mode (8.3.2).
     */
    get borderColor() {
        let r, g, b;
        if (this.displayMode === DISPLAY_MODE_320 && this.palette4096) {
            const entry = this.palette4096[0];      // G, R, B: 4 bits each
            g = ((entry >> 8) & 0x0F) * 17;
            r = ((entry >> 4) & 0x0F) * 17;
            b = (entry & 0x0F) * 17;
        } else {
            const abgr = PHYSICAL_COLORS[this.palette[0] & 7];
            r = abgr & 0xFF;
            g = (abgr >> 8) & 0xFF;
            b = (abgr >> 16) & 0xFF;
        }
        return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
    }

    // ---------------------------------------------------------------
    //  FM77AV: Analog palette
    // ---------------------------------------------------------------

    rebuildAnalogPalette(palette4096) {
        // Convert analog palette entries to rendering colors.
        for (let i = 0; i < 4096; i++) {
            const entry = palette4096[i];
            const g4 = (entry >> 8) & 0x0F;
            const r4 = (entry >> 4) & 0x0F;
            const b4 = entry & 0x0F;
            this._resolvedAnalogPalette[i] =
                0xFF000000 | ((b4 * 17) << 16) | ((g4 * 17) << 8) | (r4 * 17);
        }
    }

    // ---------------------------------------------------------------
    //  VSync
    // ---------------------------------------------------------------

    vsync() {
        this.frameCount++;
    }

    // ---------------------------------------------------------------
    //  Rendering
    // ---------------------------------------------------------------

    /**
     * Render the visible screen into the current frame (see `frameSink`).
     * Only the dirty bands are converted unless `force` is set; each written
     * rectangle is handed to the sink through present().
     * @param {boolean} [force] - redraw the whole frame (ignored while the CRT is off)
     */
    render(force = false) {
        if (!this.crtOn) {
            return this._renderBlank();
        }
        // $D433 bit 0 = 1 keeps the last picture on the screen
        if (this.holdPicture && this._pixelBuf && !this._lastBlank) return;
        const tall = this.displayMode === DISPLAY_MODE_400;
        const height = tall ? SCREEN_HEIGHT_400 : SCREEN_HEIGHT;
        this._acquireFrame(SCREEN_WIDTH, height);
        if (this.displayMode === DISPLAY_MODE_320 && this.palette4096 && this._analogDirty) {
            this.rebuildAnalogPalette(this.palette4096);
            this._analogDirty = false;
        }
        const bands = height >> 3;
        const full = this._fullDirty || force;
        if (!full) {
            let any = false;
            for (let b = 0; b < bands; b++) if (this._dirtyBands[b]) { any = true; break; }
            if (!any) return;
        }
        for (let b = 0; b < bands; b++) {
            if (!full && !this._dirtyBands[b]) continue;
            const y0 = b << 3;
            for (let y = y0; y < y0 + 8; y++) {
                switch (this.displayMode) {
                    case DISPLAY_MODE_400:  this._drawRow8Color(y, 0x7FFF, this._effectiveOffset(0) * 2,
                                                this.vramBanks[0], 0, this.vramBanks[1], 0, this.vramBanks[2], 0); break;
                    case DISPLAY_MODE_320:  this._drawRow4096(y); break;
                    case DISPLAY_MODE_262K: this._drawRow262k(y); break;
                    default: {
                        const bank = this._shownBank();
                        const m = this.vramBanks[bank];
                        this._drawRow8Color(y, 0x3FFF, this._effectiveOffset(bank), m, 0x0000, m, 0x4000, m, 0x8000);
                        break;
                    }
                }
            }
        }
        if (full) {
            this._presentFull();
        } else {
            for (let b = 0; b < bands; b++) {
                if (this._dirtyBands[b]) this._present(0, b << 3, SCREEN_WIDTH, 8);
            }
        }
        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    _renderBlank() {
        const h = (this.displayMode === DISPLAY_MODE_400) ? SCREEN_HEIGHT_400 : SCREEN_HEIGHT;
        this._acquireFrame(SCREEN_WIDTH, h);
        if (this._lastBlank) return;
        this._pixelBuf.fill(0xFF000000);
        this._presentFull();
        this._lastBlank = true;
        this._fullDirty = true;
    }

    /**
     * One 640-dot row of an 8-color format: the B, R and G
     * planes at the same in-plane address, display address plus offset,
     * wrapped with `wrap`; colored through the TTL palette.
     */
    _drawRow8Color(y, wrap, offset, bMem, bBase, rMem, rBase, gMem, gBase) {
        const px = this._pixelBuf;
        const pal = this._resolvedPalette;
        const hideB = (this.planeMaskBits & 0x10) !== 0;
        const hideR = (this.planeMaskBits & 0x20) !== 0;
        const hideG = (this.planeMaskBits & 0x40) !== 0;
        const rowStart = y * ROW_BYTES;
        let out = y * SCREEN_WIDTH;
        for (let col = 0; col < ROW_BYTES; col++) {
            const i = (rowStart + col + offset) & wrap;
            const bv = hideB ? 0 : bMem[bBase + i];
            const rv = hideR ? 0 : rMem[rBase + i];
            const gv = hideG ? 0 : gMem[gBase + i];
            for (let s = 7; s >= 0; s--) {
                px[out++] = pal[(((gv >> s) & 1) << 2) | (((rv >> s) & 1) << 1) | ((bv >> s) & 1)];
            }
        }
    }

    /**
     * One row of 320x200 4096 colors: bank 0 holds B3/B2/R3/R2/G3/G2,
     * bank 1 holds B1/B0/R1/R0/G1/G0, each bank with its own offset.
     * Each dot is drawn 2 pixels wide.
     */
    _drawRow4096(y) {
        const px = this._pixelBuf;
        const pal = this._resolvedAnalogPalette;
        let keep = 0xFFF;
        if (this.planeMaskBits & 0x10) keep &= ~0x00F;
        if (this.planeMaskBits & 0x20) keep &= ~0x0F0;
        if (this.planeMaskBits & 0x40) keep &= ~0xF00;
        const hi = this.vramBanks[0], lo = this.vramBanks[1];
        const oHi = this._effectiveOffset(0), oLo = this._effectiveOffset(1);
        const rowStart = y * ROW_BYTES_320;
        let out = y * SCREEN_WIDTH;
        for (let col = 0; col < ROW_BYTES_320; col++) {
            const a = (rowStart + col + oHi) & 0x1FFF;
            const c = (rowStart + col + oLo) & 0x1FFF;
            const b3 = hi[a], b2 = hi[0x2000 + a], r3 = hi[0x4000 + a], r2 = hi[0x6000 + a];
            const g3 = hi[0x8000 + a], g2 = hi[0xA000 + a];
            const b1 = lo[c], b0 = lo[0x2000 + c], r1 = lo[0x4000 + c], r0 = lo[0x6000 + c];
            const g1 = lo[0x8000 + c], g0 = lo[0xA000 + c];
            for (let s = 7; s >= 0; s--) {
                const g = (((g3 >> s) & 1) << 3) | (((g2 >> s) & 1) << 2) | (((g1 >> s) & 1) << 1) | ((g0 >> s) & 1);
                const r = (((r3 >> s) & 1) << 3) | (((r2 >> s) & 1) << 2) | (((r1 >> s) & 1) << 1) | ((r0 >> s) & 1);
                const b = (((b3 >> s) & 1) << 3) | (((b2 >> s) & 1) << 2) | (((b1 >> s) & 1) << 1) | ((b0 >> s) & 1);
                const color = pal[((g << 8) | (r << 4) | b) & keep];
                px[out++] = color;
                px[out++] = color;
            }
        }
    }

    /**
     * One row of 320x200 262,144 colors: bank 0 = blue, 1 = red,
     * 2 = green; in each bank $0000/$2000/.../$A000 hold bits 5..0 of that
     * component. Bank 0's offset applies to all banks. No palette.
     */
    _drawRow262k(y) {
        const px = this._pixelBuf;
        const bm = this.vramBanks[0], rm = this.vramBanks[1], gm = this.vramBanks[2];
        const ofs = this._effectiveOffset(0);
        const rowStart = y * ROW_BYTES_320;
        let out = y * SCREEN_WIDTH;
        const level = (m, i, s) =>
            (((m[i] >> s) & 1) << 5) | (((m[0x2000 + i] >> s) & 1) << 4) |
            (((m[0x4000 + i] >> s) & 1) << 3) | (((m[0x6000 + i] >> s) & 1) << 2) |
            (((m[0x8000 + i] >> s) & 1) << 1) | ((m[0xA000 + i] >> s) & 1);
        for (let col = 0; col < ROW_BYTES_320; col++) {
            const i = (rowStart + col + ofs) & 0x1FFF;
            for (let s = 7; s >= 0; s--) {
                const b = level(bm, i, s), r = level(rm, i, s), g = level(gm, i, s);
                // 0..63 to 0..255
                const color = 0xFF000000 | (((b << 2) | (b >> 4)) << 16) |
                              (((g << 2) | (g >> 4)) << 8) | ((r << 2) | (r >> 4));
                px[out++] = color;
                px[out++] = color;
            }
        }
    }

    // ---------------------------------------------------------------
    //  Bulk operations and reset
    // ---------------------------------------------------------------

    /** Banks the current format puts on the screen (for inspection tools). */
    shownBanks() {
        switch (this.displayMode) {
            case DISPLAY_MODE_320:  return [this.vramBanks[0], this.vramBanks[1]];
            case DISPLAY_MODE_262K:
            case DISPLAY_MODE_400:  return [this.vramBanks[0], this.vramBanks[1], this.vramBanks[2]];
            default:                return [this.vramBanks[this._shownBank()]];
        }
    }

    clearWorkRam() {
        this.workRam.fill(0);
        this.workRamD500.fill(0);
    }

    /** Logic unit and line engine back to their reset values. */
    resetLogicAndLine() {
        this.logicCommand = 0;
        this.logicColor = 0;
        this.logicMask = 0;
        this.colorMatchBits = 0;
        this.compareRegisters.fill(0);
        this.bankDisable = 0;
        this.tilePattern.fill(0);
        this.lineAddressOffset = 0;
        this.lineStylePattern = 0;
        this.lineStartX = 0;
        this.lineStartY = 0;
        this.lineEndX = 0;
        this.lineEndY = 0;
        this.lineRemainingUs = 0;
    }

    /**
     * Display part of the sub system reset done through the sub bank
     * register: CRT off, VRAM access off, INS LED off, both offset
     * registers 0, the $D430 display bits (DB, AB, OA) 0, and the $D42F
     * VRAM bank 0.
     */
    initForSubReset() {
        this.crtOn = false;
        this._lastBlank = false;
        this.vramAccessEnabled = false;
        this.insLedOn = false;
        this.offsetRegister.fill(0);
        this.pageControl = 0;
        this.cpuPage = 0;
        this.shownPage = 0;
        this.fineOffsetEnable = false;
        this.planeBank = 0;
        this._fullDirty = true;
    }

    /**
     * Full reset: clear VRAM, work RAM, reset palette, logic unit, line engine.
     */
    reset() {
        for (const m of this.vramBanks) m.fill(0);
        this.clearWorkRam();
        this.resetPalette();
        this.initForSubReset();
        this.subVramFastAccess = false;
        this.frameCount = 0;
        this.columns320 = false;
        this.formatByte = 0x08;      // 200 lines, not 262,144 colors
        this.holdPicture = false;
        this.windowRegisters.fill(0);
        this.planeMaskBits = 0;
        this.resetLogicAndLine();
        this._updateDisplayMode();
        this._resolvedAnalogPalette.fill(0xFF000000);
        this._analogDirty = true;
        this._fullDirty = true;
        this._frame = null;
        this._pixelBuf = null;
        this._lastBlank = false;
    }
}
