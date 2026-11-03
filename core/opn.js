// SPDX-License-Identifier: LicenseRef-fmgen AND MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa (MIT portion)
// =============================================================================
// YM2203 (OPN) FM + SSG Sound Synthesizer
//
// The FM synthesis portion of this file is a JavaScript port of
// "FM Sound Generator" (fmgen), Copyright (C) by cisc 1998, 2003.
// This portion is NOT covered by the project's MIT License; it is
// provided under the original fmgen terms (see LICENSE-fmgen.md and
// core/fmgen_readme.txt, the original readme included unmodified).
// Modifications from the original: C++ to JavaScript translation,
// reduction to the YM2203 (OPN) feature set, and integration with
// this simulator's sample output stage.
//
// 3 FM channels (4 operators each, phase modulation synthesis) plus
// 3 SSG channels rendered through an embedded PSGCore (psg.js).
// FM and SSG outputs are mixed together into the OPN's output port.
// Handles the timers and the audio synthesis. In FM77AV mode the timers
// count at the timer reference clock; otherwise they count CPU cycles.
// =============================================================================

import { PSGCore } from './psg.js';

const MASTER_CLOCK  = 1228800;
// Timer reference clock.
const OPN_TIMER_CLOCK_AV = 1228800;
const SAMPLE_RATE   = 44100;


// ---------------------------------------------------------------------------
// Envelope phase identifiers
// ---------------------------------------------------------------------------
const ENV_PHASE_ATTACK  = 1;
const ENV_PHASE_DECAY   = 2;
const ENV_PHASE_SUSTAIN = 3;
const ENV_PHASE_RELEASE = 4;
const ENV_PHASE_OFF     = 5;
const ENV_PHASE_HOLD    = 6;

// ---------------------------------------------------------------------------
// Synthesis dimension constants
// ---------------------------------------------------------------------------
const SINE_INDEX_BITS    = 10;
const SINE_TABLE_SIZE    = 1 << SINE_INDEX_BITS;    // 1024
const PHASE_EXTRA_BITS   = 2;
const CLOCK_RATIO_BITS   = 8;
const ENV_BITS           = 16;
const LFO_BITS           = 8;
const LFO_TABLE_SIZE     = 1 << LFO_BITS;           // 256
const TOTAL_LEVEL_BITS   = 7;
const TOTAL_LEVEL_COUNT  = 1 << TOTAL_LEVEL_BITS;   // 128
const LOG_TO_LIN_SIZE    = 0x1000 * 2;               // 8192
const OUTPUT_SCALE       = 16384;
const PI_CONST           = Math.PI;

// Envelope level treated as silence.
const ENV_QUIET_LEVEL   = 960;

// OUTPUT_TO_ENV_SHIFT = (20 + PHASE_EXTRA_BITS) - 13 = 9
const OUTPUT_TO_ENV_SHIFT = (20 + PHASE_EXTRA_BITS) - 13;

// ---------------------------------------------------------------------------
// Hardware mapping tables
// ---------------------------------------------------------------------------

// Register slot order -> operator index
const REG_TO_OP_MAP = [0, 2, 1, 3];

// Feedback register value -> shift amount
const FEEDBACK_SHIFT_TABLE = [31, 7, 6, 5, 4, 3, 2, 1];

// Sustain level register value -> internal level
const SUSTAIN_LEVEL_TABLE = [
      0,   4,   8,  12,  16,  20,  24,  28,
     32,  36,  40,  44,  48,  52,  56, 124,
];

// Key scale: F-number (bits 7..13) -> key code (0..31)
const KEY_SCALE_TABLE = new Uint8Array([
     0,  0,  0,  0,  0,  0,  0,  1,  2,  3,  3,  3,  3,  3,  3,  3,
     4,  4,  4,  4,  4,  4,  4,  5,  6,  7,  7,  7,  7,  7,  7,  7,
     8,  8,  8,  8,  8,  8,  8,  9, 10, 11, 11, 11, 11, 11, 11, 11,
    12, 12, 12, 12, 12, 12, 12, 13, 14, 15, 15, 15, 15, 15, 15, 15,
    16, 16, 16, 16, 16, 16, 16, 17, 18, 19, 19, 19, 19, 19, 19, 19,
    20, 20, 20, 20, 20, 20, 20, 21, 22, 23, 23, 23, 23, 23, 23, 23,
    24, 24, 24, 24, 24, 24, 24, 25, 26, 27, 27, 27, 27, 27, 27, 27,
    28, 28, 28, 28, 28, 28, 28, 29, 30, 31, 31, 31, 31, 31, 31, 31,
]);

// Detune table: (dt*32 + bn) -> detune value
const DETUNE_TABLE = new Int8Array([
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  2,  2,  2,  2,  2,  2,  2,  2,  4,  4,  4,  4,
      4,  6,  6,  6,  8,  8,  8, 10, 10, 12, 12, 14, 16, 16, 16, 16,
      2,  2,  2,  2,  4,  4,  4,  4,  4,  6,  6,  6,  8,  8,  8, 10,
     10, 12, 12, 14, 16, 16, 18, 20, 22, 24, 26, 28, 32, 32, 32, 32,
      4,  4,  4,  4,  4,  6,  6,  6,  8,  8,  8, 10, 10, 12, 12, 14,
     16, 16, 18, 20, 22, 24, 26, 28, 32, 34, 38, 40, 44, 44, 44, 44,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0, -2, -2, -2, -2, -2, -2, -2, -2, -4, -4, -4, -4,
     -4, -6, -6, -6, -8, -8, -8,-10,-10,-12,-12,-14,-16,-16,-16,-16,
     -2, -2, -2, -2, -4, -4, -4, -4, -4, -6, -6, -6, -8, -8, -8,-10,
    -10,-12,-12,-14,-16,-16,-18,-20,-22,-24,-26,-28,-32,-32,-32,-32,
     -4, -4, -4, -4, -4, -6, -6, -6, -8, -8, -8,-10,-10,-12,-12,-14,
    -16,-16,-18,-20,-22,-24,-26,-28,-32,-34,-38,-40,-44,-44,-44,-44,
]);

// ---------------------------------------------------------------------------
// Envelope rate tables
// ---------------------------------------------------------------------------

// Envelope rate pattern: [rate][patternIdx & 7] -> EG increment
function buildEnvRatePattern() {
    // Build the envelope update tables.
    const basePatterns = [
        [1, 0, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 1, 1, 0],
        [1, 1, 1, 1, 1, 1, 1, 0],
    ];
    const table = new Array(64);
    for (let rate = 0; rate < 64; rate++) {
        if (rate < 2) {
            // Rates 0-1: no envelope change
            table[rate] = [0, 0, 0, 0, 0, 0, 0, 0];
        } else if (rate < 4) {
            // Rates 2-3: all ones (uniform increment)
            table[rate] = [1, 1, 1, 1, 1, 1, 1, 1];
        } else if (rate < 8) {
            // Rates 4-7: transitional patterns
            if (rate < 6) {
                table[rate] = [1, 1, 1, 1, 1, 1, 1, 1];
            } else {
                table[rate] = [1, 1, 1, 0, 1, 1, 1, 0];
            }
        } else if (rate < 48) {
            // Rates 8-47: base pattern with increment 1
            const pat = basePatterns[rate % 4];
            table[rate] = pat.slice();
        } else if (rate < 60) {
            // Rates 48-59: increment doubles every 4 rates
            const pat = basePatterns[rate % 4];
            const group = Math.floor((rate - 48) / 4); // 0, 1, 2
            const hi = 1 << (group + 1);  // 2, 4, 8
            const lo = 1 << group;        // 1, 2, 4
            table[rate] = pat.map(v => v ? hi : lo);
        } else {
            // Rates 60-63: all 16 (maximum increment, clamped)
            table[rate] = [16, 16, 16, 16, 16, 16, 16, 16];
        }
    }
    return table;
}
const ENV_RATE_PATTERN = buildEnvRatePattern();

// Envelope rate table: rate/4 -> counter decrement per tick
// Powers of 2 from 2^0 to 2^10, clamped at 2047 for indices 11-15.
const ENV_RATE_DIVIDER = Array.from({length: 16}, (_, i) =>
    i < 11 ? (1 << i) : 2047
);

// Attack curve: [rate][patternIdx & 7] -> shift amount (-1 = skip)
function buildAttackTable() {
    const basePatterns = [
        [1, 0, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 0, 1, 0],
        [1, 1, 1, 0, 1, 1, 1, 0],
        [1, 1, 1, 1, 1, 1, 1, 0],
    ];
    const table = new Array(64);
    for (let rate = 0; rate < 64; rate++) {
        if (rate < 2) {
            // No attack
            table[rate] = [-1, -1, -1, -1, -1, -1, -1, -1];
        } else if (rate < 4) {
            // All active, shift 4
            table[rate] = [4, 4, 4, 4, 4, 4, 4, 4];
        } else if (rate < 8) {
            // Transitional: same logic as ENV_RATE_PATTERN but with shift 4 / -1
            if (rate < 6) {
                table[rate] = [4, 4, 4, 4, 4, 4, 4, 4];
            } else {
                table[rate] = [4, 4, 4, -1, 4, 4, 4, -1];
            }
        } else if (rate < 48) {
            // Standard range: shift 4 where pattern is active, -1 otherwise
            const pat = basePatterns[rate % 4];
            table[rate] = pat.map(v => v ? 4 : -1);
        } else if (rate < 60) {
            // High rates: decreasing shift values (3, 2, 1) with pattern blending
            const group = Math.floor((rate - 48) / 4); // 0, 1, 2
            const hi = 4 - (group + 1);  // 3, 2, 1
            const lo = 4 - group;        // 4, 3, 2
            const pat = basePatterns[rate % 4];
            table[rate] = pat.map(v => v ? hi : lo);
        } else {
            // Maximum rate: instant attack (shift 0)
            table[rate] = [0, 0, 0, 0, 0, 0, 0, 0];
        }
    }
    return table;
}
const ATTACK_CURVE_TABLE = buildAttackTable();


// ---------------------------------------------------------------------------
// Computed waveform and conversion tables (built once at module load)
// ---------------------------------------------------------------------------

// Logarithmic sine lookup table.
// 1024 entries, output is index into expTable (as s*2 or s*2+1)
const logSinTable = new Uint32Array(SINE_TABLE_SIZE);

// Log-to-linear lookup table, pairs of [positive, negative]
const expTable = new Int32Array(LOG_TO_LIN_SIZE);

// LFO modulation tables
const lfoPhaseTable = new Array(2);
const lfoAmpTable = new Array(2);

// LFO rate table
const lfoRateTable = new Uint32Array(8);

function _clampLow(a, b) { return a < b ? a : b; }
function _clampHigh(a, b) { return a > b ? a : b; }

// Build all computed tables
(function initializeTables() {
    // -- expTable (log-to-linear conversion) --
    let tableIdx = 0;
    let pos = 0;
    while (pos < LOG_TO_LIN_SIZE) {
        let v = Math.floor(Math.pow(2, 13 - (tableIdx % 256) / 256));
        v = ((v + 2) & ~3) >> (tableIdx >> 8);
        expTable[pos++] = v;
        expTable[pos++] = -v;
        tableIdx++;
    }

    // -- logSinTable --
    const ln2 = Math.log(2);
    for (let i = 0; i < SINE_TABLE_SIZE / 2; i++) {
        const angle = (i * 2 + 1) * PI_CONST / SINE_TABLE_SIZE;
        const logVal = -256 * Math.log(Math.sin(angle)) / ln2;
        const quantized = Math.floor(logVal + 0.5) + 1;
        logSinTable[i] = quantized * 2;
        logSinTable[SINE_TABLE_SIZE / 2 + i] = quantized * 2 + 1;
    }

    // -- LFO tables (phase modulation and amplitude modulation) --
    const pmDepths = [
        [0, 1/360, 2/360, 3/360, 4/360, 6/360, 12/360, 24/360],   // variant 0
        [0, 1/480, 2/480, 4/480, 10/480, 20/480, 80/480, 140/480], // variant 1
    ];
    const amShifts = [
        [31, 6, 4, 3], // variant 0
        [31, 2, 1, 0], // variant 1
    ];

    for (let variant = 0; variant < 2; variant++) {
        lfoPhaseTable[variant] = new Array(8);
        for (let i = 0; i < 8; i++) {
            lfoPhaseTable[variant][i] = new Int32Array(LFO_TABLE_SIZE);
            const depth = pmDepths[variant][i];
            for (let j = 0; j < LFO_TABLE_SIZE; j++) {
                const expVal = Math.pow(2, depth * (2 * j - LFO_TABLE_SIZE + 1) / (LFO_TABLE_SIZE - 1));
                const sinVal = 0.6 * depth * Math.sin(2 * j * PI_CONST / LFO_TABLE_SIZE) + 1;
                if (variant === 0)
                    lfoPhaseTable[variant][i][j] = Math.floor(0x10000 * (sinVal - 1));
                else
                    lfoPhaseTable[variant][i][j] = Math.floor(0x10000 * (expVal - 1));
            }
        }
        lfoAmpTable[variant] = new Array(4);
        for (let i = 0; i < 4; i++) {
            lfoAmpTable[variant][i] = new Uint32Array(LFO_TABLE_SIZE);
            for (let j = 0; j < LFO_TABLE_SIZE; j++) {
                lfoAmpTable[variant][i][j] = (((j * 4) >> amShifts[variant][i]) * 2) << 2;
            }
        }
    }
})();

// ---------------------------------------------------------------------------
// SynthChip: per-chip state (clock-ratio-dependent tables)
// ---------------------------------------------------------------------------
class SynthChip {
    constructor() {
        this.clockRatio = 0;
        this.ampModLevel = 0;
        this.phaseModLevel = 0;
        this.phaseModValue = 0;
        this.phaseMultTable = [];
        this.envRateTable = new Uint32Array(16);
        for (let h = 0; h < 4; h++) {
            this.phaseMultTable.push(new Uint32Array(16));
        }
    }

    updateRatio(ratio) {
        if (this.clockRatio !== ratio) {
            this.clockRatio = ratio;
            this._buildDerivedTables();
        }
    }

    // Part of the fmgen port (see the file header and LICENSE-fmgen.md): the
    // clock ratio is folded into the multiplier table.
    _buildDerivedTables() {
        const dt2Coefficients = [1.0, 1.414, 1.581, 1.732];
        for (let h = 0; h < 4; h++) {
            const scaled = dt2Coefficients[h] * this.clockRatio;
            for (let l = 0; l < 16; l++) {
                const mul = l ? l * 2 : 1;
                this.phaseMultTable[h][l] = Math.floor(mul * scaled);
            }
        }
        this.envRateTable[0] = 0;
        for (let h = 1; h < 16; h++) {
            this.envRateTable[h] =
                ((this.clockRatio << (ENV_BITS - CLOCK_RATIO_BITS)) << _clampLow(h, 11)) >>> 0;
        }
    }

    getMultiplied(dt2, mul) { return this.phaseMultTable[dt2][mul]; }
    getAmpModLevel() { return this.ampModLevel; }
    getPhaseModLevel() { return this.phaseModLevel; }
    getPhaseModValue() { return this.phaseModValue; }
    setAmpModLevel(l) { this.ampModLevel = l & (LFO_TABLE_SIZE - 1); }
    setPhaseModLevel(l) { this.phaseModLevel = l & (LFO_TABLE_SIZE - 1); }
    setPhaseModValue(v) { this.phaseModValue = v; }
}

// ---------------------------------------------------------------------------
// FMOperator: single FM operator with phase generator and envelope generator
// ---------------------------------------------------------------------------
class FMOperator {
    constructor() {
        this.chip = null;

        // Output
        this.outputVal = 0;
        this.prevSample = 0;
        this.modulationInput = 0;

        // Phase Generator
        this.phaseStep = 0;
        this.detuneOffset = 0;
        this.detune2Index = 0;
        this.freqMultiple = 0;
        this.phaseAccum = 0;
        this.phaseDelta = 0;
        this.phaseDeltaLFO = 0;

        // Envelope Generator
        this.synthVariant = 0;
        this.keyNote = 0;
        this.envLevel = 0;
        this.envLevelNextThreshold = 0;
        this.envCounter = 0;
        this.envCounterThreshold = 0;
        this.envOutput = 0;
        this.totalLevelScaled = 0;
        this.envRate = 0;
        this.envPatternIdx = 0;
        this.ssgEnvOffset = 0;
        this.ssgEnvVector = 0;
        this.ssgEnvState = 0;

        this.keyScaleAdjust = 0;
        this.egStage = ENV_PHASE_OFF;
        this.ampModSource = lfoAmpTable[0][0];
        this.lfoSensitivity = 0;

        this.totalLevel = 127;
        this.totalLevelLatched = 127;
        this.attackRate = 0;
        this.decayRate = 0;
        this.sustainRate = 0;
        this.sustainLevel = 0;
        this.releaseRate = 0;
        this.keyScale = 0;
        this.ssgMode = 0;

        this.keyPressed = false;
        this.ampModEnabled = false;
        this.needsRecalc = true;
        this.silenced = false;
    }

    assignChip(chip) { this.chip = chip; }

    reset() {
        this.totalLevel = this.totalLevelLatched = 127;
        this._updatePhase(ENV_PHASE_OFF);
        this.envCounter = 0;
        this.envPatternIdx = 0;
        this.phaseAccum = 0;
        this.outputVal = this.prevSample = 0;
        this.needsRecalc = true;
    }

    clearFeedback() {
        this.outputVal = this.prevSample = 0;
    }

    isActive() {
        return this.egStage - ENV_PHASE_OFF;
    }

    currentOutput() { return this.outputVal; }

    // --- Parameter setters ---
    writeDT(dt) { this.detuneOffset = dt * 0x20; this.needsRecalc = true; }
    writeDT2(dt2) { this.detune2Index = dt2 & 3; this.needsRecalc = true; }
    writeMUL(mul) { this.freqMultiple = mul; this.needsRecalc = true; }

    writeTL(tl, csm) {
        if (!csm) {
            this.totalLevel = tl;
            this.needsRecalc = true;
        }
        this.totalLevelLatched = tl;
    }

    writeKS(ks) { this.keyScale = ks; this.needsRecalc = true; }
    writeAR(ar) { this.attackRate = ar; this.needsRecalc = true; }
    writeDR(dr) { this.decayRate = dr; this.needsRecalc = true; }
    writeSR(sr) { this.sustainRate = sr; this.needsRecalc = true; }
    writeRR(rr) { this.releaseRate = rr; this.needsRecalc = true; }
    writeSL(sl) { this.sustainLevel = sl; this.needsRecalc = true; }
    writeAMON(on) { this.ampModEnabled = on; this.needsRecalc = true; }
    writeLFOSens(ms) { this.lfoSensitivity = ms; this.needsRecalc = true; }
    setSilenced(m) { this.silenced = m; this.needsRecalc = true; }

    writeSSGEG(ssgec) {
        if (ssgec & 8)
            this.ssgMode = ssgec & 0x0f;
        else
            this.ssgMode = 0;
        this.needsRecalc = true;
    }

    // Key on — only triggers on 0→1 transition.
    keyOn() {
        if (!this.keyPressed) {
            this.keyPressed = true;
            if (this.egStage === ENV_PHASE_OFF || this.egStage === ENV_PHASE_RELEASE) {
                if (this.ssgMode & 8) {
                    this.ssgMode &= ~0x10;
                    this.ssgMode |= (this.ssgMode & 4) << 2;
                }
                this.ssgEnvState = -1;
                this._updatePhase(ENV_PHASE_ATTACK);
                this._refreshEnvOutput();
                this.modulationInput = this.outputVal = this.prevSample = 0;
                this.phaseAccum = 0;
            }
        }
    }

    // Key off — only triggers on 1→0 transition
    keyOff() {
        if (this.keyPressed) {
            this.keyPressed = false;
            this._updatePhase(ENV_PHASE_RELEASE);
        }
    }

    // Set F-Number (block/fnum combined)
    setFrequency(f) {
        this.phaseStep = (f & 2047) << ((f >> 11) & 7);
        this.keyNote = KEY_SCALE_TABLE[(f >> 7) & 127];
        this.needsRecalc = true;
    }

    setPhaseAndNote(dp, bn) {
        this.phaseStep = dp;
        this.keyNote = bn;
        this.needsRecalc = true;
    }

    // --- Recalculate derived parameters ---
    recalculate() {
        if (this.needsRecalc) {
            this.needsRecalc = false;

            // Phase generator computation
            let pgc = this.phaseStep + DETUNE_TABLE[this.detuneOffset + this.keyNote];
            if (pgc < 0) pgc = 0x3ff80; // 2047 << 7

            this.phaseDelta = Math.floor(
                (pgc * this.chip.getMultiplied(this.detune2Index, this.freqMultiple))
                / (1 << (2 + CLOCK_RATIO_BITS - PHASE_EXTRA_BITS))
            );
            this.phaseDeltaLFO = this.phaseDelta >> 11;

            // Envelope generator computation
            this.keyScaleAdjust = this.keyNote >> (3 - this.keyScale);
            this.totalLevelScaled = this.silenced ? 0x3ff : this.totalLevel * 8;

            switch (this.egStage) {
                case ENV_PHASE_ATTACK:
                    this._configureEnvRate(this.attackRate ? _clampLow(63, this.attackRate + this.keyScaleAdjust) : 0);
                    break;
                case ENV_PHASE_DECAY:
                    this._configureEnvRate(this.decayRate ? _clampLow(63, this.decayRate + this.keyScaleAdjust) : 0);
                    this.envLevelNextThreshold = this.sustainLevel * 8;
                    break;
                case ENV_PHASE_SUSTAIN:
                    this._configureEnvRate(this.sustainRate ? _clampLow(63, this.sustainRate + this.keyScaleAdjust) : 0);
                    break;
                case ENV_PHASE_RELEASE:
                    this._configureEnvRate(_clampLow(63, this.releaseRate + this.keyScaleAdjust));
                    break;
            }

            // LFO amplitude modulation source
            this.ampModSource = lfoAmpTable[this.synthVariant][this.ampModEnabled ? (this.lfoSensitivity >> 4) & 3 : 0];
            this._refreshEnvOutput();
        }
    }

    // --- Envelope internals ---
    _configureEnvRate(rate) {
        this.envRate = rate;
        this.envCounterThreshold = ENV_RATE_DIVIDER[rate >> 2];
    }

    _refreshEnvOutput() {
        if (!this.ssgMode) {
            this.envOutput = _clampLow(this.totalLevelScaled + this.envLevel, 0x3ff) << (1 + 2);
        } else {
            if ((this.ssgMode & 0x18) === 0x18) {
                this.ssgEnvVector = -1;
                this.ssgEnvOffset = 1023;
            } else {
                this.ssgEnvVector = 1;
                this.ssgEnvOffset = 0;
            }
            this.envOutput = _clampHigh(0, _clampLow(
                this.totalLevelScaled + this.envLevel * this.ssgEnvVector + this.ssgEnvOffset, 0x3ff
            )) << (1 + 2);
        }
    }

    _advanceEnvelope() {
        // Part of the fmgen port (see the file header and LICENSE-fmgen.md):
        // the counter reload is scaled by the clock ratio.
        this.envCounter = Math.floor((2047 * 3 * (1 << CLOCK_RATIO_BITS)) / this.chip.clockRatio);

        if (this.egStage === ENV_PHASE_ATTACK) {
            const c = ATTACK_CURVE_TABLE[this.envRate][this.envPatternIdx & 7];
            if (c >= 0) {
                this.envLevel -= 1 + (this.envLevel >> c);
                if (this.envLevel <= 0)
                    this._updatePhase(ENV_PHASE_DECAY);
            }
        } else {
            if (!this.ssgMode || (this.egStage === ENV_PHASE_RELEASE)) {
                this.envLevel += ENV_RATE_PATTERN[this.envRate][this.envPatternIdx & 7];
                if (this.envLevel >= this.envLevelNextThreshold)
                    this._updatePhase(this.egStage + 1);
            } else {
                this.envLevel += 4 * ENV_RATE_PATTERN[this.envRate][this.envPatternIdx & 7];
                if (this.envLevel >= this.envLevelNextThreshold) {
                    if (this.egStage !== ENV_PHASE_OFF)
                        this._updatePhase(this.egStage + 1);
                }
            }
        }
        this._refreshEnvOutput();
        this.envPatternIdx++;
    }

    _tickEnvelope() {
        this.envCounter -= this.envCounterThreshold;
        if (this.envCounter <= 0)
            this._advanceEnvelope();
    }

    // --- Phase Generator ---
    _stepPhase() {
        const ret = this.phaseAccum >>> 0;
        this.phaseAccum = (this.phaseAccum + this.phaseDelta) >>> 0;
        return ret;
    }

    _stepPhaseVibrato() {
        const ret = this.phaseAccum >>> 0;
        this.phaseAccum = (this.phaseAccum + this.phaseDelta +
            ((this.phaseDeltaLFO * this.chip.getPhaseModValue()) >> 5)) >>> 0;
        return ret;
    }

    // --- Log to linear ---
    _expLookup(a) {
        return (a < LOG_TO_LIN_SIZE) ? expTable[a] : 0;
    }

    // --- Operator sample generation ---
    // Modulated operator (no LFO)
    generateSample(inp) {
        this._tickEnvelope();
        this.prevSample = this.outputVal;

        let pgin = this._stepPhase() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        pgin += inp >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS - (2 + OUTPUT_TO_ENV_SHIFT));
        this.outputVal = this._expLookup(this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)]);

        return this.outputVal;
    }

    // Modulated operator with LFO
    generateSampleLFO(inp) {
        this._tickEnvelope();

        let pgin = this._stepPhaseVibrato() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        pgin += inp >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS - (2 + OUTPUT_TO_ENV_SHIFT));
        this.outputVal = this._expLookup(
            this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)] + this.ampModSource[this.chip.getAmpModLevel()]
        );

        return this.outputVal;
    }

    // Self-feedback operator (no LFO), returns PREVIOUS output
    generateFeedback(fb) {
        this._tickEnvelope();

        const combined = this.outputVal + this.prevSample;
        this.prevSample = this.outputVal;

        let pgin = this._stepPhase() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        if (fb < 31) {
            pgin += ((combined << (1 + OUTPUT_TO_ENV_SHIFT)) >> fb) >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        }
        this.outputVal = this._expLookup(this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)]);

        return this.prevSample;
    }

    // Self-feedback operator with LFO, returns CURRENT output
    generateFeedbackLFO(fb) {
        this._tickEnvelope();

        const combined = this.outputVal + this.prevSample;
        this.prevSample = this.outputVal;

        let pgin = this._stepPhaseVibrato() >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        if (fb < 31) {
            pgin += ((combined << (1 + OUTPUT_TO_ENV_SHIFT)) >> fb) >> (20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS);
        }
        this.outputVal = this._expLookup(
            this.envOutput + logSinTable[pgin & (SINE_TABLE_SIZE - 1)] + this.ampModSource[this.chip.getAmpModLevel()]
        );

        return this.outputVal;
    }

    // --- Envelope phase transitions ---
    _updatePhase(nextphase) {
        switch (nextphase) {
            case ENV_PHASE_HOLD:
                this.envLevel = ENV_QUIET_LEVEL;
                this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                break;

            case ENV_PHASE_ATTACK:
                this.totalLevel = this.totalLevelLatched;
                if ((this.attackRate + this.keyScaleAdjust) < 62) {
                    this._configureEnvRate(this.attackRate ? _clampLow(63, this.attackRate + this.keyScaleAdjust) : 0);
                    this.egStage = ENV_PHASE_ATTACK;
                    break;
                }
                // fall through to decay
            // falls through
            case ENV_PHASE_DECAY:
                if (this.sustainLevel) {
                    this.envLevel = 0;
                    this.envLevelNextThreshold = this.sustainLevel * 8;
                    this._configureEnvRate(this.decayRate ? _clampLow(63, this.decayRate + this.keyScaleAdjust) : 0);
                    this.egStage = ENV_PHASE_DECAY;
                    break;
                }
                // fall through to sustain
            // falls through
            case ENV_PHASE_SUSTAIN:
                if (this.ssgMode && (this.sustainLevel >= 124)) {
                    this.envLevel = this.envLevelNextThreshold = 0x400;
                    this.egStage = ENV_PHASE_RELEASE;
                } else {
                    this.envLevel = this.sustainLevel * 8;
                    this.envLevelNextThreshold = 0x400;
                    this._configureEnvRate(this.sustainRate ? _clampLow(63, this.sustainRate + this.keyScaleAdjust) : 0);
                    this.egStage = ENV_PHASE_SUSTAIN;
                    break;
                }
                // fall through to release
            // falls through
            case ENV_PHASE_RELEASE:
                if (this.egStage === ENV_PHASE_ATTACK ||
                    (this.envLevel < (this.ssgMode ? 0x400 : ENV_QUIET_LEVEL))) {
                    if (this.ssgMode) {
                        if (this.ssgMode & 0x10) {
                            this.envLevel = 1023 - this.envLevel;
                        }
                        this.ssgMode &= ~0x10;
                    }
                    this.envLevelNextThreshold = 0x400;
                    this._configureEnvRate(_clampLow(63, this.releaseRate + this.keyScaleAdjust));
                    this.egStage = ENV_PHASE_RELEASE;
                    break;
                } else if (this.ssgMode) {
                    if ((this.ssgMode & 3) !== 2) {
                        this.envLevel = ENV_QUIET_LEVEL;
                        this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                    }
                    if (this.ssgMode & 1) {
                        // one shot
                        this._configureEnvRate(0);
                        this.egStage = ENV_PHASE_HOLD;
                    } else {
                        // repeat
                        this._configureEnvRate(this.attackRate ? _clampLow(63, this.attackRate + this.keyScaleAdjust) : 0);
                        this.egStage = ENV_PHASE_ATTACK;
                    }
                    if (this.ssgMode & 2) {
                        // alternate
                        this.ssgMode ^= 0x10;
                        if (!(this.ssgMode & 1)) {
                            this.envLevel = this.envLevelNextThreshold = 0;
                        }
                    }
                    break;
                }
                // fall through to off
            // falls through
            case ENV_PHASE_OFF:
            default:
                this.envLevel = ENV_QUIET_LEVEL;
                this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                this._refreshEnvOutput();
                this._configureEnvRate(0);
                this.egStage = ENV_PHASE_OFF;
                break;
        }
    }
}

// Carrier operators per algorithm, as a bit mask over the op[] indices.
// Used only by the FM channel level readout.
const FM_CARRIER_MASK = [0x08, 0x08, 0x08, 0x08, 0x0a, 0x0e, 0x0e, 0x0f];

// ---------------------------------------------------------------------------
// OpnVoice: 4-operator FM channel
// ---------------------------------------------------------------------------
class OpnVoice {
    constructor() {
        this.op = [new FMOperator(), new FMOperator(), new FMOperator(), new FMOperator()];
        this.fb = 31;   // feedback shift (from FEEDBACK_SHIFT_TABLE)
        this.algorithm = 0;
        this.chip = null;
        this.phaseLfoData = lfoPhaseTable[0][0];
        this.channelMuted = false;
    }

    assignChip(chip) {
        this.chip = chip;
        for (let i = 0; i < 4; i++) this.op[i].assignChip(chip);
    }

    setSynthVariant(variant) {
        for (let i = 0; i < 4; i++) this.op[i].synthVariant = variant;
    }

    writeFeedback(feedback) {
        this.fb = FEEDBACK_SHIFT_TABLE[feedback];
    }

    setFrequency(f) {
        for (let i = 0; i < 4; i++) this.op[i].setFrequency(f);
    }

    writeLFOSens(ms) {
        for (let i = 0; i < 4; i++) this.op[i].writeLFOSens(ms);
    }

    muteChannel(m) {
        for (let i = 0; i < 4; i++) this.op[i].setSilenced(m);
        this.channelMuted = m;
    }

    markDirty() {
        for (let i = 0; i < 4; i++) this.op[i].needsRecalc = true;
    }

    /** True while any operator's envelope is not OFF (bit 0 of prepareForRender()). */
    isActive() {
        const op = this.op;
        return (op[0].isActive() | op[1].isActive() | op[2].isActive() | op[3].isActive()) !== 0;
    }

    reset() {
        for (let i = 0; i < 4; i++) this.op[i].reset();
    }

    configureAlgorithm(algo) {
        this.op[0].clearFeedback();
        this.algorithm = algo;
    }

    setKeyOnSlots(key) {
        if (key & 0x1) this.op[0].keyOn(); else this.op[0].keyOff();
        if (key & 0x2) this.op[1].keyOn(); else this.op[1].keyOff();
        if (key & 0x4) this.op[2].keyOn(); else this.op[2].keyOff();
        if (key & 0x8) this.op[3].keyOn(); else this.op[3].keyOff();
    }

    prepareForRender() {
        this.op[0].recalculate();
        this.op[1].recalculate();
        this.op[2].recalculate();
        this.op[3].recalculate();

        this.phaseLfoData = lfoPhaseTable[this.op[0].synthVariant][this.op[0].lfoSensitivity & 7];
        const active = (this.op[0].isActive() | this.op[1].isActive() |
                     this.op[2].isActive() | this.op[3].isActive()) ? 1 : 0;
        const lfo = (this.op[0].lfoSensitivity &
            (this.op[0].ampModEnabled | this.op[1].ampModEnabled |
             this.op[2].ampModEnabled | this.op[3].ampModEnabled ? 0x37 : 7)) ? 2 : 0;
        return active | lfo;
    }

    // Compute one sample: no LFO
    compute() {
        let r;
        const op = this.op;
        const fb = this.fb;
        switch (this.algorithm) {
            case 0:
                op[2].generateSample(op[1].currentOutput());
                op[1].generateSample(op[0].currentOutput());
                r = op[3].generateSample(op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 1:
                op[2].generateSample(op[0].currentOutput() + op[1].currentOutput());
                op[1].generateSample(0);
                r = op[3].generateSample(op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 2:
                op[2].generateSample(op[1].currentOutput());
                op[1].generateSample(0);
                r = op[3].generateSample(op[0].currentOutput() + op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 3:
                op[2].generateSample(0);
                op[1].generateSample(op[0].currentOutput());
                r = op[3].generateSample(op[1].currentOutput() + op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 4:
                op[2].generateSample(0);
                r = op[1].generateSample(op[0].currentOutput());
                r += op[3].generateSample(op[2].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 5:
                r  = op[2].generateSample(op[0].currentOutput());
                r += op[1].generateSample(op[0].currentOutput());
                r += op[3].generateSample(op[0].currentOutput());
                op[0].generateFeedback(fb);
                break;
            case 6:
                r  = op[2].generateSample(0);
                r += op[1].generateSample(op[0].currentOutput());
                r += op[3].generateSample(0);
                op[0].generateFeedback(fb);
                break;
            case 7:
                r  = op[2].generateSample(0);
                r += op[1].generateSample(0);
                r += op[3].generateSample(0);
                r += op[0].generateFeedback(fb);
                break;
        }
        return r;
    }

    // Compute one sample: with LFO
    computeWithLFO() {
        this.chip.setPhaseModValue(this.phaseLfoData[this.chip.getPhaseModLevel()]);

        let r;
        const op = this.op;
        const fb = this.fb;
        switch (this.algorithm) {
            case 0:
                op[2].generateSampleLFO(op[1].currentOutput());
                op[1].generateSampleLFO(op[0].currentOutput());
                r = op[3].generateSampleLFO(op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 1:
                op[2].generateSampleLFO(op[0].currentOutput() + op[1].currentOutput());
                op[1].generateSampleLFO(0);
                r = op[3].generateSampleLFO(op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 2:
                op[2].generateSampleLFO(op[1].currentOutput());
                op[1].generateSampleLFO(0);
                r = op[3].generateSampleLFO(op[0].currentOutput() + op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 3:
                op[2].generateSampleLFO(0);
                op[1].generateSampleLFO(op[0].currentOutput());
                r = op[3].generateSampleLFO(op[1].currentOutput() + op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 4:
                op[2].generateSampleLFO(0);
                r = op[1].generateSampleLFO(op[0].currentOutput());
                r += op[3].generateSampleLFO(op[2].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 5:
                r  = op[2].generateSampleLFO(op[0].currentOutput());
                r += op[1].generateSampleLFO(op[0].currentOutput());
                r += op[3].generateSampleLFO(op[0].currentOutput());
                op[0].generateFeedbackLFO(fb);
                break;
            case 6:
                r  = op[2].generateSampleLFO(0);
                r += op[1].generateSampleLFO(op[0].currentOutput());
                r += op[3].generateSampleLFO(0);
                op[0].generateFeedbackLFO(fb);
                break;
            case 7:
                r  = op[2].generateSampleLFO(0);
                r += op[1].generateSampleLFO(0);
                r += op[3].generateSampleLFO(0);
                r += op[0].generateFeedbackLFO(fb);
                break;
        }
        return r;
    }
}

// ---------------------------------------------------------------------------
// Linear interpolation helper
// ---------------------------------------------------------------------------
function linearInterpolate(table, index) {
    const i = Math.floor(index);
    const frac = index - i;
    if (i >= table.length - 1) return table[table.length - 1];
    return table[i] + (table[i + 1] - table[i]) * frac;
}

// ---------------------------------------------------------------------------
// Clamp helper
// ---------------------------------------------------------------------------
function clampRange(v, hi, lo) {
    return v > hi ? hi : v < lo ? lo : v;
}

// =============================================================================
// OPN Class (YM2203)
// =============================================================================

// -----------------------------------------------------------------------------
// YM2203 timers (YM2203 data sheet, registers $24-$27)
// -----------------------------------------------------------------------------

/** Master clocks per timer A count for prescaler setting 0-2 ($2D / $2E / $2F). */
const TIMER_A_UNIT = [72, 36, 24];

/** One timer: counts (range - value) units of `scale` timer A counts, then overflows. */
class OpnTimer {
    constructor(range, scale) {
        this.range = range;    // 1024 for timer A, 256 for timer B
        this.scale = scale;    // 1 for timer A, 16 for timer B
        this.reset();
    }

    reset() {
        this.value = 0;        // NA / NB
        this.load = false;     // $27 LOAD: counting
        this.flagEnable = false; // $27 ENABLE: an overflow sets the flag
        this.elapsed = 0;      // master clocks counted in this period
        this.length = 0;       // master clocks of this period
    }

    /** Period in master clocks with `unit` clocks per timer A count. */
    periodFor(unit) {
        return unit * this.scale * (this.range - this.value);
    }

    /** $27 LOAD written: 0 -> 1 starts from the set value; 0 stops. */
    setLoad(on, unit) {
        if (on && !this.load) {
            this.length = this.periodFor(unit);
            this.elapsed = 0;
        }
        this.load = on;
    }

    /** Count `clocks`; returns the overflows. Each one restarts from the value set now. */
    advance(clocks, unit) {
        if (!this.load || this.length <= 0) return 0;
        this.elapsed += clocks;
        let overflows = 0;
        while (this.elapsed >= this.length) {
            this.elapsed -= this.length;
            this.length = this.periodFor(unit);
            overflows++;
        }
        return overflows;
    }
}

// $27, timer control and channel 3 mode (YM2203 data sheet, register $27;
// FM77AV BIOS manual appendix 3 (2)). Each timer owns one bit of three
// pairs, timer B one place above timer A:
//   bits 1-0  LOAD    the timer counts while the bit is 1
//   bits 3-2  ENABLE  an overflow sets the timer's status flag
//   bits 5-4  RESET   1 clears the timer's status flag
// and bits 7-6 select the mode of channel 3.
const CTRL_LOAD_SHIFT = 0;
const CTRL_ENABLE_SHIFT = 2;
const CTRL_RESET_SHIFT = 4;
const CTRL_CH3_MODE_SHIFT = 6;

// Channel 3 modes. Any mode but the normal one gives the operators of
// channel 3 their own F-numbers ($A8-$AE); the CSM mode also keys the
// channel on at each timer A overflow (YM2203 data sheet, register $27).
const CH3_MODE_NORMAL = 0;
const CH3_MODE_CSM = 2;

// Timer counts (YM2203 data sheet, registers $24-$26): NA has 10 bits,
// the upper 8 in $24 and the lower 2 in $25; NB is the 8 bits of $26.
// register -> [timer (0 = A, 1 = B), lowest count bit it sets, bit width]
const TIMER_COUNT_FIELDS = new Map([
    [0x24, [0, 2, 8]],
    [0x25, [0, 0, 2]],
    [0x26, [1, 0, 8]],
]);

// Operator parameters $30-$9E by the upper hex digit of the register
// (YM2203 data sheet, register map). Each takes the operator, the value
// written and whether the operator belongs to the channel keyed by CSM.
const OPERATOR_WRITERS = [];
OPERATOR_WRITERS[0x3] = (op, v) => {                 // DT, MULTI
    op.writeDT((v >> 4) & 7);
    op.writeMUL(v & 0x0F);
};
OPERATOR_WRITERS[0x4] = (op, v, csmKeyed) => op.writeTL(v & 0x7F, csmKeyed); // TL
OPERATOR_WRITERS[0x5] = (op, v) => {                 // KS, AR
    op.writeKS(v >> 6);
    op.writeAR((v & 0x1F) * 2);
};
OPERATOR_WRITERS[0x6] = (op, v) => {                 // DR
    op.writeDR((v & 0x1F) * 2);
    op.writeAMON(false);    // the YM2203 has no amplitude modulation
};
OPERATOR_WRITERS[0x7] = (op, v) => op.writeSR((v & 0x1F) * 2); // SR
OPERATOR_WRITERS[0x8] = (op, v) => {                 // SL, RR
    op.writeSL(SUSTAIN_LEVEL_TABLE[v >> 4]);
    op.writeRR((v & 0x0F) * 4 + 2);
};
OPERATOR_WRITERS[0x9] = (op, v) => op.writeSSGEG(v & 0x0F); // SSG-EG

// Register writes by the upper hex digit of the register (YM2203 data
// sheet, register map): $0x the SSG, $2x mode and timers, $3x-$9x
// operator parameters, $Ax F-numbers, $Bx feedback and algorithm. The
// other digits hold no register on the YM2203; writing them does nothing.
const REGISTER_GROUPS = new Array(16).fill(null);
REGISTER_GROUPS[0x0] = (opn, reg, v) => opn._ssg._writeReg(reg, v);
REGISTER_GROUPS[0x2] = (opn, reg, v) => opn._writeModeRegister(reg, v);
for (let digit = 0x3; digit <= 0x9; digit++) {
    REGISTER_GROUPS[digit] = (opn, reg, v) => opn._writeOperatorRegister(reg, v);
}
REGISTER_GROUPS[0xA] = (opn, reg, v) => opn._writeFrequencyRegister(reg, v);
REGISTER_GROUPS[0xB] = (opn, reg, v) => opn._writeVoiceRegister(reg, v);

export class OPN {
    constructor() {
        this._chip = new SynthChip();

        // FM channels
        this._ch = [new OpnVoice(), new OpnVoice(), new OpnVoice()];
        for (let i = 0; i < 3; i++) {
            this._ch[i].assignChip(this._chip);
        }
        this._csmch = this._ch[2];

        // Embedded SSG section. Receives YM2203 register writes 0x00-0x0F via
        // _storeRegister() and contributes one mixed sample per OPN sample
        // tick in _renderSamples().
        this._ssg = new PSGCore();

        // Gain for mixing the SSG output with the FM output.
        this._ssgMixGain = 16384;

        // F-number registers
        this._fnum = [0, 0, 0];
        this._fnumHighLatch = new Uint8Array(6); // [0..2] = $A4-$A6, [3..5] = $AC-$AE
        this._fnum3 = [0, 0, 0];

        // State
        this._ch3Mode = CH3_MODE_NORMAL;   // $27 bits 7-6
        this._prescale = 0;     // Current prescaler index

        // Clock/rate
        this._clock = MASTER_CLOCK;
        this._rate = 0;
        this._psgrate = SAMPLE_RATE;

        // FM volume
        this._fmvolume = 0;

        // Interpolation
        this._interpolation = false;
        this._mpratio = 0;
        this._mixdelta = 0;
        this._mb = [0, 0, 0, 0];

        // Timers
        this._timerUnit = TIMER_A_UNIT[0];
        this._timerA = new OpnTimer(1024, 1);
        this._timerB = new OpnTimer(256, 16);
        this._timers = [this._timerA, this._timerB];   // in the order of the $27 bits
        this._timerFlags = 0;         // bit 0: timer A overflow, bit 1: timer B overflow

        // Timer clock ratio: OPN_TIMER_CLOCK_AV / tick rate (FM77AV mode).
        // Recomputed in _recomputeTimerRatio() when the tick rate or AV mode changes.
        this._isAV = false;
        this._tickHz = 0;
        this._timerClockRatio = 1.0;

        // Audio output
        this._audioCtx = null;
        this._workletNode = null;
        this._gainNode = null;
        this._volume = 0.5;
        // Sample staging buffer (see psg.js for the same pattern)
        this._sampleBuf = new Float32Array(2048);
        this._sampleLen = 0;

        // Tick accumulator for sample timing. step() receives ticks at the
        // rate given to setTickRate(); one output sample is produced every
        // _cyclesPerSample ticks.
        this._cyclesPerSample = 0;   // ticks per output sample, set by setTickRate()
        this._fmAccum = 0;
        // Samples step() has counted but not made yet. They are made in one
        // call by renderPendingSamples(), before anything that changes the
        // sound (register writes, the CSM key-on, the tick rate) and before
        // the buffer is read, so each one still comes out of the state it
        // had at its own time.
        this._pendingSamples = 0;
        this._renderTmp = new Float64Array(1024);

        // Register file for readback
        this._regs = new Uint8Array(256);

        // Init
        this._initialize(MASTER_CLOCK, SAMPLE_RATE);
    }

    // =========================================================================
    // Initialization
    // =========================================================================

    _initialize(c, r) {
        this._clock = c;
        this._psgrate = r;
        this._configureRate(c, r, false);
        this.reset();
        this._setFMVolume(0);
    }

    /**
     * Set FM77AV mode. The timer count is scaled by the ratio of the OPN
     * timer clock to the tick rate (the master clock).
     */
    setAVMode(isAV) {
        this._isAV = isAV;
        this._recomputeTimerRatio();
    }

    /** Rate of the time units passed to step() (master clock periods). */
    setTickRate(hz) {
        this.renderPendingSamples();
        this._tickHz = hz;
        this._cyclesPerSample = hz / SAMPLE_RATE;
        this._ssg.setTickRate(hz);
        this._recomputeTimerRatio();
    }

    _recomputeTimerRatio() {
        // In FM77AV mode the timers are fed master clock periods (ticks),
        // scaled to the OPN timer clock by this ratio; otherwise they are
        // fed CPU cycles as they are.
        if (this._isAV && this._tickHz > 0) {
            this._timerClockRatio = OPN_TIMER_CLOCK_AV / this._tickHz;
        } else {
            this._timerClockRatio = 1.0;
        }
    }

    _configureRate(c, r, ip) {
        this._interpolation = ip;
        this._clock = c;
        this._psgrate = r;
        this._recalcFrequencies();
        this._mb[0] = this._mb[1] = this._mb[2] = this._mb[3] = 0;
        this._mixdelta = 0;
    }

    _recalcFrequencies() {
        const p = this._prescale;
        this._prescale = -1;
        this._configurePrescaler(p);
    }

    _configurePrescaler(p) {
        const dividers = [[6, 4], [3, 2], [2, 1]];
        const lfoRateDivisors = [109, 78, 72, 68, 63, 45, 9, 6];

        if (this._prescale !== p) {
            this._prescale = p;
            const fmclock = Math.floor(this._clock / dividers[p][0] / 12);

            if (this._interpolation) {
                this._rate = fmclock * 2;
                do {
                    this._rate >>= 1;
                    this._mpratio = Math.floor(this._rate * OUTPUT_SCALE / this._psgrate);
                } while (this._mpratio >= OUTPUT_SCALE * 2);
            } else {
                this._rate = this._psgrate;
            }

            // Ratio of FM clock to output rate
            const ratio = Math.floor(((fmclock << CLOCK_RATIO_BITS) + this._rate / 2) / this._rate);
            this._chip.updateRatio(ratio);

            // LFO rate table
            for (let i = 0; i < 8; i++) {
                lfoRateTable[i] = Math.floor((ratio << (1 + 14 - CLOCK_RATIO_BITS)) / lfoRateDivisors[i]);
            }
        }
    }

    _setFMVolume(db) {
        db = _clampLow(db, 20);
        if (db > -192)
            this._fmvolume = Math.floor(16384.0 * Math.pow(10.0, db / 40.0));
        else
            this._fmvolume = 0;
    }

    // =========================================================================
    // Reset
    // =========================================================================

    reset() {
        this._regs.fill(0);
        this._ch3Mode = CH3_MODE_NORMAL;

        this._timerA.reset();
        this._timerB.reset();
        this._timerFlags = 0;
        this._timerUnit = TIMER_A_UNIT[0];

        // BUSY countdown in the units _advanceTimers() receives (ticks in
        // FM77AV mode, CPU cycles otherwise). Set in writeReg().
        this._busyCycles = 0;

        this._fnum = [0, 0, 0];
        this._fnumHighLatch.fill(0);
        this._fnum3 = [0, 0, 0];

        this._mixdelta = 0;
        this._mb = [0, 0, 0, 0];
        this._fmAccum = 0;
        // Counted samples are dropped with the buffer below.
        this._pendingSamples = 0;

        // Reset registers
        this._configurePrescaler(0);
        // Every voice register $30-$BF to 0. The timers and the channel 3
        // mode ($24-$27) were cleared above.
        for (let reg = 0x30; reg < 0xC0; reg++) this._storeRegister(reg, 0);
        this._ch[0].reset();
        this._ch[1].reset();
        this._ch[2].reset();

        this._sampleLen = 0;

        this._ssg.reset();
    }

    // =========================================================================
    // Register interface (public API)
    // =========================================================================

    /**
     * Register address select. Selecting $2D, $2E or $2F picks the
     * prescaler by itself (YM2203 data sheet, prescaler registers); the
     * other addresses only wait for the data write.
     */
    selectAddress(addr) {
        addr &= 0xFF;
        if (addr >= 0x2D && addr <= 0x2F) {
            this.renderPendingSamples();
            this._selectPrescaler(addr - 0x2D);
        }
    }

    writeReg(reg, value) {
        this.renderPendingSamples();
        reg &= 0xFF;
        value &= 0xFF;
        this._regs[reg] = value;

        // BUSY is held for a short period after a register write.
        this._busyCycles = Math.round(83 / this._timerClockRatio);

        this._storeRegister(reg, value);
    }

    /** A register value takes effect (REGISTER_GROUPS). */
    _storeRegister(reg, v) {
        const write = REGISTER_GROUPS[reg >> 4];
        if (write !== null) write(this, reg, v);
    }

    /**
     * $20-$2F (YM2203 data sheet, register map): $24-$27 the timers,
     * $28 key on / off, $2D-$2F the prescaler. The rest do nothing.
     */
    _writeModeRegister(reg, v) {
        if (reg >= 0x2D) {
            this._selectPrescaler(reg - 0x2D);
        } else if (reg === 0x28) {
            // Bits 1-0 pick the channel (3 is none), bits 7-4 the
            // operators keyed on.
            const voice = this._ch[v & 3];
            if (voice !== undefined) voice.setKeyOnSlots(v >> 4);
        } else if (reg >= 0x24 && reg <= 0x27) {
            this._writeTimerRegister(reg, v);
        }
    }

    /** Prescaler $2D / $2E / $2F (index 0-2): the FM clock and the timer unit. */
    _selectPrescaler(index) {
        this._configurePrescaler(index);
        this._setTimerUnit(TIMER_A_UNIT[index]);
    }

    /**
     * $30-$9E: bits 1-0 of the register pick the channel (3 is none),
     * bits 3-2 the operator slot through REG_TO_OP_MAP (YM2203 data
     * sheet, register map).
     */
    _writeOperatorRegister(reg, v) {
        const channel = reg & 3;
        if (channel === 3) return;
        const voice = this._ch[channel];
        const op = voice.op[REG_TO_OP_MAP[(reg >> 2) & 3]];
        OPERATOR_WRITERS[reg >> 4](op, v, voice === this._csmch && this._isCSMMode());
    }

    /**
     * $A0-$AE (YM2203 data sheet, F-number registers): bit 2 of the
     * register selects the high byte (block and F-number bits 10-8), which
     * is held until the low byte is written; bit 3 selects the per-operator
     * F-numbers of channel 3 ($A8-$AE) instead of the channel F-numbers.
     */
    _writeFrequencyRegister(reg, v) {
        const channel = reg & 3;
        if (channel === 3) return;
        const perOperator = (reg & 0x08) !== 0;
        const latch = perOperator ? channel + 3 : channel;
        if (reg & 0x04) {
            this._fnumHighLatch[latch] = v;
        } else {
            (perOperator ? this._fnum3 : this._fnum)[channel] = this._fnumHighLatch[latch] * 0x100 + v;
        }
    }

    /** $B0-$B2: feedback (bits 5-3) and algorithm (bits 2-0) (YM2203 data sheet). */
    _writeVoiceRegister(reg, v) {
        if (reg > 0xB2) return;
        const voice = this._ch[reg & 3];
        voice.writeFeedback((v >> 3) & 7);
        voice.configureAlgorithm(v & 7);
    }

    _isCSMMode() {
        return this._ch3Mode === CH3_MODE_CSM;
    }

    readStatus() {
        const busy = this._busyCycles > 0 ? 0x80 : 0;
        return this._timerFlags | busy;
    }

    get timerAFlag() { return (this._timerFlags & 0x01) !== 0; }
    get timerBFlag() { return (this._timerFlags & 0x02) !== 0; }

    /** A timer flag is set and its ENABLE bit is on (the OPN's IRQ request). */
    get irqAsserted() {
        return (this.timerAFlag && this._timerA.flagEnable) ||
               (this.timerBFlag && this._timerB.flagEnable);
    }

    // =========================================================================
    // Read-only inspection (for a debug view). The level getters first make
    // the samples step() has already counted, then read the state; they do
    // not change the sound or the timing.
    // =========================================================================

    /** Embedded SSG section (a PSGCore). Read-only use. */
    get ssg() { return this._ssg; }

    /**
     * Register file $00-$FF as last written through writeReg(). The live array
     * is returned for cheap polling; callers must treat it as read-only.
     */
    getRegisters() {
        return this._regs;
    }

    /** Per-channel SSG level for A/B/C as 0-15 (see PSGCore.getChannelLevels). */
    getSSGChannelLevels(out) {
        this.renderPendingSamples();
        return this._ssg.getChannelLevels(out);
    }

    /**
     * FM channel output level for channels 1-3, as 0.0-1.0.
     * A muted channel reports 0; operators whose envelope is OFF are not counted.
     * @param {number[]} [out] optional 3-element array to fill (avoids garbage)
     */
    getFMChannelLevels(out = [0, 0, 0]) {
        this.renderPendingSamples();
        for (let i = 0; i < 3; i++) {
            const ch = this._ch[i];
            let level = 0;
            if (!ch.channelMuted) {
                const mask = FM_CARRIER_MASK[ch.algorithm & 7];
                for (let o = 0; o < 4; o++) {
                    if (!(mask & (1 << o))) continue;
                    const op = ch.op[o];
                    if (op.egStage === ENV_PHASE_OFF) continue;
                    const att = op.envOutput >> 3;
                    if (att >= 1023) continue;
                    level += Math.pow(2, -att / 64);
                }
            }
            out[i] = level > 1 ? 1 : level;
        }
        return out;
    }

    // =========================================================================
    // Status flag management
    // =========================================================================

    _setStatus(bits) {
        this._timerFlags |= bits;
    }

    _clearStatusBit(bit) {
        this._timerFlags &= ~bit;
    }

    // =========================================================================
    // FM sample rendering
    // =========================================================================

    _scaleSample(s) {
        return (clampRange(s, 0x7fff, -0x8000) * this._fmvolume) >> 14;
    }

    _renderSamples(buffer, nsamples) {
        const ch = this._ch;

        // Set F-Numbers
        ch[0].setFrequency(this._fnum[0]);
        ch[1].setFrequency(this._fnum[1]);
        if (this._ch3Mode === CH3_MODE_NORMAL) {
            ch[2].setFrequency(this._fnum[2]);
        } else {
            ch[2].op[0].setFrequency(this._fnum3[1]);
            ch[2].op[1].setFrequency(this._fnum3[2]);
            ch[2].op[2].setFrequency(this._fnum3[0]);
            ch[2].op[3].setFrequency(this._fnum[2]);
        }

        const actch = (((ch[2].prepareForRender() << 2) | ch[1].prepareForRender()) << 2) | ch[0].prepareForRender();
        const fmActive = !!(actch & 0x15);
        const ssg = this._ssg;
        const ssgGain = this._ssgMixGain;

        let act = actch;
        for (let n = 0; n < nsamples; n++) {
            let fmSample = 0;
            if (fmActive) {
                let x = 0, y = 0, z = 0;
                if (act & 0x01) x = ch[0].compute();
                if (act & 0x04) y = ch[1].compute();
                if (act & 0x10) z = ch[2].compute();
                fmSample = x + y + z;
                // A channel whose operators have all ended is skipped
                // from the next sample on.
                if ((act & 0x01) && !ch[0].isActive()) act &= ~0x01;
                if ((act & 0x04) && !ch[1].isActive()) act &= ~0x04;
                if ((act & 0x10) && !ch[2].isActive()) act &= ~0x10;
            }

            // SSG always renders; generateSample() returns one output sample.
            const ssgSample = (ssg.generateSample() * ssgGain) | 0;

            buffer[n] += this._scaleSample(fmSample + ssgSample);
        }
    }

    // =========================================================================
    // Timers
    // =========================================================================

    _advanceTimers(cpuCycles) {
        if (this._busyCycles > 0) {
            this._busyCycles -= cpuCycles;
            if (this._busyCycles < 0) this._busyCycles = 0;
        }

        const clocks = cpuCycles * this._timerClockRatio;
        const unit = this._timerUnit;
        for (let n = this._timerA.advance(clocks, unit); n > 0; n--) this._timerAOverflow();
        if (this._timerB.advance(clocks, unit) > 0 && this._timerB.flagEnable) this._timerFlags |= 0x02;
    }

    /** Timer A overflow: the flag (when enabled), and CSM key-on of channel 3. */
    _timerAOverflow() {
        if (this._timerA.flagEnable) this._timerFlags |= 0x01;
        if (this._isCSMMode()) {
            this.renderPendingSamples();
            const ch3 = this._ch[2];
            ch3.setKeyOnSlots(0x00);
            ch3.setKeyOnSlots(0x0F);
        }
    }

    /** $24-$26 set a timer count (TIMER_COUNT_FIELDS); $27 is _writeTimerControl. */
    _writeTimerRegister(reg, v) {
        if (reg === 0x27) {
            this._writeTimerControl(v);
            return;
        }
        const [index, low, width] = TIMER_COUNT_FIELDS.get(reg);
        const timer = this._timers[index];
        const field = ((1 << width) - 1) << low;
        timer.value = (timer.value & ~field) | ((v << low) & field);
    }

    /**
     * $27 (see CTRL_LOAD_SHIFT): for each timer its ENABLE, RESET and LOAD
     * bits, then the channel 3 mode. A new set count is used when LOAD
     * goes from 0 to 1 (OpnTimer.setLoad).
     */
    _writeTimerControl(v) {
        for (let i = 0; i < 2; i++) {
            const timer = this._timers[i];
            timer.flagEnable = ((v >> (CTRL_ENABLE_SHIFT + i)) & 1) === 1;
            if ((v >> (CTRL_RESET_SHIFT + i)) & 1) this._timerFlags &= ~(1 << i);
            timer.setLoad(((v >> (CTRL_LOAD_SHIFT + i)) & 1) === 1, this._timerUnit);
        }
        this._ch3Mode = v >> CTRL_CH3_MODE_SHIFT;
    }

    /** Prescaler changed: running timers take the new period now. */
    _setTimerUnit(unit) {
        if (unit === this._timerUnit) return;
        this._timerUnit = unit;
        for (const t of [this._timerA, this._timerB]) {
            if (t.load) t.length = t.periodFor(unit);
        }
    }

    // =========================================================================
    // Step -- called from emulation loop
    // =========================================================================

    /**
     * @param {number} ticks     - master clock periods elapsed
     * @param {number} cpuCycles - main CPU cycles in the same span; the timers
     *                             count these outside FM77AV mode
     */
    step(ticks, cpuCycles = ticks) {
        this._advanceTimers(this._isAV ? ticks : cpuCycles);

        if (!this._audioCtx) return;

        // Count the samples due; they are made later in one call.
        this._fmAccum += ticks;
        const cps = this._cyclesPerSample;
        while (this._fmAccum >= cps) {
            this._fmAccum -= cps;
            this._pendingSamples++;
        }

        // Batch flush — see psg.js for the same pattern.
        if (this._workletNode) {
            const FLUSH_SIZE = 1024;
            if (this._sampleLen + this._pendingSamples < FLUSH_SIZE) return;
            this.renderPendingSamples();
            while (this._sampleLen >= FLUSH_SIZE) {
                const chunk = this._sampleBuf.slice(0, FLUSH_SIZE);
                this._workletNode.port.postMessage(
                    { type: 'samples', data: chunk },
                    [chunk.buffer],
                );
                this._sampleBuf.copyWithin(0, FLUSH_SIZE, this._sampleLen);
                this._sampleLen -= FLUSH_SIZE;
            }
        }
    }

    /**
     * Make the samples step() has counted, in order, and add them to the
     * sample buffer. The machine calls this at the end of each run; callers
     * that read the buffer directly call it first.
     */
    renderPendingSamples() {
        let left = this._pendingSamples;
        if (left === 0) return;
        this._pendingSamples = 0;
        let len = this._sampleLen;
        let buf = this._sampleBuf;
        if (len + left > buf.length) {
            let size = buf.length * 2;
            while (len + left > size) size *= 2;
            const grown = new Float32Array(size);
            grown.set(buf);
            this._sampleBuf = buf = grown;
        }
        const tmp = this._renderTmp;
        while (left > 0) {
            const n = left < tmp.length ? left : tmp.length;
            tmp.fill(0, 0, n);
            this._renderSamples(tmp, n);
            for (let i = 0; i < n; i++) buf[len++] = tmp[i] / 32768.0;
            left -= n;
        }
        this._sampleLen = len;
    }

    // =========================================================================
    // Output volume (audio output is attached by the host, see psg.js)
    // =========================================================================

    setGain(v) {
        this._volume = Math.max(0, Math.min(1, v));
        if (this._gainNode) {
            this._gainNode.gain.value = this._volume;
        }
    }
}
