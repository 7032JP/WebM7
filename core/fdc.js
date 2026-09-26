// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// MB8877 FDC Simulator + D77 Disk Image Parser for FM-7
// =============================================================================

import { decodeHFE } from './hfe.js';

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
    RNF_WAIT:           12,  // MB8877 5-index-pulse search before asserting RNF
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

// Accelerated seek step rates in CPU cycles, used in fast-read mode.
const STEP_RATES = [200, 400, 600, 1000];

// MB8877 step rates (6/12/20/30 ms), used outside fast-read mode.
// Expressed in µs; cycle values are derived per CPU clock in setCPUClock().
const STEP_RATES_REAL_US = [6000, 12000, 20000, 30000];

// D77 header size
const D77_HEADER_SIZE = 0x2B0;
const D77_TRACK_TABLE_OFFSET = 0x20;
const D77_MAX_TRACKS = 164;
const D77_SECTOR_HEADER_SIZE = 0x10;

// Sector size lookup by N value
const SECTOR_SIZES = [128, 256, 512, 1024];

// 2D raw image constants
const RAW_2D_SIZE = 327680;   // 40 tracks * 16 sectors * 256 bytes * 2 sides
const RAW_2DD_SIZE = 655360;  // 80 tracks * 16 sectors * 256 bytes * 2 sides
const RAW_1S_SIZE = 163840;   // 40 tracks * 16 sectors * 256 bytes * 1 side


// =============================================================================
// D77 Disk Image Parser
// =============================================================================

export class D77Disk {
    constructor() {
        this.name = '';
        this.writeProtect = false;
        this.mediaType = 0;
        this.diskSize = 0;
        this.numTracks = 0;
        this.numSides = 1;
        // sectors[track][side][sectorNum] = { c, h, r, n, data, size, density, deleted, status }
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

        // Parse disk name (17 bytes, null-terminated Shift-JIS)
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
        this.mediaType = bytes[0x1B];

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
        this.numTracks = Math.floor((maxTrackIndex + this.numSides) / this.numSides);

        this.sectors = {};

        // Parse each track
        for (let idx = 0; idx <= maxTrackIndex; idx++) {
            const trackOffset = trackOffsets[idx];
            if (trackOffset === 0) continue;

            const track = Math.floor(idx / this.numSides);
            const side = idx % this.numSides;

            if (!this.sectors[track]) this.sectors[track] = {};
            if (!this.sectors[track][side]) this.sectors[track][side] = {};

            let pos = trackOffset;
            if (pos >= buffer.byteLength) continue;

            // Read the first sector header to get number of sectors in this track
            if (pos + D77_SECTOR_HEADER_SIZE > buffer.byteLength) continue;

            const numSectors = view.getUint16(pos + 0x04, true);

            for (let s = 0; s < numSectors; s++) {
                if (pos + D77_SECTOR_HEADER_SIZE > buffer.byteLength) break;

                const c = bytes[pos + 0x00];       // Cylinder
                const h = bytes[pos + 0x01];       // Head
                const r = bytes[pos + 0x02];       // Sector number (R)
                const n = bytes[pos + 0x03];       // Size code (N)
                // numSectors at pos+0x04 already read
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

        let numSides;
        let numTracks;
        let mediaType;
        let name;
        if (size === RAW_2D_SIZE) {
            numSides = 2; numTracks = 40; mediaType = 0x00; name = 'RAW2D';
        } else if (size === RAW_2DD_SIZE) {
            numSides = 2; numTracks = 80; mediaType = 0x10; name = 'RAW2DD';
        } else if (size === RAW_1S_SIZE) {
            numSides = 1; numTracks = 40; mediaType = 0x00; name = 'RAW2D';
        } else {
            console.error(`FDC: Raw image size ${size} does not match 2D (${RAW_2D_SIZE}), 2DD (${RAW_2DD_SIZE}), or 1S (${RAW_1S_SIZE})`);
            return false;
        }

        this.name = name;
        this.writeProtect = false;
        this.mediaType = mediaType;
        this.diskSize = size;
        this.numTracks = numTracks;
        this.numSides = numSides;
        this.sectors = {};

        const sectorsPerTrack = 16;
        const sectorSize = 256;
        let pos = 0;

        for (let track = 0; track < numTracks; track++) {
            this.sectors[track] = {};
            for (let side = 0; side < numSides; side++) {
                this.sectors[track][side] = {};
                for (let sec = 1; sec <= sectorsPerTrack; sec++) {
                    const dataCopy = new Uint8Array(sectorSize);
                    dataCopy.set(bytes.subarray(pos, pos + sectorSize));

                    this.sectors[track][side][sec] = {
                        c: track,
                        h: side,
                        r: sec,
                        n: 1,       // 256 bytes
                        data: dataCopy,
                        size: sectorSize,
                        density: 0x00, // MFM
                        deleted: false,
                        status: 0x00,
                        physIdx: sec - 1,   // raw images are sequential (no interleave)
                    };

                    pos += sectorSize;
                }
            }
        }

        this.loaded = true;
        return true;
    }

    /**
     * Populate this disk from a decoded HFE structure (see hfe.js).
     * Sectors come straight from the MFM decoder.
     * @param {object} decoded - { numTracks, numSides, sectors, header }
     * @returns {boolean}
     */
    loadFromDecodedHFE(decoded) {
        if (!decoded || !decoded.sectors) return false;
        this.name = 'HFE';
        this.writeProtect = false;
        this.numSides = decoded.numSides;
        this.numTracks = decoded.numTracks;
        this.mediaType = decoded.numTracks > 45 ? 0x10 : 0x00; // 2DD vs 2D
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
    getSector(track, side, sectorNum) {
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
     * Logically format the disk for F-BASIC DISK BASIC use.
     *
     * A physically-formatted disk has all sectors present but their contents
     * are undefined, so DISK BASIC reads the FAT/directory area as garbage and
     * reports "0 free clusters" (cannot SAVE). This writes a valid empty
     * filesystem so the disk is immediately usable:
     *   - clears the write-protect flag,
     *   - writes the disk information record (cyl0/h0/sec3),
     *   - initialises the FAT (cyl1/h0/sec1-3) with every cluster free,
     *   - initialises the directory (cyl1/h0/sec4.. and cyl1/h1) as all empty.
     *
     * Layout follows the F-BASIC 2D disk format (FAT on cylinder 1, free
     * cluster marker 0xFF, 32-byte directory entries; an unused entry is all
     * 0xFF). The directory track is cylinder 1 for both 2D and 2DD.
     *
     * @returns {boolean} true on success
     */
    logicalFormat() {
        if (!this.sectors[0] || !this.sectors[1]) return false;
        const fill = (track, side, sec, value) => {
            const s = this.getSector(track, side, sec);
            if (s && s.data) s.data.fill(value);
            return s;
        };

        // (1) Clear write-protect.
        this.writeProtect = false;

        // (2) Disk information record: cyl0/h0/sec3, "S" signature + spaces.
        const sir = this.getSector(0, 0, 3);
        if (sir && sir.data) {
            sir.data.fill(0x00);
            sir.data[0] = 0x53; // 'S'
            sir.data[1] = 0x20; // ' '
            sir.data[2] = 0x20; // ' '
        }

        // (3) FAT and its copies: cyl1/h0/sec1-3, every cluster free (0xFF).
        for (const sec of [1, 2, 3]) fill(1, 0, sec, 0xFF);
        const fat = this.getSector(1, 0, 1);
        if (fat && fat.data) fat.data[0] = 0x00; // FAT control byte

        // (4) Directory: cyl1/h0/sec4..16 and cyl1/h1/sec1..16, all entries
        //     unused (0xFF).
        const lastSec = Math.max(...this.getSectorList(1, 0));
        for (let sec = 4; sec <= lastSec; sec++) fill(1, 0, sec, 0xFF);
        if (this.numSides > 1) {
            for (const sec of this.getSectorList(1, 1)) fill(1, 1, sec, 0xFF);
        }
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
        bytes[0x1B] = this.mediaType & 0xFF;
        view.setUint32(0x1C, fileSize, true);

        // Track offset table + track data.
        let pos = D77_HEADER_SIZE;
        for (const e of entries) {
            view.setUint32(D77_TRACK_TABLE_OFFSET + e.idx * 4, pos, true);
            const numSectors = e.secNums.length;
            for (const sn of e.secNums) {
                const sec = this.sectors[e.track][e.side][sn];
                bytes[pos + 0x00] = sec.c & 0xFF;
                bytes[pos + 0x01] = sec.h & 0xFF;
                bytes[pos + 0x02] = sec.r & 0xFF;
                bytes[pos + 0x03] = sec.n & 0xFF;
                view.setUint16(pos + 0x04, numSectors, true);
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
        // Multi-disk D77 containers: array of D77Disk per drive
        this.diskSlots     = [[], [], [], []];
        this.diskSlotIndex = [0, 0, 0, 0];

        // Currently selected drive and head
        this.currentDrive = 0;
        this.currentSide = 0;
        this.motorOn = false;
        // Cold spin-up model (opt-in via strictSpinup).  When the spindle
        // motor goes from stopped to running it needs time to reach 300 RPM;
        // Read/Seek issued during this window miss.  Lenient
        // default keeps the drive instantly ready.
        this.strictSpinup = false;
        this._spinupRemaining = 0;   // CPU cycles left until motor is up to speed
        this._settleRemaining = 0;   // 60 ms wait (drive register / head load / step) still pending; used only when fastReadMode is OFF
        this._headLoaded = false;
        this._stepped = false;
        this.onHwWarn = null;        // (code, message) => void
        this.densityFlag = false; // bit4 of $FD1C
        this.hdMode = false;     // $FD1E bit6: HD data rate (AV40+)

        // Drive type. Initial value is false (= 2D drive) on all models for
        // FM-7 compatibility.  AV20/AV40/AV20EX/AV40EX software switches to
        // 2DD by writing $FD1E bit6=0 (AV40 drive-mode register).  FM-7 and
        // FM77AV (無印) ignore $FD1E writes, so the drive stays 2D.
        this.driveModeIs2dd = false;
        // True when this machine wires $FD1E bit6 to the drive-mode flag
        // (AV20/AV40/AV20EX/AV40EX).  Set by fm7.js setMachineType.
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
            s: false,       // Side compare (Type II)
            e: false,       // Settle delay (Type II/III)
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
        this.delayCycles = 0;       // Remaining delay in CPU cycles (2MHz)
        this.cyclesToDrq = 0;       // Cycles between DRQ assertions

        // Fast-read mode selects accelerated STEP_RATES.
        // When disabled, use MB8877 timing (STEP_RATES_REAL).
        this.fastReadMode = true;

        // Disk rotation phase — tracks the angular position of the spinning
        // disk in CPU cycles.  300 RPM = 200 ms/revolution.  The phase wraps
        // at one full revolution and is advanced by step().  Used to compute
        // realistic rotational latency for sector find operations.
        this._rotationPhase = 0;

        // IRQ / DRQ status
        this.irqFlag = false;
        this.drqFlag = false;

        // Pending DRQ for byte-level transfer timing
        this._pendingDrq = false;
        this._drqTimer = 0;
        this._effectiveBytePeriod = 0;

        // D77 sector status (CRC errors etc.) for READ completion
        this._readStatusExtra = 0;

        // Callback for IRQ generation
        this.onIRQ = null;

        // Callbacks for FDD sound synthesis (see fdd_sound.js).
        // onSeekSound(steps) — Type I command, `steps` = number of physical
        //   track transitions the head will perform (0 if already on target).
        // onHeadLoadSound() — head load click: Type I with h=1, or any Type II/III.
        // Force Interrupt never triggers sound.
        this.onSeekSound     = null;
        this.onHeadLoadSound = null;
        this.onDiskInsert    = null;
        this.onDiskEject     = null;

        // Sector iteration for Read Address
        this.readAddrSectorIndex = 0;

        // ---- Diagnostic logging (OFF by default) ----
        this.logEnabled = false;
        this.log = [];
        this._logCycle = 0;              // Master cycle counter (monotonic)
        this._logDrqPrev = false;
        this._logIrqPrev = false;
        this._logBusyPrev = false;
        this._logBusyStart = 0;
        this._logCmdStart = 0;
        this._logCmdName = '';
        this._logCmdByte = 0;
        this._logByteCount = 0;          // Bytes transferred in current sector op
        this._logTotalBytes = 0;         // Bytes transferred in current multi-op
    }

    // =========================================================================
    // Logging helpers
    // =========================================================================

    _logCmdNameOf(cmd) {
        const h = cmd & 0xF0;
        if (h === 0x00) return 'RESTORE';
        if (h === 0x10) return 'SEEK';
        if (h === 0x20 || h === 0x30) return 'STEP';
        if (h === 0x40 || h === 0x50) return 'STEP_IN';
        if (h === 0x60 || h === 0x70) return 'STEP_OUT';
        if (h === 0x80) return 'READ_SEC';
        if (h === 0x90) return 'READ_MULTI';
        if (h === 0xA0) return 'WRITE_SEC';
        if (h === 0xB0) return 'WRITE_MULTI';
        if (h === 0xC0) return 'READ_ADDR';
        if (h === 0xD0) return 'FORCE_INT';
        if (h === 0xE0) return 'READ_TRACK';
        if (h === 0xF0) return 'WRITE_TRACK';
        return '???';
    }

    _logPush(entry) {
        if (!this.logEnabled) return;
        entry.cyc = this._logCycle;
        this.log.push(entry);
    }

    /** Detect and log DRQ/IRQ/BUSY edges since last call. */
    _logEdges() {
        if (!this.logEnabled) return;
        const drq = this.drqFlag;
        const irq = this.irqFlag;
        const busy = (this.statusReg & STATUS.BUSY) !== 0;
        if (drq !== this._logDrqPrev) {
            this.log.push({ cyc: this._logCycle, t: drq ? 'DRQ+' : 'DRQ-' });
            this._logDrqPrev = drq;
        }
        if (irq !== this._logIrqPrev) {
            this.log.push({ cyc: this._logCycle, t: irq ? 'IRQ+' : 'IRQ-' });
            this._logIrqPrev = irq;
        }
        if (busy !== this._logBusyPrev) {
            if (busy) {
                this._logBusyStart = this._logCycle;
                this.log.push({ cyc: this._logCycle, t: 'BUSY+' });
            } else {
                const dur = this._logCycle - this._logBusyStart;
                this.log.push({
                    cyc: this._logCycle, t: 'BUSY-',
                    durCyc: dur, durUs: +(dur / 2).toFixed(1),
                });
            }
            this._logBusyPrev = busy;
        }
    }

    /** Clear log and reset cycle counter. */
    clearLog() {
        this.log = [];
        this._logCycle = 0;
        this._logDrqPrev = this.drqFlag;
        this._logIrqPrev = this.irqFlag;
        this._logBusyPrev = (this.statusReg & STATUS.BUSY) !== 0;
        this._logBusyStart = 0;
        this._logByteCount = 0;
        this._logTotalBytes = 0;
    }

    /**
     * Format log as plain text, one event per line.
     * @param {Object} [opts]
     * @param {boolean} [opts.compress=true] Collapse consecutive identical
     *   events (same type + same details) into one line with ×N count.
     *   Dramatically shrinks $FD1F polling noise.
     * @param {string[]} [opts.skipTypes] Event type names to exclude
     *   (e.g. ['R','W']). Applied before compression.
     * @param {string[]} [opts.includeTypes] If set, only these event types
     *   are emitted (whitelist, takes precedence over skipTypes).
     * @param {string[]} [opts.skipReg] Register names to exclude from
     *   R/W events (e.g. ['IRQDRQ']). Non-R/W events are untouched.
     * @param {string[]} [opts.includeReg] If set, only R/W events whose
     *   reg matches are emitted (whitelist, takes precedence over skipReg).
     */
    dumpLogText(opts = {}) {
        const compress = opts.compress !== false;
        const skipTypes  = new Set(opts.skipTypes    || []);
        const inclTypes  = opts.includeTypes ? new Set(opts.includeTypes) : null;
        const skipReg    = new Set(opts.skipReg      || []);
        const inclReg    = opts.includeReg    ? new Set(opts.includeReg)    : null;
        const lines = [];
        lines.push('# WebM7 FDC log');
        lines.push('# cyc = cycles @ 2MHz (divide by 2 for µs)');
        lines.push(`# compress=${compress}`);
        if (inclTypes) lines.push(`# includeTypes=${[...inclTypes].join(',')}`);
        else if (skipTypes.size) lines.push(`# skipTypes=${[...skipTypes].join(',')}`);
        if (inclReg) lines.push(`# includeReg=${[...inclReg].join(',')}`);
        else if (skipReg.size) lines.push(`# skipReg=${[...skipReg].join(',')}`);
        lines.push('# columns: cyc\tevent\tdetails');
        const fmtDetails = (e) => {
            const d = [];
            for (const k of Object.keys(e)) {
                if (k === 'cyc' || k === 't') continue;
                d.push(`${k}=${e[k]}`);
            }
            return d.join(' ');
        };
        const keyOf = (e) => `${e.t || ''}|${fmtDetails(e)}`;
        const isRW = (e) => e.t === 'R' || e.t === 'W';
        const keep = (e) => {
            const t = e.t || '';
            if (inclTypes) { if (!inclTypes.has(t)) return false; }
            else if (skipTypes.has(t)) return false;
            if (isRW(e)) {
                const reg = e.reg || '';
                if (inclReg) { if (!inclReg.has(reg)) return false; }
                else if (skipReg.has(reg)) return false;
            }
            return true;
        };
        const filtered = this.log.filter(keep);
        if (!compress) {
            for (const e of filtered) {
                const parts = [e.cyc.toString(), e.t || ''];
                const d = fmtDetails(e);
                if (d) parts.push(d);
                lines.push(parts.join('\t'));
            }
        } else {
            let i = 0;
            const N = filtered.length;
            while (i < N) {
                const e = filtered[i];
                const k = keyOf(e);
                let j = i + 1;
                while (j < N && keyOf(filtered[j]) === k) j++;
                const run = j - i;
                const parts = [e.cyc.toString(), e.t || ''];
                const d = fmtDetails(e);
                if (d) parts.push(d);
                if (run > 1) {
                    parts.push(`×${run}`);
                    parts.push(`lastCyc=${filtered[j - 1].cyc}`);
                }
                lines.push(parts.join('\t'));
                i = j;
            }
        }
        return lines.join('\n') + '\n';
    }

    // Timing constants in microseconds (converted to CPU cycles dynamically)
    // 300 RPM = 200ms/revolution, 16 sectors/track
    // Average rotational latency: ~6000µs per sector
    static ROTATE_DELAY_US = 6000;
    // MFM byte transfer delay: 32µs per byte (250kbps DD)
    static BYTE_DELAY_US = 32;
    // Inter-sector gap delay for multi-sector reads/writes
    // Real disk: ~12.5ms between adjacent sectors (200ms / 16 sectors)
    static MULTI_SECTOR_GAP_US = 6000;
    // MB8877 RNF search window: 5 index pulses (5 revolutions at 300rpm = 1s)
    // The controller keeps BUSY asserted while scanning sector IDs; only after
    // 5 index pulses without a matching R does it set RNF and raise INTRQ.
    static RNF_TIMEOUT_US = 1000000;

    // CPU-clock-dependent cycle counts (set by setCPUClock)
    // Defaults match FM-7 clock (1.794 MHz = 1.794 cycles/µs)
    static ROTATE_DELAY = Math.round(6000 * 1.794);       // 10764
    static BYTE_DELAY = Math.round(32 * 1.794);           // 57
    static MULTI_SECTOR_GAP = Math.round(6000 * 1.794);   // 10764
    static RNF_TIMEOUT = Math.round(1000000 * 1.794);     // 1794000
    // Full revolution at 300 RPM = 200 ms
    static REVOLUTION_US = 200000;
    static REVOLUTION_CYCLES = Math.round(200000 * 1.794); // 358800
    // Realistic Type-I step delays (6/12/20/30 ms) in CPU cycles (per clock).
    static STEP_RATES_REAL = STEP_RATES_REAL_US.map(us => Math.round(us * 1.794));
    // Sectors per track (standard FM-7 2D/2DD format)
    static SECTORS_PER_TRACK = 16;
    // Cold spin-up time: motor needs roughly half a second to reach a stable
    // 300 RPM.  ~2.5 revolutions ≈ 500 ms is enough to model "read too early
    // after motor-on misses" without making the IPL feel sluggish.
    static SPINUP_US = 500000;
    static SPINUP_CYCLES = Math.round(500000 * 1.794); // 897000
    // E flag wait (Type II / III) is 30 ms; drive register write, head load
    // and step are each followed by a 60 ms wait (hardware spec).
    static E_SETTLE_US = 30000;
    static E_SETTLE_CYCLES = Math.round(30000 * 1.794);
    // fastReadMode ON: E flag wait stays at the accelerated value (~16.7 ms).
    static E_SETTLE_FAST_US = 16700;
    static E_SETTLE_FAST_CYCLES = Math.round(16700 * 1.794);
    // Wait after a seek finishes (fastReadMode OFF only): 20 ms when the head
    // moved, 300 us when it did not.
    static SEEK_END_MOVED_US = 20000;
    static SEEK_END_MOVED_CYCLES = Math.round(20000 * 1.794);
    static SEEK_END_STAY_US = 300;
    static SEEK_END_STAY_CYCLES = Math.round(300 * 1.794);
    static WAIT60_US = 60000;
    static WAIT60_CYCLES = Math.round(60000 * 1.794);

    /** Update timing constants for actual CPU clock frequency */
    static setCPUClock(hz) {
        const cpm = hz / 1000000;  // cycles per microsecond
        FDC.ROTATE_DELAY = Math.round(FDC.ROTATE_DELAY_US * cpm);
        FDC.BYTE_DELAY = Math.round(FDC.BYTE_DELAY_US * cpm);
        FDC.MULTI_SECTOR_GAP = Math.round(FDC.MULTI_SECTOR_GAP_US * cpm);
        FDC.RNF_TIMEOUT = Math.round(FDC.RNF_TIMEOUT_US * cpm);
        FDC.REVOLUTION_CYCLES = Math.round(FDC.REVOLUTION_US * cpm);
        FDC.SPINUP_CYCLES = Math.round(FDC.SPINUP_US * cpm);
        FDC.E_SETTLE_CYCLES = Math.round(FDC.E_SETTLE_US * cpm);
        FDC.WAIT60_CYCLES = Math.round(FDC.WAIT60_US * cpm);
        FDC.E_SETTLE_FAST_CYCLES = Math.round(FDC.E_SETTLE_FAST_US * cpm);
        FDC.SEEK_END_MOVED_CYCLES = Math.round(FDC.SEEK_END_MOVED_US * cpm);
        FDC.SEEK_END_STAY_CYCLES = Math.round(FDC.SEEK_END_STAY_US * cpm);
        FDC.STEP_RATES_REAL = STEP_RATES_REAL_US.map(us => Math.round(us * cpm));
    }

    /**
     * Effective Type-I step delay in CPU cycles for the current step-rate flag.
     * Fast-read mode ON → accelerated STEP_RATES; OFF → realistic MB8877 rates.
     */
    _stepDelayCycles() {
        return this.fastReadMode
            ? STEP_RATES[this.cmdFlags.r]
            : FDC.STEP_RATES_REAL[this.cmdFlags.r];
    }

    // =========================================================================
    // Disk Management
    // =========================================================================

    /**
     * Load a disk image into a drive.
     * Automatically detects D77 vs raw 2D format.
     * @param {number} driveNum - Drive number (0-3)
     * @param {ArrayBuffer} arrayBuffer - Disk image data
     * @returns {boolean} true if loaded successfully
     */
    loadDisk(driveNum, arrayBuffer) {
        if (driveNum < 0 || driveNum > 3) {
            console.error(`FDC: Invalid drive number ${driveNum}`);
            return false;
        }

        const slots = [];

        // HFE (bit-stream floppy image, v1): MFM-decode into sectors and report
        // any track-length problems that would stop the medium booting on real
        // hardware.  Detected by the format signature "HXCPICFE".
        if (arrayBuffer.byteLength >= 8) {
            const sig = new Uint8Array(arrayBuffer, 0, 8);
            if (String.fromCharCode(...sig) === 'HXCPICFE') {
                const decoded = decodeHFE(arrayBuffer);
                if (decoded) {
                    for (const w of decoded.warnings) {
                        if (typeof this.onHwWarn === 'function') this.onHwWarn('hfe-track-length', w.message);
                        else console.warn(`[FDC/HFE] ${w.message}`);
                    }
                    const d = new D77Disk();
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
                const d = new D77Disk();
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

        // Fallback: raw 2D
        if (slots.length === 0) {
            const d = new D77Disk();
            if (d.parseRaw2D(arrayBuffer)) slots.push(d);
        }

        if (slots.length === 0) {
            console.error(`FDC: Failed to load disk in drive ${driveNum}`);
            return false;
        }

        this.diskSlots[driveNum] = slots;
        this.diskSlotIndex[driveNum] = 0;
        this.disks[driveNum] = slots[0];

        if (slots.length > 1) {
            console.log(`FDC: Drive ${driveNum}: Multi-disk D77 container, ${slots.length} disks: [${slots.map(s => `"${s.name}"`).join(', ')}]`);
        } else {
            const d = slots[0];
            console.log(`FDC: Drive ${driveNum}: Disk loaded - "${d.name}", ${d.numTracks} tracks, ${d.numSides} side(s)`);
        }
        if (this.onDiskInsert) this.onDiskInsert(driveNum);
        return true;
    }

    /**
     * Select an alternate disk from a multi-disk D77 container.
     * @param {number} driveNum
     * @param {number} diskIdx - 0-based index into diskSlots
     * @returns {boolean} true if switched
     */
    selectDisk(driveNum, diskIdx) {
        if (driveNum < 0 || driveNum > 3) return false;
        const slots = this.diskSlots[driveNum];
        if (!slots || diskIdx < 0 || diskIdx >= slots.length) return false;
        this.diskSlotIndex[driveNum] = diskIdx;
        this.disks[driveNum] = slots[diskIdx];
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
     * @returns {{type:string,cylinders:number,sides:number,sectorsPerTrack:number,sectorSize:number}|null}
     *          null when no disk is loaded.
     */
    getGeometry(driveNum) {
        const d = this.disks[driveNum];
        if (!d || !d.loaded) return null;
        const cylinders = d.numTracks || 0;
        const sides = d.numSides || 1;
        // Inspect the first populated track to derive sectors-per-track and
        // sector size. Falls back to 0 when the structure is empty.
        let sectorsPerTrack = 0;
        let sectorSize = 0;
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
                sectorsPerTrack = secKeys.length;
                const first = secObj[secKeys[0]];
                sectorSize = (first && first.size) ? first.size : 0;
                break;
            }
            if (sectorsPerTrack > 0) break;
        }
        // 2D vs 2DD by track count (2DD doubles the track density to ~80).
        const type = cylinders > 45 ? '2DD' : '2D';
        return { type, cylinders, sides, sectorsPerTrack, sectorSize };
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
            if (hadDisk && this.onDiskEject) this.onDiskEject(driveNum);
        }
    }

    /**
     * Get the currently selected disk object.
     * @returns {D77Disk|null}
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
                    if (this.logEnabled) {
                        this._logByteCount++;
                        this._logTotalBytes++;
                        extra = { idx: this._logByteCount };
                    }
                    this._advanceRead(elapsedSinceDrq);
                } else {
                    value = this.dataReg;
                }
                break;

            case 0xFD1C: // Side register readback (bits 7-1 read as 1)
                value = this.currentSide | 0xFE;
                break;

            case 0xFD1D: // Drive select readback
                value = (this.currentDrive & 0x03) | (this.motorOn ? 0x80 : 0x00);
                break;

            case 0xFD1F: // DRQ/IRQ status
                // bit 7: DRQ, bit 6: IRQ
                value = (this.drqFlag ? 0x80 : 0x00) | (this.irqFlag ? 0x40 : 0x00);
                break;

            default:
                value = 0xFF;
                break;
        }

        if (this.logEnabled) {
            const name = { 0xFD18: 'STA', 0xFD19: 'TRK', 0xFD1A: 'SEC',
                           0xFD1B: 'DAT', 0xFD1C: 'SID', 0xFD1D: 'DRV',
                           0xFD1F: 'IRQDRQ' }[addr] || ('$' + addr.toString(16));
            const e = { cyc: this._logCycle, t: 'R', reg: name, val: '$' + (value & 0xFF).toString(16).padStart(2, '0') };
            if (extra) Object.assign(e, extra);
            this.log.push(e);
            this._logEdges();
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

        if (this.logEnabled) {
            const name = { 0xFD18: 'CMD', 0xFD19: 'TRK', 0xFD1A: 'SEC',
                           0xFD1B: 'DAT', 0xFD1C: 'SID', 0xFD1D: 'DRV' }[addr]
                         || ('$' + addr.toString(16));
            const e = { cyc: this._logCycle, t: 'W', reg: name, val: '$' + value.toString(16).padStart(2, '0') };
            if (addr === 0xFD18) e.cmd = this._logCmdNameOf(value);
            this.log.push(e);
        }

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
                    if (this.logEnabled) {
                        this._logByteCount++;
                        this._logTotalBytes++;
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
                }
                {
                    const newMotor = (value & 0x80) !== 0;
                    // Stopped -> running: start the cold spin-up window.
                    if (newMotor && !this.motorOn && this.strictSpinup) {
                        this._spinupRemaining = FDC.SPINUP_CYCLES;
                    } else if (!newMotor) {
                        this._spinupRemaining = 0;
                    }
                    this.motorOn = newMotor;
                }
                break;

            case 0xFD1E: // AV40 drive-mode register (AV20+ only)
                // bit6 selects drive type (inverted):
                //   bit6=1 → 2D drive mode (FM-7 compatible)
                //   bit6=0 → 2DD drive mode
                // FM-7 and FM77AV (無印) ignore this write entirely.
                if (this.supportsDriveModeSwitch) {
                    this.driveModeIs2dd = (value & 0x40) === 0;
                }
                this.hdMode = (value & 0x40) !== 0;
                break;

            default:
                break;
        }

        if (this.logEnabled) this._logEdges();
    }

    // =========================================================================
    // State Machine Step
    // =========================================================================

    /**
     * Advance the FDC state machine by the given number of CPU cycles.
     * Call this from the main emulation loop.
     * @param {number} cycles - Number of CPU cycles elapsed (at 2MHz)
     */
    step(cycles) {
        if (this.logEnabled) this._logCycle += cycles;

        // Advance disk rotation phase (continuous, wraps at one revolution)
        this._rotationPhase = (this._rotationPhase + cycles) % FDC.REVOLUTION_CYCLES;

        // Burn down the cold spin-up window while the motor is running.
        if (this._spinupRemaining > 0 && this.motorOn) {
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
            if (this.logEnabled) this._logEdges();
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
                // (In practice, step() ensures DRQ timing; the actual data movement
                // happens in readIO for $FD1B.)
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
                // Not commonly used; stub
                this._completeCommand(0);
                break;

            case FDC_STATE.WRITE_TRACK:
                // Data-driven by CPU writes to $FD1B (see _writeTrackByte).
                // WRITE TRACK is treated as lasting one disk revolution
                // (index pulse to the next index pulse).
                // We accumulate elapsed cycles from command start and complete
                // after one revolution, regardless of how many bytes the CPU
                // managed to feed.  DRQ is paced at BYTE_DELAY (see
                // _reqNextTrackByte) so the CPU feeds ~one track's worth of
                // bytes per revolution, which keeps the format routine from
                // over-running its track buffer.
                this._wtElapsed = (this._wtElapsed || 0) + (cycles || 0);
                if (this._wtElapsed >= FDC.REVOLUTION_CYCLES) {
                    this._completeCommand(0);
                }
                break;

            case FDC_STATE.RNF_WAIT:
                // 5-index-pulse search window elapsed without matching sector.
                this._completeCommand(STATUS.RNF);
                break;
        }
        if (this.logEnabled) this._logEdges();
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

        if (this.logEnabled) {
            this._logCmdByte = cmd;
            this._logCmdName = this._logCmdNameOf(cmd);
            this._logCmdStart = this._logCycle;
            this._logByteCount = 0;
            this._logTotalBytes = 0;
            this.log.push({
                cyc: this._logCycle, t: 'CMD',
                cmd: this._logCmdName,
                byte: '$' + cmd.toString(16).padStart(2, '0'),
                trk: this.trackReg, sec: this.sectorReg,
                drv: this.currentDrive, side: this.currentSide,
                pos: this.headPosition[this.currentDrive],
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

        // Set access latch for UI LED
        this.accessLatch = true;

        // Set BUSY
        this.statusReg = STATUS.BUSY;
        this.drqFlag = false;

        // Strict: 回転待ちの間は NOT_READY を返す。
        if (this.strictSpinup && this._spinupRemaining > 0) {
            if (typeof this.onHwWarn === 'function') {
                this.onHwWarn('fdc-spinup',
                    `FDC command $${cmd.toString(16).padStart(2,'0')} issued during motor spin-up (${Math.round(this._spinupRemaining / 1.794)}us left); spin-up wait is active`);
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

            // FDD sound: compute how many physical steps this command will make,
            // then fire the seek-sound callback BEFORE Restore overwrites trackReg.
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
            this.cmdFlags.a0 = (cmd & 0x01) !== 0; // DAM flag for write

            // FDD sound: head-load click for any Type II command.
            if (this.onHeadLoadSound) this.onHeadLoadSound();

            // No disk inserted: return NOT_READY.
            // MB8877 reports NOT_READY when drive has no media.
            // Software may check NOT_READY to skip disk boot.
            if (!this.currentDisk || !this.currentDisk.loaded) {
                this._completeCommand(STATUS.NOT_READY);
                return;
            }

            // Apply settle delay if E flag set.
            // The head-settle time elapses BEFORE the controller starts
            // scanning ID fields, so the rotational wait to the target
            // sector must be measured from the post-settle disk phase.
            // (Computing latency first and then adding the settle time
            // would start the transfer 15ms past the sector's angular
            // position and systematically miss the following sector.)
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

            if (!this.currentDisk || !this.currentDisk.loaded) {
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
            if (!this.currentDisk || !this.currentDisk.loaded) {
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
            if (!this.currentDisk || !this.currentDisk.loaded) {
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

    /**
     * Compute rotational latency to reach the target sector from the
     * current disk rotation phase.  The disk spins
     * continuously at 300 RPM; the time to reach a given sector depends
     * on where the head is in the rotation when the command is issued.
     *
     * 300 RPM = 200 ms / revolution, 16 sectors / track.
     * Sector N occupies a fixed arc: offset = N * (revolution / 16).
     * Latency = (sector_offset - current_phase) mod revolution.
     *
     * Returns the rotational latency in CPU cycles for each sector read.
     */
    _rotationalLatency(phaseOffsetCycles = 0) {
        const rev = FDC.REVOLUTION_CYCLES;
        // Use the physical sector order from the image for rotational latency.
        let slot = (this.sectorReg - 1) & 0x0F;   // fallback: logical numbering
        let spt = FDC.SECTORS_PER_TRACK;
        const disk = this.currentDisk;
        if (disk && disk.getSector) {
            const track = this._mediaTrackIndex();
            const sec = track < 0 ? null
                : disk.getSector(track, this.currentSide, this.sectorReg);
            if (sec && sec.physIdx !== undefined) {
                slot = sec.physIdx;
                const n = disk.getSectorList(track, this.currentSide).length;
                if (n > 0) spt = n;
            }
        }
        const sectorSlot = rev / spt;   // cycles per sector slot
        const sectorOffset = slot * sectorSlot;
        // Time from current phase until the sector header passes under head.
        // phaseOffsetCycles: cycles that will elapse before the search
        // actually begins (e.g. E-flag head settle) — measure from there.
        const phase = (this._rotationPhase + phaseOffsetCycles) % rev;
        let latency = Math.round(sectorOffset - phase);
        if (latency < 0) latency += rev;
        // Minimum latency: at least ~1 ms for controller overhead
        const minCycles = Math.round(rev / (spt * 4));  // ~3125 @ 2MHz
        if (latency < minCycles) latency += rev;
        return latency;
    }

    // =========================================================================
    // Type I: Seek / Step
    // =========================================================================

    /**
     * Wait before a Type II / III command starts scanning: E flag (30 ms,
     * or the accelerated value when fastReadMode is ON)
     * plus, when fastReadMode is OFF, the pending 60 ms of drive register
     * write / step and the head load if the head is not loaded yet.
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
     * Wait in cycles after a seek has finished.  fastReadMode ON keeps the
     * short fixed waits; OFF uses 20 ms (head moved) / 300 us (no movement).
     */
    _seekEndDelay(moved) {
        if (this.fastReadMode) return moved ? 2000 : (this.cmdFlags.v ? 2000 : 200);
        return moved ? FDC.SEEK_END_MOVED_CYCLES : FDC.SEEK_END_STAY_CYCLES;
    }

    /** Restore: step out until track 0 */
    _beginSeekRestore() {
        this.stepDirection = -1;
        const pos = this.headPosition[this.currentDrive];
        if (pos === 0) {
            // The controller asserts BUSY briefly even when already at track 0.
            this.trackReg = 0;
            this.headPosition[this.currentDrive] = 0;
            this.delayCycles = this._seekEndDelay(false);
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
            // Already at target. Defer completion so polling loops that
            // wait for BUSY=1 can observe the transient (see comment in
            // _beginSeekRestore). Use a minimal 200-cycle delay.
            this.trackReg = target;
            this.delayCycles = this._seekEndDelay(false);
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
        // directionSet: whether to change stepDirection (Step In/Out set it, plain Step doesn't)
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
                    this.delayCycles = this._seekEndDelay(true);
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
                    this.delayCycles = this._seekEndDelay(true);
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
                this.delayCycles = this._seekEndDelay(true);
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
        let status = 0;

        // Track 0 bit
        if (this.headPosition[this.currentDrive] === 0) {
            status |= STATUS.TRACK0;
        }

        // Head engaged
        if (this.cmdFlags.h) {
            status |= STATUS.HEAD_ENGAGED;
        }

        if (!this.fastReadMode && (this._stepped || this.cmdFlags.h)) {
            this._settleRemaining = FDC.WAIT60_CYCLES;
        }
        if (this.cmdFlags.h) this._headLoaded = true;
        this._stepped = false;

        // Drive is always READY for Type I commands — drives are physically
        // present.  "No disk" is detected by RNF on Type II/III, not NOT_READY.

        this._completeCommand(status);
    }

    // =========================================================================
    // Type II: Read Sector
    // =========================================================================

    /**
     * Map the physical head position (step counter) to the media track
     * index, honouring the drive-mode ($FD1E) vs media-type combination:
     *   - 2DD drive-mode + 2D media : the drive half-steps relative to the
     *     media pitch; odd head positions sit between tracks (returns -1).
     *   - 2D drive-mode + 2DD media : the drive double-steps, so the media
     *     cylinder is twice the head position.
     * Matching mode/media returns the head position unchanged.
     */
    _mediaTrackIndex() {
        const disk = this.currentDisk;
        const pos = this.headPosition[this.currentDrive];
        if (!disk) return pos;
        const mediaIs2DD = (disk.mediaType === 0x10);
        if (this.driveModeIs2dd && !mediaIs2DD) {
            if (pos & 1) return -1;          // between 2D tracks
            return pos >> 1;
        }
        if (!this.driveModeIs2dd && mediaIs2DD) {
            return (pos << 1) & 0xFF;        // double-step
        }
        return pos;
    }

    /** Begin reading sector data after finding sector */
    _startReadTransfer() {
        const disk = this.currentDisk;
        if (!disk) {
            this._completeCommand(STATUS.RNF);
            return;
        }

        // Look up the sector on the CURRENT physical track by sector number.
        // MB8877/WD1793 READ SECTOR scans address fields on the physical track.
        // The FDC compares each sector ID's C field against the Track Register
        // and R field against the Sector Register.  Only when both match does
        // the data transfer begin.  If no matching ID is found within 5 index
        // pulses, RNF is asserted.
        // Drive vs media type compensation (reference: MB8877 / WD279x).
        // D77 header byte 0x1B: 0x00=2D, 0x10=2DD, 0x20=2HD.
        // The step counter is mapped to the media track (2D-mode drive on
        // 2DD media double-steps; 2DD-mode drive on 2D media half-steps and
        // odd positions sit between tracks). The ID C-field of the sector on
        // that media track must still match the Track Register, exactly as
        // on the real controller.
        const physTrack = this._mediaTrackIndex();
        const side = this.currentSide;
        const sectorNum = this.sectorReg;
        const mismatchRNF = (physTrack < 0);

        const sector = mismatchRNF ? null : disk.getSector(physTrack, side, sectorNum);
        if (mismatchRNF || !sector || sector.c !== this.trackReg) {
            if (this.logEnabled) {
                this.log.push({
                    cyc: this._logCycle, t: 'FIND_RNF',
                    physTrk: physTrack, tr: this.trackReg,
                    side, sec: sectorNum,
                    has: !sector ? 'none' : `C${sector.c}`,
                });
            }
            // MB8877: on missing sector, keep BUSY asserted while searching
            // for 5 index pulses (5 revolutions ≈ 1 s at 300rpm), then assert
            // RNF + INTRQ.
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }
        if (this.logEnabled) {
            this.log.push({
                cyc: this._logCycle, t: 'FIND_OK',
                physTrk: physTrack, side, sec: sectorNum,
                size: sector.size,
                d77status: '$' + (sector.status || 0).toString(16).padStart(2, '0'),
                deleted: sector.deleted ? 1 : 0,
            });
            this._logByteCount = 0;
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
        // D77 status field: reflect errors to FDC status.
        // D77 dumps record abnormal sectors as various non-zero status
        // values ($B0, $E0, $10, etc.). Any non-zero value sets CRC_ERROR.
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
     *   that the CPU just consumed.  Bytes arrive from the
     *   spinning disk at fixed intervals (BYTE_DELAY).  If the CPU reads the
     *   data register quickly, the remaining time until the *next* byte is
     *   shorter than a full BYTE_DELAY.  Accounting for this prevents
     *   artificially inflating the DRQ-to-DRQ gap and keeps software timing
     *   loops (which poll $FD1F between bytes) in spec.
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
                if (this.logEnabled) {
                    const secEnd = {
                        cyc: this._logCycle, t: 'SEC_END',
                        readBytes: this._logByteCount,
                        nextSec: (this.sectorReg + 1) & 0xFF,
                    };
                    if (this._lostDataCount > 0) secEnd.lostBytes = this._lostDataCount;
                    this.log.push(secEnd);
                }
                this._lostDataCount = 0;
                this.sectorReg++;
                this.drqFlag = false;
                this.statusReg = STATUS.BUSY;  // BUSY but no DRQ during gap
                this.state = FDC_STATE.READ_FIND_SECTOR;
                this.delayCycles = FDC.MULTI_SECTOR_GAP;
            } else {
                // Single sector: done (include D77 sector status like CRC errors)
                // Also report LOST_DATA in final status (real WD279x does this)
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

        const track = this._mediaTrackIndex();
        const side = this.currentSide;
        const sectorNum = this.sectorReg;

        const sector = track < 0 ? null : disk.getSector(track, side, sectorNum);
        if (!sector || sector.c !== this.trackReg) {
            // MB8877: C field must match track register (same as read path).
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }

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
        const track = this._mediaTrackIndex();
        const side = this.currentSide;
        this._wtTrack = track;
        this._wtSide = side;
        // Sectors physically present on this track (image is pre-formatted).
        this._wtExpectSectors = track < 0 ? 0
            : this.currentDisk.getSectorList(track, side).length;
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
     * Schedule the next WRITE TRACK DRQ one byte-period in the future.
     * Pacing the data request at BYTE_DELAY (like the data-rate of a real
     * drive) limits the CPU to ~one track's worth of bytes per revolution,
     * so its format loop feeds its track buffer exactly once instead of
     * spinning at full CPU speed and over-running the buffer.
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
     * Address marks: 0xFE = ID (next 4 bytes C,H,R,N), 0xFB/0xF8 = Data
     * (followed by 128<<N data bytes).  Gap/sync/CRC bytes (0x4E, 0x00,
     * 0xF5, 0xF6, 0xF7, 0xFC, …) carry no sector data and are skipped.
     */
    _writeTrackByte(b) {
        this._wtBytes++;
        this._writeTrackIdle = 0;
        if (this.currentDisk) this.currentDisk.dirty = true;

        if (this._wtPhase === 'data') {
            if (this._wtSector && this._wtDataIndex < this._wtSector.size) {
                this._wtSector.data[this._wtDataIndex] = b;
            }
            this._wtDataIndex++;
            this._wtDataRemaining--;
            if (this._wtDataRemaining <= 0) {
                // Sector data field captured.  Return to gap scanning and keep
                // accepting bytes — WRITE TRACK is treated as lasting a full
                // revolution (until the index pulse), so we let the CPU feed the
                // trailing gap.  Completion happens via the idle timeout in
                // step() once the CPU stops writing (or the safety cap below).
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
            this._wtSector = this.currentDisk.getSector(this._wtTrack, this._wtSide, r);
            this._wtDataRemaining = 128 << n;
            this._wtDataIndex = 0;
            this._wtPhase = 'data';
            this._wtIdReady = false;
        }

        // Safety cap (~2× a 2D track's raw capacity) in case the stream never
        // describes the expected sector count, to avoid stalling forever.
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

        const track = this._mediaTrackIndex();
        const side = this.currentSide;
        // ID フィールドは常にヘッドの下を通る順 (物理順) で返す。
        // fastReadMode の ON/OFF には依存しない。
        const sectorList = track < 0 ? [] : disk.getPhysicalOrder(track, side);

        if (sectorList.length === 0) {
            if (this.logEnabled) {
                this.log.push({ cyc: this._logCycle, t: 'RADDR_RNF', physTrk: track, side });
            }
            // MB8877: unformatted track — search 5 index pulses before RNF.
            this.statusReg = STATUS.BUSY;
            this.drqFlag = false;
            this.state = FDC_STATE.RNF_WAIT;
            this.delayCycles = FDC.RNF_TIMEOUT;
            return;
        }
        if (this.logEnabled) {
            const idx = this.readAddrSectorIndex % sectorList.length;
            this.log.push({
                cyc: this._logCycle, t: 'READ_ADDR',
                physTrk: track, side, retSec: sectorList[idx],
                listLen: sectorList.length,
            });
        }

        // Rotate through sectors on each Read Address call
        const sectorIdx = this.readAddrSectorIndex % sectorList.length;
        this.readAddrSectorIndex++;
        const sectorNum = sectorList[sectorIdx];
        const sector = disk.getSector(track, side, sectorNum);

        // Build 6-byte ID field: C, H, R, N, CRC1, CRC2
        this.idBuffer = new Uint8Array(6);
        this.idBuffer[0] = sector.c;
        this.idBuffer[1] = sector.h;
        this.idBuffer[2] = sector.r;
        this.idBuffer[3] = sector.n;
        this.idBuffer[4] = 0x00; // CRC (dummy)
        this.idBuffer[5] = 0x00;

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
     * Force Interrupt command - aborts current operation.
     * @param {number} cmd - Command byte ($D0-$DF)
     * @private
     */
    _forceInterrupt(cmd) {
        const conditions = cmd & 0x0F;

        if (this.logEnabled) {
            this.log.push({
                cyc: this._logCycle, t: 'FORCE_INT',
                byte: '$' + cmd.toString(16).padStart(2, '0'),
                cond: '$' + conditions.toString(16),
                wasBusy: (this._logBusyPrev ? 1 : 0),
                bytesSoFar: this._logTotalBytes,
            });
        }

        // Abort current command
        this.state = FDC_STATE.IDLE;
        this.drqFlag = false;

        // Build status as if Type I (track 0, etc.)
        // Drive is always READY (physically present)
        this.statusReg = 0;
        if (this.headPosition[this.currentDrive] === 0) {
            this.statusReg |= STATUS.TRACK0;
        }

        if (conditions !== 0) {
            // Generate interrupt immediately for $D8 (immediate interrupt)
            this.irqFlag = true;
            if (this.onIRQ) {
                this.onIRQ();
            }
        }

        if (this.logEnabled) this._logEdges();
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

        if (this.logEnabled) {
            const dur = this._logCycle - this._logCmdStart;
            const flags = [];
            if (errorBits & STATUS.RNF) flags.push('RNF');
            if (errorBits & STATUS.CRC_ERROR) flags.push('CRC');
            if (errorBits & STATUS.LOST_DATA) flags.push('LOST');
            if (errorBits & STATUS.WRITE_PROTECT) flags.push('WP');
            if (errorBits & STATUS.NOT_READY) flags.push('NRDY');
            if (errorBits & STATUS.RECORD_TYPE) flags.push('DDM');
            const entry = {
                cyc: this._logCycle, t: 'DONE',
                cmd: this._logCmdName,
                status: '$' + (errorBits & 0xFF).toString(16).padStart(2, '0'),
                flags: flags.length ? flags.join('|') : 'OK',
                durCyc: dur, durUs: +(dur / 2).toFixed(1),
                bytes: this._logTotalBytes,
            };
            if (this._lostDataCount > 0) entry.lostBytes = this._lostDataCount;
            this.log.push(entry);
            this._logEdges();
        }

        // Assert IRQ
        this.irqFlag = true;
        if (this.onIRQ) {
            this.onIRQ();
        }
        if (this.logEnabled) this._logEdges();
    }

    // =========================================================================
    // Drive Status ($FD1C read)
    // =========================================================================

    /**
     * Read drive status register.
     * @returns {number} Status byte
     * @private
     */
    _readDriveStatus() {
        let status = 0;

        // Bit 7: 1 = drive not ready / motor off
        // Drive is always physically present; motor-off — or, in strict mode,
        // a motor that has not finished spinning up — means not ready.
        if (!this.motorOn || (this.strictSpinup && this._spinupRemaining > 0)) {
            status |= 0x80;
        }

        // Bit 6: write protect
        if (this.currentDisk && this.currentDisk.writeProtect) {
            status |= 0x40;
        }

        // Bit 2: track 0
        if (this.headPosition[this.currentDrive] === 0) {
            status |= 0x04;
        }

        // Bit 1: index pulse (simulate: toggle based on timing, always return 0 for simplicity)
        // Bit 0: side selected
        status |= (this.currentSide & 0x01);

        return status;
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
        this._pendingDrq = false;
        this._drqTimer = 0;
        this.motorOn = false;
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
        this.readAddrSectorIndex = 0;
        this.accessLatch = false;
    }
}
