// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// HFE floppy-image support (HFE v1 bit-stream floppy image format)
//
// Floppy-drive emulator hardware feeds the drive a raw
// MFM bit-cell stream taken from an .hfe file.  Unlike a sector image (.d77),
// an HFE preserves the *physical* track: gaps, sync marks and — crucially —
// the total track length.  A hand-authored track whose MFM length overruns the
// nominal bytes-per-side will pass a sector CRC check yet fail to boot on the
// real machine, because the index pulse arrives before the controller finishes
// the track.
//
// This module:
//   * parses HFE v1 (format signature "HXCPICFE"),
//   * de-interleaves the two sides and reports the per-side track length,
//   * validates those lengths against the nominal bytes/side derived from the
//     bit rate and spindle RPM (the check that catches "over-length" media),
//   * MFM-decodes the stream into sectors so the image can actually be booted,
//   * and can MFM-encode/build an HFE (used by the headless tests and for any
//     future D77 -> HFE export).
//
// Bit order follows the HFE format convention: within each stored byte the
// least significant bit is the first bit in time.
// =============================================================================

const HFE_SIGNATURE = 'HXCPICFE';

// Sync marks expressed as 16-cell MFM patterns (first-in-time = most
// significant bit of the listed value).
const SYNC_A1 = 0x4489; // data 0xA1 with one suppressed clock (IDAM/DAM sync)

// ---------------------------------------------------------------------------
// CRC-16/CCITT (poly 0x1021, init 0xFFFF) over the byte sequence including the
// three A1 sync bytes and the address/data mark.
// ---------------------------------------------------------------------------
function crc16(bytes) {
    let crc = 0xFFFF;
    for (const b of bytes) {
        crc ^= (b & 0xFF) << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc & 0xFFFF;
}

// ---------------------------------------------------------------------------
// Bit buffer — accumulates MFM cells in time order and packs them LSB-first.
// ---------------------------------------------------------------------------
class BitWriter {
    constructor() { this.bits = []; }
    cell(b) { this.bits.push(b & 1); }
    // Push a 16-cell sync pattern given MSB-first.
    sync16(pattern) {
        for (let i = 15; i >= 0; i--) this.cell((pattern >> i) & 1);
    }
    toBytes() {
        const out = new Uint8Array(Math.ceil(this.bits.length / 8));
        for (let i = 0; i < this.bits.length; i++) {
            if (this.bits[i]) out[i >> 3] |= (1 << (i & 7)); // LSB-first
        }
        return out;
    }
    get length() { return this.bits.length; }
}

function bitOf(bytes, idx) {
    return (bytes[idx >> 3] >> (idx & 7)) & 1; // LSB-first
}

// ---------------------------------------------------------------------------
// MFM encode one data byte (MSB-first) onto a BitWriter, maintaining the
// running "previous data bit" needed for clock generation.
// ---------------------------------------------------------------------------
function encodeByte(bw, value, state) {
    for (let i = 7; i >= 0; i--) {
        const d = (value >> i) & 1;
        const clock = (state.prev === 0 && d === 0) ? 1 : 0;
        bw.cell(clock);
        bw.cell(d);
        state.prev = d;
    }
}

// ---------------------------------------------------------------------------
// Build a single side's MFM bitstream for a list of sectors in IBM System 34
// (double-density) track layout.  `padTo` (bytes) pads the trailing gap so the
// track reaches a target physical length — used by tests to synthesise both
// well-formed and deliberately over-length tracks.
// ---------------------------------------------------------------------------
export function encodeMFMTrack(sectors, opts = {}) {
    const bw = new BitWriter();
    const state = { prev: 0 };
    const gapByte = (n) => { for (let i = 0; i < n; i++) encodeByte(bw, 0x4E, state); };
    const sync00 = (n) => { for (let i = 0; i < n; i++) encodeByte(bw, 0x00, state); };

    gapByte(opts.gap0 ?? 80);            // post-index gap (Gap 4a)
    sync00(12);                          // sync
    // (IAM omitted — FM-7 sector reads only need IDAM/DAM)

    for (const s of sectors) {
        gapByte(opts.gap1 ?? 22);        // Gap 1 / Gap 3
        sync00(12);
        // --- ID field ---
        bw.sync16(SYNC_A1); state.prev = 1;
        bw.sync16(SYNC_A1); state.prev = 1;
        bw.sync16(SYNC_A1); state.prev = 1;
        const idBytes = [0xA1, 0xA1, 0xA1, 0xFE, s.c, s.h, s.r, s.n];
        const idCrc = crc16(idBytes);
        encodeByte(bw, 0xFE, state);
        encodeByte(bw, s.c, state);
        encodeByte(bw, s.h, state);
        encodeByte(bw, s.r, state);
        encodeByte(bw, s.n, state);
        encodeByte(bw, (idCrc >> 8) & 0xFF, state);
        encodeByte(bw, idCrc & 0xFF, state);

        gapByte(22); sync00(12);
        // --- Data field ---
        bw.sync16(SYNC_A1); state.prev = 1;
        bw.sync16(SYNC_A1); state.prev = 1;
        bw.sync16(SYNC_A1); state.prev = 1;
        const mark = s.deleted ? 0xF8 : 0xFB;
        const size = 128 << (s.n & 0xFF);
        const data = s.data || new Uint8Array(size);
        const dataBytes = [0xA1, 0xA1, 0xA1, mark, ...Array.from(data.subarray(0, size))];
        const dataCrc = crc16(dataBytes);
        encodeByte(bw, mark, state);
        for (let i = 0; i < size; i++) encodeByte(bw, data[i] || 0, state);
        encodeByte(bw, (dataCrc >> 8) & 0xFF, state);
        encodeByte(bw, dataCrc & 0xFF, state);
    }

    gapByte(opts.gap4 ?? 40);            // trailing gap

    let bytes = bw.toBytes();
    if (opts.padTo && bytes.length < opts.padTo) {
        const padded = new Uint8Array(opts.padTo);
        padded.set(bytes);
        padded.fill(0x4E, bytes.length); // gap fill in non-MFM (filler) bytes
        bytes = padded;
    }
    return bytes;
}

// ---------------------------------------------------------------------------
// Assemble an HFE v1 ArrayBuffer from per-track, per-side MFM byte arrays.
//   trackSides[track] = [side0Bytes, side1Bytes]
// ---------------------------------------------------------------------------
export function buildHFE(trackSides, opts = {}) {
    const numTracks = trackSides.length;
    const numSides = 2;
    const bitRate = opts.bitRate ?? 250;
    const rpm = opts.rpm ?? 300;

    // Interleave the two sides in 256-byte blocks.
    const trackBlocks = [];
    for (const [s0, s1] of trackSides) {
        const lenPerSide = Math.max(s0.length, s1.length);
        const numChunks = Math.ceil(lenPerSide / 256);
        const block = new Uint8Array(numChunks * 512);
        for (let c = 0; c < numChunks; c++) {
            block.set(s0.subarray(c * 256, c * 256 + 256), c * 512);
            block.set(s1.subarray(c * 256, c * 256 + 256), c * 512 + 256);
        }
        trackBlocks.push({ block, len: lenPerSide * 2 }); // len = both sides
    }

    // Layout: header block (512) + LUT block (512) + track data blocks.
    const lutOffsetBlocks = 1;
    let cursorBlocks = 2; // after header + LUT
    const lut = [];
    for (const tb of trackBlocks) {
        lut.push({ offset: cursorBlocks, len: tb.len });
        cursorBlocks += Math.ceil(tb.block.length / 512);
    }
    const totalBlocks = cursorBlocks;
    const buf = new ArrayBuffer(totalBlocks * 512);
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);

    for (let i = 0; i < HFE_SIGNATURE.length; i++) bytes[i] = HFE_SIGNATURE.charCodeAt(i);
    bytes[8] = 0;            // format revision
    bytes[9] = numTracks;
    bytes[10] = numSides;
    bytes[11] = 0x00;        // ISOIBM_MFM_ENCODING
    view.setUint16(12, bitRate, true);
    view.setUint16(14, rpm, true);
    bytes[16] = 0x07;        // GENERIC_SHUGART_DD_FLOPPYMODE
    bytes[17] = 0xFF;
    view.setUint16(18, lutOffsetBlocks, true);

    // Track LUT.
    let p = lutOffsetBlocks * 512;
    for (const e of lut) {
        view.setUint16(p, e.offset, true);
        view.setUint16(p + 2, e.len, true);
        p += 4;
    }

    // Track data.
    for (let t = 0; t < trackBlocks.length; t++) {
        bytes.set(trackBlocks[t].block, lut[t].offset * 512);
    }

    return buf;
}

// ---------------------------------------------------------------------------
// Parse an HFE v1 image — header, LUT, and de-interleaved per-side bitstreams.
// Returns null if the signature does not match.
// ---------------------------------------------------------------------------
export function parseHFE(buffer) {
    if (buffer.byteLength < 512) return null;
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    for (let i = 0; i < HFE_SIGNATURE.length; i++) {
        if (bytes[i] !== HFE_SIGNATURE.charCodeAt(i)) return null;
    }

    const header = {
        revision: bytes[8],
        numTracks: bytes[9],
        numSides: bytes[10],
        encoding: bytes[11],
        bitRate: view.getUint16(12, true),
        rpm: view.getUint16(14, true),
        interfaceMode: bytes[16],
        lutOffset: view.getUint16(18, true),
    };
    if (header.rpm === 0) header.rpm = 300;
    if (header.bitRate === 0) header.bitRate = 250;

    const tracks = [];
    let p = header.lutOffset * 512;
    for (let t = 0; t < header.numTracks; t++) {
        const offset = view.getUint16(p, true);
        const len = view.getUint16(p + 2, true); // bytes for both sides
        p += 4;
        const base = offset * 512;
        const perSide = Math.floor(len / 2);
        const side0 = new Uint8Array(perSide);
        const side1 = new Uint8Array(perSide);
        let w = 0;
        for (let c = 0; c * 256 < perSide; c++) {
            const chunk = Math.min(256, perSide - c * 256);
            const o = base + c * 512;
            if (o + 256 + chunk > buffer.byteLength) break;
            side0.set(bytes.subarray(o, o + chunk), w);
            side1.set(bytes.subarray(o + 256, o + 256 + chunk), w);
            w += chunk;
        }
        tracks.push({ side0, side1, lenPerSide: perSide });
    }

    return { header, tracks };
}

// ---------------------------------------------------------------------------
// Nominal MFM bytes per side for the given bit rate / RPM.
//   250 kbps @ 300 RPM -> 250000 * 0.2 / 8 = 6250 bytes.
// ---------------------------------------------------------------------------
export function nominalBytesPerSide(bitRate, rpm) {
    return Math.round((bitRate * 1000) * (60 / rpm) / 8);
}

// ---------------------------------------------------------------------------
// Validate per-side track lengths.  Over-length tracks are the ones that pass
// sector CRC yet fail to boot on real hardware (the index pulse cuts the track
// short), so they are flagged.  Returns an array of warning objects.
// ---------------------------------------------------------------------------
export function validateHFETrackLengths(parsed, opts = {}) {
    const warnings = [];
    if (!parsed) return warnings;
    const nominal = nominalBytesPerSide(parsed.header.bitRate, parsed.header.rpm);
    const overSlack = opts.overSlack ?? 16;   // bytes of jitter tolerated
    const underSlack = opts.underSlack ?? 64;
    for (let t = 0; t < parsed.tracks.length; t++) {
        // HFE stores two flux cells per MFM data bit, so the MFM byte length
        // per side is half the stored bitstream length.  Compare that against
        // the nominal MFM capacity (e.g. 6250 bytes for 250 kbps @ 300 RPM).
        const len = Math.round(parsed.tracks[t].lenPerSide / 2);
        if (len > nominal + overSlack) {
            warnings.push({
                track: t, length: len, nominal, kind: 'over',
                message: `track ${t}: MFM length ${len} bytes/side exceeds nominal ${nominal} (+${len - nominal}); real hardware may reject this medium`,
            });
        } else if (len > 0 && len < nominal - underSlack) {
            warnings.push({
                track: t, length: len, nominal, kind: 'under',
                message: `track ${t}: MFM length ${len} bytes/side is short of nominal ${nominal} (${len - nominal})`,
            });
        }
    }
    return warnings;
}

// ---------------------------------------------------------------------------
// MFM-decode one side's bitstream into sectors.  Scans for the A1 sync, then
// decodes the IDAM (C/H/R/N + CRC) and the following DAM (data + CRC).
// ---------------------------------------------------------------------------
export function decodeMFMTrack(bytes) {
    const totalCells = bytes.length * 8;
    const sectors = [];

    // Read `count` MFM data bytes starting at cell index `pos` (which must sit
    // on a clock cell).  Returns { bytes, next }.
    const readBytes = (pos, count) => {
        const out = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            let v = 0;
            for (let b = 0; b < 8; b++) {
                // cell layout: clock, data, clock, data ...  take the data cell.
                const dataCell = pos + 1;
                if (dataCell >= totalCells) return { bytes: out.subarray(0, i), next: pos, short: true };
                v = (v << 1) | bitOf(bytes, dataCell);
                pos += 2;
            }
            out[i] = v;
        }
        return { bytes: out, next: pos };
    };

    // Slide a 16-cell window looking for the A1 sync pattern.
    let i = 0;
    let syncWindow = 0;
    let filled = 0;
    let pendingId = null;
    while (i < totalCells) {
        syncWindow = ((syncWindow << 1) | bitOf(bytes, i)) & 0xFFFF;
        i++;
        filled++;
        if (filled < 16 || syncWindow !== SYNC_A1) continue;

        // Found one A1.  The cell just consumed (index i) leaves `i` pointing
        // at the cell after the 16-cell sync — i.e. the next clock cell.
        // Skip any further A1 syncs, then read the mark byte.
        let pos = i;
        // Consume additional A1 syncs (decoded value 0xA1 each, 16 cells).
        // We simply attempt to read the mark; encoders emit exactly 3 syncs,
        // and the third's trailing cells already advanced `i`, so read here.
        const mark = readBytes(pos, 1);
        const markByte = mark.bytes[0];
        pos = mark.next;

        if (markByte === 0xFE) {
            // ID field: C H R N CRChi CRClo
            const id = readBytes(pos, 6);
            pos = id.next;
            if (id.bytes.length === 6) {
                const idField = [0xA1, 0xA1, 0xA1, 0xFE, id.bytes[0], id.bytes[1], id.bytes[2], id.bytes[3]];
                const crc = (id.bytes[4] << 8) | id.bytes[5];
                pendingId = {
                    c: id.bytes[0], h: id.bytes[1], r: id.bytes[2], n: id.bytes[3],
                    crcOk: crc16(idField) === crc,
                };
            }
        } else if ((markByte === 0xFB || markByte === 0xF8) && pendingId) {
            const size = 128 << (pendingId.n & 0xFF);
            const dat = readBytes(pos, size + 2);
            pos = dat.next;
            if (dat.bytes.length === size + 2) {
                const data = dat.bytes.subarray(0, size);
                const crc = (dat.bytes[size] << 8) | dat.bytes[size + 1];
                const dataField = [0xA1, 0xA1, 0xA1, markByte, ...Array.from(data)];
                const crcOk = crc16(dataField) === crc;
                sectors.push({
                    c: pendingId.c, h: pendingId.h, r: pendingId.r, n: pendingId.n,
                    size,
                    data: Uint8Array.from(data),
                    deleted: markByte === 0xF8,
                    density: 0x00,
                    status: (pendingId.crcOk && crcOk) ? 0x00 : 0x10, // 0x10 = CRC error
                    // Physical slot on the track (order the data fields appear
                    // in the MFM stream). Captures interleave/skew so the
                    // rotational-latency model sees the real media layout,
                    // matching the D77 loader (fdc.js parseD77 physIdx).
                    physIdx: sectors.length,
                });
            }
            pendingId = null;
        }
        // Resume the sliding search after this field.
        i = pos;
        syncWindow = 0;
        filled = 0;
    }
    return sectors;
}

// ---------------------------------------------------------------------------
// Decode a whole HFE into the structure FDC.loadDisk needs:
//   { numTracks, numSides, sectors, warnings, header }
// `sectors` matches D77Disk.sectors: sectors[track][side][r] = {c,h,r,n,...}
// ---------------------------------------------------------------------------
export function decodeHFE(buffer) {
    const parsed = parseHFE(buffer);
    if (!parsed) return null;
    const warnings = validateHFETrackLengths(parsed);
    const sectors = {};
    let numSides = 1;
    for (let t = 0; t < parsed.tracks.length; t++) {
        sectors[t] = {};
        const sides = parsed.header.numSides > 1 ? [parsed.tracks[t].side0, parsed.tracks[t].side1]
                                                 : [parsed.tracks[t].side0];
        for (let side = 0; side < sides.length; side++) {
            sectors[t][side] = {};
            const decoded = decodeMFMTrack(sides[side]);
            for (const sec of decoded) {
                sectors[t][side][sec.r] = sec;
                if (side === 1) numSides = 2;
            }
        }
    }
    if (parsed.header.numSides > 1) numSides = 2;
    return {
        numTracks: parsed.header.numTracks,
        numSides,
        sectors,
        warnings,
        header: parsed.header,
    };
}
