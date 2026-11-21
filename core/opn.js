// SPDX-License-Identifier: LicenseRef-fmgen
// Port of "FM Sound Generator" (fmgen) 008, Copyright (C) by cisc 1998, 2003.
// Modifications by 7032 / Naomitsu Tsugiiwa, under the fmgen terms.
// =============================================================================
// YM2203 (OPN) FM + SSG Sound Synthesizer
//
// This file is a JavaScript port of "FM Sound Generator" (fmgen) 008,
// Copyright (C) by cisc 1998, 2003. It is NOT covered by the project's
// MIT License; the whole file is provided under the original fmgen terms
// only (see LICENSE-fmgen.md and core/fmgen_readme.txt, the original readme
// included unmodified).
// Modifications from the original: C++ to JavaScript translation; reduction
// to what the YM2203 uses (no LFO, no noise, no OPM or OPNA/B parts);
// integration with this simulator's sample output stage, timers and SSG.
// LICENSE-fmgen.md has the list.
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
// Envelope phases, numbered so that phase + 1 is the one that follows
// ---------------------------------------------------------------------------
const ENV_PHASE_ATTACK  = 1;
const ENV_PHASE_DECAY   = 2;
const ENV_PHASE_SUSTAIN = 3;
const ENV_PHASE_RELEASE = 4;
const ENV_PHASE_OFF     = 5;

// ---------------------------------------------------------------------------
// Synthesis dimensions
// ---------------------------------------------------------------------------
const SINE_INDEX_BITS  = 10;
const SINE_TABLE_SIZE  = 1 << SINE_INDEX_BITS;
const PHASE_EXTRA_BITS = 9;
const CLOCK_RATIO_BITS = 7;
const LOG_TO_LIN_SIZE  = 0x1000 * 2;

// One full turn of the phase is 2^(20 + PHASE_EXTRA_BITS).
const PHASE_TO_SINE_SHIFT = 20 + PHASE_EXTRA_BITS - SINE_INDEX_BITS;
// Shift from an operator output to the envelope count of one turn.
const OUTPUT_TO_ENV_SHIFT = (20 + PHASE_EXTRA_BITS) - 13;
const INPUT_TO_SINE_SHIFT = PHASE_TO_SINE_SHIFT - (2 + OUTPUT_TO_ENV_SHIFT);

// Envelope level treated as silence.
const ENV_QUIET_LEVEL = 955;
// Counter value of one envelope step; the rate takes from it every sample.
const ENV_STEP_SPAN = (2047 * 3) << CLOCK_RATIO_BITS;

// ---------------------------------------------------------------------------
// Tables
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
      0,   0,   0,   0,   0,   0,   0,   1,   2,   3,   3,   3,   3,   3,   3,   3,
      4,   4,   4,   4,   4,   4,   4,   5,   6,   7,   7,   7,   7,   7,   7,   7,
      8,   8,   8,   8,   8,   8,   8,   9,  10,  11,  11,  11,  11,  11,  11,  11,
     12,  12,  12,  12,  12,  12,  12,  13,  14,  15,  15,  15,  15,  15,  15,  15,
     16,  16,  16,  16,  16,  16,  16,  17,  18,  19,  19,  19,  19,  19,  19,  19,
     20,  20,  20,  20,  20,  20,  20,  21,  22,  23,  23,  23,  23,  23,  23,  23,
     24,  24,  24,  24,  24,  24,  24,  25,  26,  27,  27,  27,  27,  27,  27,  27,
     28,  28,  28,  28,  28,  28,  28,  29,  30,  31,  31,  31,  31,  31,  31,  31,
]);

// Detune: (dt * 32 + key code) -> phase offset
const DETUNE_TABLE = new Int8Array([
      0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   2,   2,   2,   2,   2,   2,   2,   2,   4,   4,   4,   4,
      4,   6,   6,   6,   8,   8,   8,  10,  10,  12,  12,  14,  16,  16,  16,  16,
      2,   2,   2,   2,   4,   4,   4,   4,   4,   6,   6,   6,   8,   8,   8,  10,
     10,  12,  12,  14,  16,  16,  18,  20,  22,  24,  26,  28,  32,  32,  32,  32,
      4,   4,   4,   4,   4,   6,   6,   6,   8,   8,   8,  10,  10,  12,  12,  14,
     16,  16,  18,  20,  22,  24,  26,  28,  32,  34,  38,  40,  44,  44,  44,  44,
      0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,  -2,  -2,  -2,  -2,  -2,  -2,  -2,  -2,  -4,  -4,  -4,  -4,
     -4,  -6,  -6,  -6,  -8,  -8,  -8, -10, -10, -12, -12, -14, -16, -16, -16, -16,
     -2,  -2,  -2,  -2,  -4,  -4,  -4,  -4,  -4,  -6,  -6,  -6,  -8,  -8,  -8, -10,
    -10, -12, -12, -14, -16, -16, -18, -20, -22, -24, -26, -28, -32, -32, -32, -32,
     -4,  -4,  -4,  -4,  -4,  -6,  -6,  -6,  -8,  -8,  -8, -10, -10, -12, -12, -14,
    -16, -16, -18, -20, -22, -24, -26, -28, -32, -34, -38, -40, -44, -44, -44, -44,
]);

// Decay: [rate * 8 + step of the pattern] -> level added
const ENV_DECAY_STEPS = new Int8Array([
     0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,
     1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  0,  1,  0,  1,  0,  1,  0,  1,  1,  1,  0,  1,  0,  1,  0,
     1,  1,  1,  0,  1,  1,  1,  0,  1,  1,  1,  1,  1,  1,  1,  0,
     1,  1,  1,  1,  1,  1,  1,  1,  2,  1,  1,  1,  2,  1,  1,  1,
     2,  1,  2,  1,  2,  1,  2,  1,  2,  2,  2,  1,  2,  2,  2,  1,
     2,  2,  2,  2,  2,  2,  2,  2,  4,  2,  2,  2,  4,  2,  2,  2,
     4,  2,  4,  2,  4,  2,  4,  2,  4,  4,  4,  2,  4,  4,  4,  2,
     4,  4,  4,  4,  4,  4,  4,  4,  8,  4,  4,  4,  8,  4,  4,  4,
     8,  4,  8,  4,  8,  4,  8,  4,  8,  8,  8,  4,  8,  8,  8,  4,
    16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
    16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
]);

// Rate / 4 -> how fast the step counter runs
const ENV_RATE_DIVIDER = [
       1,    2,    4,    8,   16,   32,   64,  128,
     256,  512, 1024, 2047, 2047, 2047, 2047, 2047,
];

// Attack: [rate * 8 + step of the pattern] -> shift of the level (-1: no step)
const ATTACK_CURVE_TABLE = new Int8Array([
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
     4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
     4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,  4,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4, -1,  4, -1,  4, -1,  4, -1,  4,  4,  4, -1,  4, -1,  4, -1,
     4,  4,  4, -1,  4,  4,  4, -1,  4,  4,  4,  4,  4,  4,  4, -1,
     4,  4,  4,  4,  4,  4,  4,  4,  3,  4,  4,  4,  3,  4,  4,  4,
     3,  4,  3,  4,  3,  4,  3,  4,  3,  3,  3,  4,  3,  3,  3,  4,
     3,  3,  3,  3,  3,  3,  3,  3,  2,  3,  3,  3,  2,  3,  3,  3,
     2,  3,  2,  3,  2,  3,  2,  3,  2,  2,  2,  3,  2,  2,  2,  3,
     2,  2,  2,  2,  2,  2,  2,  2,  1,  2,  2,  2,  1,  2,  2,  2,
     1,  2,  1,  2,  1,  2,  1,  2,  1,  1,  1,  2,  1,  1,  1,  2,
     0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
     0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
]);

// SSG-EG: [((shape * 2 + fast attack) * 3 + part) * 2] -> offset in $200
// steps, then direction. Shape is the register value & 7.
const SSG_ENV_TABLE = new Int8Array([
     1,  1,  1,  1,  1,  1,
     0,  1,  1,  1,  1,  1,
     0,  1,  2,  0,  2,  0,
     0,  1,  2,  0,  2,  0,
     1, -1,  0,  1,  1, -1,
     0,  1,  1, -1,  0,  1,
     1, -1,  0,  0,  0,  0,
     0,  1,  0,  0,  0,  0,
     2, -1,  2, -1,  2, -1,
     1, -1,  2, -1,  2, -1,
     1, -1,  0,  0,  0,  0,
     1, -1,  0,  0,  0,  0,
     0,  1,  1, -1,  0,  1,
     1, -1,  0,  1,  1, -1,
     0,  1,  2,  0,  2,  0,
     1, -1,  2,  0,  2,  0,
]);

// Log sine: phase -> index into expTable (pairs of positive and negative)
const logSinTable = new Uint32Array(SINE_TABLE_SIZE);

// Log level -> linear value, as positive and negative pairs
const expTable = new Int32Array(LOG_TO_LIN_SIZE);

(function buildLogTables() {
    for (let i = 0; i < 256; i++) {
        const v = (Math.floor(Math.pow(2, 13 - i / 256)) + 2) & ~3;
        expTable[i * 2] = v;
        expTable[i * 2 + 1] = -v;
    }
    // Each further 512 entries are the 512 before them, halved.
    for (let i = 512; i < LOG_TO_LIN_SIZE; i++) {
        expTable[i] = Math.trunc(expTable[i - 512] / 2);
    }

    const ln2 = Math.log(2);
    for (let i = 0; i < SINE_TABLE_SIZE / 2; i++) {
        const angle = (i * 2 + 1) * Math.PI / SINE_TABLE_SIZE;
        const level = Math.floor(-256 * Math.log(Math.sin(angle)) / ln2 + 0.5) + 1;
        logSinTable[i] = level * 2;
        logSinTable[SINE_TABLE_SIZE / 2 + i] = level * 2 + 1;
    }
})();

function _clampLow(a, b) { return a < b ? a : b; }

// ---------------------------------------------------------------------------
// SynthChip: what the operators share, set by the clock to output rate ratio
// ---------------------------------------------------------------------------
class SynthChip {
    constructor() {
        this.clockRatio = 0;
        this.phaseFactors = new Uint32Array(16);    // by MUL
    }

    updateRatio(ratio) {
        if (this.clockRatio === ratio) return;
        this.clockRatio = ratio;
        const unit = ratio / (1 << (2 + CLOCK_RATIO_BITS - PHASE_EXTRA_BITS));
        for (let mul = 0; mul < 16; mul++) {
            this.phaseFactors[mul] = (mul ? mul * 2 : 1) * unit;
        }
    }
}

// ---------------------------------------------------------------------------
// FMOperator: one operator, with its phase and envelope generators
// ---------------------------------------------------------------------------
class FMOperator {
    constructor() {
        this.chip = null;

        // Output
        this.outputVal = 0;
        this.prevSample = 0;

        // Phase generator
        this.phaseStep = 0;
        this.detuneOffset = 0;
        this.freqMultiple = 0;
        this.phaseAccum = 0;        // int32 holding the 32-bit counter
        this.phaseDelta = 0;

        // Envelope generator
        this.keyNote = 0;
        this.envLevel = 0;
        this.envLevelNextThreshold = 0;
        this.envCounter = 0;
        this.envCounterStep = 0;
        this.envOutput = 0;
        this.totalLevelScaled = 0;
        this.envRate = 0;
        this.envPatternIdx = 0;
        this.ssgEnvOffset = 0;
        this.ssgEnvVector = 0;
        this.ssgEnvState = 0;

        this.keyScaleAdjust = 0;
        this.egStage = ENV_PHASE_OFF;

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
        this.needsRecalc = true;
    }

    assignChip(chip) { this.chip = chip; }

    reset() {
        this.totalLevel = this.totalLevelLatched = 127;
        this._enterPhase(ENV_PHASE_OFF);
        this.envCounter = 0;
        this.envPatternIdx = 0;
        this.ssgEnvState = 0;
        this.phaseAccum = 0;
        this.outputVal = this.prevSample = 0;
        this.needsRecalc = true;
    }

    clearFeedback() {
        this.outputVal = this.prevSample = 0;
    }

    /** Non-zero while the envelope is not OFF. */
    isActive() {
        return this.egStage - ENV_PHASE_OFF;
    }

    // --- Parameters ---
    writeDT(dt) { this.detuneOffset = dt * 0x20; this.needsRecalc = true; }
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

    writeSSGEG(value) {
        this.ssgMode = (value & 8) ? value : 0;
    }

    keyOn() {
        if (this.keyPressed) return;
        this.keyPressed = true;
        if (this.egStage === ENV_PHASE_OFF || this.egStage === ENV_PHASE_RELEASE) {
            this.ssgEnvState = -1;
            this._enterPhase(ENV_PHASE_ATTACK);
            this._refreshEnvOutput();
            this.outputVal = this.prevSample = 0;
            this.phaseAccum = 0;
        }
    }

    keyOff() {
        if (!this.keyPressed) return;
        this.keyPressed = false;
        this._enterPhase(ENV_PHASE_RELEASE);
    }

    /** Block and F-number, as the registers hold them together. */
    setFrequency(f) {
        this.phaseStep = (f & 2047) << ((f >> 11) & 7);
        this.keyNote = KEY_SCALE_TABLE[(f >> 7) & 127];
        this.needsRecalc = true;
    }

    /** Work out again what depends on the parameters, once they changed. */
    recalculate() {
        if (!this.needsRecalc) return;
        this.needsRecalc = false;

        // A 32-bit unsigned product: a negative sum wraps around.
        this.phaseDelta = Math.imul(
            this.phaseStep + DETUNE_TABLE[this.detuneOffset + this.keyNote],
            this.chip.phaseFactors[this.freqMultiple],
        );

        this.keyScaleAdjust = this.keyNote >> (3 - this.keyScale);
        this.totalLevelScaled = this.totalLevel * 8;

        switch (this.egStage) {
            case ENV_PHASE_ATTACK:
                this._configureEnvRate(this._scaledRate(this.attackRate));
                break;
            case ENV_PHASE_DECAY:
                this._configureEnvRate(this._scaledRate(this.decayRate));
                this.envLevelNextThreshold = this.sustainLevel * 8;
                break;
            case ENV_PHASE_SUSTAIN:
                this._configureEnvRate(this._scaledRate(this.sustainRate));
                break;
            case ENV_PHASE_RELEASE:
                this._configureEnvRate(_clampLow(63, this.releaseRate + this.keyScaleAdjust));
                break;
        }

        if (this.ssgMode && this.egStage !== ENV_PHASE_RELEASE) this._loadSsgPart();
        this._refreshEnvOutput();
    }

    // --- Envelope ---
    _scaledRate(rate) {
        return rate ? _clampLow(63, rate + this.keyScaleAdjust) : 0;
    }

    _configureEnvRate(rate) {
        this.envRate = rate;
        this.envCounterStep = ENV_RATE_DIVIDER[rate >> 2] * this.chip.clockRatio;
    }

    /**
     * The offset and direction of the current part of an SSG-EG shape. The
     * table is flat: a part of -1, left by a key-on without SSG-EG, reads the
     * entry before, and before the first entry there is only the first.
     */
    _loadSsgPart() {
        const fast = this.attackRate >= ((this.ssgMode === 8 || this.ssgMode === 12) ? 56 : 60) ? 1 : 0;
        const at = (((this.ssgMode & 7) * 2 + fast) * 3 + this.ssgEnvState) * 2;
        const entry = at < 0 ? 0 : at;
        this.ssgEnvOffset = SSG_ENV_TABLE[entry] * 0x200;
        this.ssgEnvVector = SSG_ENV_TABLE[entry + 1];
    }

    _refreshEnvOutput() {
        const level = this.ssgMode
            ? this.totalLevelScaled + this.envLevel * this.ssgEnvVector + this.ssgEnvOffset
            : this.totalLevelScaled + this.envLevel;
        this.envOutput = _clampLow(level, 0x3ff) << (1 + 2);
    }

    _enterPhase(phase) {
        switch (phase) {
            case ENV_PHASE_ATTACK:
                this.totalLevel = this.totalLevelLatched;
                if (this.ssgMode) {
                    this.ssgEnvState++;
                    if (this.ssgEnvState > 2) this.ssgEnvState = 1;
                    this._loadSsgPart();
                }
                if (this.attackRate + this.keyScaleAdjust < 62) {
                    this._configureEnvRate(this._scaledRate(this.attackRate));
                    this.egStage = ENV_PHASE_ATTACK;
                    break;
                }
                // falls through
            case ENV_PHASE_DECAY:
                if (this.sustainLevel) {
                    this.envLevel = 0;
                    this.envLevelNextThreshold = this.ssgMode
                        ? _clampLow(this.sustainLevel * 8, 0x200) : this.sustainLevel * 8;
                    this._configureEnvRate(this._scaledRate(this.decayRate));
                    this.egStage = ENV_PHASE_DECAY;
                    break;
                }
                // falls through
            case ENV_PHASE_SUSTAIN:
                this.envLevel = this.sustainLevel * 8;
                this.envLevelNextThreshold = this.ssgMode ? 0x200 : 0x400;
                this._configureEnvRate(this._scaledRate(this.sustainRate));
                this.egStage = ENV_PHASE_SUSTAIN;
                break;
            case ENV_PHASE_RELEASE:
                if (this.ssgMode) {
                    this.envLevel = this.envLevel * this.ssgEnvVector + this.ssgEnvOffset;
                    this.ssgEnvVector = 1;
                    this.ssgEnvOffset = 0;
                }
                if (this.egStage === ENV_PHASE_ATTACK || this.envLevel < ENV_QUIET_LEVEL) {
                    this.envLevelNextThreshold = 0x400;
                    this._configureEnvRate(_clampLow(63, this.releaseRate + this.keyScaleAdjust));
                    this.egStage = ENV_PHASE_RELEASE;
                    break;
                }
                // falls through
            default:
                this.envLevel = ENV_QUIET_LEVEL;
                this.envLevelNextThreshold = ENV_QUIET_LEVEL;
                this._refreshEnvOutput();
                this._configureEnvRate(0);
                this.egStage = ENV_PHASE_OFF;
                break;
        }
    }

    /** One step of the envelope, when the counter has run out. */
    _advanceEnvelope() {
        this.envCounter = ENV_STEP_SPAN;
        const step = this.envRate * 8 + (this.envPatternIdx & 7);

        if (this.egStage === ENV_PHASE_ATTACK) {
            const shift = ATTACK_CURVE_TABLE[step];
            if (shift >= 0) {
                this.envLevel -= 1 + (this.envLevel >> shift);
                if (this.envLevel <= 0) this._enterPhase(ENV_PHASE_DECAY);
            }
            this._refreshEnvOutput();
        } else if (!this.ssgMode) {
            this.envLevel += ENV_DECAY_STEPS[step];
            if (this.envLevel >= this.envLevelNextThreshold) this._enterPhase(this.egStage + 1);
            this._refreshEnvOutput();
        } else {
            this.envLevel += 4 * ENV_DECAY_STEPS[step];
            if (this.envLevel >= this.envLevelNextThreshold) {
                this._refreshEnvOutput();
                if (this.egStage === ENV_PHASE_DECAY) this._enterPhase(ENV_PHASE_SUSTAIN);
                else if (this.egStage === ENV_PHASE_SUSTAIN) this._enterPhase(ENV_PHASE_ATTACK);
                else if (this.egStage === ENV_PHASE_RELEASE) this._enterPhase(ENV_PHASE_OFF);
            }
        }
        this.envPatternIdx++;
    }

    _tickEnvelope() {
        this.envCounter -= this.envCounterStep;
        if (this.envCounter <= 0) this._advanceEnvelope();
    }

    /** The phase of this sample, in sine table steps; the counter moves on. */
    _stepPhase() {
        const phase = this.phaseAccum >>> PHASE_TO_SINE_SHIFT;
        this.phaseAccum = (this.phaseAccum + this.phaseDelta) | 0;
        return phase;
    }

    _levelToSample(sineIndex) {
        // Unsigned: an SSG-EG level below 0 is out of the table, so silent.
        const level = (this.envOutput + logSinTable[sineIndex & (SINE_TABLE_SIZE - 1)]) >>> 0;
        return level < LOG_TO_LIN_SIZE ? expTable[level] : 0;
    }

    /** One sample, modulated by `input`. */
    generateSample(input) {
        this._tickEnvelope();
        this.prevSample = this.outputVal;
        const sineIndex = this._stepPhase() + (input >> INPUT_TO_SINE_SHIFT);
        this.outputVal = this._levelToSample(sineIndex);
        return this.outputVal;
    }

    /** One sample, modulated by the last two outputs. Returns the one before. */
    generateFeedback(shift) {
        this._tickEnvelope();
        const sum = this.outputVal + this.prevSample;
        this.prevSample = this.outputVal;
        let sineIndex = this._stepPhase();
        if (shift < 31) {
            sineIndex += ((sum << (1 + OUTPUT_TO_ENV_SHIFT)) >> shift) >> PHASE_TO_SINE_SHIFT;
        }
        this.outputVal = this._levelToSample(sineIndex);
        return this.prevSample;
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
        this.feedbackShift = 0;
        this.algorithm = 0;
    }

    assignChip(chip) {
        for (let i = 0; i < 4; i++) this.op[i].assignChip(chip);
    }

    reset() {
        for (let i = 0; i < 4; i++) this.op[i].reset();
    }

    writeFeedback(feedback) {
        this.feedbackShift = FEEDBACK_SHIFT_TABLE[feedback];
    }

    configureAlgorithm(algo) {
        this.op[0].clearFeedback();
        this.algorithm = algo;
    }

    setFrequency(f) {
        for (let i = 0; i < 4; i++) this.op[i].setFrequency(f);
    }

    setKeyOnSlots(slots) {
        for (let i = 0; i < 4; i++) {
            if (slots & (1 << i)) this.op[i].keyOn(); else this.op[i].keyOff();
        }
    }

    /** Bring the operators up to date; true if any of them sounds. */
    prepareForRender() {
        const op = this.op;
        let active = 0;
        for (let i = 0; i < 4; i++) {
            op[i].recalculate();
            active |= op[i].isActive();
        }
        return active !== 0;
    }

    /** One sample of the channel. */
    compute() {
        const op = this.op;
        const fb = this.feedbackShift;
        let r;
        switch (this.algorithm) {
            case 0:
                op[2].generateSample(op[1].outputVal);
                op[1].generateSample(op[0].outputVal);
                r = op[3].generateSample(op[2].outputVal);
                op[0].generateFeedback(fb);
                break;
            case 1:
                op[2].generateSample(op[0].outputVal + op[1].outputVal);
                op[1].generateSample(0);
                r = op[3].generateSample(op[2].outputVal);
                op[0].generateFeedback(fb);
                break;
            case 2:
                op[2].generateSample(op[1].outputVal);
                op[1].generateSample(0);
                r = op[3].generateSample(op[0].outputVal + op[2].outputVal);
                op[0].generateFeedback(fb);
                break;
            case 3:
                op[2].generateSample(0);
                op[1].generateSample(op[0].outputVal);
                r = op[3].generateSample(op[1].outputVal + op[2].outputVal);
                op[0].generateFeedback(fb);
                break;
            case 4:
                op[2].generateSample(0);
                r = op[1].generateSample(op[0].outputVal);
                r += op[3].generateSample(op[2].outputVal);
                op[0].generateFeedback(fb);
                break;
            case 5:
                r  = op[2].generateSample(op[0].outputVal);
                r += op[1].generateSample(op[0].outputVal);
                r += op[3].generateSample(op[0].outputVal);
                op[0].generateFeedback(fb);
                break;
            case 6:
                r  = op[2].generateSample(0);
                r += op[1].generateSample(op[0].outputVal);
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
// YM2203 timers (registers $24-$27)
// -----------------------------------------------------------------------------

/** Master clocks per timer A count for prescaler setting 0-2 ($2D / $2E / $2F). */
const TIMER_A_UNIT = [72, 36, 24];

/** Register numbers that pick a prescaler when named on the bus. */
const PRESCALER_BY_NAME = new Map([[0x2D, 0], [0x2E, 1], [0x2F, 2]]);

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

// $27, timer control and channel 3 mode. Each timer owns one bit of three
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
// channel 3 their own F-numbers ($A8-$AE); with this bit of the mode set,
// a timer A overflow also keys the channel on (CSM).
const CH3_MODE_NORMAL = 0;
const CH3_MODE_CSM_BIT = 2;

// Timer counts (registers $24-$26): NA has 10 bits,
// the upper 8 in $24 and the lower 2 in $25; NB is the 8 bits of $26.
// register -> [timer (0 = A, 1 = B), lowest count bit it sets, bit width]
const TIMER_COUNT_FIELDS = new Map([
    [0x24, [0, 2, 8]],
    [0x25, [0, 0, 2]],
    [0x26, [1, 0, 8]],
]);

// Operator parameters $30-$9E by the upper hex digit of the register.
// Each takes the operator, the value
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
OPERATOR_WRITERS[0x6] = (op, v) => op.writeDR((v & 0x1F) * 2); // DR
OPERATOR_WRITERS[0x7] = (op, v) => op.writeSR((v & 0x1F) * 2); // SR
OPERATOR_WRITERS[0x8] = (op, v) => {                 // SL, RR
    op.writeSL(SUSTAIN_LEVEL_TABLE[v >> 4]);
    op.writeRR((v & 0x0F) * 4 + 2);
};
OPERATOR_WRITERS[0x9] = (op, v) => op.writeSSGEG(v & 0x0F); // SSG-EG

// Register writes by the upper hex digit of the register: $0x the SSG, $2x mode and timers, $3x-$9x
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
        this._configureRate(c, r);
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

    _configureRate(c, r) {
        this._clock = c;
        this._psgrate = r;
        this._recalcFrequencies();
    }

    _recalcFrequencies() {
        const p = this._prescale;
        this._prescale = -1;
        this._configurePrescaler(p);
    }

    _configurePrescaler(p) {
        const dividers = [6, 3, 2];

        if (this._prescale !== p) {
            this._prescale = p;
            const fmclock = Math.floor(this._clock / dividers[p] / 12);

            this._rate = this._psgrate;

            // Ratio of FM clock to output rate
            const half = Math.floor(this._rate / 2);
            this._chip.updateRatio(Math.floor(((fmclock << CLOCK_RATIO_BITS) + half) / this._rate));
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

        this._fmAccum = 0;
        // Counted samples are dropped with the buffer below.
        this._pendingSamples = 0;

        // Every voice register $30-$BF to 0. The timers and the channel 3
        // mode ($24-$27) were cleared above.
        for (let reg = 0x30; reg < 0xC0; reg++) this._storeRegister(reg, 0);
        this._configurePrescaler(0);
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
     * The bus has named a register. Naming one of PRESCALER_BY_NAME selects
     * the prescaler at once; every other number waits for its data in
     * writeReg().
     */
    selectAddress(addr) {
        const choice = PRESCALER_BY_NAME.get(addr & 0xFF);
        if (choice === undefined) return;
        this.renderPendingSamples();
        this._selectPrescaler(choice);
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
     * $20-$2F: $24-$27 the timers,
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
     * bits 3-2 the operator slot through REG_TO_OP_MAP.
     */
    _writeOperatorRegister(reg, v) {
        const channel = reg & 3;
        if (channel === 3) return;
        const voice = this._ch[channel];
        const op = voice.op[REG_TO_OP_MAP[(reg >> 2) & 3]];
        OPERATOR_WRITERS[reg >> 4](op, v, voice === this._csmch && this._isCSMMode());
    }

    /**
     * $A0-$AE: bit 2 of the
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

    /** $B0-$B2: feedback (bits 5-3) and algorithm (bits 2-0). */
    _writeVoiceRegister(reg, v) {
        if (reg > 0xB2) return;
        const voice = this._ch[reg & 3];
        voice.writeFeedback((v >> 3) & 7);
        voice.configureAlgorithm(v & 7);
    }

    _isCSMMode() {
        return (this._ch3Mode & CH3_MODE_CSM_BIT) !== 0;
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
     * Operators whose envelope is OFF are not counted.
     * @param {number[]} [out] optional 3-element array to fill (avoids garbage)
     */
    getFMChannelLevels(out = [0, 0, 0]) {
        this.renderPendingSamples();
        for (let i = 0; i < 3; i++) {
            const ch = this._ch[i];
            let level = 0;
            const mask = FM_CARRIER_MASK[ch.algorithm & 7];
            for (let o = 0; o < 4; o++) {
                if (!(mask & (1 << o))) continue;
                const op = ch.op[o];
                if (op.egStage === ENV_PHASE_OFF) continue;
                const att = op.envOutput >> 3;
                if (att >= 1023) continue;
                level += Math.pow(2, -att / 64);
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

    _scaleFM(s) {
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

        const active0 = ch[0].prepareForRender();
        const active1 = ch[1].prepareForRender();
        const active2 = ch[2].prepareForRender();
        const ssg = this._ssg;
        const ssgGain = this._ssgMixGain;

        for (let n = 0; n < nsamples; n++) {
            let fm = 0;
            if (active0) fm = ch[0].compute();
            if (active1) fm += ch[1].compute();
            if (active2) fm += ch[2].compute();

            // SSG always renders; generateSample() returns one output sample.
            buffer[n] += this._scaleFM(fm) + ((ssg.generateSample() * ssgGain) | 0);
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
