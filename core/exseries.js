// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// Extensions of the FM77AV20EX / FM77AV40 / FM77AV40EX.
//
// The unit owns the registers and memories that these machines add on top of
// the FM77AV: the wide MMR switch ($FD94), mode register 2 ($FD95), the ROM
// window and learning RAM in the $2xxxx physical pages ($FD2E), the second
// kanji ROM ($FD2C-$FD2F), the sub-side kanji port ($D406/$D407), the
// extended sub RAM ($D42E, $D800-$FFFF), the banked RAM behind sub
// $C000-$CFFF ($D42E bits 3-4) and the write latch of $FD04.  It
// also answers for the devices that are not fitted (reads $FF, writes
// dropped).  The host (FM7) routes the matching addresses here.
// =============================================================================

// Which machine has what.  `ram2x` tells whether the $2xxxx
// physical pages outside the window / learning RAM hold ordinary RAM.
const FEATURES_BY_MACHINE = {
    fm77av40: {
        wideMmr: true, modeRegister2: true, romWindow: false, learningRam: false,
        kanjiLevel2: true, subKanjiPort: true, extSubRam: true, fd04Latch: true, ram2x: true,
    },
    fm77av20ex: {
        wideMmr: true, modeRegister2: true, romWindow: true, learningRam: true,
        kanjiLevel2: true, subKanjiPort: true, extSubRam: true, fd04Latch: true, ram2x: false,
    },
    fm77av40ex: {
        wideMmr: true, modeRegister2: true, romWindow: true, learningRam: true,
        kanjiLevel2: true, subKanjiPort: true, extSubRam: true, fd04Latch: true, ram2x: true,
    },
};

// Every other machine: none of the extensions; $2xxxx stays with the host.
const NO_FEATURES = {
    wideMmr: false, modeRegister2: false, romWindow: false, learningRam: false,
    kanjiLevel2: false, subKanjiPort: false, extSubRam: false, fd04Latch: false, ram2x: true,
};

const PAGE_LEARNING_RAM = 0x28;
const PAGE_ROM_WINDOW   = 0x2E;
const EXT_SUB_ROM_BANKS = 12;     // 4KB x 12 = 48KB
const OPEN_BUS          = 0xFF;

// Sub $D800-$FFFF while the sub CPU runs from RAM: 2KB pages.  Page 0
// ($D800-$DFFF) is one of 8 banks picked by $D42E bits 0-2; the pages
// above it are fixed.  All of it lives in `extSubMemory`: the 8 banks first,
// then the fixed pages.
const SUB_RAM_FIRST      = 0xD800;
const SUB_RAM_PAGE_SHIFT = 11;
const SUB_RAM_PAGE_MASK  = (1 << SUB_RAM_PAGE_SHIFT) - 1;
const SUB_RAM_PAGES      = (0x10000 - SUB_RAM_FIRST) >> SUB_RAM_PAGE_SHIFT;   // 5
const EXT_SUB_RAM_BANKS  = 8;
const SUB_RAM_BYTES      = (EXT_SUB_RAM_BANKS + SUB_RAM_PAGES - 1) << SUB_RAM_PAGE_SHIFT;

// Sub-side kanji address port: $D406 holds the upper byte, $D407 the lower.
const SUB_KANJI_UPPER = 0;
const SUB_KANJI_LOWER = 1;

// Banked RAM at sub $C000-$CFFF.  $D42E bits 3-4 pick what sub $C000-$CFFF shows.
// Each entry is the start of the 4KB bank in
// `c000BankRam`, C000_HIDDEN (the ordinary sub memory stays visible) or
// C000_UNDEFINED (bank 3 is not assigned: reads $FF, writes dropped).
const C000_HIDDEN    = -1;
const C000_UNDEFINED = -2;
const C000_BANK_START = [C000_HIDDEN, 0x0000, 0x1000, C000_UNDEFINED];
const C000_FIRST     = 0xC000;
const C000_LAST      = 0xCFFF;

export class ExSeriesUnit {
    /**
     * @param {{kanjiROM: Uint8Array}} host  owner of the level 1 kanji ROM
     */
    constructor(host) {
        this.host = host;
        this.features = NO_FEATURES;

        // ROM images supplied by the user.
        this.kanji2Rom       = new Uint8Array(0x20000).fill(0xFF);  // level 2 kanji
        this.dictionaryRom   = new Uint8Array(0x40000).fill(0xFF);  // 4KB x 64 banks
        this.extSubRom       = new Uint8Array(0xC000).fill(0xFF);   // 4KB x 12 banks
        this.extSubRomBytes  = 0;

        // Memories cleared at power-on. All but the banked $C000 RAM are kept
        // across a reset (see clearC000BankRam).
        this.extSubMemory      = new Uint8Array(SUB_RAM_BYTES);   // sub $D800-$FFFF (banks, then fixed pages)
        this.learningRam = new Uint8Array(0x1000);   // physical $28000-$28FFF
        this.c000BankRam  = new Uint8Array(0x2000);   // 4KB x 2 banks at sub $C000-$CFFF

        // Start in `extSubMemory` of each 2KB page of sub $D800-$FFFF.
        this.subRamPageStart = new Int32Array(SUB_RAM_PAGES);
        for (let p = 1; p < SUB_RAM_PAGES; p++) {
            this.subRamPageStart[p] = (EXT_SUB_RAM_BANKS + p - 1) << SUB_RAM_PAGE_SHIFT;
        }
        // Upper and lower byte of the sub-side kanji address.
        this.subKanjiAddress = new Uint8Array(2);

        this.resetRegisters();
    }

    /** Select the machine; equivalent to switching the power on. */
    setMachine(type) {
        this.features = FEATURES_BY_MACHINE[type] || NO_FEATURES;
        this.powerOn();
    }

    powerOn() {
        this.extSubMemory.fill(0);
        this.learningRam.fill(0);
        this.c000BankRam.fill(0);
        this.resetRegisters();
    }

    /** Reset button: the banked $C000 RAM is cleared as well. */
    clearC000BankRam() {
        this.c000BankRam.fill(0);
    }

    /** Reset button: registers return to $00. The other memories keep their contents. */
    resetRegisters() {
        this.regFD94 = 0;
        this.regFD95 = 0;
        this.regFD2E = 0;  // write side
        this.regFD04 = 0;  // write side
        this.regD42E = 0;
        this.kanji2Address = 0;
        this.subKanjiAddress.fill(0);
        this._selectSubRamBank();
    }

    // ---- derived state ----------------------------------------------------

    /** $FD94 bit 7: MMR registers drive A19-A12 with all 8 bits. */
    get wideMmr() {
        return this.features.wideMmr && (this.regFD94 & 0x80) !== 0;
    }

    /** $FD95 bit 3: high-speed mode.  Remembered only; the clock is unchanged. */
    get highSpeedBit() {
        return (this.regFD95 & 0x08) !== 0;
    }

    /** $FD04 bit 2: the extended sub RAM and sub $E000-$FFFF accept writes. */
    get subRamWritable() {
        return (this.regFD04 & 0x04) !== 0;
    }

    // ---- ROM images ---------------------------------------------------------

    loadKanji2(data) {
        const src = new Uint8Array(data);
        this.kanji2Rom.fill(0xFF);
        this.kanji2Rom.set(src.subarray(0, this.kanji2Rom.length));
        return Math.min(src.length, this.kanji2Rom.length);
    }

    loadDictionary(data) {
        const src = new Uint8Array(data);
        this.dictionaryRom.fill(0xFF);
        this.dictionaryRom.set(src.subarray(0, this.dictionaryRom.length));
        return Math.min(src.length, this.dictionaryRom.length);
    }

    loadExtSub(data) {
        const src = new Uint8Array(data);
        const n = Math.min(src.length, this.extSubRom.length);
        this.extSubRom.fill(0xFF);
        this.extSubRom.set(src.subarray(0, n));
        this.extSubRomBytes = n;
        return n;
    }

    clearRoms() {
        this.kanji2Rom.fill(0xFF);
        this.dictionaryRom.fill(0xFF);
        this.extSubRom.fill(0xFF);
        this.extSubRomBytes = 0;
    }

    // ---- main CPU I/O -------------------------------------------------------

    /**
     * True for the main I/O addresses this unit answers: $FD24-$FD2F and
     * $FD94-$FD9D.  $FD98/$FD99 belong to the DMA controller when one is
     * fitted, so the host passes `dmaFitted`.
     */
    claimsMainIO(addr, dmaFitted) {
        if (addr >= 0xFD24 && addr <= 0xFD2F) return true;
        if (addr >= 0xFD94 && addr <= 0xFD9D) {
            return !(dmaFitted && (addr === 0xFD98 || addr === 0xFD99));
        }
        return false;
    }

    readMainIO(addr) {
        // $FD2E / $FD2F: left / right 8 dots of the level 2 kanji word.
        if ((addr === 0xFD2E || addr === 0xFD2F) && this.features.kanjiLevel2) {
            return this.kanji2Rom[((this.kanji2Address << 1) | (addr & 1)) & 0x1FFFF];
        }
        // Everything else reads $FF: write-only registers ($FD2C/$FD2D,
        // $FD94, $FD95) and absent devices ($FD24-$FD2B,
        // $FD96/$FD97, $FD98/$FD99 without DMA, $FD9A-$FD9D).
        return OPEN_BUS;
    }

    writeMainIO(addr, val) {
        const f = this.features;
        switch (addr) {
            case 0xFD2C:   // level 2 kanji address, upper byte
                if (f.kanjiLevel2) this.kanji2Address = (val << 8) | (this.kanji2Address & 0x00FF);
                return;
            case 0xFD2D:   // level 2 kanji address, lower byte
                if (f.kanjiLevel2) this.kanji2Address = (this.kanji2Address & 0xFF00) | val;
                return;
            case 0xFD2E:   // window bank / learning RAM select
                if (f.romWindow) this.regFD2E = val;
                return;
            case 0xFD94:
                if (f.wideMmr) this.regFD94 = val;
                return;
            case 0xFD95:
                if (f.modeRegister2) this.regFD95 = val;
                return;
            default:       // $FD24-$FD2B, $FD2F, $FD96-$FD9D: dropped
                return;
        }
    }

    /** $FD04 write: bits 2-5 are latched, bits 0, 1, 6, 7 ignored. */
    latchFormatByte(val) {
        if (this.features.fd04Latch) this.regFD04 = val & 0x3C;
    }

    // ---- main CPU physical pages -------------------------------------------

    /**
     * Read physical page `page` (MMR value) at `offset` (0-$FFF).
     * Returns -1 when the page is ordinary extended RAM kept by the host.
     */
    readPhysical(page, offset) {
        if (page >= 0x40) return OPEN_BUS;                  // no RAM card
        if ((page & 0xF0) !== 0x20) return -1;
        const f = this.features;
        if (page === PAGE_ROM_WINDOW && f.romWindow) {
            // the window shows ROM while open; closed, the page is RAM
            return (this.regFD2E & 0x40) ? this._romWindowByte(offset) : -1;
        }
        if (page === PAGE_LEARNING_RAM && f.learningRam && (this.regFD2E & 0x80)) {
            return this.learningRam[offset];
        }
        return f.ram2x ? -1 : OPEN_BUS;
    }

    /**
     * Write physical page `page` at `offset`.  Returns false when the host
     * should store the byte in its extended RAM.
     */
    writePhysical(page, offset, val) {
        if (page >= 0x40) return true;
        if ((page & 0xF0) !== 0x20) return false;
        const f = this.features;
        if (page === PAGE_LEARNING_RAM && f.learningRam && (this.regFD2E & 0x80)) {
            this.learningRam[offset] = val;
            return true;
        }
        // $FD2E bit 6 selects the ROM for reads of the $2E page only.
        if (page === PAGE_ROM_WINDOW && f.romWindow) return false;
        return !f.ram2x;
    }

    /**
     * Label of what this unit shows at physical page `page` (for the
     * debugger's memory map), or null when the host decides.
     */
    physicalRegion(page) {
        if (page >= 0x40) return 'unmapped';
        if ((page & 0xF0) !== 0x20) return null;
        const f = this.features;
        if (page === PAGE_ROM_WINDOW && f.romWindow && (this.regFD2E & 0x40)) {
            return (this.regFD95 & 0x80) ? 'ext sub ROM (read)' : 'dictionary ROM (read)';
        }
        if (page === PAGE_LEARNING_RAM && f.learningRam && (this.regFD2E & 0x80)) {
            return 'learning RAM';
        }
        if (page === PAGE_ROM_WINDOW && f.romWindow) return null;
        return f.ram2x ? null : 'unmapped';
    }

    _romWindowByte(offset) {
        // $FD95 bit 7 picks the ROM: 1 = extended sub ROM, 0 = dictionary ROM.
        if (this.regFD95 & 0x80) {
            const bank = this.regFD2E & 0x0F;
            if (bank >= EXT_SUB_ROM_BANKS) return OPEN_BUS;
            const at = (bank << 12) | offset;
            return at < this.extSubRomBytes ? this.extSubRom[at] : OPEN_BUS;
        }
        return this.dictionaryRom[((this.regFD2E & 0x3F) << 12) | offset];
    }

    // ---- sub CPU side ---------------------------------------------------------

    /** $D406 / $D407 read: left / right 8 dots of the level 1 kanji word. */
    readSubKanji(addr) {
        if (!this.features.subKanjiPort) return OPEN_BUS;
        const a = this.subKanjiAddress;
        const word = (a[SUB_KANJI_UPPER] << 8) | a[SUB_KANJI_LOWER];
        return this.host.kanjiROM[((word << 1) | (addr & 1)) & 0x1FFFF];
    }

    /** $D406 / $D407 write: upper / lower byte of the sub-side kanji address. */
    writeSubKanji(addr, val) {
        if (!this.features.subKanjiPort) return;
        this.subKanjiAddress[addr & 1] = val;
    }

    /** $D42E write: bits 0-2 select the extended sub RAM bank; the rest is latched. */
    writeSubRamSelect(val) {
        if (!this.features.extSubRam) return;
        this.regD42E = val;
        this._selectSubRamBank();
    }

    /** Point page 0 of sub $D800-$FFFF at the bank $D42E bits 0-2 select. */
    _selectSubRamBank() {
        this.subRamPageStart[0] = (this.regD42E & (EXT_SUB_RAM_BANKS - 1)) << SUB_RAM_PAGE_SHIFT;
    }

    /** Start of the banked RAM shown at sub $C000-$CFFF, or C000_HIDDEN / C000_UNDEFINED. */
    _c000BankStart() {
        if (!this.features.extSubRam) return C000_HIDDEN;
        return C000_BANK_START[(this.regD42E >> 3) & 0x03];
    }

    /**
     * Sub read at `addr` through the banked $C000 RAM.  Returns -1
     * when the address is not covered and the host decides.
     */
    readC000Bank(addr) {
        if (addr < C000_FIRST || addr > C000_LAST) return -1;
        const start = this._c000BankStart();
        if (start === C000_HIDDEN) return -1;
        if (start === C000_UNDEFINED) return OPEN_BUS;
        return this.c000BankRam[start + (addr - C000_FIRST)];
    }

    /** Sub write through the banked $C000 RAM; false when the host should handle it. */
    writeC000Bank(addr, val) {
        if (addr < C000_FIRST || addr > C000_LAST) return false;
        const start = this._c000BankStart();
        if (start === C000_HIDDEN) return false;
        if (start !== C000_UNDEFINED) this.c000BankRam[start + (addr - C000_FIRST)] = val;
        return true;
    }

    /** Offset in `extSubMemory` of sub address `addr` ($D800-$FFFF) through the page table. */
    _subRamOffset(addr) {
        return this.subRamPageStart[(addr - SUB_RAM_FIRST) >> SUB_RAM_PAGE_SHIFT] + (addr & SUB_RAM_PAGE_MASK);
    }

    /** Sub $D800-$FFFF while the sub runs from RAM. */
    readSubRam(addr) {
        return this.extSubMemory[this._subRamOffset(addr)];
    }

    /** Sub $D800-$FFFF write: stored only while $FD04 bit 2 is set. */
    writeSubRam(addr, val) {
        if (!this.features.extSubRam || !this.subRamWritable) return;
        this.extSubMemory[this._subRamOffset(addr)] = val;
    }
}
