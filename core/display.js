// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// FM-7 / FM77AV / FM77AV40 Display System for Web Simulator
// Handles VRAM, TTL/analog palette, sub CPU memory, and RGBA frame rendering (output goes to a frame sink).
// Includes the FM77AV ALU, the line drawing engine, and the 262,144-color mode.
// Shared RAM is handled in fm7.js.

const VRAM_SIZE       = 0xC000;  // 48KB per page, 3 planes
const PLANE_SIZE      = 0x4000;  // 16KB per plane
const BLUE_BASE       = 0x0000;
const RED_BASE        = 0x4000;
const GREEN_BASE      = 0x8000;
const WORK_RAM_BASE   = 0xC000;
const WORK_RAM_END    = 0xD37F;
const WORK_RAM_SIZE   = WORK_RAM_END - WORK_RAM_BASE + 1;  // 0x1380
const IO_BASE         = 0xD400;
const IO_END_FM7      = 0xD40F;
const IO_END_AV       = 0xD42B;  // FM77AV extended I/O (ALU registers)

const SCREEN_WIDTH    = 640;
const SCREEN_HEIGHT   = 200;
const BYTES_PER_LINE  = 80;  // 640 / 8
const BYTES_PER_LINE_320 = 40;  // 320 / 8 (analog 320x200 mode)

// FM77AV display modes
const DISPLAY_MODE_640  = 0;  // 640x200, 8 colors (FM-7 compatible)
const DISPLAY_MODE_320  = 1;  // 320x200, 4096 colors (FM77AV)
const DISPLAY_MODE_262K = 2;  // 320x200, 262,144 colors (FM77AV40)
const DISPLAY_MODE_400  = 3;  // 640x400, 8 colors (FM77AV40)

const SCREEN_HEIGHT_400 = 400;
const PLANE_SIZE_400    = 0x8000;  // 32KB per plane in 400-line mode

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

// ALU command modes (bits 2-0 of ALU command register $D410)
const ALU_PSET     = 0;
const ALU_PROHIBIT = 1;  // Reserved/disabled - preserves masked bits only
const ALU_OR       = 2;
const ALU_AND      = 3;
const ALU_XOR      = 4;
const ALU_NOT      = 5;
const ALU_TILE     = 6;
const ALU_COMPARE  = 7;

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
        // VRAM page 0: 3 bitplanes, 48KB total (FM-7 + FM77AV)
        this._vramBuf = new ArrayBuffer(VRAM_SIZE);
        this.vram = new Uint8Array(this._vramBuf);

        // VRAM page 1: 3 bitplanes, 48KB total (FM77AV only)
        this._vramBuf1 = new ArrayBuffer(VRAM_SIZE);
        this.vramPage1 = new Uint8Array(this._vramBuf1);

        // VRAM page 2: 3 bitplanes, 48KB total (FM77AV40 only)
        this._vramBuf2 = new ArrayBuffer(VRAM_SIZE);
        this.vramPage2 = new Uint8Array(this._vramBuf2);

        // VRAM pages 3-5: back block planes for AV40EX/SX 2-page 400-line and
        // 2-page 262K/4096-color modes. Same layout as vram/vramPage1/vramPage2.
        // blockDisplay selects the block to render; blockActive selects the write
        // target in the 400-line and 262K-color modes.
        this._vramBuf3 = new ArrayBuffer(VRAM_SIZE);
        this.vramPage3 = new Uint8Array(this._vramBuf3);
        this._vramBuf4 = new ArrayBuffer(VRAM_SIZE);
        this.vramPage4 = new Uint8Array(this._vramBuf4);
        this._vramBuf5 = new ArrayBuffer(VRAM_SIZE);
        this.vramPage5 = new Uint8Array(this._vramBuf5);

        // Temporary buffer for VRAM scroll rotation (32KB for 400-line planes)
        this._scrollBuf = new Uint8Array(PLANE_SIZE_400);

        // Sub CPU work RAM: $C000-$D37F (4992 bytes) + $D500-$D7FF (768 bytes, FM77AV only)
        this._workBuf = new ArrayBuffer(0x1680);  // 0x1380 + 0x0300
        this.workRam = new Uint8Array(this._workBuf);

        // TTL Palette: 8 entries, each maps logical color -> physical color
        this.palette = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            this.palette[i] = i;
        }

        // Resolved palette: logical index -> ABGR uint32
        this._resolvedPalette = new Uint32Array(8);
        this._rebuildResolvedPalette();

        // FM77AV analog palette: 4096 entries, stored externally in fm7.js
        this.analogPalette = null;       // Uint16Array(4096), set by fm7.js
        this._resolvedAnalogPalette = new Uint32Array(4096);
        this._analogDirty = true;        // Rebuild _resolvedAnalogPalette only when palette changed

        // VRAM offset register (scroll offset within each plane)
        // FM77AV: separate offset per page
        this.vramOffset = [0, 0];       // [page0, page1] - register value
        this.appliedScrollOffset = [0, 0]; // [page0, page1] - scroll offset already applied to VRAM
        this._scrollWriteCount = [0, 0];   // $D40E/$D40F write counter: scroll executes on even count
        this.vramOffsetFlag = false;    // Extended VRAM offset (bit 2 of $D430)

        // FM77AV VRAM page control
        this.activeVramPage = 0;    // Sub CPU writes to this page (0 or 1)
        this.displayVramPage = 0;   // Renderer reads from this page (0 or 1)
        this.displayMode = DISPLAY_MODE_640;  // current display mode (DISPLAY_MODE_*)
        this._mode320Flag = false;  // Tracks $FD12 bit6 independently from displayMode

        // FM77AV40EX/SX VRAM block select ($D433 bits 0/4)
        // Front/back block for 2-page 400-line / 262K-color / 4096-color modes.
        // Orthogonal to activeVramPage/displayVramPage ($D430 bits 5/6, used for
        // 200-line 2-page). In 400/262K modes the renderer and VRAM writes
        // consult these instead.
        this.blockActive = 0;
        this.blockDisplay = 0;

        // FM77AV40EX hardware window ($D438-$D43F). Pixel rectangle [x1,x2) × [y1,y2)
        // — in 640x400 mode, inside the window the renderer reads from the *other* block
        // (back if blockDisplay=0, front if blockDisplay=1). X aligned on 8 px.
        this.windowX1 = 0;
        this.windowX2 = 0;
        this.windowY1 = 0;
        this.windowY2 = 0;
        this.windowOpen = false;

        // Optional diagnostic trace of scroll / display state events
        // (off by default; see dumpScrollTrace()).
        this.enableScrollTrace = false;
        this._scrollTraceSize = 65536;
        this._scrollTrace = new Array(this._scrollTraceSize);
        this._scrollTraceIdx = 0;
        this._scrollTraceCount = 0;

        // FM77AV mode flag - set by fm7.js when machine type is FM77AV
        this.isAV = false;

        // FM77AV40 mode flag
        this.isAV40 = false;

        // FM77AV40: VRAM bank select ($D42F) for 262,144-color / 400-line mode
        this.vramBankSelect = 0;  // 0-2 (bank 3 does not exist)

        // Multi-page register: bit mask controlling which planes are active
        // bit 0 = blue (plane 0), bit 1 = red (plane 1), bit 2 = green (plane 2)
        // 1 = plane DISABLED (masked), 0 = plane ENABLED
        this.multiPage = 0;

        // ---------------------------------------------------------------
        //  ALU registers ($D410-$D42B) - FM77AV hardware ALU (MB61VH010)
        // ---------------------------------------------------------------
        this.aluCommand   = 0;       // $D410: ALU command register
                                      //   bit 7: ALU enable (1=active)
                                      //   bit 6: compare-write mode
                                      //   bit 5: NOT-equal write (with bit 6)
                                      //   bits 2-0: operation mode
        this.aluColor     = 0;       // $D411: ALU color (bit 0 = B, bit 1 = R, bit 2 = G)
        this.aluMask      = 0;       // $D412: ALU mask (1=preserve original bit)
        this.aluCompareStatus   = 0;       // $D413: compare result status (read)
        this.aluCompareData    = new Uint8Array(8);  // $D413-$D41A: compare data (write)
        this.aluDisable   = 0x00;    // $D41B: plane disable (bit=1 disables ALU on that plane)
        this.aluTileData   = new Uint8Array(3);  // $D41C-$D41E: tile patterns per plane

        // ---------------------------------------------------------------
        //  Line drawing engine registers ($D420-$D42B)
        // ---------------------------------------------------------------
        this.lineBusy     = false;   // Line drawing busy flag
        this.lineOffset   = 0;       // $D420-$D421: VRAM address offset
        this.lineStyle    = 0;       // $D422-$D423: line style pattern (16-bit)
        this.lineX0       = 0;       // $D424-$D425: X0 coordinate (10-bit)
        this.lineY0       = 0;       // $D426-$D427: Y0 coordinate (9-bit)
        this.lineX1       = 0;       // $D428-$D429: X1 coordinate (10-bit)
        this.lineY1       = 0;       // $D42A-$D42B: Y1 coordinate (9-bit)

        // Internal line drawing state
        this._linePrevAddr = 0xFFFF;  // Previous VRAM address during line draw
        this._lineMask    = 0xFF;    // Current line drawing mask byte
        this._lineCount   = 0;       // Bytes processed during line draw
        this._lineBusyRemainder = 0;  // Busy-time remainder carried over to the next line
        this._lineBusyMicros = 0;    // BUSY timer countdown (microseconds); cleared by fm7.js

        // MISC register ($D430) last written value (maintained by fm7.js)
        this.miscReg = 0;

        // CRT and VRAM access flags (sub CPU I/O side effects)
        // CRT 表示は $D408 の読みで点灯、書き込みで消灯する。
        // リセットとサブ CPU のリセット ($FD13) でも消灯する。
        // vramAccessEnabled: サブ CPU 側の VRAM アクセス許可 ($D409 読みで許可・書きで
        // 禁止)。表示の点灯・消灯とは独立で、描画には関与しない。
        this.crtOn = false;
        this.vramAccessEnabled = false;
        // insLedOn: キーボードの INS LED ($D40D 読みで点灯・書きで消灯、
        // リセットとサブ CPU のリセットで消灯)。
        this.insLedOn = false;
        // $D405 bit 0: cycle-steal mode. Only machines where
        // hasCycleStealControl is true expose this register (see fm7.js).
        this.cycleStealMode = false;

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
    //  VRAM array accessors
    // ---------------------------------------------------------------

    /** Get the VRAM array for the active (write) page */
    _getActiveVram() {
        // In 262K / 400-line mode, vramBankSelect selects plane bank (0-2),
        // blockActive ($D433 bit0, AV40EX/SX 2-page mode) selects front/back block.
        if (this.displayMode === DISPLAY_MODE_262K || this.displayMode === DISPLAY_MODE_400) {
            if (this.blockActive === 1) {
                if (this.vramBankSelect === 2) return this.vramPage5;
                if (this.vramBankSelect === 1) return this.vramPage4;
                return this.vramPage3;
            }
            if (this.vramBankSelect === 2) return this.vramPage2;
            if (this.vramBankSelect === 1) return this.vramPage1;
            return this.vram;
        }
        return this.activeVramPage === 0 ? this.vram : this.vramPage1;
    }

    /** Get the VRAM array for the display (read) page */
    _getDisplayVram() {
        return this.displayVramPage === 0 ? this.vram : this.vramPage1;
    }

    /**
     * Mark the affected display region for redraw.
     * @param {number} rawOffset - byte offset within a 0x4000 plane region
     */
    _markVramLineDirty(rawOffset) {
        let screenLine;
        if (this.displayMode === DISPLAY_MODE_320) {
            screenLine = ((rawOffset & 0x1FFF) / BYTES_PER_LINE_320) | 0;
        } else if (this.displayMode === DISPLAY_MODE_262K) {
            const sub = rawOffset & 0x1FFF;
            // Bank 1 scrolls by vramOffset[1]; banks 0/2 share vramOffset[0]
            // (matches _render320x200_262k's ofsB0/ofsB1/ofsB2).
            const ofs = (this.vramBankSelect === 1) ? this.vramOffset[1] : this.vramOffset[0];
            screenLine = (((sub - ofs + 0x2000) & 0x1FFF) / BYTES_PER_LINE_320) | 0;
        } else {
            screenLine = (rawOffset / BYTES_PER_LINE) | 0;
        }
        if (screenLine < SCREEN_HEIGHT) {
            this._dirtyBands[screenLine >> 3] = 1;
        }
    }

    // ---------------------------------------------------------------
    //  Internal VRAM access helpers for ALU operations
    // ---------------------------------------------------------------

    /**
     * Read a byte from VRAM for ALU operations on a specific plane (bank).
     * Respects the multi-page access mask. Returns 0xFF if the plane is masked.
     * @param {number} offset - byte offset within a plane (masked to the plane size of the current mode)
     * @param {number} plane - plane number (0=blue, 1=red, 2=green)
     * @returns {number} byte value
     */
    _aluReadPlane(offset, plane) {
        if (this.multiPage & (1 << plane)) {
            return 0xFF;
        }
        if (this.displayMode === DISPLAY_MODE_400) {
            const pages = this.blockActive === 1
                ? [this.vramPage3, this.vramPage4, this.vramPage5]
                : [this.vram, this.vramPage1, this.vramPage2];
            return pages[plane][offset & (PLANE_SIZE_400 - 1)];
        }
        const vram = this._getActiveVram();
        // ALU accesses use raw offset (no scroll offset applied)
        return vram[plane * PLANE_SIZE + (offset & (PLANE_SIZE - 1))];
    }

    /**
     * Write a byte to VRAM for ALU operations on a specific plane (bank).
     * Respects the multi-page access mask. Skips write if plane is masked.
     * @param {number} offset - byte offset within a plane (masked to the plane size of the current mode)
     * @param {number} plane - plane number (0=blue, 1=red, 2=green)
     * @param {number} dat - byte value to write
     */
    _aluWritePlane(offset, plane, dat) {
        if (this.multiPage & (1 << plane)) {
            return;
        }
        if (this.displayMode === DISPLAY_MODE_400) {
            const pages = this.blockActive === 1
                ? [this.vramPage3, this.vramPage4, this.vramPage5]
                : [this.vram, this.vramPage1, this.vramPage2];
            const vram = pages[plane];
            const rawOffset = offset & (PLANE_SIZE_400 - 1);
            if (vram[rawOffset] !== dat) {
                vram[rawOffset] = dat;
                if (this.blockActive === this.blockDisplay) {
                    const line = (rawOffset / BYTES_PER_LINE) | 0;
                    if (line < SCREEN_HEIGHT_400) {
                        this._dirtyBands[(line >> 3)] = 1;
                    }
                }
            }
            return;
        }
        const vram = this._getActiveVram();
        // ALU accesses use raw offset (no scroll offset applied)
        const rawOffset = offset & (PLANE_SIZE - 1);
        const addr = plane * PLANE_SIZE + rawOffset;
        if (vram[addr] !== dat) {
            vram[addr] = dat;
            this._markVramLineDirty(rawOffset);
        }
    }

    /**
     * ALU write with compare-write mode support.
     * If compare-write mode (bit 6 of aluCommand) is active, the write
     * is masked by the compare status register (aluCompareStatus).
     * @param {number} offset - byte offset within a plane
     * @param {number} plane - plane number
     * @param {number} dat - data to write
     */
    _aluWriteWithCompare(offset, plane, dat) {
        // Check if compare-write mode is active
        if ((this.aluCommand & 0x40) === 0) {
            // Normal write
            this._aluWritePlane(offset, plane, dat);
            return;
        }

        // Compare-write mode
        const existing = this._aluReadPlane(offset, plane);
        let temp, result;

        if (this.aluCommand & 0x20) {
            // NOT-equal write: write where compare did NOT match
            temp = existing & this.aluCompareStatus;
            dat = dat & (~this.aluCompareStatus & 0xFF);
        } else {
            // Equal write: write where compare DID match
            temp = existing & (~this.aluCompareStatus & 0xFF);
            dat = dat & this.aluCompareStatus;
        }

        this._aluWritePlane(offset, plane, (temp | dat) & 0xFF);
    }

    // ---------------------------------------------------------------
    //  ALU operation implementations
    // ---------------------------------------------------------------

    /**
     * ALU PSET operation: write color to all enabled planes.
     * For each plane: if color bit set, write 0xFF; else write 0x00.
     * Masked bits are preserved from original VRAM data.
     */
    _aluPset(addr) {
        // If compare-write mode, run compare first
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                // Color data: all 1s or all 0s based on color bit
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;

                // Read existing for mask
                const mask = this._aluReadPlane(addr, plane);

                // Apply mask: preserve bits where aluMask=1
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);

                // Write with compare-write support
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU prohibit operation (command 1): preserves masked bits only.
     * Effectively clears unmasked bits while keeping masked bits.
     */
    _aluProhibit(addr) {
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                const mask = this._aluReadPlane(addr, plane);
                const dat = mask & this.aluMask;
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU OR operation: OR color with existing VRAM data.
     */
    _aluOr(addr) {
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;
                const mask = this._aluReadPlane(addr, plane);
                dat |= mask;
                // Apply mask bits
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU AND operation: AND color with existing VRAM data.
     */
    _aluAnd(addr) {
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;
                const mask = this._aluReadPlane(addr, plane);
                dat &= mask;
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU XOR operation: XOR color with existing VRAM data.
     */
    _aluXor(addr) {
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = (this.aluColor & bit) ? 0xFF : 0x00;
                const mask = this._aluReadPlane(addr, plane);
                dat ^= mask;
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU NOT operation: invert existing VRAM data.
     */
    _aluNot(addr) {
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                const mask = this._aluReadPlane(addr, plane);
                let dat = (~mask) & 0xFF;
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU TILE operation: write tile pattern data to planes.
     * Each plane gets its own tile byte from aluTileData[plane].
     */
    _aluTile(addr) {
        if (this.aluCommand & 0x40) {
            this._aluCompare(addr);
        }

        let bit = 0x01;
        for (let plane = 0; plane < 3; plane++) {
            if (!(this.aluDisable & bit)) {
                let dat = this.aluTileData[plane];
                // Apply mask
                const mask = this._aluReadPlane(addr, plane);
                dat = (dat & (~this.aluMask & 0xFF)) | (mask & this.aluMask);
                this._aluWriteWithCompare(addr, plane, dat);
            }
            bit <<= 1;
        }
    }

    /**
     * ALU compare operation: compare VRAM colors against compare registers.
     * For each of the 8 pixel positions in the byte, extract the 3-bit color
     * from the 3 planes, then check if that color matches any of the 8
     * compare data registers (that are enabled with bit 7 = 0).
     * Result bits are set in aluCompareStatus.
     */
    _aluCompare(addr) {
        // Read all three planes
        const b = this._aluReadPlane(addr, 0);
        const r = this._aluReadPlane(addr, 1);
        const g = this._aluReadPlane(addr, 2);

        // Bank disable mask (inverted: bits that are NOT disabled)
        const disMask = (~this.aluDisable) & 0x07;

        let result = 0;
        let bitPos = 0x80;

        for (let i = 0; i < 8; i++) {
            // Extract color at this bit position
            let color = 0;
            if (b & bitPos) color |= 0x01;
            if (r & bitPos) color |= 0x02;
            if (g & bitPos) color |= 0x04;

            // Check against all 8 compare slots
            let matched = false;
            for (let j = 0; j < 8; j++) {
                // bit 7 = 0 means this slot is active
                if ((this.aluCompareData[j] & 0x80) === 0) {
                    if ((this.aluCompareData[j] & disMask) === (color & disMask)) {
                        matched = true;
                        break;
                    }
                }
            }

            if (matched) {
                result |= bitPos;
            }

            bitPos >>= 1;
        }

        this.aluCompareStatus = result;
    }

    /**
     * Execute ALU operation on the given VRAM address.
     * Called from the line drawing engine.
     * Uses the line drawing mask (_lineMask) instead of aluMask.
     */
    _aluExecLineByte(addr) {
        if (addr >= 0x8000) {
            this._lineMask = 0xFF;
            return;
        }

        // Save and set mask from line engine
        const savedMask = this.aluMask;
        this.aluMask = this._lineMask;
        this._lineMask = 0xFF;

        // Dispatch ALU operation
        this._dispatchAluOp(addr);

        // Restore mask
        this.aluMask = savedMask;

        // Count bytes processed
        this._lineCount++;
    }

    /**
     * Dispatch to the correct ALU operation based on command bits 2-0.
     */
    _dispatchAluOp(addr) {
        addr &= (this.displayMode === DISPLAY_MODE_400) ? (PLANE_SIZE_400 - 1) : (PLANE_SIZE - 1);
        switch (this.aluCommand & 0x07) {
            case ALU_PSET:     this._aluPset(addr);     break;
            case ALU_PROHIBIT: this._aluProhibit(addr); break;
            case ALU_OR:       this._aluOr(addr);       break;
            case ALU_AND:      this._aluAnd(addr);      break;
            case ALU_XOR:      this._aluXor(addr);      break;
            case ALU_NOT:      this._aluNot(addr);      break;
            case ALU_TILE:     this._aluTile(addr);     break;
            case ALU_COMPARE:  this._aluCompare(addr);  break;
        }
    }

    // ---------------------------------------------------------------
    //  Hardware line drawing engine (Bresenham's algorithm)
    // ---------------------------------------------------------------

    /**
     * Plot a single pixel during line drawing.
     * Accumulates a mask byte and triggers ALU execution when
     * the address changes to the next byte.
     */
    _linePlotPixel(x, y) {
        // ALU must be enabled for line drawing
        if (!(this.aluCommand & 0x80)) {
            return;
        }

        // Calculate VRAM byte address from (x, y) coordinates
        let addr;
        if (this.displayMode === DISPLAY_MODE_320 ||
            this.displayMode === DISPLAY_MODE_262K) {
            // 320x200 analog / 262K-color mode: 40 bytes per line
            addr = (y * BYTES_PER_LINE_320 + (x >> 3)) & 0xFFFF;
        } else {
            // 640x200 / 640x400 digital mode: 80 bytes per line
            addr = (y * BYTES_PER_LINE + (x >> 3)) & 0xFFFF;
        }

        // Add line offset
        const planeMask = (this.displayMode === DISPLAY_MODE_400) ? (PLANE_SIZE_400 - 1) : (PLANE_SIZE - 1);
        addr = (addr + this.lineOffset) & planeMask;

        // If address changed from previous pixel, flush the ALU for the old address
        if (this._linePrevAddr !== addr) {
            this._aluExecLineByte(this._linePrevAddr);
            this._linePrevAddr = addr;
        }

        // Apply line style: only set pixel if current style bit is 1
        if (this.lineStyle & 0x8000) {
            // Pixel mask table: clears the bit for this pixel's position
            const pixMask = [0x7F, 0xBF, 0xDF, 0xEF, 0xF7, 0xFB, 0xFD, 0xFE];
            this._lineMask &= pixMask[x & 0x07];
        }

        // Rotate line style pattern (16-bit left rotate)
        this.lineStyle = ((this.lineStyle << 1) | (this.lineStyle >>> 15)) & 0xFFFF;
    }

    /**
     * Execute hardware line drawing using Bresenham's algorithm.
     * Triggered by writing to $D42B (Y1 low byte).
     */
    _lineDrawExec() {
        let x1 = this.lineX0;
        let x2 = this.lineX1;
        let y1 = this.lineY0;
        let y2 = this.lineY1;

        // Initialize line drawing state
        this._lineCount = 0;
        this._linePrevAddr = 0xFFFF;
        this._lineMask = 0xFF;

        // Calculate deltas and step directions
        let dx = x2 - x1;
        let dy = y2 - y1;
        let ux, uy;

        if (dx < 0) {
            ux = -1;
            dx = -dx;
        } else {
            ux = 1;
        }

        if (dy < 0) {
            uy = -1;
            dy = -dy;
        } else {
            uy = 1;
        }

        if (dx === 0 && dy === 0) {
            // Single point
            this._linePlotPixel(x1, y1);
        } else if (dx === 0) {
            // Vertical line
            for (;;) {
                this._linePlotPixel(x1, y1);
                if (y1 === y2) break;
                y1 += uy;
            }
        } else if (dy === 0) {
            // Horizontal line
            for (;;) {
                this._linePlotPixel(x1, y1);
                if (x1 === x2) break;
                x1 += ux;
            }
        } else if (dx >= dy) {
            // Shallow line (DX >= DY)
            let r = dx >> 1;
            for (;;) {
                this._linePlotPixel(x1, y1);
                if (x1 === x2) break;
                x1 += ux;
                r -= dy;
                if (r < 0) {
                    r += dx;
                    y1 += uy;
                }
            }
        } else {
            // Steep line (DX < DY)
            let r = dy >> 1;
            for (;;) {
                this._linePlotPixel(x1, y1);
                if (y1 === y2) break;
                y1 += uy;
                r -= dx;
                if (r < 0) {
                    r += dy;
                    x1 += ux;
                }
            }
        }

        // Flush the last byte's ALU operation
        this._aluExecLineByte(this._linePrevAddr);

        // Update the line drawing busy state.
        let busyTime = this._lineCount >> 4;
        this._lineBusyRemainder += (this._lineCount & 0x0F);
        if (this._lineBusyRemainder >= 0x10) {
            busyTime++;
            this._lineBusyRemainder &= 0x0F;
        }

        if (busyTime > 0) {
            this.lineBusy = true;
            this._lineBusyMicros = busyTime;  // fm7.js scheduler clears this after timeout
        }
    }

    // ---------------------------------------------------------------
    //  VRAM read/write with ALU interception
    // ---------------------------------------------------------------

    readVRAM(addr) {
        addr &= 0xFFFF;
        if (addr >= VRAM_SIZE) return 0xFF;

        // 400-line mode: $0000-$7FFF maps to one bank-selected plane
        if (this.displayMode === DISPLAY_MODE_400) {
            if (addr >= PLANE_SIZE_400) return 0xFF; // $8000-$BFFF invalid
            if (this.isAV && (this.aluCommand & 0x80)) {
                this._dispatchAluOp(addr);
            }
            if (this.isAV && (this.multiPage & (1 << this.vramBankSelect))) {
                return 0xFF;
            }
            return this._getActiveVram()[addr];
        }

        const plane = (addr / PLANE_SIZE) | 0;
        const rawOffset = addr % PLANE_SIZE;

        // FM77AV: ALU intercept on read
        if (this.isAV && (this.aluCommand & 0x80)) {
            this._dispatchAluOp(rawOffset);
        }
        if (this.isAV && (this.multiPage & (1 << plane))) {
            return 0xFF;
        }

        // No scroll offset applied here: scrolling rotates the VRAM contents
        // (see _vramScroll); only 262K mode applies the offset in the renderer.
        const vram = this._getActiveVram();
        return vram[addr];
    }

    writeVRAM(addr, value) {
        addr &= 0xFFFF;
        if (addr >= VRAM_SIZE) return;

        // 400-line mode: $0000-$7FFF maps to one bank-selected plane
        if (this.displayMode === DISPLAY_MODE_400) {
            if (addr >= PLANE_SIZE_400) return; // $8000-$BFFF invalid
            if (this.isAV && (this.aluCommand & 0x80)) {
                this._dispatchAluOp(addr);
                return;
            }
            if (this.multiPage & (1 << this.vramBankSelect)) return;
            const vram = this._getActiveVram();
            if (vram[addr] !== value) {
                vram[addr] = value;
                // Only mark display dirty when writing to the currently-displayed block
                if (this.blockActive === this.blockDisplay) {
                    const line = (addr / BYTES_PER_LINE) | 0;
                    if (line < SCREEN_HEIGHT_400) {
                        this._dirtyBands[(line >> 3)] = 1;
                    }
                }
            }
            return;
        }

        const plane = (addr / PLANE_SIZE) | 0;
        const rawOffset = addr % PLANE_SIZE;

        // FM77AV: when ALU is enabled, writes trigger ALU operation (uses raw offset)
        // The write data from the CPU is ignored; the ALU determines what gets written.
        if (this.isAV && (this.aluCommand & 0x80)) {
            this._dispatchAluOp(rawOffset);
            return;
        }

        // Normal write - no scroll offset applied here (see readVRAM)
        if (this.multiPage & (1 << plane)) {
            return;
        }

        const vram = this._getActiveVram();

        if (vram[addr] !== value) {
            vram[addr] = value;
            this._markVramLineDirty(rawOffset);
        }
    }

    // ---------------------------------------------------------------
    //  Sub CPU memory read/write  ($0000 - $D42B)
    // ---------------------------------------------------------------

    read(addr) {
        addr &= 0xFFFF;
        if (addr < VRAM_SIZE) {
            return this.readVRAM(addr);
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            return this.workRam[addr - WORK_RAM_BASE];
        }
        if (addr >= IO_BASE && addr <= IO_END_AV) {
            const result = this.readIO(addr);
            return result.value;
        }
        return 0xFF;
    }

    write(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;
        if (addr < VRAM_SIZE) {
            this.writeVRAM(addr, value);
            return;
        }
        if (addr >= WORK_RAM_BASE && addr <= WORK_RAM_END) {
            this.workRam[addr - WORK_RAM_BASE] = value;
            return;
        }
        if (addr >= IO_BASE && addr <= IO_END_AV) {
            this.writeIO(addr, value);
            return;
        }
    }

    // ---------------------------------------------------------------
    //  I/O register read ($D400 - $D42F)
    // ---------------------------------------------------------------

    readIO(addr) {
        addr &= 0xFFFF;

        switch (addr) {
            case 0xD402:
                return { value: 0xFF, sideEffect: 'cancelAck' };
            case 0xD403:
                return { value: 0xFF, sideEffect: 'beep' };
            case 0xD404:
                return { value: 0xFF, sideEffect: 'attention' };
            case 0xD408:
                // CRT 表示 ON ($D408 の読みで点灯)。
                if (!this.crtOn) {
                    this.crtOn = true;
                    this._lastBlank = false;
                    this._fullDirty = true;
                }
                return { value: 0xFF };
            case 0xD409:
                // VRAM アクセス許可 (読みで許可)。表示の点灯・消灯 (crtOn) とは
                // 独立で、画面に描くかどうかには関与しない。
                this.vramAccessEnabled = true;
                return { value: 0xFF };
            case 0xD40A:
                return { value: 0xFF, sideEffect: 'busyOff' };
            case 0xD40D:
                this.insLedOn = true;
                return { value: 0xFF };
            case 0xD40E:
            case 0xD40F:
                // 読みは $FF を返す。
                return { value: 0xFF };
        }

        // FM77AV ALU registers ($D410-$D42B)
        if (this.isAV && addr >= 0xD410 && addr <= 0xD42B) {
            switch (addr) {
                case 0xD410: return { value: this.aluCommand };
                case 0xD411: return { value: this.aluColor };
                case 0xD412: return { value: this.aluMask };
                case 0xD413: return { value: this.aluCompareStatus };
                case 0xD41B: return { value: this.aluDisable };
            }
            // $D414-$D41A: compare data (write-only, read returns 0xFF)
            if (addr >= 0xD413 && addr <= 0xD41A) {
                return { value: 0xFF };
            }
            // $D41C-$D41E: tile patterns (write-only, read returns 0xFF)
            if (addr >= 0xD41C && addr <= 0xD41E) {
                return { value: 0xFF };
            }
            // $D420-$D42B: line drawing registers (write-only, read returns 0xFF)
            if (addr >= 0xD420 && addr <= 0xD42B) {
                return { value: 0xFF };
            }
        }

        // FM77AV40: $D42F — VRAM bank select (read)
        if (addr === 0xD42F && this.isAV40) {
            return { value: 0xFC | (this.vramBankSelect & 3) };
        }

        return { value: 0xFF };
    }

    // ---------------------------------------------------------------
    //  I/O register write ($D400 - $D42F)
    // ---------------------------------------------------------------

    writeIO(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;

        switch (addr) {
            case 0xD408:
                // CRT 表示 OFF (書きで消灯)
                this.crtOn = false;
                this._lastBlank = false;
                return {};
            case 0xD409:
                // VRAM アクセス禁止 (書きで禁止)。crtOn には触れない。
                this.vramAccessEnabled = false;
                return {};
            case 0xD40A:
                return { sideEffect: 'busyOn' };
            case 0xD40D:
                this.insLedOn = false;
                return {};

            case 0xD40E:
                this._updateVramOffsetHigh(value);
                return {};
            case 0xD40F:
                this._updateVramOffsetLow(value);
                return {};
        }

        // FM77AV ALU registers ($D410-$D42B)
        if (this.isAV && addr >= 0xD410 && addr <= 0xD42B) {
            switch (addr) {
                // ALU command register
                case 0xD410:
                    this.aluCommand = value;
                    return {};
                // ALU color
                case 0xD411:
                    this.aluColor = value;
                    return {};
                // ALU mask
                case 0xD412:
                    this.aluMask = value;
                    return {};
                // ALU plane disable
                case 0xD41B:
                    this.aluDisable = value;
                    return {};

                // Line drawing: address offset (A1 and up; stored as even addresses)
                case 0xD420:
                    // High byte: bits map to offset bits 13-9
                    this.lineOffset = (this.lineOffset & 0x01FE) | ((value * 512) & 0x3E00);
                    return {};
                case 0xD421:
                    // Low byte: bits map to offset bits 8-1
                    this.lineOffset = (this.lineOffset & 0x3E00) | (value * 2);
                    return {};

                // Line style
                case 0xD422:
                    this.lineStyle = (this.lineStyle & 0x00FF) | (value << 8);
                    return {};
                case 0xD423:
                    this.lineStyle = (this.lineStyle & 0xFF00) | value;
                    return {};

                // X0 coordinate (10-bit)
                case 0xD424:
                    this.lineX0 = ((this.lineX0 & 0x00FF) | (value << 8)) & 0x03FF;
                    return {};
                case 0xD425:
                    this.lineX0 = (this.lineX0 & 0xFF00) | value;
                    return {};

                // Y0 coordinate (9-bit)
                case 0xD426:
                    this.lineY0 = ((this.lineY0 & 0x00FF) | (value << 8)) & 0x01FF;
                    return {};
                case 0xD427:
                    this.lineY0 = (this.lineY0 & 0xFF00) | value;
                    return {};

                // X1 coordinate (10-bit)
                case 0xD428:
                    this.lineX1 = ((this.lineX1 & 0x00FF) | (value << 8)) & 0x03FF;
                    return {};
                case 0xD429:
                    this.lineX1 = (this.lineX1 & 0xFF00) | value;
                    return {};

                // Y1 coordinate (9-bit)
                case 0xD42A:
                    this.lineY1 = ((this.lineY1 & 0x00FF) | (value << 8)) & 0x01FF;
                    return {};

                // Y1 low byte: writing triggers line drawing!
                case 0xD42B:
                    this.lineY1 = (this.lineY1 & 0xFF00) | value;
                    // Execute line drawing
                    this._lineDrawExec();
                    return {};
            }

            // $D413-$D41A: compare data registers
            if (addr >= 0xD413 && addr <= 0xD41A) {
                this.aluCompareData[addr - 0xD413] = value;
                return {};
            }

            // $D41C-$D41E: tile pattern registers
            if (addr >= 0xD41C && addr <= 0xD41E) {
                this.aluTileData[addr - 0xD41C] = value;
                return {};
            }

            return {};
        }

        // FM77AV40: $D42F — VRAM bank select (write)
        if (addr === 0xD42F && this.isAV40) {
            const bank = value & 0x03;
            if (bank < 3) {
                this.vramBankSelect = bank;
            }
            return {};
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
        // Keep 4 bits; only the lower 3 are used for R/G/B rendering.
        value &= 0x0F;
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
    //  VRAM offset (scroll)
    // ---------------------------------------------------------------

    /** Push one event to the scroll trace ring buffer (no-op if disabled). */
    _pushScrollTrace(tag, extra) {
        if (!this.enableScrollTrace) return;
        const e = {
            tag,
            mode: this.displayMode,
            apg: this.activeVramPage,
            dpg: this.displayVramPage,
            flag: this.vramOffsetFlag,
            ofs0: this.vramOffset[0],
            ofs1: this.vramOffset[1],
            crt0: this.appliedScrollOffset[0],
            crt1: this.appliedScrollOffset[1],
        };
        if (extra) Object.assign(e, extra);
        this._scrollTrace[this._scrollTraceIdx] = e;
        this._scrollTraceIdx = (this._scrollTraceIdx + 1) % this._scrollTraceSize;
        this._scrollTraceCount++;
    }

    /** Return scroll trace events in chronological order (oldest first). */
    dumpScrollTrace() {
        const out = [];
        const n = Math.min(this._scrollTraceCount, this._scrollTraceSize);
        const start = this._scrollTraceCount < this._scrollTraceSize
            ? 0 : this._scrollTraceIdx;
        for (let i = 0; i < n; i++) {
            out.push(this._scrollTrace[(start + i) % this._scrollTraceSize]);
        }
        return out;
    }

    /** Reset the scroll trace ring buffer. */
    clearScrollTrace() {
        this._scrollTraceIdx = 0;
        this._scrollTraceCount = 0;
    }

    /** Write VRAM offset high byte ($D40E) */
    _updateVramOffsetHigh(value) {
        const pg = this.activeVramPage;
        // High 6 bits of 14-bit offset
        let offset = (value & 0x3F) << 8;
        offset |= (this.vramOffset[pg] & 0xFF);  // keep existing low byte
        this.vramOffset[pg] = offset;
        this._pushScrollTrace('D40E', { val: value });
        this._scrollCountUp(pg);
    }

    /** Write VRAM offset low byte ($D40F) */
    _updateVramOffsetLow(value) {
        const pg = this.activeVramPage;
        // Apply the low byte with the precision allowed by the machine and mode.
        if (!this.isAV || !this.vramOffsetFlag) {
            value &= 0xE0;
        }
        let offset = (this.vramOffset[pg] & 0x3F00);  // keep existing high byte
        offset |= value;
        this.vramOffset[pg] = offset;
        this._pushScrollTrace('D40F', { val: value });
        this._scrollCountUp(pg);
    }

    /**
     * Apply the scroll once per register pair write.
     */
    _scrollCountUp(pg) {
        this._scrollWriteCount[pg]++;
        if ((this._scrollWriteCount[pg] & 1) === 0) {
            // Pass raw difference as WORD (16-bit), masking done in _vramScroll
            const diff = (this.vramOffset[pg] - this.appliedScrollOffset[pg]) & 0xFFFF;
            this._vramScroll(diff);
            this.appliedScrollOffset[pg] = this.vramOffset[pg];
            this._fullDirty = true;
        }
    }

    /**
     * Apply a scroll of 'offset' to the active page according to the display mode.
     */
    _vramScroll(offset) {
        this._pushScrollTrace('SCROLL', { diff: offset & 0xFFFF });

        // 400-line mode.
        if (this.displayMode === DISPLAY_MODE_400) {
            const span = (offset & 0x3FFF) * 2;
            if (span !== 0) {
                const phase = this.activeVramPage & 1;
                const planes = this.blockActive === 1
                    ? [this.vramPage3, this.vramPage4, this.vramPage5]
                    : [this.vram, this.vramPage1, this.vramPage2];
                const buf = this._scrollBuf;
                const SIZE = PLANE_SIZE_400;       // 0x8000
                const nSave = span >> 1;           // field bytes that wrap around
                const nShift = (SIZE - span) >> 1; // field bytes shifted down
                for (let pi = 0; pi < 3; pi++) {
                    const plane = planes[pi];
                    for (let j = 0; j < nSave; j++) buf[j] = plane[phase + 2 * j];
                    for (let j = 0; j < nShift; j++) plane[phase + 2 * j] = plane[phase + span + 2 * j];
                    for (let j = 0; j < nSave; j++) plane[phase + (SIZE - span) + 2 * j] = buf[j];
                }
            }
            this._fullDirty = true;
            return;
        }
        // 262K: renderer applies per-byte offset transform at read time
        // (see _render320x200_262k). No physical rotation.
        if (this.displayMode === DISPLAY_MODE_262K) {
            this._fullDirty = true;
            return;
        }

        const buf = this._scrollBuf;
        const vram = this._getActiveVram();

        if (this.displayMode === DISPLAY_MODE_320) {
            // 320x200 analog: 6 sub-planes of 0x2000 each
            const HALF = 0x2000;
            offset &= (HALF - 1);
            if (offset === 0) return;
            for (let i = 0; i < 6; i++) {
                const base = i * HALF;
                buf.set(vram.subarray(base, base + offset));
                vram.copyWithin(base, base + offset, base + HALF);
                vram.set(buf.subarray(0, offset), base + HALF - offset);
            }
        } else {
            // 640x200 8-color: 3 planes of 0x4000 each
            offset &= (PLANE_SIZE - 1);
            if (offset === 0) return;
            for (let i = 0; i < 3; i++) {
                const base = i * PLANE_SIZE;
                buf.set(vram.subarray(base, base + offset));
                vram.copyWithin(base, base + offset, base + PLANE_SIZE);
                vram.set(buf.subarray(0, offset), base + PLANE_SIZE - offset);
            }
        }
        this._fullDirty = true;
    }

    /** Get the display page's VRAM offset (for rendering) */
    getDisplayVramOffset() {
        // 200-line, 4096-color and 400-line modes physically rotate VRAM at
        // scroll time, so the renderer reads from offset 0. 262K mode applies
        // its per-bank offset inside _render320x200_262k.
        return 0;
    }

    // ---------------------------------------------------------------
    //  FM77AV: VRAM page and display mode control
    // ---------------------------------------------------------------

    _setActiveVramPage(page) {
        page &= 1;
        if (this.activeVramPage !== page) {
            this.activeVramPage = page;
            this._pushScrollTrace('APG');
        }
    }

    _setDisplayVramPage(page) {
        page &= 1;
        if (this.displayVramPage !== page) {
            this.displayVramPage = page;
            this._pushScrollTrace('DPG');
            this._fullDirty = true;
        }
    }

    _setDisplayMode(mode) {
        if (this.displayMode !== mode) {
            this.displayMode = mode;
            this._fullDirty = true;
            this._frame = null;   // Force frame re-acquire for dimension change
            this._pushScrollTrace('MODE');
        }
    }

    // ---------------------------------------------------------------
    //  FM77AV: Analog palette
    // ---------------------------------------------------------------

    rebuildAnalogPalette(analogPalette) {
        // Convert analog palette entries to rendering colors.
        for (let i = 0; i < 4096; i++) {
            const entry = analogPalette[i];
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
        if (this.displayMode === DISPLAY_MODE_400) {
            return this._render640x400(force);
        }
        if (this.displayMode === DISPLAY_MODE_262K) {
            return this._render320x200_262k(force);
        }
        if (this.displayMode === DISPLAY_MODE_320) {
            return this._render320x200(force);
        }
        return this._render640x200(force);
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

    _render640x200(force = false) {
        this._acquireFrame(SCREEN_WIDTH, SCREEN_HEIGHT);

        const needFull = this._fullDirty || force;

        if (!needFull) {
            let anyDirty = false;
            for (let b = 0; b < 25; b++) {
                if (this._dirtyBands[b]) { anyDirty = true; break; }
            }
            if (!anyDirty) return;
        }

        const pixels = this._pixelBuf;
        const displayVram = this._getDisplayVram();
        const blue  = displayVram;
        const red   = displayVram;
        const green = displayVram;
        const pal   = this._resolvedPalette;

        for (let band = 0; band < 25; band++) {
            if (!needFull && !this._dirtyBands[band]) continue;

            const yStart = band << 3;
            const yEnd = Math.min(yStart + 8, SCREEN_HEIGHT);

            for (let y = yStart; y < yEnd; y++) {
                const lineBase = y * BYTES_PER_LINE;
                const pixelRow = y * SCREEN_WIDTH;

                for (let byteX = 0; byteX < BYTES_PER_LINE; byteX++) {
                    const byteAddr = lineBase + byteX;
                    // Apply the display mask.
                    const bByte = (this.multiPage & 0x10) ? 0 : blue [BLUE_BASE  + byteAddr];
                    const rByte = (this.multiPage & 0x20) ? 0 : red  [RED_BASE   + byteAddr];
                    const gByte = (this.multiPage & 0x40) ? 0 : green[GREEN_BASE + byteAddr];
                    const px = pixelRow + (byteX << 3);

                    pixels[px    ] = pal[((gByte >> 7) & 1) << 2 | ((rByte >> 7) & 1) << 1 | ((bByte >> 7) & 1)];
                    pixels[px + 1] = pal[((gByte >> 6) & 1) << 2 | ((rByte >> 6) & 1) << 1 | ((bByte >> 6) & 1)];
                    pixels[px + 2] = pal[((gByte >> 5) & 1) << 2 | ((rByte >> 5) & 1) << 1 | ((bByte >> 5) & 1)];
                    pixels[px + 3] = pal[((gByte >> 4) & 1) << 2 | ((rByte >> 4) & 1) << 1 | ((bByte >> 4) & 1)];
                    pixels[px + 4] = pal[((gByte >> 3) & 1) << 2 | ((rByte >> 3) & 1) << 1 | ((bByte >> 3) & 1)];
                    pixels[px + 5] = pal[((gByte >> 2) & 1) << 2 | ((rByte >> 2) & 1) << 1 | ((bByte >> 2) & 1)];
                    pixels[px + 6] = pal[((gByte >> 1) & 1) << 2 | ((rByte >> 1) & 1) << 1 | ((bByte >> 1) & 1)];
                    pixels[px + 7] = pal[( gByte       & 1) << 2 | ( rByte       & 1) << 1 | ( bByte       & 1)];
                }
            }
        }

        if (needFull) {
            this._presentFull();
        } else {
            for (let band = 0; band < 25; band++) {
                if (!this._dirtyBands[band]) continue;
                const yStart = band << 3;
                const h = Math.min(8, SCREEN_HEIGHT - yStart);
                this._present(0, yStart, SCREEN_WIDTH, h);
            }
        }

        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    _render320x200(force = false) {
        this._acquireFrame(SCREEN_WIDTH, SCREEN_HEIGHT);

        if (this.analogPalette && this._analogDirty) {
            this.rebuildAnalogPalette(this.analogPalette);
            this._analogDirty = false;
        }

        const needFull = this._fullDirty || force;

        if (!needFull) {
            let anyDirty = false;
            for (let b = 0; b < 25; b++) {
                if (this._dirtyBands[b]) { anyDirty = true; break; }
            }
            if (!anyDirty) return;
        }

        const pixels = this._pixelBuf;
        // 4096-color 2-page (AV40EX/SX): blockDisplay selects the front/back block.
        const page0 = this.blockDisplay === 1 ? this.vramPage3 : this.vram;
        const page1 = this.blockDisplay === 1 ? this.vramPage4 : this.vramPage1;
        const pal = this._resolvedAnalogPalette;

        // FM77AV 320x200, 4096-color mode. Both pages are read together to
        // form the 12-bit colour index (displayVramPage is not used in this mode).

        // Build the display mask.
        let idxMask = 0xFFF;
        if (this.multiPage & 0x10) idxMask &= ~0x00F;
        if (this.multiPage & 0x20) idxMask &= ~0x0F0;
        if (this.multiPage & 0x40) idxMask &= ~0xF00;

        for (let band = 0; band < 25; band++) {
            if (!needFull && !this._dirtyBands[band]) continue;

            const yStart = band << 3;
            const yEnd = Math.min(yStart + 8, SCREEN_HEIGHT);

            for (let y = yStart; y < yEnd; y++) {
                const lineOfs = y * BYTES_PER_LINE_320;
                const pixelRow = y * SCREEN_WIDTH;

                for (let byteX = 0; byteX < BYTES_PER_LINE_320; byteX++) {
                    const ofs0 = lineOfs + byteX;
                    const ofs1 = lineOfs + byteX;

                    // 12 sub-planes across both pages
                    const b0 = page0[0x0000 + ofs0];
                    const b1 = page0[0x2000 + ofs0];
                    const r0 = page0[0x4000 + ofs0];
                    const r1 = page0[0x6000 + ofs0];
                    const g0 = page0[0x8000 + ofs0];
                    const g1 = page0[0xA000 + ofs0];
                    const b2 = page1[0x0000 + ofs1];
                    const b3 = page1[0x2000 + ofs1];
                    const r2 = page1[0x4000 + ofs1];
                    const r3 = page1[0x6000 + ofs1];
                    const g2 = page1[0x8000 + ofs1];
                    const g3 = page1[0xA000 + ofs1];

                    for (let bit = 7; bit >= 0; bit--) {
                        const idx = (
                            (((g0 >> bit) & 1) << 11) |
                            (((g1 >> bit) & 1) << 10) |
                            (((g2 >> bit) & 1) <<  9) |
                            (((g3 >> bit) & 1) <<  8) |
                            (((r0 >> bit) & 1) <<  7) |
                            (((r1 >> bit) & 1) <<  6) |
                            (((r2 >> bit) & 1) <<  5) |
                            (((r3 >> bit) & 1) <<  4) |
                            (((b0 >> bit) & 1) <<  3) |
                            (((b1 >> bit) & 1) <<  2) |
                            (((b2 >> bit) & 1) <<  1) |
                            (((b3 >> bit) & 1))
                        ) & idxMask;

                        const color = pal[idx];
                        const destX = pixelRow + (byteX * 16) + ((7 - bit) * 2);
                        pixels[destX]     = color;
                        pixels[destX + 1] = color;
                    }
                }
            }
        }

        if (needFull) {
            this._presentFull();
        } else {
            for (let band = 0; band < 25; band++) {
                if (!this._dirtyBands[band]) continue;
                const yStart = band << 3;
                const h = Math.min(8, SCREEN_HEIGHT - yStart);
                this._present(0, yStart, SCREEN_WIDTH, h);
            }
        }

        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    _render320x200_262k(force = false) {
        this._acquireFrame(SCREEN_WIDTH, SCREEN_HEIGHT);

        const needFull = this._fullDirty || force;

        if (!needFull) {
            let anyDirty = false;
            for (let b = 0; b < 25; b++) {
                if (this._dirtyBands[b]) { anyDirty = true; break; }
            }
            if (!anyDirty) return;
        }

        const pixels = this._pixelBuf;
        // 262,144-color mode uses 3 banks; on AV40EX/SX blockDisplay selects
        // the front/back block.
        const page0 = this.blockDisplay === 1 ? this.vramPage3 : this.vram;
        const page1 = this.blockDisplay === 1 ? this.vramPage4 : this.vramPage1;
        const page2 = this.blockDisplay === 1 ? this.vramPage5 : this.vramPage2;
        // Scroll offset is applied per bank when reading (bank 2 uses the
        // same offset as bank 0).
        const ofsB0 = this.vramOffset[0];
        const ofsB1 = this.vramOffset[1];
        const ofsB2 = this.vramOffset[0];

        // 262,144-color mode: 320x200, 6 bits per channel.

        for (let band = 0; band < 25; band++) {
            if (!needFull && !this._dirtyBands[band]) continue;

            const yStart = band << 3;
            const yEnd = Math.min(yStart + 8, SCREEN_HEIGHT);

            for (let y = yStart; y < yEnd; y++) {
                const lineOfs = y * BYTES_PER_LINE_320;
                const pixelRow = y * SCREEN_WIDTH;

                for (let byteX = 0; byteX < BYTES_PER_LINE_320; byteX++) {
                    const logical = lineOfs + byteX;
                    const a0 = (logical + ofsB0) & 0x1FFF;
                    const a1 = (logical + ofsB1) & 0x1FFF;
                    const a2 = (logical + ofsB2) & 0x1FFF;

                    // Read the sub-plane bytes for this position.
                    const b5 = page0[0x0000 + a0], b4 = page0[0x2000 + a0];
                    const b3 = page1[0x0000 + a1], b2 = page1[0x2000 + a1];
                    const b1 = page2[0x0000 + a2], b0 = page2[0x2000 + a2];

                    const r5 = page0[0x4000 + a0], r4 = page0[0x6000 + a0];
                    const r3 = page1[0x4000 + a1], r2 = page1[0x6000 + a1];
                    const r1 = page2[0x4000 + a2], r0 = page2[0x6000 + a2];

                    const g5 = page0[0x8000 + a0], g4 = page0[0xA000 + a0];
                    const g3 = page1[0x8000 + a1], g2 = page1[0xA000 + a1];
                    const g1 = page2[0x8000 + a2], g0 = page2[0xA000 + a2];

                    for (let bit = 7; bit >= 0; bit--) {
                        // Assemble the 6-bit value of each channel.
                        const rv = (((r5 >> bit) & 1) << 5) | (((r4 >> bit) & 1) << 4) |
                                   (((r3 >> bit) & 1) << 3) | (((r2 >> bit) & 1) << 2) |
                                   (((r1 >> bit) & 1) << 1) |  ((r0 >> bit) & 1);
                        const gv = (((g5 >> bit) & 1) << 5) | (((g4 >> bit) & 1) << 4) |
                                   (((g3 >> bit) & 1) << 3) | (((g2 >> bit) & 1) << 2) |
                                   (((g1 >> bit) & 1) << 1) |  ((g0 >> bit) & 1);
                        const bv = (((b5 >> bit) & 1) << 5) | (((b4 >> bit) & 1) << 4) |
                                   (((b3 >> bit) & 1) << 3) | (((b2 >> bit) & 1) << 2) |
                                   (((b1 >> bit) & 1) << 1) |  ((b0 >> bit) & 1);

                        // Convert the color components to the rendering format.
                        const r8 = (rv << 2) | (rv >> 4);
                        const g8 = (gv << 2) | (gv >> 4);
                        const b8 = (bv << 2) | (bv >> 4);

                        // ABGR for little-endian Uint32Array
                        const color = 0xFF000000 | (b8 << 16) | (g8 << 8) | r8;
                        const destX = pixelRow + (byteX * 16) + ((7 - bit) * 2);
                        pixels[destX]     = color;
                        pixels[destX + 1] = color;
                    }
                }
            }
        }

        if (needFull) {
            this._presentFull();
        } else {
            for (let band = 0; band < 25; band++) {
                if (!this._dirtyBands[band]) continue;
                const yStart = band << 3;
                const h = Math.min(8, SCREEN_HEIGHT - yStart);
                this._present(0, yStart, SCREEN_WIDTH, h);
            }
        }

        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    _render640x400(force = false) {
        this._acquireFrame(SCREEN_WIDTH, SCREEN_HEIGHT_400);

        const needFull = this._fullDirty || force;

        if (!needFull) {
            let anyDirty = false;
            for (let b = 0; b < 50; b++) {
                if (this._dirtyBands[b]) { anyDirty = true; break; }
            }
            if (!anyDirty) return;
        }

        const pixels = this._pixelBuf;
        // 400-line mode; blockDisplay selects the front/back block on AV40EX/SX.
        const frontB = this.vram,      frontR = this.vramPage1, frontG = this.vramPage2;
        const backB  = this.vramPage3, backR  = this.vramPage4, backG  = this.vramPage5;
        const primB = this.blockDisplay === 1 ? backB : frontB;
        const primR = this.blockDisplay === 1 ? backR : frontR;
        const primG = this.blockDisplay === 1 ? backG : frontG;
        const altB  = this.blockDisplay === 1 ? frontB : backB;
        const altR  = this.blockDisplay === 1 ? frontR : backR;
        const altG  = this.blockDisplay === 1 ? frontG : backG;
        const pal   = this._resolvedPalette;
        // Hardware window: inside the rectangle, read from the other block.
        const winOpen = this.windowOpen;
        const winFx = this.windowX1 >> 3;
        const winLx = this.windowX2 >> 3;
        const winY1 = this.windowY1;
        const winY2 = this.windowY2;

        for (let band = 0; band < 50; band++) {
            if (!needFull && !this._dirtyBands[band]) continue;

            const yStart = band << 3;
            const yEnd = Math.min(yStart + 8, SCREEN_HEIGHT_400);

            for (let y = yStart; y < yEnd; y++) {
                const lineBase = y * BYTES_PER_LINE;
                const pixelRow = y * SCREEN_WIDTH;
                const inWinY = winOpen && (y >= winY1) && (y < winY2);

                for (let byteX = 0; byteX < BYTES_PER_LINE; byteX++) {
                    const byteAddr = lineBase + byteX;
                    const useAlt = inWinY && (byteX >= winFx) && (byteX < winLx);
                    const blue  = useAlt ? altB : primB;
                    const red   = useAlt ? altR : primR;
                    const green = useAlt ? altG : primG;
                    const bByte = (this.multiPage & 0x10) ? 0 : blue [byteAddr];
                    const rByte = (this.multiPage & 0x20) ? 0 : red  [byteAddr];
                    const gByte = (this.multiPage & 0x40) ? 0 : green[byteAddr];
                    const px = pixelRow + (byteX << 3);

                    pixels[px    ] = pal[((gByte >> 7) & 1) << 2 | ((rByte >> 7) & 1) << 1 | ((bByte >> 7) & 1)];
                    pixels[px + 1] = pal[((gByte >> 6) & 1) << 2 | ((rByte >> 6) & 1) << 1 | ((bByte >> 6) & 1)];
                    pixels[px + 2] = pal[((gByte >> 5) & 1) << 2 | ((rByte >> 5) & 1) << 1 | ((bByte >> 5) & 1)];
                    pixels[px + 3] = pal[((gByte >> 4) & 1) << 2 | ((rByte >> 4) & 1) << 1 | ((bByte >> 4) & 1)];
                    pixels[px + 4] = pal[((gByte >> 3) & 1) << 2 | ((rByte >> 3) & 1) << 1 | ((bByte >> 3) & 1)];
                    pixels[px + 5] = pal[((gByte >> 2) & 1) << 2 | ((rByte >> 2) & 1) << 1 | ((bByte >> 2) & 1)];
                    pixels[px + 6] = pal[((gByte >> 1) & 1) << 2 | ((rByte >> 1) & 1) << 1 | ((bByte >> 1) & 1)];
                    pixels[px + 7] = pal[( gByte       & 1) << 2 | ( rByte       & 1) << 1 | ( bByte       & 1)];
                }
            }
        }

        if (needFull) {
            this._presentFull();
        } else {
            for (let band = 0; band < 50; band++) {
                if (!this._dirtyBands[band]) continue;
                const yStart = band << 3;
                const h = Math.min(8, SCREEN_HEIGHT_400 - yStart);
                this._present(0, yStart, SCREEN_WIDTH, h);
            }
        }

        this._fullDirty = false;
        this._dirtyBands.fill(0);
    }

    // ---------------------------------------------------------------
    //  Bulk operations
    // ---------------------------------------------------------------

    loadVRAM(data) {
        const src = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (src.length !== VRAM_SIZE) {
            throw new Error(`VRAM data must be ${VRAM_SIZE} bytes, got ${src.length}`);
        }
        this.vram.set(src);
        this._fullDirty = true;
    }

    clearVRAM() {
        this.vram.fill(0);
        this.vramPage1.fill(0);
        this.vramPage2.fill(0);
        this.vramPage3.fill(0);
        this.vramPage4.fill(0);
        this.vramPage5.fill(0);
        this._fullDirty = true;
    }

    clearWorkRam() {
        this.workRam.fill(0);
    }

    /**
     * Reset ALU and line drawing engine to power-on state.
     * Called when the sub CPU is reset.
     */
    resetALU() {
        this.aluCommand = 0;
        this.aluColor = 0;
        this.aluMask = 0;
        this.aluCompareStatus = 0;
        this.aluCompareData.fill(0x80);
        this.aluDisable = 0x00;
        this.aluTileData.fill(0);

        this.lineBusy = false;
        this._lineBusyMicros = 0;
        this.lineOffset = 0;
        this.lineStyle = 0;
        this.lineX0 = 0;
        this.lineY0 = 0;
        this.lineX1 = 0;
        this.lineY1 = 0;
        this._linePrevAddr = 0xFFFF;
        this._lineMask = 0xFF;
        this._lineCount = 0;
        this._lineBusyRemainder = 0;
    }

    /**
     * Full reset: clear VRAM, work RAM, reset palette, ALU, line engine.
     */
    reset() {
        this.clearVRAM();
        this.clearWorkRam();
        this.resetPalette();
        this.vramOffset = [0, 0];
        this.appliedScrollOffset = [0, 0];
        this._scrollWriteCount = [0, 0];
        this.vramOffsetFlag = false;
        // リセット時は表示を消灯する。
        this.crtOn = false;
        this.vramAccessEnabled = false;
        this.insLedOn = false;
        this.cycleStealMode = false;
        this.frameCount = 0;
        this.activeVramPage = 0;
        this.displayVramPage = 0;
        this.blockActive = 0;
        this.blockDisplay = 0;
        this.windowX1 = 0;
        this.windowX2 = 0;
        this.windowY1 = 0;
        this.windowY2 = 0;
        this.windowOpen = false;
        this.displayMode = DISPLAY_MODE_640;
        this._mode320Flag = false;
        this.multiPage = 0;
        this.vramBankSelect = 0;

        // Reset ALU and line drawing engine
        this.resetALU();

        this.miscReg = 0;
        this._resolvedAnalogPalette.fill(0xFF000000);
        this._analogDirty = true;
        this._fullDirty = true;
        this._frame = null;
        this._pixelBuf = null;
        this._lastBlank = false;
    }

    // ---------------------------------------------------------------
    //  Debug / inspection helpers
    // ---------------------------------------------------------------

    getPixelColor(x, y) {
        if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return 0;
        const byteOffset = (y * BYTES_PER_LINE + Math.floor(x / 8) + this.getDisplayVramOffset()) % PLANE_SIZE;
        const bit = 7 - (x & 7);
        const b = (this.vram[BLUE_BASE  + byteOffset] >> bit) & 1;
        const r = (this.vram[RED_BASE   + byteOffset] >> bit) & 1;
        const g = (this.vram[GREEN_BASE + byteOffset] >> bit) & 1;
        return (g << 2) | (r << 1) | b;
    }

    setPixel(x, y, colorIndex) {
        if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) return;
        const byteOffset = (y * BYTES_PER_LINE + Math.floor(x / 8) + this.getDisplayVramOffset()) % PLANE_SIZE;
        const bit = 7 - (x & 7);
        const mask = 1 << bit;
        const invMask = ~mask & 0xFF;

        const bAddr = BLUE_BASE  + byteOffset;
        const rAddr = RED_BASE   + byteOffset;
        const gAddr = GREEN_BASE + byteOffset;

        this.vram[bAddr] = (colorIndex & 1) ? (this.vram[bAddr] | mask) : (this.vram[bAddr] & invMask);
        this.vram[rAddr] = (colorIndex & 2) ? (this.vram[rAddr] | mask) : (this.vram[rAddr] & invMask);
        this.vram[gAddr] = (colorIndex & 4) ? (this.vram[gAddr] | mask) : (this.vram[gAddr] & invMask);

        this._dirtyBands[(y >> 3)] = 1;
    }

    drawHLine(x0, x1, y, colorIndex) {
        for (let x = x0; x <= x1; x++) {
            this.setPixel(x, y, colorIndex);
        }
    }

    fillRect(x0, y0, w, h, colorIndex) {
        for (let y = y0; y < y0 + h && y < SCREEN_HEIGHT; y++) {
            for (let x = x0; x < x0 + w && x < SCREEN_WIDTH; x++) {
                this.setPixel(x, y, colorIndex);
            }
        }
    }
}
