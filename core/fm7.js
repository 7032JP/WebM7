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
import { Display, DISPLAY_MODE_400 } from './display.js';
import { FDC } from './fdc.js';
import { Scheduler } from './scheduler.js';
import { Keyboard } from './keyboard.js';
import { PSG } from './psg.js';
import { OPN } from './opn.js';
import { usToTicks, ticksToUs, MASTER_CLOCK_HZ, TICKS_PER_US, SUB_CPU_CLOCK_HZ, SUB_CYCLES_PER_TICK } from './scheduler.js';
import { CMT } from './cmt.js';
import { MouseSetCard, SoundChipPorts, ConnectorMouse } from './inputports.js';
import { ExSeriesUnit } from './exseries.js';

// =============================================================================
// Memory Map Constants
// =============================================================================

// Main CPU memory map
const MAIN_RAM_SIZE      = 0x8000;   // 32KB main RAM ($0000-$7FFF)
const BASIC_ROM_BYTES    = 0x7C00;   // 31KB
const IO_BASE            = 0xFD00;   // I/O space ($FD00-$FDFF)
const IO_END             = 0xFDFF;
const BOOT_ROM_BASE      = 0xFE00;   // Boot ROM ($FE00-$FFFF)
const BOOT_LOADER_BYTES      = 0x0200;   // 512 bytes
const VECTOR_AREA_FIRST  = 0xFFE0;   // interrupt vectors: RAM
const RESTART_VECTOR     = 0xFFFE;   // restart address ($FFFE/$FFFF)
const RESTART_ADDRESS    = 0xFE00;   // FM-7 restart address: fixed at the boot ROM start
// Shared RAM between the main and sub CPUs:
// main $FC80-$FCFF and sub $D380-$D3FF are the same 128 bytes.
const SHARED_MAIN_FIRST  = 0xFC80;
const SHARED_MAIN_LAST   = 0xFCFF;
const SHARED_SUB_FIRST   = 0xD380;
const SHARED_SUB_LAST    = 0xD3FF;
const SHARED_BYTES       = 0x0080;

// Sub CPU memory map
const SUB_ROM_BASE       = 0xD800;   // Sub CPU ROM ($D800-$FFFF)
const SUB_ROM_SIZE       = 0x2800;   // 10KB

// FM77AV Sub ROM layout
const SUB_ROM_AV_BASE    = 0xE000;   // new sub monitor ROM start ($E000-$FFFF, 8KB)

// Sub monitors started by a $FD13 write, named as in HW manual 8.6.5, plus
// the program in the extended sub RAM of the EX series.
const MONITOR_OLD_SUB     = 'old sub (640x200)';
const MONITOR_NEW_SUB_640 = 'new sub (640x200)';
const MONITOR_NEW_SUB_320 = 'new sub (320x200)';
const MONITOR_SUB_RAM     = 'extended sub RAM';
// $FD13 bits 1-0 -> monitor; 11 is treated as the old sub.
const MONITOR_BY_SUB_BANK = [MONITOR_OLD_SUB, MONITOR_NEW_SUB_640, MONITOR_NEW_SUB_320, MONITOR_OLD_SUB];

// Status bytes read as [bit, test that makes the bit 1]; the bits outside
// the table always read 1.
const inDisplayPeriod = (m) => !m._verticalBlanking && !m._inHorizontalBlank;
// Sub $D430 (HW manual 4.2, 8.4.1 (2), 8.6.1-8.6.3)
const D430_READ_BITS = [
    [0x80, inDisplayPeriod],              // DISP TIME
    [0x10, (m) => m.display.lineReady],   // LINE: 1 = READY
    [0x04, (m) => m._inVsyncPulse],       // VSYNC
    [0x01, (m) => m._subResetStatus],     // RESET: 1 = reset by $FD13
];
const D430_UNUSED_BITS = 0x6A;
// Main $FD12 (HW manual 4.1, 8.6.6)
const FD12_READ_BITS = [
    [0x40, (m) => m.display.columns320],  // 320/640: 1 = 320x200 4096 colors
    [0x02, inDisplayPeriod],              // display
    [0x01, (m) => m._inVsyncPulse],       // VSYNC
];
const FD12_UNUSED_BITS = 0xBC;
// Main $FD04 read (HW manual 4.1): BUSY reads 1 while busy, BREAK and
// ATTENTION read 0 while active, bits 6-2 read 1.
const FD04_READ_BITS = [
    [0x80, (m) => m._subBusyLine()],      // BUSY (same line as $FD05 bit 7)
    [0x02, (m) => !m._breakKey],          // BREAK, 0 = pressed
    [0x01, (m) => !m._attentionLatch],    // ATTENTION, 0 = requested
];
const FD04_UNUSED_BITS = 0x7C;
// Sub $D430 write: each field taken from the same byte.
const D430_WRITE_FIELDS = [
    (m, v) => { m._nmiMaskSub = (v & 0x80) !== 0; },          // NMI mask
    (m, v) => m.display.writePageControl(v),                  // DB, AB, OA
    (m, v) => { m._characterGeneratorBank = v & 0x03; },      // CG / sub monitor ROM bank
];

// I/O port addresses (main CPU side)
const FD00_KEY_STATUS    = 0xFD00;   // Keyboard status
const FD01_KEY_DATA      = 0xFD01;   // Keyboard data
const FD02_KEY_IRQ_MASK  = 0xFD02;   // Keyboard IRQ mask
const FD03_IRQ_STATUS    = 0xFD03;   // IRQ status (read) / BEEP control (write)
// HD6844 channel control register bits
const DMA_CH_MEMORY_TO_DEVICE = 0x01;   // R/W: 1 = memory -> device
const DMA_CH_MODE_BLOCK       = 0x02;   // MCA: 1 = whole block with the main CPU halted (MCB = 0)
const DMA_CH_MODE_TSC         = 0x04;   // MCB: 1 = TSC steal
const DMA_CH_ADDRESS_DOWN     = 0x08;   // 1 = address counts down
const DMA_CH_BUSY             = 0x40;   // Busy/Ready (read only)
const DMA_CH_DEND             = 0x80;   // DEND (read only, cleared by reading the register)
// Bits that software can write, from the register descriptions of the MC6844
// data sheet: channel control bits 0-3 (bits 6-7 are status), priority control
// bits 0-3 (request enables) and bit 7 (rotate), interrupt control bits 0-3
// (done interrupt enables), data chain bits 0-3.
const DMA_WRITABLE_CHANNEL_CTL   = 0x0F;
const DMA_WRITABLE_PRIORITY_CTL  = 0x8F;
const DMA_WRITABLE_INTERRUPT_CTL = 0x0F;
const DMA_WRITABLE_CHAIN_CTL     = 0x0F;
// Main CPU cycles lost per DMA byte in the HALT steal mode: the HALT
// acknowledge, the transfer cycle and the bus hand-back.
const DMA_STOLEN_CYCLES_PER_BYTE = 3;

const IO_SUB_ATTN_STATUS = 0xFD04;   // read: ATTENTION / BREAK
const IO_SUB_CONTROL     = 0xFD05;   // read: BUSY / EXTDET, write: HALT / CANCEL
const FD0F_ROM_SELECT    = 0xFD0F;   // ROM bank select

// FM77AV additional I/O ports (main CPU side)
const FD12_SUB_MONITOR   = 0xFD12;   // Display mode select (write) / blanking and VSYNC status (read)
const IO_INITIATOR_DISABLE = 0xFD10; // bit 1: initiator ROM 0 = enabled, 1 = disabled
const IO_SUB_MONITOR_SEL = 0xFD13;   // sub monitor select; every write resets the sub CPU
const FD30_APAL_ADDR_HI  = 0xFD30;   // analog palette number LC11-LC8 (HW manual 4.1)
const FD31_APAL_ADDR_LO  = 0xFD31;   // analog palette number LC7-LC0
const FD32_APAL_BLUE     = 0xFD32;   // Blue level register BL3-BL0
const FD33_APAL_RED      = 0xFD33;   // Red level register RL3-RL0

// Memory management (HW manual 8.1)
const MAP_REGISTER_FIRST = 0xFD80;   // MMR: registers 0-15 of the selected segment
const MAP_REGISTER_LAST  = 0xFD8F;
const SEGMENT_SELECT     = 0xFD90;   // MSR (MMR segment register)
const WINDOW_OFFSET      = 0xFD92;   // WOR (window offset register), write only
const MODE_SELECT        = 0xFD93;   // mode select: bit 7 MMR, bit 6 window, bit 0 boot RAM
const MAP_SEGMENTS_MAX   = 8;        // 4 segments, 8 with the wide MMR
const WINDOW_FIRST       = 0x7C00;   // window area $7C00-$7FFF
const WINDOW_LAST        = 0x7FFF;
const RESIDENT_FIRST     = 0xFC00;   // $FC00-$FFFF is never translated
const PHYSICAL_RAM_BYTES = 0x70000;  // largest extended RAM (FM77AV40 / AV40EX)

// FDC I/O ($FD18-$FD1F)
const FDC_IO_BASE        = 0xFD18;
const FDC_IO_END         = 0xFD1F;

// Main CPU TIMER interrupt period: 2.03 ms (FM-7 User's Manual, system
// specification 1.8.3; FM77AV Hardware Manual 8.2.1 (2)).
const MAIN_TIMER_PERIOD_US = 2030;
// Sub CPU NMI clock: 20 ms (FM77AV Hardware Manual 8.2.2 (1)).
const SUB_NMI_PERIOD_US    = 20000;
// Buzzer: single beep length and tone (chosen values).
const SINGLE_BEEP_US       = 200000;
export const BUZZER_TONE_HZ = 300000 / 256;


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
// Main CPU bus cycle lengths
// -----------------------------------------------------------------------
// In master clock periods (125 ns). The address ranges and lengths are the
// table of FM77AV Hardware Manual 7.1 (2): $0000-$FCFF and $FFE0-$FFFD are
// short, $FD00-$FFDF and $FFFE-$FFFF are long. Internal cycles put $FFFF on
// the bus (MC6809E data sheet, figure "RESET Timing"), so they count as long.
const BUS_TICKS_FM7_MODE = { short: 4, long: 6 };   // 500 ns / 750 ns
const BUS_TICKS_MMR_MODE = { short: 5, long: 7 };   // 625 ns / 875 ns

/** 1 marks a CPU address whose bus cycle is long. */
const LONG_BUS_CYCLE_MAP = (() => {
    const map = new Uint8Array(0x10000);
    map.fill(1, 0xFD00, 0xFFE0);
    map[0xFFFE] = 1;
    map[0xFFFF] = 1;
    return map;
})();

// Sub direct access (FM77AV Hardware Manual 7.1 (2) (3)): an access of the
// main CPU to the sub CPU space (physical $10000-$1FFFF) waits until it is in
// step with the sub CPU's E clock. The sub E period is 250/63 master periods
// (8 MHz / 2.016 MHz); time is counted in 1/63 of a master period so the
// edges fall on whole numbers. The sub E edges are taken at multiples of
// this period from the start of the master clock.
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const SUB_E_UNITS_PER_TICK = SUB_CPU_CLOCK_HZ / gcd(MASTER_CLOCK_HZ, SUB_CPU_CLOCK_HZ);   // 63
const SUB_E_PERIOD_UNITS = MASTER_CLOCK_HZ / gcd(MASTER_CLOCK_HZ, SUB_CPU_CLOCK_HZ);     // 250

/**
 * Master periods to add so that a bus cycle ending at master tick `endTick`
 * ends on the next sub E edge instead (0 when it already does; at most one
 * sub cycle, rounded up to whole master periods).
 */
export function subDirectWaitTicks(endTick) {
    const r = (endTick * SUB_E_UNITS_PER_TICK) % SUB_E_PERIOD_UNITS;
    return r === 0 ? 0 : Math.ceil((SUB_E_PERIOD_UNITS - r) / SUB_E_UNITS_PER_TICK);
}

// --- CRT timing (us) ---------------------------------------------------------
// Every value below is printed in the timing figures of the FM77AV Hardware
// Manual (Fujitsu), section 8.6 "Registers":
//   8.6.1 Display status register, figure "horizontal display period":
//         1H = 63.5 us, blanking 23.8 us, display 39.7 us.
//   8.6.1, figure "vertical display period": display 12.70 ms,
//         vertical blanking 3.94 ms.
//   8.6.2 VSYNC status register, timing figure: VSYNC goes to 1
//         1.52 ms after the vertical blanking starts, stays 0.51 ms, and
//         1.91 ms more pass before the display period.
// The VSYNC timing uses the three parts of the 8.6.2 figure.
// Horizontal: each line starts with blanking, then the display part.
const HSCAN_200 = { periodUs: 63.5,  blankUs: 23.8 };   // Hardware Manual 8.6.1, 15.75 kHz
// 400 lines: no figure; a line is taken as half the 200-line one.
const HSCAN_400 = { periodUs: 63.5 / 2, blankUs: 23.8 / 2 };
// Vertical, the same for 200 and 400 lines. One field, in scan order:
// [length in us, DISP TIME reads blanking, VSYNC reads 1].
const VERTICAL_DISPLAY_US = 12700;                 // Hardware Manual 8.6.1
const VSYNC_FIGURE_US = [1520, 510, 1910];         // Hardware Manual 8.6.2: before / during / after VSYNC
const FIELD_SEGMENTS = [
    { us: VERTICAL_DISPLAY_US, blanking: false, vsync: false },
    ...VSYNC_FIGURE_US.map((us, i) => ({ us, blanking: true, vsync: i === 1 })),
];

// Key encoder commands, indexed by the command byte: [PARAM bytes after
// the command byte (for $80 it depends on the first PARAM byte), action
// run with the PARAM bytes once they are all in].
// $00-$05: the sub command codes of KEYBOARD CONTROL and their PARAM
// (FM-Techknow 5-1-7 (4), figure 5-9); the sub CPU passes the code and the
// PARAM bytes it uses to $D431 one byte at a time, so a command takes
// 1 byte plus its PARAM bytes. The $03 reply has CAPS LED in bit 0 and
// kana LED in bit 1 (the same figure).
// $80: the clock, read by the subsystem at power on (FM-Techknow 5-4). Its
// first PARAM byte selects the direction: $00 asks for the CLOCK_BYTES
// reply, $01 is followed by CLOCK_BYTES clock bytes, which are taken in
// and dropped.
// A command number with no entry here ends with its own byte.
const CLOCK_BYTES = 7;    // the 13 READ RTC digits packed two to a byte (_encoderReplyClock)
const ENCODER_TABLE = new Array(256).fill(null);
for (const [code, param, act] of [
    [0x00, 1, (m, p) => m._encoderSetCodeMode(p[0])],                         // key code mode set
    [0x01, 0, (m) => m._encoderReplies.push(m._encoderCodeMode)],             // key code mode read
    [0x02, 1, () => {}],                                                      // LED set
    [0x03, 0, (m) => m._encoderReplies.push(                                  // LED read
        (m.keyboard.capsLock ? 0x01 : 0) | (m.keyboard.kanaMode ? 0x02 : 0))],
    [0x04, 1, (m, p) => m.keyboard.selectRepeat(p[0])],                       // auto repeat on / off
    [0x05, 2, (m, p) => m.keyboard.setRepeatTiming(p[0], p[1])],              // auto repeat times (x 10 ms)
    [0x80, (dir) => 1 + (dir === 0x01 ? CLOCK_BYTES : 0),                     // clock: direction byte, then data when setting
        (m, p) => { if (p[0] === 0x00) m._encoderReplyClock(); }],
]) ENCODER_TABLE[code] = { param, act };

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
        this._setModel(MACHINE_FM7);
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

        // Wire FDC sound callbacks to the FDD sound synthesiser (if the host
        // supplied one); otherwise they are no-ops.
        this.fdc.onSeekSound = (steps) => {
            if (this.fddSound) this.fddSound.seek(steps, this.isFM77AV);
        };
        this.fdc.onHeadLoadSound = () => {
            if (this.fddSound) this.fddSound.headLoad(this.isFM77AV);
        };
        this.fdc.onDiskInsert = () => {
            if (this.fddSound) this.fddSound.diskInsert(this.isFM77AV);
        };
        this.fdc.onMediaRemoved = () => {
            if (this.fddSound) this.fddSound.diskEject(this.isFM77AV);
        };

        // --- Memory arrays ---
        this.mainRAM    = new Uint8Array(0x10000);              // Full 64KB RAM (ROM overlays on top)
        this.fbasicROM  = new Uint8Array(BASIC_ROM_BYTES);     // $8000-$FBFF
        this.bootROM    = new Uint8Array(BOOT_LOADER_BYTES);        // $FE00-$FFFF (DOS boot)
        this.bootBasROM = new Uint8Array(BOOT_LOADER_BYTES);       // $FE00-$FFFF (BASIC boot)
        this.subROM     = new Uint8Array(SUB_ROM_SIZE);         // Sub CPU $D800-$FFFF
        this.cgROM      = new Uint8Array(0x2000);               // CG ROM (8KB, 4 banks x 2KB)
        this.sharedRam  = new Uint8Array(SHARED_BYTES);   // power-on contents not given in the manuals: $00

        // --- FM77AV additional ROM arrays ---
        this.initiateROM = new Uint8Array(0x2000);    // Initiator ROM (up to 8KB)
        this.subROM_A    = new Uint8Array(0x2800);    // new sub monitor ROM for 640x200 (buffer sized for up to 10KB)
        this.subROM_B    = new Uint8Array(0x2800);    // new sub monitor ROM for 320x200 (buffer sized for up to 10KB)

        // --- Kanji ROM, level 1 (main $FD20-$FD23) ---
        this.kanjiROM   = new Uint8Array(0x20000);    // 128KB level 1, via $FD22/$FD23
        this.kanjiROM.fill(0xFF);
        this._kanjiLevel1Address = 0;                           // 16-bit level 1 address ($FD20/$FD21)

        // --- FM77AV20EX / AV40 / AV40EX extensions (exseries.js) ---
        this.ex = new ExSeriesUnit(this);

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
        // Main/sub interface; see _powerOnSubInterface()
        this._haltLatch        = false;  // $FD05 bit 7 as last written
        this._haltWritten      = false;  // $FD05 written in this main instruction
        this._subStoppedByHalt = false;  // sub CPU stopped by HALT (BA = BS = 1)
        this._cancelLatch      = false;  // CANCEL IRQ request, cleared by the sub reading $D402
        this._attentionLatch   = false;  // ATTENTION from the sub ($D404 read), cleared by the main reading $FD04
        this._busyToMain      = true;   // software busy flag: $D40A write = BUSY, read = READY
        this._ifaceSerial     = 0;      // counts HALT takes and $D40A reads, to order them
        this._haltTakenSerial = 0;      // serial of the last HALT taken
        this._readySerial     = 0;      // serial of the last $D40A read
        this._subResetStatus   = false;  // $D430 bit 0: set by a $FD13 reset
        this._subNmiSeenWhileStopped = false; // 20 ms NMI edge seen while stopped
        this._subCmdCode  = 0;      // Command code last fetched by the sub CPU from $D382 (0 = none / BUSY cleared)
        this._breakKey    = false;  // BREAK key state (directly read via $FD04 bit1)
        this._breakKeyCodes = ['Escape', 'Pause']; // host keys that act as BREAK; a user setting

        // ROM write protection and keyboard handshake are enabled by default.
        // FDC spin-up delay is disabled by default. BREAK status is always readable.
        // onHwWarn(code, message) reports hardware access warnings.
        this.hwStrict = {
            romWriteProtect: true,  // writes to $8000-$FBFF ignored while ROM overlay active
            keyEncHandshake: true,  // code-system switch needs the $D432 ENCSTA handshake
            fdcSpinup:       false, // cold motor spin-up delay (disabled by default)
        };
        this.onHwWarn = null;       // (code, message) => void
        this._startupSystem    = 'basic'; // 'dos' or 'basic' (current active mode)
        this._startupSystemChoice = 'basic'; // 'basic' | 'dos' — machine mode selection
        this._startupSystemChosen = false;   // true once the user picks a mode; FM77AV honors it then
        this._upperSpaceIsRom = true; // BASIC ROM overlay at $8000-$FBFF

        // --- FM77AV specific state ---
        this._initiateROMSize = 0;       // Actual size of loaded Initiator ROM
        this._subROM_ASize    = 0;       // actual size of the loaded 640x200 new sub monitor ROM
        this._subROM_BSize    = 0;       // actual size of the loaded 320x200 new sub monitor ROM
        this._initiatorActive = false;   // Initiator ROM mapped at $6000-$7FFF and $FFFE/$FFFF
        this._standInBootShown = false;  // no initiator ROM: stand-in boot map (see _bootAreaRom)
        this._activeSubMonitor  = MONITOR_OLD_SUB; // monitor started by the last $FD13 write
        this._characterGeneratorBank       = 0;       // CG ROM bank (0-3, bits 0-1 of $D430)
        this._nmiMaskSub      = false;   // NMI mask for sub CPU (bit 7 of $D430)
        this._inVsyncPulse       = false;   // TRUE only during the VSYNC pulse — $FD12 bit 0
        this._fieldSegment    = 0;       // index into FIELD_SEGMENTS (0 = display)
        this._verticalBlanking        = false;   // TRUE for the whole vertical blanking (before, during and after VSYNC, Hardware Manual 8.6.2) — $FD12 bit 1
        this._inHorizontalBlank       = false;   // TRUE=horizontal blanking active
        // Horizontal scan phase, in emulated microseconds since the start of
        // the current scanline. It also times the FM-7 sub CPU hold.
        this._scanPhaseUs      = 0;          // position within the current line
        this._scanTiming       = HSCAN_200;  // HSCAN_200 or HSCAN_400
        // Main CPU bus cycle lengths for the current mode.
        this._busTicks = BUS_TICKS_FM7_MODE;
        this.mainCPU.longCycleMap = LONG_BUS_CYCLE_MAP;
        // Master periods of sub direct access wait taken by the current instruction.
        this._subWaitTicks = 0;
        // Key encoder behind sub $D431 / $D432
        this._encoderReplies = [];        // bytes waiting to be read from $D431
        this._encoderCommand = [];        // bytes of the command being received
        this._encoderByteUnacknowledged = false; // $D432 bit 0 reads 0 once after a byte is sent
        this._encoderStatusUnread = false; // a byte was sent and $D432 not read since
        this._encoderCodeMode = 0;        // 0 / 1: 9-bit codes, 2: scan codes

        // Buzzer. The core decides when it sounds; the
        // host makes the tone (buzzerOutput).
        this._buzzerContinuous  = false;  // $FD03 bit 7
        this._buzzerSingleTicks = 0;      // time left of the single beep
        this._buzzerSounding    = false;  // last state handed to the host
        this._cassetteToSpeaker = false;  // $FD03 bit 0: tape sound to the speaker

        // Analog palette (4096 entries, 12 bits: G in bits 8-11, R in bits 4-7, B in bits 0-3)
        this._palette4096     = new Uint16Array(4096);
        this._analogPaletteAddr = 0;     // Palette write address

        // Memory management. Registers of $FD80-$FD93.
        this._mappingOn       = false;   // $FD93 bit 7: MMR translation
        this._windowOn        = false;   // $FD93 bit 6: window $7C00-$7FFF
        this._bootRamWritable = false;   // $FD93 bit 0: boot RAM accepts writes
        this._segmentSelect   = 0;       // MSR ($FD90)
        this._windowOffset    = 0;       // WOR ($FD92)
        this._mapRegisters    = new Uint8Array(MAP_SEGMENTS_MAX * 16);
        // Extended RAM, indexed by physical address; setMachineType() sizes it.
        this._physicalRam     = new Uint8Array(PHYSICAL_RAM_BYTES);
        // DMA controller HD6844 behind $FD98 / $FD99
        this._dmaRegisterNumber = 0;                 // register number written to $FD98
        this._dmaAddress     = new Uint16Array(4);   // channel 0-3 address (power-on 0)
        this._dmaByteCount   = new Uint16Array(4);   // channel 0-3 byte count (power-on 0)
        this._dmaChannelCtl  = new Uint8Array(4);    // channel 0-3 channel control
        this._dmaPriorityCtl = 0;                    // $14
        this._dmaInterruptCtl = 0;                   // $15 bits 3-0 (DIE0-3); bit 7 is computed
        this._dmaChainCtl    = 0;                    // $16
        this.dmaTransferSeen = false;                // UI: a DMA byte moved since the last poll (the UI clears it)

        // --- OPN (YM2203) / FM Sound Card ---
        this._fmCardEnabled = false; // FM sound card: off by default for FM-7
        // OPN bus interface ($FD15/$FD16)
        this._opnCommand    = 0;    // command code last written to $FD15
        this._opnDataLatch  = 0;    // value last written to $FD16
        this._opnRegisterNo = 0;    // register number taken by command $03
        this._ssgRegisters  = new Uint8Array(16); // registers $00-$0F as written
        // OPN I/O ports and the joystick connectors
        this.soundPorts = new SoundChipPorts();
        // Host gamepad index for each joystick connector (polled by the host),
        // or null when none is assigned.
        this.joystickHostIndex = [null, null];

        // --- Mouse ---
        // One mouse at a time: the bus mouse card ('bus'), or a mouse on
        // joystick connector 1 or 2 ('port1' / 'port2'), or none.
        this.mouseKind = 'none';
        this.mouseCard = new MouseSetCard();
        this.connectorMouse = new ConnectorMouse();
        // $FD17 bit 2 (write): mouse interrupt enable; enabled at reset.
        this._mouseIrqEnable = true;

        // IRQ / FIRQ flags for main CPU
        this._timerIRQ    = false;  // Timer IRQ pending (cleared by reading $FD03)
        this._opnIrqLatch = false;  // OPN timer IRQ latch (edge-triggered; dropped when the OPN IRQ source clears)
        this._opnIrqPrev  = false;  // Previous OPN IRQ state for edge detection
        this._irqMaskReg  = 0;      // $FD02 IRQ mask register as written (bit 2 = timer, bit 4 = FDC)

        // Emulation loop state (maintained by the host's frame loop, e.g.
        // FM7Browser; reported through getStatus())
        this._running     = false;
        this._currentFPS  = 0;

        // --- Wire components together ---
        this._wireMemory();
        this._buildMainPageViews();
        this._wireScheduler();
        this._wireKeyboard();
        this._wireFDC();

        // Devices that count time do so in master clock periods.
        this._installTickRate();
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
    // Main CPU page tables (see CPU6809.readPages)
    // =========================================================================
    // A page goes straight to main RAM or to the BASIC ROM only while what
    // _mainRead / _mainWrite would do for it is a plain array access. Every
    // state those depend on for $0000-$FBFF (the MMR and window switches,
    // the BASIC ROM overlay, the initiator ROM, the machine type and the
    // loaded ROMs) calls _refreshMainPages when it changes. $FC00-$FFFF
    // (shared RAM, I/O, boot area) always takes the handler.

    /** 256-byte views of main RAM and the BASIC ROM, made once (the arrays are never replaced). */
    _buildMainPageViews() {
        const view = (mem, p) => mem.subarray(p << 8, (p + 1) << 8);
        this._mainRamPages = Array.from({ length: 256 }, (_, p) => view(this.mainRAM, p));
        this._basicRomPages = Array.from({ length: BASIC_ROM_BYTES >> 8 }, (_, p) => view(this.fbasicROM, p));
        this._mainPagesReady = true;
        this._refreshMainPages();
        this._buildSubPageViews();
    }

    /** Work out the main CPU page tables from the current memory map. */
    _refreshMainPages() {
        if (!this._mainPagesReady) return;
        const rd = this.mainCPU.readPages, wr = this.mainCPU.writePages;
        rd.fill(null);
        wr.fill(null);
        // MMR translation: every access goes through _translateMainAddress.
        if (this._mappingOn) return;
        const ram = this._mainRamPages, basic = this._basicRomPages;
        const upperRom = this._upperSpaceIsRom;
        const basicLoaded = this.romLoaded.fbasic;
        const initiator = this._isFM77AV && this._initiatorActive && this.romLoaded.initiate;
        const windowOn = this._windowOn;
        for (let p = 0; p < (RESIDENT_FIRST >> 8); p++) {
            if (windowOn && p >= (WINDOW_FIRST >> 8) && p <= (WINDOW_LAST >> 8)) continue;
            const upper = p >= (MAIN_RAM_SIZE >> 8);
            // Writes under the BASIC ROM overlay may be refused (_mainWrite).
            if (!(upper && upperRom)) wr[p] = ram[p];
            if (initiator && p >= 0x60 && p < 0x80) continue;
            if (!upper || !upperRom) rd[p] = ram[p];
            else if (basicLoaded) rd[p] = basic[p - (MAIN_RAM_SIZE >> 8)];
        }
    }

    // =========================================================================
    // Sub CPU page tables (see CPU6809.readPages)
    // =========================================================================
    // Direct pages: the work RAM $C000-$D2FF (not while the EX-series banked
    // RAM may cover $C000-$CFFF), the FM77AV work RAM $D500-$D7FF, and for
    // reads the ROM at $D800-$FFFF that _subRead would pick. They depend on
    // the machine type, the EX-series features, the sub monitor, the CG ROM
    // bank and the new sub monitor ROM sizes; each of those calls
    // _refreshSubPages when it changes. VRAM, shared RAM and I/O always take
    // the handler.

    /** 256-byte views of the sub side memories (the arrays are never replaced). */
    _buildSubPageViews() {
        const views = (mem) => Array.from({ length: mem.length >> 8 }, (_, p) => mem.subarray(p << 8, (p + 1) << 8));
        this._subViews = {
            workRam: views(this.display.workRam.subarray(0, 0x1300)),   // $C000-$D2FF
            workRamD500: views(this.display.workRamD500),
            subROM: views(this.subROM), subROM_A: views(this.subROM_A), subROM_B: views(this.subROM_B),
            cgROM: views(this.cgROM),
        };
        this._subPagesReady = true;
        this._refreshSubPages();
    }

    /** Work out the sub CPU page tables from the current state. */
    _refreshSubPages() {
        if (!this._subPagesReady) return;
        const rd = this.subCPU.readPages, wr = this.subCPU.writePages;
        rd.fill(null);
        wr.fill(null);
        const v = this._subViews;
        const av = this._isFM77AV;
        // Work RAM; $C000-$CFFF only when no banked RAM can answer there.
        const firstWork = this.ex.features.extSubRam ? 0xD0 : 0xC0;
        for (let p = firstWork; p < 0xD3; p++) { rd[p] = wr[p] = v.workRam[p - 0xC0]; }
        if (av) for (let p = 0xD5; p < 0xD8; p++) { rd[p] = wr[p] = v.workRamD500[p - 0xD5]; }
        // ROM at $D800-$FFFF (reads only).
        const monitor = this._activeSubMonitor;
        if (monitor === MONITOR_SUB_RAM) return;
        for (let p = SUB_ROM_BASE >> 8; p < 0x100; p++) {
            let page;
            if (!av || monitor === MONITOR_OLD_SUB) {
                page = v.subROM[p - (SUB_ROM_BASE >> 8)];
            } else if (p < (SUB_ROM_AV_BASE >> 8)) {
                page = v.cgROM[this._characterGeneratorBank * 8 + (p - (SUB_ROM_BASE >> 8))];
            } else {
                const a = monitor === MONITOR_NEW_SUB_640;
                const size = a ? (this._subROM_ASize || 0x2000) : (this._subROM_BSize || 0x2000);
                const pages = a ? v.subROM_A : v.subROM_B;
                page = pages[p - ((size > 0x2000 ? SUB_ROM_BASE : SUB_ROM_AV_BASE) >> 8)];
            }
            rd[p] = page;
        }
    }

    get _activeSubMonitor() { return this._activeSubMonitorValue; }
    set _activeSubMonitor(v) { if (v !== this._activeSubMonitorValue) { this._activeSubMonitorValue = v; this._refreshSubPages(); } }
    get _characterGeneratorBank() { return this._characterGeneratorBankValue; }
    set _characterGeneratorBank(v) { if (v !== this._characterGeneratorBankValue) { this._characterGeneratorBankValue = v; this._refreshSubPages(); } }
    get _subROM_ASize() { return this._subROM_ASizeValue; }
    set _subROM_ASize(v) { if (v !== this._subROM_ASizeValue) { this._subROM_ASizeValue = v; this._refreshSubPages(); } }
    get _subROM_BSize() { return this._subROM_BSizeValue; }
    set _subROM_BSize(v) { if (v !== this._subROM_BSizeValue) { this._subROM_BSizeValue = v; this._refreshSubPages(); } }

    get _mappingOn() { return this._mappingOnBit; }
    set _mappingOn(v) { if (v !== this._mappingOnBit) { this._mappingOnBit = v; this._refreshMainPages(); } }
    get _windowOn() { return this._windowOnBit; }
    set _windowOn(v) { if (v !== this._windowOnBit) { this._windowOnBit = v; this._refreshMainPages(); } }
    get _upperSpaceIsRom() { return this._upperSpaceIsRomBit; }
    set _upperSpaceIsRom(v) { if (v !== this._upperSpaceIsRomBit) { this._upperSpaceIsRomBit = v; this._refreshMainPages(); } }
    get _initiatorActive() { return this._initiatorActiveBit; }
    set _initiatorActive(v) { if (v !== this._initiatorActiveBit) { this._initiatorActiveBit = v; this._refreshMainPages(); } }

    // =========================================================================
    // Main CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _mainRead(addr) {
        addr &= 0xFFFF;

        // FM77AV: Initiator ROM overlay takes priority over MMR.
        // When active, $6000-$7FFF always reads from Initiator ROM.
        // The reset vector ($FFFE/$FFFF) also shows the last two bytes of the
        // ROM ($7FFE/$7FFF) so it resolves to the initiator entry.  The rest
        // of $FE00-$FFFF stays RAM.
        if (this.isFM77AV && this._initiatorActive && this.romLoaded.initiate) {
            if (addr >= 0x6000 && addr < 0x8000) {
                return this.initiateROM[addr - 0x6000];
            }
            if (addr >= 0xFFFE) {
                return this.initiateROM[addr & 0x1FFF];
            }
        }

        // $0000-$FBFF: through the window / MMR when they translate it
        if (addr < RESIDENT_FIRST) {
            const phys = this._translateMainAddress(addr);
            return phys >= 0 ? this._readPhysical(phys, addr) : this._readStandard(addr);
        }

        // $FC00-$FC7F: RAM
        if (addr < SHARED_MAIN_FIRST) {
            return this.mainRAM[addr];
        }

        // Shared RAM. Software touches it only while the
        // sub CPU is stopped; outside HALT it is accessible as well.
        if (addr <= SHARED_MAIN_LAST && addr >= SHARED_MAIN_FIRST) {
            return this.sharedRam[addr - SHARED_MAIN_FIRST];
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            return this._mainIORead(addr);
        }

        // $FE00-$FFFF: boot area. The memory map decides, for each read,
        // whether a boot ROM or the RAM underneath answers (see
        // _bootAreaRom / _restartAddress). Writes go to the RAM; on the
        // FM77AV family $FE00-$FFDF takes them only while $FD93 bit 0 is 1
        // (see _mainWrite).
        if (addr >= BOOT_ROM_BASE) {
            if (addr >= RESTART_VECTOR) {
                const start = this._restartAddress();
                if (start >= 0) return (addr === RESTART_VECTOR) ? (start >> 8) : (start & 0xFF);
                return this.mainRAM[addr];
            }
            if (addr >= VECTOR_AREA_FIRST) return this.mainRAM[addr];
            const rom = this._bootAreaRom();
            return rom ? rom[addr - BOOT_ROM_BASE] : this.mainRAM[addr];
        }

        return 0xFF;
    }

    /** CPU address $0000-$FBFF of the standard space: RAM, or the BASIC ROM when enabled. */
    _readStandard(addr) {
        if (addr < MAIN_RAM_SIZE || !this._upperSpaceIsRom) return this.mainRAM[addr];
        if (this.romLoaded.fbasic) return this.fbasicROM[addr - 0x8000];
        // ROM enabled but not loaded: warn once and show the RAM underneath.
        if (!this._fbasicWarnShown) {
            this._fbasicWarnShown = true;
            console.error(`[ROM MISSING] BASIC ROM read at $${addr.toString(16).toUpperCase()} but not loaded! PC=$${(this.mainCPU.pc||0).toString(16).toUpperCase()}`);
        }
        return this.mainRAM[addr];
    }

    // =========================================================================
    // Main CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _mainWrite(addr, val) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // $0000-$FBFF: through the window / MMR when they translate it
        if (addr < RESIDENT_FIRST) {
            const phys = this._translateMainAddress(addr);
            if (phys >= 0 && this._writePhysical(phys, addr, val)) return;
        }

        // $0000-$FBFF: RAM (writes under the BASIC ROM overlay are ignored
        // while ROM write protection is on)
        if (addr < 0xFC00) {
            // With ROM write protection on, writes into the BASIC ROM range are refused.
            if (this.hwStrict.romWriteProtect &&
                addr >= 0x8000 && this._upperSpaceIsRom && this.romLoaded.fbasic) {
                this._hwWarn('rom-overlay-write',
                    `write $${val.toString(16).padStart(2,'0')} to $${addr.toString(16).toUpperCase()} ignored: BASIC ROM overlay active (set $FD0F to map RAM first)`);
                return;
            }
            this.mainRAM[addr] = val;
            return;
        }

        // $FC00-$FC7F: RAM
        if (addr < SHARED_MAIN_FIRST) {
            this.mainRAM[addr] = val;
            return;
        }

        // Shared RAM, same rule as the read side.
        if (addr <= SHARED_MAIN_LAST) {
            this.sharedRam[addr - SHARED_MAIN_FIRST] = val;
            return;
        }

        // $FD00-$FDFF: I/O space
        if (addr >= IO_BASE && addr <= IO_END) {
            this._mainIOWrite(addr, val);
            return;
        }

        // $FE00-$FFFF: boot area - writes go to the RAM underneath (the
        // ROM overlay affects reads only; the stack often lives here).
        if (addr >= BOOT_ROM_BASE) {
            // On the FM77AV family $FE00-$FFDF takes writes only while
            // $FD93 bit 0 is 1; $FFE0-$FFFF always does.
            if (this.isFM77AV && addr <= 0xFFDF && !this._bootRamWritable) {
                if (!this._bootRamWarned) {
                    this._bootRamWarned = true;
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
        // EX-series registers and absent devices ($FD24-$FD2F, $FD94-$FD9D)
        if (this.ex.claimsMainIO(addr, this.hasDmaController)) {
            return this.ex.readMainIO(addr);
        }

        // Keyboard ($FD00 read: bit 7 = upper bit of the key code, bit 0 = CPU speed flag)
        if (addr === FD00_KEY_STATUS) {
            let val = this.keyboard.readKeyUpper();
            // bit 0: CPU speed flag — always 1 (normal speed; the low-speed
            // switch is not emulated).
            val |= 0x01;
            return val;
        }
        if (addr === FD01_KEY_DATA) {
            return this.keyboard.readKeyData();
        }

        // $FD02 read: bit 7 = cassette data input, bit 1 = printer, bit 0 = printer ACK
        if (addr === FD02_KEY_IRQ_MASK) {
            let val = 0x7F; // bit 7 is set from the cassette input below
            // bit 7: cassette data input (from tape)
            val = (val & ~0x80) | this.cmt.readDataBit();
            return val;
        }

        // IRQ status ($FD03 read) - active low: 0 = pending; reading clears the timer flag only
        // bit 0: keyboard, bit 1: printer, bit 2: timer, bit 3: extended (OPN/FDC)
        //
        // bit 0 reads 0 while the key interrupt is enabled ($FD02 bit 0 = 1)
        // and a request is pending; 1 while it is disabled (including just
        // after a reset).
        if (addr === FD03_IRQ_STATUS) {
            let status = 0xFF;
            if (this.keyboard.mainInterrupt) status &= ~0x01;
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
            if (this._mouseCardIrq()) status &= ~0x08;
            return status;
        }

        // $FD17 (read): bit 3 OPN interrupt, bit 2 mouse interrupt, 0 = pending
        // Present with the OPN (FM77AV family or the FM sound card).
        if (addr === 0xFD17) {
            if (!this._hasOpn()) return 0xFF;
            let val = 0xFF;
            if (this._opnIrqLatch) val &= ~0x08;
            if (this._mouseCardIrq()) val &= ~0x04;
            return val;
        }

        if (addr === IO_SUB_ATTN_STATUS) return this._readAttentionStatus();
        if (addr === IO_SUB_CONTROL) return this._readSubStatus();

        // $FD0B: Boot status register (FM77AV+)
        // bit 0: 0=BASIC boot, 1=DOS boot
        // Returns $FE (BASIC) or $FF (DOS)
        if (addr === 0xFD0B) {
            if (this.isFM77AV) {
                return (this._startupSystem === 'basic') ? 0xFE : 0xFF;
            }
            return 0xFF;
        }

        // $FD0F: Reading enables BASIC ROM overlay at $8000-$FBFF
        if (addr === FD0F_ROM_SELECT) {
            this._upperSpaceIsRom = true;
            return 0xFF;
        }

        // $FD10 is write only (HW manual 4.1); it reads $FF.
        if (addr === IO_INITIATOR_DISABLE && this.isFM77AV) return 0xFF;

        // $FD12 read (HW manual 4.1, 8.6.6)
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            return this._composeStatus(FD12_READ_BITS, FD12_UNUSED_BITS);
        }

        // $FD30-$FD34: analog palette, all write only (HW manual 4.1)
        if (addr >= 0xFD30 && addr <= 0xFD34) return 0xFF;

        // FDC registers ($FD18-$FD1F)
        if (addr >= FDC_IO_BASE && addr <= FDC_IO_END) {
            return this.fdc.readIO(addr);
        }

        // $FD37: Multi-page register — write-only; reads as 0xFF.
        if (addr === 0xFD37) {
            return 0xFF;
        }

        // $FD38-$FD3F: TTL palette. FM77AV and later read
        // back bits 2-0 (G, R, B) with bits 7-3 as 1; FM-7 / FM-77 write-only.
        if (addr >= 0xFD38 && addr <= 0xFD3F) {
            if (!this.isFM77AV) return 0xFF;
            return 0xF8 | (this.display.readPalette(addr - 0xFD38) & 0x07);
        }

        // $FD0D / $FD0E: PSG (HW manual 4.1 "PSG, shared with the FM sound").
        // The FM-7 has its own PSG; on the FM77AV family the OPN answers.
        if (addr === 0xFD0D) {
            return this.isFM77AV ? 0xFF : this.psg.readCmd();
        }
        if (addr === 0xFD0E) {
            return this.isFM77AV ? this._opnDataRead() : this.psg.readData();
        }

        // $FD15: OPN command register — write-only (BDIR/BC1/status-read mode).
        // Reads return open bus ($FF); OPN status is surfaced on $FD16 data bus
        // via bit2 "status read" mode.
        if (addr === 0xFD15) {
            return 0xFF;
        }

        // $FD16: OPN data read
        if (addr === 0xFD16) {
            if (!this._fmCardEnabled) return 0xFF;
            return this._opnDataRead();
        }

        // $FD06/$FD07: RS-232C USART (not installed: return open bus)
        if (addr === 0xFD06 || addr === 0xFD07) return 0xFF;

        // $FD20/$FD21: Kanji ROM address register (write-only, read returns 0xFF)
        // $FD22/$FD23: Kanji ROM data (level 1)
        // ($FD24-$FD2F are answered by the EX-series unit at the top.)
        if (addr === 0xFD22 || addr === 0xFD23) {
            const offset = (this._kanjiLevel1Address << 1) + (addr & 1);
            return this.kanjiROM[offset & 0x1FFFF];
        }
        if (addr >= 0xFD20 && addr <= 0xFD2F) return 0xFF;

        // $FD08-$FD0C: Printer/timer I/O (stub)
        if (addr >= 0xFD08 && addr <= 0xFD0C) return 0xFF;

        // $FD11: Extended sub interface (stub)
        if (addr === 0xFD11) return 0xFF;

        // $FD13 is write only; it always reads $FF.
        if (addr === IO_SUB_MONITOR_SEL) return 0xFF;

        // $FD14: Extended register (stub)
        if (addr === 0xFD14) return 0xFF;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return 0xFF;

        // Mouse set card: timer $FDE0-$FDE7, counters and switches $FDE8
        // Without the card the addresses read as unconnected.
        if (addr >= 0xFDE0 && addr <= 0xFDE8) {
            if (this.mouseKind !== 'bus') return 0xFF;
            if (addr === 0xFDE8) return this.mouseCard.readStatus();
            return this.mouseCard.timer.read(addr - 0xFDE0);
        }

        // DMA controller: $FD98 reads $FF
        if (this.hasDmaController && addr === 0xFD98) return 0xFF;
        if (this.hasDmaController && addr === 0xFD99) return this._readDmaRegister(this._dmaRegisterNumber);

        // Memory management registers
        if (this.hasMMR && addr >= MAP_REGISTER_FIRST && addr <= 0xFD9F) {
            return this._readMemoryManagement(addr);
        }

        // Log unhandled I/O reads (FM77AV mode only, throttled)
        if (this.isFM77AV) {
            const key = addr & 0xFFFF;
            if (!this._ioWarnSeen) this._ioWarnSeen = new Set();
            if (!this._ioWarnSeen.has(key)) {
                this._ioWarnSeen.add(key);
                console.warn(`[IO READ] Unhandled I/O read`);
            }
        }

        // Other I/O - return default
        return 0xFF;
    }

    // =========================================================================
    // Main CPU I/O Write ($FD00-$FDFF)
    // =========================================================================

    _mainIOWrite(addr, val) {
        // EX-series registers and absent devices ($FD24-$FD2F, $FD94-$FD9D)
        if (this.ex.claimsMainIO(addr, this.hasDmaController)) {
            this.ex.writeMainIO(addr, val);
            return;
        }

        // $FD00 write: cassette motor control + write data
        // bit 0: cassette write data (recording), bit 1: motor (1=ON)
        // (FM-7 User's Manual, system specification 1.12.5: output port bit 1
        // drives the motor relay through an inverter; 1 turns the relay ON)
        if (addr === FD00_KEY_STATUS) {
            this.cmt.setControl(val);
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
            // bit 0: key interrupt to the main CPU (1) or the sub CPU (0)
            this.keyboard.setInterruptToMain((val & 0x01) !== 0);
            return;
        }

        if (addr === FD03_IRQ_STATUS) {
            this._writeBuzzerRegister(val);
            return;
        }

        if (addr === IO_SUB_CONTROL) {
            this._writeSubControl(val);
            return;
        }

        // $FD0F: Writing disables BASIC ROM overlay
        if (addr === FD0F_ROM_SELECT) {
            this._upperSpaceIsRom = false;
            return;
        }

        // $FD0B / $FD0C writes on the AV40 family: accepted and ignored.
        if ((addr === 0xFD0B || addr === 0xFD0C) && this.isAV40) return;

        // $FD10 write (HW manual 4.1; BIOS manual appendix 1): bit 1 is the
        // initiator ROM disable, 0 = enabled, 1 = disabled. Nothing else
        // changes here; the ROM sets the sub monitor itself through $FD13.
        if (addr === IO_INITIATOR_DISABLE && this.isFM77AV) {
            this._initiatorActive = (val & 0x02) === 0 && this.romLoaded.initiate;
            return;
        }

        // FM77AV: $FD12 write - 320/640 mode select
        // bit 6: 1=320x200 mode, 0=640x200 mode
        if (addr === FD12_SUB_MONITOR && this.isFM77AV) {
            this.display.setColumns320((val & 0x40) !== 0);
            return;
        }

        // $FD13 (AV family): sub monitor select and sub CPU reset
        if (addr === IO_SUB_MONITOR_SEL && this.isFM77AV) {
            this._writeSubMonitorSelect(val);
            return;
        }

        // $FD30-$FD34: analog palette number, then the Blue / Red / Green
        // level registers of that entry (HW manual 4.1)
        if (this.isFM77AV) {
            if (addr === FD30_APAL_ADDR_HI) {
                this._analogPaletteAddr = (this._analogPaletteAddr & 0x0FF) | ((val & 0x0F) << 8);
                return;
            }
            if (addr === FD31_APAL_ADDR_LO) {
                this._analogPaletteAddr = (this._analogPaletteAddr & 0xF00) | (val & 0xFF);
                return;
            }
            // Kept as G in bits 11-8, R in bits 7-4, B in bits 3-0.
            if (addr === FD32_APAL_BLUE) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._palette4096[idx];
                this._palette4096[idx] = (cur & 0xFF0) | (val & 0x0F);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                return;
            }
            if (addr === FD33_APAL_RED) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._palette4096[idx];
                this._palette4096[idx] = (cur & 0xF0F) | ((val & 0x0F) << 4);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                return;
            }
            // $FD34: Green level
            if (addr === 0xFD34) {
                const idx = this._analogPaletteAddr & 0xFFF;
                const cur = this._palette4096[idx];
                this._palette4096[idx] = (cur & 0x0FF) | ((val & 0x0F) << 8);
                this.display._analogDirty = true;
                this.display._fullDirty = true;
                return;
            }
        }

        // $FD37: Multi-page register (main CPU side access)
        // Controls which color planes are visible (bit=1 → plane disabled)
        if (addr === 0xFD37) {
            if (this.display.planeMaskBits !== val) {
                this.display.planeMaskBits = val;
                this.display._fullDirty = true;
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

        // $FD0D / $FD0E: PSG (HW manual 4.1). $FD0D takes BDIR / BC1 in
        // bits 1-0; on the FM77AV family they drive the OPN.
        if (addr === 0xFD0D) {
            if (this.isFM77AV) {
                this._opnCommandWrite(val & 0x03);
            } else {
                this.psg.writeCmd(val);
            }
            return;
        }
        if (addr === 0xFD0E) {
            if (this.isFM77AV) {
                this._opnDataWrite(val);
            } else {
                this.psg.writeData(val);
            }
            return;
        }

        // $FD15: OPN command register — 4-bit enum decode (FM card / FM77AV).
        if (addr === 0xFD15) {
            if (this._fmCardEnabled) this._opnCommandWrite(val);
            return;
        }

        // $FD16: OPN data bus write
        if (addr === 0xFD16) {
            if (this._fmCardEnabled) this._opnDataWrite(val);
            return;
        }

        // $FD00 writes are handled above (cassette control)
        if (addr === 0xFD00) return;

        // $FD04 write, decoded in one place:
        //   the read side ($FD04 bits 0, 1) is unaffected;
        //   bits 2-5 latched, bit 2 = extended sub RAM write enable;
        //   bit 3 = 400 lines (0), bit 4 = 262,144 colors.
        if (addr === 0xFD04) {
            this.ex.latchFormatByte(val);
            if (this.display.has400Line || this.display.has262kColor) {
                this.display.writeFormatByte(val);
            }
            return;
        }

        // $FD06/$FD07: RS-232C USART write (stub: no device)
        if (addr === 0xFD06 || addr === 0xFD07) return;

        // $FD20/$FD21: level 1 kanji ROM address, high / low byte
        // $FD22/$FD23: level 1 data (read-only)
        // ($FD24-$FD2F are handled by the EX-series unit at the top.)
        if (addr === 0xFD20) {
            this._kanjiLevel1Address = (this._kanjiLevel1Address & 0x00FF) | (val << 8);
            return;
        }
        if (addr === 0xFD21) {
            this._kanjiLevel1Address = (this._kanjiLevel1Address & 0xFF00) | val;
            return;
        }
        if (addr >= 0xFD20 && addr <= 0xFD2F) return;

        // $FDFD-$FDFF: Boot mode / extended registers (stub)
        if (addr >= 0xFDFD) return;

        // Mouse set card
        if (addr >= 0xFDE0 && addr <= 0xFDE8) {
            if (this.mouseKind !== 'bus') return;
            if (addr === 0xFDE8) this.mouseCard.setControl(val);
            else this.mouseCard.timer.write(addr - 0xFDE0, val);
            return;
        }

        // $FD17 (write): bit 2 = mouse interrupt enable
        if (addr === 0xFD17) {
            if (this._hasOpn()) this._mouseIrqEnable = (val & 0x04) !== 0;
            return;
        }

        // DMA controller
        if (this.hasDmaController && addr === 0xFD98) { this._dmaRegisterNumber = val; return; }
        if (this.hasDmaController && addr === 0xFD99) { this._writeDmaRegister(this._dmaRegisterNumber, val); return; }

        // Memory management registers
        if (this.hasMMR && addr >= MAP_REGISTER_FIRST && addr <= 0xFD9F) {
            this._writeMemoryManagement(addr, val);
            return;
        }

        // Log unhandled I/O writes (FM77AV mode only, throttled)
        if (this.isFM77AV) {
            const key = 0x10000 | (addr & 0xFFFF);
            if (!this._ioWarnSeen) this._ioWarnSeen = new Set();
            if (!this._ioWarnSeen.has(key)) {
                this._ioWarnSeen.add(key);
                console.warn(`[IO WRITE] Unhandled I/O write`);
            }
        }
    }

    // =========================================================================
    // Memory management: MMR and window (HW manual 8.1)
    // =========================================================================

    /** Bits an MMR register holds: 6 (A17-A12), or 8 on machines with the extended MMR. */
    _mapRegisterBits() {
        return this.ex.features.wideMmr ? 0xFF : 0x3F;
    }

    /** Index into _mapRegisters of register `reg` (0-15) in the selected segment. */
    _mapRegisterIndex(reg) {
        const segments = this.ex.wideMmr ? 8 : 4;
        return (this._segmentSelect % segments) * 16 + reg;
    }

    /**
     * Physical address of CPU address `addr` (< $FC00), or -1 when neither
     * the window nor the MMR translates it. The window wins
     * over the MMR inside $7C00-$7FFF.
     */
    _translateMainAddress(addr) {
        if (this._windowOn && addr >= WINDOW_FIRST && addr <= WINDOW_LAST) {
            return (addr + (this._windowOffset << 8)) & 0xFFFF;
        }
        if (!this._mappingOn) return -1;
        let page = this._mapRegisters[this._mapRegisterIndex(addr >> 12)];
        if (!this.ex.wideMmr) page &= 0x3F;
        return (page << 12) | (addr & 0x0FFF);
    }

    /**
     * Sub direct access wait (FM77AV Hardware Manual 7.1 (2) (3)): the bus cycle of this access is
     * stretched until it ends on a sub E edge. The access lies in
     * $0000-$FBFF (a short bus cycle); it starts after the bus cycles the
     * instruction has already made, at their own lengths, and after the
     * waits already taken in it. The CPU does not record where the internal
     * cycles of the instruction fall, so they are counted at its end; in a
     * loop that repeats the same instructions this only moves every access
     * by the same amount, which does not change the waits. The waits are
     * added to the length of the instruction by _runFor.
     */
    _subDirectWait() {
        const cpu = this.mainCPU;
        const bus = this._busTicks;
        const longBefore = cpu.longBusBytes;
        const shortBefore = cpu.busBytes - 1 - longBefore;
        if (shortBefore < 0) return;   // not an access of the main CPU's instruction
        const end = this.scheduler.elapsedTicks + this._subWaitTicks
            + shortBefore * bus.short + longBefore * bus.long + bus.short;
        this._subWaitTicks += subDirectWaitTicks(end);
    }

    /** Read physical address `phys` for CPU address `logicalAddr`. */
    _readPhysical(phys, logicalAddr) {
        const page = phys >>> 12;
        const offset = phys & 0x0FFF;
        switch (page >> 4) {
            case 0x1: // sub CPU space: only while the sub CPU is stopped by HALT
                this._subDirectWait();
                return this._subStoppedByHalt ? this._subRead(phys & 0xFFFF) : 0xFF;
            case 0x3: // standard space
                if ((page & 0x0F) === (logicalAddr >> 12)) return this._readStandard(logicalAddr);
                return this.mainRAM[phys & 0xFFFF];
            case 0x0:
                break;
            default: { // $20000 and up: the EX-series map first
                const v = this.ex.readPhysical(page, offset);
                if (v >= 0) return v;
            }
        }
        return phys < this._physicalRam.length ? this._physicalRam[phys] : 0xFF;
    }

    /**
     * Write physical address `phys` for CPU address `logicalAddr`.
     * Returns false when the byte goes through the untranslated map instead.
     */
    _writePhysical(phys, logicalAddr, val) {
        const page = phys >>> 12;
        switch (page >> 4) {
            case 0x1:
                this._subDirectWait();
                if (this._subStoppedByHalt) this._subWrite(phys & 0xFFFF, val);
                return true;
            case 0x3:
                if ((page & 0x0F) === (logicalAddr >> 12)) return false;
                this.mainRAM[phys & 0xFFFF] = val;
                return true;
            case 0x0:
                break;
            default:
                if (this.ex.writePhysical(page, phys & 0x0FFF, val)) return true;
        }
        if (phys < this._physicalRam.length) this._physicalRam[phys] = val;
        return true;
    }

    /** Read $FD80-$FD9F. $FD94-$FD9D belong to the EX-series unit and the DMA controller. */
    _readMemoryManagement(addr) {
        if (addr <= MAP_REGISTER_LAST) {
            // the bits a register does not have read 1 (the empty cells of HW manual 4.1)
            return this._mapRegisters[this._mapRegisterIndex(addr - MAP_REGISTER_FIRST)] | (~this._mapRegisterBits() & 0xFF);
        }
        switch (addr) {
            case SEGMENT_SELECT: return this._segmentSelect;
            case MODE_SELECT:
                return 0x3E | (this._mappingOn ? 0x80 : 0) | (this._windowOn ? 0x40 : 0)
                    | (this._bootRamWritable ? 0x01 : 0);
            default: return 0xFF;    // WOR is write only; $FD91, $FD9E, $FD9F
        }
    }

    /** Write $FD80-$FD9F (see _readMemoryManagement). */
    _writeMemoryManagement(addr, val) {
        if (addr <= MAP_REGISTER_LAST) {
            // HW manual 4.1: A17-A12 in bits 5-0; the extended MMR keeps all 8 bits.
            this._mapRegisters[this._mapRegisterIndex(addr - MAP_REGISTER_FIRST)] = val & this._mapRegisterBits();
            return;
        }
        switch (addr) {
            case SEGMENT_SELECT: this._segmentSelect = val & 0x07; break;
            case WINDOW_OFFSET:  this._windowOffset = val; break;
            case MODE_SELECT:
                this._mappingOn = (val & 0x80) !== 0;
                this._windowOn = (val & 0x40) !== 0;
                this._bootRamWritable = (val & 0x01) !== 0;
                // Once software opens the boot RAM for writing, the RAM
                // answers the boot area; the stand-in map ends here.
                if (this._bootRamWritable) this._standInBootShown = false;
                this._selectBusCycleLengths();
                break;
        }
    }

    /** Power-on / reset state of $FD80-$FD93. */
    _resetMemoryManagement() {
        this._mappingOn = false;
        this._windowOn = false;
        this._bootRamWritable = false;
        this._bootRamWarned = false;
        this._segmentSelect = 0;
        this._windowOffset = 0;
        this._mapRegisters.fill(0);
    }

    /**
     * Memory management state for a debug view (read only): the mode bits,
     * MSR, WOR and the physical page each CPU page maps to.
     */
    memoryManagementView() {
        const wide = this.ex.wideMmr;
        const pages = [];
        for (let r = 0; r < 16; r++) {
            const v = this._mapRegisters[this._mapRegisterIndex(r)];
            pages.push(wide ? v : v & 0x3F);
        }
        return {
            mapping: this._mappingOn, windowOn: this._windowOn, bootRamWritable: this._bootRamWritable,
            segment: this._segmentSelect, windowOffset: this._windowOffset, wide, pages,
            registers: this._mapRegisters, physicalRamBytes: this._physicalRam.length,
        };
    }

    // =========================================================================
    // Sub CPU Memory Read ($0000-$FFFF)
    // =========================================================================

    _subRead(addr) {
        addr &= 0xFFFF;

        // Banked RAM over $C000-$CFFF
        if (addr >= 0xC000 && addr < 0xD000) {
            const v = this.ex.readC000Bank(addr);
            if (v >= 0) return v;
        }

        // $0000-$BFFF: VRAM (48KB) + $C000-$D37F: Work RAM
        if (addr < 0xD380) {
            return this.display.read(addr);
        }

        // Shared RAM, sub side
        if (addr <= SHARED_SUB_LAST) {
            const v = this.sharedRam[addr - SHARED_SUB_FIRST];
            // $D382: command code.  Remember the code the sub CPU fetched so
            // the auto-type pacing can tell a key read from other work while
            // BUSY.
            if (addr === 0xD382 && v !== 0) this._subCmdCode = v;
            return v;
        }

        // $D400-$D40F: Sub CPU I/O
        if (addr <= 0xD40F) {
            // $D400: Keyboard high byte (mirrors main CPU $FD00).
            if (addr === 0xD400) {
                return this.keyboard.readKeyUpper();
            }
            // $D401: Keyboard data (same as main CPU $FD01)
            if (addr === 0xD401) {
                return this.keyboard.readKeyData();
            }

            // $D406/$D407: sub-side level 1 kanji port (EX-series unit)
            if ((addr === 0xD406 || addr === 0xD407) && this.ex.features.subKanjiPort) {
                return this.ex.readSubKanji(addr);
            }

            // Sub-side ports of the main/sub interface: $D402, $D404, $D40A
            if (addr === 0xD402 || addr === 0xD404 || addr === 0xD40A) {
                return this._readSubInterfacePort(addr);
            }

            // Display/control I/O ($D402-$D40F)
            const result = this.display.readIO(addr);

            // Handle side effects that need fm7-level state
            if (result.sideEffect === 'beep') {
                // $D403 read: one single beep
                this._buzzerSingle();
            }

            return result.value;
        }

        // FM77AV: $D410-$D43F registers (HW manual 4.2). The rest of the I/O
        // area up to $D4FF has no register and reads $FF.
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            if (addr >= 0xD440) return 0xFF;
            // $D410-$D42B: ALU + line drawing registers
            if (addr <= 0xD42B) {
                const result = this.display.readIO(addr);
                return result.value;
            }
            // $D42C-$D42F: $D42E is the EX-series sub RAM bank (write only);
            // $D42F is the VRAM bank of the AV40 family
            if (addr <= 0xD42F) {
                if (addr === 0xD42E && this.ex.features.extSubRam) return 0xFF;
                const result = this.display.readIO(addr);
                return result.value;
            }
            // $D430 read: display and sub CPU status.
            if (addr === 0xD430) return this._composeStatus(D430_READ_BITS, D430_UNUSED_BITS);
            // $D431 / $D432: key encoder data and status
            if (addr === 0xD431) return this._encoderReplies.length > 0 ? this._encoderReplies.shift() : 0xFF;
            if (addr === 0xD432) return this._readEncoderStatus();
            // $D433, $D438-$D43F and $D434-$D437 read as $FF
            return 0xFF;
        }

        // FM77AV: Extended work RAM at $D500-$D7FF
        if (this.isFM77AV && addr >= 0xD500 && addr < SUB_ROM_BASE) {
            return this.display.workRamD500[addr - 0xD500];
        }

        // No register behind the rest of the I/O area (FM-7 $D410-$D7FF).
        if (addr < SUB_ROM_BASE) return 0xFF;

        // $D800-$FFFF while the sub runs from RAM ($FD13 bit 2): extended sub RAM
        if (this._activeSubMonitor === MONITOR_SUB_RAM) {
            return this.ex.readSubRam(addr);
        }

        // $D800-$DFFF: CG ROM (FM77AV) or Sub ROM (FM-7)
        if (addr < SUB_ROM_AV_BASE) {
            if (this.isFM77AV) {
                // old sub monitor: the FM-7 compatible sub ROM
                if (this._activeSubMonitor === MONITOR_OLD_SUB) {
                    return this.subROM[addr - SUB_ROM_BASE];
                }
                // new sub monitors: CG ROM with bank switching
                const cgAddr = this._characterGeneratorBank * 0x0800 + (addr - 0xD800);
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
            // old sub monitor: FM-7 compatible sub ROM
            if (this._activeSubMonitor === MONITOR_OLD_SUB) {
                return this.subROM[addr - SUB_ROM_BASE];
            }
            // new sub monitor for 640x200 or 320x200
            const rom = (this._activeSubMonitor === MONITOR_NEW_SUB_640) ? this.subROM_A : this.subROM_B;
            const romSize = (this._activeSubMonitor === MONITOR_NEW_SUB_640)
                ? (this._subROM_ASize || 0x2000)
                : (this._subROM_BSize || 0x2000);

            if (romSize > 0x2000) {
                // 10KB ROM: $E000-$FFFF portion
                return rom[addr - SUB_ROM_BASE];
            }
            // 8KB ROM: covers $E000-$FFFF
            return rom[addr - SUB_ROM_AV_BASE];
        }

        // FM-7: the sub ROM only
        return this.subROM[addr - SUB_ROM_BASE];
    }

    // =========================================================================
    // Sub CPU Memory Write ($0000-$FFFF)
    // =========================================================================

    _subWrite(addr, val) {
        addr &= 0xFFFF;
        val &= 0xFF;

        // Banked RAM over $C000-$CFFF
        if (addr >= 0xC000 && addr < 0xD000 &&
            this.ex.writeC000Bank(addr, val)) {
            return;
        }

        // $0000-$BFFF: VRAM + $C000-$D37F: Work RAM
        if (addr < 0xD380) {
            this.display.write(addr, val);
            return;
        }

        // Shared RAM, sub side
        if (addr <= SHARED_SUB_LAST) {
            this.sharedRam[addr - SHARED_SUB_FIRST] = val;
            return;
        }

        // $D400-$D40F: Sub CPU I/O
        if (addr <= 0xD40F) {
            // Keyboard ($D400-$D401) - writes ignored
            if (addr <= 0xD401) return;

            // $D406/$D407: sub-side level 1 kanji address (EX-series unit)
            if ((addr === 0xD406 || addr === 0xD407) && this.ex.features.subKanjiPort) {
                this.ex.writeSubKanji(addr, val);
                return;
            }

            // $D405 bit 0 (write): the sub CPU's VRAM access mode
            // (FM-77 and later). Reads return $FF.
            if (addr === 0xD405) {
                if (this.hasSubVramModeSelect) {
                    this.display.subVramFastAccess = (val & 0x01) !== 0;
                }
                return;
            }

            // $D40A write: BUSY flag to BUSY
            if (addr === 0xD40A) {
                this._busyToMain = true;
                return;
            }

            // Display/control I/O
            this.display.writeIO(addr, val);
            return;
        }

        // FM77AV: $D410-$D43F registers (HW manual 4.2); $D440-$D4FF ignored.
        if (this.isFM77AV && addr >= 0xD410 && addr < 0xD500) {
            if (addr >= 0xD440) return;
            // $D410-$D42B: ALU + line drawing registers
            if (addr <= 0xD42B) {
                this.display.writeIO(addr, val);
                return;
            }
            // $D42C-$D42F: $D42E (EX-series unit), $D42F
            if (addr <= 0xD42F) {
                // $D42E: bits 0-2 = extended sub RAM bank, bits 3-4 = banked $C000
                // RAM bank
                if (addr === 0xD42E && this.ex.features.extSubRam) {
                    this.ex.writeSubRamSelect(val);
                    return;
                }
                this.display.writeIO(addr, val);
                return;
            }
            // $D430 write: every field at once.
            if (addr === 0xD430) {
                for (const store of D430_WRITE_FIELDS) store(this, val);
                return;
            }
            // $D431: a byte to the key encoder
            if (addr === 0xD431) {
                this._encoderReceive(val);
                return;
            }
            // $D432: Key encoder status (read-only, writes ignored)
            // $D433: bit 0 keeps the picture on the screen on the machines
            // that have the register; $D438-$D43F: stored only
            if (addr === 0xD433 || addr >= 0xD438) {
                this.display.writeIO(addr, val);
                return;
            }
            // $D434-$D437: Other FM77AV registers
            return;
        }

        // FM77AV: Extended work RAM at $D500-$D7FF
        if (this.isFM77AV && addr >= 0xD500 && addr < SUB_ROM_BASE) {
            this.display.workRamD500[addr - 0xD500] = val;
            return;
        }

        // No register behind the rest of the I/O area (FM-7 $D410-$D7FF).
        if (addr < SUB_ROM_BASE) return;

        // $D800-$FFFF: ROM on the sub side; on the EX series the extended
        // sub RAM behind it takes writes while $FD04 bit 2 is set.
        this.ex.writeSubRam(addr, val);
    }

    // =========================================================================
    // Scheduler Wiring
    // =========================================================================

    _wireScheduler() {
        this.scheduler.setMainCPU(this.mainCPU);
        this.scheduler.setSubCPU(this.subCPU);

        // The machine's own run loop replaces the generic one.
        this.scheduler.runFor = (microseconds) => this._runFor(microseconds);

        // Main CPU TIMER interrupt.
        this.scheduler.addEvent('timer', MAIN_TIMER_PERIOD_US, () => {
            this._timerIRQ = true;
        });

        // Key encoder timing: auto repeat and the greeting.
        this.scheduler.addEvent('keyencoder', 10000, () => {
            this.keyboard.advanceTime(10000);
        });

        // Auto-type (TXT/BAS paste) pacing — driven by the emulation clock,
        // NOT the render loop.  Advancing on emulated time makes the input rate
        // independent of the host display refresh (60 vs 120/144 Hz) and of
        // whether frames are currently being rendered.  16667 µs = one 60 Hz
        // frame; the keyboard's gaps are also kept in emulated µs.
        // The release is held while the sub CPU is busy with a command that
        // does not read the keyboard (see _autoTypeHeld).
        this.scheduler.addEvent('autotype', 16667, () => {
            this.keyboard.advanceAutoType(16667, !this._autoTypeHeld());
        });

        // Vertical scan: walk FIELD_SEGMENTS. `_verticalBlanking` drives
        // DISP TIME ($FD12 bit 1 / $D430 bit 7) and `_inVsyncPulse` drives
        // VSYNC ($FD12 bit 0 / $D430 bit 2). A frame is counted when the
        // display part ends.
        this.scheduler.addEvent('vsync', FIELD_SEGMENTS[0].us, () => {
            const next = (this._fieldSegment + 1) % FIELD_SEGMENTS.length;
            const seg = FIELD_SEGMENTS[next];
            this._fieldSegment = next;
            this._verticalBlanking = seg.blanking;
            this._inVsyncPulse = seg.vsync;
            if (next === 1) this.display.frameCount++;
            const evt = this.scheduler.findEvent('vsync');
            if (evt) evt.restartWithPeriodUs(seg.us);
        });

        // Sub CPU NMI timer (50 Hz = 20ms, independent of VSync)
        this.scheduler.addEvent('subnmi', SUB_NMI_PERIOD_US, () => {
            // While the NMI mask ($D430 bit 7) is set, the 20ms NMI is not delivered.
            if (this.isFM77AV && this._nmiMaskSub) return;
            this._deliverSubNmi();
        });
    }

    // =========================================================================
    // Run loop
    // =========================================================================

    /**
     * Emulate the given time. Each main CPU instruction is timed by its bus
     * cycles; the devices and the event list advance by the same
     * master clock periods, and the sub CPU is then allowed the matching
     * share of its 2.016 MHz clock.
     *
     * @param {number} microseconds
     * @returns {number} master ticks actually run
     */
    _runFor(microseconds) {
        const sched = this.scheduler;
        const start = sched.elapsedTicks;
        const goal = start + usToTicks(microseconds);
        // Every pass moves the clock by at least one short bus cycle, so the
        // guard only catches a stalled loop, never a long request.
        let guard = Math.ceil((goal - start) / BUS_TICKS_FM7_MODE.short) + 16;
        // The machine type does not change during a run.
        const hasDma = this.hasDmaController;
        const cpu = this.mainCPU;
        const display = this.display, fdc = this.fdc, psg = this.psg, opn = this.opn, cmt = this.cmt;
        while (sched.elapsedTicks < goal && --guard > 0) {
            const bus = this._busTicks;
            // Who drives the main bus in this pass (MC6844 data sheet, Transfer
            // Modes, HALT burst): a
            // mode 3 channel that has begun its block keeps the main CPU
            // halted, so the pass is one idle E clock; otherwise the main
            // CPU runs one instruction.
            let cpuCycles = 1, ticks = bus.long;
            if (!(hasDma && this._dmacKeepsCpuHalted())) {
                cpuCycles = cpu.exec();
                ticks = cpu.instructionTicks(bus.short, bus.long);
                if (this._subWaitTicks !== 0) { ticks += this._subWaitTicks; this._subWaitTicks = 0; }
                if (ticks <= 0) ticks = bus.long;   // never stall the clock
            }

            // The same as _advanceDevices(ticks, cpuCycles), written out
            // here because it runs after every instruction.
            if (display.lineRemainingUs > 0) display.advanceLineEngine(ticks / TICKS_PER_US);
            fdc.step(ticks);
            psg.step(ticks);
            if (this._fmCardEnabled) opn.step(ticks, cpuCycles);
            cmt.step(ticks);
            if (this.mouseKind === 'bus') this._advanceMouseCard(ticks, cpuCycles);
            if (this._buzzerSingleTicks > 0) {
                this._buzzerSingleTicks -= ticks;
                if (this._buzzerSingleTicks <= 0) {
                    this._buzzerSingleTicks = 0;
                    this._refreshBuzzer();
                }
            }

            // The DMAC answers the requests standing after this pass.
            const heldTicks = hasDma ? this._dmacAfterPass(bus) : 0;
            this._checkAndAssertInterrupts();
            const passTicks = ticks + heldTicks;
            sched.elapsedTicks += passTicks;

            this._grantSubCycles(passTicks);
            if (this._haltWritten) this._takeHaltRequest();
            this._runSubCPU();
            sched.advanceEvents(passTicks);
        }
        // The FM samples of this run are made now (see OPN.step).
        opn.renderPendingSamples();
        return sched.elapsedTicks - start;
    }

    /** Advance every device that counts time by `ticks` master periods. */
    _advanceDevices(ticks, cpuCycles) {
        // Line engine BUSY time
        if (this.display.lineRemainingUs > 0) {
            this.display.advanceLineEngine(ticks / TICKS_PER_US);
        }
        this.fdc.step(ticks);
        this.psg.step(ticks);
        if (this._fmCardEnabled) this.opn.step(ticks, cpuCycles);
        this.cmt.step(ticks);
        this._advanceMouseCard(ticks, cpuCycles);
        if (this._buzzerSingleTicks > 0) {
            this._buzzerSingleTicks -= ticks;
            if (this._buzzerSingleTicks <= 0) {
                this._buzzerSingleTicks = 0;
                this._refreshBuzzer();
            }
        }
    }

    /**
     * Move the horizontal scan by `us` microseconds and update the
     * horizontal blanking flag; HSCAN_400 applies in 400-line mode.
     * The phase wraps by one subtraction when it passed the period less
     * than once: for a period T and T <= p < 2T, p - T is exact in floating
     * point and equals p % T, so the phase is the same as with the remainder.
     */
    _advanceHorizontalScan(us) {
        const t = this.display.displayMode === DISPLAY_MODE_400 ? HSCAN_400 : HSCAN_200;
        if (t !== this._scanTiming) {
            this._scanTiming = t;
            this._scanPhaseUs %= t.periodUs;
        }
        const period = t.periodUs;
        let phase = this._scanPhaseUs + us;
        if (phase >= period) phase = phase < 2 * period ? phase - period : phase % period;
        this._scanPhaseUs = phase;
        this._inHorizontalBlank = phase < t.blankUs;
    }

    /**
     * Whether the sub CPU runs only in the horizontal blanking now (HW manual
     * 8.4.2 (1)): in the FM-7 access mode (an FM-7, or an FM-77 with $D405
     * bit 0 = 0; the FM77AV family always uses the fast mode), during the
     * display period, while the sub CPU has VRAM access opened ($D409).
     */
    _subLimitedToBlanking() {
        const fm7AccessMode = !this.isFM77AV && !this.display.subVramFastAccess;
        const displayPeriod = !this._verticalBlanking;
        return fm7AccessMode && displayPeriod && this.display.vramAccessEnabled;
    }

    /**
     * Give the sub CPU the cycles of `ticks` master periods and move the beam
     * on. While the CRT holds the sub CPU, only the horizontal blanking at
     * the start of each line counts (the first 23.8 us of each 63.5 us
     * line; HW manual 8.6.1).
     */
    _grantSubCycles(ticks) {
        const us = ticks / TICKS_PER_US;
        let freeUs = us;
        if (this._subLimitedToBlanking()) {
            const t = this._scanTiming;
            freeUs = 0;
            let phase = this._scanPhaseUs, left = us;
            while (left > 0) {
                const edge = phase < t.blankUs ? t.blankUs : t.periodUs;
                const step = Math.min(left, edge - phase);
                if (phase < t.blankUs) freeUs += step;
                phase += step;
                left -= step;
                if (phase >= t.periodUs) phase -= t.periodUs;
            }
        }
        this._advanceHorizontalScan(us);
        this.scheduler.grantSubCycles(freeUs * TICKS_PER_US * SUB_CYCLES_PER_TICK);
    }

    /**
     * Let the sub CPU spend its earned cycles. Only the main CPU writes the
     * HALT request, so it does not change while the sub CPU runs here. The
     * CANCEL request is a level on the sub IRQ input: it is driven before
     * every sub instruction, so a taken IRQ is asked again while it stays.
     */
    _runSubCPU() {
        const sched = this.scheduler;
        const sub = this.subCPU;
        if (!sub) return;
        for (let guard = 999; guard > 0 && !sched.subHalted && sched.subCyclesPending > 0; guard--) {
            if (this._cancelLatch) sub.irqRequest = true;
            const cycles = sub.exec();
            sched.subCyclesPending -= cycles > 0 ? cycles : 2;
        }
    }

    /** Clock the mouse card's timer: external clock inputs (C1-C3) 19.2 kHz (FM-Techknow fig. 5-17), E = main CPU cycles. */
    _advanceMouseCard(ticks, cpuCycles) {
        if (this.mouseKind === 'bus') this.mouseCard.timer.advance(ticks, cpuCycles, MASTER_CLOCK_HZ);
    }

    // =========================================================================
    // Mouse
    // =========================================================================

    /** True when the machine has an OPN (FM77AV family, or the FM sound card). */
    _hasOpn() {
        return this.isFM77AV || this._fmCardEnabled;
    }

    /** Mouse card interrupt: timer composite flag, gated by $FD17 bit 2. */
    _mouseCardIrq() {
        return this.mouseKind === 'bus' && this._mouseIrqEnable && this.mouseCard.timer.interrupt;
    }

    /**
     * Connect a mouse: 'bus' (mouse set card), 'port1' / 'port2' (on a
     * joystick connector) or 'none'. Connecting starts the device afresh.
     */
    connectMouse(kind) {
        if (kind !== 'bus' && kind !== 'port1' && kind !== 'port2') kind = 'none';
        this.mouseKind = kind;
        this.mouseCard.reset();
        this.connectorMouse.reset();
        this.soundPorts.mice = [
            kind === 'port1' ? this.connectorMouse : null,
            kind === 'port2' ? this.connectorMouse : null,
        ];
    }

    /** Pointer movement in counts (1 count per host pixel); right and down positive. */
    moveMouse(dx, dy) {
        if (this.mouseKind === 'bus') this.mouseCard.move(dx | 0, dy | 0);
        else if (this.mouseKind !== 'none') this.connectorMouse.move(dx | 0, dy | 0);
    }

    /** Mouse button state. */
    pressMouseButtons(left, right) {
        this.mouseCard.setButtons(left, right);
        this.connectorMouse.setButtons(left, right);
    }

    // ==========================================================================
    // DMA controller HD6844
    // ==========================================================================
    // $FD98 selects an internal register ($00-$16, numbering of the MC6844
    // data sheet), $FD99 reads / writes it; the number does not advance.

    /** $FD99 read. Unused register numbers read $FF. */
    _readDmaRegister(num) {
        if (num < 0x10) {
            const ch = num >> 2;
            const word = (num & 0x02) ? this._dmaByteCount[ch] : this._dmaAddress[ch];
            return (num & 0x01) ? (word & 0xFF) : (word >> 8);
        }
        if (num <= 0x13) {
            // Channel control: reading clears DEND of that channel (and with
            // it the DEND IRQ flag it caused).
            const ch = num - 0x10;
            const v = this._dmaChannelCtl[ch];
            this._dmaChannelCtl[ch] = v & ~DMA_CH_DEND;
            return v;
        }
        if (num === 0x14) return this._dmaPriorityCtl;
        if (num === 0x15) return this._dmaInterruptCtl | (this._dmaIrqActive() ? 0x80 : 0);
        if (num === 0x16) return this._dmaChainCtl;
        return 0xFF;
    }

    /** $FD99 write. Read-only bits ignore writes. */
    _writeDmaRegister(num, val) {
        if (num < 0x10) {
            const ch = num >> 2;
            const regs = (num & 0x02) ? this._dmaByteCount : this._dmaAddress;
            regs[ch] = (num & 0x01) ? ((regs[ch] & 0xFF00) | val) : ((regs[ch] & 0x00FF) | (val << 8));
            return;
        }
        if (num <= 0x13) {
            const ch = num - 0x10;
            const keep = this._dmaChannelCtl[ch] & ~DMA_WRITABLE_CHANNEL_CTL;
            this._dmaChannelCtl[ch] = keep | (val & DMA_WRITABLE_CHANNEL_CTL);
            return;
        }
        if (num === 0x14) this._dmaPriorityCtl = val & DMA_WRITABLE_PRIORITY_CTL;
        else if (num === 0x15) this._dmaInterruptCtl = val & DMA_WRITABLE_INTERRUPT_CTL;
        else if (num === 0x16) this._dmaChainCtl = val & DMA_WRITABLE_CHAIN_CTL;
    }

    /** DEND IRQ: a channel with DEND whose DIE bit is set. */
    _dmaIrqActive() {
        for (let ch = 0; ch < 4; ch++) {
            if ((this._dmaChannelCtl[ch] & DMA_CH_DEND) && (this._dmaInterruptCtl & (1 << ch))) return true;
        }
        return false;
    }

    /** Transfer request (Tx RQ) of a channel: channel 0 = FDC DRQ. */
    _dmaRequest(ch) {
        return ch === 0 && this.fdc.drqFlag;
    }

    /**
     * Whether a channel in mode 3 (whole block) holds the main CPU: it has
     * accepted its first request (Busy) and its byte count is not yet 0.
     * The hold ends with the last byte or when RE is cleared (the main
     * reset clears every RE); a missing request does not end it.
     */
    _dmacKeepsCpuHalted() {
        for (let ch = 0; ch < 4; ch++) {
            const ctl = this._dmaChannelCtl[ch];
            const blockBusy = (ctl & (DMA_CH_BUSY | DMA_CH_MODE_BLOCK | DMA_CH_MODE_TSC))
                === (DMA_CH_BUSY | DMA_CH_MODE_BLOCK);
            if (blockBusy && this._dmaByteCount[ch] !== 0 && (this._dmaPriorityCtl & (1 << ch))) return true;
        }
        return false;
    }

    /**
     * The DMAC's part of a run loop pass: it serves the standing requests
     * (_dmacServeRequests). A byte moved in the HALT steal mode holds the
     * main bus for DMA_STOLEN_CYCLES_PER_BYTE E clocks, each counted at
     * the long bus cycle length; the devices go on through those E clocks.
     * A transfer is not an instruction, so no sub direct access wait is left.
     * Returns the master ticks the main bus was held.
     */
    _dmacAfterPass(bus) {
        const stolen = this._dmacServeRequests();
        this._subWaitTicks = 0;
        if (stolen === 0) return 0;
        const held = stolen * bus.long;
        this._advanceDevices(held, stolen);
        return held;
    }

    /**
     * Serve pending requests once per main CPU instruction (or per bus
     * cycle while a mode 3 channel holds the main CPU).
     * Returns the main CPU cycles lost in the HALT steal mode; a mode 3 channel
     * steals nothing here because the main CPU is not running at all.
     * The TSC modes never transfer: the machine's wiring has no TSC clock
     * control, so the bus is never granted to the controller that way.
     */
    _dmacServeRequests() {
        let stolen = 0;
        for (let ch = 0; ch < 4; ch++) {
            // A request (Tx RQ) is served when the channel is enabled (RE),
            // not in a TSC mode (no TSC on this machine) and has bytes left.
            if (!this._dmaRequest(ch)) continue;
            const ctl = this._dmaChannelCtl[ch];
            const enabled = (this._dmaPriorityCtl & (1 << ch)) !== 0 && !(ctl & DMA_CH_MODE_TSC);
            if (!enabled || this._dmaByteCount[ch] === 0) continue;
            this._dmaMoveByte(ch);
            if (!(ctl & DMA_CH_MODE_BLOCK)) stolen += DMA_STOLEN_CYCLES_PER_BYTE;
        }
        return stolen;
    }

    /** One byte on a channel. */
    _dmaMoveByte(ch) {
        let ctl = this._dmaChannelCtl[ch] | DMA_CH_BUSY;
        const count = (this._dmaByteCount[ch] - 1) & 0xFFFF;   // decremented as the transfer starts
        this._dmaByteCount[ch] = count;
        // The 16-bit address goes through the MMR like a main CPU access.
        const addr = this._dmaAddress[ch];
        if (ctl & DMA_CH_MEMORY_TO_DEVICE) {
            this.fdc.writeIO(0xFD1B, this._mainRead(addr));
        } else {
            this._mainWrite(addr, this.fdc.readIO(0xFD1B));
        }
        this._dmaAddress[ch] = (ctl & DMA_CH_ADDRESS_DOWN) ? addr - 1 : addr + 1;
        this.dmaTransferSeen = true;
        if (count === 0) {
            // Last byte: Busy drops; DEND is set only while the channel's
            // DIE bit is on at that moment.
            ctl &= ~DMA_CH_BUSY;
            if (this._dmaInterruptCtl & (1 << ch)) ctl |= DMA_CH_DEND;
            this._dmaChannelCtl[ch] = ctl;
            this._dmaChainReload(ch);
            return;
        }
        this._dmaChannelCtl[ch] = ctl;
    }

    /** Data chain: reload the chained channel from channel 3. */
    _dmaChainReload(ch) {
        const chain = this._dmaChainCtl;
        if (!(chain & 0x01)) return;
        const target = (chain >> 1) & 0x03;
        if (target === 0x03 || target !== ch) return;   // 11 is undefined
        this._dmaAddress[ch] = this._dmaAddress[3];
        this._dmaByteCount[ch] = this._dmaByteCount[3];
    }

    /**
     * DMAC reset by the main reset (MC6844 data sheet, Hardware Initialization):
     * every register except the address and byte count registers becomes 0.
     */
    _resetDmaController() {
        this._dmaChannelCtl.fill(0);
        this._dmaPriorityCtl = 0;
        this._dmaInterruptCtl = 0;
        this._dmaChainCtl = 0;
        this._dmaRegisterNumber = 0;
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

        // Key interrupt routed to the main CPU.
        if (this.keyboard.mainInterrupt) mainIrq = true;

        // FDC: INTRQ becomes a main CPU IRQ only while $FD02 bit 4 is 1 (0,
        // masked, after a reset).  Reading $FD18 clears irqFlag and the request.
        if (this._fdcIrqActive()) mainIrq = true;

        // OPN Timer IRQ: routed through $FD03 bit3 "extended interrupt".
        // The IRQ source is the OPN status
        // bits 0/1 (Timer A/B overflow). The program's IRQ handler clears
        // these by writing OPN register $27 with reset bits ($10/$20).
        // Edge-triggered latch: set on new OPN timer overflow, cleared
        // when no IRQ-enabled OPN timer flag remains. Reading $FD03 only
        // reports the latch and does not clear it.
        if (this._fmCardEnabled) {
            const opnActive = this.opn.irqAsserted;
            if (opnActive && !this._opnIrqPrev) this._opnIrqLatch = true;
            // Auto-clear when no IRQ-enabled timer flag remains.
            if (!opnActive) this._opnIrqLatch = false;
            this._opnIrqPrev = opnActive;
            if (this._opnIrqLatch) mainIrq = true;
        }

        // Mouse set card timer (extended interrupt).
        if (this._mouseCardIrq()) mainIrq = true;

        // DMA controller DEND IRQ, wired to the main IRQ
        if (this.hasDmaController && this._dmaIrqActive()) mainIrq = true;

        // Level-triggered: assert or de-assert IRQ based on current sources
        if (mainIrq) this.mainCPU.irq();
        else this.mainCPU.irqRequest = false;

        // Key interrupt routed to the sub CPU: its FIRQ.
        this.subCPU.firqRequest = this.keyboard.subInterrupt;

        // ATTENTION drives the main FIRQ as a level until $FD04 is read.
        if (this._attentionLatch) this.mainCPU.firq();
    }

    // =========================================================================
    // Main CPU <-> sub CPU interface
    // =========================================================================

    /**
     * $FD04 read. Bit 0 = ATTENTION, bit 1 = BREAK (0 = active),
     * bit 7 = the same BUSY line as $FD05 bit 7, bits 6-2 read 1
     * (HW manual 4.1). The read clears ATTENTION and drops the
     * FIRQ it drives (a held BREAK keeps its own request).
     */
    _readAttentionStatus() {
        const status = this._composeStatus(FD04_READ_BITS, FD04_UNUSED_BITS);
        this._acknowledgeAttention();
        return status;
    }

    /** Reading $FD04 takes the ATTENTION request; a held BREAK keeps the FIRQ. */
    _acknowledgeAttention() {
        if (!this._attentionLatch) return;
        this._attentionLatch = false;
        if (!this._breakKey) this.mainCPU.firqRequest = false;
    }

    /** A status byte: `unused` with each bit of `table` set while its test holds. */
    _composeStatus(table, unused) {
        let v = unused;
        for (const [bit, isOne] of table) if (isOne(this)) v |= bit;
        return v;
    }

    /**
     * $FD05 read. Bit 7 BUSY is 1 while the software busy flag is set, while
     * the sub CPU is stopped by HALT (BA = BS = 1), and from a taken HALT
     * until the sub CPU reads $D40A. Bits 6-1 read 1. Bit 0 EXTDET reads 0.
     */
    _readSubStatus() {
        return this._subBusyLine() ? 0xFE : 0x7E;
    }

    /** The BUSY line seen by the main CPU ($FD05 bit 7, $FD04 bit 7). */
    _subBusyLine() {
        return this._busyToMain || this._subStoppedByHalt || this._haltNotYetAnswered();
    }

    /**
     * $FD05 write. Bit 7 is the HALT request, latched
     * as written. Bit 6 = 1 latches the CANCEL IRQ request; writing 0 does
     * not clear it. Bits 5-0 (Z80 switch of the FM-7 family) are outside
     * this range.
     */
    _writeSubControl(val) {
        this._haltLatch = (val & 0x80) !== 0;
        this._haltWritten = true;
        if (val & 0x40) this._cancelLatch = true;
    }

    /**
     * Sub-side interface ports. All read $FF.
     *   $D402: CANCEL IRQ acknowledge
     *   $D404: ATTENTION to the main CPU (FIRQ)
     *   $D40A: busy flag to READY
     */
    _readSubInterfacePort(subIoReg) {
        if (subIoReg === 0xD402) {
            this._cancelLatch = false;
            this.subCPU.irqRequest = false;
        } else if (subIoReg === 0xD404) {
            this._attentionLatch = true;
            this.mainCPU.firq();
        } else {
            this._busyToMain = false;
            this._readySerial = ++this._ifaceSerial;
            this._subCmdCode = 0;   // auto-type pacing: the command has finished
        }
        return 0xFF;
    }

    /**
     * After a main instruction that wrote $FD05, before the sub CPU runs
     * again: the sub CPU runs only between main instructions, so it is at an
     * instruction boundary here (an interrupt entry counts as one). It stops
     * there, or resumes where it stopped (MC6809 data sheet, HALT).
     */
    _takeHaltRequest() {
        this._haltWritten = false;
        if (this._haltLatch === this._subStoppedByHalt) return;
        if (this._haltLatch) this._stopSubCpu();
        else this._resumeSubCpu();
    }

    /**
     * True when a HALT has been taken and the sub CPU has not read $D40A
     * since: $FD05 shows BUSY then (F-BASIC Kaiseki Manual, Phase III: the
     * hardware raises BUSY when the sub CPU takes a HALT).
     */
    _haltNotYetAnswered() {
        return this._haltTakenSerial > this._readySerial;
    }

    _stopSubCpu() {
        this._subStoppedByHalt = true;
        this._haltTakenSerial = ++this._ifaceSerial;
        this.scheduler.setSubHalted(true);
    }

    _resumeSubCpu() {
        this._subStoppedByHalt = false;
        this.scheduler.setSubHalted(false);
        // an NMI edge seen while stopped is serviced after resuming.
        if (this._subNmiSeenWhileStopped) {
            this._subNmiSeenWhileStopped = false;
            this.subCPU.nmi();
        }
    }

    /** 20 ms sub NMI tick: latched while the sub CPU is stopped. */
    _deliverSubNmi() {
        if (this._subStoppedByHalt) {
            this._subNmiSeenWhileStopped = true;
            return;
        }
        this.subCPU.nmi();
    }

    /**
     * $FD13 write. HW manual 8.6.5: every write resets the sub CPU and starts
     * the monitor chosen by bits 1-0. On the EX series bit 2 starts the
     * program in the extended sub RAM instead.
     */
    _writeSubMonitorSelect(val) {
        const fromRam = this.ex.features.extSubRam && (val & 0x04) !== 0;
        this._activeSubMonitor = fromRam ? MONITOR_SUB_RAM : MONITOR_BY_SUB_BANK[val & 0x03];
        this._restartSubSystem();
    }

    /**
     * Sub system reset by $FD13 (HW manual 8.6.3 calls it a reset of the sub
     * system). The sub I/O registers with a reset row in HW manual 4.2 take
     * that value; the $D430 RESET status becomes 1. Main
     * side registers and all memories keep their contents. A HALT request
     * still latched keeps the reset CPU stopped (MC6809 data sheet, HALT).
     */
    _restartSubSystem() {
        this.display.initForSubReset();   // $D408, $D409, $D40D, $D40E/$D40F, $D430 DB/AB/OA
        this._busyToMain = true;          // $D40A: BUSY
        this._haltTakenSerial = this._readySerial = this._ifaceSerial = 0;
        this._nmiMaskSub = false;         // $D430 bit 7
        this._characterGeneratorBank = 0; // $D430 bits 1-0
        this._subResetStatus = true;      // $D430 bit 0 (read)
        this._cancelLatch = false;
        this._subNmiSeenWhileStopped = false;
        this.subCPU.reset();
    }

    /** Power-on / reset button state of the interface. */
    _powerOnSubInterface() {
        this._haltLatch = false;
        this._haltWritten = false;
        this._subStoppedByHalt = false;
        this._cancelLatch = false;
        this._attentionLatch = false;
        this._busyToMain = true;          // BUSY until the sub monitor reads $D40A
        this._haltTakenSerial = this._readySerial = this._ifaceSerial = 0;
        this._subResetStatus = false;
        this._subNmiSeenWhileStopped = false;
        this._activeSubMonitor = MONITOR_OLD_SUB;
        this._subCmdCode = 0;
    }

    /**
     * Auto-type hold: true while the next queued key must NOT be released.
     *
     * A key released while the sub CPU is busy with a long console command
     * (other than a key read: GET $04 / INKEY $29 / GRAPHIC CURSOR $1F) can
     * be dropped, so the release is held until something is waiting for it.
     * Nothing is held when keys are routed to the main CPU IRQ, when the sub
     * CPU is idle or halted, or when the command byte is not known.
     *
     * @returns {boolean}
     */
    _autoTypeHeld() {
        if (this.keyboard.interruptToMain) return false;    // keys go to the main CPU IRQ
        if (this._subStoppedByHalt || !(this._busyToMain || this._haltNotYetAnswered())) return false;
        const cmd = this._subCmdCode;                        // code fetched from $D382 for this BUSY period
        if (cmd === 0x00) return false;
        return cmd !== 0x04 && cmd !== 0x29 && cmd !== 0x1F;
    }

    // =========================================================================
    // Keyboard Wiring
    // =========================================================================

    _wireKeyboard() {
        // The key interrupt is a level; _checkAndAssertInterrupts follows it.
        // Poke the CPU at once so that it notices quickly.
        this.keyboard.onMainInterrupt = () => this.mainCPU.irq();
        // The greeting ends with one single beep.
        this.keyboard.onSingleBeep = () => this._buzzerSingle();
    }


    /**
     * BREAK key press (physical or virtual keyboard).
     * Asserts main CPU FIRQ; in scan code mode the encoder also sends the
     * BREAK make code (nothing in ASCII mode).
     */
    pressBreak() {
        this._breakKey = true;
        this.mainCPU.firq();
        this.keyboard.breakKeyEvent(true);
    }

    /**
     * BREAK key release (physical or virtual keyboard).
     * In scan code mode the encoder also sends the BREAK break code
     * (only when the key was down, so a stray release sends nothing).
     */
    releaseBreak() {
        const wasDown = this._breakKey;
        this._breakKey = false;
        if (wasDown) this.keyboard.breakKeyEvent(false);
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
        // The FDC interrupt is evaluated by the common check (_checkAndAssertInterrupts).
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
        const len = Math.min(src.length, BASIC_ROM_BYTES);
        this.fbasicROM.set(src.subarray(0, len));
        this.romLoaded.fbasic = true;
        this._refreshMainPages();
        console.log(`BASIC ROM loaded: ${len} bytes`);
    }

    /**
     * Load Boot ROM ($FE00-$FFFF, 512 bytes)
     * @param {ArrayBuffer} data
     */
    loadBootROM(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, BOOT_LOADER_BYTES);
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
        const len = Math.min(src.length, BOOT_LOADER_BYTES);
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
        this._refreshMainPages();
        console.log(`Initiator ROM loaded: ${len} bytes`);
    }

    /**
     * Load the new sub monitor ROM for 640x200 (FM77AV, 8KB or 10KB image)
     * @param {ArrayBuffer} data
     */
    loadSubROM_A(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.subROM_A.length);
        this.subROM_A.set(src.subarray(0, len));
        this._subROM_ASize = src.length;
        this.romLoaded.subA = true;
        console.log(`New sub monitor ROM (640x200) loaded: ${len} bytes`);
    }

    /**
     * Load the new sub monitor ROM for 320x200 (FM77AV, 8KB or 10KB image)
     * @param {ArrayBuffer} data
     */
    loadSubROM_B(data) {
        const src = new Uint8Array(data);
        const len = Math.min(src.length, this.subROM_B.length);
        this.subROM_B.set(src.subarray(0, len));
        this._subROM_BSize = src.length;
        this.romLoaded.subB = true;
        console.log(`New sub monitor ROM (320x200) loaded: ${len} bytes`);
    }

    /**
     * Load the level 2 kanji ROM (128KB, read through $FD2C-$FD2F).
     * @param {ArrayBuffer} data
     */
    loadKanji2ROM(data) {
        const len = this.ex.loadKanji2(data);
        this.romLoaded.kanji2 = true;
        console.log(`Kanji2 ROM loaded: ${len} bytes`);
    }

    /**
     * Load the dictionary ROM (256KB, 4KB banks in the $2E000 window).
     * @param {ArrayBuffer} data
     */
    loadDicromROM(data) {
        const len = this.ex.loadDictionary(data);
        this.romLoaded.dicrom = true;
        console.log(`DICROM loaded: ${len} bytes (${Math.floor(len / 0x1000)} banks)`);
    }

    /**
     * Load the extended sub ROM (48KB, 4KB banks in the $2E000 window).
     * @param {ArrayBuffer} data
     */
    loadExtSubROM(data) {
        const len = this.ex.loadExtSub(data);
        this.romLoaded.extsub = true;
        console.log(`EXTSUB.ROM loaded: ${len} bytes (${Math.ceil(len / 0x1000)} banks)`);
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
        this.kanjiROM.fill(0xFF);
        this.ex.clearRoms();
        this._initiateROMSize = 0;
        this._subROM_ASize = 0;
        this._subROM_BSize = 0;
        this._kanjiSize = 0;
        for (const k of Object.keys(this.romLoaded)) this.romLoaded[k] = false;
        this._refreshMainPages();
    }

    // =========================================================================
    // Machine Type
    // =========================================================================

    /**
     * Every device that measures time is fed master clock periods;
     * tell them the rate once.
     */
    _installTickRate() {
        FDC.setTickRate(MASTER_CLOCK_HZ);
        this.opn.setTickRate(MASTER_CLOCK_HZ);
        this.psg.setTickRate(MASTER_CLOCK_HZ);
    }

    /**
     * Choose the boot mode ('basic' or 'dos') as an explicit selection, used
     * by the next reset() on every machine.
     * @param {'basic'|'dos'} mode
     */
    setStartupSystem(mode) {
        this._startupSystemChoice = (mode === 'dos') ? 'dos' : 'basic';
        this._startupSystemChosen = true;
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
        this._setModel(type);
        // Per-machine features are answered by the capability getters.
        const isAV = this.isFM77AV;
        const isAV40 = this.isAV40;
        // Drive-mode switching is available on machines with 2DD support;
        // every machine starts in 2D mode.
        this.fdc.supportsDriveModeSwitch = this.supports2DD;
        this.fdc.driveModeIs2dd = false;
        this._selectBusCycleLengths();
        this.opn.setAVMode(isAV);
        // FM77AV has OPN built-in; always enable FM sound
        if (isAV) this._fmCardEnabled = true;
        // Extended RAM: up to physical $6FFFF on the AV40 / AV40EX, $2FFFF otherwise.
        this._physicalRam = new Uint8Array(isAV40 ? PHYSICAL_RAM_BYTES : 0x30000);
        this._applyDisplayFeatures();
        // EX-series extensions for this machine (power-on state).
        this.ex.setMachine(type);
        this._refreshSubPages();
        console.log(`Machine type set to: ${type}`);
    }

    /**
     * Tell the display what this machine carries: VRAM banks of 48KB, the
     * logic unit / line engine, and the 640x400 and 262,144-color modes of
     * the AV40 family.
     * The FM77AV20EX has neither.
     */
    _applyDisplayFeatures() {
        let banks = 1;
        if (this.isAV40) banks = 4;
        else if (this.isFM77AV) banks = 2;
        this.display.setMachineFeatures({
            logicUnit: this.isFM77AV, banks, color262k: this.isAV40, line400: this.isAV40,
        });
    }

    /**
     * Pick the main CPU bus cycle lengths: the MMR or
     * text window in use selects 625 / 875 ns, otherwise 500 / 750 ns.
     * $FD95 bit 3 (high-speed mode) does not change them.
     */
    _selectBusCycleLengths() {
        const mapped = this.hasMMR && (this._mappingOn || this._windowOn);
        this._busTicks = mapped ? BUS_TICKS_MMR_MODE : BUS_TICKS_FM7_MODE;
    }

    /**
     * Record the machine type and the flags the run loop asks for on every
     * instruction (isFM77AV, isAV40, hasDmaController). They are worked out
     * here once instead of on each call; the model changes only through
     * this method.
     */
    _setModel(type) {
        this._model = type;
        this._isFM77AV = type !== MACHINE_FM7 && type !== MACHINE_FM77;
        this._isAV40 = type === MACHINE_FM77AV40 || type === MACHINE_FM77AV40EX;
        this._hasDmaController = type === MACHINE_FM77AV20EX || this._isAV40;
        this._refreshMainPages();
        this._refreshSubPages();
    }

    /**
     * @returns {boolean} true if FM77AV series.
     *
     * The FM-7 and FM-77 are excluded. Features the FM-77 shares with the AV
     * family use `hasMMR` / `hasSubVramModeSelect`.
     */
    get isFM77AV() {
        return this._isFM77AV;
    }

    /** @returns {boolean} true if FM77AV40 or FM77AV40EX */
    get isAV40() {
        return this._isAV40;
    }

    /** @returns {boolean} true if FM77AV40EX (the machine with the extended sub ROM) */
    get isAV40EX() {
        return this._model === MACHINE_FM77AV40EX;
    }

    /** @returns {boolean} true if FM77AV20 or FM77AV20EX */
    get isAV20() {
        return this._model === MACHINE_FM77AV20 || this._model === MACHINE_FM77AV20EX;
    }

    // ---- Capability flags (machine → feature mapping in one place) ----

    /**
     * MMR and window (HW manual 8.1) present: FM-77 and every later machine.
     *
     * The FM-7 has neither.  Everything the FM-77 shares with the FM77AV
     * family — the $FD80-$FD93 register file, address translation, and the
     * extra bus waits that drop the effective main clock while paging is on
     * — is gated on this rather than on isFM77AV, so the FM-77 gets the
     * common part without inheriting the AV-only extensions.
     */
    get hasMMR() {
        return this._model !== MACHINE_FM7;
    }

    /**
     * $D405 bit 0 selects the sub CPU's VRAM access mode:
     * FM-77 and later. The FM-7 has no such register.
     */
    get hasSubVramModeSelect() {
        return this._model !== MACHINE_FM7;
    }

    /** 2DD drive-mode switch ($FD1E) wired: AV20/AV20EX/AV40/AV40EX */
    get supports2DD() {
        return this.isAV20 || this.isAV40;
    }

    /** DMA controller HD6844 present: AV20EX/AV40/AV40EX */
    get hasDmaController() {
        return this._hasDmaController;
    }

    /** Catalogue main RAM size in KB (base configuration). */
    get mainRamKB() {
        if (!this.isFM77AV) return 64;      // FM-7 / FM-77
        return this.isAV40 ? 192 : 128;     // AV/AV20/AV20EX = 128, AV40 family = 192
    }

    /**
     * Catalogue VRAM size in KB, shown in the header like mainRamKB. The
     * emulation may carry more banks than this (see _applyDisplayFeatures).
     */
    get vramKB() {
        if (!this.isFM77AV) return 48;                         // 16KB x 3 planes
        if (this._model === MACHINE_FM77AV40EX) return 192;
        if (this._model === MACHINE_FM77AV40) return 144;
        return 96;                                             // AV / AV20 / AV20EX
    }

    /**
     * Enable/disable FM sound card (OPN + joystick port).
     * The FM77AV family always has the OPN built-in; on the FM-7 / FM-77
     * this setting applies.
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
    // OPN command and data ports
    //
    // $FD15/$FD16 (and the FM77AV's $FD0D/$FD0E) go through these. The
    // register number and data are handed to the OPN; registers $00-$0F are
    // also kept here for read-back and for the I/O port model.
    // =========================================================================

    /**
     * $FD15 write: the low 4 bits are the command, carried out
     * when it is written.
     */
    _opnCommandWrite(val) {
        const cmd = val & 0x0F;
        this._opnCommand = cmd;
        if (cmd === 0x03) {
            this._opnRegisterNo = this._opnDataLatch;
            this.opn.selectAddress(this._opnRegisterNo);
        } else if (cmd === 0x02) {
            this._opnRegisterWrite(this._opnRegisterNo, this._opnDataLatch);
        }
    }

    /** Hand a register write to the OPN and to the I/O port model. */
    _opnRegisterWrite(reg, val) {
        this.opn.writeReg(reg, val);
        if (reg < 0x10) {
            this._ssgRegisters[reg] = val;
            this.soundPorts.write(reg, val, ticksToUs(this.scheduler.elapsedTicks));
        }
    }

    /** $FD16 write: kept for the next $03 / $02 command. */
    _opnDataWrite(val) {
        this._opnDataLatch = val & 0xFF;
    }

    /** $FD16 read: what the last command selected. */
    _opnDataRead() {
        switch (this._opnCommand) {
            case 0x01: return this._ssgRegisterRead(this._opnRegisterNo);
            case 0x04: return this.opn.readStatus();
            case 0x09: return this.soundPorts.readPortA();
            default:   return 0xFF;   // inactive: the bus floats high
        }
    }

    /** Register read through command $01: $00-$0F only. */
    _ssgRegisterRead(reg) {
        if (reg === 0x0E) return this.soundPorts.readPortA();
        if (reg === 0x0F) return this.soundPorts.portBPins();
        if (reg < 0x10) return this._ssgRegisters[reg];
        return 0xFF;
    }

    // =========================================================================
    // Disk Loading
    // =========================================================================

    /**
     * Load a D77 disk image into a drive.
     * @param {number} driveNum - Drive number (0-3)
     * @param {ArrayBuffer} data - Disk image data
     * @param {number} [slotIndex=0] - Disk to put in the drive when the image
     *        holds several disks (see FDC.loadDisk)
     * @returns {boolean} success
     */
    loadDisk(driveNum, data, slotIndex = 0) {
        return this.fdc.loadDisk(driveNum, data, slotIndex);
    }

    /**
     * Load a T77 tape image.
     * @param {ArrayBuffer} data - T77 file data
     * @returns {boolean} success
     */
    loadTape(data) {
        return this.cmt.mountT77(data);
    }

    /**
     * Load a WAV file as cassette media (CAS:).
     * @param {ArrayBuffer} data - WAV file data
     * @returns {boolean} success
     */
    loadTapeWAV(data) {
        return this.cmt.mountWave(data);
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
     * Boot mode follows the machine mode setting ('basic' or 'dos'); on the
     * FM77AV family, until a mode is chosen explicitly, it follows whether a
     * disk is present in drive 0. BASIC mode boots from disk and falls back
     * to BASIC when no bootable disk is present; DOS mode requires a bootable
     * disk.
     */
    reset() {
        // Select the boot mode for the current machine.
        const hasDisk = this.fdc.disks[0] && this.fdc.disks[0].loaded;
        const startupSystem = (this.isFM77AV && !this._startupSystemChosen)
            ? (hasDisk ? 'dos' : 'basic')
            : ((this._startupSystemChoice === 'dos') ? 'dos' : 'basic');
        this._startupSystem = startupSystem;

        // Clear main RAM. The shared RAM keeps its contents.
        this.mainRAM.fill(0x00);
        this._subWaitTicks = 0;

        // Reset I/O state
        this._powerOnSubInterface();
        this._breakKey    = false;
        this._timerIRQ    = false;
        this._irqMaskReg  = 0;
        // Buzzer: continuous off, single beep stopped.
        this._buzzerContinuous = false;
        this._buzzerSingleTicks = 0;
        this._refreshBuzzer();

        // Mouse devices restart; the connection itself is kept.
        this._mouseIrqEnable = true;
        this.mouseCard.reset();
        this.connectorMouse.reset();
        // A reset selects the BASIC ROM.
        // IPL/program code disables it via write to $FD0F when needed.
        this._upperSpaceIsRom = true;
        this._fbasicWarnShown = false;

        // OPN bus interface and I/O ports
        this._opnCommand = 0;
        this._opnDataLatch = 0;
        this._opnRegisterNo = 0;
        this._ssgRegisters.fill(0);
        this.soundPorts.reset();

        // EX-series registers return to $00; their memories are kept (exseries.js)
        this.ex.resetRegisters();

        // FM77AV specific reset
        if (this.isFM77AV) {
            this._initiatorActive = false; // Set before boot path logic overrides it
            this._characterGeneratorBank = 0;
            this._nmiMaskSub = false;
            this._inVsyncPulse = false;
            this._fieldSegment = 0;
            this._verticalBlanking = false;
            this._inHorizontalBlank = true;   // Blanking active at power-on
            this._analogPaletteAddr = 0;
            this._palette4096.fill(0);
            this._resetMemoryManagement();
            this._resetDmaController();
            // Banked $C000 RAM contents
            this.ex.clearC000BankRam();
            // Share analog palette reference with display
            this.display.palette4096 = this._palette4096;
            this._applyDisplayFeatures();
            // Reset the key code format to the default (ASCII-style, no
            // break codes).
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._encoderCodeMode = 0;
        } else {
            this._initiatorActive = false;
            this._characterGeneratorBank = 0;
            // Clear FM77AV state that may linger from a previous AV session
            this._nmiMaskSub = false;
            this._inVsyncPulse = false;
            this._fieldSegment = 0;
            this._inHorizontalBlank = true;
            this._analogPaletteAddr = 0;
            this._palette4096.fill(0);
            this._resetMemoryManagement();
            this._resetDmaController();
            this.display.palette4096 = null;
            this._applyDisplayFeatures();
            // FM-7 / FM-77: 9-bit key codes (no scan codes), no break codes
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
        this.scheduler.restartClock();
        this._encoderReplies.length = 0;
        this._encoderCommand.length = 0;
        this._encoderByteUnacknowledged = false;
        this._encoderStatusUnread = false;
        this._scanPhaseUs = 0;

        // Re-apply keyboard mode after component reset (components may clear it)
        // Default = 9-bit key codes. Programs switch through $D431.
        if (this.isFM77AV) {
            this.keyboard._enableBreakCodes = false;
            this.keyboard._useScanCodes = false;
            this._encoderCodeMode = 0;
        }

        // =====================================================================
        // Boot preparation: initialize hardware state, set the memory map of
        // the boot area, then let the main CPU fetch its restart address.
        // =====================================================================

        // Initialize the FDC for BASIC boot.
        if (startupSystem === 'basic') {
            this._initFDCPorts();
        }

        // Reset sub CPU — it reads its own reset vector from sub ROM
        this.subCPU.reset();
        // The sub CPU NMI mask (_nmiMaskSub) was cleared above; software sets
        // or clears it via $D430 bit 7.
        this.scheduler.setSubHalted(false);

        // Memory map at reset. The main CPU then fetches its restart address
        // through that map (MC6809 data sheet, RESET), so nothing is copied
        // into RAM here.
        //   FM-7 / FM-77: the boot ROM picked by the mode switch answers
        //     $FE00-$FFDF, and $FFFE/$FFFF give the fixed restart address
        //     $FE00 (FM-7 User's Manual System Specification 1.2.2).
        //   FM77AV family: the initiator ROM answers $6000-$7FFF and
        //     $FFFE/$FFFF (HW manual 3.1); it places the boot program in
        //     the RAM at $FE00-$FFDF itself.
        this._initiatorActive = this.isFM77AV && this.romLoaded.initiate;
        this._standInBootShown = this.isFM77AV && !this.romLoaded.initiate;
        if (this._standInBootShown) {
            console.error('[BOOT] FM77AV requires INITIATE.ROM. Using the stand-in boot map.');
        } else if (this._initiatorActive) {
            console.log('[BOOT] FM77AV: starting the initiator');
        }
        this.mainCPU.reset();

        // Log boot info (single line to keep the console quiet)
        console.log(
            `${this._model.toUpperCase()} reset: boot=${startupSystem}`
        );

        // Reset clears the MMR and window: back to the FM-7 mode bus cycles.
        this._selectBusCycleLengths();
    }

    /**
     * FDC initialization for BASIC boot: bring the FDC to its initial state.
     */
    _initFDCPorts() {
        this.fdc.reset();
    }

    /**
     * The boot ROM that answers reads of $FE00-$FFDF, or null for RAM.
     *  - FM-7 / FM-77: the ROM selected by the mode switch (FM-7 User's
     *    Manual System Specification 1.2.2; FM-Techknow 1-5). In BASIC mode
     *    without the BASIC boot ROM the DOS boot ROM is shown; in DOS mode
     *    without the DOS boot ROM the RAM answers.
     *  - FM77AV family: RAM (HW manual 3.1), except under the stand-in map
     *    used when no initiator ROM is loaded: in DOS mode the DOS boot ROM
     *    is shown in place of the program the initiator would have placed.
     * @returns {Uint8Array|null}
     */
    _bootAreaRom() {
        if (this.isFM77AV) {
            if (this._standInBootShown && this._startupSystem === 'dos' && this.romLoaded.boot) {
                return this.bootROM;
            }
            return null;
        }
        if (this._startupSystem === 'basic' && this.romLoaded.bootBas) return this.bootBasROM;
        if (this.romLoaded.boot) return this.bootROM;
        return null;
    }

    /**
     * The address the hardware supplies at $FFFE/$FFFF, or -1 when the RAM
     * answers. (The initiator ROM case is handled before this, in _mainRead.)
     *  - FM-7 / FM-77: fixed at $FE00 (System Specification 1.2.2). With no
     *    boot ROM for BASIC mode, the BASIC ROM's own start address is used
     *    instead so that BASIC still comes up.
     *  - FM77AV family: RAM, except under the stand-in map (no initiator
     *    ROM), which gives $FE00 in DOS mode and the BASIC ROM's start
     *    address in BASIC mode.
     * @returns {number}
     */
    _restartAddress() {
        if (this.isFM77AV) {
            if (!this._standInBootShown) return -1;
            return (this._startupSystem === 'dos') ? RESTART_ADDRESS : this._basicStartAddress();
        }
        if (this._startupSystem === 'basic' && !this.romLoaded.bootBas) return this._basicStartAddress();
        return RESTART_ADDRESS;
    }

    /**
     * Start address held in the last two bytes of the BASIC ROM ($FBFE/$FBFF),
     * or $FE00 when the ROM is missing or the value is plainly unset
     * ($0000 or $FFFF).
     * @returns {number}
     */
    _basicStartAddress() {
        if (!this.romLoaded.fbasic) return RESTART_ADDRESS;
        const start = (this.fbasicROM[BASIC_ROM_BYTES - 2] << 8) | this.fbasicROM[BASIC_ROM_BYTES - 1];
        return (start === 0x0000 || start === 0xFFFF) ? RESTART_ADDRESS : start;
    }

    // =========================================================================
    // Emulation Loop
    //   The frame loop (timing source, display presentation, audio start on
    //   user gesture) belongs to the host: see FM7Browser in
    //   fm7_browser.js (browser UI). Headless use drives the machine
    //   with scheduler.runFor(us) directly.
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
            model: this._model,
            startupSystem: this._startupSystem,
            subCpuStopped: this._subStoppedByHalt,
            mainCpuPc: this.mainCPU.pc || 0,
            subCpuPc: this.subCPU.pc || 0,
            romsLoaded: { ...this.romLoaded },
            diskLoaded: [
                this.fdc.disks[0] !== null,
                this.fdc.disks[1] !== null,
                this.fdc.disks[2] !== null,
                this.fdc.disks[3] !== null,
            ],
            // FM77AV specific
            initiatorActive: this._initiatorActive,
            subMonitor: this._activeSubMonitor,
            // FDC status
            floppy: {
                busy: (this.fdc.statusReg & 0x01) !== 0,      // status bit 0
                touchedSincePoll: this.fdc.accessLatch,        // the UI clears it after reading
                motorRunning: this.fdc.motorRunning,
                drive: this.fdc.currentDrive,
                headCylinder: this.fdc.headPosition[this.fdc.currentDrive],
                sectorRegister: this.fdc.sectorReg,
                phase: this.fdc.state,
            },
        };
    }


    // =========================================================================
    // Gamepad Polling
    // =========================================================================

    // FM-7 joystick is read via OPN ($FD15/$FD16) Port A/B only.
    // PSG ($FD0D/$FD0E) does not provide joystick input on FM-7.

    /**
     * Assign a host gamepad to joystick connector 1 or 2 (0 / 1).
     * @param {number} fmPort - 0 for J1, 1 for J2
     * @param {number|null} gamepadIndex - host gamepad index, or null
     */
    setJoystickAssignment(fmPort, gamepadIndex) {
        this.joystickHostIndex[fmPort & 1] = (gamepadIndex == null) ? null : (gamepadIndex | 0);
    }

    /**
     * Set the switches of the joystick on a connector.
     * @param {number} fmPort - 0 for J1, 1 for J2
     * @param {object|number} buttons - {up, down, left, right, trigger1,
     *   trigger2} booleans, or an active-low byte (bit 0 up, 1 down, 2 left,
     *   3 right, 4 trigger 1, 5 trigger 2; $FF = nothing pressed)
     */
    setJoystickState(fmPort, buttons) {
        if (fmPort !== 0 && fmPort !== 1) return;
        let lines = 0xFF;
        if (typeof buttons === 'number') {
            lines = buttons & 0xFF;
        } else if (buttons) {
            const names = ['up', 'down', 'left', 'right', 'trigger1', 'trigger2'];
            names.forEach((n, bit) => { if (buttons[n]) lines &= ~(1 << bit); });
        }
        this.soundPorts.joystickSwitches[fmPort] = lines;
    }

    /** Release the joystick on one connector, or on both when no port is given. */
    clearJoystickState(fmPort) {
        if (fmPort === 0 || fmPort === 1) this.soundPorts.joystickSwitches[fmPort] = 0xFF;
        else this.soundPorts.joystickSwitches.fill(0xFF);
    }

    // =========================================================================
    // Key encoder commands (HW manual 4.2 $D431 / $D432)
    // =========================================================================

    /**
     * $D432: bit 7 LATCH (0 = a byte can be read from $D431), bit 0 ACK
     * (0 = the last byte sent is not taken yet), the other bits 1. The
     * encoder takes a byte by the time the sub CPU looks again: ACK reads 0
     * on the first status read after a byte is sent and 1 after that.
     * Reading it also satisfies the handshake between command bytes.
     */
    _readEncoderStatus() {
        let v = 0xFF;
        if (this._encoderReplies.length > 0) v &= ~0x80;
        if (this._encoderByteUnacknowledged) {
            v &= ~0x01;
            this._encoderByteUnacknowledged = false;
        }
        this._encoderStatusUnread = false;
        return v;
    }

    /**
     * A byte written to $D431. The first byte of a command is its number;
     * ENCODER_TABLE gives how many PARAM bytes follow it and what it does
     * once they are all in. An unknown number ends with its own byte.
     */
    _encoderReceive(val) {
        const cmd = this._encoderCommand;
        this._encoderByteUnacknowledged = true;
        // Handshake (hwStrict.keyEncHandshake): a later byte of a command sent
        // without reading $D432 in between abandons the command.
        if (this.hwStrict.keyEncHandshake && cmd.length > 0 && this._encoderStatusUnread) {
            this._hwWarn('keyenc-handshake',
                `key-encoder byte $${val.toString(16).padStart(2,'0')} sent without polling $D432 ENCSTA; command aborted`);
            cmd.length = 0;
            this._encoderStatusUnread = false;
            return;
        }
        cmd.push(val);
        this._encoderStatusUnread = true;
        const spec = ENCODER_TABLE[cmd[0]];
        if (spec) {
            const p = spec.param;
            // $80 needs its first PARAM byte before its length is known.
            const params = typeof p === 'number' ? p : cmd.length < 2 ? 1 : p(cmd[1]);
            if (cmd.length < 1 + params) return;
            spec.act(this, cmd.slice(1));
        }
        cmd.length = 0;
        this._encoderStatusUnread = false;
    }

    /** Select the key code mode: 2 = scan codes with break codes, else 9-bit codes. */
    _encoderSetCodeMode(mode) {
        const scan = mode === 0x02;
        this.keyboard._useScanCodes = scan;
        this.keyboard._enableBreakCodes = scan;
        this._encoderCodeMode = mode;
        this.keyboard.stopGreeting();
    }

    /**
     * Clock reply: the 13 digits of the READ RTC return (FM-Techknow 5-4-1,
     * figure 5-21) two to a byte, upper digit first: year, month, day (the
     * tens digit carries the leap year select in bits 3-2), weekday, hour
     * (the tens digit carries 24-hour select in bit 3 and PM in bit 2),
     * minute, second; the low half of the last byte is 0.
     */
    _encoderReplyClock() {
        const now = new Date();
        const year = now.getFullYear();
        // Leap year select (bits 3-2 of the day tens digit): FM-Techknow 5-4-1,
        // READ RTC (figure 5-21), D10: 00 when year mod 4 = 0, 01 when 3,
        // 10 when 2, 11 when 1.
        const leapSelect = (4 - (year % 4)) % 4;
        const digits = [
            Math.floor((year % 100) / 10), year % 10,
            Math.floor((now.getMonth() + 1) / 10), (now.getMonth() + 1) % 10,
            (leapSelect << 2) | Math.floor(now.getDate() / 10), now.getDate() % 10,
            now.getDay(),
            0x08 | Math.floor(now.getHours() / 10), now.getHours() % 10,  // 24-hour clock
            Math.floor(now.getMinutes() / 10), now.getMinutes() % 10,
            Math.floor(now.getSeconds() / 10), now.getSeconds() % 10,
            0,
        ];
        for (let i = 0; i < digits.length; i += 2) this._encoderReplies.push((digits[i] << 4) | digits[i + 1]);
    }

    // =========================================================================
    // Buzzer
    // =========================================================================

    /**
     * $FD03 write, the buzzer register (FM-7 User's Manual System
     * Specification 1.2.3): bit 7 continuous buzzer, bit 6 single buzzer
     * (each write with it set starts one beep), bit 0 tape sound to the
     * speaker. The buzzer output is then decided from the new state.
     */
    _writeBuzzerRegister(val) {
        this._buzzerContinuous = (val & 0x80) !== 0;
        this._cassetteToSpeaker = (val & 0x01) !== 0;
        if ((val & 0x40) !== 0) this._buzzerSingleTicks = usToTicks(SINGLE_BEEP_US);
        this._refreshBuzzer();
    }

    /** Start (or restart) the single beep: about 0.2 s. */
    _buzzerSingle() {
        this._buzzerSingleTicks = usToTicks(SINGLE_BEEP_US);
        this._refreshBuzzer();
    }

    /** The buzzer sounds while the continuous buzzer or a single beep is on. */
    _refreshBuzzer() {
        const on = this._buzzerContinuous || this._buzzerSingleTicks > 0;
        if (on === this._buzzerSounding) return;
        this._buzzerSounding = on;
        this.buzzerOutput(on);
    }

    /**
     * Host hook: start or stop the buzzer tone (BUZZER_TONE_HZ). The core
     * has no sound output of its own.
     * @param {boolean} on
     */
    buzzerOutput(on) { // eslint-disable-line no-unused-vars
    }
}
