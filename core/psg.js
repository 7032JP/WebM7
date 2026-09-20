// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// AY-3-8910 PSG / YM2203 SSG Simulator for FM-7 Web Simulator
//
// Two classes are exported:
//
//   PSGCore — pure synthesis (registers + tone/noise/envelope + mixer).
//             No audio output. Reusable from OPN as the SSG section.
//   PSG     — PSGCore + sample output stage (the host attaches the audio
//             device; see audio_output.js in the browser UI), used standalone for the
//             FM-7 built-in PSG at $FD0D/$FD0E.
//
// FM-7 built-in PSG is mapped at $FD0D (command) / $FD0E (data).
// BDIR/BC1 protocol:
//   $03 → Address latch (data bus = register number)
//   $02 → Data write   (data bus → latched register)
//   $01 → Data read    (latched register → data bus)
//   $00 → Inactive
//
// PSG master clock = 1.2288 MHz (same as the synthesis-clock convention used
// throughout the simulator). Tone frequency = clock / (16 × TP),
// noise frequency = clock / (16 × NP), envelope step = clock / (256 × EP).
// =============================================================================

const PSG_CLOCK     = 1228800;       // 1.2288 MHz
const CLOCK_DIV     = 8;             // Internal divider for tone/noise
const ENV_DIV       = CLOCK_DIV * 2; // Envelope runs at half the tone rate
const SAMPLE_RATE   = 44100;

// AY-3-8910 volume table (logarithmic approximation, about 3 dB per step)
const VOL = new Float32Array([
    0.0000, 0.0099, 0.0144, 0.0203,
    0.0287, 0.0405, 0.0573, 0.0809,
    0.1143, 0.1614, 0.2281, 0.3224,
    0.4556, 0.6438, 0.9098, 1.0000,
]);

// =============================================================================
// PSGCore — synthesis only, no audio output
// =============================================================================

export class PSGCore {
    constructor() {
        // --- Registers (R0-R15) ---
        this.regs = new Uint8Array(16);

        // --- BDIR/BC1 interface ---
        this._latchedReg = 0;
        this._dataBus = 0;

        // --- Tone generators (channels A, B, C) ---
        this._tonePeriod  = new Float64Array(3);
        this._toneCount   = new Float64Array(3);
        this._toneOut     = new Uint8Array(3);

        // --- Noise generator ---
        this._noisePeriod = 0;
        this._noiseCount  = 0;
        this._noiseOut    = 0;
        this._lfsr        = 1;           // 17-bit LFSR, must never be 0

        // --- Envelope generator ---
        this._envPeriod   = 0;
        this._envCount    = 0;
        this._envStep     = 0;           // Current level 0-15
        this._envDir      = -1;          // +1 = attack, -1 = decay
        this._envHolding  = false;

        // --- Clock ratios (synthesis-clock == 1.2288 MHz) ---
        this._ticksPerSample    = (PSG_CLOCK / CLOCK_DIV) / SAMPLE_RATE;
        this._envTicksPerSample = (PSG_CLOCK / ENV_DIV)   / SAMPLE_RATE;
        this._cpuToPsgRatio     = PSG_CLOCK / 1794000;  // default FM-7
    }

    // =====================================================================
    // Reset
    // =====================================================================

    setCPUClock(hz) {
        this._cpuToPsgRatio = PSG_CLOCK / hz;
    }

    reset() {
        this.regs.fill(0);
        this.regs[7] = 0xFF;           // Mixer: all disabled
        this._latchedReg = 0;
        this._dataBus = 0;

        this._tonePeriod.fill(0);
        this._toneCount.fill(0);
        this._toneOut.fill(0);

        this._noisePeriod = 0;
        this._noiseCount  = 0;
        this._noiseOut    = 0;
        this._lfsr        = 1;

        this._envPeriod  = 0;
        this._envCount   = 0;
        this._envStep    = 0;
        this._envDir     = -1;
        this._envHolding = false;
    }

    // =====================================================================
    // I/O interface  ($FD0D = command,  $FD0E = data)
    // =====================================================================

    /** Write to command port ($FD0D). */
    writeCmd(val) {
        switch (val & 0x03) {
            case 0x03:                          // Latch address
                this._latchedReg = this._dataBus & 0x0F;
                break;
            case 0x02:                          // Write data
                this._writeReg(this._latchedReg, this._dataBus);
                break;
            case 0x01:                          // Read data
                if (this._latchedReg <= 0x0F) {
                    this._dataBus = this.regs[this._latchedReg];
                }
                break;
            // 0x00 = inactive — do nothing
        }
    }

    /** Write to data port ($FD0E). */
    writeData(val) { this._dataBus = val & 0xFF; }

    /** Read from data port ($FD0E). */
    readData()     { return this._dataBus; }

    /** Read from command port ($FD0D) — returns open-bus 0xFF. */
    readCmd()      { return 0xFF; }

    // =====================================================================
    // Register write
    // =====================================================================

    _writeReg(reg, val) {
        reg &= 0x0F;
        this.regs[reg] = val;

        switch (reg) {
            case 0: case 1:
                this._tonePeriod[0] = ((this.regs[1] & 0x0F) << 8) | this.regs[0];
                break;
            case 2: case 3:
                this._tonePeriod[1] = ((this.regs[3] & 0x0F) << 8) | this.regs[2];
                break;
            case 4: case 5:
                this._tonePeriod[2] = ((this.regs[5] & 0x0F) << 8) | this.regs[4];
                break;
            case 6:
                this._noisePeriod = val & 0x1F;
                break;
            case 11: case 12:
                this._envPeriod = this.regs[11] | (this.regs[12] << 8);
                break;
            case 13:
                // Writing R13 restarts the envelope
                this._envCount = 0;
                this._envHolding = false;
                if (val & 0x04) {
                    this._envStep = 0;   // Attack: start low, go up
                    this._envDir  = 1;
                } else {
                    this._envStep = 15;  // Decay: start high, go down
                    this._envDir  = -1;
                }
                break;
        }
    }

    // =====================================================================
    // Synthesis primitives
    // =====================================================================

    _advance(ticks) {
        // --- Tone counters ---
        for (let ch = 0; ch < 3; ch++) {
            const p = this._tonePeriod[ch];
            if (p < 1) { this._toneOut[ch] = 1; continue; }
            this._toneCount[ch] += ticks;
            while (this._toneCount[ch] >= p) {
                this._toneCount[ch] -= p;
                this._toneOut[ch] ^= 1;
            }
        }

        // --- Noise counter (runs at half the tone rate) ---
        const np = (this._noisePeriod || 1) * 2;
        this._noiseCount += ticks;
        while (this._noiseCount >= np) {
            this._noiseCount -= np;
            // 17-bit LFSR: XOR bits 0 and 3
            const bit = ((this._lfsr ^ (this._lfsr >> 3)) & 1);
            this._lfsr = ((this._lfsr >> 1) | (bit << 16)) & 0x1FFFF;
            if (this._lfsr === 0) this._lfsr = 1;   // Safety
            this._noiseOut = this._lfsr & 1;
        }

        // --- Envelope counter ---
        if (!this._envHolding && this._envPeriod > 0) {
            // Envelope ticks at half the tone counter rate
            const envTicks = ticks * 0.5;
            const ep = this._envPeriod;
            this._envCount += envTicks;
            while (this._envCount >= ep && !this._envHolding) {
                this._envCount -= ep;
                this._envStep += this._envDir;
                if (this._envStep < 0 || this._envStep > 15) {
                    this._envCycle();
                }
            }
        }
    }

    // Handle envelope cycle boundary
    _envCycle() {
        const shape = this.regs[13] & 0x0F;
        const cont  = shape & 0x08;
        const att   = shape & 0x04;
        const alt   = shape & 0x02;
        const hold  = shape & 0x01;

        if (!cont) {
            // Shapes 0-7: one-shot, hold at 0
            this._envStep    = 0;
            this._envHolding = true;
        } else if (hold) {
            // Determine hold level
            if (alt) {
                // 0xB → decay then hold 15;  0xF → attack then hold 0
                this._envStep = att ? 0 : 15;
            } else {
                // 0x9 → decay then hold 0;   0xD → attack then hold 15
                this._envStep = att ? 15 : 0;
            }
            this._envHolding = true;
        } else if (alt) {
            // Triangle (0xA, 0xE): reverse direction
            this._envDir = -this._envDir;
            // Clamp to valid range
            this._envStep = (this._envDir > 0) ? 0 : 15;
        } else {
            // Sawtooth repeat (0x8, 0xC): restart
            this._envStep = att ? 0 : 15;
        }
    }

    _mix() {
        const mixer = this.regs[7];
        let out = 0;

        for (let ch = 0; ch < 3; ch++) {
            // Mixer bits: 0-2 = tone enable (active low), 3-5 = noise enable (active low)
            const toneGate  = ((mixer >> ch)       & 1) ? 1 : this._toneOut[ch];
            const noiseGate = ((mixer >> (ch + 3))  & 1) ? 1 : this._noiseOut;

            if (toneGate & noiseGate) {
                const vr = this.regs[8 + ch];
                const level = (vr & 0x10)
                    ? Math.abs(this._envStep)           // Envelope mode
                    : (vr & 0x0F);                      // Fixed volume
                out += VOL[level];
            }
        }

        // 3 channels max → scale to ≈ ±0.5
        return out * 0.25;
    }

    /**
     * Advance the synthesis core by exactly one output sample's worth of
     * ticks and return the mixed sample value. For embedded use (SSG inside
     * OPN), the caller drives this once per output-rate sample so the
     * SSG progresses in lock-step with the host's audio rate.
     *
     * Returns a float in roughly ±0.5 range (3-channel sum scaled by 0.25).
     */
    generateSample() {
        this._advance(this._ticksPerSample);
        return this._mix();
    }

    // =====================================================================
    // Read-only inspection (for a debug view). These never touch chip state
    // and never affect synthesis.
    // =====================================================================

    /**
     * Register file R0-R15. The live array is returned for cheap polling;
     * callers must treat it as read-only.
     */
    getRegisters() {
        return this.regs;
    }

    /**
     * Per-channel output level for A/B/C as 0-15.
     * Same rule _mix() uses: the volume register (R8-R10) holds a fixed level
     * in bits 0-3, and bit4 selects the envelope generator's current step
     * instead. A channel whose tone and noise are both gated off in the mixer
     * (R7) only emits a DC level, so it is reported as 0.
     * @param {number[]} [out] optional 3-element array to fill (avoids garbage)
     */
    getChannelLevels(out = [0, 0, 0]) {
        const mixer = this.regs[7];
        for (let ch = 0; ch < 3; ch++) {
            const gatedOff = ((mixer >> ch) & 1) && ((mixer >> (ch + 3)) & 1);
            const vr = this.regs[8 + ch];
            const level = (vr & 0x10) ? Math.abs(this._envStep) : (vr & 0x0F);
            out[ch] = gatedOff ? 0 : level;
        }
        return out;
    }
}

// =============================================================================
// PSG — PSGCore + audio output (standalone FM-7 built-in PSG)
// =============================================================================

export class PSG extends PSGCore {
    constructor() {
        super();

        // --- Audio output ---
        this._audioCtx    = null;
        this._workletNode = null;
        this._gainNode    = null;
        this._volume      = 0.5;          // Default 50%
        // Sample staging buffer for the current step() call. Resized as
        // needed; flushed (transferred) to the attached output port at the end of
        // each step() so the audio thread always has fresh data.
        this._sampleBuf   = new Float32Array(2048);
        this._sampleLen   = 0;

        // --- Clock accumulator ---
        this._accum       = 0;
    }

    reset() {
        super.reset();
        this._accum = 0;
        this._sampleLen = 0;
    }

    /**
     * Advance the PSG by `cpuCycles` worth of audio and fill the ring buffer.
     * Must be called regularly from the frame loop.
     */
    step(cpuCycles) {
        if (!this._audioCtx) return;

        // Convert CPU cycles to PSG internal ticks (1.2288 MHz / 8)
        this._accum += cpuCycles * this._cpuToPsgRatio / CLOCK_DIV;
        const tps = this._ticksPerSample;

        let len = this._sampleLen;
        let buf = this._sampleBuf;
        while (this._accum >= tps) {
            this._accum -= tps;
            this._advance(tps);
            if (len >= buf.length) {
                // Grow staging buffer (rare; simulator catches up after pause)
                const grown = new Float32Array(buf.length * 2);
                grown.set(buf);
                this._sampleBuf = buf = grown;
            }
            buf[len++] = this._mix();
        }
        this._sampleLen = len;

        // Flush in chunks of FLUSH_SIZE samples. step() runs per CPU
        // instruction (hundreds of thousands of times per second) so
        // posting on every call would saturate the message channel and
        // cause audible crackling. 1024 samples ≈ 21ms at 48 kHz, which
        // is a reasonable trade-off between latency and overhead.
        if (this._workletNode) {
            const FLUSH_SIZE = 1024;
            while (this._sampleLen >= FLUSH_SIZE) {
                const chunk = this._sampleBuf.slice(0, FLUSH_SIZE);
                this._workletNode.port.postMessage(
                    { type: 'samples', data: chunk },
                    [chunk.buffer],
                );
                // Shift remaining samples down
                this._sampleBuf.copyWithin(0, FLUSH_SIZE, this._sampleLen);
                this._sampleLen -= FLUSH_SIZE;
            }
        }
    }

    // =====================================================================
    // Output volume (the audio output itself is attached by the host: see
    // audio_output.js of the browser UI, which sets _audioCtx / _workletNode /
    // _gainNode. The core only generates samples into _sampleBuf and hands
    // full chunks to _workletNode.port when one is attached.)
    // =====================================================================

    /**
     * Set output volume.
     * @param {number} v - 0.0 (silent) to 1.0 (full)
     */
    setVolume(v) {
        this._volume = Math.max(0, Math.min(1, v));
        if (this._gainNode) {
            this._gainNode.gain.value = this._volume;
        }
    }

    /** Get current volume (0.0-1.0). */
    getVolume() { return this._volume; }
}
