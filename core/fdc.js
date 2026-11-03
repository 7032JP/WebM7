// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// MB8877 FDC Simulator + D77 Disk Image Parser for FM-7
// =============================================================================

import { decodeHFE, crc16 } from './hfe.js';

// FDC State Machine
const FDC_STATE = {
    IDLE:               0,
    COMMAND_RECEIVED:    1,
    SEEK_STEPPING:       2,
    SEEK_VERIFY:         3,
    READ_FIND_SECTOR:    4,
    READ_TRANSFER:       5,
    WRITE_FIND_SECTOR:   6,
    WRITE_TRANSFER:      7,
    READ_ADDRESS:        8,
    READ_TRACK:          9,
    WRITE_TRACK:        10,
    COMPLETE:           11,
    RNF_WAIT:           12,  // search time before asserting RNF
};

// Command types
const CMD_TYPE = {
    TYPE_I:   1,  // Restore, Seek, Step, Step-In, Step-Out
    TYPE_II:  2,  // Read Sector, Write Sector
    TYPE_III: 3,  // Read Address, Read Track, Write Track
    TYPE_IV:  4,  // Force Interrupt
};

// Status register bits
const STATUS = {
    BUSY:           0x01,
    DRQ:            0x02,   // Type II/III: Data Request
    INDEX:          0x02,   // Type I: Index pulse
    LOST_DATA:      0x04,   // Type II/III: Lost data
    TRACK0:         0x04,   // Type I: Track 0
    CRC_ERROR:      0x08,
    SEEK_ERROR:     0x10,   // Type I: Seek error
    RNF:            0x10,   // Type II/III: Record Not Found
    HEAD_ENGAGED:   0x20,   // Type I: Head engaged
    RECORD_TYPE:    0x20,   // Type II/III: Record type (deleted mark)
    WRITE_PROTECT:  0x40,
    NOT_READY:      0x80,
};
// [bit, name for Type I commands, name for the others]
const STATUS_WORDS = [
    [STATUS.RNF, 'seek-error', 'not-found'],
    [STATUS.CRC_ERROR, 'crc', 'crc'],
    [STATUS.LOST_DATA, 'track0', 'lost'],
    [STATUS.WRITE_PROTECT, 'protected', 'protected'],
    [STATUS.NOT_READY, 'not-ready', 'not-ready'],
    [STATUS.RECORD_TYPE, 'head-loaded', 'deleted-mark'],
];

// Type I status bits that follow the drive signals.
const TYPE_I_DRIVE_BITS = STATUS.INDEX | STATUS.TRACK0 | STATUS.WRITE_PROTECT | STATUS.NOT_READY;

// Accelerated seek step rates (µs), used in fast-read mode.
const STEP_RATES_FAST_US = [100, 200, 300, 500];

// Step rates at the 1 MHz clock (µs): MB8877A data sheet, Table 1
// "Stepping Rates" (the 1 MHz column); FM77AV Hardware Manual 5.9.4.
const STEP_RATES_REAL_US = [6000, 12000, 20000, 30000];

// D77 header size
const D77_HEADER_SIZE = 0x2B0;
const D77_TRACK_TABLE_OFFSET = 0x20;
const D77_MAX_TRACKS = 164;
const D77_SECTOR_HEADER_SIZE = 0x10;
const D77_MEDIA_2DD = 0x10;          // header media type of a 2DD disk

const hexByte = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hexWord = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

// Trace words for the command byte (upper 4 bits) and the status bits.
const COMMAND_WORDS = ['restore', 'seek', 'step', 'step', 'step-in', 'step-in', 'step-out', 'step-out',
                       'read', 'read-multi', 'write', 'write-multi', 'read-id', 'interrupt',
                       'read-track', 'write-track'];


// Raw (headerless) image geometry. A 2D disk has 40 tracks per side, 2
// sides, 16 sectors of 256 bytes per track (FM-7 User's Manual System
// Description, chapter 13, the floppy disk structure); 2DD doubles the
// tracks, 1S is one side of a 2D disk.
const RAW_SECTORS_PER_TRACK = 16;
const RAW_SECTOR_BYTES = 256;
const RAW_GEOMETRIES = [
    { name: 'RAW2D',  tracks: 40, sides: 2, densityByte: 0x00 },
    { name: 'RAW2DD', tracks: 80, sides: 2, densityByte: 0x10 },
    { name: 'RAW2D',  tracks: 40, sides: 1, densityByte: 0x00 },
];
const rawImageBytes = (g) => g.tracks * g.sides * RAW_SECTORS_PER_TRACK * RAW_SECTOR_BYTES;


// =============================================================================
// D77 Disk Image Parser
// =============================================================================

export class FloppyImage {
    constructor() {
        this.name = '';
        this.writeProtect = false;
        this.densityByte = 0;
        this.diskSize = 0;
        this.trackTotal = 0;
        this.numSides = 1;
        // sectors[track][side][sectorNum] = { c, h, r, n, data, size, density, deleted, status, physIdx }
        this.sectors = {};
        this.loaded = false;
        // Set true when a sector/track write modifies this image (for SAVE).
        this.dirty = false;
    }

    /**
     * Parse a D77 format disk image.
     * @param {ArrayBuffer} buffer - The raw D77 file data
     * @returns {boolean} true if parsing succeeded
     */
    parseD77(buffer) {
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        if (buffer.byteLength < D77_HEADER_SIZE) {
            console.error('FDC: D77 image too small for header');
            return false;
        }

        // The D77 disk image format fixes the header layout: name (17 bytes,
        // null-terminated) at 0, write-protect at $1A, media type at $1B,
        // image size at $1C, track offset table from $20. The offsets are a
        // requirement of reading existing images.
        // Parse disk name (up to 17 bytes, null-terminated; bytes kept as-is)
        let nameBytes = [];
        for (let i = 0; i < 17; i++) {
            const ch = bytes[i];
            if (ch === 0) break;
            nameBytes.push(ch);
        }
        this.name = String.fromCharCode(...nameBytes);

        // Write protect flag
        this.writeProtect = (bytes[0x1A] !== 0);

        // Media type
        this.densityByte = bytes[0x1B];

        // Disk size (32-bit LE)
        this.diskSize = view.getUint32(0x1C, true);

        // Parse track offset table
        const trackOffsets = [];
        let maxTrackIndex = -1;
        for (let i = 0; i < D77_MAX_TRACKS; i++) {
            const offset = view.getUint32(D77_TRACK_TABLE_OFFSET + i * 4, true);
            trackOffsets.push(offset);
            if (offset !== 0) {
                maxTrackIndex = i;
            }
        }

        if (maxTrackIndex < 0) {
            console.error('FDC: D77 image has no tracks');
            return false;
        }

        // Determine track/side layout
        // D77 track table: index = track * numSides + side
        // Detect number of sides by checking if odd entries are used
        this.numSides = 1;
        for (let i = 0; i <= maxTrackIndex; i++) {
            if (i % 2 === 1 && trackOffsets[i] !== 0) {
                this.numSides = 2;
                break;
            }
        }
        this.trackTotal = Math.floor((maxTrackIndex + this.numSides) / this.numSides);

        this.sectors = {};

        // Parse each track
        for (let idx = 0; idx <= maxTrackIndex; idx++) {
            const trackStart = trackOffsets[idx];
            if (trackStart === 0) continue;

            const track = Math.floor(idx / this.numSides);
            const side = idx % this.numSides;

            if (!this.sectors[track]) this.sectors[track] = {};
            if (!this.sectors[track][side]) this.sectors[track][side] = {};

            let pos = trackStart;
            if (pos >= buffer.byteLength) continue;

            // Read the first sector header to get number of sectors in this track
            if (pos + D77_SECTOR_HEADER_SIZE > buffer.byteLength) continue;

            const sectorTotal = view.getUint16(pos + 0x04, true);

            for (let s = 0; s < sectorTotal; s++) {
                if (pos + D77_SECTOR_HEADER_SIZE > buffer.byteLength) break;

                const c = bytes[pos + 0x00];       // Cylinder
                const h = bytes[pos + 0x01];       // Head
                const r = bytes[pos + 0x02];       // Sector number (R)
                const n = bytes[pos + 0x03];       // Size code (N)
                // sectorTotal at pos+0x04 already read
                const density = bytes[pos + 0x06];
                const deleted = bytes[pos + 0x07];
                const status = bytes[pos + 0x08];
                const dataSize = view.getUint16(pos + 0x0E, true);

                pos += D77_SECTOR_HEADER_SIZE;

                if (pos + dataSize > buffer.byteLength) {
                    console.error(`FDC: D77 sector data overflows at track ${track} side ${side} sector ${r}`);
                    break;
                }

                const data = new Uint8Array(buffer, pos, dataSize);
                // Copy the data so it's independent of the original buffer
                const dataCopy = new Uint8Array(dataSize);
                dataCopy.set(data);

                this.sectors[track][side][r] = {
                    c: c,
                    h: h,
                    r: r,
                    n: n,
                    data: dataCopy,
                    size: dataSize,
                    density: density,
                    deleted: (deleted !== 0),
                    status: status,
                    // Physical slot on the track: D77 stores sector blocks in
                    // the order they appear on the media, so the parse order
                    // IS the physical order (captures interleave/skew).
                    physIdx: s,
                };

                pos += dataSize;
            }
        }

        this.loaded = true;

        return true;
    }

    /**
     * Parse a raw 2D/2DD disk image (no header, fixed format).
     * 16 sectors/track, 256 bytes/sector.
     * 327680: 2D double-sided (40 tracks). 655360: 2DD double-sided (80 tracks).
     * 163840: 2D single-sided (40 tracks).
     * @param {ArrayBuffer} buffer - The raw image data
     * @returns {boolean} true if parsing succeeded
     */
    parseRaw2D(buffer) {
        const bytes = new Uint8Array(buffer);
        const size = buffer.byteLength;

        const geometry = RAW_GEOMETRIES.find((g) => rawImageBytes(g) === size);
        if (!geometry) {
            console.error(`FDC: Raw image size ${size} matches none of ${RAW_GEOMETRIES.map(rawImageBytes).join(', ')}`);
            return false;
        }
        const numSides = geometry.sides;
        const trackTotal = geometry.tracks;
        const densityByte = geometry.densityByte;
        const name = geometry.name;

        this.name = name;
        this.writeProtect = false;
        this.densityByte = densityByte;
        this.diskSize = size;
        this.trackTotal = trackTotal;
        this.numSides = numSides;
        this.sectors = {};

        const sectorsInTrack = 16;
        const sectorBytes = 256;
        let pos = 0;

        for (let track = 0; track < trackTotal; track++) {
            this.sectors[track] = {};
            for (let side = 0; side < numSides; side++) {
                this.sectors[track][side] = {};
                for (let sec = 1; sec <= sectorsInTrack; sec++) {
                    const dataCopy = new Uint8Array(sectorBytes);
                    dataCopy.set(bytes.subarray(pos, pos + sectorBytes));

                    this.sectors[track][side][sec] = {
                        c: track,
                        h: side,
                        r: sec,
                        n: 1,       // 256 bytes
                        data: dataCopy,
                        size: sectorBytes,
                        density: 0x00, // MFM
                        deleted: false,
                        status: 0x00,
                        physIdx: sec - 1,   // raw images are sequential (no interleave)
                    };

                    pos += sectorBytes;
                }
            }
        }

        this.loaded = true;
        return true;
    }

    /**
     * Populate this disk from a decoded HFE structure (see hfe.js).
     * Sectors come straight from the MFM decoder.
     * @param {object} decoded - { trackTotal, numSides, sectors, header }
     * @returns {boolean}
     */
    loadFromDecodedHFE(decoded) {
        if (!decoded || !decoded.sectors) return false;
        this.name = 'HFE';
        this.writeProtect = false;
        this.numSides = decoded.numSides;
        this.trackTotal = decoded.trackTotal;
        this.densityByte = decoded.trackTotal > 45 ? 0x10 : 0x00; // 2DD vs 2D
        this.sectors = decoded.sectors;
        this.loaded = true;
        return true;
    }

    /**
     * Get a sector from the disk.
     * @param {number} track - Track number
     * @param {number} side - Side (0 or 1)
     * @param {number} sectorNum - Sector number (usually 1-based)
     * @returns {object|null} Sector object or null if not found
     */
    lookupSector(track, side, sectorNum) {
        if (!this.sectors[track]) return null;
        if (!this.sectors[track][side]) return null;
        return this.sectors[track][side][sectorNum] || null;
    }

    /**
     * Get list of all sector numbers on a given track/side.
     * @param {number} track
     * @param {number} side
     * @returns {number[]} Array of sector numbers
     */
    getSectorList(track, side) {
        if (!this.sectors[track]) return [];
        if (!this.sectors[track][side]) return [];
        return Object.keys(this.sectors[track][side]).map(Number).sort((a, b) => a - b);
    }

    /**
     * Get sector numbers on a track/side in PHYSICAL (media) order, i.e. the
     * order the sector blocks pass under the head — this captures interleave
     * and skew. Falls back to numeric order for sectors without physIdx.
     * @param {number} track
     * @param {number} side
     * @returns {number[]} Array of sector numbers in physical order
     */
    getPhysicalOrder(track, side) {
        if (!this.sectors[track]) return [];
        if (!this.sectors[track][side]) return [];
        const secs = Object.values(this.sectors[track][side]);
        secs.sort((a, b) => (a.physIdx ?? (a.r - 1)) - (b.physIdx ?? (b.r - 1)));
        return secs.map(s => s.r);
    }

    /**
     * Logical format of an empty F-BASIC disk:
     * the ID sector, the FAT and the directory of an empty disk. Sectors are
     * numbered 1-32 per track as F-BASIC does (17-32 are sectors 1-16 of
     * side 1). The write-protect mark is also cleared.
     *
     * @returns {boolean} true on success
     */
    formatForFBasic() {
        if (!this.sectors[0] || !this.sectors[1]) return false;
        const fbasicSector = (track, n) => this.lookupSector(track, (n - 1) >> 4, ((n - 1) & 15) + 1);
        const fill = (track, from, to, value) => {
            for (let n = from; n <= to; n++) {
                const sec = fbasicSector(track, n);
                if (sec && sec.data) sec.data.fill(value);
            }
        };
        this.writeProtect = false;
        // F-BASIC disk layout (FM-7 User's Manual System Description,
        // chapter 13, the floppy disk structure): the ID sector, the FAT and
        // the directory.
        // ID sector (track 0, sector 3): starts with "S", the rest is 0.
        fill(0, 3, 3, 0x00);
        const id = fbasicSector(0, 3);
        if (id && id.data) id.data[0] = 0x53;
        // FAT (track 1, sector 1) and the reserved sectors 2-3: every cluster free.
        fill(1, 1, 3, 0xFF);
        const fat = fbasicSector(1, 1);
        if (fat && fat.data) fat.data[0] = 0x00;
        // Directory (track 1, sectors 4-32): every slot unused.
        fill(1, 4, 32, 0xFF);
        return true;
    }

    /**
     * Re-serialize the current (possibly written-to) in-memory image back to a
     * D77 ArrayBuffer. Sectors are emitted per track in ascending sector-number
     * order. Used to export/persist a disk after SAVE/SAVEM writes.
     * @returns {ArrayBuffer}
     */
    serializeD77() {
        // Collect present tracks in D77 table-index order (track*sides + side).
        const entries = [];
        for (const trackStr of Object.keys(this.sectors)) {
            const track = Number(trackStr);
            for (const sideStr of Object.keys(this.sectors[track])) {
                const side = Number(sideStr);
                const secNums = this.getSectorList(track, side);
                if (secNums.length === 0) continue;
                let blockLen = 0;
                for (const sn of secNums) {
                    blockLen += D77_SECTOR_HEADER_SIZE + this.sectors[track][side][sn].size;
                }
                entries.push({ idx: track * this.numSides + side, track, side, secNums, blockLen });
            }
        }
        entries.sort((a, b) => a.idx - b.idx);

        let dataLen = 0;
        for (const e of entries) dataLen += e.blockLen;
        const fileSize = D77_HEADER_SIZE + dataLen;

        const buf = new ArrayBuffer(fileSize);
        const view = new DataView(buf);
        const bytes = new Uint8Array(buf);

        // Header: name (max 16 chars + null), write-protect, media type, size.
        for (let i = 0; i < this.name.length && i < 16; i++) {
            bytes[i] = this.name.charCodeAt(i) & 0xFF;
        }
        bytes[0x1A] = this.writeProtect ? 0x10 : 0x00;
        bytes[0x1B] = this.densityByte & 0xFF;
        view.setUint32(0x1C, fileSize, true);

        // Track offset table + track data.
        let pos = D77_HEADER_SIZE;
        for (const e of entries) {
            view.setUint32(D77_TRACK_TABLE_OFFSET + e.idx * 4, pos, true);
            const sectorTotal = e.secNums.length;
            for (const sn of e.secNums) {
                const sec = this.sectors[e.track][e.side][sn];
                bytes[pos + 0x00] = sec.c & 0xFF;
                bytes[pos + 0x01] = sec.h & 0xFF;
                bytes[pos + 0x02] = sec.r & 0xFF;
                bytes[pos + 0x03] = sec.n & 0xFF;
                view.setUint16(pos + 0x04, sectorTotal, true);
                bytes[pos + 0x06] = sec.density & 0xFF;
                bytes[pos + 0x07] = sec.deleted ? 0x10 : 0x00;
                bytes[pos + 0x08] = sec.status & 0xFF;
                // 0x09-0x0D reserved (zero)
                view.setUint16(pos + 0x0E, sec.size, true);
                pos += D77_SECTOR_HEADER_SIZE;
                bytes.set(sec.data.subarray(0, sec.size), pos);
                pos += sec.size;
            }
        }
        return buf;
    }
}


// =============================================================================
// MB8877 FDC Simulator
// =============================================================================

export class FDC {
    constructor() {
        // Drives (up to 4): active disk (references entry in diskSlots)
        this.disks = [null, null, null, null];
        // Multi-disk D77 containers: array of FloppyImage per drive
        this.diskSlots     = [[], [], [], []];
        this.diskSlotIndex = [0, 0, 0, 0];

        // Currently selected drive and head
        this.currentDrive = 0;
        this.currentSide = 0;
        this.motorRunning = false;
        // $FD1D bit6: drive disable (no drive is selected while set).
        this.driveDisabled = false;
        // Optional motor spin-up delay (strictSpinup); the default keeps the
        // drive instantly ready.
        this.strictSpinup = false;
        this._spinupRemaining = 0;   // ticks left until the motor is up to speed
        this._settleRemaining = 0;   // pending drive settle wait (fastReadMode OFF only)
        this._headLoaded = false;
        this._stepped = false;
        this.onHwWarn = null;        // (code, message) => void
        this.densityFlag = false; // bit4 of $FD1C
        this.hdMode = false;     // $FD1E bit6 as written (1 = 2D drive mode)

        // Drive type. Defaults to 2D; models that support drive-mode
        // switching change it through $FD1E (see supportsDriveModeSwitch).
        this.driveModeIs2dd = false;
        // True when $FD1E bit 6 selects the drive mode (machines with 2DD
        // drives; fm7.js supports2DD). Set by fm7.js setMachineType.
        this.supportsDriveModeSwitch = false;

        // Registers
        this.statusReg = 0;
        this.trackReg = 0;
        this.sectorReg = 0;
        this.dataReg = 0;
        this.commandReg = 0;

        // Physical head position per drive
        this.headPosition = [0, 0, 0, 0];

        // Step direction: +1 = step in (toward center), -1 = step out (toward edge)
        this.stepDirection = 1;

        // State machine
        this.state = FDC_STATE.IDLE;
        this.commandType = 0;

        // Access latch for UI LED (sticky until read and cleared)
        this.accessLatch = false;

        // Command flags parsed from command byte
        this.cmdFlags = {
            h: false,       // Head load (Type I)
            v: false,       // Verify (Type I)
            r: 0,           // Step rate (Type I)
            m: false,       // Multiple sectors (Type II)
            s: false,       // Side number to compare (Type II)
            e: false,       // Settle delay (Type II/III)
            c: false,       // Compare the side with S (Type II)
            a0: false,      // Address mark (Type II write)
            u: false,       // Update track (Type I step)
        };

        // Data transfer
        this.dataBuffer = null;     // Uint8Array for current sector
        this.dataIndex = 0;         // Current position in dataBuffer
        this.dataLength = 0;        // Total bytes to transfer

        // Read Address result buffer
        this.idBuffer = null;
        this.idIndex = 0;

        // Timing
        this.delayCycles = 0;       // Remaining delay in ticks (see FDC.setTickRate)
        this.cyclesToDrq = 0;       // Cycles between DRQ assertions

        // Fast-read mode selects accelerated STEP_RATES.
        // When disabled, use MB8877 timing (STEP_RATES_REAL).
        this.fastReadMode = true;

        // Rotation phase used to calculate sector access delays.
        this._rotationPhase = 0;

        // IRQ / DRQ status
        this.irqFlag = false;
        this.drqFlag = false;

        // Force Interrupt conditions waiting for an event (I0: READY rising,
        // I1: READY falling, I2: every index pulse) and the last READY level.
        this._forceIntCond = 0;
        this._forceIntReady = false;

        // Pending DRQ for byte-level transfer timing
        this._pendingDrq = false;
        this._drqTimer = 0;
        this._effectiveBytePeriod = 0;

        // D77 sector status (CRC errors etc.) for READ completion
        this._readStatusExtra = 0;

        // Callback for IRQ generation
        this.onIntrqRise = null;

        // Callbacks for FDD sound synthesis (see fdd_sound.js).
        // onSeekSound(steps) — Type I command; `steps` may be zero.
        // onHeadLoadSound() — head load click: Type I with h=1, or any Type II/III.
        // Force Interrupt never triggers sound.
        this.onSeekSound     = null;
        this.onHeadLoadSound = null;
        this.onDiskInsert    = null;
        this.onMediaRemoved     = null;

        // ---- Development trace (off by default) ----
        this.traceOn = false;
        this.trace = [];                 // { ticks, kind, ...fields }
        this._traceTicks = 0;            // time units since clearTrace()
        this._seenLines = { drq: false, irq: false, busy: false };
        this._busySince = 0;
        this._commandSince = 0;
        this._commandWord = '';
        this._commandByte = 0;
        this._sectorBytes = 0;           // bytes moved in the current sector
        this._commandBytes = 0;          // bytes moved by the current command
    }

    // =========================================================================
    // Development trace
    // =========================================================================

    /** Short word for a command byte (upper 4 bits). */
    static commandWord(cmd) {
        return COMMAND_WORDS[cmd >> 4];
    }

    /** Status bits named for the trace; Type I commands use other names for bits 2, 4, 5. */
    _statusWords(bits) {
        const seekType = (this._commandByte & 0x80) === 0;
        const words = [];
        for (const [bit, typeOne, other] of STATUS_WORDS) {
            if (bits & bit) words.push(seekType ? typeOne : other);
        }
        return words;
    }

    /** Add one trace record (only while the trace is on). */
    _note(kind, fields) {
        if (!this.traceOn) return;
        this.trace.push({ ticks: this._traceTicks, kind, ...fields });
    }

    /** Record changes of the DRQ, IRQ and BUSY lines since the last look. */
    _noteLines() {
        if (!this.traceOn) return;
        const now = { drq: this.drqFlag, irq: this.irqFlag, busy: (this.statusReg & STATUS.BUSY) !== 0 };
        for (const name of ['drq', 'irq', 'busy']) {
            if (now[name] === this._seenLines[name]) continue;
            this._seenLines[name] = now[name];
            const fields = { line: name, level: now[name] ? 1 : 0 };
            if (name === 'busy') {
                if (now.busy) this._busySince = this._traceTicks;
                else fields.lastedUs = this._ticksToUs(this._traceTicks - this._busySince);
            }
            this._note('line', fields);
        }
    }

    _ticksToUs(ticks) {
        return Math.round(ticks / FDC.CYCLES_PER_US * 10) / 10;
    }

    /** Empty the trace and start the clock again. */
    clearTrace() {
        this.trace = [];
        this._traceTicks = 0;
        this._seenLines = { drq: this.drqFlag, irq: this.irqFlag, busy: (this.statusReg & STATUS.BUSY) !== 0 };
        this._busySince = 0;
        this._sectorBytes = 0;
        this._commandBytes = 0;
    }

    /**
     * The trace as text: one record per line, "time_us kind fields".
     * Consecutive reads of the same register are folded into one line that
     * counts each value read ("$80*12 $00*3"), from the first to the last.
     * @param {Object} [opts]
     * @param {boolean} [opts.fold=true] fold repeated register reads
     * @param {string[]} [opts.kinds] only these kinds (e.g. ['command', 'end'])
     * @param {string[]} [opts.ports] only register accesses to these addresses (e.g. ['$FD18'])
     */
    traceText(opts = {}) {
        const fold = opts.fold !== false;
        const kinds = opts.kinds ? new Set(opts.kinds) : null;
        const ports = opts.ports ? new Set(opts.ports) : null;
        const wanted = (r) => {
            if (kinds && !kinds.has(r.kind)) return false;
            if (ports && (r.kind === 'in' || r.kind === 'out') && !ports.has(r.port)) return false;
            return true;
        };
        const fieldsOf = (r) => Object.entries(r)
            .filter(([k]) => k !== 'ticks' && k !== 'kind')
            .map(([k, v]) => `${k}=${v}`).join(' ');
        const out = [
            '; WebM7 floppy controller trace',
            '; time_us   kind   fields',
        ];
        const records = this.trace.filter(wanted);
        for (let i = 0; i < records.length; i++) {
            const r = records[i];
            const at = this._ticksToUs(r.ticks).toFixed(1).padStart(10);
            if (fold && r.kind === 'in') {
                let j = i;
                const tally = new Map();
                while (j < records.length && records[j].kind === 'in' && records[j].port === r.port) {
                    tally.set(records[j].value, (tally.get(records[j].value) || 0) + 1);
                    j++;
                }
                if (j - i > 1) {
                    const values = [...tally].map(([v, n]) => `${v}*${n}`).join(' ');
                    const until = this._ticksToUs(records[j - 1].ticks).toFixed(1);
                    out.push(`${at}  in     port=${r.port} reads=${j - i} values=${values} until=${until}`);
                    i = j - 1;
                    continue;
                }
            }
            out.push(`${at}  ${r.kind.padEnd(6)} ${fieldsOf(r)}`.trimEnd());
        }
        return out.join('\n') + '\n';
    }

    // Timing parameters in microseconds (converted to ticks by setTickRate)
    // MFM byte transfer delay per byte: a DRQ every 32 us
    // (FM77AV Hardware Manual 5.9.4 (3)).
    static BYTE_DELAY_US = 32;
    // Inter-sector gap delay for multi-sector reads/writes
    static MULTI_SECTOR_GAP_US = 6000;
    // RNF search time: 5 index pulses (5 revolutions)
    static RNF_TIMEOUT_US = 1000000;

    // Rate of the time units the FDC is stepped with (master clock periods,
    // set by setTickRate). Every *_CYCLES value below is in those units.
    static TICK_RATE_HZ = 8000000;
    static CYCLES_PER_US = 8;

    static BYTE_DELAY = 0;
    static MULTI_SECTOR_GAP = 0;
    static RNF_TIMEOUT = 0;
    // Full revolution at 300 RPM = 200 ms
    static REVOLUTION_US = 200000;
    static REVOLUTION_CYCLES = 0;
    static STEP_RATES_REAL = [];
    static STEP_RATES_FAST = [];
    // Sectors per track (standard FM-7 2D/2DD format)
    static SECTORS_IN_TRACK = 16;
    // Cold spin-up time before the motor reaches a stable speed.
    static SPINUP_US = 500000;
    static SPINUP_CYCLES = 0;
    // E flag wait (Type II / III) used when fast-read mode is off: about
    // 30 ms at 1 MHz (FM77AV Hardware Manual 5.9.5).
    static E_SETTLE_US = 30000;
    static E_SETTLE_CYCLES = 0;
    // fastReadMode ON: accelerated E flag wait.
    static E_SETTLE_FAST_US = 16700;
    static E_SETTLE_FAST_CYCLES = 0;
    // Head settling after the last step of a verifying Type I command:
    // 15 ms at 2 MHz, 30 ms with the 1 MHz clock (FD179X-01 data sheet,
    // "Head Positioning" and "Verification").
    static HEAD_SETTLE_US = 30000;
    static HEAD_SETTLE_CYCLES = 0;
    // fastReadMode ON: short end-of-seek waits (moved / not moved).
    static SEEK_END_FAST_MOVED_US = 1000;
    static SEEK_END_FAST_STAY_US = 100;
    static SEEK_END_FAST_MOVED_CYCLES = 0;
    static SEEK_END_FAST_STAY_CYCLES = 0;
    // HLT hardware timer (HLTIME): 60 ms after a STEP pulse, a head load or
    // a drive register write (FM77AV Hardware Manual 5.9.4 (1)).
    static WAIT60_US = 60000;
    static WAIT60_CYCLES = 0;
    // Width of the INDEX pulse seen in the Type I status (once per revolution).
    static INDEX_PULSE_US = 4000;
    static INDEX_PULSE_CYCLES = 0;

    /** Set the rate of the time units passed to step() and derive the waits. */
    static setTickRate(hz) {
        const perUs = hz / 1000000;
        const t = (us) => Math.round(us * perUs);
        FDC.TICK_RATE_HZ = hz;
        FDC.CYCLES_PER_US = perUs;
        FDC.BYTE_DELAY = t(FDC.BYTE_DELAY_US);
        FDC.MULTI_SECTOR_GAP = t(FDC.MULTI_SECTOR_GAP_US);
        FDC.RNF_TIMEOUT = t(FDC.RNF_TIMEOUT_US);
        FDC.REVOLUTION_CYCLES = t(FDC.REVOLUTION_US);
        FDC.SPINUP_CYCLES = t(FDC.SPINUP_US);
        FDC.E_SETTLE_CYCLES = t(FDC.E_SETTLE_US);
        FDC.E_SETTLE_FAST_CYCLES = t(FDC.E_SETTLE_FAST_US);
        FDC.HEAD_SETTLE_CYCLES = t(FDC.HEAD_SETTLE_US);
        FDC.SEEK_END_FAST_MOVED_CYCLES = t(FDC.SEEK_END_FAST_MOVED_US);
        FDC.SEEK_END_FAST_STAY_CYCLES = t(FDC.SEEK_END_FAST_STAY_US);
        FDC.WAIT60_CYCLES = t(FDC.WAIT60_US);
        FDC.INDEX_PULSE_CYCLES = t(FDC.INDEX_PULSE_US);
        FDC.STEP_RATES_REAL = STEP_RATES_REAL_US.map(t);
        FDC.STEP_RATES_FAST = STEP_RATES_FAST_US.map(t);
    }

    static { FDC.setTickRate(FDC.TICK_RATE_HZ); }

    /**
     * Effective Type-I step delay in ticks for the current step-rate flag.
     * Fast-read mode ON → accelerated STEP_RATES; OFF → realistic MB8877 rates.
     */
    _stepDelayCycles() {
        return this.fastReadMode
            ? FDC.STEP_RATES_FAST[this.cmdFlags.r]
            : FDC.STEP_RATES_REAL[this.cmdFlags.r];
    }

    // =========================================================================
    // Disk Management
    // =========================================================================

    /**
     * Load a disk image into a drive.
     * Automatically detects HFE, D77 (single or multi-disk) and raw 2D/2DD images.
     * @param {number} driveNum - Drive number (0-3)
     * @param {ArrayBuffer} arrayBuffer - Disk image data
     * @param {number} [slotIndex=0] - Disk to put in the drive when the image
     *        holds several disks (0-based). Out of range falls back to 0.
     *        Used to keep the user's choice when the same file is read again.
     * @returns {boolean} true if loaded successfully
     */
    loadDisk(driveNum, arrayBuffer, slotIndex = 0) {
        if (driveNum < 0 || driveNum > 3) {
            console.error(`FDC: Invalid drive number ${driveNum}`);
            return false;
        }

        const slots = [];

        // HFE (bit-stream floppy image, v1): MFM-decode into sectors and report
        // track-length warnings.  Detected by the format signature "HXCPICFE".
        if (arrayBuffer.byteLength >= 8) {
            const sig = new Uint8Array(arrayBuffer, 0, 8);
            if (String.fromCharCode(...sig) === 'HXCPICFE') {
                const decoded = decodeHFE(arrayBuffer);
                if (decoded) {
                    for (const w of decoded.warnings) {
                        if (typeof this.onHwWarn === 'function') this.onHwWarn('hfe-track-length', w.message);
                        else console.warn(`[FDC/HFE] ${w.message}`);
                    }
                    const d = new FloppyImage();
                    if (d.loadFromDecodedHFE(decoded)) slots.push(d);
                }
            }
        }

        // Try D77 container: walk sequential headers using disk_size @ 0x1C.
        // A multi-disk D77 concatenates N disk images, each with its own header.
        if (slots.length === 0 && arrayBuffer.byteLength >= D77_HEADER_SIZE) {
            const fullView = new DataView(arrayBuffer);
            let pos = 0;
            while (pos + D77_HEADER_SIZE <= arrayBuffer.byteLength) {
                const declaredSize = fullView.getUint32(pos + 0x1C, true);
                if (declaredSize < D77_HEADER_SIZE) break;
                if (pos + declaredSize > arrayBuffer.byteLength) break;
                const slice = arrayBuffer.slice(pos, pos + declaredSize);
                const d = new FloppyImage();
                if (!d.parseD77(slice)) break;
                slots.push(d);
                pos += declaredSize;
            }
            // Fully consumed → valid D77 (single or multi-disk)
            if (slots.length > 0 && pos !== arrayBuffer.byteLength) {
                // Partial parse: reject so fallback paths can try
                slots.length = 0;
            }
        }

        // Fallback: raw 2D/2DD
        if (slots.length === 0) {
            const d = new FloppyImage();
            if (d.parseRaw2D(arrayBuffer)) slots.push(d);
        }

        if (slots.length === 0) {
            console.error(`FDC: Failed to load disk in drive ${driveNum}`);
            return false;
        }

        const index = (Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < slots.length)
            ? slotIndex : 0;
        this.diskSlots[driveNum] = slots;
        this.diskSlotIndex[driveNum] = index;
        this.disks[driveNum] = slots[index];

        if (slots.length > 1) {
            console.log(`FDC: Drive ${driveNum}: Multi-disk D77 container, ${slots.length} disks: [${slots.map(s => `"${s.name}"`).join(', ')}]`);
        } else {
            const d = slots[0];
            console.log(`FDC: Drive ${driveNum}: Disk loaded - "${d.name}", ${d.trackTotal} tracks, ${d.numSides} side(s)`);
        }
        if (this.onDiskInsert) this.onDiskInsert(driveNum);
        return true;
    }

    /**
     * Select an alternate disk from a multi-disk D77 container.
     * @param {number} driveNum
     * @param {number} slotIndex - 0-based index into diskSlots
     * @returns {boolean} true if switched
     */
    selectDisk(driveNum, slotIndex) {
        if (driveNum < 0 || driveNum > 3) return false;
        const slots = this.diskSlots[driveNum];
        if (!slots || slotIndex < 0 || slotIndex >= slots.length) return false;
        this.diskSlotIndex[driveNum] = slotIndex;
        this.disks[driveNum] = slots[slotIndex];
        if (this.onDiskInsert) this.onDiskInsert(driveNum);
        return true;
    }

    /**
     * Get disk names in the multi-disk container for a drive.
     * @param {number} driveNum
     * @returns {{names: string[], index: number}}
     */
    getDiskList(driveNum) {
        const slots = this.diskSlots[driveNum] || [];
        return {
            names: slots.map(d => d.name || ''),
            index: this.diskSlotIndex[driveNum] || 0,
        };
    }

    /**
     * Read-only geometry summary of the disk in a drive (for UI display).
     * Does not affect emulation; purely inspects the parsed disk structure.
     * @param {number} driveNum
     * @returns {{type:string,cylinders:number,sides:number,sectorsInTrack:number,sectorBytes:number}|null}
     *          null when no disk is loaded.
     */
    getGeometry(driveNum) {
        const d = this.disks[driveNum];
        if (!d || !d.loaded) return null;
        const cylinders = d.trackTotal || 0;
        const sides = d.numSides || 1;
        // Inspect the first populated track to derive sectors-per-track and
        // sector size. Falls back to 0 when the structure is empty.
        let sectorsInTrack = 0;
        let sectorBytes = 0;
        const trackKeys = Object.keys(d.sectors || {});
        for (const tk of trackKeys) {
            const sidesObj = d.sectors[tk];
            if (!sidesObj) continue;
            const sideKeys = Object.keys(sidesObj);
            for (const sk of sideKeys) {
                const secObj = sidesObj[sk];
                if (!secObj) continue;
                const secKeys = Object.keys(secObj);
                if (secKeys.length === 0) continue;
                sectorsInTrack = secKeys.length;
                const first = secObj[secKeys[0]];
                sectorBytes = (first && first.size) ? first.size : 0;
                break;
            }
            if (sectorsInTrack > 0) break;
        }
        // 2D vs 2DD by track count (2DD doubles the track density to ~80).
        const type = cylinders > 45 ? '2DD' : '2D';
        return { type, cylinders, sides, sectorsInTrack, sectorBytes };
    }

    /**
     * Eject disk from a drive.
     * @param {number} driveNum
     */
    ejectDisk(driveNum) {
        if (driveNum >= 0 && driveNum <= 3) {
            const hadDisk = !!this.disks[driveNum];
            this.disks[driveNum] = null;
            this.diskSlots[driveNum] = [];
            this.diskSlotIndex[driveNum] = 0;
            if (hadDisk && this.onMediaRemoved) this.onMediaRemoved(driveNum);
        }
    }

    /**
     * Get the currently selected disk object.
     * @returns {FloppyImage|null}
     */
    get currentDisk() {
        return this.disks[this.currentDrive];
    }

    /**
     * Re-serialize a drive's disk image (all slots of a multi-disk container,
     * concatenated) to a D77 ArrayBuffer for export/persistence.
     * @param {number} driveNum
     * @returns {ArrayBuffer|null}
     */
    serializeDrive(driveNum) {
        const slots = this.diskSlots[driveNum];
        if (!slots || slots.length === 0) return null;
        const parts = slots.map(d => d.serializeD77());
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength; }
        return out.buffer;
    }

    /** @returns {boolean} true if any slot in the drive has unsaved writes. */
    isDriveDirty(driveNum) {
        const slots = this.diskSlots[driveNum];
        return !!slots && slots.some(d => d.dirty);
    }

    /** Clear the dirty flag for all slots in a drive (after persisting). */
    clearDriveDirty(driveNum) {
        const slots = this.diskSlots[driveNum];
        if (slots) for (const d of slots) d.dirty = false;
    }

    // =========================================================================
    // I/O Port Interface
    // =========================================================================

    /**
     * Read from FDC I/O port.
     * @param {number} addr - Address ($FD18-$FD1F)
     * @returns {number} Byte value
     */
    readIO(addr) {
        let value = 0xFF;
        let extra = null;
        switch (addr) {
            case 0xFD18: // Status Register
                // Reading status clears IRQ
                this.irqFlag = false;
                // Type I status: INDEX, TRACK00, WRITE PROTECT and NOT READY
                // follow the drive signals at the time of the read.
                if (this.commandType === CMD_TYPE.TYPE_I) {
                    this.statusReg = (this.statusReg & ~TYPE_I_DRIVE_BITS)
                                   | this._typeIDriveBits();
                }
                value = this.statusReg;
                break;

            case 0xFD19: // Track Register
                value = this.trackReg & 0xFF;
                break;

            case 0xFD1A: // Sector Register
                value = this.sectorReg & 0xFF;
                break;

            case 0xFD1B: // Data Register
                // If DRQ is set, reading data clears it and advances transfer
                if (this.drqFlag) {
                    value = this.dataReg;
                    const elapsedSinceDrq = this._drqAge || 0;
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    if (this.traceOn) {
                        this._sectorBytes++;
                        this._commandBytes++;
                        extra = { byte: this._sectorBytes };
                    }
                    this._advanceRead(elapsedSinceDrq);
                } else {
                    value = this.dataReg;
                }
                break;

            case 0xFD1C: // Head register read: bit 7 DRQ, bit 6 IRQ, bit 0 side
                // Bits 5-1 read as 1.
                value = (this.drqFlag ? 0x80 : 0x00) | (this.irqFlag ? 0x40 : 0x00)
                      | 0x3E | (this.currentSide & 0x01);
                break;

            case 0xFD1D: // Drive select readback
                value = (this.currentDrive & 0x03) | (this.driveDisabled ? 0x40 : 0x00)
                      | (this.motorRunning ? 0x80 : 0x00);
                break;

            case 0xFD1F: // DRQ/IRQ status
                // bit 7: DRQ, bit 6: IRQ
                value = (this.drqFlag ? 0x80 : 0x00) | (this.irqFlag ? 0x40 : 0x00);
                break;

            default:
                value = 0xFF;
                break;
        }

        if (this.traceOn) {
            this._note('in', { port: hexWord(addr), value: hexByte(value), ...extra });
            this._noteLines();
        }
        return value;
    }

    /**
     * Write to FDC I/O port.
     * @param {number} addr - Address ($FD18-$FD1F)
     * @param {number} value - Byte value
     */
    writeIO(addr, value) {
        value &= 0xFF;

        this._note('out', { port: hexWord(addr), value: hexByte(value) });

        switch (addr) {
            case 0xFD18: // Command Register
                // Only update commandReg if command will actually execute
                // (Force Interrupt always executes; others only when not busy)
                if ((value & 0xF0) === 0xD0 || !(this.statusReg & STATUS.BUSY)) {
                    this.commandReg = value;
                }
                this._executeCommand(value);
                break;

            case 0xFD19: // Track Register
                this.trackReg = value;
                break;

            case 0xFD1A: // Sector Register
                this.sectorReg = value;
                break;

            case 0xFD1B: // Data Register
                this.dataReg = value;
                if (this.drqFlag && (this.state === FDC_STATE.WRITE_TRANSFER)) {
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    if (this.traceOn) {
                        this._sectorBytes++;
                        this._commandBytes++;
                    }
                    this._advanceWrite();
                } else if (this.drqFlag && (this.state === FDC_STATE.WRITE_TRACK)) {
                    this.drqFlag = false;
                    this.statusReg &= ~STATUS.DRQ;
                    this._writeTrackByte(value);
                }
                break;

            case 0xFD1C: // Head/Side select + density
                this.currentSide = value & 0x01;
                this.densityFlag = (value & 0x10) !== 0;
                break;

            case 0xFD1D: // Drive select + motor
                {
                    const newDrive = value & 0x03;
                    if (newDrive !== this.currentDrive || !(value & 0x80)) this._headLoaded = false;
                    if (!this.fastReadMode) this._settleRemaining = FDC.WAIT60_CYCLES;
                    this.currentDrive = newDrive;
                    this.driveDisabled = (value & 0x40) !== 0;
                }
                {
                    const newMotor = (value & 0x80) !== 0;
                    // Stopped -> running: start the cold spin-up window.
                    if (newMotor && !this.motorRunning && this.strictSpinup) {
                        this._spinupRemaining = FDC.SPINUP_CYCLES;
                    } else if (!newMotor) {
                        this._spinupRemaining = 0;
                    }
                    this.motorRunning = newMotor;
                }
                break;

            case 0xFD1E: // Drive-mode register
                // Update the drive mode on models with drive-mode switching.
                if (this.supportsDriveModeSwitch) {
                    this.driveModeIs2dd = (value & 0x40) === 0;
                }
                this.hdMode = (value & 0x40) !== 0;
                break;

            default:
                break;
        }

        this._noteLines();
    }

    // =========================================================================
    // State Machine Step
    // =========================================================================

    /**
     * True while step() has nothing to do but turn the disk: no command in
     * progress, no DRQ, spin-up or head settle time left, no force
     * interrupt condition and no trace.
     */
    _isWaiting() {
        return (this.state === FDC_STATE.IDLE || this.state === FDC_STATE.COMPLETE) &&
            !this._pendingDrq && !this._forceIntCond && !this.traceOn &&
            !(this._spinupRemaining > 0) && !(this._settleRemaining > 0);
    }

    /**
     * Advance the FDC state machine by the given number of ticks.
     * Call this from the main emulation loop.
     * @param {number} cycles - Number of ticks elapsed (see FDC.setTickRate)
     */
    step(cycles) {
        if (this._isWaiting()) {
            // Waiting with nothing to count down: only the disk turns, and
            // the DRQ age stays 0 (the full path below does the same).
            const rev = FDC.REVOLUTION_CYCLES;
            let phase = this._rotationPhase + cycles;
            if (phase >= rev) phase = phase < 2 * rev ? phase - rev : phase % rev;
            this._rotationPhase = phase;
            this._drqAge = 0;
            return;
        }
        if (this.traceOn) this._traceTicks += cycles;

        // Advance disk rotation phase (continuous, wraps at one revolution)
        const indexPassed = this._rotationPhase + cycles >= FDC.REVOLUTION_CYCLES;
        this._rotationPhase = (this._rotationPhase + cycles) % FDC.REVOLUTION_CYCLES;

        if (this._forceIntCond) this._checkForceIntConditions(indexPassed);

        // Burn down the cold spin-up window while the motor is running.
        if (this._spinupRemaining > 0 && this.motorRunning) {
            this._spinupRemaining -= cycles;
            if (this._spinupRemaining < 0) this._spinupRemaining = 0;
        }

        if (this._settleRemaining > 0) {
            this._settleRemaining -= cycles;
            if (this._settleRemaining < 0) this._settleRemaining = 0;
        }

        // Handle pending DRQ (byte transfer timing)
        if (this._pendingDrq) {
            this._drqTimer -= cycles;
            if (this._drqTimer <= 0) {
                this._pendingDrq = false;
                if (this.drqFlag && (this.state === FDC_STATE.READ_TRANSFER)) {
                    // Previous DRQ was not consumed — lost data
                    this.statusReg |= STATUS.LOST_DATA;
                    this._lostDataCount = (this._lostDataCount || 0) + 1;
                    if (this._lostDataCount === 1) {
                        console.warn(`[FDC] LOST_DATA at byte ${this.dataIndex}/${this.dataLength} T${this.headPosition[this.currentDrive]} S${this.currentSide} sec${this.sectorReg}`);
                    }
                }
                this.drqFlag = true;
                this.statusReg |= STATUS.DRQ;
            }
        }

        // DRQ timeout for READ: if the CPU hasn't consumed the data register
        // within a byte period, the disk has rotated past the byte — flag
        // LOST_DATA and auto-advance so the (read) transfer keeps moving.
        // WRITE advances when the CPU writes to $FD1B. DRQ stays asserted
        // until that write; the write path has no DRQ timeout.
        if (this.drqFlag && !this._pendingDrq &&
            this.state === FDC_STATE.READ_TRANSFER) {
            this._drqAge = (this._drqAge || 0) + cycles;
            if (this._drqAge >= FDC.BYTE_DELAY) {
                this._drqAge = 0;
                this.statusReg |= STATUS.LOST_DATA;
                this._lostDataCount = (this._lostDataCount || 0) + 1;
                if (this._lostDataCount === 1) {
                    console.warn(`[FDC] LOST_DATA timeout at byte ${this.dataIndex}/${this.dataLength} T${this.headPosition[this.currentDrive]} S${this.currentSide} sec${this.sectorReg}`);
                }
                this._advanceRead();
            }
        } else {
            this._drqAge = 0;
        }

        if (this.state === FDC_STATE.IDLE || this.state === FDC_STATE.COMPLETE) {
            this._noteLines();
            return;
        }

        // Count down delay
        if (this.delayCycles > 0) {
            this.delayCycles -= cycles;
            if (this.delayCycles > 0) return;
            // Delay finished, continue with current state
            cycles = -this.delayCycles; // Leftover cycles
            this.delayCycles = 0;
        }

        switch (this.state) {
            case FDC_STATE.COMMAND_RECEIVED:
                // Should not normally stay here; handled in _executeCommand
                break;

            case FDC_STATE.SEEK_STEPPING:
                this._stepSeek();
                break;

            case FDC_STATE.SEEK_VERIFY:
                this._completeTypeI();
                break;

            case FDC_STATE.READ_FIND_SECTOR:
                this._startReadTransfer();
                break;

            case FDC_STATE.READ_TRANSFER:
                // Data transfer is driven by CPU reads from $FD1B
                // If DRQ has been set for too long without read, flag lost data
                // (Data movement happens in readIO for $FD1B; the timeout
                // handling above also advances the transfer.)
                break;

            case FDC_STATE.WRITE_FIND_SECTOR:
                this._startWriteTransfer();
                break;

            case FDC_STATE.WRITE_TRANSFER:
                // Driven by CPU writes to $FD1B
                break;

            case FDC_STATE.READ_ADDRESS:
                this._startReadAddress();
                break;

            case FDC_STATE.READ_TRACK:
                // Read Track: completes immediately without data transfer.
                this._completeCommand(0);
                break;

            case FDC_STATE.WRITE_TRACK:
                // Data-driven by CPU writes to $FD1B (see _writeTrackByte).
                // WRITE TRACK lasts one disk revolution and completes on
                // elapsed cycles regardless of how many bytes the CPU fed.
                // DRQ is paced at BYTE_DELAY (see _reqNextTrackByte) so the
                // CPU feeds about one track's worth of bytes per revolution.
                this._wtElapsed = (this._wtElapsed || 0) + (cycles || 0);
                if (this._wtElapsed >= FDC.REVOLUTION_CYCLES) {
                    this._completeCommand(0);
                }
                break;

            case FDC_STATE.RNF_WAIT:
                // Search time elapsed without a matching sector.
                this._completeCommand(STATUS.RNF);
                break;
        }
        this._noteLines();
    }

    // =========================================================================
    // Command Dispatch
    // =========================================================================

    /**
     * Parse and begin executing an FDC command.
     * @param {number} cmd - Command byte
     * @private
     */
    _executeCommand(cmd) {
        // Clear IRQ on new command
        this.irqFlag = false;

        if (this.traceOn) {
            this._commandByte = cmd;
            this._commandWord = FDC.commandWord(cmd);
            this._commandSince = this._traceTicks;
            this._sectorBytes = 0;
            this._commandBytes = 0;
            this._note('command', {
                op: this._commandWord, code: hexByte(cmd),
                drive: this.currentDrive, side: this.currentSide,
                track: this.trackReg, sector: this.sectorReg,
                head: this.headPosition[this.currentDrive],
            });
        }

        const cmdHigh = cmd & 0xF0;

        // --- Type IV: Force Interrupt ---
        if ((cmd & 0xF0) === 0xD0) {
            this._forceInterrupt(cmd);
            return;
        }

        // If busy, ignore new commands (except Force Interrupt above)
        if (this.statusReg & STATUS.BUSY) {
            console.warn(`[FDC] CMD $${cmd.toString(16)} IGNORED (busy)`);
            return;
        }

        // A new command cancels the Force Interrupt conditions.
        this._forceIntCond = 0;

        // Set access latch for UI LED
        this.accessLatch = true;

        // Set BUSY
        this.statusReg = STATUS.BUSY;
        this.drqFlag = false;

        // Strict mode: while the motor is still spinning up, report NOT READY.
        if (this.strictSpinup && this._spinupRemaining > 0) {
            if (typeof this.onHwWarn === 'function') {
                this.onHwWarn('fdc-spinup',
                    `FDC command $${cmd.toString(16).padStart(2,'0')} issued during motor spin-up (${Math.round(this._spinupRemaining / FDC.CYCLES_PER_US)}us left); spin-up wait is active`);
            }
            this._completeCommand(STATUS.NOT_READY);
            return;
        }

        // --- Type I commands ---
        if (cmd < 0x80) {
            this.commandType = CMD_TYPE.TYPE_I;
            this.cmdFlags.h = (cmd & 0x08) !== 0;
            this.cmdFlags.v = (cmd & 0x04) !== 0;
            this.cmdFlags.r = cmd & 0x03;
            this.cmdFlags.u = (cmd & 0x10) !== 0; // Update flag for Step variants

            // FDD sound: compute the step count for the seek sound, then fire
            // the seek-sound callback BEFORE Restore overwrites trackReg.
            if (this.onSeekSound) {
                let steps = 0;
                if (cmdHigh === 0x00) {
                    // Restore steps out from the physical head position toward TR00.
                    steps = this.headPosition[this.currentDrive] & 0xFF;
                    if (steps === 0) steps = 1; // always audible
                } else if (cmdHigh === 0x10) {
                    // Seek: |dataReg - trackReg|
                    steps = Math.abs((this.dataReg & 0xFF) - (this.trackReg & 0xFF));
                } else {
                    // Step / Step-In / Step-Out: exactly 1 track
                    steps = 1;
                }
                this.onSeekSound(steps);
            }
            // Head load click if h=1 (force head load on Type I).
            if (this.cmdFlags.h && this.onHeadLoadSound) {
                this.onHeadLoadSound();
            }

            if (cmdHigh === 0x00) {
                // Restore: seek to track 0
                this.dataReg = 0; // Target track = 0
                this.trackReg = 0xFF; // Start from "unknown"
                this.state = FDC_STATE.SEEK_STEPPING;
                this._beginSeekRestore();
            } else if (cmdHigh === 0x10) {
                // Seek: seek to track in data register
                this.state = FDC_STATE.SEEK_STEPPING;
                this._beginSeek();
            } else if (cmdHigh <= 0x30) {
                // Step (no direction change)
                this._beginStep(false);
            } else if (cmdHigh <= 0x50) {
                // Step In
                this.stepDirection = 1;
                this._beginStep(true);
            } else if (cmdHigh <= 0x70) {
                // Step Out
                this.stepDirection = -1;
                this._beginStep(true);
            }
            return;
        }

        // --- Type II commands ---
        if (cmd < 0xC0) {
            this.commandType = CMD_TYPE.TYPE_II;
            this.cmdFlags.m = (cmd & 0x10) !== 0;
            this.cmdFlags.s = (cmd & 0x08) !== 0;
            this.cmdFlags.e = (cmd & 0x04) !== 0;
            this.cmdFlags.c = (cmd & 0x02) !== 0; // C flag: compare the side
            this.cmdFlags.a0 = (cmd & 0x01) !== 0; // DAM flag for write

            // FDD sound: head-load click for any Type II command.
            if (this.onHeadLoadSound) this.onHeadLoadSound();

            // Drive not ready (no disk, motor stopped): return NOT_READY.
            if (this._driveNotReady()) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }

            // Apply the wait before scanning (see _typeIIIWaitCycles).
            // The wait elapses BEFORE the controller starts scanning ID
            // fields, so the rotational latency to the target sector is
            // measured from the disk phase after that wait.
            const settleCycles = this._typeIIIWaitCycles();

            if (cmdHigh === 0x80 || cmdHigh === 0x90) {
                // Read Sector - add rotational latency
                this.state = FDC_STATE.READ_FIND_SECTOR;
                this.delayCycles = settleCycles + this._rotationalLatency(settleCycles);
            } else {
                // Write Sector ($A0-$BF)
                if (this.currentDisk.writeProtect) {
                    this._completeCommand(STATUS.WRITE_PROTECT);
                    return;
                }
                this.state = FDC_STATE.WRITE_FIND_SECTOR;
                this.delayCycles = settleCycles + this._rotationalLatency(settleCycles);
            }
            return;
        }

        // --- Type III commands ---
        if (cmd < 0xE0) {
            // $C0-$DF: Read Address (but $D0-$DF is Force Interrupt, handled above)
            this.commandType = CMD_TYPE.TYPE_III;
            this.cmdFlags.e = (cmd & 0x04) !== 0;

            // FDD sound: head-load click for Type III.
            if (this.onHeadLoadSound) this.onHeadLoadSound();

            if (this._driveNotReady()) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }

            this.state = FDC_STATE.READ_ADDRESS;
            this.delayCycles = this._typeIIIWaitCycles();
            return;
        }

        if (cmdHigh === 0xE0) {
            // Read Track
            this.commandType = CMD_TYPE.TYPE_III;
            if (this.onHeadLoadSound) this.onHeadLoadSound();
            if (this._driveNotReady()) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }
            this.state = FDC_STATE.READ_TRACK;
            this.delayCycles = 0;
            return;
        }

        if (cmdHigh === 0xF0) {
            // Write Track (Format)
            this.commandType = CMD_TYPE.TYPE_III;
            if (this.onHeadLoadSound) this.onHeadLoadSound();
            if (this._driveNotReady()) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }
            if (this.currentDisk.writeProtect) {
                this._completeCommand(STATUS.WRITE_PROTECT);
                return;
            }
            // Set up the IBM System 34 MFM format-stream parser and request
            // the first track byte from the CPU (DRQ-driven, like WRITE SECTOR).
            this._beginWriteTrack();
            return;
        }
    }

    /** Index of the ID field next under the head, from the rotation phase. */
    _idUnderHead(count) {
        const rev = FDC.REVOLUTION_CYCLES || 1;
        return Math.floor((this._rotationPhase % rev) / rev * count) % count;
    }

    /**
     * Compute rotational latency to reach the target sector from the
     * current disk rotation phase.  The disk spins
     * continuously at 300 RPM; the time to reach a given sector depends
     * on where the head is in the rotation when the command is issued.
     *
     * Returns the wait from the current rotation position to the target
     * sector, in ticks.
     */
    _rotationalLatency(phaseOffsetCycles = 0) {
        const rev = FDC.REVOLUTION_CYCLES;
        // Use the physical sector order from the image for rotational latency.
        let slot = (this.sectorReg - 1) & 0x0F;   // fallback: logical numbering
        let spt = FDC.SECTORS_IN_TRACK;
        const disk = this.currentDisk;
        if (disk && disk.lookupSector) {
            const track = this._cylinderUnderHead();
            const sec = track < 0 ? null
                : disk.lookupSector(track, this.currentSide, this.sectorReg);
            if (sec && sec.physIdx !== undefined) {
                slot = sec.physIdx;
                const n = disk.getSectorList(track, this.currentSide).length;
                if (n > 0) spt = n;
            }
        }
        const sectorSlot = rev / spt;   // cycles per sector slot
        const sectorStartCycle = slot * sectorSlot;
        // Time from current phase until the sector header passes under head.
        // phaseOffsetCycles: cycles that will elapse before the search
        // actually begins (e.g. E-flag head settle) — measure from there.
        const phase = (this._rotationPhase + phaseOffsetCycles) % rev;
        let latency = Math.round(sectorStartCycle - phase);
        if (latency < 0) latency += rev;
        // Minimum latency for controller overhead: a quarter of a sector slot
        const minCycles = Math.round(rev / (spt * 4));  // a quarter of a sector slot
        if (latency < minCycles) latency += rev;
        return latency;
    }

    // =========================================================================
    // Command start wait (Type II / III) and Type I end wait
    // =========================================================================

    /**
     * Wait before a Type II / III command starts scanning: the E flag wait
     * plus, when fastReadMode is OFF, the pending drive register write /
     * step wait and the head load if the head is not loaded yet.
     */
    _typeIIIWaitCycles() {
        let wait = 0;
        if (this.cmdFlags.e) {
            wait = this.fastReadMode ? FDC.E_SETTLE_FAST_CYCLES : FDC.E_SETTLE_CYCLES;
        }
        if (!this.fastReadMode) {
            let pending = this._settleRemaining;
            if (!this._headLoaded) pending = Math.max(pending, FDC.WAIT60_CYCLES);
            wait += pending;
        }
        this._settleRemaining = 0;
        this._headLoaded = true;
        return wait;
    }

    /**
     * Time from the last step (or from the start, when the head stays put)
     * until a Type I command ends.
     *   V = 0: the command ends once the last step time has run out.
     *   V = 1: head settling after a step, then HLT from the HLTIME timer
     *          (60 ms after a STEP pulse or a head load), then the first ID
     *          field to pass under the head; with no matching ID the search
     *          gives up after five revolutions.
     * fastReadMode keeps short fixed waits instead.
     */
    _typeIEndWait(moved) {
        if (this.fastReadMode) {
            return (moved || this.cmdFlags.v)
                ? FDC.SEEK_END_FAST_MOVED_CYCLES : FDC.SEEK_END_FAST_STAY_CYCLES;
        }
        if (!this.cmdFlags.v) return 1;
        let hlt = this._settleRemaining;
        if (moved || !this._headLoaded) hlt = Math.max(hlt, FDC.WAIT60_CYCLES);
        const settle = moved ? FDC.HEAD_SETTLE_CYCLES : 0;
        const ready = Math.max(settle, hlt);
        if (!this._verifyTrack()) return ready + 5 * FDC.REVOLUTION_CYCLES;
        return ready + this._nextIdFieldWait(ready);
    }

    /** Wait until the next ID field passes under the head, `after` units from now. */
    _nextIdFieldWait(after) {
        let spt = FDC.SECTORS_IN_TRACK;
        const disk = this.currentDisk;
        if (disk && disk.getSectorList) {
            const track = this._cylinderUnderHead();
            const n = track < 0 ? 0 : disk.getSectorList(track, this.currentSide).length;
            if (n > 0) spt = n;
        }
        const slot = FDC.REVOLUTION_CYCLES / spt;
        const into = (this._rotationPhase + after) % slot;
        return Math.round(into === 0 ? 0 : slot - into);
    }

    /** Restore: step out until track 0 */
    _beginSeekRestore() {
        this.stepDirection = -1;
        const pos = this.headPosition[this.currentDrive];
        if (pos === 0) {
            // Already at track 0: no step pulse. BUSY is set when the command
            // is loaded and cleared by the Type I end sequence, as for any
            // other Type I command (FD179X-01 data sheet, "Type I Commands").
            this.trackReg = 0;
            this.headPosition[this.currentDrive] = 0;
            this.delayCycles = this._typeIEndWait(false);
            this.state = FDC_STATE.SEEK_VERIFY;
        } else {
            // Step toward track 0
            this.delayCycles = this._stepDelayCycles();
            this.state = FDC_STATE.SEEK_STEPPING;
        }
    }

    /** Seek: move head to target track (in data register) */
    _beginSeek() {
        const target = this.dataReg;
        const headPos = this.headPosition[this.currentDrive];
        // Compare with the physical head position; software may change trackReg.
        if (target === headPos) {
            // Already at target. Completion is deferred by _typeIEndWait(false).
            this.trackReg = target;
            this.delayCycles = this._typeIEndWait(false);
            this.state = FDC_STATE.SEEK_VERIFY;
            return;
        }

        this.stepDirection = (target > headPos) ? 1 : -1;
        this.trackReg = headPos; // Sync trackReg with actual head position
        this.delayCycles = this._stepDelayCycles();
        this.state = FDC_STATE.SEEK_STEPPING;
    }

    /** Step command (with or without direction update) */
    _beginStep(directionSet) {
        // stepDirection already set by caller for Step In/Out
        this.delayCycles = this._stepDelayCycles();
        this.state = FDC_STATE.SEEK_STEPPING;
    }

    /** Process one step pulse during seek */
    _stepSeek() {
        this._stepped = true;
        const cmd = this.commandReg & 0xF0;
        if (cmd === 0x00) {
            // Restore
            let pos = this.headPosition[this.currentDrive];
            pos += this.stepDirection; // -1 toward track 0
            if (pos <= 0) {
                pos = 0;
                this.trackReg = 0;
                this.headPosition[this.currentDrive] = 0;
                if (!this.fastReadMode || this.cmdFlags.v) {
                    this.state = FDC_STATE.SEEK_VERIFY;
                    this.delayCycles = this._typeIEndWait(true);
                } else {
                    this._completeTypeI();
                }
                return;
            }
            this.headPosition[this.currentDrive] = pos;
            this.delayCycles = this._stepDelayCycles();
        } else if (cmd === 0x10) {
            // Seek
            const target = this.dataReg;
            this.trackReg += this.stepDirection;
            this.headPosition[this.currentDrive] += this.stepDirection;
            if (this.headPosition[this.currentDrive] < 0) {
                this.headPosition[this.currentDrive] = 0;
            }
            if (this.trackReg === target || this.trackReg < 0 || this.trackReg > 255) {
                this.trackReg = target & 0xFF;
                this.headPosition[this.currentDrive] = target;
                if (!this.fastReadMode || this.cmdFlags.v) {
                    this.state = FDC_STATE.SEEK_VERIFY;
                    this.delayCycles = this._typeIEndWait(true);
                } else {
                    this._completeTypeI();
                }
                return;
            }
            this.delayCycles = this._stepDelayCycles();
        } else {
            // Step / Step In / Step Out
            this.headPosition[this.currentDrive] += this.stepDirection;
            if (this.headPosition[this.currentDrive] < 0) {
                this.headPosition[this.currentDrive] = 0;
            }
            if (this.cmdFlags.u) {
                this.trackReg += this.stepDirection;
                if (this.trackReg < 0) this.trackReg = 0;
                if (this.trackReg > 255) this.trackReg = 255;
            }
            if (!this.fastReadMode || this.cmdFlags.v) {
                this.state = FDC_STATE.SEEK_VERIFY;
                this.delayCycles = this._typeIEndWait(true);
            } else {
                this._completeTypeI();
            }
        }
    }

    /** Complete a Type I command and set final status */
    _completeTypeI() {
        // Reset PLL drift counter — Type I commands (RESTORE/SEEK) establish
        // a new head position; the PLL re-locks from scratch on the next read.
        this._pllDrift = 0;
        // INDEX, TRACK00, WRITE PROTECT, NOT READY from the drive signals.
        let status = this._typeIDriveBits();

        // Head engaged
        if (this.cmdFlags.h) {
            status |= STATUS.HEAD_ENGAGED;
        }

        // V flag: the track under the head must carry an ID field whose
        // track number equals the Track Register.
        if (this.cmdFlags.v && !this._verifyTrack()) {
            status |= STATUS.SEEK_ERROR;
        }

        // HLTIME restarts with the last STEP pulse or the head load; a
        // verifying command has already waited it out.
        if (!this.fastReadMode) {
            if (this.cmdFlags.v) this._settleRemaining = 0;
            else if (this._stepped || this.cmdFlags.h) this._settleRemaining = FDC.WAIT60_CYCLES;
        }
        if (this.cmdFlags.h || this.cmdFlags.v) this._headLoaded = true;
        this._stepped = false;

        this._completeCommand(status);
    }

    /**
     * Type I verify: true when the media track under the head (current side)
     * has an ID field whose track number matches the Track Register.
     */
    _verifyTrack() {
        if (this._driveNotReady()) return false;
        const disk = this.currentDisk;
        const track = this._cylinderUnderHead();
        if (track < 0) return false;
        const side = this.currentSide;
        for (const n of disk.getSectorList(track, side)) {
            const sec = disk.lookupSector(track, side, n);
            if (sec && sec.c === (this.trackReg & 0xFF)) return true;
        }
        return false;
    }

    /** True when no drive is selected (drive disable) or no disk is inserted. */
    _noMedia() {
        if (this.driveDisabled) return true;
        const disk = this.currentDisk;
        return !disk || !disk.loaded;
    }

    /**
     * True when the selected drive is not ready: no media, motor stopped, or
     * (strict mode only) still spinning up. A drive is ready when a disk is
     * inserted and turning.
     */
    _driveNotReady() {
        if (this._noMedia()) return true;
        if (!this.motorRunning) return true;
        return this.strictSpinup && this._spinupRemaining > 0;
    }

    /**
     * Drive signal bits of the Type I status: INDEX (pulse once per
     * revolution while the disk turns), TRACK00, WRITE PROTECT, NOT READY.
     */
    _typeIDriveBits() {
        let bits = 0;
        const notReady = this._driveNotReady();
        if (notReady) bits |= STATUS.NOT_READY;
        if (!this.driveDisabled && this.currentDisk && this.currentDisk.writeProtect) {
            bits |= STATUS.WRITE_PROTECT;
        }
        if (this.headPosition[this.currentDrive] === 0) bits |= STATUS.TRACK0;
        if (!notReady && this.motorRunning && this._rotationPhase < FDC.INDEX_PULSE_CYCLES) {
            bits |= STATUS.INDEX;
        }
        return bits;
    }

    // =========================================================================
    // Type II: Read Sector
    // =========================================================================

    /**
     * Media track under the head, or -1 between two tracks.
     * Positions are counted in 96 tpi pitches: one step moves the head two
     * of them in 2D drive mode and one in 2DD drive mode; a 2D track is two
     * of them apart, a 2DD track one.
     */
    _cylinderUnderHead() {
        const steps = this.headPosition[this.currentDrive];
        const disk = this.currentDisk;
        if (!disk) return steps;
        const headPitch = this.driveModeIs2dd ? 1 : 2;
        const trackPitch = disk.densityByte === D77_MEDIA_2DD ? 1 : 2;
        const pos = steps * headPitch;
        if (pos % trackPitch !== 0) return -1;
        return (pos / trackPitch) & 0xFF;
    }

    /**
     * Type II C flag: when it is 1, the LSB of the side number in the ID
     * field must equal the S flag, or the sector is not found (FM77AV
     * Hardware Manual 5.9.5, S flag and C flag). With C = 0 any side passes.
     */
    _sideMatches(sector) {
        return !this.cmdFlags.c || ((sector.h & 1) === (this.cmdFlags.s ? 1 : 0));
    }

    /** Begin reading sector data after finding sector */
    _startReadTransfer() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        // Look up the target sector on the current track; if it is not found,
        // report an error after the search time below.
        // Which media track the head is on depends on the drive mode
        // (2D / 2DD) and the track pitch of the media. The step counter is mapped to the media track (2D-mode drive on
        // 2DD media double-steps; 2DD-mode drive on 2D media half-steps and
        // odd positions sit between tracks). The ID C-field of the sector on
        // that media track must still match the Track Register.
        const physTrack = this._cylinderUnderHead();
        const side = this.currentSide;
        const sectorNum = this.sectorReg;
        const mismatchRNF = (physTrack < 0);

        const sector = mismatchRNF ? null : disk.lookupSector(physTrack, side, sectorNum);
        if (mismatchRNF || !sector || sector.c !== this.trackReg || !this._sideMatches(sector)) {
            this._note('search', {
                result: 'missing', medium: physTrack, side, sector: sectorNum,
                track: this.trackReg, idTrack: sector ? sector.c : '-',
            });
            // Missing sector: stay BUSY for the search time, then assert
            // RNF + INTRQ.
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }
        if (this.traceOn) {
            this._note('search', {
                result: 'found', medium: physTrack, side, sector: sectorNum,
                bytes: sector.size, imageStatus: hexByte(sector.status || 0),
                markDeleted: sector.deleted ? 1 : 0,
            });
            this._sectorBytes = 0;
        }
        // Set up data transfer
        this.dataBuffer = sector.data;
        this.dataIndex = 0;
        this.dataLength = sector.size;
        this._lostDataCount = 0;

        // Check deleted data mark and D77 sector status
        let statusExtra = 0;
        if (sector.deleted) {
            statusExtra |= STATUS.RECORD_TYPE;
        }
        // D77 status field: a non-zero value marks a sector the dump could
        // not read normally (for example $B0 or $E0); any non-zero value is
        // reported as CRC ERROR.
        if (sector.status !== 0) {
            statusExtra |= STATUS.CRC_ERROR;
        }
        // Save completion status for when transfer finishes
        this._readStatusExtra = statusExtra;

        // Models PLL re-lock jitter between successive sector reads.
        this.dataReg = this.dataBuffer[0];
        this.dataIndex = 1;
        this._pendingDrq = true;
        const drift = Math.min(this._pllDrift || 0, 4);
        this._pllDrift = (this._pllDrift || 0) + 3;
        this._effectiveBytePeriod = FDC.BYTE_DELAY + drift;
        this._drqTimer = this._effectiveBytePeriod;
        this.statusReg = STATUS.BUSY | statusExtra;
        this.state = FDC_STATE.READ_TRANSFER;
    }

    /**
     * Advance read transfer after CPU reads data register.
     * @param {number} [elapsedSinceDrq=0] - Cycles elapsed since the DRQ
     *   that the CPU just consumed; the next transfer is scheduled with
     *   this time already counted.
     */
    _advanceRead(elapsedSinceDrq = 0) {
        if (this.state !== FDC_STATE.READ_TRANSFER) return;

        if (this.dataIndex < this.dataLength) {
            // More bytes to transfer.
            // Use the per-transfer effective byte period (which includes
            // clock-drift simulation) minus the time already elapsed since
            // the DRQ that the CPU just consumed.
            this.dataReg = this.dataBuffer[this.dataIndex];
            this.dataIndex++;
            this._pendingDrq = true;
            const period = this._effectiveBytePeriod || FDC.BYTE_DELAY;
            const remaining = period - elapsedSinceDrq;
            this._drqTimer = remaining > 0 ? remaining : 1;
        } else {
            // Transfer complete
            if (this.cmdFlags.m) {
                // Multi-sector: advance to next sector with rotational delay
                this._note('next', {
                    moved: this._sectorBytes, lost: this._lostDataCount || 0, sector: this.sectorReg + 1,
                });
                this._lostDataCount = 0;
                this.sectorReg++;
                this.drqFlag = false;
                this.statusReg = STATUS.BUSY;  // BUSY but no DRQ during gap
                this.state = FDC_STATE.READ_FIND_SECTOR;
                this.delayCycles = FDC.MULTI_SECTOR_GAP;
            } else {
                // Single sector: done (include D77 sector status like CRC errors)
                // Also report LOST_DATA in the final status
                let finalStatus = this._readStatusExtra || 0;
                if (this._lostDataCount > 0) finalStatus |= STATUS.LOST_DATA;
                this._completeCommand(finalStatus);
            }
        }
    }

    // =========================================================================
    // Type II: Write Sector
    // =========================================================================

    /** Begin write transfer */
    _startWriteTransfer() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        const track = this._cylinderUnderHead();
        const side = this.currentSide;
        const sectorNum = this.sectorReg;

        const sector = track < 0 ? null : disk.lookupSector(track, side, sectorNum);
        if (!sector || sector.c !== this.trackReg || !this._sideMatches(sector)) {
            // C field must match the track register (same as read path).
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }

        // a0 = 1 writes a deleted data mark ($F8), 0 a data mark ($FB)
        // (FM77AV Hardware Manual 5.9.5, Type II (5); FD179X-01 data sheet,
        // Write Sector).
        sector.deleted = this.cmdFlags.a0;

        // Set up write buffer
        this.dataBuffer = sector.data;
        this.dataIndex = 0;
        this.dataLength = sector.size;

        // Request first byte from CPU
        this.drqFlag = true;
        this.statusReg = STATUS.BUSY | STATUS.DRQ;
        this.state = FDC_STATE.WRITE_TRANSFER;
    }

    /** Advance write transfer after CPU writes data register */
    _advanceWrite() {
        if (this.state !== FDC_STATE.WRITE_TRANSFER) return;

        if (this.dataIndex < this.dataLength) {
            this.dataBuffer[this.dataIndex] = this.dataReg;
            this.dataIndex++;
            if (this.currentDisk) this.currentDisk.dirty = true;
        }

        if (this.dataIndex < this.dataLength) {
            // More bytes needed
            this.drqFlag = true;
            this.statusReg |= STATUS.DRQ;
        } else {
            // Sector write complete
            if (this.cmdFlags.m) {
                // Multi-sector: advance to next sector with rotational delay
                this.sectorReg++;
                this.drqFlag = false;
                this.statusReg = STATUS.BUSY;  // BUSY but no DRQ during gap
                this.state = FDC_STATE.WRITE_FIND_SECTOR;
                this.delayCycles = FDC.MULTI_SECTOR_GAP;
            } else {
                this._completeCommand(0);
            }
        }
    }

    // =========================================================================
    // Type III: Write Track (Format)
    // =========================================================================

    /**
     * Begin a WRITE TRACK (format) command.  The CPU streams a full IBM
     * System 34 MFM track image to the data register; we parse it
     * incrementally in _writeTrackByte and write each sector's data field
     * into the matching (pre-existing) sector of the in-memory image.
     */
    _beginWriteTrack() {
        const track = this._cylinderUnderHead();
        const side = this.currentSide;
        this._wtTrack = track;
        this._wtSide = side;
        this._wtSectorsWritten = 0;
        this._wtBytes = 0;
        this._wtPhase = 'gap';        // 'gap' | 'id' | 'data'
        this._wtIdCount = 0;
        this._wtId = [0, 0, 0, 0];    // C, H, R, N from the last ID Address Mark
        this._wtIdReady = false;
        this._wtDataRemaining = 0;
        this._wtDataIndex = 0;
        this._wtSector = null;
        this._wtElapsed = 0;
        this._pendingDrq = false;
        this.delayCycles = 0;
        this.state = FDC_STATE.WRITE_TRACK;
        // Request the first byte immediately; subsequent bytes are paced.
        this.drqFlag = true;
        this.statusReg = STATUS.BUSY | STATUS.DRQ;
    }

    /**
     * Schedule the next WRITE TRACK DRQ one byte-period (BYTE_DELAY) in the future.
     */
    _reqNextTrackByte() {
        if (this.state !== FDC_STATE.WRITE_TRACK) return;
        this.drqFlag = false;
        this.statusReg &= ~STATUS.DRQ;
        this._pendingDrq = true;
        this._drqTimer = FDC.BYTE_DELAY;   // step() decrements _drqTimer
    }

    /**
     * Consume one byte of the WRITE TRACK format stream.
     * Address marks introduce the ID and data fields; gap/sync/CRC bytes
     * carry no sector data and are skipped.
     */
    _writeTrackByte(b) {
        this._wtBytes++;
        if (this.currentDisk) this.currentDisk.dirty = true;

        if (this._wtPhase === 'data') {
            if (this._wtSector && this._wtDataIndex < this._wtSector.size) {
                this._wtSector.data[this._wtDataIndex] = b;
            }
            this._wtDataIndex++;
            this._wtDataRemaining--;
            if (this._wtDataRemaining <= 0) {
                // Sector data field captured.  Return to gap scanning and keep
                // accepting bytes — WRITE TRACK is treated as lasting one
                // revolution's worth of time from its start, so we let the CPU
                // feed the trailing gap.  Completion happens when that time has
                // elapsed in step() (or at the safety cap below).
                this._wtPhase = 'gap';
                this._wtSector = null;
                this._wtSectorsWritten++;
            }
            this._reqNextTrackByte();
            return;
        }

        if (this._wtPhase === 'id') {
            this._wtId[this._wtIdCount++] = b;
            if (this._wtIdCount >= 4) {
                this._wtPhase = 'gap';   // ID complete; await Data Address Mark
                this._wtIdReady = true;
            }
            this._reqNextTrackByte();
            return;
        }

        // gap phase: scan for address marks
        if (b === 0xFE) {
            this._wtPhase = 'id';
            this._wtIdCount = 0;
            this._wtIdReady = false;
        } else if ((b === 0xFB || b === 0xF8) && this._wtIdReady) {
            const r = this._wtId[2];
            const n = this._wtId[3] & 0x03;
            this._wtSector = this.currentDisk.lookupSector(this._wtTrack, this._wtSide, r);
            this._wtDataRemaining = 128 << n;
            this._wtDataIndex = 0;
            this._wtPhase = 'data';
            this._wtIdReady = false;
        }

        // Safety cap (~2× a 2D track's raw capacity) on the bytes accepted by
        // one WRITE TRACK command.
        if (this._wtBytes > 13000) {
            this._completeCommand(0);
            return;
        }
        this._reqNextTrackByte();
    }

    // =========================================================================
    // Type III: Read Address
    // =========================================================================

    /** Start Read Address command - returns sector ID from current track */
    _startReadAddress() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        const track = this._cylinderUnderHead();
        const side = this.currentSide;
        // ID fields come back in the order they pass under the head
        // (physical order), whether fastReadMode is on or off.
        const sectorList = track < 0 ? [] : disk.getPhysicalOrder(track, side);

        if (sectorList.length === 0) {
            this._note('id', { result: 'missing', medium: track, side });
            // Unformatted track: stay BUSY for the search time, then report RNF.
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }
        if (this.traceOn) {
            this._note('id', {
                result: 'found', medium: track, side,
                sector: sectorList[this._idUnderHead(sectorList.length)], ofSectors: sectorList.length,
            });
        }

        // The ID field that passes under the head next, from the rotation
        // phase of the disk; the disk then turns to the end of that ID, so a
        // following Read Address sees the next one.
        const slot = this._idUnderHead(sectorList.length);
        const sectorNum = sectorList[slot];
        this._rotationPhase = Math.floor((slot + 1) / sectorList.length * (FDC.REVOLUTION_CYCLES || 1)) % (FDC.REVOLUTION_CYCLES || 1);
        const sector = disk.lookupSector(track, side, sectorNum);

        // Build 6-byte ID field: C, H, R, N, CRC1, CRC2
        this.idBuffer = new Uint8Array(6);
        this.idBuffer[0] = sector.c;
        this.idBuffer[1] = sector.h;
        this.idBuffer[2] = sector.r;
        this.idBuffer[3] = sector.n;
        // CRC1, CRC2: the CRC bytes of the ID field (FM77AV Hardware Manual
        // 5.9.5, Type III (1) Read Address). CRC-CCITT preset to all ones,
        // over the address mark ($A1 x3, $FE) and C, H, R, N (FD179X-01 data
        // sheet, Organization, CRC Logic).
        const idCrc = crc16([0xA1, 0xA1, 0xA1, 0xFE, sector.c, sector.h, sector.r, sector.n]);
        this.idBuffer[4] = idCrc >> 8;
        this.idBuffer[5] = idCrc & 0xFF;

        // Transfer via data register + DRQ, same as Read Sector
        this.dataBuffer = this.idBuffer;
        this.dataIndex = 0;
        this.dataLength = 6;

        // The cylinder number from the ID field is loaded into the sector
        // register (the track register is left alone).
        this.sectorReg = sector.c;

        // Present first byte
        this.dataReg = this.dataBuffer[0];
        this.dataIndex = 1;
        this.drqFlag = true;
        this.statusReg = STATUS.BUSY | STATUS.DRQ;
        this.state = FDC_STATE.READ_TRANSFER;
    }

    // =========================================================================
    // Type IV: Force Interrupt
    // =========================================================================

    /**
     * Force Interrupt command. Terminates the command in progress: returns
     * the state to idle, clears DRQ, cancels the pending DRQ and the
     * remaining command delay. No further data request follows the
     * termination.
     * Status: when a command was in progress, its status is kept with only
     * BUSY (and DATA REQUEST) cleared; otherwise the Type I status (HEAD
     * ENGAGED, WRITE PROTECT, NOT READY, INDEX, TRACK00) is returned.
     * IRQ: I3 raises it at once; I0 / I1 / I2 arm the READY rising edge,
     * the READY falling edge and every index pulse (see
     * _checkForceIntConditions).
     * @param {number} cmd - Command byte ($D0-$DF)
     * @private
     */
    _forceInterrupt(cmd) {
        const conditions = cmd & 0x0F;

        this._note('stop', {
            code: hexByte(cmd), when: conditions, busy: this._seenLines.busy ? 1 : 0,
            moved: this._commandBytes,
        });

        const wasBusy = (this.statusReg & STATUS.BUSY) !== 0;

        // Abort current command. Cancel the scheduled DRQ and the remaining
        // delay as well, so that no DRQ is raised after the termination.
        this.state = FDC_STATE.IDLE;
        this.drqFlag = false;
        this._pendingDrq = false;
        this._drqTimer = 0;
        this._drqAge = 0;
        this.delayCycles = 0;

        if (wasBusy) {
            // Keep the status of the interrupted command; drop BUSY and,
            // for Type II/III, DATA REQUEST.
            let clear = STATUS.BUSY;
            if (this.commandType !== CMD_TYPE.TYPE_I) clear |= STATUS.DRQ;
            this.statusReg &= ~clear;
        } else {
            // Not executing: Type I status.
            this.commandType = CMD_TYPE.TYPE_I;
            this.statusReg = this._typeIDriveBits()
                           | (this._headLoaded ? STATUS.HEAD_ENGAGED : 0);
        }

        // I0 / I1 / I2 wait for their events; I3 interrupts at once.
        this._forceIntCond = conditions & 0x07;
        this._forceIntReady = !this._driveNotReady();
        if (conditions & 0x08) this._raiseForceInt();

        this._noteLines();
    }

    /** Raise the IRQ for a Force Interrupt condition. */
    _raiseForceInt() {
        this.irqFlag = true;
        if (this.onIntrqRise) {
            this.onIntrqRise();
        }
    }

    /**
     * Watch the armed Force Interrupt conditions: I0 = READY rising edge,
     * I1 = READY falling edge, I2 = every index pulse.
     * @param {boolean} indexPassed - the index position passed in this step
     * @private
     */
    _checkForceIntConditions(indexPassed) {
        const ready = !this._driveNotReady();
        let fire = false;
        if (ready !== this._forceIntReady) {
            if (ready && (this._forceIntCond & 0x01)) fire = true;
            if (!ready && (this._forceIntCond & 0x02)) fire = true;
            this._forceIntReady = ready;
        }
        if (indexPassed && (this._forceIntCond & 0x04) && ready && this.motorRunning) fire = true;
        if (fire) {
            this._raiseForceInt();
            this._noteLines();
        }
    }

    // =========================================================================
    // Command Completion
    // =========================================================================

    /**
     * Complete current command, set final status, raise IRQ.
     * @param {number} errorBits - Additional status bits to set
     * @private
     */
    _completeCommand(errorBits) {
        this.statusReg = errorBits & ~STATUS.BUSY; // Clear BUSY, set error bits
        this.drqFlag = false;
        this.state = FDC_STATE.IDLE;

        if (this.traceOn) {
            const words = this._statusWords(errorBits);
            this._note('end', {
                op: this._commandWord, status: hexByte(errorBits),
                bits: words.length ? words.join(',') : '-',
                tookUs: this._ticksToUs(this._traceTicks - this._commandSince),
                moved: this._commandBytes, lost: this._lostDataCount || 0,
            });
            this._noteLines();
        }

        // Assert IRQ
        this.irqFlag = true;
        if (this.onIntrqRise) {
            this.onIntrqRise();
        }
        this._noteLines();
    }

    // =========================================================================
    // Reset
    // =========================================================================

    /** Reset the FDC to initial state */
    reset() {
        this.statusReg = 0;
        this.trackReg = 0;
        this.sectorReg = 0;
        this.dataReg = 0;
        this.commandReg = 0;
        this.state = FDC_STATE.IDLE;
        this.commandType = 0;
        this.irqFlag = false;
        this.drqFlag = false;
        this._forceIntCond = 0;
        this._forceIntReady = false;
        this._pendingDrq = false;
        this._drqTimer = 0;
        this.motorRunning = false;
        this.driveDisabled = false;
        this._spinupRemaining = 0;
        this._settleRemaining = 0;
        this._headLoaded = false;
        this._stepped = false;
        this.hdMode = false;
        this.currentDrive = 0;
        this.currentSide = 0;
        this.stepDirection = 1;
        this.delayCycles = 0;
        this.dataBuffer = null;
        this.dataIndex = 0;
        this.dataLength = 0;
        this.headPosition = [0, 0, 0, 0];
        this.accessLatch = false;
    }
}
