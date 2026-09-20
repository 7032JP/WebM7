// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * FM-7 CMT (Cassette Magnetic Tape) Controller
 *
 * T77 tape image format (standard layout):
 *   Header: 16 bytes (magic string, see T77_HEADER; no terminator)
 *   Data:   2-byte pulse widths (bit15=polarity, bit14-0=width),
 *           big-endian in the standard layout. The loader auto-detects
 *           byte order so legacy little-endian exports keep loading.
 *           A 17-byte header variant (magic + lone null terminator, odd
 *           file length) is also accepted for legacy files.
 *   Gap:    0x0000 = silence/gap marker (not end-of-tape)
 *
 * FM-7 cassette I/O (main CPU):
 *   $FD00 write bit 1: motor control (1=ON, 0=OFF)
 *   $FD02 read  bit 7: read data (current signal level from tape)
 */

const T77_HEADER = "XM7 TAPE IMAGE 0";
const T77_HEADER_SIZE = 16;

// Main CPU effective clock — used to convert between T77 pulse widths
// (in CPU cycles via _scale) and WAV sample counts.
const CMT_CPU_HZ = 1794000;
// Canonical scale used when capturing writes into T77 pulse widths
// (T77 width unit ≈ 16 CPU cycles, matching the read-side default).
const T77_SAVE_SCALE = 16;
const T77_MAX_WIDTH = 0x7FFF; // 15-bit width field

export class CMT {
    constructor() {
        /** @type {Uint16Array|null} */
        this._pulses = null;
        this._pos = 0;
        this._cycleCount = 0;
        this._level = 0;
        this._motor = false;
        this._loaded = false;
        this._eot = false;
        this._scale = 10;

        // Statistics
        this._pulsesConsumed = 0;
        this._transitions = 0;
        this._readBitCalls = 0;
        this._validPulseCount = 0;
        this._lastDiagPulse = 0;

        // --- Write capture (recording) ---
        // Cassette WRITE data ($FD00 bit 0) transitions are captured into a
        // T77-style pulse list while the motor is ON. Always armed; cleared
        // by clearRecording()/eject().
        this._recording = true;
        this._recPulses = [];   // captured pulses (uint16: bit15 polarity + width)
        this._recCycles = 0;    // CPU cycles elapsed at current write level
        this._recLevel = 0;     // current cassette write-data level (0/1)
        this._recDataEvents = 0; // write-data transitions seen (real SAVE output);
                                 // 0 means the buffer holds silence only (e.g.
                                 // motor idling or LOAD), not a real recording
    }

    /**
     * Load a T77 tape image with auto byte-order detection.
     */
    loadT77(buffer) {
        this._pulses = null;
        this._loaded = false;
        this._eot = false;
        this._pos = 0;
        this._cycleCount = 0;
        this._level = 0;

        if (buffer.byteLength < T77_HEADER_SIZE + 2) {
            console.error('[CMT] T77 file too small');
            return false;
        }

        const headerBytes = new Uint8Array(buffer, 0, T77_HEADER_SIZE);
        let header = '';
        for (let i = 0; i < T77_HEADER.length; i++) {
            header += String.fromCharCode(headerBytes[i]);
        }
        if (header !== T77_HEADER) {
            console.error('[CMT] Invalid T77 header:', header);
            return false;
        }

        // Locate the pulse stream. The standard layout starts it right after
        // the 16-byte magic (even file length). A legacy 17-byte header
        // (magic + lone null terminator) makes the total length odd — step
        // past the terminator so the stream stays 2-byte aligned.
        const allBytes = new Uint8Array(buffer);
        let dataOffset = T77_HEADER_SIZE;
        if ((buffer.byteLength & 1) !== 0) dataOffset++;
        // Skip leading 0x0000 gap records in whole 2-byte units. Scanning
        // byte-wise here could eat the first byte of a real pulse (e.g. a
        // BE width that is a multiple of 256) and shift the whole stream by
        // one byte; whole-record skipping structurally rules that out.
        while (dataOffset + 2 <= buffer.byteLength &&
               allBytes[dataOffset] === 0x00 && allBytes[dataOffset + 1] === 0x00) {
            dataOffset += 2;
        }
        console.log(`[CMT] Header: ${dataOffset} bytes (${dataOffset - T77_HEADER_SIZE} bytes of terminator/gap skipped)`);

        const dataSize = buffer.byteLength - dataOffset;
        const numPulses = (dataSize / 2) | 0;
        const view = new DataView(buffer, dataOffset);

        // Auto-detect byte order: try both BE and LE, pick the one
        // that gives more values in the expected range (20-100)
        const littleEndian = this._detectByteOrder(view, numPulses);

        // Read ALL pulses — 0x0000 is a gap marker, NOT end-of-tape.
        // End of tape is the end of the file.
        this._pulses = new Uint16Array(numPulses);
        let validCount = numPulses;
        for (let i = 0; i < numPulses; i++) {
            this._pulses[i] = view.getUint16(i * 2, littleEndian);
        }

        this._loaded = true;
        this._validPulseCount = validCount;

        // Auto-detect scale from the data
        this._scale = this._detectScale(validCount);

        if (validCount > 0) {
            this._level = (this._pulses[0] & 0x8000) ? 1 : 0;
        }

        this._logPulseDump(validCount, littleEndian);
        return true;
    }

    /**
     * Detect byte order by checking which gives values in expected range.
     * T77 data pulses should have widths around 20-60 (for 1200/2400Hz).
     */
    _detectByteOrder(view, numPulses) {
        let beInRange = 0, leInRange = 0;
        const sampleCount = Math.min(numPulses, 10000);
        // Sample from middle of file (skip potential silence/gaps at start)
        const start = Math.min(Math.floor(numPulses * 0.3), Math.max(0, numPulses - sampleCount));
        for (let i = start; i < start + sampleCount && i < numPulses; i++) {
            const be = view.getUint16(i * 2, false) & 0x7FFF;
            const le = view.getUint16(i * 2, true) & 0x7FFF;
            if (be >= 5 && be <= 200) beInRange++;
            if (le >= 5 && le <= 200) leInRange++;
        }
        const isLE = leInRange > beInRange;
        console.log(`[CMT] Byte order: BE=${beInRange}/${sampleCount} LE=${leInRange}/${sampleCount} → ${isLE ? 'LE' : 'BE'}`);
        return isLE;
    }

    /**
     * Detect scale factor from the two dominant pulse width clusters.
     * Target: 2400Hz half-period ≈ 416 CPU cycles (scale≈16).
     * At 1.794MHz with scale 16: short=416cy, long=768cy.
     */
    _detectScale(validCount) {
        if (validCount < 100) return 16;

        // Collect widths, skip zeros (gaps), very large (silence) and very small (noise)
        const widths = [];
        for (let i = 0; i < validCount; i++) {
            const w = this._pulses[i] & 0x7FFF;
            if (w >= 5 && w < 200) widths.push(w);
        }
        if (widths.length < 100) return 16;

        // Bimodal detection: build a histogram, find the two dominant clusters
        // (2400Hz and 1200Hz half-periods at ~2:1 ratio). Picks the smaller
        // cluster (short = 2400Hz) and computes scale = 416 / short_peak.
        // Robust to skewed distributions (e.g. mostly-long-pulse SAVE captures
        // where percentile-based detection collapses both clusters together).
        const hist = new Array(200).fill(0);
        for (const w of widths) hist[w]++;
        // Find peaks: bucket count > both neighbors and > some threshold.
        const peaks = [];
        const minPeak = Math.max(20, widths.length * 0.02);
        for (let w = 5; w < 200; w++) {
            if (hist[w] < minPeak) continue;
            const left  = (hist[w-1] || 0) + (hist[w-2] || 0) + (hist[w-3] || 0);
            const right = (hist[w+1] || 0) + (hist[w+2] || 0) + (hist[w+3] || 0);
            if (hist[w] >= left / 3 && hist[w] >= right / 3) peaks.push({ w, n: hist[w] });
        }
        // Merge close peaks (within 3 width units).
        peaks.sort((a, b) => a.w - b.w);
        const merged = [];
        for (const p of peaks) {
            if (merged.length && p.w - merged[merged.length-1].w <= 3) {
                if (p.n > merged[merged.length-1].n) merged[merged.length-1] = p;
            } else merged.push(p);
        }
        // Pick the two most populous peaks, then take the smaller-w one as short.
        merged.sort((a, b) => b.n - a.n);
        let shortCluster;
        if (merged.length >= 2) {
            const top2 = merged.slice(0, 2).sort((a, b) => a.w - b.w);
            shortCluster = top2[0].w;
        } else if (merged.length === 1) {
            shortCluster = merged[0].w;
        } else {
            // Fallback: percentile
            widths.sort((a, b) => a - b);
            shortCluster = widths[Math.floor(widths.length * 0.10)];
        }
        const scale = 416 / shortCluster;
        widths.sort((a, b) => a - b);
        const longCluster = (widths[Math.floor(widths.length * 0.60)] +
                             widths[Math.floor(widths.length * 0.80)]) / 2;

        console.log(`[CMT] Scale: ${scale.toFixed(4)} (short=${shortCluster.toFixed(0)}→${(shortCluster*scale).toFixed(0)}cy, ` +
            `long=${longCluster.toFixed(0)}→${(longCluster*scale).toFixed(0)}cy, ratio=${(longCluster/shortCluster).toFixed(2)})`);
        return scale;
    }

    _logPulseDump(validCount, isLE) {
        const lines = [];
        const dumpCount = Math.min(20, validCount);
        for (let i = 0; i < dumpCount; i++) {
            const raw = this._pulses[i];
            const pol = (raw & 0x8000) ? 'H' : 'L';
            const w = raw & 0x7FFF;
            lines.push(`  [${i}] ${pol} w=${w} (${(w * this._scale)|0}cy)`);
        }
        // Sample from data section
        const mid = Math.min(validCount - 1, Math.floor(validCount * 0.3));
        if (mid > 100) {
            lines.push(`  --- sample at pos ${mid}: ---`);
            for (let i = mid; i < Math.min(mid + 10, validCount); i++) {
                const raw = this._pulses[i];
                const pol = (raw & 0x8000) ? 'H' : 'L';
                const w = raw & 0x7FFF;
                lines.push(`  [${i}] ${pol} w=${w} (${(w * this._scale)|0}cy)`);
            }
        }
        // One-line summary always; the per-pulse dump is dev-only (set _dbgPulseDump=true).
        const summary = `[CMT] T77: ${validCount} pulses, ${isLE ? 'LE' : 'BE'}, scale=${this._scale.toFixed(4)}`;
        console.log(this._dbgPulseDump ? `${summary}\n${lines.join('\n')}` : summary);
    }

    /**
     * Advance tape by CPU cycles with proper timing.
     * The scale factor converts T77 pulse widths to CPU cycles.
     * Speed is controlled by the simulator running more cycles per frame.
     */
    step(cycles) {
        // Accumulate elapsed cycles at the current write level for recording,
        // independent of whether a tape is loaded (SAVE has no loaded tape).
        if (this._recording && this._motor) {
            this._recCycles += cycles;
        }

        if (!this._motor || !this._loaded || this._eot) return;

        this._cycleCount += cycles;

        while (this._pulses && this._pos < this._pulses.length) {
            const raw = this._pulses[this._pos];
            const width = (raw & 0x7FFF) * this._scale;

            // Width 0 = gap/silence marker in T77, skip instantly
            if (width < 1) {
                this._pulsesConsumed++;
                this._pos++;
                continue;
            }

            if (this._cycleCount >= width) {
                this._cycleCount -= width;
                this._pulsesConsumed++;
                this._pos++;
                if (this._pos < this._pulses.length) {
                    const newLevel = (this._pulses[this._pos] & 0x8000) ? 1 : 0;
                    if (newLevel !== this._level) this._transitions++;
                    this._level = newLevel;
                }
            } else {
                break;
            }
        }

        if (this._pulses && this._pos >= this._pulses.length) {
            this._eot = true;
            console.log(`[CMT] End of tape (consumed=${this._pulsesConsumed}, trans=${this._transitions})`);
        }

        if (this._pulsesConsumed % 100000 === 0 && this._pulsesConsumed > 0 &&
            this._pulsesConsumed !== this._lastDiagPulse) {
            this._lastDiagPulse = this._pulsesConsumed;
            console.log(`[CMT] progress: pos=${this._pos}/${this._validPulseCount} trans=${this._transitions} level=${this._level}`);
        }
    }

    readDataBit() {
        if (!this._loaded || !this._motor) return 0x80;
        this._readBitCalls++;
        return this._level ? 0x80 : 0x00;
    }

    writeControl(value) {
        const newMotor = (value & 0x02) !== 0;
        const writeBit = (value & 0x01);   // cassette WRITE data (recording)

        if (newMotor && !this._motor) {
            console.log(`[CMT] Motor ON (pos=${this._pos}/${this._validPulseCount}, scale=${this._scale.toFixed(4)})`);
            if (this._loaded && this._pulses && this._pos < this._pulses.length) {
                this._level = (this._pulses[this._pos] & 0x8000) ? 1 : 0;
            }
            if (this._recording) {
                // Start a fresh timing window at the current write level.
                this._recCycles = 0;
                this._recLevel = writeBit;
            }
        } else if (!newMotor && this._motor) {
            console.log(`[CMT] Motor OFF (pos=${this._pos}, consumed=${this._pulsesConsumed}, trans=${this._transitions}, reads=${this._readBitCalls})`);
            // Flush the pending pulse at motor stop.
            if (this._recording) this._emitRecPulse(this._recLevel, this._recCycles);
            this._recCycles = 0;
        } else if (newMotor && this._recording && writeBit !== this._recLevel) {
            // Write-data transition while recording: emit the pulse just held.
            this._recDataEvents++;
            this._emitRecPulse(this._recLevel, this._recCycles);
            this._recCycles = 0;
            this._recLevel = writeBit;
        }

        this._motor = newMotor;
    }

    /**
     * Append a captured pulse (level held for `cycles` CPU cycles) to the
     * recording buffer, splitting widths that exceed the 15-bit field.
     */
    _emitRecPulse(level, cycles) {
        let w = Math.round(cycles / T77_SAVE_SCALE);
        if (w < 1) return;                    // ignore sub-unit glitches
        const polarity = level ? 0x8000 : 0;
        while (w > T77_MAX_WIDTH) {
            this._recPulses.push(polarity | T77_MAX_WIDTH);
            w -= T77_MAX_WIDTH;
        }
        this._recPulses.push(polarity | w);
    }

    /** Clear the write-capture buffer and re-arm recording. */
    clearRecording() {
        this._recPulses = [];
        this._recCycles = 0;
        this._recLevel = 0;
        this._recDataEvents = 0;
        this._recording = true;
    }

    /**
     * @returns {number} number of captured write pulses (incl. pending).
     * Reports 0 while no actual write-data transition has been captured:
     * motor-only runs (LOAD, MOTOR idling) accumulate silence, and counting
     * that as a recording would let the UI save a data-less tape file.
     */
    get recordedPulseCount() {
        if (this._recDataEvents === 0) return 0;
        return this._recPulses.length + (this._recCycles > 0 ? 1 : 0);
    }

    /**
     * Snapshot of captured pulses including any in-progress pulse, as a
     * plain array of uint16 (bit15 = polarity, bit14-0 = width).
     */
    _recordingSnapshot() {
        const out = this._recPulses.slice();
        const w = Math.round(this._recCycles / T77_SAVE_SCALE);
        if (w >= 1) {
            const polarity = this._recLevel ? 0x8000 : 0;
            let rem = w;
            while (rem > T77_MAX_WIDTH) { out.push(polarity | T77_MAX_WIDTH); rem -= T77_MAX_WIDTH; }
            out.push(polarity | rem);
        }
        return out;
    }

    get loaded() { return this._loaded; }
    get motor() { return this._motor; }
    get eot() { return this._eot; }
    get position() { return this._pos; }
    get totalPulses() { return this._pulses ? this._pulses.length : 0; }

    get stats() {
        return {
            consumed: this._pulsesConsumed,
            transitions: this._transitions,
            reads: this._readBitCalls,
            pos: this._pos,
            total: this._validPulseCount
        };
    }

    rewind() {
        let stats = '';
        if (this._loaded) {
            stats = `consumed=${this._pulsesConsumed} transitions=${this._transitions} reads=${this._readBitCalls}`;
            console.log(`[CMT] Tape rewound (${stats})`);
        }
        this._pos = 0;
        this._cycleCount = 0;
        this._eot = false;
        this._pulsesConsumed = 0;
        this._transitions = 0;
        this._readBitCalls = 0;
        this._lastDiagPulse = 0;
        if (this._loaded && this._pulses && this._pulses.length > 0) {
            this._level = (this._pulses[0] & 0x8000) ? 1 : 0;
        } else {
            this._level = 0;
        }
        return stats;
    }

    // ------------------------------------------------------------------
    // Export: captured writes → T77 / WAV
    // ------------------------------------------------------------------

    /**
     * Serialize captured write pulses to a T77 tape image in the standard
     * layout: 16-byte magic header, one leading 0x0000 gap record (customary
     * in real-world files), then big-endian uint16 pulses.
     * @param {number[]} [pulses] override pulse list (defaults to recording)
     * @returns {ArrayBuffer}
     */
    exportT77(pulses) {
        const arr = pulses || this._recordingSnapshot();
        const buf = new ArrayBuffer(T77_HEADER_SIZE + 2 + arr.length * 2);
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < T77_HEADER.length; i++) {
            bytes[i] = T77_HEADER.charCodeAt(i);
        }
        const view = new DataView(buf, T77_HEADER_SIZE);
        view.setUint16(0, 0x0000, false); // leading gap record
        for (let i = 0; i < arr.length; i++) {
            view.setUint16(2 + i * 2, arr[i] & 0xFFFF, false); // big-endian
        }
        return buf;
    }

    /**
     * Render a pulse list to a mono 8-bit PCM WAV file (square-wave carrier).
     * Exposed via the Save .wav button; round-trips cleanly back through
     * loadWAV (verified to decode to the same blocks).
     *
     * @param {number} [sampleRate=48000]
     * @param {number[]} [pulses] override pulse list (defaults to recording)
     * @param {number} [scale=T77_SAVE_SCALE] cycles per width unit
     * @returns {ArrayBuffer}
     */
    exportWAV(sampleRate = 48000, pulses, scale = T77_SAVE_SCALE) {
        const arr = pulses || this._recordingSnapshot();
        const cyclesPerSample = CMT_CPU_HZ / sampleRate;

        // Build the PCM sample stream from pulse run-lengths.
        const samples = [];
        const HI = 0xC0, LO = 0x40; // 8-bit unsigned around 0x80 mid
        const pushRun = (v, widthUnits) => {
            const n = Math.max(1, Math.round(widthUnits * scale / cyclesPerSample));
            for (let s = 0; s < n; s++) samples.push(v);
        };
        for (let i = 0; i < arr.length; i++) {
            const raw = arr[i];
            pushRun((raw & 0x8000) ? HI : LO, raw & 0x7FFF);
        }
        // --- Close the final pulse -------------------------------------
        // Demodulation measures full cycles between rising edges, so the
        // stream must end with one final rising edge; without it the last
        // half-cycle never closes and the final bit of the last byte (the
        // closing block's checksum) is lost — LOAD then waits forever.
        if (arr.length > 0) {
            const last = arr[arr.length - 1];
            if (last & 0x8000) {
                // Ended on a high half-cycle: mirror it low first so the
                // final data cycle keeps its measured period.
                pushRun(LO, last & 0x7FFF);
            }
            pushRun(HI, CMT._TICK_SHORT); // final rising edge
        }
        // Short mid-level silence tail so the signal region ends cleanly.
        {
            const n = Math.round(sampleRate * 0.1);
            for (let s = 0; s < n; s++) samples.push(0x80);
        }

        const dataSize = samples.length;
        const buf = new ArrayBuffer(44 + dataSize);
        const dv = new DataView(buf);
        const ws = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
        ws(0, 'RIFF');
        dv.setUint32(4, 36 + dataSize, true);
        ws(8, 'WAVE');
        ws(12, 'fmt ');
        dv.setUint32(16, 16, true);        // fmt chunk size
        dv.setUint16(20, 1, true);         // PCM
        dv.setUint16(22, 1, true);         // mono
        dv.setUint32(24, sampleRate, true);
        dv.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
        dv.setUint16(32, 1, true);          // block align
        dv.setUint16(34, 8, true);          // bits/sample
        ws(36, 'data');
        dv.setUint32(40, dataSize, true);
        for (let i = 0; i < dataSize; i++) dv.setUint8(44 + i, samples[i]);
        return buf;
    }

    // ------------------------------------------------------------------
    // Import: WAV → playable tape (CAS:)
    // ------------------------------------------------------------------

    /**
     * Load a WAV file as cassette media. Supports PCM 8-bit unsigned and
     * 16-bit signed, mono or multi-channel (channel 0 is used). The audio
     * waveform is thresholded into a binary level stream and run-length
     * encoded into the same pulse representation used for T77 playback.
     *
     * @returns {boolean}
     */
    loadWAV(buffer) {
        this._pulses = null;
        this._loaded = false;
        this._eot = false;
        this._pos = 0;
        this._cycleCount = 0;
        this._level = 0;

        const dv = new DataView(buffer);
        if (buffer.byteLength < 44 ||
            dv.getUint32(0, false) !== 0x52494646 /* 'RIFF' */ ||
            dv.getUint32(8, false) !== 0x57415645 /* 'WAVE' */) {
            console.error('[CMT] Not a RIFF/WAVE file');
            return false;
        }

        // Walk chunks to find 'fmt ' and 'data'.
        let fmtOff = -1, dataOff = -1, dataLen = 0;
        let off = 12;
        while (off + 8 <= buffer.byteLength) {
            const id = dv.getUint32(off, false);
            const sz = dv.getUint32(off + 4, true);
            if (id === 0x666d7420) fmtOff = off + 8;           // 'fmt '
            else if (id === 0x64617461) { dataOff = off + 8; dataLen = sz; } // 'data'
            off += 8 + sz + (sz & 1); // chunks are word-aligned
        }
        if (fmtOff < 0 || dataOff < 0) {
            console.error('[CMT] WAV missing fmt/data chunk');
            return false;
        }

        const audioFormat = dv.getUint16(fmtOff, true);
        const channels    = dv.getUint16(fmtOff + 2, true) || 1;
        const sampleRate  = dv.getUint32(fmtOff + 4, true) || 48000;
        const bits        = dv.getUint16(fmtOff + 14, true) || 8;
        if (audioFormat !== 1) {
            console.error('[CMT] WAV not PCM (format=' + audioFormat + ')');
            return false;
        }
        const bytesPerSample = bits >> 3;
        const frameBytes = bytesPerSample * channels;
        const frames = Math.floor(Math.min(dataLen, buffer.byteLength - dataOff) / frameBytes);

        // Channel-0 sample reader on a common ±128 scale (8/16-bit).
        const readCh0 = (frame) => {
            const p = dataOff + frame * frameBytes;
            if (bits === 8) return dv.getUint8(p) - 128;      // unsigned → signed
            if (bits === 16) return dv.getInt16(p, true) / 256;
            return dv.getInt16(p, true) / 256;
        };

        // --- FSK demodulate → re-encode clean pulses --------------------
        // Real tape recordings carry analog defects — drifting amplitude,
        // dropouts, noise — that defeat any single slice threshold and flip
        // bits ("Device I/O error"). Rather than feed the raw sliced waveform
        // to the BIOS, fully demodulate it: split the recording into signal
        // regions, recover the bit stream from full-cycle periods (robust to
        // half-cycle asymmetry), frame it into bytes, repair leader noise, and
        // re-emit a CLEAN carrier with canonical pulse widths — the same shape
        // a pristine tape image has. The BIOS then reads an ideal signal.
        const smp = new Int16Array(frames);
        for (let f = 0; f < frames; f++) {
            const p = dataOff + f * frameBytes;
            smp[f] = (bits === 8) ? (dv.getUint8(p) - 128) * 256 : dv.getInt16(p, true);
        }

        // Two decoders, picked automatically. Full FSK demodulation produces a
        // pristine re-encoded carrier and rescues noisy/uneven recordings, but
        // only when it can frame real data blocks. Cleaner tapes that the demod
        // can't frame (different block layout, etc.) decode fine by adaptive
        // slicing. Demod wins when it frames data blocks covering most of the
        // bytes it recovered; otherwise fall back to the slicer.
        const dbg = {};
        const demodPulses = this._wavDemodToPulses(smp, sampleRate, dbg);
        const slicePulses = this._wavSlice(smp, sampleRate);
        const sliceQ = this._wavPulsesToBytes(slicePulses);

        // Both decoders self-verify via block checksums; pick the cleaner one.
        // Fewest bad blocks wins, ties go to the demod (canonical carrier). If
        // neither framed any block, the raw sliced signal is the safer choice.
        //
        // Exception: the demod re-encodes only regions that frame standard
        // blocks, so a tape whose bulk is raw (un-framed) data — e.g. a small
        // loader that then reads the main program as a custom block — would be
        // truncated by the demod (it drops the big raw region and the load
        // stops partway). When the demod re-encoded far fewer bytes than it
        // actually recovered, the slice (which keeps every region's signal)
        // is the complete one.
        const demodTruncated = dbg.encodedBytes < dbg.bytes * 0.5;
        let useDemod;
        if (demodTruncated && sliceQ.ok > 0) useDemod = false;
        else if (dbg.okBlocks === 0 && sliceQ.ok === 0) useDemod = true; // pure raw data:
            // prefer the demod, which regenerates a canonical-frequency carrier
            // the BIOS can read even if the tape was recorded at a drifted speed.
        else if (dbg.badBlocks !== sliceQ.bad) useDemod = dbg.badBlocks < sliceQ.bad;
        else useDemod = dbg.okBlocks >= sliceQ.ok;

        let mode;
        if (useDemod) {
            this._pulses = Uint16Array.from(demodPulses);
            this._scale = this._detectScale(this._pulses.length);
            this._wavQuality = { mode: 'demod', okBlocks: dbg.okBlocks, badBlocks: dbg.badBlocks };
            mode = `demod ${dbg.okBlocks}ok/${dbg.badBlocks}bad (slice ${sliceQ.ok}/${sliceQ.bad})`;
        } else {
            this._pulses = Uint16Array.from(slicePulses);
            this._scale = CMT_CPU_HZ / sampleRate;  // 1 width unit = 1 sample frame
            this._wavQuality = { mode: 'slice', okBlocks: sliceQ.ok, badBlocks: sliceQ.bad };
            mode = `slice ${sliceQ.ok}ok/${sliceQ.bad}bad (demod ${dbg.okBlocks}/${dbg.badBlocks})`;
        }
        this._validPulseCount = this._pulses.length;
        this._loaded = this._pulses.length > 0;
        if (this._loaded) this._level = (this._pulses[0] & 0x8000) ? 1 : 0;

        console.log(`[CMT] WAV: ${frames} frames @${sampleRate}Hz/${bits}bit/${channels}ch ` +
            `→ ${this._pulses.length} pulses, scale=${this._scale.toFixed(3)} [${mode}]`);
        return this._loaded;
    }

    // ------------------------------------------------------------------
    // WAV FSK demodulation → clean re-encoded pulse train
    // ------------------------------------------------------------------

    // Canonical re-encoded half-cycle widths (T77 width units, ~9µs each):
    //   short = 2400 Hz half-cycle (data bit 0), long = 1200 Hz (data bit 1).
    static get _TICK_SHORT() { return 23; }
    static get _TICK_LONG() { return 46; }

    /**
     * Full pipeline: channel-0 samples (16-bit scale) → clean pulse list.
     * @param {Int16Array} smp
     * @param {number} rate sample rate (Hz)
     * @param {object} dbg out: {regions, bytes, dataBlocks}
     * @returns {number[]} uint16 pulse list (bit15 polarity + width)
     */
    _wavDemodToPulses(smp, rate, dbg) {
        const n = smp.length;
        // --- Signal regions: 50ms RMS blocks above a noise floor, merged
        //     across gaps < 100ms. Isolates carrier from silence/dropouts. ---
        const block = Math.max(1, Math.floor(rate / 20));
        const RMS_TH = 500;            // 16-bit-scale noise floor
        const regions = [];
        let inSig = false, rstart = 0;
        for (let s = 0; s < n; s += block) {
            const e = Math.min(s + block, n);
            let sq = 0;
            for (let i = s; i < e; i++) sq += smp[i] * smp[i];
            const rms = Math.sqrt(sq / Math.max(1, e - s));
            if (rms > RMS_TH) { if (!inSig) { rstart = s; inSig = true; } }
            else if (inSig) { regions.push([rstart, s]); inSig = false; }
        }
        if (inSig) regions.push([rstart, n]);
        const mergeGap = Math.floor(rate * 0.1);
        const merged = [];
        for (const r of regions) {
            if (merged.length && r[0] - merged[merged.length - 1][1] < mergeGap) {
                merged[merged.length - 1][1] = r[1];
            } else merged.push([r[0], r[1]]);
        }

        // --- Decode each region in order ---------------------------------
        // A region that frames standard blocks is re-encoded as a clean carrier.
        // A region that carries raw, un-framed data (e.g. a loader's main
        // program) has no blocks to validate — so its signal is passed through
        // by slicing it directly and converting widths to canonical tick units,
        // keeping it in sequence so a multi-part load isn't truncated.
        const threshold = 625e-6 * rate;   // full-cycle 1200↔2400 Hz boundary
        const parts = [];                  // ordered: {bytes} | {raw}
        let totalBytes = 0, totalBlocks = 0, okBlocks = 0, badBlocks = 0;
        for (const [s, e] of merged) {
            let decoded = this._wavDemodRegion(smp, s, e, threshold);
            let v = { ok: 0, bad: 0 };
            if (decoded.length) {
                decoded = this._wavCleanLeaders(decoded);
                v = this._wavVerifyBlocks(decoded);
            }
            if (v.ok > 0) {                                  // framed block region
                totalBytes += decoded.length;
                if (this._wavHasDataBlocks(decoded)) totalBlocks++;
                okBlocks += v.ok; badBlocks += v.bad;
                parts.push({ bytes: decoded });
            } else if (e - s > rate * 0.5) {                 // raw data region
                const raw = this._wavRawRegionPulses(smp, s, e);
                if (raw.length) parts.push({ raw });
            }
        }

        // --- Assemble in sequence ---
        const pulses = [];
        this._wavSilence(1.0, pulses);
        let first = true, encodedBytes = 0;
        for (const p of parts) {
            if (!first) this._wavSilence(1.0, pulses);
            first = false;
            if (p.bytes) {
                encodedBytes += p.bytes.length;
                for (let i = 0; i < p.bytes.length; i++) this._wavEncodeByte(p.bytes[i], pulses);
            } else {
                encodedBytes += Math.floor(p.raw.length / 4);   // approx byte count
                for (let i = 0; i < p.raw.length; i++) pulses.push(p.raw[i]);
            }
        }
        this._wavSilence(1.0, pulses);

        if (dbg) {
            dbg.regions = merged.length; dbg.bytes = totalBytes;
            dbg.dataBlocks = totalBlocks; dbg.encodedBytes = encodedBytes;
            dbg.okBlocks = okBlocks; dbg.badBlocks = badBlocks;
        }
        return pulses;
    }

    /**
     * Fallback decoder: adaptive-threshold level slicing. Tracks the signal
     * centre with a one-pole low-pass (recentres drifting/asymmetric half-
     * cycles) and auto-calibrates the hysteresis band by sweeping the whole
     * file and keeping the threshold with the fewest single-half-cycle glitches.
     * Widths stay in sample-frame units (scale = CPU_HZ / sampleRate).
     * @param {Int16Array} smp  @param {number} rate
     * @returns {number[]} uint16 pulse list
     */
    _wavSlice(smp, rate) {
        const n = smp.length;
        const win = Math.max(4, Math.round(rate / 1200));
        const alpha = 1 / win;
        const boundary = rate / 3200;          // 2400↔1200 Hz half-period
        const gapW = rate * 1.5 / 1000;        // ≥1.5ms = gap

        const STEP = Math.max(1, Math.floor(n / 100000));
        let base = n > 0 ? smp[0] : 0, sumSq = 0, statN = 0;
        for (let f = 0; f < n; f++) {
            base += alpha * (smp[f] - base);
            if ((f % STEP) === 0) { const d = smp[f] - base; sumSq += d * d; statN++; }
        }
        const std = statN ? Math.sqrt(sumSq / statN) : 0;

        const slicePass = (hystVal, out) => {
            let b = n > 0 ? smp[0] : 0;
            let lvl = n > 0 ? ((smp[0] - b) >= 0 ? 1 : 0) : 0;
            let rs = 0, glitches = 0, curSym = -1, runLen = 0;
            const emit = (l, len) => {
                if (out) {
                    let w = len;
                    const pol = l ? 0x8000 : 0;
                    while (w > T77_MAX_WIDTH) { out.push(pol | T77_MAX_WIDTH); w -= T77_MAX_WIDTH; }
                    if (w >= 1) out.push(pol | w);
                }
                if (len > gapW) { if (runLen === 1) glitches++; curSym = -1; runLen = 0; return; }
                const sym = len < boundary ? 0 : 1;
                if (sym === curSym) { runLen++; }
                else { if (runLen === 1) glitches++; curSym = sym; runLen = 1; }
            };
            for (let f = 1; f < n; f++) {
                b += alpha * (smp[f] - b);
                const d = smp[f] - b;
                const nl = (d > hystVal) ? 1 : (d < -hystVal) ? 0 : lvl;
                if (nl !== lvl) { emit(lvl, f - rs); lvl = nl; rs = f; }
            }
            if (n - rs >= 1) emit(lvl, n - rs);
            if (runLen === 1) glitches++;
            return glitches;
        };

        // Auto-calibrate the hysteresis by virtual read: slice at each band,
        // decode the pulses to bytes and keep the band whose blocks validate
        // best (most checksum-OK, bad heavily penalised). Glitch count alone
        // picked loadable-but-imperfect bands on some tapes.
        const HF = [0.18, 0.25, 0.32, 0.35, 0.40, 0.50, 0.62, 0.75, 0.90];
        let best = null, bestScore = -Infinity;
        for (const hf of HF) {
            const out = [];
            slicePass(Math.max(0.5, std * hf), out);
            const q = this._wavPulsesToBytes(out);
            const score = q.ok - 100 * q.bad;
            if (score > bestScore) { bestScore = score; best = out; }
        }
        return best || [];
    }

    /**
     * Regenerate a raw (un-framed) data region as a clean canonical carrier.
     * Such a region has no block checksums to tune against, and may have been
     * recorded at a drifted carrier speed — so passing its widths through
     * verbatim would play at the wrong frequency and the BIOS would misread it.
     * Instead, recover the bit stream from full-cycle periods (threshold from
     * the carrier's own 2:1 short/long ratio) and re-emit each cycle at the
     * canonical short/long width, normalising the timing while preserving the
     * raw bits (no byte framing — the loader reads it directly).
     * @returns {number[]} uint16 pulse list (canonical ticks)
     */
    _wavRawRegionPulses(smp, start, end) {
        const pos = [];
        for (let i = start + 1; i < end; i++) {
            if (smp[i - 1] <= 0 && smp[i] > 0) pos.push(i);
        }
        if (pos.length < 10) return [];
        const np = pos.length - 1;
        const hist = new Int32Array(80);
        for (let i = 0; i < np; i++) { const p = pos[i + 1] - pos[i]; if (p >= 6 && p < 80) hist[p]++; }
        let p1 = 6; for (let p = 6; p < 80; p++) if (hist[p] > hist[p1]) p1 = p;
        let p2 = 6; for (let p = 6; p < 80; p++) { if (Math.abs(p - p1) < 6) continue; if (hist[p] > hist[p2]) p2 = p; }
        const shortPk = Math.min(p1, p2);
        // Short and long carriers sit at a 2:1 ratio; split at 1.5x the short.
        const threshold = shortPk * 1.5, bigGap = threshold * 2.5;
        const S = CMT._TICK_SHORT, L = CMT._TICK_LONG;
        const out = [];
        for (let i = 0; i < np; i++) {
            const p = pos[i + 1] - pos[i];
            if (p > bigGap) continue;                        // silence inside region
            const w = (p > threshold) ? L : S;
            out.push(0x8000 | w); out.push(w);
        }
        return out;
    }

    /**
     * Demodulate one region: positive-going zero crossings give full-cycle
     * periods (robust to half-cycle asymmetry); classify each as bit 0/1 and
     * frame into bytes (start 0 + 8 data LSB-first + 2 stop 1).
     *
     * The short/long boundary is auto-tuned per region: tape speed drifts
     * (wow/flutter) shift the carrier frequency, so a single fixed threshold
     * mis-slices some recordings. Several thresholds around the nominal value
     * are tried and the one whose framed blocks validate best (most checksum-
     * OK blocks) is kept — a per-region virtual read.
     */
    _wavDemodRegion(smp, start, end, baseThreshold) {
        const pos = [];
        for (let i = start + 1; i < end; i++) {
            if (smp[i - 1] <= 0 && smp[i] > 0) pos.push(i);
        }
        if (pos.length < 3) return [];
        const np = pos.length - 1;
        const periods = new Int32Array(np);
        for (let i = 0; i < np; i++) periods[i] = pos[i + 1] - pos[i];

        const framedAt = (threshold) => {
            const longGap = threshold * 2.5;
            const bits = [];
            for (let i = 0; i < np; i++) {
                const p = periods[i];
                if (p > longGap) continue;                 // silence inside region
                bits.push(p > threshold ? 1 : 0);          // 1200Hz=1, 2400Hz=0
            }
            const out = [];
            let i = 0;
            while (i < bits.length - 10) {
                if (bits[i] === 0) {                        // start bit
                    let v = 0;
                    for (let b = 0; b < 8; b++) v |= bits[i + 1 + b] << b;
                    out.push(v);
                    i += 11;                               // start + 8 + 2 stop
                } else i++;
            }
            return out;
        };

        let best = null, bestOk = -1, bestBad = Infinity;
        for (const f of [0.88, 0.94, 1.0, 1.06, 1.12, 1.18]) {
            const bytes = framedAt(baseThreshold * f);
            const v = this._wavVerifyBlocks(bytes);
            if (v.ok > bestOk || (v.ok === bestOk && v.bad < bestBad)) {
                bestOk = v.ok; bestBad = v.bad; best = bytes;
            }
        }
        return best || [];
    }

    /**
     * Repair bit errors that fall in leader/gap sections (between data blocks)
     * by forcing them back to 0xFF, while leaving real block content intact.
     * Blocks begin with the 0x01 0x3C marker; the byte after carries the length.
     */
    _wavCleanLeaders(decoded) {
        // Strip pre-leader garbage before the first run of three 0xFF.
        let ls = -1;
        for (let j = 0; j < decoded.length - 2; j++) {
            if (decoded[j] === 0xFF && decoded[j + 1] === 0xFF && decoded[j + 2] === 0xFF) { ls = j; break; }
        }
        const d = ls > 0 ? decoded.slice(ls) : decoded.slice();
        // Map out block byte-ranges.
        const ranges = [];
        let bk = 0;
        while (bk < d.length && d[bk] === 0xFF) bk++;
        while (bk < d.length - 3) {
            if (d[bk] === 0x01 && d[bk + 1] === 0x3C) {
                const bl = bk + 3 < d.length ? d[bk + 3] : 0;
                const be = Math.min(bk + 4 + bl + 1, d.length);
                ranges.push([bk, be]);
                bk = be;
                while (bk < d.length && d[bk] === 0xFF) bk++;
            } else bk++;
        }
        // Non-0xFF bytes outside any block are leader noise → 0xFF.
        for (let j = 0; j < d.length; j++) {
            if (d[j] === 0xFF) continue;
            let inside = false;
            for (let r = 0; r < ranges.length; r++) if (ranges[r][0] <= j && j < ranges[r][1]) { inside = true; break; }
            if (!inside) d[j] = 0xFF;
        }
        return d;
    }

    /**
     * Virtual read: walk the byte stream's blocks and verify each block's
     * checksum (the byte after the body equals (type+len+Σbody) mod 256).
     * A correctly-decoded tape has zero bad blocks; any bad block means the
     * BIOS will hit a Device I/O error there.
     * @returns {{ok:number, bad:number}}
     */
    _wavVerifyBlocks(d) {
        let i = 0, ok = 0, bad = 0;
        while (i < d.length - 4) {
            if (d[i] === 0x01 && d[i + 1] === 0x3C && (d[i + 2] === 0x00 || d[i + 2] === 0x01)) {
                const type = d[i + 2], len = d[i + 3];
                if (i + 4 + len >= d.length) break;
                let sum = type + len;
                for (let k = 0; k < len; k++) sum += d[i + 4 + k];
                if ((sum & 0xFF) === d[i + 4 + len]) ok++; else bad++;
                i += 4 + len + 1;
            } else i++;
        }
        return { ok, bad };
    }

    /**
     * Decode a measured-width pulse list (the slice path's output) back to
     * bytes and score it by block checksums, so the slice can be compared to
     * the demod on the same footing. Pairs half-cycles into full cycles,
     * re-aligning after every gap, and tries both pairing phases.
     * @returns {{ok:number, bad:number}}
     */
    _wavPulsesToBytes(pulses) {
        const hist = new Int32Array(64);
        for (let i = 0; i < pulses.length; i++) { const w = pulses[i] & 0x7FFF; if (w >= 2 && w < 64) hist[w]++; }
        let p1 = 0; for (let w = 2; w < 64; w++) if (hist[w] > hist[p1]) p1 = w;
        let p2 = 0; for (let w = 2; w < 64; w++) { if (Math.abs(w - p1) < 3) continue; if (hist[w] > hist[p2]) p2 = w; }
        if (!hist[p1] || !hist[p2]) return { ok: 0, bad: 0 };
        const S = Math.min(p1, p2), L = Math.max(p1, p2);
        const cycMid = S + L, gapW = L * 3;
        let best = { ok: 0, bad: 0 };
        for (let phase = 0; phase < 2; phase++) {
            const bits = [];
            let i = phase;
            while (i + 1 < pulses.length) {
                const w1 = pulses[i] & 0x7FFF;
                if (w1 > gapW) { i++; continue; }
                const w2 = pulses[i + 1] & 0x7FFF;
                if (w2 > gapW) { i++; continue; }
                bits.push((w1 + w2) > cycMid ? 1 : 0);
                i += 2;
            }
            const out = [];
            let j = 0;
            while (j < bits.length - 10) {
                if (bits[j] === 0) { let v = 0; for (let b = 0; b < 8; b++) v |= bits[j + 1 + b] << b; out.push(v); j += 11; }
                else j++;
            }
            const v = this._wavVerifyBlocks(out);
            if (v.ok > best.ok || (v.ok === best.ok && v.bad < best.bad)) best = v;
        }
        return best;
    }

    /** True if the byte stream contains a data block (marker 0x01 0x3C 0x01). */
    _wavHasDataBlocks(d) {
        let k = 0;
        while (k < d.length && d[k] === 0xFF) k++;
        while (k < d.length - 3) {
            if (d[k] === 0x01 && d[k + 1] === 0x3C) {
                const bt = d[k + 2];
                if (bt === 0x01) return true;             // data block
                if (bt === 0x00) {                         // header block — skip
                    const bl = k + 3 < d.length ? d[k + 3] : 0;
                    k += 4 + bl + 1;
                    while (k < d.length && d[k] === 0xFF) k++;
                } else break;
            } else k++;
        }
        return false;
    }

    /** Encode one byte as an FM-7 serial frame of canonical pulses. */
    _wavEncodeByte(val, pulses) {
        const S = CMT._TICK_SHORT, L = CMT._TICK_LONG;
        const addBit = (bit) => {
            const w = bit ? L : S;
            pulses.push(0x8000 | w);   // high half-cycle
            pulses.push(w);            // low half-cycle
        };
        addBit(0);                                         // start bit
        for (let b = 0; b < 8; b++) addBit((val >> b) & 1);
        addBit(1); addBit(1);                              // 2 stop bits
    }

    /** Append a run of silence (gap) pulses of the given duration. */
    _wavSilence(seconds, pulses) {
        let ticks = Math.floor(seconds / 9e-6);
        while (ticks > T77_MAX_WIDTH) { pulses.push(T77_MAX_WIDTH); ticks -= T77_MAX_WIDTH; }
        if (ticks > 0) pulses.push(ticks & 0x7FFF);
    }

    /** Eject the tape — clears loaded data (recording buffer kept). */
    eject() {
        this._pulses = null;
        this._loaded = false;
        this._eot = false;
        this._pos = 0;
        this._cycleCount = 0;
        this._level = 0;
        this._motor = false;
    }

    reset() {
        this._motor = false;
        this.rewind();
    }
}
