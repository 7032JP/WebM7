// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// FM-7 Web Simulator - Main System Class
//
// Ties together all components: dual 6809 CPUs, memory, display, FDC,
// scheduler, and keyboard into a working FM-7 emulation.
// This class is host-agnostic (no DOM / Web Audio / timers): the browser
// binding is FM7Browser (fm7_browser.js, part of the browser UI).
// =============================================================================

import { CPU6809 } from './cpu6809.js';
import { Display } from './display.js';
import { FDC } from './fdc.js';
import { Scheduler } from './scheduler.js';
import { Keyboard } from './keyboard.js';
import { PSG } from './psg.js';
import { OPN } from './opn.js';
import { usToCycles, cyclesToUs, setCPUClock, setSubCPUClock, getSubCycleRatio } from './scheduler.js';
import { CMT } from './cmt.js';

// =============================================================================
// Memory Map Constants
// =============================================================================

// Main CPU memory map
const MAIN_RAM_SIZE      = 0x8000;   // 32KB main RAM ($0000-$7FFF)
const FBASIC_ROM_BASE    = 0x8000;   // BASIC ROM ($8000-$FBFF)
const FBASIC_ROM_SIZE    = 0x7C00;   // 31KB
const IO_BASE            = 0xFD00;   // I/O space ($FD00-$FDFF)
const IO_END             = 0xFDFF;
const BOOT_ROM_BASE      = 0xFE00;   // Boot ROM ($FE00-$FFFF)
const BOOT_ROM_SIZE      = 0x0200;   // 512 bytes
const SHARED_RAM_BASE    = 0xFC80;   // Shared RAM ($FC80-$FCFF)
const SHARED_RAM_END     = 0xFCFF;
const SHARED_RAM_SIZE    = 0x0080;

// Sub CPU memory map (handled by Display class for $0000-$D40F)
const SUB_ROM_BASE       = 0xD800;   // Sub CPU ROM ($D800-$FFFF)
const SUB_ROM_SIZE       = 0x2800;   // 10KB
const CG_ROM_BASE        = 0xD000;   // CG ROM region (within sub address space)

// FM77AV Sub ROM layout
const SUB_ROM_AV_BASE    = 0xE000;   // Type-A/B ROM start ($E000-$FFFF, 8KB)
const SUB_ROM_AV_SIZE    = 0x2000;   // 8KB

// FM77AV Sub monitor types (matches $FD13 register values)
const SUB_MONITOR_C      = 0;        // FM-7 compatible ($FD13=0)
const SUB_MONITOR_A      = 1;        // FM77AV native / INITIATE ($FD13=1)
const SUB_MONITOR_B      = 2;        // FM77AV extended ($FD13=2)

// I/O port addresses (main CPU side)
const FD00_KEY_STATUS    = 0xFD00;   // Keyboard status
const FD01_KEY_DATA      = 0xFD01;   // Keyboard data
const FD02_KEY_IRQ_MASK  = 0xFD02;   // Keyboard IRQ mask
const FD03_IRQ_STATUS    = 0xFD03;   // IRQ status / mask
const FD04_IRQ_MASK      = 0xFD04;   // IRQ mask register
const FD05_SUB_CTRL      = 0xFD05;   // Sub CPU control (write: HALT/CANCEL, read: BUSY)
const FD0F_ROM_SELECT    = 0xFD0F;   // ROM bank select

// FM77AV additional I/O ports (main CPU side)
const FD12_SUB_MONITOR   = 0xFD12;   // Sub monitor type / initiator control
const FD13_SUB_BANK      = 0xFD13;   // Sub ROM bank switch + sub CPU reset
const FD30_APAL_ADDR_HI  = 0xFD30;   // Analog palette address high nibble
const FD31_APAL_ADDR_LO  = 0xFD31;   // Analog palette address low byte
const FD32_APAL_BLUE     = 0xFD32;   // Analog palette Blue data
const FD33_APAL_RED      = 0xFD33;   // Analog palette Red data

// FM77AV MMR (Memory Management Register)
const FD92_TWR_OFFSET    = 0xFD92;   // TWR (Text Window RAM) offset register
const FD93_MMR_CTRL      = 0xFD93;   // MMR control register
const MMR_WINDOW_SIZE    = 0x1000;   // 4KB per MMR window
const MMR_NUM_SEGMENTS   = 16;       // 16 × 4KB = 64KB logical space
const MMR_EXTENDED_RAM   = 0x70000;  // 448KB extended RAM (AV40: pages $40-$6F)

// FDC I/O ($FD18-$FD1F)
const FDC_IO_BASE        = 0xFD18;
const FDC_IO_END         = 0xFD1F;

// Timer IRQ period (microseconds)
const TIMER_PERIOD_US    = 2034;


// =============================================================================
// FM7 Main System Class
// =============================================================================

// Machine types
export const MACHINE_FM7        = 'fm7';
export const MACHINE_FM77       = 'fm77';
export const MACHINE_FM77AV     = 'fm77av';
export const MACHINE_FM77AV20   = 'fm77av20';
export const MACHINE_FM77AV20EX = 'fm77av20ex';
export const MACHINE_FM77AV40   = 'fm77av40';
export const MACHINE_FM77AV40EX = 'fm77av40ex';

// -----------------------------------------------------------------------
// CPU clocks
// -----------------------------------------------------------------------
// The published specifications quote the *nominal* CPU rate of 2 MHz for the
// FM-7 and every later machine (8 MHz oscillator divided down).  What
// software actually sees is lower, because the bus inserts memory wait
// cycles on every access; 1.794 MHz is that wait-adjusted effective rate.
// The sub system runs on its own 2.000 MHz clock and is *not* affected by
// the main CPU's MMR/TWR slowdown.
//
// The FM-77 and the FM77AV family share these base clocks with the FM-7.
// What the later machines add is the MMR/TWR paging hardware, whose extra
// bus waits lower the *effective* main clock while it is enabled — see
// CLOCK_AV_MMR below.
const CLOCK_MAIN       = 1794000;   // Main CPU, effective (nominal 2 MHz - waits)
const CLOCK_SUB        = 2000000;   // Sub CPU
// FM77AV family only: MMR/TWR add extra bus waits; AV20EX/AV40EX can opt into
// a high-speed MMR mode that runs above the baseline instead.
const CLOCK_AV_MMR     = 1565000;   // MMR or TWR enabled
const CLOCK_AV_MMRFAST = 2016000;   // AV20EX/AV40EX fast-MMR mode

// --- Horizontal scan timing ----------------------------------------------
// One scanline lasts a fixed wall-clock time: it is set by the CRT
// controller, not by the main CPU.  The phase must therefore be tracked in
// microseconds, never in a fixed number of main CPU cycles — the main CPU's
// effective rate moves between 1.794 MHz (baseline), 1.565 MHz (MMR/TWR) and
// 2.016 MHz (fast-MMR), so any fixed cycle count would stretch or shrink the
// scanline with it.
//
// Values are the published display timings:
//   200-line (15 kHz): H display 39-40 us + H blank 24 us = 63.5 us (15.75 kHz)
//   400-line (24 kHz): H display 30   us + H blank 11 us = 41   us (24.4  kHz)
// The 200-line display period alternates 39/40 us between odd and even lines;
// the mean 39.5 us is used, which is exactly the 79/127 active fraction the
// previous cycle-based counter had.
const HLINE_US_200 = 63.5;   // full scanline period, 200-line mode
const HDISP_US_200 = 39.5;   // active display part of it (blank starts here)
const HLINE_US_400 = 41.0;   // full scanline period, 400-line mode
const HDISP_US_400 = 30.0;   // active display part of it

export class FM7 {
    /**
     * @param {object} [parts] - optional host-provided component instances.
     *   The browser UI passes sound generators with an audio output stage
     *   (WebPSG / WebOPN) and the FDD sound synthesiser; headless use takes
     *   the core defaults (no audio device, no FDD sound).
     * @param {PSG} [parts.psg]
     * @param {OPN} [parts.opn]
     * @param {object|null} [parts.fddSound] - { seek, headLoad, diskInsert, diskEject, ... }
     */
    constructor(parts = {}) {
        // --- Machine type ---
        this._machineType = MACHINE_FM7;
        // --- Component instances ---
        this.mainCPU   = new CPU6809();
        this.subCPU    = new CPU6809();
        this.display   = new Display();
        this.fdc       = new FDC();
        this.scheduler = new Scheduler();
        this.keyboard  = new Keyboard();
        this.cmt       = new CMT();
        this.psg       = parts.psg || new PSG();
        this.opn       = parts.opn || new OPN();
        this.fddSound  = parts.fddSound || null;

        // Wire FDC sound callbacks. The FDD sound synthesiser (if the host
        // supplied one) lazily binds to whatever audio context the PSG has
        // created — if audio hasn't started yet, the callbacks become no-ops
        // and the synthesiser starts producing sound once the context is
        // available. Without a synthesiser they are no-ops as well.
        this.fdc.onSeekSound = (steps) => {
            if (this.fddSound) this.fddSound.seek(steps, this.isFM77AV);
        };
        this.fdc.onHeadLoadSound = () => {
            if (this.fddSound) this.fddSound.headLoad(this.isFM77AV);
        };
        this.fdc.onDiskInsert = () => {
            if (this.fddSound) this.fddSound.diskInsert(this.isFM77AV);
        };
        this.fdc.onDiskEject = () => {
            if (this.fddSound) this.fddSound.diskEject(this.isFM77AV);
        };

        // --- Memory arrays ---
        this.mainRAM    = new Uint8Array(0x10000);              // Full 64KB RAM (ROM overlays on top)
        this.fbasicROM  = new Uint8Array(FBASIC_ROM_SIZE);     // $8000-$FBFF
        this.bootROM    = new Uint8Array(BOOT_ROM_SIZE);        // $FE00-$FFFF (DOS boot)
        this.bootBasROM = new Uint8Array(BOOT_ROM_SIZE);       // $FE00-$FFFF (BASIC boot)
        this.subROM     = new Uint8Array(SUB_ROM_SIZE);         // Sub CPU $D800-$FFFF
        this.cgROM      = new Uint8Array(0x2000);               // CG ROM (8KB, 4 banks x 2KB)
        this.sharedRAM  = new Uint8Array(SHARED_RAM_SIZE);      // $FC80-$FCFF

        // --- FM77AV additional ROM arrays ---
        this.initiateROM = new Uint8Array(0x2000);    // Initiator ROM (up to 8KB)
        this.subROM_A    = new Uint8Array(0x2800);    // Sub-system Type-A ROM (up to 10KB: $D800-$FFFF)
        this.subROM_B    = new Uint8Array(0x2800);    // Sub-system Type-B ROM (up to 10KB: $D800-$FFFF)
        this.extsubROM   = new Uint8Array(0xC000);    // EXTSUB.ROM (48KB, AV40EX Type-D/E banks)
        this._extsubROMSize = 0;

        // --- AV40 Type-D/E sub RAM ---
        this.subRAM_DE   = new Uint8Array(0x2000);    // $E000-$FFFF writable RAM (8KB)
        this.subRAM_CG   = new Uint8Array(0x4000);    // $D800-$DFFF CG RAM (2KB x 8 banks)
        this.subRAM_CN   = new Uint8Array(0x2000);    // $C000-$CFFF Console RAM (4KB x 2 banks)
        this._cgramBank    = 0;                        // CG RAM bank selector (0-7, $D42E bits 0-2)
        this._consramBank  = 0;                        // Console RAM bank (0-2, $D42E bits 3-4)

        // --- Dictionary card / EXTSUB.ROM access ---
        this._dicromBank  = 0;       // $FD2E bits 0-5: dictionary ROM bank (0-63)
        this._dicromEn    = false;   // $FD2E bit 6: dictionary ROM enable
        this._dicramEn    = false;   // $FD2E bit 7: learning RAM enable
        this._extromSel   = false;   // $FD95 bit 7: extended ROM select (EXTSUB.ROM, AV40EX only)
        this._mmrFastMode = false;   // $FD95 bit 3: high-speed MMR (AV40EX only)
        this.dicromROM    = new Uint8Array(0x40000);   // DICROM.ROM (256KB, 64 banks x 4KB)
        this.dicromROM.fill(0xFF);
        this.dicramRAM    = new Uint8Array(0x2000);    // Learning RAM (8KB, $28000-$29FFF)

        // --- Kanji ROM (128KB level 1 + 128KB level 2) ---
        this.kanjiROM   = new Uint8Array(0x20000);    // 128KB level 1, via $FD22/$FD23
        this.kanjiROM.fill(0xFF);
        this.kanjiROM2  = new Uint8Array(0x20000);    // 128KB level 2, via $FD2E/$FD2F (read)
        this.kanjiROM2.fill(0xFF);
        this._kanjiAddr = 0;                           // 16-bit kanji ROM address register (shared L1/L2)
        this._subKanjiBank = false;                    // $D42E bit 7: sub kanji level (false=L1, true=L2)
        this._subKanjiFlag = false;                    // $FD04 bit 5: kanji ROM connected to sub (AV40+)

        // --- ROM loaded flags ---
        this.romLoaded = {
            fbasic: false,
            boot: false,
            bootBas: false,
            sub: false,
            cg: false,
            // FM77AV ROMs
            initiate: false,
            subA: false,
            subB: false,
            kanji: false,
            kanji2: false,
            dicrom: false,
            extsub: false,
        };

        // --- I/O state ---
        this._subHalted   = true;   // Sub CPU starts halted after reset
        this._subHaltRequest = false; // Deferred HALT request (applied after sub CPU instruction)
        this._subCancelRequest = false; // Deferred CANCEL request
        this._subBusy     = true;   // Sub CPU BUSY flag (set on reset, cleared by sub CPU reading $D40A)
        this._subBusyWasCleared = false; // One-shot: sub CPU cleared BUSY via $D40A read
        this._subCancel   = false;  // Sub CPU CANCEL flag
        this._subAttn     = false;  // Sub CPU attention flag (FIRQ to main CPU)
        this._breakKey    = false;  // BREAK key state (directly read via $FD04 bit1)
        this._breakKeyCodes = ['Escape', 'Pause']; // Configurable break key assignments

        // ROM write protection and keyboard handshake are enabled by default.
        // FDC spin-up delay is disabled by default. BREAK status is always readable.
        // onHwWarn(code, message) reports hardware access warnings.
        this.hwStrict = {
            romWriteProtect: true,  // writes to $8000-$FBFF ignored while ROM overlay active
            keyEncHandshake: true,  // code-system switch needs the $D432 ENCSTA handshake
            fdcSpinup:       false, // cold motor spin-up delay (disabled by default)
        };
        this.onHwWarn = null;       // (code, message) => void
        this._bootMode    = 'basic'; // 'dos' or 'basic' (current active mode)
        this._bootModeOverride = 'basic'; // 'basic' | 'dos' — machine mode selection
        this._bootModeExplicit = false;   // true once the user picks a mode; FM77AV honors it then
        this.romAdjust = true;            // false: skip boot assists (set before reset())
        // 起動補助は設定で有効なときだけ行う。互換 ROM では行わない。
        this.romAdjustBoot     = true;    // DOS 起動補助 (IPL 事前読み込み等) を行うか
        this._basicRomEnabled = true; // BASIC ROM overlay at $8000-$FBFF

        // --- FM77AV specific state ---
        this._initiateROMSize = 0;       // Actual size of loaded Initiator ROM
        this._subROM_ASize    = 0;       // Actual size of loaded Type-A ROM
        this._subROM_BSize    = 0;       // Actual size of loaded Type-B ROM
        this._initiatorActive = false;   // Initiator ROM mapped at $FE00-$FFFF
        this._initiatorHandoffDone = false; // Sub-monitor switch + log only on first disable
        this._fd10Reg         = 0;       // FM77AV extended sub CPU mode register ($FD10)
        this._subMonitorType  = SUB_MONITOR_C; // Sub monitor: C=0, A=1, B=2
        this._cgRomBank       = 0;       // CG ROM bank (0-3, bits 0-1 of $D430)
        this._nmiMaskSub      = false;   // NMI mask for sub CPU (bit 7 of $D430)
        this._subResetFlag    = false;   // Sub CPU reset flag (read via $D430 bit 0)
        this._subResetDeferred = false;  // $FD13 reset deferred while sub CPU is halted
        this._vsyncFlag       = false;   // TRUE only during the VSYNC pulse (510μs / 330μs) — $FD12 bit 0
        this._vsyncPhase      = 0;       // 0 = V-active, 1 = vfp, 2 = vsync pulse, 3 = vbp
        this._inVBlank        = false;   // TRUE during entire V-blank period (vfp + vsync + vbp) — $FD12 bit 1
        this._blankFlag       = false;   // TRUE=horizontal blanking active
        // Pre-AV machines: CRT scan steals VRAM cycles from the sub CPU
        // during active display, dropping its effective rate from 2.0 MHz to
        // ~0.75 MHz (sub gets 384 of every 1024 VRAM bus cycles per
        // scanline). FM77AV+ has a separate VRAM bus and is not affected;
        // the FM-77 is affected but can switch it off via $D405 bit 0.
        // 1024/384 inflation = sub CPU cycle accounting grows ~2.667x faster.
        this._fm7SubCycleSteal = 1024 / 384; // ≈ 2.667
        // Horizontal scan phase, in emulated microseconds since the start of
        // the current scanline.  Kept in µs rather than main CPU
        // cycles so the scanline period stays 63.5 µs (41 µs in 400-line
        // mode) on every effective main clock.
        this._fm7HBlankPhaseUs = 0;          // FM-7 / FM-77 side
        this._hblankPhaseUs    = 0;          // FM77AV side (feeds _blankFlag)
        this._hbIs400          = false;      // cached display mode of the two below
        this._hbLineUs         = HLINE_US_200;  // current scanline period
        this._hbDispUs         = HDISP_US_200;  // blank starts at this offset
        // µs per main CPU cycle at the current effective clock; refreshed by
        // _refreshCycleScale() from both clock entry points.
        this._usPerMainCycle   = 1 / (CLOCK_MAIN / 1000000);
        // Last mainCyclesTotal already converted into the sub cycle budget
        // (see the exec override). Lets the budget include DMA bus-seizure
        // padding and error-skip cycles without double counting.
        this._subBudgetMainMark = 0;
        this._subNmiDelay     = 0;       // NMI delay in cycles after sub CPU reset
        this._subNmiPending   = false;   // 20ms NMI edge latched while sub CPU was halted
        // FM77AV key encoder MCU at sub $D431/$D432 (see _keyEncProcessByte)
        this._rtcRxBuf = [];      // Sub-side response buffer (read via $D431)
        this._keyEncAckAt = 0;    // sub CPU cycle until which $D432 bit0 (ACK) reads 0 after a $D431 write
        this._keyEncSendBuf = []; // MCU command FIFO (write via $D431)
        this._keyEncFormat = 0;   // 0=9BIT FM-7 ASCII, 1=alt-ASCII, 2=SCAN
        this._keyEncNeedsRead = false; // strict: ENCSTA ($D432) must be polled between command bytes

        // BEEP (the tone itself is produced by the host, see FM7Browser;
        // the core only tracks the continuous-BEEP state)
        this._beepContinuous = false;
        this._speakerFlag = false;     // $FD03 bit 0 — speaker enable latch

        // Analog palette (4096 entries, 12-bit RGB: B4:R4:G4)
        this._analogPalette     = new Uint16Array(4096);
        this._analogPaletteAddr = 0;     // Palette write address

        // MMR (Memory Management Register) - FM77AV
        // Maps 16 × 4KB windows in logical $0000-$FFFF to physical extended RAM
        this._mmrEnabled   = false;        // MMR active flag
        this._mmrBankReg   = 0;            // $FD90: bank select (0-7) for register access AND address translation
        this._twrFlag      = false;        // $FD93 bit 6: TWR (Text Window RAM) enable
        this._twrReg       = 0;            // $FD92: TWR offset register
        this._mmrRegs      = new Uint8Array(128); // 8 banks × 16 segments
        this._mmrExt       = false;            // $FD94 bit 7: extended MMR (8 banks; off = 4 banks)
        this._extRAM       = new Uint8Array(MMR_EXTENDED_RAM); // 192KB extended RAM
        // DMAC HD6844 ($FD98-$FD99) — FM77AV40/AV40EX only.
        // Channel 0 is the FDC DMA channel; ch1-3 are used for data chaining.
        this._dmaReg       = 0;                  // currently selected register number
        this._dmaAdr       = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];   // 16-bit address regs
        this._dmaBcr       = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];   // 16-bit byte-count regs
        this._dmaChcr      = [0, 0, 0, 0];       // 8-bit channel control regs
        this._dmaPcr       = 0;                  // priority control reg ($14)
        this._dmaIcr       = 0;                  // interrupt control reg ($15)
        this._dmaDcr       = 0;                  // data chain control reg ($16)
        this._dmaFlag      = false;              // active transfer
        this.dmaActivityLatch = false;           // UI: a DMA byte moved since last poll (consumer clears)
        this._dmaBurst     = false;              // burst mode active
        // RD512 stub ($FD40-$FD4F) — sector register for ext RAM window
        this._rd512Sector  = 0;               // 16-bit sector address

        // --- OPN (YM2203) / FM Sound Card ---
        this._fmCardEnabled = false; // FM sound card: off by default for FM-7
        this._opnAddrLatch = 0;      // selreg (latched register number)
        this._opnDataBus   = 0;      // seldat (data bus latch)
        this._opnPState    = 0;      // command pstate: 0=INACTIVE 1=READDAT 2=WRITEDAT 3=ADDRESS 4=READSTAT 9=JOYSTICK
        this._opnRegs      = new Uint8Array(256);
        this._opnRegs[0x0E] = 0xFF;     // Port A: all released (active low)
        this._opnRegs[0x0F] = 0xFF;     // Port B: no joystick selected
        this._gamepadState = new Uint8Array(2);
        this._gamepadState[0] = 0xFF;   // All buttons released (active low)
        this._gamepadState[1] = 0xFF;
        // Per FM-7 port → host gamepad index (Gamepad API index, polled by the host).
        // null = unassigned (No device). [port1, port2]
        this._joystickAssign = [null, null];

        // --- PTM (MC6840 Programmable Timer Module) at $FDE0-$FDE7 ---
        // FM77AV: used for periodic timer IRQ.
        // Routes IRQ to main CPU via $FD17 bit 2.
        // Reference: Motorola MC6840 datasheet, FM77AV Technical Manual.
        // Register map (addr = addr - 0xFDE0):
        //   0 W: CR1 if CR2[0]=1 else CR3;  R: no-op ($FF)
        //   1 W: CR2;                       R: status register
        //   2 W: MSB write buffer (shared); R: T1 counter MSB (latches LSB to buffer)
        //   3 W: T1 LSB (loads latch = {msbBuf, val}, resets T1); R: T1 LSB buffered
        //   4/5: T2 same pattern
        //   6/7: T3 same pattern
        this._ptmCR      = new Uint8Array(3);  // CR1, CR2, CR3
        this._ptmLatch   = new Uint16Array(3); // T1-T3 reload latches
        this._ptmCounter = new Uint16Array(3); // T1-T3 current counter
        this._ptmLsbBuf  = new Uint8Array(3);  // T1-T3 LSB read buffer (captured at MSB read)
        this._ptmMsbWBuf = 0;                  // Shared MSB write buffer
        this._ptmStatus  = 0;                  // bit0-2: timer IRQ flags; bit7 = any IRQ & enabled
        this._ptmCycleAcc = 0;                 // Fractional cycle accumulator (PTM clock = 1MHz ≈ main/2)
        // Timers explicitly started by the guest (mode-select START / counter load).
        // Only consulted for the mouse-timer path (see _ptmTick); leaves the
        // legacy internal-clock tick untouched when the mouse is disabled.
        this._ptmRunning = [false, false, false];
        this._ptmMouseClkAcc = 0;              // accumulator for the ~19.2 kHz C-clock feed

        // --- Mouse (all machines) ---
        // Two protocols share one browser-side movement accumulator:
        //
        //  1) Bus mouse ("mouse set") at $FDE8 — single register, available
        //     on every machine as an external mouse set. A write with
        //     the low two bits set latches the pending movement (sign-INVERTED
        //     int8) and resets the phase; each read returns the next nibble
        //     (4 reads = one sample) in the order X-lo, X-hi, Y-lo, Y-hi, with
        //     the buttons in bit 4-5 and bit 7 always high while connected.
        //     Its periodic polling interrupt is generated by the PTM, whose
        //     counters are fed a ~19.2 kHz clock while the mouse is connected.
        //
        //  2) Intelligent mouse via the OPN joystick port (FM sound card on
        //     the FM-7, on-board OPN on the FM77AV family) — a level change on
        //     OPN reg 15 bit 4 (port 1) / bit 5 (port 2) strobes the phase.
        //     Movement is latched at phase 0 (NOT sign-inverted); a port-A read
        //     with matching reg-15 direction bits returns the next nibble in the
        //     order X-hi, X-lo, Y-hi, Y-lo with trigger-masked buttons.
        //
        // Exactly one device is connected at a time (_mouseMode). The
        // protocol that is not selected answers as "not connected", the same
        // as an unplugged connector; the protocol handling itself is shared.
        this._mouseMode     = 'none';  // 'none' | 'bus' | 'intel1' | 'intel2'
        this._mouseEnabled  = false;   // derived: _mouseMode !== 'none'
        this._mouseBtn      = 0x30;    // bit4 left, bit5 right; active low (bit set = released)
        this._mouseAccDX    = 0;       // browser-side pending movement (X)
        this._mouseAccDY    = 0;       // browser-side pending movement (Y)
        // Bus mouse ($FDE8) state
        this._mouseBusPhase = 0;
        this._mouseBusDX    = 0;       // sign-inverted latched byte
        this._mouseBusDY    = 0;
        // Intelligent mouse (joystick port) state
        this._intelMousePort  = 1;     // 1 = OPN joystick port 1 (default), 2 = port 2
        this._mouseIntelPhase = 0;
        this._mouseIntelDX    = 0;     // raw latched byte (not sign-inverted)
        this._mouseIntelDY    = 0;
        this._mouseIntelStrobe = false;
        this._mouseIntelLastEdge = 0;  // mainCyclesTotal at the last strobe edge

        // IRQ / FIRQ flags for main CPU
        this._timerIRQ    = false;  // Timer IRQ pending (cleared by reading $FD03)
        this._opnIrqLatch = false;  // OPN timer IRQ latch (edge-triggered, cleared by $FD03 read)
        this._opnIrqPrev  = false;  // Previous OPN IRQ state for edge detection
        this._fdcIrqPrev  = false;  // Previous FDC IRQ state for edge detection
        this._fdcDrqPrev  = false;
        this._irqMaskReg  = 0;      // $FD02 keyboard IRQ mask (bit 0)
        this._fd17MouseIrqEnable = true;  // $FD17 write bit2: マウス/PTM 割り込み許可 (リセットで許可)

        // Emulation loop state (maintained by the host's frame loop, e.g.
        // FM7Browser; reported through getStatus())
        this._running     = false;
        this._currentFPS  = 0;

        // --- Wire components together ---
        this._wireMemory();
        this._wireScheduler();
        this._wireKeyboard();
        this._wireFDC();

        // Install the default machine's (FM-7) clocks so an instance that is
        // used without an explicit setMachineType() call is still consistent.
        this._applyMachineClocks();
    }

    // =========================================================================
    // Memory Wiring
    // =========================================================================

    _wireMemory() {
        // Main CPU memory read
        this.mainCPU.setReadMem((addr) => this._mainRead(addr));
        this.mainCPU.setWriteMem((addr, val) => this._mainWrite(addr, val));

        // Sub CPU memory read
        this.subCPU.setReadMem((addr) => this._subRead(addr));
        this.subCPU.setWriteMem((addr, val) => this._subWrite(addr, val));
    }

    // =========================================================================
    // Main CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _mainRead(addr) {
        addr &= 0xFFFF;

        // FM77AV: Initiator ROM overlay takes priority over MMR.
        // When active, $6000-$7FFF always reads from Initiator ROM.
        // The upper 512 bytes of the 8KB ROM ($1E00-$1FFF) are also mirrored
        // at $FE00-$FFFF so the reset vector resolves to the initiator entry.
        if (this.isFM77AV && this._initiatorActive && this.romLoaded.initiate) {
            if (addr >= 0x6000 && addr < 0x8000) {
                return this.initiateROM[addr - 0x6000];
            }
            if (addr >= 0xFE00 && addr <= 0xFFFF) {
                return this.initiateROM[(addr - 0xFE00) + 0x1E00];
            }
        }

        // FM77AV TWR: $7C00-$7FFF window — priority over MMR
        if (this._twrFlag && addr >= 0x7C00 && addr <= 0x7FFF) {
            return this._twrRead(addr);
        }

        // FM77AV MMR: remap through segment table
        // MMR applies to $0000-$FBFF only; $FC00+ (RAM/shared/I/O) bypasses MMR
        if (this._mmrEnabled && addr < 0xFC00) {
            const seg = addr >> 12;  // 4KB segment number (0-15)
            const bankIdx = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
            const bankOff = bankIdx * MMR_NUM_SEGMENTS;
            const rawPage = this._mmrRegs[bankOff + seg];
            const physPage = this._mmrExt ? rawPage : (rawPage & 0x3F);
            // FM77AV MMR physical page mapping:
            //   Pages 0x00-0x0F: extended RAM bank 0 (64KB)
            //   Pages 0x10-0x1F: sub CPU address space (VRAM/IO/ROM) — accessible only when sub CPU halted
            //   Pages 0x20-0x2F: extended RAM bank 2 (64KB)
            //   Pages 0x30-0x3F: main RAM (same physical memory as CPU direct access)
            if ((physPage & 0x30) === 0x30) {
                const mainPage = physPage & 0x0F;
                if (mainPage !== seg) {
                    return this.mainRAM[(mainPage << 12) | (addr & 0x0FFF)];
                }
                // Identity mapping: fall through to normal map
            } else if ((physPage & 0xF0) === 0x10) {
                // Pages $10-$1F: sub CPU address space
                // Only accessible when sub CPU is halted (returns 0xFF otherwise)
                if (this._subHalted) {
                    const subAddr = ((physPage & 0x0F) << 12) | (addr & 0x0FFF);
                    const v = this._subRead(subAddr);
                    return v;
                }
                return 0xFF;
            } else if ((physPage & 0xF0) === 0x20) {
                // Pages $20-$2F: dictionary card space (日本語カード)
                const offset = addr & 0x0FFF;

                // $28000-$29FFF: Learning RAM (8KB, enabled by $FD2E bit 7)
                if ((physPage === 0x28 || physPage === 0x29) && this._dicramEn) {
                    const ramOff = ((physPage & 0x01) << 12) | offset;
                    return this.dicramRAM[ramOff];
                }

                // $2E000-$2EFFF: Dictionary ROM / EXTSUB.ROM window
                if ((physPage & 0x0F) === 0x0E && this._dicromEn) {
                    const bankAddr = this._dicromBank << 12;
                    if (this._extromSel) {
                        if (this._dicromBank >= 32) {
                            // EXTSUB.ROM: banks 32+ → extsubROM offset
                            const extOff = (bankAddr - 0x20000) | offset;
                            if (extOff < this._extsubROMSize) {
                                return this.extsubROM[extOff];
                            }
                        }
                        // extended ROM select + bank 0-31: extended ROM bank (not supported)
                        return 0xFF;
                    }
                    // DICROM.ROM: bank 0-63
                    return this.dicromROM[(bankAddr | offset) & 0x3FFFF];
                }
                // Other $2x pages: extended RAM bank B (if exists)
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
                    return this._extRAM[physAddr];
                }
                return 0xFF;
            } else {
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
                    return this._extRAM[physAddr];
                }
                return 0xFF;
            }
        }

        // $0000-$7FFF: Main RAM (32KB)
        // (Initiator ROM overlay already handled above, before MMR)
        if (addr < MAIN_RAM_SIZE) {
            return this.mainRAM[addr];
        }

        // $8000-$FBFF: BASIC ROM (if enabled) or RAM
        if (addr >= 0x8000 && addr < 0xFC00) {
            if (this._basicRomEnabled) {
                if (this.romLoaded.fbasic) {
                    return this.fbasicROM[addr - 0x8000];
                }
                // ROM enabled but not loaded - warn once
                if (!this._fbasicWarnShown) {
                    this._fbasicWarnShown = true;
                    console.error(`[ROM MISSING] BASIC ROM read at $${addr.toString(16).toUpperCase()} but not loaded! PC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
                }
            }
            return this.mainRAM[addr];
        }

        // $FC00-$FC7F: RAM
        if (addr >= 0xFC00 && addr < SHARED_RAM_BASE) {
            return this.mainRAM[addr];
        }

        // $FC80-$FCFF: Shared RAM (dual-port) — main CPU side read is valid only
        // while the sub CPU is HALTed; otherwise reads 0xFF. On real hardware the
        // dual-port bus arbitration gates main-side access to the sub HALT state.
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            if (this._subHalted) {
                return this.sharedRAM[addr - SHARED_RAM_BASE];
            }
            return 0xFF;
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            return this._mainIORead(addr);
        }

        // $FE00-$FFFF: Boot ROM area
        // (The initiator ROM overlay, when active, is handled earlier.)
        if (addr >= BOOT_ROM_BASE) {
            // $FFE0-$FFFF: Interrupt vectors in RAM
            if (addr >= 0xFFE0) {
                return this.mainRAM[addr];
            }
            // $FE00-$FFDF
            // FM77AV: once the initiator overlay is off, this area is RAM.
            if (this.isFM77AV) {
                return this.mainRAM[addr];
            }
            // FM-7 $FE00-$FFDF: the boot ROM visible here is chosen by the boot
            // mode. BASIC mode shows the BASIC-mode boot ROM, DOS mode the
            // DOS-mode boot ROM. Vectors ($FFE0+) always come from RAM (above).
            if (this._bootMode === 'basic' && this.romLoaded.bootBas) {
                return this.bootBasROM[addr - BOOT_ROM_BASE];
            }
            if (this.romLoaded.boot) {
                return this.bootROM[addr - BOOT_ROM_BASE];
            }
            return this.mainRAM[addr];
        }

        return 0xFF;
    }

    // =========================================================================
    // Main CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _mainWrite(addr, val) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // FM77AV TWR: $7C00-$7FFF window — priority over MMR
        if (this._twrFlag && addr >= 0x7C00 && addr <= 0x7FFF) {
            this._twrWrite(addr, val);
            return;
        }

        // FM77AV MMR: remap writes through segment table
        // MMR applies to $0000-$FBFF only; $FC00+ (RAM/shared/I/O) bypasses MMR
        if (this._mmrEnabled && addr < 0xFC00) {
            const seg = addr >> 12;
            const bankIdx = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
            const bankOff = bankIdx * MMR_NUM_SEGMENTS;
            const rawPage = this._mmrRegs[bankOff + seg];
            const physPage = this._mmrExt ? rawPage : (rawPage & 0x3F);
            // Pages 0x30-0x3F: main RAM
            if ((physPage & 0x30) === 0x30) {
                const mainPage = physPage & 0x0F;
                if (mainPage !== seg) {
                    this.mainRAM[(mainPage << 12) | (addr & 0x0FFF)] = val;
                    return;
                }
                // Identity: fall through to normal write path
            } else if ((physPage & 0xF0) === 0x10) {
                // Pages $10-$1F: sub CPU address space
                // Only accessible when sub CPU is halted (writes ignored otherwise)
                if (this._subHalted) {
                    const subAddr = ((physPage & 0x0F) << 12) | (addr & 0x0FFF);
                    this._subWrite(subAddr, val, true);
                }
                return;
            } else if ((physPage & 0xF0) === 0x20) {
                // Pages $20-$2F: dictionary card space
                // $28000-$29FFF: Learning RAM write
                if ((physPage === 0x28 || physPage === 0x29) && this._dicramEn) {
                    const ramOff = ((physPage & 0x01) << 12) | (addr & 0x0FFF);
                    this.dicramRAM[ramOff] = val;
                    return;
                }
                // Other $2x pages: extended RAM
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
                    this._extRAM[physAddr] = val;
                }
                return;
            } else {
                // Pages 0x00-0x0F: extended RAM
                const physAddr = (physPage << 12) | (addr & 0x0FFF);
                if (physAddr < this._extRAM.length) {
                    this._extRAM[physAddr] = val;
                }
                return;
            }
        }

        // $0000-$FBFF: RAM (writes always go to RAM, even under ROM overlay)
        if (addr < 0xFC00) {
            // Strict: while the BASIC ROM overlay is active over $8000-$FBFF,
            // real hardware does NOT latch writes to that window — the byte is
            // lost until $FD0F selects the underlying RAM.  Lenient default
            // passes the write through, which hides a missing $FD0F.
            if (this.hwStrict.romWriteProtect &&
                addr >= 0x8000 && this._basicRomEnabled && this.romLoaded.fbasic) {
                this._hwWarn('rom-overlay-write',
                    `write $${val.toString(16).padStart(2,'0')} to $${addr.toString(16).toUpperCase()} ignored: BASIC ROM overlay active (set $FD0F to map RAM first)`);
                return;
            }
            this.mainRAM[addr] = val;
            return;
        }

        // $FC00-$FC7F: RAM
        if (addr < SHARED_RAM_BASE) {
            this.mainRAM[addr] = val;
            return;
        }

        // $FC80-$FCFF: Shared RAM (dual-port) — main CPU side write is valid only
        // while the sub CPU is HALTed; otherwise dropped. On real hardware the
        // dual-port bus arbitration gates main-side access to the sub HALT state.
        if (addr >= SHARED_RAM_BASE && addr <= SHARED_RAM_END) {
            if (this._subHalted) {
                this.sharedRAM[addr - SHARED_RAM_BASE] = val;
            }
            return;
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            this._mainIOWrite(addr, val);
            return;
        }

        // $FE00-$FFFF: Boot ROM area - writes go to underlying RAM
        // (ROM overlay only affects reads; the stack often lives here)
        if (addr >= BOOT_ROM_BASE) {
            // FM77AV 系: $FE00-$FFDF のブート RAM は $FD93 bit0 が 0 の間は
            // 書き込み保護 (書き込みは捨てられる)。$FFE0-$FFFF (BIOS のワーク
            // と割り込みベクタ) は bit0 と無関係に常に書き込める。
            if (this.isFM77AV && addr <= 0xFFDF && !this._bootramRW) {
                if (!this._bootramWarned) {
                    this._bootramWarned = true;
                    this._hwWarn('bootram-write-protect',
                        `write $${val.toString(16).padStart(2,'0')} to $${addr.toString(16).toUpperCase()} ignored: boot RAM is write-protected ($FD93 bit0 = 0) PC=$${(this.mainCPU.pc || 0).toString(16).toUpperCase()}`);
                }
                return;
            }
            this.mainRAM[addr] = val;
            return;
        }
    }

    // =========================================================================
    // Main CPU I/O Read ($FD00-$FDFF)
    // =========================================================================

    _mainIORead(addr) {
        // Keyboard ($FD00 read: bit 7 = BREAK key, bit 0 = CPU speed flag)
        if (addr === FD00_KEY_STATUS) {
            let val = this.keyboard.readIO(addr);
            // bit 0: CPU speed flag — 1 = normal speed, 0 = low speed.
            //
            // What "low speed" means shifts by one generation, so this bit
            // is NOT a fixed frequency:
            //   FM-77 / FM77AV family : low speed = the FM-7's speed
            //   FM-7                  : low speed = the FM-8's speed
            // (The previous generation's 1.2288 MHz nominal rate is the
            //  FM-7's low-speed target — it is NOT the FM-7's normal speed,
            //  which is the same 2 MHz nominal as every later machine.)
            //
            // We never emulate the low-speed switch position, so every
            // machine reports 1 here.  If low speed is ever added, the value
            // must be derived from the machine type together with the switch
            // state — not from a single hard-coded frequency.
            val |= 0x01;
            return val;
        }
        if (addr === FD01_KEY_DATA) {
            return this.keyboard.readIO(addr);
        }

        // $FD02 read: bit 7 = cassette data input, bit 1 = printer, bit 0 = printer ACK
        if (addr === FD02_KEY_IRQ_MASK) {
            let val = 0x7F; // bit 7 = 0 by default
            // bit 7: cassette data input (from tape)
            val = (val & ~0x80) | this.cmt.readDataBit();
            return val;
        }

        // IRQ status ($FD03 read) - active low: 0 = pending, read clears flags
        // bit 0: keyboard, bit 1: printer, bit 2: timer, bit 3: extended (OPN/DMA/PTM)
        //
        // Hardware behaviour: bit 0 is gated by the keyboard IRQ mask
        // ($FD02 bit 0).  When the mask is set (= IRQ disabled, the
        // power-on default), bit 0 reads 1 even when a key has arrived,
        // and software cannot detect keystrokes until it writes $FD02 #$01
        // to release the mask.
        if (addr === FD03_IRQ_STATUS) {
            let status = 0xFF;
            if (this.keyboard._irqFlag && this.keyboard._irqMask === 0) {
                status &= ~0x01;
            }
            if (this._timerIRQ) {
                status &= ~0x04;
                this._timerIRQ = false;
            }
            // bit 3: extended interrupt (OPN timer A/B overflow).
            // $FD03 read only reports the flag; it does NOT clear the OPN
            // IRQ source. The IRQ is acknowledged by writing OPN register
            // $27 with reset bits ($10/$20), which clears the OPN status —
            // our auto-clear path then drops the latch.
            if (this._opnIrqLatch) status &= ~0x08;
            if (this._fdcIrqActive()) status &= ~0x08;
            return status;
        }

        // $FD17: Extended IRQ status (active low, FM77AV)
        // bit 3 (0x08): OPN timer A or B IRQ pending
        // bit 2 (0x04): PTM IRQ pending
        if (addr === 0xFD17) {
            let val = 0xFF;
            if (this._opnIrqLatch) val &= ~0x08;
            // PTM IRQ source: active low when any enabled timer has pending IRQ
            if (this._fd17MouseIrqEnable && (this._ptmStatus & 0x80)) val &= ~0x04;
            return val;
        }

        // $FD04: Sub CPU status (BUSY, attention, break key)
        if (addr === FD04_IRQ_MASK) {
            // When sub CPU is halted, report BUSY=false regardless of
            // the _subBusy latch.  The sub CPU is stopped and not
            // processing — the main CPU should be free to write shared
            // RAM.  _subHaltAck sets _subBusy=true on HALT for
            // compatibility (some code may briefly read $FD04 right
            // after writing $FD05 HALT in the same instruction flow),
            // but the authoritative answer when halted is "not busy".
            const busy = this._subHalted ? false : this._subBusy;
            let ret = busy ? 0xFF : 0x7F;  // bit 7 = BUSY only
            if (this._subAttn) {
                ret &= ~0x01;  // bit 0 = attention (active low)
                this._subAttn = false;  // Clear attention on read
            }
            // bit 1 = break key (active low: 0=pressed, 1=not pressed).
            // Software detects BREAK by polling this bit (documented FM-7
            // hardware behavior), so it is always exposed — the FIRQ path
            // coexists with it, it does not replace it.
            if (this._breakKey) ret &= ~0x02;
            return ret;
        }

        // Sub CPU status ($FD05 read)
        // bit 7 = BUSY (1=busy / halted, 0=ready). bit 0 = EXTDET.
        // Hardware semantics: BUSY is asserted both when the sub CPU
        // sets the BUSY latch ($D40A write) AND while HALT is
        // acknowledged (main CPU has acquired the sub bus). The HALT
        // protocol — main writes $FD05=$80 then polls $FD05 until bit7=1
        // — relies on the latter, so the read must reflect _subHalted
        // directly rather than depend on _subHaltAck having already
        // re-set the _subBusy latch.
        if (addr === FD05_SUB_CTRL) {
            // bit 0 (EXTDET) is reported as 0 on every machine.
            this._subBusyWasCleared = false;
            return (this._subHalted || this._subBusy) ? 0xFE : 0x7E;
        }

        // $FD0B: Boot status register (FM77AV+)
        // bit 0: 0=BASIC boot, 1=DOS boot
        // Returns $FE (BASIC) or $FF (DOS)
        if (addr === 0xFD0B) {
            if (this.isFM77AV) {
                return (this._bootMode === 'basic') ? 0xFE : 0xFF;
            }
            return 0xFF;
        }

        // $FD0F: Reading enables BASIC ROM overlay at $8000-$FBFF
        if (addr === FD0F_ROM_SELECT) {
            this._basicRomEnabled = true;
            return 0xFF;
        }

        // FM77AV: $FD10 read - Extended sub CPU status
        if (addr === 0xFD10 && this.isFM77AV) {
            // Returns mode/status byte
            return this._fd10Reg || 0x00;
        }

        // FM77AV: $FD12 read - Sub mode status
        // bit 6: mode320 (1=320x200, 0=640x200)
        // bit 1: blanking status (0 when V-blank OR H-blank active — negative logic)
        // bit 0: VSYNC status (1 during VSYNC pulse only)
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            let ret = 0xFF;
            if (this.display.displayMode === 1) ret |= 0x40; else ret &= ~0x40;
            // bit 1: clear when in V-blank (vfp+vsync+vbp) OR when in HBlank
            if (this._inVBlank || this._blankFlag) ret &= ~0x02;
            // bit 0: clear when NOT in VSYNC pulse
            if (!this._vsyncFlag) ret &= ~0x01;
            return ret;
        }

        // FM77AV: $FD30-$FD34 read — analog palette read-back
        // $FD30/$FD31 (address regs) are write-only → 0xFF.
        // $FD32-$FD34 (B/R/G nibbles) read only on AV20/AV40+; plain FM77AV → 0xFF.
        if (this.isFM77AV && addr >= 0xFD30 && addr <= 0xFD34) {
            if (addr === 0xFD30 || addr === 0xFD31) return 0xFF;
            if (!this.hasPaletteReadback) return 0xFF;
            const idx = this._analogPaletteAddr & 0xFFF;
            const entry = this._analogPalette[idx];
            switch (addr) {
                case 0xFD32: return 0xF0 | (entry & 0x0F);          // Blue
                case 0xFD33: return 0xF0 | ((entry >> 4) & 0x0F);   // Red
                case 0xFD34: return 0xF0 | ((entry >> 8) & 0x0F);   // Green
            }
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            return this.fdc.readIO(addr);
        }

        // $FD37: Multi-page register — write-only on real hardware; reads as 0xFF.
        if (addr === 0xFD37) {
            return 0xFF;
        }

        // $FD38-$FD3F: TTL palette read — top nibble reads as 0xF (open bus).
        // AV40EX uses only lower 3 bits; FM-7/FM77AV (MB15021) uses lower 4 bits.
        if (addr >= 0xFD38 && addr <= 0xFD3F) {
            const p = this.display.readPalette(addr - 0xFD38);
            return this.isAV40EX ? (0xF0 | (p & 0x07)) : (0xF0 | (p & 0x0F));
        }

        // $FD0D / $FD0E:
        //   FM-7  : standalone PSG (separate AY-3-8910 chip).
        //   FM77AV: mirror of OPN $FD15/$FD16.
        if (addr === 0xFD0D) {
            return this.isFM77AV ? 0xFF : this.psg.readCmd();
        }
        if (addr === 0xFD0E) {
            return this.isFM77AV ? this._opnReadData() : this.psg.readData();
        }

        // $FD15: OPN command register — write-only (BDIR/BC1/status-read mode).
        // Reads return open bus ($FF); OPN status is surfaced on $FD16 data bus
        // via bit2 "status read" mode.
        if (addr === 0xFD15) {
            return 0xFF;
        }

        // $FD16: OPN data bus read — dispatch on pstate
        if (addr === 0xFD16) {
            if (!this._fmCardEnabled) return 0xFF;
            return this._opnReadData();
        }

        // $FD06/$FD07: RS-232C USART (not installed: return open bus)
        if (addr === 0xFD06 || addr === 0xFD07) return 0xFF;

        // $FD20/$FD21: Kanji ROM address register (write-only, read returns 0xFF)
        // $FD22/$FD23: Kanji ROM data (level 1)
        // $FD2C/$FD2D: Kanji ROM address (aliases $FD20/$FD21, AV40EX/jcard)
        // $FD2E/$FD2F: Kanji ROM data (level 2, AV40EX/jcard)
        if (addr === 0xFD22 || addr === 0xFD23) {
            // When kanji ROM is connected to sub CPU, main reads return 0xFF
            if (this._subKanjiFlag) return 0xFF;
            const offset = (this._kanjiAddr << 1) + (addr & 1);
            return this.kanjiROM[offset & 0x1FFFF];
        }
        if ((addr === 0xFD2E || addr === 0xFD2F) && this.isAV40EX) {
            if (this._subKanjiFlag) return 0xFF;
            const offset = (this._kanjiAddr << 1) + (addr & 1);
            return this.kanjiROM2[offset & 0x1FFFF];
        }
        if (addr >= 0xFD20 && addr <= 0xFD2F) return 0xFF;

        // $FD08-$FD0C: Printer/timer I/O (stub)
        if (addr >= 0xFD08 && addr <= 0xFD0C) return 0xFF;

        // $FD11: Extended sub interface (stub)
        if (addr === 0xFD11) return 0xFF;

        // $FD13: 書き込み専用 (ハードウェアの仕様)。読みは常に $FF。
        if (addr === FD13_SUB_BANK) return 0xFF;

        // $FD14: Extended register (stub)
        if (addr === 0xFD14) return 0xFF;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return 0xFF;

        // PTM (MC6840) $FDE0-$FDE7
        if (addr >= 0xFDE0 && addr <= 0xFDE7) {
            return this._ptmRead(addr - 0xFDE0);
        }

        // Bus mouse ($FDE8) — mouse set available on all machines. When
        // disabled the read returns the "not connected" sentinel ($80,
        // bit 7 high).
        if (addr === 0xFDE8) {
            return this._mouseBusRead();
        }

        // MIDI USART stub at $FDE9-$FDEB (FM77AV+).
        // Status register $FDEB returns TX ready / TX empty ($05), RX empty. Data register
        // $FDEA returns 0xFF (no MIDI input source). Software that probes
        // the USART for device presence sees a "ready, no data" channel.
        if (this.isFM77AV && addr === 0xFDEA) return 0xFF;
        if (this.isFM77AV && addr === 0xFDEB) return 0x05;
        if (this.isFM77AV && addr === 0xFDE9) return 0xFF;

        // FM77AV40: RD512 registers ($FD40-$FD4F)
        // $FD40-$FD41: sector register (write-only), $FD48-$FD4F: data window
        if (this.isAV40 && addr >= 0xFD40 && addr <= 0xFD4F) {
            return 0xFF; // No ext RAM installed
        }

        // FM77AV40: CRTC MB89321 ($FD96-$FD97) — NOP on AV40
        if (this.isAV40 && (addr === 0xFD96 || addr === 0xFD97)) {
            return 0xFF;
        }

        // FM77AV40: DMAC HD6844 ($FD98 register select / $FD99 data)
        if (this.hasDMAC && addr === 0xFD98) return this._dmaReg & 0xFF;
        if (this.hasDMAC && addr === 0xFD99) return this._dmacReadReg(this._dmaReg);

        // MMR/TWR registers ($FD80-$FD9F) — FM-77 and later
        // $FD80-$FD8F: Segment registers for current bank (selected by $FD90)
        // $FD90: Bank select, $FD92: TWR offset (write-only), $FD93: MMR/TWR control
        // $FD94: Extended MMR/CPU speed, $FD95: Mode select 2
        if (this.hasMMR && addr >= 0xFD80 && addr <= 0xFD9F) {
            if (addr === FD93_MMR_CTRL) {
                // Returns $FF with bit7 cleared if !mmr, bit6 cleared if !twr, bit0 cleared if !bootramRW
                return 0xFF & (this._mmrEnabled ? 0xFF : ~0x80) & (this._twrFlag ? 0xFF : ~0x40) & (this._bootramRW ? 0xFF : ~0x01);
            }
            if (addr === 0xFD90) {
                return this._mmrBankReg;
            }
            if (addr <= 0xFD8F) {
                // $FD80-$FD8F: read segment registers for bank selected by $FD90
                const bankIdx = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
                return this._mmrRegs[bankIdx * MMR_NUM_SEGMENTS + (addr - 0xFD80)];
            }
            // $FD92: TWR offset register (write-only, returns $FF on read)
            if (addr === FD92_TWR_OFFSET) {
                return 0xFF;
            }
            // $FD94: Extended MMR/CPU speed — read returns $FF
            // $FD95: Mode select 2 — read returns $FF on AV40 (non-EX)
            // $FD9A-$FD9F: extended RAM probe / MR2 — no hardware = $FF
            // All three read as $FF on every machine, so the AV-only ones
            // need no separate branch here; the write side does split them.
            return 0xFF;
        }

        // Log unhandled I/O reads (FM77AV mode only, throttled)
        if (this.isFM77AV) {
            const key = addr & 0xFFFF;
            if (!this._ioWarnSeen) this._ioWarnSeen = new Set();
            if (!this._ioWarnSeen.has(key)) {
                this._ioWarnSeen.add(key);
                console.warn(`[IO READ] Unhandled $${addr.toString(16).toUpperCase()} at MainPC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
            }
        }

        // Other I/O - return default
        return 0xFF;
    }

    // =========================================================================
    // Main CPU I/O Write ($FD00-$FDFF)
    // =========================================================================

    _mainIOWrite(addr, val) {
        // $FD00 write: cassette motor control + write data
        // bit 0: cassette write data (recording), bit 1: motor (1=ON)
        if (addr === FD00_KEY_STATUS) {
            this.cmt.writeControl(val);
            return;
        }

        // $FD02: IRQ mask register (write)
        // Bit 0: key IRQ enable (1=enable), Bit 2: timer IRQ enable (1=enable)
        if (addr === FD02_KEY_IRQ_MASK) {
            this._irqMaskReg = val;
            if (val & 0x10) {
                this._hwWarn('fdc-irq-enable',
                    '$FD02 bit4 (FDC IRQ enable) set: FDC completion now raises main CPU IRQ');
            }
            this.keyboard.writeIO(addr, val);
            return;
        }

        // $FD03 write: BEEP/speaker control
        // bit 7: continuous BEEP, bit 6: single BEEP (205ms), bit 0: speaker flag
        //
        // Hardware behaviour:
        // bit 0 latches the speaker flag.  bit 6 takes priority: when set,
        // a single 205ms BEEP fires and bit 7 is ignored.  Only when bit 6
        // is clear does bit 7 control continuous BEEP on/off.
        if (addr === FD03_IRQ_STATUS) {
            this._speakerFlag = (val & 0x01) !== 0;
            if (val & 0x40) {
                // Single BEEP: 205ms tone, bit 7 ignored.
                this._beepStart(205);
            } else if (val & 0x80) {
                // Continuous BEEP on.
                this._beepStart(-1);
            } else {
                // BEEP off (no-op if already off).
                this._beepStop();
            }
            return;
        }

        // Sub CPU control ($FD05 write)
        // FM-7 I/O $FD05 write: sub CPU control
        // bit 7: 1 = HALT request, 0 = RUN request
        // bit 6: CANCEL IRQ
        // Like real hardware, HALT/RUN is a REQUEST that takes
        // effect after the sub CPU completes its current instruction.
        // _subHaltAck() applies the request at the instruction boundary.
        if (addr === FD05_SUB_CTRL) {
            this._subHaltRequest = (val & 0x80) !== 0;
            if (val & 0x40) {
                // Cancel IRQ request: deferred to instruction boundary via _subHaltAck().
                // _subHaltAck() sets _subCancel = true but does NOT assert IRQ.
                this._subCancelRequest = true;
            }
            // Level-triggered Cancel IRQ: assert/deassert based on _subCancel flag.
            // _subCancel is promoted from _subCancelRequest by _subHaltAck(),
            // so Cancel written NOW takes effect on the NEXT $FD05 write (RUN command).
            if (this._subCancel) {
                this.subCPU.intr |= 0x04; // INTR_IRQ
            } else {
                this.subCPU.intr &= ~0x04;
            }
            return;
        }

        // $FD0F: Writing disables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            this._basicRomEnabled = false;
            return;
        }

        // FM77AV40: $FD0B write - RS-232C clock/baud rate (stub)
        if (addr === 0xFD0B && this.isAV40) {
            this._fd0bReg = val & 0xFF;
            return;
        }

        // FM77AV40: $FD0C write - RS-232C extended DTR (stub)
        if (addr === 0xFD0C && this.isAV40) {
            this._fd0cReg = val & 0xFF;
            return;
        }

        // FM77AV: $FD10 write - Mode control / Initiator ROM overlay toggle
        // bit 1 controls the Initiator ROM overlay:
        //   bit 1 = 0: Initiator ROM overlay active at $6000-$7FFF / $FE00-$FFFF
        //   bit 1 = 1: Initiator disabled, underlying RAM/ROM visible
        // The overlay can be toggled both ways (software may temporarily
        // re-enable it), so both transitions are supported.
        if (addr === 0xFD10 && this.isFM77AV) {
            this._fd10Reg = val;
            const wantDisable = (val & 0x02) !== 0;
            if (this._initiatorActive && wantDisable) {
                this._initiatorActive = false;
                // Handoff side effects (sub monitor Type-C switch for BASIC
                // boot) happen only the first time the initiator is disabled.
                if (!this._initiatorHandoffDone) {
                    this._initiatorHandoffDone = true;
                    if (this._bootMode === 'basic') {
                        this._mainIOWrite(FD13_SUB_BANK, SUB_MONITOR_C);
                        this.keyboard._enableBreakCodes = false;
                        this.keyboard._useScanCodes = false;
                    }
                    // DOS boot: preserve the current BASIC ROM overlay setting.
                    console.log('FM77AV: Initiator overlay handoff complete');
                }
            } else if (!this._initiatorActive && !wantDisable && this.romLoaded.initiate) {
                this._initiatorActive = true;
            }
            return;
        }

        // FM77AV: $FD12 write - 320/640 mode select
        // bit 6: 1=320x200 mode, 0=640x200 mode
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            const mode320 = (val & 0x40) !== 0;
            this.display._mode320Flag = mode320;
            // Don't override 262K / 400-line mode — $D404 controls those
            if (this.display.displayMode !== 2 && this.display.displayMode !== 3) {
                this.display._setDisplayMode(mode320 ? 1 : 0);
            }
            return;
        }

        // FM77AV: $FD13 write - Sub ROM bank switch + Sub CPU reset
        // bit 1-0: sub ROM bank (0=Type-C, 1=Type-A, 2=Type-B)
        // AV40/AV40EX: bit 2: Type-D/E (sub RAM mode, bits 1-0 ignored)
        // Writing triggers sub CPU reset
        if (addr === FD13_SUB_BANK && this.isFM77AV) {
            let bank = val & 0x03;
            if (this.isAV40 && (val & 0x04)) {
                bank = 4; // Type-D/E: RAM mode, bits 1-0 ignored
            }
            const oldType = this._subMonitorType;
            this._subMonitorType = bank;
            this._subBusy = true;
            this._subBusyWasCleared = false;
            this._subResetFlag = true;

            // Defer sub CPU reset during HALT.
            // $FD13 does not clear HALT; $FD05 bit 7 controls its release.
            if (this._subHalted) {
                // Defer reset: update bank, reset display state, but do
                // NOT reset sub CPU or clear halt.
                this._subResetDeferred = true;
                this._applyFD13DisplayReset();
                if (oldType !== bank) {
                    console.log('FM77AV: Sub ROM bank → Type-' +
                        (['C', 'A', 'B', 'CG', 'D/E(RAM)'][bank] || bank) + ' (deferred, sub halted)');
                }
                return;
            }

            // Sub CPU is running — immediate reset
            this._subResetDeferred = false;
            this._applyFD13DisplayReset();

            this.subCPU.reset();
            this.scheduler.setSubHalted(false);
            if (oldType !== bank) {
                console.log('FM77AV: Sub ROM bank → Type-' +
                    (['C', 'A', 'B', 'CG', 'D/E(RAM)'][bank] || bank) + ', sub CPU reset');
            }
            return;
        }

        // FM77AV: $FD30-$FD34 - Analog palette
        // $FD30: palette address high (bits 11-8 from low nibble of data)
        // $FD31: palette address low (full byte = bits 7-0)
        // $FD32: Blue level (low nibble = 4-bit blue intensity)
        // $FD33: Red level (low nibble = 4-bit red intensity)
        // $FD34: Green level (low nibble = 4-bit green intensity)
        if (this.isFM77AV) {
            if (addr === FD30_APAL_ADDR_HI) {
                // High nibble of 12-bit palette address
                this._analogPaletteAddr = (this._analogPaletteAddr & 0x0FF) | ((val & 0x0F) << 8);
                return;
            }
            if (addr === FD31_APAL_ADDR_LO) {
                // Low byte of 12-bit palette address
                this._analogPaletteAddr = (this._analogPaletteAddr & 0xF00) | (val & 0xFF);
                return;
            }
            // Analog palette internal storage format:
            //   bits 0-3:  B level
            //   bits 4-7:  R level
            //   bits 8-11: G level
            // The renderer's pixel index is built with the same layout
            // (G in high bits, R in middle, B in low bits) so that pixel
            // sub-plane bits map directly into palette lookup keys.
            if (addr === FD32_APAL_BLUE) {
                // Blue data for current palette entry → bits 0-3
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xFF0) | (val & 0x0F);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('PAL_B', { idx, val: val & 0x0F });
                return;
            }
            if (addr === FD33_APAL_RED) {
                // Red data for current palette entry → bits 4-7
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0xF0F) | ((val & 0x0F) << 4);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('PAL_R', { idx, val: val & 0x0F });
                return;
            }
            // $FD34: Green data for current palette entry → bits 8-11
            if (addr === 0xFD34) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._analogPalette[idx];
                this._analogPalette[idx] = (cur & 0x0FF) | ((val & 0x0F) << 8);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('PAL_G', { idx, val: val & 0x0F });
                return;
            }
        }

        // $FD37: Multi-page register (main CPU side access)
        // Controls which color planes are visible (bit=1 → plane disabled)
        if (addr === 0xFD37) {
            if (this.display.multiPage !== val) {
                this.display.multiPage = val;
                this.display._fullDirty = true;
                this.display._pushScrollTrace('FD37', { val });
            }
            return;
        }

        // $FD38-$FD3F: TTL palette (main CPU side access)
        if (addr >= 0xFD38 && addr <= 0xFD3F) {
            this.display.writePalette(addr - 0xFD38, val);
            return;
        }

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            this.fdc.writeIO(addr, val);
            return;
        }

        // $FD0D / $FD0E:
        //   FM-7  : standalone built-in PSG (AY-3-8910), separate from OPN.
        //   FM77AV: physical mirror of OPN command/data ($FD15/$FD16).
        //           Real hardware has no separate PSG chip — the YM2203 SSG
        //           section answers both address pairs.
        if (addr === 0xFD0D) {
            if (this.isFM77AV) {
                // PSG-compat mirror of OPN command port — only lower 2 bits valid.
                this._opnWriteCmd(val & 0x03);
            } else {
                this.psg.writeCmd(val);
            }
            return;
        }
        if (addr === 0xFD0E) {
            if (this.isFM77AV) {
                this._opnWriteData(val);
            } else {
                this.psg.writeData(val);
            }
            return;
        }

        // $FD15: OPN command register — 4-bit enum decode (FM card / FM77AV).
        if (addr === 0xFD15) {
            if (this._fmCardEnabled) this._opnWriteCmd(val);
            return;
        }

        // $FD16: OPN data bus write
        if (addr === 0xFD16) {
            if (this._fmCardEnabled) this._opnWriteData(val);
            return;
        }

        // $FD00: Keyboard port write (no-op, read-only register)
        if (addr === 0xFD00) return;

        // $FD04: Main CPU side — AV40 display mode control
        // bit 2: sub-RAM write protect (0=protect, 1=unprotect)
        // bit 3: 400-line mode (0=enable, 1=disable)
        // bit 4: 262,144-color mode (1=enable, only when bit3=1)
        if (addr === 0xFD04) {
            if (this.isAV40) {
                this._subramProtect = !(val & 0x04);
                this._subKanjiFlag = !(val & 0x20); // bit 5: kanji ROM → sub (0=connect)
                const mode400l = !(val & 0x08);
                const mode256k = ((val & 0x10) !== 0) && !mode400l;

                let newMode;
                if (mode400l) {
                    newMode = 3; // DISPLAY_MODE_400
                } else if (mode256k) {
                    newMode = 2; // DISPLAY_MODE_262K
                } else if (this.display.displayMode === 2 || this.display.displayMode === 3) {
                    newMode = this.display._mode320Flag ? 1 : 0;
                } else {
                    newMode = this.display.displayMode;
                }
                if (newMode !== this.display.displayMode) {
                    this.display._setDisplayMode(newMode);
                }
            }
            return;
        }

        // $FD06/$FD07: RS-232C USART write (stub: no device)
        if (addr === 0xFD06 || addr === 0xFD07) return;

        // $FD20/$FD2C: Kanji ROM address high byte write (shared register)
        // $FD21/$FD2D: Kanji ROM address low byte write (shared register)
        // $FD22/$FD23: level 1 data (read-only), $FD2E/$FD2F: level 2 data (read-only)
        // $FD2E write: Dictionary card bank select (AV40EX built-in)
        if (addr === 0xFD20 || (addr === 0xFD2C && this.isAV40EX)) {
            this._kanjiAddr = (this._kanjiAddr & 0x00FF) | (val << 8);
            return;
        }
        if (addr === 0xFD21 || (addr === 0xFD2D && this.isAV40EX)) {
            this._kanjiAddr = (this._kanjiAddr & 0xFF00) | val;
            return;
        }
        if (addr === 0xFD2E && this.isAV40EX) {
            this._dicramEn = !!(val & 0x80);
            this._dicromEn = !!(val & 0x40);
            this._dicromBank = val & 0x3F;
            return;
        }
        if (addr >= 0xFD20 && addr <= 0xFD2F) return;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return;

        // PTM (MC6840) $FDE0-$FDE7
        if (addr >= 0xFDE0 && addr <= 0xFDE7) {
            this._ptmWrite(addr - 0xFDE0, val);
            return;
        }

        // Bus mouse ($FDE8) — mouse set available on all machines. A write
        // latches the pending movement and resets the read phase.
        if (addr === 0xFDE8) {
            this._mouseBusWrite(val);
            return;
        }

        // $FD17 write: bit2 = マウス/PTM 割り込み許可 (1=許可)
        if (addr === 0xFD17) {
            this._fd17MouseIrqEnable = (val & 0x04) !== 0;
            return;
        }

        // MIDI USART stub: writes are accepted (TX byte simulated as sent).
        if (this.isFM77AV && (addr === 0xFDE9 || addr === 0xFDEA || addr === 0xFDEB)) {
            return;
        }

        // FM77AV40: RD512 ($FD40-$FD4F) — ext RAM sector/data window
        if (this.isAV40 && addr >= 0xFD40 && addr <= 0xFD4F) {
            if (addr === 0xFD40) { this._rd512Sector = (this._rd512Sector & 0x00FF) | (val << 8); }
            else if (addr === 0xFD41) { this._rd512Sector = (this._rd512Sector & 0xFF00) | val; }
            // $FD48-$FD4F: data write (NOP — no ext RAM)
            return;
        }

        // FM77AV40: CRTC MB89321 ($FD96-$FD97) — NOP
        if (this.isAV40 && (addr === 0xFD96 || addr === 0xFD97)) return;

        // FM77AV40: DMAC HD6844 ($FD98 register select / $FD99 data)
        if (this.hasDMAC && addr === 0xFD98) { this._dmaReg = val & 0xFF; return; }
        if (this.hasDMAC && addr === 0xFD99) { this._dmacWriteReg(this._dmaReg, val); return; }

        // MMR registers ($FD80-$FD9F) — FM-77 and later.
        // $FD80-$FD93 are common to every machine that has MMR; $FD94, $FD95
        // and $FD9A-$FD9F are FM77AV-family extensions and stay gated on
        // isFM77AV inside this block.
        if (this.hasMMR && addr >= 0xFD80 && addr <= 0xFD9F) {
            // $FD93: MMR/TWR control register
            // bit 7: MMR enable, bit 6: TWR enable
            if (addr === FD93_MMR_CTRL) {
                this._mmrEnabled = (val & 0x80) !== 0;
                this._twrFlag = (val & 0x40) !== 0;
                this._bootramRW = (val & 0x01) !== 0;
                this._updateMainCpuClock();
                return;
            }
            // $FD90: MMR bank select register (selects which bank for $FD80-$FD8F AND address translation)
            if (addr === 0xFD90) {
                this._mmrBankReg = val & 0x07;
                return;
            }
            if (addr <= 0xFD8F) {
                // $FD80-$FD8F: write to segment registers for bank selected by $FD90
                const bk = this._mmrExt ? this._mmrBankReg : (this._mmrBankReg & 3);
                this._mmrRegs[bk * MMR_NUM_SEGMENTS + (addr - 0xFD80)] = val;
                return;
            }
            // $FD92: TWR offset register write
            if (addr === FD92_TWR_OFFSET) {
                this._twrReg = val & 0xFF;
                return;
            }
            // $FD94: Extended MMR / CPU speed — FM77AV family only.
            // bit 7 widens the segment table from 4 banks to 8 and lifts the
            // 6-bit cap on the physical page number.  The FM-77 has the
            // 4-bank MMR only, so the register is ignored there and _mmrExt
            // stays false, keeping it at 4 banks / 6-bit pages.
            if (addr === 0xFD94) {
                if (this.isFM77AV) {
                    this._mmrExt = (val & 0x80) !== 0;
                    // bit2: refresh speed, bit0: window speed — no effect in simulator
                }
                return;
            }
            // $FD95: Mode select 2 — FM77AV family only
            //   bit7 = extended ROM select (EXTSUB.ROM bank select) — AV40EX only
            //   bit3 = high-speed MMR (suppresses MMR slowdown) — AV20EX/AV40EX
            // hasFastMMR is false on the FM-77 (and on AV/AV20/AV40), so the
            // whole body is already machine-gated; nothing to add.
            if (addr === 0xFD95) {
                if (this.hasFastMMR) {
                    if (this.isAV40EX) {
                        this._extromSel = !!(val & 0x80);
                    }
                    this._mmrFastMode = !!(val & 0x08);
                    this._updateMainCpuClock();
                }
                return;
            }
            // $FD9A-$FD9F: extended RAM probe / MR2 — FM77AV family only,
            // and a NOP there too (no hardware behind it).  Same outcome on
            // the FM-77, so one shared NOP covers both.
            return;
        }

        // Log unhandled I/O writes (FM77AV mode only, throttled)
        if (this.isFM77AV) {
            const key = 0x10000 | (addr & 0xFFFF);
            if (!this._ioWarnSeen) this._ioWarnSeen = new Set();
            if (!this._ioWarnSeen.has(key)) {
                this._ioWarnSeen.add(key);
                console.warn(`[IO WRITE] Unhandled $${addr.toString(16).toUpperCase()} = $${val.toString(16).toUpperCase()} at MainPC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
            }
        }
    }

    // =========================================================================
    // TWR (Text Window RAM) Address Translation
    // Add the TWR offset in 256-byte units and wrap at 64 KB.
    // FM77AV: window bank 0 selects extended RAM bank 0.
    // =========================================================================

    _twrTranslate(addr) {
        return ((this._twrReg << 8) + addr) & 0xFFFF;
    }

    _twrRead(addr) {
        const physAddr = this._twrTranslate(addr);
        if (physAddr < this._extRAM.length) {
            return this._extRAM[physAddr];
        }
        return 0xFF;
    }

    _twrWrite(addr, val) {
        const physAddr = this._twrTranslate(addr);
        if (physAddr < this._extRAM.length) {
            this._extRAM[physAddr] = val;
        }
    }

    // =========================================================================
    // Sub CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _subRead(addr) {
        addr &= 0xFFFF;

        // AV40 Console RAM: $C000-$CFFF when Type-D/E + console RAM bank >= 1
        if (addr >= 0xC000 && addr < 0xD000 &&
            this._subMonitorType >= 4 && this._consramBank >= 1) {
            return this.subRAM_CN[(this._consramBank - 1) * 0x1000 + (addr - 0xC000)];
        }

        // $0000-$BFFF: VRAM (48KB) + $C000-$D37F: Work RAM
        if (addr < 0xD380) {
            return this.display.read(addr);
        }

        // $D380-$D3FF: Shared RAM (always accessible from sub CPU)
        if (addr <= 0xD3FF) {
            return this.sharedRAM[addr - 0xD380];
        }

        // $D400-$D40F: Sub CPU I/O
        if (addr <= 0xD40F) {
            // FM-7: $D410-$D7FF mirrors $D400-$D40F
            const ioAddr = 0xD400 + ((addr - 0xD400) & 0x0F);

            // $D400: Keyboard high byte (mirrors main CPU $FD00).
            // Returns 0xFF if last key has bit 8 set (PF/break-class), else 0x7F.
            // Cancel signaling is via $D402 (cancelAck) + main CPU $FD05 write.
            if (ioAddr === 0xD400) {
                return this.keyboard.readIO(0xFD00);
            }
            // $D401: Keyboard data (same as main CPU $FD01)
            if (ioAddr === 0xD401) {
                return this.keyboard.readIO(0xFD01);
            }

            // $D406/$D407: Sub-side kanji ROM read (AV40/AV40EX only)
            if ((ioAddr === 0xD406 || ioAddr === 0xD407) && this.isAV40) {
                if (!this._subKanjiFlag) return 0xFF; // not connected to sub
                const offset = (this._kanjiAddr << 1) + (ioAddr & 1);
                if (this._subKanjiBank) {
                    return this.kanjiROM2[offset & 0x1FFFF];
                }
                return this.kanjiROM[offset & 0x1FFFF];
            }

            // Display/control I/O ($D402-$D40F)
            const result = this.display.readIO(ioAddr);

            // Handle side effects that need fm7-level state
            if (result.sideEffect === 'cancelAck') {
                // $D402: Cancel IRQ ACK — clear both flag and request, deassert IRQ
                this._subCancel = false;
                this._subCancelRequest = false;
                // De-assert the level-triggered sub CPU IRQ.
                this.subCPU.intr &= ~0x04;  // INTR_IRQ = 0x04
            } else if (result.sideEffect === 'attention') {
                // $D404: Set attention flag, trigger main CPU FIRQ
                this._subAttn = true;
                this.mainCPU.firq();
            } else if (result.sideEffect === 'beep') {
                // $D403: Sub CPU BEEP trigger (single 205ms tone)
                this._beepStart(205);
            } else if (result.sideEffect === 'busyOff') {
                // $D40A read: Clear BUSY flag side effect only; data bus reads as 0xFF.
                this._subBusy = false;
                this._subBusyWasCleared = true;
                return 0xFF;
            }

            return result.value;
        }

        // FM77AV: $D410-$D4FF I/O area
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            // $D440-$D4FF: Mirror to $D400-$D43F (6-bit mask)
            if (addr >= 0xD440) {
                return this._subRead(0xD400 + ((addr - 0xD400) & 0x3F));
            }
            // $D410-$D42B: ALU + line drawing registers
            if (addr <= 0xD42B) {
                const result = this.display.readIO(addr);
                return result.value;
            }
            // $D42C-$D42F: Additional FM77AV registers
            if (addr <= 0xD42F) {
                const result = this.display.readIO(addr);
                return result.value;
            }
            // $D430: MISC register read — STATUS (different from write!)
            // bit 7: blanking status (0 when V-blank or H-blank active)
            // bit 4: line drawing status (0 when line drawing active)
            // bit 2: VSYNC status (0 when NOT in VSYNC pulse)
            // bit 0: sub CPU reset status (0 when sub CPU NOT reset)
            if (addr === 0xD430) {
                let ret = 0xFF;
                // bit 7: clear when in V-blank (vfp+vsync+vbp) OR H-blank
                if (this._inVBlank || this._blankFlag) {
                    ret &= ~0x80;
                }
                // bit 4: line drawing status (0 = busy)
                if (this.display.lineBusy) {
                    ret &= ~0x10;
                }
                // bit 2: VSYNC status (0 when NOT in vsync, i.e., during VBlank)
                if (!this._vsyncFlag) {
                    ret &= ~0x04;
                }
                // bit 0: sub CPU reset status (0 when sub CPU NOT in reset state)
                if (!this._subResetFlag) {
                    ret &= ~0x01;
                }
                return ret;
            }
            // $D431: Key encoder data receive (RTC MS58321 serial data)
            if (addr === 0xD431) {
                if (this._rtcRxBuf.length > 0) {
                    return this._rtcRxBuf.shift();
                }
                return 0xFF;
            }
            // $D432: Key encoder status
            // bit 7: RXRDY (0 = data ready in receive buffer)
            // bit 0: ACK (1 = acknowledged; 0 for ~5 us after each $D431 write)
            if (addr === 0xD432) {
                let val = 0xFF;
                if (this._rtcRxBuf.length > 0) val &= ~0x80; // RXRDY: data available
                if (this.scheduler.subCyclesTotal < this._keyEncAckAt) val &= ~0x01;
                // ENCSTA was polled — satisfies the inter-byte handshake.
                this._keyEncNeedsRead = false;
                return val;
            }
            // $D433: AV40EX VRAM block select (write-only — reads return $FF)
            // $D434-$D43F: Other FM77AV registers
            return 0xFF;
        }

        // FM77AV: Extended work RAM at $D500-$D7FF
        if (this.isFM77AV && addr >= 0xD500 && addr < SUB_ROM_BASE) {
            return this.display.workRam[0x1380 + (addr - 0xD500)];
        }

        // $D410-$D7FF: mirror / open bus
        if (addr < SUB_ROM_BASE) {
            if (this.isFM77AV) {
                // FM77AV: $D410-$D4FF already handled above
                return 0xFF;
            }
            // FM-7: $D410-$D7FF mirrors $D400-$D40F
            return this._subRead(0xD400 + ((addr - 0xD400) & 0x0F));
        }

        // $D800-$DFFF: CG ROM/RAM (FM77AV) or Sub ROM (FM-7)
        if (addr < SUB_ROM_AV_BASE) {
            if (this.isFM77AV) {
                // Type-C: use sub ROM (FM-7 compatible)
                if (this._subMonitorType === SUB_MONITOR_C) {
                    return this.subROM[addr - SUB_ROM_BASE];
                }
                // Type-D/E: CG RAM (banked, writable)
                if (this._subMonitorType >= 4) {
                    return this.subRAM_CG[this._cgramBank * 0x0800 + (addr - 0xD800)];
                }
                // Type-A/B: CG ROM with bank switching
                const cgAddr = this._cgRomBank * 0x0800 + (addr - 0xD800);
                if (cgAddr < this.cgROM.length) {
                    return this.cgROM[cgAddr];
                }
                return 0xFF;
            }
            // FM-7: Sub ROM
            return this.subROM[addr - SUB_ROM_BASE];
        }

        // $E000-$FFFF: Code ROM (bank-switched on FM77AV)
        if (this.isFM77AV) {
            // Type-C: FM-7 compatible sub ROM
            if (this._subMonitorType === SUB_MONITOR_C) {
                return this.subROM[addr - SUB_ROM_BASE];
            }
            // Type-D/E: sub RAM (writable, loaded by F-BASIC from disk)
            if (this._subMonitorType >= 4) {
                return this.subRAM_DE[addr - SUB_ROM_AV_BASE];
            }
            // Type-A or Type-B
            const rom = (this._subMonitorType === SUB_MONITOR_A) ? this.subROM_A : this.subROM_B;
            const romSize = (this._subMonitorType === SUB_MONITOR_A)
                ? (this._subROM_ASize || 0x2000)
                : (this._subROM_BSize || 0x2000);

            if (romSize > 0x2000) {
                // 10KB ROM: $E000-$FFFF portion
                return rom[addr - SUB_ROM_BASE];
            }
            // 8KB ROM: covers $E000-$FFFF
            return rom[addr - SUB_ROM_AV_BASE];
        }

        // FM-7: Type-C ROM fixed
        return this.subROM[addr - SUB_ROM_BASE];
    }

    // =========================================================================
    // Sub CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _subWrite(addr, val, fromMain = false) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // AV40 Console RAM: $C000-$CFFF when Type-D/E + console RAM bank >= 1
        if (addr >= 0xC000 && addr < 0xD000 &&
            this._subMonitorType >= 4 && this._consramBank >= 1) {
            this.subRAM_CN[(this._consramBank - 1) * 0x1000 + (addr - 0xC000)] = val;
            return;
        }

        // $0000-$BFFF: VRAM + $C000-$D37F: Work RAM
        if (addr < 0xD380) {
            this.display.write(addr, val);
            return;
        }

        // $D380-$D3FF: Shared RAM (always accessible from sub CPU)
        if (addr <= 0xD3FF) {
            this.sharedRAM[addr - 0xD380] = val;
            return;
        }

        // $D400-$D40F: Sub CPU I/O
        if (addr <= 0xD40F) {
            const ioAddr = 0xD400 + ((addr - 0xD400) & 0x0F);

            // Keyboard ($D400-$D401) - writes ignored
            if (ioAddr <= 0xD401) return;

            // $D404 (write): sub→main attention FIRQ trigger.
            // This register does NOT control display mode / 262K-color /
            // sub-RAM protect / kanji-ROM connection — those are owned
            // exclusively by the main-side $FD04. Writing here only raises
            // the sub-attention line, identical to the $D404 read path.
            if (ioAddr === 0xD404 && this.isAV40) {
                this._subAttn = true;
                this.mainCPU.firq();
                return;
            }

            // $D406/$D407: Sub-side kanji ROM address write (AV40/AV40EX only)
            // $D406 write: kanji address high byte, $D407 write: kanji address low byte
            if ((ioAddr === 0xD406 || ioAddr === 0xD407) && this.isAV40) {
                if (ioAddr & 1) {
                    this._kanjiAddr = (this._kanjiAddr & 0xFF00) | val;
                } else {
                    this._kanjiAddr = (this._kanjiAddr & 0x00FF) | (val << 8);
                }
                return;
            }

            // $D405 bit 0 (write): cycle-steal mode. Setting it releases the
            // sub CPU from the CRT's VRAM bus contention during active scan
            // (see the exec loop). The switch arrived with the FM-77; on the
            // FM-7 the contention is unconditional and there is no register
            // to turn it off, so the write is ignored there. Reads are left
            // as open bus ($FF) as before.
            if (ioAddr === 0xD405) {
                if (this.hasCycleStealControl) {
                    this.display.cycleStealMode = (val & 0x01) !== 0;
                }
                return;
            }

            // Display/control I/O
            const result = this.display.writeIO(ioAddr, val);

            // Handle side effects
            if (result && result.sideEffect === 'busyOn') {
                // $D40A write: Set BUSY
                this._subBusy = true;
                this._subBusyWasCleared = false;
            }
            return;
        }

        // FM77AV: $D410-$D4FF I/O area
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            // $D440-$D4FF: Mirror to $D400-$D43F (6-bit mask)
            if (addr >= 0xD440) {
                this._subWrite(0xD400 + ((addr - 0xD400) & 0x3F), val);
                return;
            }
            // $D410-$D42B: ALU + line drawing registers
            if (addr <= 0xD42B) {
                this.display.writeIO(addr, val);
                return;
            }
            // $D42C-$D42F: Additional FM77AV registers
            if (addr <= 0xD42F) {
                // $D42E: AV40 sub RAM bank select / sub kanji ROM select
                if (addr === 0xD42E && this.isAV40) {
                    this._cgramBank = val & 0x07;       // bits 0-2: CG RAM bank
                    this._consramBank = (val >> 3) & 0x03; // bits 3-4: console RAM bank
                    if (this._consramBank >= 3) this._consramBank = 0;
                    this._subKanjiBank = !!(val & 0x80); // bit 7: level 1/2 select
                    return;
                }
                this.display.writeIO(addr, val);
                return;
            }
            // $D430: MISC register write
            // bit 7: NMI mask (1=masked)
            // bit 6: display page select
            // bit 5: active page select
            // bit 2: extended VRAM offset flag
            // bit 1-0: CG ROM bank
            if (addr === 0xD430) {
                // Trace raw $D430 write before applying side-effects
                this.display._pushScrollTrace('D430', { val });

                // NMI mask (bit 7)
                this._nmiMaskSub = (val & 0x80) !== 0;
                if (this._nmiMaskSub) {
                    // Clear pending NMI on sub CPU
                    this.subCPU.intr &= ~0x01;  // INTR_NMI = 0x01
                    this._subNmiPending = false;
                }

                // Active VRAM page (bit 5)
                this.display._setActiveVramPage((val >> 5) & 1);

                // Display VRAM page (bit 6)
                this.display._setDisplayVramPage((val >> 6) & 1);

                // Extended VRAM offset flag (bit 2)
                this.display.vramOffsetFlag = (val & 0x04) !== 0;

                // CG ROM bank (bits 1-0)
                this._cgRomBank = val & 0x03;

                this.display.miscReg = val;
                return;
            }
            // $D431: Key encoder MCU command interface (multi-protocol)
            if (addr === 0xD431) {
                this._keyEncProcessByte(val);
                return;
            }
            // $D432: Key encoder status (read-only, writes ignored)
            // $D433: AV40EX VRAM block select — selects front/back block for 2-page
            // 400-line / 262K / 4096-color modes.
            //   bit 0: active block (write target: 0=front, 1=back)
            //   bit 4: display block (renderer source: 0=front, 1=back)
            if (addr === 0xD433 && this.isAV40EX) {
                const newActive  = val & 0x01;
                const newDisplay = (val >> 4) & 0x01;
                if (this.display.blockDisplay !== newDisplay) {
                    this.display.blockDisplay = newDisplay;
                    this.display._fullDirty = true;
                }
                this.display.blockActive = newActive;
                return;
            }
            // $D438-$D43F: AV40EX hardware window (8-byte window-coord register file)
            // Inside [x1,x2) × [y1,y2), the renderer reads the alternate block.
            //   $D438 X1 hi (bits 0-1 → X bit8-9)    $D439 X1 lo (bits 3-7 → X bit3-7, bit0-2 = 0)
            //   $D43A X2 hi                            $D43B X2 lo
            //   $D43C Y1 hi (bit 0 → Y bit8)          $D43D Y1 lo (bit 0-7)
            //   $D43E Y2 hi                            $D43F Y2 lo
            if (addr >= 0xD438 && addr <= 0xD43F && this.isAV40EX) {
                const d = this.display;
                switch (addr & 7) {
                    case 0: d.windowX1 = (d.windowX1 & 0x00F8) | ((val & 0x03) << 8); break;
                    case 1: d.windowX1 = (d.windowX1 & 0x0300) | (val & 0xF8);        break;
                    case 2: d.windowX2 = (d.windowX2 & 0x00F8) | ((val & 0x03) << 8); break;
                    case 3: d.windowX2 = (d.windowX2 & 0x0300) | (val & 0xF8);        break;
                    case 4: d.windowY1 = (d.windowY1 & 0x00FF) | ((val & 0x01) << 8); break;
                    case 5: d.windowY1 = (d.windowY1 & 0x0100) | val;                 break;
                    case 6: d.windowY2 = (d.windowY2 & 0x00FF) | ((val & 0x01) << 8); break;
                    case 7: d.windowY2 = (d.windowY2 & 0x0100) | val;                 break;
                }
                d.windowOpen = (d.windowX1 < d.windowX2) && (d.windowY1 < d.windowY2);
                d._fullDirty = true;
                return;
            }
            // $D434-$D437: Other FM77AV registers
            return;
        }

        // FM77AV: Extended work RAM at $D500-$D7FF
        if (this.isFM77AV && addr >= 0xD500 && addr < SUB_ROM_BASE) {
            this.display.workRam[0x1380 + (addr - 0xD500)] = val;
            return;
        }

        // $D410+: mirrors / open bus
        if (addr < SUB_ROM_BASE) {
            if (this.isFM77AV) {
                // FM77AV: $D410-$D4FF already handled above
                return;
            }
            // FM-7: mirrors $D400-$D40F
            this._subWrite(0xD400 + ((addr - 0xD400) & 0x0F), val);
            return;
        }

        // $D800-$FFFF: ROM area (writes ignored) or Type-D/E sub RAM (writable)
        if (this._subMonitorType >= 4) {
            // subramProtect blocks sub CPU writes only; main CPU MMR bypasses protect
            if (this._subramProtect && !fromMain) {
                return; // protected
            }
            if (addr < SUB_ROM_AV_BASE) {
                // $D800-$DFFF: CG RAM (banked)
                this.subRAM_CG[this._cgramBank * 0x0800 + (addr - 0xD800)] = val;
            } else {
                // $E000-$FFFF: sub RAM
                this.subRAM_DE[addr - SUB_ROM_AV_BASE] = val;
            }
        }
    }

    // =========================================================================
    // Scheduler Wiring
    // =========================================================================

    _wireScheduler() {
        this.scheduler.setMainCPU(this.mainCPU);
        this.scheduler.setSubCPU(this.subCPU);

        // Override scheduler exec to add per-instruction IRQ checks and FDC step
        this.scheduler.exec = (microseconds) => {
            const targetCycles = usToCycles(microseconds);
            const startMain = this.scheduler.mainCyclesTotal;
            let loopGuard = 100000; // prevent infinite loop

            while (this.scheduler.mainCyclesTotal - startMain < targetCycles) {
                if (--loopGuard <= 0) {
                    break;
                }

                // Main CPU: execute one instruction
                const mainElapsed = this.mainCPU.exec();

                if (mainElapsed <= 0) {
                    console.error('[EXEC] mainCPU.exec() returned 0 at PC=$' +
                        this.mainCPU.pc.toString(16) + ' opcode=$' +
                        this._mainRead(this.mainCPU.pc).toString(16));
                    this.scheduler.mainCyclesTotal += 2; // skip
                    continue;
                }
                this.scheduler.mainCyclesTotal += mainElapsed;

                // Line drawing BUSY timer
                if (this.display.lineBusy && this.display._lineBusyMicros > 0) {
                    this.display._lineBusyMicros -= cyclesToUs(mainElapsed);
                    if (this.display._lineBusyMicros <= 0) {
                        this.display.lineBusy = false;
                        this.display._lineBusyMicros = 0;
                    }
                }

                // FDC state machine step
                this.fdc.step(mainElapsed);

                // DMAC HD6844: drains FDC DRQ to memory while a transfer is
                // active. Burst-mode bus seizure adds extra main CPU cycles.
                if (this.hasDMAC) {
                    const dmaCycles = this._dmacExec(mainElapsed);
                    if (dmaCycles > 0) this.scheduler.mainCyclesTotal += dmaCycles;
                }

                // VSYNC pulse timing is driven by scheduler event (2-phase).
                // Horizontal scan phase: advanced in emulated µs, so a
                // scanline lasts the same wall-clock time no matter what the
                // main CPU's effective rate currently is (1.794 / 1.565 /
                // 2.016 MHz).
                // Display mode picks the period: 63.5 µs in 200-line (15 kHz),
                // 41 µs in 400-line (24 kHz).  Cached so the mode test costs
                // one comparison per instruction.
                const is400Line = (this.display.displayMode === 3); // DISPLAY_MODE_400
                if (is400Line !== this._hbIs400) {
                    this._hbIs400  = is400Line;
                    this._hbLineUs = is400Line ? HLINE_US_400 : HLINE_US_200;
                    this._hbDispUs = is400Line ? HDISP_US_400 : HDISP_US_200;
                    // Keep the phase inside the new (possibly shorter) period.
                    this._hblankPhaseUs    %= this._hbLineUs;
                    this._fm7HBlankPhaseUs %= this._hbLineUs;
                }
                const elapsedUs = mainElapsed * this._usPerMainCycle;
                if (this.isFM77AV) {
                    this._hblankPhaseUs = (this._hblankPhaseUs + elapsedUs) % this._hbLineUs;
                    this._blankFlag = this._hblankPhaseUs >= this._hbDispUs;
                } else {
                    // FM-7 / FM-77: track the phase too so the cycle-steal
                    // slowdown applies only during the active display part.
                    this._fm7HBlankPhaseUs = (this._fm7HBlankPhaseUs + elapsedUs) % this._hbLineUs;
                    // 水平ブランク状態フラグを同じ位相から求める。
                    this._blankFlag = this._fm7HBlankPhaseUs >= this._hbDispUs;
                }

                // PSG audio synthesis (generates samples into ring buffer)
                this.psg.step(mainElapsed);
                if (this._fmCardEnabled) this.opn.step(mainElapsed);
                this.cmt.step(mainElapsed);

                // PTM ticks on FM77AV machines, or while a mouse is connected.
                if (this.isFM77AV || this._mouseEnabled) this._ptmTick(mainElapsed);

                // Check and assert IRQ/FIRQ on main CPU (level-triggered)
                this._checkAndAssertInterrupts();

                // Accumulate the sub CPU cycle budget for the main cycles
                // just consumed (incl. DMA bus-seizure padding above).
                // The sub system runs on its own nominal 2.0 MHz clock,
                // independent of the main CPU's effective clock — MMR/TWR
                // slowdown (1.565 MHz) and the AV40EX fast-MMR mode
                // (2.016 MHz) must NOT propagate to the sub CPU.
                // FM-7 / FM-77: same 2.0 MHz base; the CRT cycle steal below
                // then yields 750 kHz effective during active scan and
                // the full 2.0 MHz during HBlank.
                {
                    const mainDelta = this.scheduler.mainCyclesTotal - this._subBudgetMainMark;
                    this._subBudgetMainMark = this.scheduler.mainCyclesTotal;
                    this.scheduler.subCyclesTarget += mainDelta * getSubCycleRatio();
                }

                // Apply deferred HALT/RUN at instruction boundary
                // (real hardware applies halt at instruction boundary)
                this._subHaltAck();

                // Sub CPU: catch up to its own cycle budget.
                // While halted, subCyclesTotal is fast-forwarded (without
                // executing sub instructions) so it doesn't fall behind.
                // This matches real HW: sub clock is frozen during HALT, so
                // the time that passes while halted does NOT translate into
                // extra sub work once halt is released.
                if (this.subCPU) {
                    if (this.scheduler.subHalted) {
                        this.scheduler.subCyclesTotal = this.scheduler.subCyclesTarget;
                    } else {
                        // CRT cycle steal: while the CRT is scanning
                        // out the active part of a line it owns the VRAM bus,
                        // so a sub CPU that is also on that bus is held off
                        // and its consumed clocks swell (384 of every 1024 bus
                        // cycles are left to it, i.e. ~0.75 MHz against the
                        // nominal 2.0 MHz).  Modelled by inflating the
                        // subCyclesTotal accumulation, so fewer sub
                        // instructions fit into the same budget.  FM77AV+ has
                        // a separate VRAM path and is exempt.
                        //
                        // From the FM-77 on, $D405 bit 0 releases the sub CPU
                        // from the contention; display.cycleStealMode holds
                        // that switch.  It can only ever be set on machines
                        // with hasCycleStealControl, so the FM-7 never takes
                        // that escape.
                        //
                        // The VRAM access flag ($D409) gates the contention.
                        // Apply wait cycles only during the active display period.
                        const stealActive = !this.isFM77AV
                            && !this.display.cycleStealMode
                            && this.display.vramaFlag
                            && this._fm7HBlankPhaseUs < this._hbDispUs;
                        const stealMul = stealActive ? this._fm7SubCycleSteal : 1.0;
                        let subGuard = 1000;
                        while (this.scheduler.subCyclesTotal < this.scheduler.subCyclesTarget) {
                            const subElapsed = this.subCPU.exec();
                            if (subElapsed <= 0) {
                                console.error('[EXEC] subCPU.exec() returned 0 at PC=$' +
                                    this.subCPU.pc.toString(16));
                                this.scheduler.subCyclesTotal += 2;
                                break;
                            }
                            this.scheduler.subCyclesTotal += (stealMul === 1.0)
                                ? subElapsed
                                : Math.round(subElapsed * stealMul);
                            // Also check after each sub CPU instruction for responsive halt
                            this._subHaltAck();
                            if (this.scheduler.subHalted) {
                                // Once sub halts mid-catchup, skip remaining budget.
                                this.scheduler.subCyclesTotal = this.scheduler.subCyclesTarget;
                                break;
                            }
                            if (--subGuard <= 0) break;
                        }
                    }
                }

                // Tick all scheduler events
                for (let i = 0; i < this.scheduler.events.length; i++) {
                    this.scheduler.events[i].tick(mainElapsed);
                }
            }

            const actualCycles = this.scheduler.mainCyclesTotal - startMain;
            // Convert back through the *current* main clock — it varies by
            // machine type and, on the FM77AV family, with MMR/TWR state.
            return cyclesToUs(actualCycles);
        };

        // Timer IRQ event (~2034.5us period, ~491.6 Hz)
        this.scheduler.addTimerEvent(() => {
            this._timerIRQ = true;
        });

        // Auto-type (TXT/BAS paste) pacing — driven by the emulation clock,
        // NOT the render loop.  Advancing on emulated time makes the input rate
        // independent of the host display refresh (60 vs 120/144 Hz) and of
        // whether frames are currently being rendered.  16667 µs = one 60 Hz
        // frame; the keyboard's gaps are also kept in emulated µs.
        this.scheduler.addEvent('autotype', 16667, () => {
            this.keyboard.autoTypeTick(16667);
        });

        // VSync event — 4-phase, mode-dependent timing values.
        //
        //   200-line (15kHz)  vdisp=12700 vfp=1520 vsync=510 vbp=1910 = 16640μs (60.1Hz)
        //   400-line (24kHz)  vdisp=16400 vfp= 340 vsync=330 vbp= 980 = 18050μs (55.4Hz)
        //
        // Phase 0: V-active        — vsync=0, V-blank=0 (HBlank still toggles within)
        // Phase 1: V-blank vfp     — vsync=0, V-blank=1
        // Phase 2: V-blank vsync   — vsync=1, V-blank=1   ($FD12 bit 0 high here)
        // Phase 3: V-blank vbp     — vsync=0, V-blank=1
        //
        // `_vsyncFlag` matches the short pulse (Phase 2). `_inVBlank` covers
        // the entire vertical retrace window (Phase 1+2+3) and feeds $FD12 bit 1.
        this.scheduler.addEvent('vsync', 12700, () => {
            const is400 = (this.display.displayMode === 3);
            const evt = this.scheduler.getEvent('vsync');
            const advance = (us) => {
                if (evt) {
                    evt.setIntervalUs(us);
                    evt.current = evt.reload;
                }
            };
            switch (this._vsyncPhase) {
                case 0:
                    // V-active ended → enter V-blank (vfp first)
                    this._inVBlank = true;
                    this._vsyncFlag = false;
                    this._vsyncPhase = 1;
                    this.display.frameCount++;
                    advance(is400 ? 340 : 1520);
                    break;
                case 1:
                    // vfp ended → start VSYNC pulse
                    this._vsyncFlag = true;
                    this._vsyncPhase = 2;
                    advance(is400 ? 330 : 510);
                    break;
                case 2:
                    // VSYNC pulse ended → enter vbp
                    this._vsyncFlag = false;
                    this._vsyncPhase = 3;
                    advance(is400 ? 980 : 1910);
                    break;
                default:
                    // vbp ended → V-active again
                    this._inVBlank = false;
                    this._vsyncPhase = 0;
                    advance(is400 ? 16400 : 12700);
                    break;
            }
        });

        // Sub CPU NMI timer (50 Hz = 20ms, independent of VSync)
        this.scheduler.addEvent('subnmi', 20000, () => {
            // FM77AV NMI mask ($D430 bit 7) gates the 20ms clock BEFORE the
            // CPU's edge latch — an edge occurring while masked is lost.
            if (this.isFM77AV && this._nmiMaskSub) return;
            // MC6809 /NMI edges are latched during HALT and serviced after release.
            if (this._subHalted) {
                this._subNmiPending = true;
                return;
            }
            if (!(this.subCPU.intr & 0x01)) {
                this.subCPU.nmi();
            }
        });
    }

    // =========================================================================
    // PTM (MC6840 Programmable Timer Module)
    // =========================================================================

    _ptmUpdateStatusTop() {
        // Bit 7 of status = any enabled timer has pending IRQ
        let any = false;
        for (let i = 0; i < 3; i++) {
            if ((this._ptmStatus & (1 << i)) && (this._ptmCR[i] & 0x40)) { any = true; break; }
        }
        if (any) this._ptmStatus |= 0x80;
        else this._ptmStatus &= ~0x80;
    }

    _ptmReload(idx) {
        this._ptmCounter[idx] = this._ptmLatch[idx];
    }

    _ptmRead(r) {
        // r = 0..7 (addr - 0xFDE0)
        if (r === 0) return 0xFF; // no-op read
        if (r === 1) {
            // Reading status does not clear it; reading a timer's MSB clears its flag.
            const s = this._ptmStatus;
            return s;
        }
        // r = 2,4,6: timer MSB read (captures LSB into buffer, clears IRQ flag)
        if ((r & 1) === 0) {
            const t = (r >> 1) - 1; // 2→0, 4→1, 6→2
            const cnt = this._ptmCounter[t];
            this._ptmLsbBuf[t] = cnt & 0xFF;
            // Clear timer's IRQ flag on counter read
            this._ptmStatus &= ~(1 << t);
            this._ptmUpdateStatusTop();
            return (cnt >> 8) & 0xFF;
        }
        // r = 3,5,7: buffered LSB read
        const t = ((r - 1) >> 1) - 1;
        return this._ptmLsbBuf[t];
    }

    _ptmWrite(r, val) {
        val &= 0xFF;
        if (r === 0) {
            // CR1 if CR2[0]=1, else CR3
            if (this._ptmCR[1] & 0x01) {
                this._ptmCR[0] = val;
                // CR1 bit0 = internal reset (holds all timers).
                if (val & 0x01) { this._ptmRunning[0] = this._ptmRunning[1] = this._ptmRunning[2] = false; }
            } else {
                this._ptmCR[2] = val;
            }
            return;
        }
        if (r === 1) {
            this._ptmCR[1] = val;
            return;
        }
        // r = 2,4,6: write MSB buffer (shared)
        if ((r & 1) === 0) {
            this._ptmMsbWBuf = val;
            return;
        }
        // r = 3,5,7: write LSB, commit latch, reload counter for that timer
        const t = ((r - 1) >> 1) - 1;
        this._ptmLatch[t] = ((this._ptmMsbWBuf & 0xFF) << 8) | val;
        this._ptmReload(t);
        // Loading the counter arms the timer for the mouse-timer path (the
        // legacy feed still keys off CR bit 0 and is unaffected).
        this._ptmRunning[t] = true;
        // Clear pending IRQ flag on reload
        this._ptmStatus &= ~(1 << t);
        this._ptmUpdateStatusTop();
    }

    /**
     * Tick the PTM by `mainCycles` main CPU cycles.
     * PTM internal clock ≈ 1MHz (main CPU / 2). Counters decrement each PTM tick.
     * Underflow: counter wraps to reload latch value and sets IRQ flag (mode: continuous).
     */
    _ptmTick(mainCycles) {
        // Legacy internal-clock feed: accumulate at the PTM clock rate (main/2).
        this._ptmCycleAcc += mainCycles;
        const ticks = this._ptmCycleAcc >> 1;
        this._ptmCycleAcc &= 1;

        // Mouse C-clock feed (~19.2 kHz), only present while a mouse is
        // connected. On real hardware the PTM is clocked by the mouse set, so
        // its polling timer only runs with the mouse attached; this mirrors that
        // without disturbing the legacy timer path. ~93 main cycles ≈ one
        // 19.2 kHz edge at the nominal main clock (approximation). The mouse
        // set attaches to any machine, so this is gated on the connection alone.
        const mouseActive = this._mouseEnabled;
        let cTicks = 0;
        if (mouseActive) {
            this._ptmMouseClkAcc += mainCycles;
            cTicks = (this._ptmMouseClkAcc / 93) | 0;
            this._ptmMouseClkAcc -= cTicks * 93;
        }

        if (ticks <= 0 && cTicks <= 0) return;

        for (let i = 0; i < 3; i++) {
            const cr = this._ptmCR[i];
            // CR bit 0 selects the main/2 clock feed.
            const legacy = (cr & 0x01) !== 0;
            // Mouse path: a guest-started timer the legacy path does not already
            // drive. Clocked by the C feed when CR bit 1 (clock source) = 0.
            const mouseRun = mouseActive && this._ptmRunning[i] && !legacy;
            if (!legacy && !mouseRun) continue;

            let n = (mouseRun && !(cr & 0x02)) ? cTicks : ticks;

            // T3 /8 prescaler (CR3 bit 0) — legacy feed only.
            if (i === 2 && legacy && (this._ptmCR[2] & 0x01)) {
                this._ptmT3Div = (this._ptmT3Div || 0) + n;
                n = this._ptmT3Div >> 3;
                this._ptmT3Div &= 7;
            }
            if (n <= 0) continue;

            let c = this._ptmCounter[i] - n;
            while (c < 0) {
                c += (this._ptmLatch[i] + 1);
                // Underflow: set IRQ flag
                this._ptmStatus |= (1 << i);
            }
            this._ptmCounter[i] = c & 0xFFFF;
        }
        this._ptmUpdateStatusTop();
    }

    // ==========================================================================
    // Mouse (all machines)
    // ==========================================================================
    // Button byte convention (`_mouseBtn`, active low): bit set = released,
    // bit clear = pressed. Bit 4 = left, bit 5 = right.

    // ---- Bus mouse ($FDE8) ----

    _mouseBusRead() {
        if (this._mouseMode !== 'bus') return 0x80;  // bit 7 = 1: not connected
        const phase = this._mouseBusPhase;
        this._mouseBusPhase = (phase + 1) & 0x03;
        let nibble;
        switch (phase) {
            case 0:  nibble = this._mouseBusDX & 0x0F; break;        // X-lo
            case 1:  nibble = (this._mouseBusDX >> 4) & 0x0F; break; // X-hi
            case 2:  nibble = this._mouseBusDY & 0x0F; break;        // Y-lo
            default: nibble = (this._mouseBusDY >> 4) & 0x0F; break; // Y-hi
        }
        // Buttons in bit 4-5 (pressed = 1 here), bit 7 always high while present.
        return nibble | ((~this._mouseBtn) & 0x30) | 0x80;
    }

    _mouseBusWrite(val) {
        if ((val & 0x03) === 0) return;  // low two bits clear: not a latch trigger
        this._mouseBusPhase = 0;
        if (this._mouseMode === 'bus') {
            // Snapshot pending movement (clamped int8), sign-inverted per the
            // bus-mouse convention, then clear the shared accumulator.
            let dx = this._mouseAccDX;
            let dy = this._mouseAccDY;
            if (dx > 127) dx = 127; else if (dx < -127) dx = -127;
            if (dy > 127) dy = 127; else if (dy < -127) dy = -127;
            this._mouseBusDX = (-dx) & 0xFF;
            this._mouseBusDY = (-dy) & 0xFF;
            this._mouseAccDX = 0;
            this._mouseAccDY = 0;
        } else {
            this._mouseBusDX = 0;
            this._mouseBusDY = 0;
        }
    }

    // ---- Intelligent mouse (OPN joystick port) ----

    /**
     * Strobe-edge handler, called from the OPN reg 15 write path. On a phase-0
     * edge the pending movement is latched (raw byte, NOT sign-inverted).
     */
    _mouseIntelStrobeUpdate(reg15) {
        if (this._mouseMode !== 'intel1' && this._mouseMode !== 'intel2') return;
        const mask = (this._intelMousePort === 1) ? 0x10 : 0x20;
        const newStrobe = (reg15 & mask) !== 0;
        if (newStrobe === this._mouseIntelStrobe) return;
        this._mouseIntelStrobe = newStrobe;
        // On real hardware the mouse resets its internal nibble sequencer when
        // the strobe stays idle for a while, so stray extra edges cannot leave
        // the phase permanently desynced. Model that with a 2 ms timeout,
        // evaluated lazily on the next edge (latched DX/DY are kept).
        const now = this.scheduler.mainCyclesTotal;
        if (now - this._mouseIntelLastEdge > usToCycles(2000)) {
            this._mouseIntelPhase = 0;
        }
        this._mouseIntelLastEdge = now;
        if (this._mouseIntelPhase === 0) {
            let dx = this._mouseAccDX;
            let dy = this._mouseAccDY;
            if (dx > 127) dx = 127; else if (dx < -127) dx = -127;
            if (dy > 127) dy = 127; else if (dy < -127) dy = -127;
            this._mouseIntelDX = dx & 0xFF;
            this._mouseIntelDY = dy & 0xFF;
            this._mouseAccDX = 0;
            this._mouseAccDY = 0;
        }
        this._mouseIntelPhase = (this._mouseIntelPhase + 1) & 0x03;
    }

    /**
     * Read the mouse data nibble for an OPN port-A read (selreg 14) when the
     * reg-15 direction bits select the mouse port. Returns the next nibble plus
     * trigger-masked button bits and bit 6-7 high, or null to fall through to
     * the gamepad path.
     */
    _mouseIntelRead() {
        if (this._mouseMode !== 'intel1' && this._mouseMode !== 'intel2') return null;
        const reg15 = this._opnRegs[0x0F];
        const expect = (this._intelMousePort === 1) ? 0x00 : 0x40;
        if ((reg15 & 0xC0) !== expect) return null;
        const trigger = (this._intelMousePort === 1)
            ? (reg15 & 0x03)
            : ((reg15 >> 2) & 0x03);
        let nibble;
        switch (this._mouseIntelPhase) {
            case 1:  nibble = (this._mouseIntelDX >> 4) & 0x0F; break; // X-hi
            case 2:  nibble = this._mouseIntelDX & 0x0F; break;        // X-lo
            case 3:  nibble = (this._mouseIntelDY >> 4) & 0x0F; break; // Y-hi
            default: nibble = this._mouseIntelDY & 0x0F; break;        // Y-lo (phase 0)
        }
        // Buttons (active low here), gated by the trigger-select bits.
        const btn = this._mouseBtn & ((trigger << 4) & 0x30);
        return nibble | btn | 0xC0;
    }

    // ---- Public API ----

    /**
     * Connect one mouse device: 'none' / 'bus' / 'intel1' / 'intel2'
     * (any other value is treated as 'none'). Switching modes is the
     * equivalent of reseating a connector: phase, latches and pending
     * movement are reset. Protocol handling itself is untouched.
     */
    setMouseMode(mode) {
        if (mode !== 'bus' && mode !== 'intel1' && mode !== 'intel2') mode = 'none';
        if (mode === this._mouseMode) return;
        this._mouseMode = mode;
        this._mouseEnabled = mode !== 'none';
        if (mode === 'intel1') this._intelMousePort = 1;
        else if (mode === 'intel2') this._intelMousePort = 2;
        this._mouseAccDX = 0;
        this._mouseAccDY = 0;
        this._mouseBtn = 0x30;
        this._mouseBusPhase = 0;
        this._mouseBusDX = 0;
        this._mouseBusDY = 0;
        this._mouseIntelPhase = 0;
        this._mouseIntelDX = 0;
        this._mouseIntelDY = 0;
        this._mouseIntelStrobe = false;
        this._mouseIntelLastEdge = 0;
    }

    /** Legacy toggle (UI/tests): connect or disconnect the bus mouse set. */
    setMouseEnabled(on) {
        this.setMouseMode(on ? 'bus' : 'none');
    }

    /** Select the OPN joystick port the intelligent mouse answers on (1 or 2). */
    setMousePort(port) {
        const p = (port === 2) ? 2 : 1;
        if (this._mouseMode === 'intel1' || this._mouseMode === 'intel2') {
            this.setMouseMode(p === 2 ? 'intel2' : 'intel1');
        } else {
            this._intelMousePort = p;
        }
    }

    /** Feed relative mouse motion (browser pixels); accumulates until the next latch. */
    addMouseDelta(dx, dy) {
        if (!this._mouseEnabled) return;
        this._mouseAccDX += dx | 0;
        this._mouseAccDY += dy | 0;
    }

    /**
     * Report mouse button state.
     * @param {boolean} left  - left button currently pressed
     * @param {boolean} right - right button currently pressed
     */
    setMouseButtons(left, right) {
        if (!this._mouseEnabled) return;
        let b = 0x30;              // active low: bit set = released
        if (left)  b &= ~0x10;
        if (right) b &= ~0x20;
        this._mouseBtn = b;
    }

    // ==========================================================================
    // DMAC HD6844 (FM77AV40 / AV40EX)
    // ==========================================================================
    // Channel 0 is wired to the FDC; ch1-3 are spare/data-chain channels.
    // Register map (selected via $FD98, accessed via $FD99):
    //   $00-$0F: per-channel address (hi/lo) and byte-count (hi/lo) regs
    //            ch0=$00-$03, ch1=$04-$07, ch2=$08-$0B, ch3=$0C-$0F
    //   $10-$13: per-channel control regs (chcr)
    //            bit0: 0=FDC→Mem (read), 1=Mem→FDC (write)
    //            bit1: burst mode
    //            bit3: 0=address up, 1=address down
    //            bit6: ACT (transfer active)
    //            bit7: DONE (transfer complete) — read clears
    //   $14: pcr (priority/TxRQ enable). bit0=ch0 TxRQ, etc.
    //   $15: icr (interrupt control). bit0-3=per-ch IRQ enable, bit7=IRQ pending
    //   $16: dcr (data chain control). bits0-2=chain mode, bit4=end flag

    _dmacReadReg(addr) {
        switch (addr & 0xFF) {
            // Address register (high byte) — ch0 always available, ch1-3 AV40 only
            case 0x00: case 0x04: case 0x08: case 0x0C:
                return (this._dmaAdr[addr >> 2] >> 8) & 0xFF;
            // Address register (low byte)
            case 0x01: case 0x05: case 0x09: case 0x0D:
                return this._dmaAdr[addr >> 2] & 0xFF;
            // Byte count register (high)
            case 0x02: case 0x06: case 0x0A: case 0x0E:
                return (this._dmaBcr[addr >> 2] >> 8) & 0xFF;
            // Byte count register (low)
            case 0x03: case 0x07: case 0x0B: case 0x0F:
                return this._dmaBcr[addr >> 2] & 0xFF;
            // Channel control register (read clears DONE bit7)
            case 0x10: case 0x11: case 0x12: case 0x13: {
                const ch = (addr - 0x10) & 3;
                const tmp = this._dmaChcr[ch];
                this._dmaChcr[ch] &= 0x7F;
                return tmp;
            }
            // Priority control
            case 0x14:
                return this._dmaPcr;
            // Interrupt control: returns ((dcr>>4)|0x80) & icr, then clears IRQ
            case 0x15: {
                const tmp = (((this._dmaDcr >> 4) | 0x80) & this._dmaIcr) & 0xFF;
                this._dmaDcr &= 0x0F;
                this._dmaIcr &= ~0x80;
                return tmp;
            }
            // Data chain control: returns dcr low 4 bits
            case 0x16:
                return this._dmaDcr & 0x0F;
        }
        return 0x00;
    }

    _dmacWriteReg(addr, val) {
        val &= 0xFF;
        switch (addr & 0xFF) {
            case 0x00: case 0x04: case 0x08: case 0x0C: {
                const ch = addr >> 2;
                this._dmaAdr[ch] = (this._dmaAdr[ch] & 0xFF) | (val << 8);
                return;
            }
            case 0x01: case 0x05: case 0x09: case 0x0D: {
                const ch = addr >> 2;
                this._dmaAdr[ch] = (this._dmaAdr[ch] & 0xFF00) | val;
                return;
            }
            case 0x02: case 0x06: case 0x0A: case 0x0E: {
                const ch = addr >> 2;
                this._dmaBcr[ch] = (this._dmaBcr[ch] & 0xFF) | (val << 8);
                return;
            }
            case 0x03: case 0x07: case 0x0B: case 0x0F: {
                const ch = addr >> 2;
                this._dmaBcr[ch] = (this._dmaBcr[ch] & 0xFF00) | val;
                return;
            }
            // chcr: high 4 bits (ACT/DONE/etc) preserved, low 4 bits writable
            case 0x10: case 0x11: case 0x12: case 0x13: {
                const ch = (addr - 0x10) & 3;
                this._dmaChcr[ch] = (this._dmaChcr[ch] & 0xC0) | (val & 0x0F);
                return;
            }
            case 0x14:
                this._dmaPcr = val & 0x8F;
                return;
            case 0x15:
                this._dmaIcr = (this._dmaIcr & 0x80) | (val & 0x0F);
                return;
            case 0x16:
                this._dmaDcr = (this._dmaDcr & 0xF0) | (val & 0x0F);
                return;
        }
    }

    /**
     * Per-instruction DMAC tick. Called from the main exec loop after FDC
     * step. Auto-activates ch0 when the FDC drives DRQ with TxRQ enabled,
     * then transfers one byte per DRQ. Burst mode keeps the bus seized
     * (and stalls the main CPU 2 cycles per poll) between DRQs.
     *
     * Returns the number of main CPU cycles consumed by the DMA bus seizure
     * (0 when no transfer happened).
     */
    _dmacExec(mainElapsed) {
        if (!this.hasDMAC) return 0;

        // Auto-activate when FDC raises DRQ with a pending transfer
        if (!this._dmaFlag &&
            this._dmaBcr[0] > 0 &&
            (this._dmaPcr & 0x01) &&
            this.fdc.drqFlag) {
            this._dmaFlag = true;
            this._dmaChcr[0] = (this._dmaChcr[0] & 0x0F) | 0x40;  // ACT
        }

        if (!this._dmaFlag) return 0;
        if (!(this._dmaPcr & 0x01)) return 0;   // TxRQ dropped

        const ch = 0;

        // BCR exhausted before transfer started
        if (this._dmaBcr[ch] === 0) {
            this._dmaFlag = false;
            this._dmaChcr[ch] = (this._dmaChcr[ch] & 0x0F) | 0x80; // DONE
            return 0;
        }

        // Wait for FDC DRQ
        if (!this.fdc.drqFlag) {
            // In burst mode the bus is held; advance scheduler 2 cycles per
            // poll so events still fire and we don't deadlock.
            return this._dmaBurst ? 2 : 0;
        }

        // Latch burst mode at first byte
        if ((this._dmaChcr[ch] & 0x02) && !this._dmaBurst) {
            this._dmaBurst = true;
        }

        let cycles = 3;  // bus seizure cost per byte
        this.dmaActivityLatch = true;   // for the status-bar DMA (green) LED
        // DMA bus master forces MMR segment to 0 for the duration of the
        // transfer (HD6844 spec). Without this, a program that selects a
        // non-zero MMR bank and then runs FDC DMA would read/write the wrong
        // physical RAM bank.
        const savedSeg = this._mmrBankReg;
        this._mmrBankReg = 0;
        if (this._dmaChcr[ch] & 0x01) {
            // Mem → FDC (write)
            const dat = this._mainRead(this._dmaAdr[ch]);
            this.fdc.writeIO(0xFD1B, dat);
        } else {
            // FDC → Mem (read)
            const dat = this.fdc.readIO(0xFD1B);
            this._mainWrite(this._dmaAdr[ch], dat);
        }
        this._mmrBankReg = savedSeg;

        // Address update (bit3: 0=up, 1=down)
        if (this._dmaChcr[ch] & 0x08) {
            this._dmaAdr[ch] = (this._dmaAdr[ch] - 1) & 0xFFFF;
        } else {
            this._dmaAdr[ch] = (this._dmaAdr[ch] + 1) & 0xFFFF;
        }

        this._dmaBcr[ch] = (this._dmaBcr[ch] - 1) & 0xFFFF;

        // Transfer complete
        if (this._dmaBcr[ch] === 0) {
            // Data chain (AV40 only): if dcr low3 == 1, refill ch0 from ch3
            if ((this._dmaDcr & 0x07) === 0x01) {
                this._dmaAdr[0] = this._dmaAdr[3];
                this._dmaBcr[0] = this._dmaBcr[3];
                this._dmaBcr[3] = 0;
            } else {
                this._dmaFlag = false;
                this._dmaBurst = false;
                this._dmaChcr[ch] = (this._dmaChcr[ch] & 0x0F) | 0x80; // DONE
                this._dmaDcr |= 0x10;  // end flag
                if (this._dmaIcr & 0x01) {
                    this._dmaIcr |= 0x80;  // IRQ pending
                }
            }
        }
        return cycles;
    }

    _fdcIrqActive() {
        return !!(this.fdc.irqFlag && (this._irqMaskReg & 0x10));
    }

    /** Check all IRQ/FIRQ sources and assert on CPUs */
    _checkAndAssertInterrupts() {
        // Main CPU IRQ: timer, keyboard, FDC, OPN timers
        // 6809 IRQ is level-triggered: asserted while source is active,
        // de-asserted when all sources go inactive.
        let mainIrq = false;

        // Timer IRQ: $FD02 bit2 (1=enable, 0=mask)
        if (this._timerIRQ && (this._irqMaskReg & 0x04)) mainIrq = true;

        // Keyboard IRQ: use keyboard module's actual state (handles its own mask)
        if (this.keyboard.isIRQActive()) mainIrq = true;

        // FDC: INTRQ は $FD02 bit4 が 1 のときだけメイン CPU の IRQ になる
        // (リセット時は 0 でマスク)。$FD18 の読みで irqFlag が落ちて解除される。
        if (this._fdcIrqActive()) mainIrq = true;

        // OPN Timer IRQ: routed through $FD03 bit3 "extended interrupt".
        // The IRQ source is the OPN status
        // bits 0/1 (Timer A/B overflow). The program's IRQ handler clears
        // these by writing OPN register $27 with reset bits ($10/$20).
        // Edge-triggered latch: set on new OPN timer overflow, auto-clears
        // when the underlying OPN status bits clear. The latch is also
        // cleared by reading $FD03. (Either path is sufficient.)
        if (this._fmCardEnabled) {
            const opnActive = (this.opn.timerAFlag && this.opn._timerAIRQ) ||
                              (this.opn.timerBFlag && this.opn._timerBIRQ);
            if (opnActive && !this._opnIrqPrev) this._opnIrqLatch = true;
            // Auto-clear when the OPN side has dropped both flags. Without
            // this, a program whose IRQ handler resets timers via OPN reg $27
            // (without ever reading $FD03) would experience an IRQ storm.
            if (!opnActive) this._opnIrqLatch = false;
            this._opnIrqPrev = opnActive;
            if (this._opnIrqLatch) mainIrq = true;
        }

        // PTM IRQ ($FDE0-$FDE7, routed via $FD17 bit 2). Present on the
        // FM77AV family (on-board) and on any machine while a mouse
        // (the mouse set carries the PTM) is connected.
        if ((this.isFM77AV || this._mouseEnabled) && this._fd17MouseIrqEnable && (this._ptmStatus & 0x80)) mainIrq = true;

        // DMAC IRQ (FM77AV40+): icr bit7 set when transfer completes and any
        // channel TxRQ is enabled in icr low 4 bits.
        if (this.hasDMAC && (this._dmaIcr & 0x80)) mainIrq = true;

        // Level-triggered: assert or de-assert IRQ based on current sources
        if (mainIrq) this.mainCPU.irq();
        else this.mainCPU.intr &= ~0x04;  // INTR_IRQ

        // Sub CPU FIRQ: keyboard-driven, gated by $FD02 bit 0.
        // $FD02 bit 0 controls keyboard routing:
        //   bit 0 = 0 → keyboard._irqMask = 1 → keyboard routed to sub CPU via FIRQ
        //   bit 0 = 1 → keyboard._irqMask = 0 → keyboard routed to main CPU via IRQ
        // When keyboard is routed to main CPU, sub CPU FIRQ must be cleared.
        // Use _irqFlag (edge, cleared on $FD01 read) rather than
        // _keyAvailable (level, stays latched on the data register)
        // so sub FIRQ tracks new events only.
        if (this.keyboard._irqFlag && this.keyboard._irqMask !== 0) {
            this.subCPU.intr |= 0x02; // INTR_FIRQ
        } else {
            this.subCPU.intr &= ~0x02;
        }

        // Main CPU FIRQ is edge-triggered: asserted once when sub CPU
        // reads $D404 (in _subRead). Do NOT re-assert here every cycle,
        // or the main CPU gets stuck in infinite FIRQ.
    }

    // =========================================================================
    // Sub CPU HALT acknowledge (deferred application)
    // =========================================================================

    /**
     * Apply pending HALT/RUN/CANCEL requests at sub CPU instruction boundary.
     * Called after each sub CPU instruction completes.
     * Real hardware applies halt at instruction boundaries.
     */
    /** Display-side reset performed on $FD13 write (extracted for deferred path) */
    _applyFD13DisplayReset() {
        this.display.resetALU();
        this.display.resetPalette();
        this.display.multiPage = 0;
        // Un-rotate VRAM before zeroing offsets
        const savedActive = this.display.activeVramPage;
        for (let p = 0; p < 2; p++) {
            if (this.display.crtcOffset[p] !== 0) {
                this.display.activeVramPage = p;
                this.display._vramScroll((-this.display.crtcOffset[p]) & 0xFFFF);
            }
        }
        this.display.activeVramPage = savedActive;
        this.display.vramOffset[0] = 0;
        this.display.vramOffset[1] = 0;
        this.display.crtcOffset[0] = 0;
        this.display.crtcOffset[1] = 0;
        this.display._vramOffsetCount[0] = 0;
        this.display._vramOffsetCount[1] = 0;
        this.display.vramOffsetFlag = false;
        // CRT 表示は $D408 の読みで点灯し、サブ CPU のリセットで消灯する。
        this.display.crtOn = false;
        this.display.vramaFlag = false;
        this.display.insLedOn = false;
        // $D405 bit 0 is a sub-side display control latch; clear it with the
        // other display latches on sub CPU reset. Harmless on the FM-7,
        // where it can never have been set.
        this.display.cycleStealMode = false;
        this.display.activeVramPage = 0;
        this.display.displayVramPage = 0;
        // Reset display mode: 400-line / 262K → restore to 200-line mode
        // But NOT when entering Type-D/E — $FD04 sets 400-line before $FD13
        if (this.display.displayMode >= 2 && this._subMonitorType < 4) {
            const newMode = this.display._mode320Flag ? 1 : 0;
            this.display._setDisplayMode(newMode);
        }
        this.display.subramVramBank = 0;
        this._nmiMaskSub = false;
        this._subNmiPending = false;
        this._vsyncFlag = false;
        this._vsyncPhase = 0;
        this._inVBlank = false;
        this._blankFlag = true;
        this._subCancelRequest = false;
        this.display._fullDirty = true;
    }

    _subHaltAck() {
        // Apply HALT/RUN request
        if (this._subHaltRequest) {
            if (!this._subHalted) {
                this._subHalted = true;
                this._subBusy = true;
                this._subBusyWasCleared = false;
                this.scheduler.setSubHalted(true);
                // Save sub CPU's view of $D430 state at halt time.
                // Main CPU MMR writes to $D430 during halt may otherwise
                // change apg from under the sub CPU's feet, causing it to
                // write scroll registers to the wrong page on resume.
                if (this.haltSaveApg !== false) {
                    this._haltSavedActivePage = this.display.activeVramPage;
                    this._haltSavedDisplayPage = this.display.displayVramPage;
                }
                this.display._pushScrollTrace('HALT', { val: this.subCPU.pc });
            }
        } else {
            if (this._subHalted) {
                this._subHalted = false;
                this.scheduler.setSubHalted(false);
                // Restore sub CPU's view of $D430 state.
                if (this.haltSaveApg !== false && this._haltSavedActivePage !== undefined) {
                    this.display._setActiveVramPage(this._haltSavedActivePage);
                    this.display._setDisplayVramPage(this._haltSavedDisplayPage);
                    this._haltSavedActivePage = undefined;
                }
                // Apply deferred $FD13 reset on HALT release
                if (this._subResetDeferred) {
                    this._subResetDeferred = false;
                    this.subCPU.reset();
                    this._subNmiPending = false;  // reset clears the latched NMI edge
                    console.log('FM77AV: Deferred sub CPU reset applied on HALT release');
                } else if (this._subNmiPending) {
                    // Deliver the 20ms NMI edge latched during HALT
                    // (MC6809 /NMI is edge-latched, not lost while halted)
                    this._subNmiPending = false;
                    if (!(this.subCPU.intr & 0x01)) {
                        this.subCPU.nmi();
                    }
                }
                this.display._pushScrollTrace('RUN', { val: this.subCPU.pc });
            }
        }
        // Apply CANCEL request: promote request to flag.
        // Do NOT assert IRQ here — IRQ is only asserted when $FD05 is written
        // (level-trigger check), typically on the RUN command after halt.
        if (this._subCancelRequest) {
            this._subCancel = true;
            this._subCancelRequest = false;
        }
    }

    // =========================================================================
    // Keyboard Wiring
    // =========================================================================

    _wireKeyboard() {
        this.keyboard.onIRQ = () => {
            // Keyboard IRQ is level-triggered; _checkAndAssertInterrupts
            // polls keyboard.isIRQActive() each instruction cycle.
            // Immediately poke the CPU so it notices quickly.
            this.mainCPU.irq();
        };

        // 独自メッセージの自動送出に合わせて BEEP を鳴らす。
        this.keyboard.onKeyEncBeep = () => this._beepStart(25);
    }


    /**
     * Simulate BREAK key press (for virtual keyboard).
     * Asserts main CPU FIRQ, same as physical BREAK key.
     */
    pressBreak() {
        this._breakKey = true;
        this.mainCPU.firq();
    }

    /**
     * Simulate BREAK key release (for virtual keyboard).
     */
    releaseBreak() {
        this._breakKey = false;
    }

    /**
     * Enable/disable real-hardware strict-fidelity checks.  Accepts a partial
     * options object; unspecified keys keep their current value.  Passing
     * `true` enables every check, `false` disables every check.  FDC-side
     * checks (spin-up) are mirrored onto the FDC instance.
     */
    setHwStrict(opts) {
        if (opts === true || opts === false) {
            for (const k of Object.keys(this.hwStrict)) this.hwStrict[k] = opts;
        } else if (opts && typeof opts === 'object') {
            for (const k of Object.keys(opts)) {
                if (k in this.hwStrict) this.hwStrict[k] = !!opts[k];
            }
        }
        // Mirror FDC-side flags and warning sink onto the controller.
        this.fdc.strictSpinup = this.hwStrict.fdcSpinup;
        this.fdc.onHwWarn = (code, msg) => this._hwWarn(code, msg);
        return this.hwStrict;
    }

    /** Fire a strict-fidelity warning (real-machine pitfall caught). */
    _hwWarn(code, message) {
        if (typeof this.onHwWarn === 'function') this.onHwWarn(code, message);
    }

    // =========================================================================
    // FDC Wiring
    // =========================================================================

    _wireFDC() {
        // FDC の IRQ は fdc.irqFlag と $FD02 bit4 (マスク解除) の論理積で
        // _checkAndAssertInterrupts が評価する。fdc.irqFlag は $FD18 (ステータス)
        // の読みで落ちる。
    }

    // =========================================================================
    // ROM Loading
    // =========================================================================

    /**
     * Load BASIC ROM ($8000-$FBFF, 31KB)
     * @param {ArrayBuffer} data
     */
    loadFBasicROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, FBASIC_ROM_SIZE);
        this.fbasicROM.set(src.subarray(0, len));
        this.romLoaded.fbasic = true;
        console.log(`BASIC ROM loaded: ${len} bytes`);
    }

    /**
     * Load Boot ROM ($FE00-$FFFF, 512 bytes)
     * @param {ArrayBuffer} data
     */
    loadBootROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, BOOT_ROM_SIZE);
        this.bootROM.set(src.subarray(0, len));
        this.romLoaded.boot = true;
        console.log(`Boot DOS ROM loaded: ${len} bytes`);
    }

    /**
     * Load BASIC Boot ROM ($FE00-$FFFF, 512 bytes)
     * @param {ArrayBuffer} data
     */
    loadBootBasROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, BOOT_ROM_SIZE);
        this.bootBasROM.set(src.subarray(0, len));
        this.romLoaded.bootBas = true;
        console.log(`Boot BASIC ROM loaded: ${len} bytes`);
    }

    /**
     * Load Sub CPU ROM ($D800-$FFFF, 10KB)
     * @param {ArrayBuffer} data
     */
    loadSubROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, SUB_ROM_SIZE);
        this.subROM.set(src.subarray(0, len));
        this.romLoaded.sub = true;
    }

    /**
     * Load CG ROM (character generator, up to 8KB = 4 banks x 2KB)
     * @param {ArrayBuffer} data
     */
    loadCGROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.cgROM.length);
        this.cgROM.set(src.subarray(0, len));
        this.romLoaded.cg = true;
        console.log(`CG ROM loaded: ${len} bytes (${Math.ceil(len / 0x0800)} banks)`);
    }

    /**
     * Load Kanji ROM (JIS level 1, 128KB).
     * Accessed via $FD20/$FD21 (address) and $FD22/$FD23 (data).
     * @param {ArrayBuffer} data
     */
    loadKanjiROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.kanjiROM.length);
        // Reset to 0xFF before loading (in case data is smaller than 128KB)
        this.kanjiROM.fill(0xFF);
        this.kanjiROM.set(src.subarray(0, len));
        this._kanjiSize = len;
        this.romLoaded.kanji = true;
        console.log(`Kanji ROM loaded: ${len} bytes`);
    }

    // =========================================================================
    // FM77AV ROM Loading
    // =========================================================================

    /**
     * Load Initiator ROM (FM77AV, 8KB)
     * @param {ArrayBuffer} data
     */
    loadInitiateROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.initiateROM.length);
        this.initiateROM.set(src.subarray(0, len));
        this._initiateROMSize = len;

        this.romLoaded.initiate = true;
        console.log(`Initiator ROM loaded: ${len} bytes`);
    }

    /**
     * Load Sub-system Type-A ROM (FM77AV, 8KB)
     * @param {ArrayBuffer} data
     */
    loadSubROM_A(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.subROM_A.length);
        this.subROM_A.set(src.subarray(0, len));
        this._subROM_ASize = src.length;
        this.romLoaded.subA = true;
        console.log(`Sub ROM Type-A loaded: ${src.length} bytes`);
    }

    /**
     * Load Sub-system Type-B ROM (FM77AV, 8KB)
     * @param {ArrayBuffer} data
     */
    loadSubROM_B(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.subROM_B.length);
        this.subROM_B.set(src.subarray(0, len));
        this._subROM_BSize = src.length;
        this.romLoaded.subB = true;
        console.log(`Sub ROM Type-B loaded: ${src.length} bytes`);
    }

    /**
     * Load EXTSUB.ROM (FM77AV40EX/SX, 48KB — extended sub ROM banks Type-D/E)
     * @param {ArrayBuffer} data
     */
    loadKanji2ROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.kanjiROM2.length);
        this.kanjiROM2.fill(0xFF);
        this.kanjiROM2.set(src.subarray(0, len));
        this.romLoaded.kanji2 = true;
        console.log(`Kanji2 ROM loaded: ${len} bytes`);
    }

    loadDicromROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.dicromROM.length);
        this.dicromROM.fill(0xFF);
        this.dicromROM.set(src.subarray(0, len));
        this.romLoaded.dicrom = true;
        console.log(`DICROM loaded: ${len} bytes (${Math.floor(len / 0x1000)} banks)`);
    }

    loadExtSubROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.extsubROM.length);
        this.extsubROM.set(src.subarray(0, len));
        this._extsubROMSize = src.length;
        this.romLoaded.extsub = true;
        console.log(`EXTSUB.ROM loaded: ${src.length} bytes (${Math.ceil(src.length / 0x2000)} banks)`);
    }

    /**
     * Clear every loaded ROM (data and loaded flags). Used when switching
     * between ROM sets so that no stale data from the previous set survives
     * — the machine must run on exactly one complete set at a time.
     */
    clearROMs() {
        this.fbasicROM.fill(0);
        this.bootROM.fill(0);
        this.bootBasROM.fill(0);
        this.subROM.fill(0);
        this.cgROM.fill(0);
        this.initiateROM.fill(0);
        this.subROM_A.fill(0);
        this.subROM_B.fill(0);
        this.extsubROM.fill(0);
        this.kanjiROM.fill(0xFF);
        this.kanjiROM2.fill(0xFF);
        this.dicromROM.fill(0xFF);
        this._initiateROMSize = 0;
        this._subROM_ASize = 0;
        this._subROM_BSize = 0;
        this._extsubROMSize = 0;
        this._kanjiSize = 0;
        for (const k of Object.keys(this.romLoaded)) this.romLoaded[k] = false;
    }

    // =========================================================================
    // Machine Type
    // =========================================================================

    /**
     * Install the baseline clocks everywhere that derives timing from them:
     * the scheduler (main + sub), the FDC's cycle-based delays, and the
     * OPN / PSG sample-rate ratios.
     *
     * Every machine shares the same base pair (main 1.794 MHz effective, sub
     * 2.000 MHz).  The FM77AV family's MMR/TWR slowdown is not a different
     * base clock but a temporary state layered on top of the main value by
     * `_updateMainCpuClock()`.
     *
     * @returns {{main: number, sub: number}} the clocks just installed, in Hz
     */
    _applyMachineClocks() {
        const main = CLOCK_MAIN, sub = CLOCK_SUB;
        setCPUClock(main);
        setSubCPUClock(sub);
        FDC.setCPUClock(main);
        this.opn.setCPUClock(main);
        this.psg.setCPUClock(main);
        // Scheduler events keep canonical µs periods; re-derive their cycle
        // reloads for the new clock.
        this.scheduler.onClockChange();
        this._refreshCycleScale();
        return { main, sub };
    }

    /**
     * Set the machine type. Must be called before reset().
     * @param {string} type - 'fm7', 'fm77', 'fm77av', 'fm77av20',
     *                        'fm77av20ex', 'fm77av40' or 'fm77av40ex'
     */
    setMachineType(type) {
        const KNOWN = [MACHINE_FM7, MACHINE_FM77, MACHINE_FM77AV, MACHINE_FM77AV20,
                       MACHINE_FM77AV20EX, MACHINE_FM77AV40, MACHINE_FM77AV40EX];
        if (!KNOWN.includes(type)) {
            console.warn(`Unknown machine type: ${type}, defaulting to fm7`);
            type = MACHINE_FM7;
        }
        this._machineType = type;
        // The FM-77 is NOT an AV machine: it keeps the FM-7 hardware
        // configuration (ROM set, 2D drives, no MMR/TWR, no analog palette,
        // no built-in OPN) and differs from the FM-7 only in CPU clock.
        const isAV = this.isFM77AV;
        const isAV40 = this.isAV40;
        // FDC $FD1E (drive-mode register) is wired on AV20/AV20EX/AV40/
        // AV40EX.  FM-7, FM-77 and FM77AV(無印) leave the drive in 2D mode
        // permanently; the others boot in 2D mode and switch to 2DD only
        // when software writes $FD1E bit6=0.
        this.fdc.supportsDriveModeSwitch = this.has2DD;
        this.fdc.driveModeIs2dd = false;
        // Per-machine CPU clocks (see the CLOCK_* table near the top).
        const { main: cpuHz, sub: subHz } = this._applyMachineClocks();
        this.opn.setAVMode(isAV);
        // FM77AV has OPN built-in; always enable FM sound
        if (isAV) this._fmCardEnabled = true;
        // AV40/AV40EX: expand extended RAM to 448KB
        if (isAV40) {
            this._extRAM = new Uint8Array(0x70000); // 448KB
        } else {
            this._extRAM = new Uint8Array(0x30000); // 192KB
        }
        this.display.isAV40 = isAV40;
        // FM77AV 系で独自メッセージの自動送出を有効にする。
        this.keyboard._hiddenMsgEnabled = isAV;
        console.log(`Machine type set to: ${type} (main CPU ${cpuHz / 1000}kHz, sub CPU ${subHz / 1000}kHz)`);
    }

    /**
     * Update the main CPU effective clock based on MMR/TWR state.
     *
     * Real hardware adds bus-cycle waits when MMR or TWR is enabled, dropping
     * the effective main CPU clock from 1.794 MHz to 1.565 MHz (≈12.8% slow).
     * AV40EX has an opt-in high-speed MMR mode (`$FD95` bit 3) that pushes
     * the clock above baseline to 2.016 MHz.
     *
     * Gated on `hasMMR`, so the FM-77 gets the 1.565 MHz slowdown as well.
     * Only the FM-7 is excluded — it has no MMR/TWR at all and keeps the
     * baseline clock from `_applyMachineClocks()`.  The fast-MMR branch stays
     * AV-only via `hasFastMMR`.  The sub CPU clock is never touched here:
     * MMR/TWR waits are a main-bus effect.
     *
     * Updates: scheduler clock + scheduler event reloads (so VSync/timer/etc.
     * keep firing on real-time periods), FDC clock-dependent constants, OPN
     * and PSG clock ratios.
     */
    _updateMainCpuClock() {
        if (!this.hasMMR) return;  // FM-7 has no MMR/TWR
        let cpuHz;
        if (this.hasFastMMR && this._mmrFastMode) {
            cpuHz = CLOCK_AV_MMRFAST;
        } else if (this._mmrEnabled || this._twrFlag) {
            cpuHz = CLOCK_AV_MMR;
        } else {
            cpuHz = CLOCK_MAIN;
        }
        setCPUClock(cpuHz);
        FDC.setCPUClock(cpuHz);
        this.opn.setCPUClock(cpuHz);
        this.psg.setCPUClock(cpuHz);
        // Re-derive scheduler event reloads from canonical µs periods
        this.scheduler.onClockChange();
        this._refreshCycleScale();
    }

    /**
     * Recompute the µs-per-main-cycle factor that the horizontal scan phase
     * tracker multiplies each instruction's cycle count by.
     *
     * Must be called from every place that changes the main CPU's effective
     * clock — `_applyMachineClocks()` (machine type) and
     * `_updateMainCpuClock()` (MMR/TWR and fast-MMR) are the only two — so a
     * scanline keeps lasting 63.5 µs (41 µs in 400-line mode) across
     * 1.794 / 1.565 / 2.016 MHz.  Because the phase itself is stored in µs it
     * stays continuous over a clock change; only the scale factor moves.
     */
    _refreshCycleScale() {
        this._usPerMainCycle = cyclesToUs(1);
    }

    /**
     * @returns {boolean} true if FM77AV series.
     *
     * The FM-77 is deliberately excluded: it is a pre-AV machine, and this
     * flag is what every AV-only feature is gated on (analog palette, ALU,
     * built-in OPN, initiator ROM, extended MMR, DMAC, 2DD drive mode, ...).
     *
     * What the FM-77 *does* share with the AV family — the base MMR/TWR
     * register file and the cycle-steal release switch — is gated on its own
     * capability getter (`hasMMR`, `hasCycleStealControl`) instead, so those
     * can be granted without dragging the AV-only features along.
     */
    get isFM77AV() {
        return this._machineType !== MACHINE_FM7 && this._machineType !== MACHINE_FM77;
    }

    /** @returns {boolean} true if FM77AV40 or FM77AV40EX */
    get isAV40() {
        return this._machineType === MACHINE_FM77AV40 || this._machineType === MACHINE_FM77AV40EX;
    }

    /** @returns {boolean} true if FM77AV40EX (EXTSUB.ROM搭載機) */
    get isAV40EX() {
        return this._machineType === MACHINE_FM77AV40EX;
    }

    /** @returns {boolean} true if FM77AV20 or FM77AV20EX */
    get isAV20() {
        return this._machineType === MACHINE_FM77AV20 || this._machineType === MACHINE_FM77AV20EX;
    }

    // ---- Capability flags (machine → feature mapping in one place) ----
    // For the pre-existing four machines these reduce exactly to the old
    // isAV40 / isAV40EX gates, so their behaviour is unchanged by design.

    /**
     * MMR / TWR paging hardware present: FM-77 and every later machine.
     *
     * The FM-7 has neither.  Everything the FM-77 shares with the FM77AV
     * family — the $FD80-$FD93 register file, address translation, and the
     * extra bus waits that drop the effective main clock while paging is on
     * — is gated on this rather than on isFM77AV, so the FM-77 gets the
     * common part without inheriting the AV-only extensions.
     *
     * For the pre-existing machines this is identical to isFM77AV, so their
     * behaviour is unchanged by construction.
     */
    get hasMMR() {
        return this._machineType !== MACHINE_FM7;
    }

    /**
     * Software control over the CRT cycle steal ($D405 bit 0): FM-77 and
     * later.
     *
     * On the FM-7 the sub CPU's VRAM accesses always contend with CRT
     * scanout during active display and there is no register to release
     * them.  From the FM-77 on, setting this bit lifts the contention.
     * The AV family has a separate VRAM bus and is not subject to the steal
     * at all, so the flag is moot there (see the exec loop).
     */
    get hasCycleStealControl() {
        return this._machineType !== MACHINE_FM7;
    }

    /** 2DD drive-mode switch ($FD1E) wired: AV20/AV20EX/AV40/AV40EX */
    get has2DD() {
        return this.isAV20 || this.isAV40;
    }

    /** DMAC HD6844 present: AV20EX/AV40/AV40EX */
    get hasDMAC() {
        return this._machineType === MACHINE_FM77AV20EX || this.isAV40;
    }

    /** High-speed MMR ($FD95 bit3, suppresses MMR slowdown): AV20EX/AV40EX */
    get hasFastMMR() {
        return this._machineType === MACHINE_FM77AV20EX || this.isAV40EX;
    }

    /** Analog palette read-back ($FD32-$FD34): AV20 and later */
    get hasPaletteReadback() {
        return this.isAV20 || this.isAV40;
    }

    /** Catalogue main RAM size in KB (base configuration). */
    get mainRamKB() {
        if (!this.isFM77AV) return 64;      // FM-7
        return this.isAV40 ? 192 : 128;     // AV/AV20/AV20EX = 128, AV40 family = 192
    }

    /** VRAM size in KB. */
    get vramKB() {
        if (!this.isFM77AV) return 48;      // FM-7 (16KB x 3 planes)
        if (this.isAV40EX) return 192;      // 2-block
        if (this.isAV40) return 144;        // 400-line / 262K banks
        return 96;                          // AV/AV20/AV20EX (48KB x 2 pages)
    }

    /**
     * Enable/disable FM sound card (OPN + joystick port).
     * FM77AV always has OPN built-in; this only affects FM-7 mode.
     */
    setFMCard(enabled) {
        this._fmCardEnabled = enabled || this.isFM77AV;
    }

    /**
     * Read-only: is the OPN present on the current machine?
     * True for the FM sound card on FM-7 / FM-77 and always on FM77AV.
     */
    get fmCardEnabled() {
        return this._fmCardEnabled;
    }

    // =========================================================================
    // OPN bus helpers
    //
    // The YM2203 talks to the CPU through a 4-bit BDIR/BC1/etc. enum on its
    // command port. fm7.js owns the protocol latches (selreg / seldat /
    // pstate) and forwards register transactions to the OPN object. These
    // helpers exist so both $FD15/$FD16 (FM-7 card / FM77AV) and $FD0D/$FD0E
    // (FM77AV mirror) can dispatch through the same logic without duplicating
    // the case table.
    // =========================================================================

    /** OPN command port write — dispatches the 4-bit BDIR/BC1 enum. */
    _opnWriteCmd(val) {
        const cmd = val & 0x0F;
        switch (cmd) {
            case 0x00: // INACTIVE
                this._opnPState = 0x00;
                break;
            case 0x01: // READDAT: seldat ← regs[selreg]
                this._opnPState = 0x01;
                this._opnDataBus = this._opnRegs[this._opnAddrLatch] & 0xFF;
                break;
            case 0x02: { // WRITEDAT: writereg(selreg, seldat)
                this._opnPState = 0x02;
                const reg = this._opnAddrLatch;
                const dat = this._opnDataBus & 0xFF;
                this.opn.writeReg(reg, dat);
                this._opnRegs[reg] = dat;
                // Intelligent mouse strobe rides on OPN reg 15 bit 4 (port 1)
                // or bit 5 (port 2); each level change advances the phase.
                if (reg === 0x0F) this._mouseIntelStrobeUpdate(dat);
                break;
            }
            case 0x03: { // ADDRESS: selreg ← seldat; prescaler regs self-trigger
                this._opnPState = 0x03;
                this._opnAddrLatch = this._opnDataBus & 0xFF;
                const r = this._opnAddrLatch;
                if (r >= 0x2D && r <= 0x2F) {
                    this._opnDataBus = 0;
                    this.opn.writeReg(r, 0);
                    this._opnRegs[r] = 0;
                }
                break;
            }
            case 0x04: // READSTAT
                this._opnPState = 0x04;
                break;
            case 0x09: // JOYSTICK
                this._opnPState = 0x09;
                break;
            // other codes: ignored (pstate unchanged)
        }
    }

    /** OPN data port write — latches into seldat for the next WRITEDAT. */
    _opnWriteData(val) {
        this._opnDataBus = val & 0xFF;
    }

    /** OPN data port read — dispatches on pstate (status / joystick / data). */
    _opnReadData() {
        switch (this._opnPState) {
            case 0x04: // READSTAT: live status each read
                return this.opn.readStatus();
            case 0x09: { // JOYSTICK: only selreg==14 yields joystick data
                if (this._opnAddrLatch === 14) {
                    // Intelligent mouse (when enabled) takes precedence over the
                    // gamepad when reg-15 direction bits select its port.
                    const mouseData = this._mouseIntelRead();
                    if (mouseData !== null) return mouseData;
                    const portB = this._opnRegs[0x0F] & 0xF0;
                    if (portB === 0x20) return this._gamepadState[0];
                    if (portB === 0x50) return this._gamepadState[1];
                    return 0xFF;
                }
                return 0x00;
            }
            default: // INACTIVE / READDAT / WRITEDAT / ADDRESS → seldat
                return this._opnDataBus;
        }
    }

    // =========================================================================
    // Disk Loading
    // =========================================================================

    /**
     * Load a D77 disk image into a drive.
     * @param {number} driveNum - Drive number (0-3)
     * @param {ArrayBuffer} data - Disk image data
     * @returns {boolean} success
     */
    loadDisk(driveNum, data) {
        return this.fdc.loadDisk(driveNum, data);
    }

    /**
     * Load a T77 tape image.
     * @param {ArrayBuffer} data - T77 file data
     * @returns {boolean} success
     */
    loadTape(data) {
        return this.cmt.loadT77(data);
    }

    /**
     * Load a WAV file as cassette media (CAS:).
     * @param {ArrayBuffer} data - WAV file data
     * @returns {boolean} success
     */
    loadTapeWAV(data) {
        return this.cmt.loadWAV(data);
    }

    /**
     * Export captured cassette writes as a T77 tape image.
     * @returns {ArrayBuffer}
     */
    saveTapeT77() {
        return this.cmt.exportT77();
    }

    /**
     * Export captured cassette writes as a WAV file (CAS:).
     * @param {number} [sampleRate=48000]
     * @returns {ArrayBuffer}
     */
    saveTapeWAV(sampleRate = 48000) {
        return this.cmt.exportWAV(sampleRate);
    }

    /**
     * Re-serialize a drive's (written-to) disk image to a D77 ArrayBuffer.
     * @param {number} driveNum
     * @returns {ArrayBuffer|null}
     */
    saveDiskImage(driveNum) {
        return this.fdc.serializeDrive(driveNum);
    }

    /** @returns {boolean} true if the drive's disk has unsaved writes. */
    isDiskDirty(driveNum) {
        return this.fdc.isDriveDirty(driveNum);
    }

    /** Clear a drive's disk dirty flag (after persisting). */
    clearDiskDirty(driveNum) {
        this.fdc.clearDriveDirty(driveNum);
    }


    // =========================================================================
    // Reset
    // =========================================================================

    /**
     * Reset the entire system.
     * Boot mode is selected by the machine mode setting, not by disk presence:
     * the boot ROM shown at $FE00 is chosen by the mode ('basic' or 'dos').
     * BASIC mode boots from disk and gracefully falls back to F-BASIC when no
     * bootable disk is present; DOS mode requires a bootable disk.
     */
    reset() {
        // Select the boot mode for the current machine.
        const hasDisk = this.fdc.disks[0] && this.fdc.disks[0].loaded;
        const bootMode = (this.isFM77AV && !this._bootModeExplicit)
            ? (hasDisk ? 'dos' : 'basic')
            : ((this._bootModeOverride === 'dos') ? 'dos' : 'basic');
        this._bootMode = bootMode;

        // Clear main RAM; shared RAM to 0xFF (FM-7 hardware default)
        this.mainRAM.fill(0x00);
        this.sharedRAM.fill(0xFF);

        // Reset I/O state
        this._subHalted   = false;  // Sub CPU runs after reset
        this._subHaltRequest = false;
        this._subCancelRequest = false;
        this._subBusy     = true;   // BUSY set on reset (sub CPU clears via $D40A read during init)
        this._subBusyWasCleared = false;
        this._subCancel   = false;
        this._subAttn     = false;
        this._breakKey    = false;
        this._timerIRQ    = false;
        this._irqMaskReg  = 0;
        this._fd17MouseIrqEnable = true;

        // Reset PTM state
        this._ptmCR.fill(0);
        this._ptmLatch.fill(0xFFFF);
        this._ptmCounter.fill(0xFFFF);
        this._ptmLsbBuf.fill(0);
        this._ptmMsbWBuf = 0;
        this._ptmStatus = 0;
        this._ptmCycleAcc = 0;
        this._ptmT3Div = 0;
        this._ptmRunning[0] = this._ptmRunning[1] = this._ptmRunning[2] = false;
        this._ptmMouseClkAcc = 0;
        // Mouse — reset hardware phase/latch state but preserve the user's
        // connection mode and port selection.
        this._mouseAccDX = 0;
        this._mouseAccDY = 0;
        this._mouseBtn = 0x30;
        this._mouseBusPhase = 0;
        this._mouseBusDX = 0;
        this._mouseBusDY = 0;
        this._mouseIntelPhase = 0;
        this._mouseIntelDX = 0;
        this._mouseIntelDY = 0;
        this._mouseIntelStrobe = false;
        this._mouseIntelLastEdge = 0;
        // BASIC ROM: always enabled at reset (real hardware default).
        // IPL/program code disables it via write to $FD0F when needed.
        this._basicRomEnabled = true;
        this._fbasicWarnShown = false;

        // Reset OPN state
        this._opnAddrLatch = 0;
        this._opnDataBus = 0;
        this._opnPState = 0;
        this._opnRegs.fill(0);
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        // FM77AV specific reset
        if (this.isFM77AV) {
            this._initiatorActive = false; // Set before boot path logic overrides it
            this._initiatorHandoffDone = false;
            // Sub monitor type after reset is always Type-C (sub ROM bank=0).
            // The IPL/program then switches via $FD13 if it needs Type-A/B.
            this._subMonitorType = SUB_MONITOR_C;
            this._cgRomBank = 0;
            this._nmiMaskSub = false;
            this._subResetFlag = false;
            this._subResetDeferred = false;
            this._vsyncFlag = false;
            this._vsyncPhase = 0;
            this._inVBlank = false;
            this._blankFlag = true;   // Blanking active at power-on
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            // MMR reset
            this._mmrEnabled = false;
            this._mmrExt = false;
            this._mmrBankReg = 0;
            this._twrFlag = false;
            this._twrReg = 0;
            this._mmrRegs.fill(0);
            // DMAC HD6844 reset
            this._dmaReg = 0;
            for (let i = 0; i < 4; i++) {
                this._dmaAdr[i] = 0xFFFF;
                this._dmaBcr[i] = 0xFFFF;
                this._dmaChcr[i] = 0;
            }
            this._dmaPcr = 0;
            this._dmaIcr = 0;
            this._dmaDcr = 0;
            this._dmaFlag = false;
            this._dmaBurst = false;
            this._bootramRW = false;
            this._bootramWarned = false;
            // AV40 sub-interface extension
            this._subramProtect = true;    // Sub RAM protected at reset
            this._subKanjiConnect = false; // Kanji ROM disconnected at reset
            this._cgramBank = 0;
            this._consramBank = 0;
            this.subRAM_DE.fill(0);
            this.subRAM_CG.fill(0);
            this.subRAM_CN.fill(0);
            this._dicromBank = 0;
            this._dicromEn = false;
            this._dicramEn = false;
            this._extromSel = false;
            this._mmrFastMode = false;
            this._subKanjiBank = false;
            this._subKanjiFlag = false;
            // AV40 peripheral stubs
            this._rd512Sector = 0;
            // MMR registers stay at $00 after fill(0) above.
            // Unwritten segments remain $00 (pointing to extRAM page 0),
            // which software that reads low RAM through the MMR relies on.
            // Share analog palette reference with display
            this.display.analogPalette = this._analogPalette;
            // Enable FM77AV features in display (ALU, line drawing)
            this.display.isAV = true;
            this.display.isAV40 = this.isAV40;
            // Keyboard MCU power-on default = 9-bit key format (FM-7
            // compatible ASCII, no break codes). Native FM77AV programs
            // that need scan codes explicitly switch by writing cmd
            // $00 with data $02 to the MCU at $D431. The sub ROM bank
            // handler may also adjust the mode when the program switches
            // to Type-C (see $FD13 write handler).
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._keyEncFormat = 0;
            this._keyEncFormatExplicit = false;
        } else {
            this._initiatorActive = false;
            this._initiatorHandoffDone = false;
            this._subMonitorType = SUB_MONITOR_C;
            this._cgRomBank = 0;
            // Clear FM77AV state that may linger from a previous AV session
            this._nmiMaskSub = false;
            this._subResetFlag = false;
            this._subResetDeferred = false;
            this._vsyncFlag = false;
            this._vsyncPhase = 0;
            this._blankFlag = true;
            this._analogPaletteAddr = 0;
            this._analogPalette.fill(0);
            this._mmrEnabled = false;
            this._mmrExt = false;
            this._mmrBankReg = 0;
            this._twrFlag = false;
            this._twrReg = 0;
            this._mmrRegs.fill(0);
            this._bootramRW = false;
            this._dmaReg = 0;
            for (let i = 0; i < 4; i++) {
                this._dmaAdr[i] = 0xFFFF;
                this._dmaBcr[i] = 0xFFFF;
                this._dmaChcr[i] = 0;
            }
            this._dmaPcr = 0;
            this._dmaIcr = 0;
            this._dmaDcr = 0;
            this._dmaFlag = false;
            this._dmaBurst = false;
            this._rd512Sector = 0;
            this.display.analogPalette = null;
            this.display.isAV = false;
            this.display.isAV40 = false;
            // FM-7: ASCII character codes, no break codes
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
        }

        // Reset all components
        this.display.reset();
        this.fdc.reset();
        this.cmt.reset();
        this.keyboard.reset();
        this.psg.reset();
        this.opn.reset();
        this.scheduler.reset();
        this._keyEncAckAt = 0;
        this._subBudgetMainMark = 0;

        // Re-apply keyboard mode after component reset (components may clear it)
        // Default = 9-bit key format (FM-7 ASCII). Programs switch via $D431.
        if (this.isFM77AV) {
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._keyEncFormat = 0;
            this._keyEncFormatExplicit = false;
        }

        // =====================================================================
        // Boot preparation: initialize hardware state, then choose the main
        // CPU start address for the selected boot path.
        // =====================================================================

        // Initialize the vector area from the selected boot ROM.
        const vecROM = this._bootROMForVectors(bootMode);
        if (vecROM) {
            for (let i = 0xFFE0; i <= 0xFFFF; i++) {
                const romByte = vecROM[i - BOOT_ROM_BASE];
                if (romByte !== 0xFF) {
                    this.mainRAM[i] = romByte;
                }
            }
        }

        // Initialize the FDC for BASIC boot.
        if (bootMode === 'basic') {
            this._initFDCPorts();
        }

        // Reset sub CPU — it reads its own reset vector from sub ROM
        this.subCPU.reset();
        this._subNmiPending = false;
        // NMI is masked via _nmiMaskSub (set earlier); sub ROM unmasks via $D430
        this.scheduler.setSubHalted(false);

        // Determine main CPU start address based on boot mode and machine type
        let mainPC;
        let initiatorPath = false;
        if (this.isFM77AV) {
            // FM77AV: execute the initiator ROM for machine initialization.
            if (!this.romLoaded.initiate) {
                console.error('[BOOT] FM77AV requires INITIATE.ROM. Using direct start.');
                mainPC = (bootMode === 'dos') ? this._dosBootDirect() : this._basicBootBypass();
            } else {
                this._initiatorActive = true;
                mainPC = 0x6000;
                initiatorPath = true;
                console.log('[BOOT] FM77AV: running INITIATE.ROM as 6809 code (PC=$6000)');
            }
        } else if (bootMode === 'dos') {
            // FM-7 DOS boot: run BOOT_DOS.ROM code at $FE00 on the 6809.
            mainPC = this._dosBootDirect();
        } else if (this.romLoaded.bootBas) {
            // Start the selected BASIC boot ROM.
            mainPC = 0xFE00;
        } else {
            // Direct start when the BASIC boot ROM is unavailable.
            mainPC = this._basicBootBypass();
        }

        // Set main CPU initial state (DP=0, interrupts masked, PC=target)
        this.mainCPU.reset();
        this.mainCPU.pc = mainPC;
        // Apply register setup for boot assist.
        if (this._bootRegs) {
            if (this._bootRegs.a !== undefined) this.mainCPU.a = this._bootRegs.a;
            if (this._bootRegs.x !== undefined) this.mainCPU.x = this._bootRegs.x;
            this._bootRegs = null;
        }
        // Set reset vector in RAM to match (for consistency)
        this.mainRAM[0xFFFE] = (mainPC >> 8) & 0xFF;
        this.mainRAM[0xFFFF] = mainPC & 0xFF;

        // Log boot info (single line to keep the console quiet)
        console.log(
            `${this._machineType.toUpperCase()} reset: PC=$${mainPC.toString(16).toUpperCase().padStart(4, '0')}, ` +
            `boot=${bootMode}, initiator=${initiatorPath ? 'ACTIVE' : 'OFF'}(ROM ${this.romLoaded.initiate ? 'Y' : 'N'}), ` +
            `subMon=Type-${['C','A','B','CG','D/E'][this._subMonitorType]}(A=${this.romLoaded.subA} B=${this.romLoaded.subB} C=${this.romLoaded.sub}), ` +
            `disk0=${hasDisk ? 'Y' : 'N'}, basicROM=${this.romLoaded.fbasic ? 'Y' : 'N'}`
        );
        const srvHi = this._subRead(0xFFFE);
        const srvLo = this._subRead(0xFFFF);
        console.log(`  Sub CPU reset vector: $${((srvHi << 8) | srvLo).toString(16).toUpperCase().padStart(4, '0')}`);

        // Reset clears MMR/TWR — restore the machine's base main clock
        // (no-op outside the FM77AV family).
        this._updateMainCpuClock();
    }

    /**
     * FDC initialization for BASIC boot: bring the FDC to its initial state.
     */
    _initFDCPorts() {
        this.fdc.reset();
    }

    /**
     * Boot ROM whose vector table ($FFE0-$FFFF) is reflected into RAM at
     * reset. Mirrors the $FE00-$FFDF read-side selection: on FM-7 the
     * boot mode picks the ROM; on FM77AV the DOS-mode boot ROM is used as the
     * initial table. Falls back to the other ROM if the selected one is not
     * loaded. Returns null when neither is loaded.
     * @param {string} bootMode 'basic' | 'dos'
     * @returns {Uint8Array|null}
     */
    _bootROMForVectors(bootMode) {
        const preferBas = !this.isFM77AV && bootMode === 'basic';
        if (preferBas) {
            if (this.romLoaded.bootBas) return this.bootBasROM;
            if (this.romLoaded.boot) return this.bootROM;
        } else {
            if (this.romLoaded.boot) return this.bootROM;
            if (this.romLoaded.bootBas) return this.bootBasROM;
        }
        return null;
    }

    /**
     * Whether a cold-start address read from a ROM's entry information looks
     * obviously uninitialized (never legitimately a real entry point):
     * $0000 or $FFFF.
     * @param {number} addr
     * @returns {boolean}
     */
    _isColdStartUninitialized(addr) {
        return addr === 0x0000 || addr === 0xFFFF;
    }

    /**
     * BASIC boot fallback: read the start address from the ROM image.
     * @returns {number} Start address for main CPU
     */
    _basicBootBypass() {
        if (!this.romLoaded.fbasic) {
            console.error('[BOOT] BASIC ROM not loaded — cannot BASIC boot');
            return 0xFE00; // Fallback: try boot ROM if available
        }
        // Read the fallback start address.
        const hi = this.fbasicROM[0x7BFE];
        const lo = this.fbasicROM[0x7BFF];
        const coldStart = (hi << 8) | lo;
        if (this._isColdStartUninitialized(coldStart)) {
            console.error(`[BOOT] BASIC ROM cold start looks uninitialized ($${coldStart.toString(16).toUpperCase().padStart(4, '0')}) — falling back to $FE00`);
            return 0xFE00; // Fallback: try boot ROM if available
        }
        console.log(`[BOOT] BASIC direct start: entry $${coldStart.toString(16).toUpperCase().padStart(4, '0')}`);
        return coldStart;
    }

    /**
     * Start DOS boot with optional boot assist.
     * @returns {number} Start address for main CPU
     */
    _dosBootDirect() {
        const disk = this.fdc.disks[0];
        if (!disk || !disk.loaded) {
            console.error('[BOOT] No disk in drive 0 — falling back to BASIC');
            return this._basicBootBypass();
        }

        // 起動を補助する。互換 ROM では行わない。
        if (this.romAdjust && this.romAdjustBoot && !this.isFM77AV) {
            const sec1 = disk.getSector(0, 0, 1);
            if (sec1 && sec1.data && sec1.data.length >= 0x28) {
                const d = sec1.data;
                const directIPL = d[0] === 0x1A && d[1] === 0x50 &&
                                  d[2] === 0x10 && d[3] === 0xCE && d[4] === 0x01;
                const flexIPL = d[0] === 0x20 && d[1] === 0x20 &&
                                d[0x22] === 0x1A && d[0x23] === 0x50 &&
                                d[0x24] === 0x10 && d[0x25] === 0xCE && d[0x26] === 0x01;
                if (directIPL || flexIPL) {
                    // Pre-read sectors for boot assist.
                    for (let sec = 1; sec <= 16; sec++) {
                        const s = disk.getSector(0, 0, sec);
                        if (!s || !s.data) break;
                        const base = sec * 0x100;
                        for (let i = 0; i < s.data.length; i++) {
                            this.mainRAM[(base + i) & 0xFFFF] = s.data[i];
                        }
                    }

                    // Pre-read additional sectors for boot assist.
                    const readParam = (off) => ({
                        type: d[off], bufHi: d[off+2], bufLo: d[off+3],
                        track: d[off+4], sector: d[off+5], side: d[off+6], drive: d[off+7],
                    });
                    const iplBase = flexIPL ? 0x22 : 0x00;
                    // Read the sector loading parameters.
                    const tabA = readParam(0x02);
                    const tabB = readParam(0x0A);
                    // Read the sector counts for this boot format.
                    const countA = d[iplBase + 0x18] || 0;
                    const countB = d[iplBase + 0x32] || 0;

                    // Pre-read the sector group.
                    if (tabA.type === 0x0A && countA > 0) {
                        let buf = (tabA.bufHi << 8) | tabA.bufLo;
                        let sec = tabA.sector;
                        for (let i = 0; i < countA; i++) {
                            const s = disk.getSector(tabA.track, tabA.side, sec);
                            if (s && s.data) {
                                for (let j = 0; j < s.data.length; j++) {
                                    this.mainRAM[(buf + j) & 0xFFFF] = s.data[j];
                                }
                            }
                            buf += 0x100;
                            sec++;
                        }

                    }
                    // Pre-read the sector group.
                    if (tabB.type === 0x0A && countB > 0) {
                        let buf = (tabB.bufHi << 8) | tabB.bufLo;
                        let sec = tabB.sector;
                        for (let i = 0; i < countB; i++) {
                            const s = disk.getSector(tabB.track, tabB.side, sec);
                            if (s && s.data) {
                                for (let j = 0; j < s.data.length; j++) {
                                    this.mainRAM[(buf + j) & 0xFFFF] = s.data[j];
                                }
                            }
                            buf += 0x100;
                            sec++;
                        }

                    }

                    // Prepare boot memory.
                    this._installBootROMtoRAM();
                    // Bring the FDC to its initial state.
                    this._initFDCPorts();
                    // Enable timer IRQ ($FD02 bit 2).
                    this._irqMaskReg |= 0x04;

                    // Select the entry point for the detected boot format.
                    const hasFBasicTables = tabA.type === 0x0A || tabB.type === 0x0A;
                    if (this.romLoaded.fbasic && hasFBasicTables) {
                        const coldStart = (this.fbasicROM[0x7BFE] << 8) | this.fbasicROM[0x7BFF];
                        if (!this._isColdStartUninitialized(coldStart)) {
                            const dosBase = (tabA.bufHi << 8) | tabA.bufLo;
                            this._bootRegs = { a: 0xFF, x: dosBase };
                            console.log(`[BOOT] boot assist: entry $${coldStart.toString(16).toUpperCase()}`);
                            return coldStart;
                        }
                        console.log('[BOOT] boot assist: entry $0100');
                        return 0x0100;
                    }
                    console.log('[BOOT] boot assist: entry $0100');
                    return 0x0100;
                }
            }
        }

        // For FM77AV: place the boot ROM code in RAM at $FE00-$FFDF, where
        // the machine reads it once the initiator overlay is off.
        if (this.isFM77AV) {
            this._installBootROMtoRAM();
        }

        // 起動を補助する。互換 ROM では行わない。
        if (this.romAdjust && this.romAdjustBoot && this._needsIPLPreload(disk)) {
            // Pre-read sectors for boot assist.
            for (let sec = 1; sec <= 16; sec++) {
                const s = disk.getSector(0, 0, sec);
                if (!s || !s.data) break;
                const base = sec * 0x100;
                for (let i = 0; i < s.data.length; i++) {
                    this.mainRAM[(base + i) & 0xFFFF] = s.data[i];
                }
            }
            // Prepare boot memory.
            this._installBootROMtoRAM();
            this._initFDCPorts();
            console.log('[BOOT] boot assist: entry $0100');
            return 0x0100;
        }

        // Start DOS boot.
        console.log(`[BOOT] DOS direct: running BOOT_DOS.ROM at $FE00`);
        return 0xFE00;
    }

    /**
     * Check whether the disk needs boot assist.
      * @returns {boolean}
     */
    _needsIPLPreload(disk) {
        const sector1 = disk.getSector(0, 0, 1);
        if (!sector1 || !sector1.data) return false;
        const d = sector1.data;

        // Check the supported boot format.
        for (let i = 0; i < Math.min(d.length, 64); i++) {
            const b = d[i];
            if ((b === 0xBD || b === 0x7E || b === 0x8E || b === 0xBE ||
                 b === 0xFE || b === 0xCC) && i + 2 < d.length) {
                const addr = (d[i + 1] << 8) | d[i + 2];
                if (addr >= 0x0020 && addr < 0x0300) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Prepare RAM for boot. */
    _installBootROMtoRAM() {
        // Code area only: $FE00-$FFDF (480 bytes). Vectors at $FFE0+ are
        // already set up separately in reset().
        const codeSize = 0x01E0; // 480 bytes

        if (this.romLoaded.boot) {
            // Use standalone boot_dos.rom
            for (let i = 0; i < codeSize; i++) {
                this.mainRAM[BOOT_ROM_BASE + i] = this.bootROM[i];
            }
            console.log('[BOOT] Boot memory ready');
        } else if (this.romLoaded.initiate && this._initiateROMSize >= 0x1BC4) {
            // Prepare boot memory from the available ROM.
            for (let i = 0; i < codeSize; i++) {
                this.mainRAM[BOOT_ROM_BASE + i] = this.initiateROM[0x1A00 + i];
            }
            console.log('[BOOT] Boot memory ready');
        } else {
            console.warn('[BOOT] Boot ROM unavailable');
        }
    }

    // =========================================================================
    // Emulation Loop
    //   The frame loop (timing source, display presentation, audio start on
    //   user gesture) belongs to the host: see FM7Browser in
    //   fm7_browser.js (browser UI). Headless use drives the machine
    //   with scheduler.exec(us) directly.
    // =========================================================================

    // =========================================================================
    // Status / Debug
    // =========================================================================

    /**
     * Get current emulation status for UI display.
     * @returns {object} Status information
     */
    getStatus() {
        return {
            running: this._running,
            fps: this._currentFPS,
            machineType: this._machineType,
            bootMode: this._bootMode,
            subHalted: this._subHalted,
            mainPC: this.mainCPU.pc || 0,
            subPC: this.subCPU.pc || 0,
            romsLoaded: { ...this.romLoaded },
            diskLoaded: [
                this.fdc.disks[0] !== null,
                this.fdc.disks[1] !== null,
                this.fdc.disks[2] !== null,
                this.fdc.disks[3] !== null,
            ],
            // FM77AV specific
            initiatorActive: this._initiatorActive,
            subMonitorType: this._subMonitorType,
            // FDC status
            fdcBusy: (this.fdc.statusReg & 0x01) !== 0,
            fdcAccess: this.fdc.accessLatch,
            fdcMotor: this.fdc.motorOn,
            fdcDrive: this.fdc.currentDrive,
            fdcTrack: this.fdc.headPosition[this.fdc.currentDrive],
            fdcSector: this.fdc.sectorReg,
            fdcState: this.fdc.state,
        };
    }


    // =========================================================================
    // Gamepad Polling
    // =========================================================================

    // FM-7 joystick is read via OPN ($FD15/$FD16) Port A/B only.
    // PSG ($FD0D/$FD0E) does not provide joystick input on FM-7.

    /**
     * Assign a browser gamepad to an FM-7 joystick port independently.
     * @param {number} fmPort - 0 for Port 1, 1 for Port 2
     * @param {number|null} gamepadIndex - Gamepad API index (host-side), or null to unassign
     */
    setJoystickAssignment(fmPort, gamepadIndex) {
        const p = fmPort & 1;
        this._joystickAssign[p] = (gamepadIndex == null) ? null : (gamepadIndex | 0);
    }

    /**
     * Set joystick button state programmatically (headless / scripted control).
     *
     * Works independently of the host's Gamepad polling (FM7Browser polls
     * inside its frame loop). In headless mode nothing polls, so the value set
     * here persists and is read back through the OPN port ($FD15/$FD16).
     *
     * @param {number} fmPort - 0 for Joystick 1, 1 for Joystick 2
     * @param {object|number} buttons - Either an object with boolean fields
     *   {up, down, left, right, trigger1, trigger2}, or an active-low raw byte
     *   (0xFF = all released; bit0 up, bit1 down, bit2 left, bit3 right,
     *   bit4 trigger1, bit5 trigger2).
     */
    setJoystickState(fmPort, buttons) {
        if (fmPort !== 0 && fmPort !== 1) return;
        let b;
        if (typeof buttons === 'number') {
            b = buttons & 0xFF;
        } else {
            const o = buttons || {};
            b = 0xFF;
            if (o.up)       b &= ~0x01;
            if (o.down)     b &= ~0x02;
            if (o.left)     b &= ~0x04;
            if (o.right)    b &= ~0x08;
            if (o.trigger1) b &= ~0x10;
            if (o.trigger2) b &= ~0x20;
        }
        this._gamepadState[fmPort] = b & 0xFF;
    }

    /**
     * Release a joystick to the idle state (0xFF). With no argument, or an
     * out-of-range port, both ports are released.
     * @param {number} [fmPort] - 0 for Joystick 1, 1 for Joystick 2
     */
    clearJoystickState(fmPort) {
        if (fmPort === 0 || fmPort === 1) {
            this._gamepadState[fmPort] = 0xFF;
        } else {
            this._gamepadState[0] = 0xFF;
            this._gamepadState[1] = 0xFF;
        }
    }

    // =========================================================================
    // RTC (MS58321) via Key Encoder
    // =========================================================================

    /**
     * Process a byte written to the FM77AV key encoder MCU at sub address
     * $D431. The MCU exposes a multi-protocol command interface with a
     * 16-byte send FIFO. The first byte is the command, subsequent bytes
     * are arguments.
     *
     * Supported commands:
     *   $00 +1: code system switch (0=9BIT FM-7 ASCII, 1=alt-ASCII, 2=SCAN)
     *   $01:    get current code system → 1 byte response
     *   $02 +1: LED set (stub)
     *   $03:    LED get (stub)
     *   $04 +1: key repeat enable (stub)
     *   $05 +2: key repeat time (stub)
     *   $80 +1: RTC sub-protocol
     *           sub=0: get RTC → 7-byte BCD response
     *           sub=1 +7: set RTC (we ignore set; host clock is read-only)
     *   $81-$84: digitize / screen mode / brightness (stubs)
     *
     * The reset/power-on default is KEY_FORMAT_9BIT (FM-7 compatible
     * ASCII with no break codes). Programs that need scan codes (e.g. native
     * FM77AV software) issue command $00 with data $02 to switch.
     */
    _keyEncProcessByte(val) {
        if (!this._keyEncSendBuf) this._keyEncSendBuf = [];
        const buf = this._keyEncSendBuf;
        // ACK (bit0 of $D432) drops for about 5 us after every byte written.
        this._keyEncAckAt = this.scheduler.subCyclesTotal + 10;
        if (buf.length >= 16) {
            buf.length = 0;
        }

        // Strict: the MCU is a serial handshake device — after each byte the
        // host must read ENCSTA ($D432) and see the ready/ACK bit before
        // sending the next.  A continuation byte that arrives without that
        // poll is a protocol violation; on real hardware the byte is dropped
        // and the in-flight command never commits (e.g. the ASCII->SCAN
        // switch does not happen).  Lenient default accepts back-to-back bytes.
        if (this.hwStrict.keyEncHandshake && buf.length > 0 && this._keyEncNeedsRead) {
            this._hwWarn('keyenc-handshake',
                `key-encoder byte $${val.toString(16).padStart(2,'0')} sent without polling $D432 ENCSTA; command aborted`);
            buf.length = 0;
            this._keyEncNeedsRead = false;
            return;
        }

        buf.push(val);
        // Require an ENCSTA poll before the next byte is accepted.
        this._keyEncNeedsRead = true;

        const finishCmd = () => {
            this._keyEncSendBuf.length = 0;
            this._keyEncNeedsRead = false; // command done — next byte starts fresh
        };

        switch (buf[0]) {
            case 0x00: // Code system switch
                if (buf.length >= 2) {
                    const fmt = buf[1];
                    if (fmt === 0x02) { // SCAN
                        this.keyboard._useScanCodes = true;
                        this.keyboard._enableBreakCodes = true;
                    } else { // 0=9BIT FM-7, 1=alt both → ASCII-style
                        this.keyboard._useScanCodes = false;
                        this.keyboard._enableBreakCodes = false;
                    }
                    this._keyEncFormat = fmt;
                    this._keyEncFormatExplicit = true; // program has chosen
                    finishCmd();
                }
                return;
            case 0x01: // Get code system
                this._rtcRxBuf.push(this._keyEncFormat || 0);
                finishCmd();
                return;
            case 0x02: // LED set
            case 0x04: // Repeat enable
                if (buf.length >= 2) finishCmd();
                return;
            case 0x03: { // LED get: bit0 = CAPS, bit1 = KANA
                const led = (this.keyboard.capsLock ? 0x01 : 0x00)
                          | (this.keyboard.kanaMode ? 0x02 : 0x00);
                this._rtcRxBuf.push(led);
                finishCmd();
                return;
            }
            case 0x05: // Repeat time
                if (buf.length >= 3) finishCmd();
                return;
            case 0x80: // RTC sub-protocol
                if (buf.length >= 2) {
                    if (buf[1] === 0x00) { // get
                        this._rtcEmitGet();
                        finishCmd();
                    } else if (buf[1] === 0x01) { // set (need 9 bytes total)
                        if (buf.length >= 9) finishCmd();
                    } else {
                        finishCmd();
                    }
                }
                return;
            case 0x81: // Digitize
            case 0x82: // Screen mode set
            case 0x84: // Screen brightness
                if (buf.length >= 2) finishCmd();
                return;
            case 0x83: // Screen mode get
                this._rtcRxBuf.push(0);
                finishCmd();
                return;
            default:
                finishCmd();
                return;
        }
    }

    /** Emit current host time as a 7-byte BCD response in _rtcRxBuf. */
    _rtcEmitGet() {
        const now = new Date();
        const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
        // RTC response: sec, min, hour, weekday, day, month, year (7 bytes BCD)
        this._rtcRxBuf.push(bcd(now.getSeconds()));
        this._rtcRxBuf.push(bcd(now.getMinutes()));
        this._rtcRxBuf.push(bcd(now.getHours()));
        this._rtcRxBuf.push(now.getDay() & 0xFF);
        this._rtcRxBuf.push(bcd(now.getDate()));
        this._rtcRxBuf.push(bcd(now.getMonth() + 1));
        this._rtcRxBuf.push(bcd(now.getFullYear() % 100));
    }


    // =========================================================================
    // BEEP Sound
    // =========================================================================

    /**
     * Start BEEP tone. The core only records the continuous-BEEP state; the
     * audible tone is produced by the host (FM7Browser overrides this).
     * @param {number} durationMs - Duration in ms, or -1 for continuous
     */
    _beepStart(durationMs) {
        this._beepContinuous = (durationMs < 0);
    }

    /** Stop BEEP tone (host override produces the fade-out). */
    _beepStop() {
        this._beepContinuous = false;
    }




}
