// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// FDD emulation sound synthesizer (Web Audio)
// =============================================================================
// Synthesizes realistic mechanical FDD sounds from layered noise, impulses,
// and filtered oscillators. No external audio assets are used.
//
// Sound types:
//   1. Head seek  — multi-step "ガガガ" / "カカカ" with metallic impact layers
//   2. Head load  — single "カチッ" / "ガシッ" click
//   3. Spindle motor — low hum while disk is being accessed
//   4. Disk insert — sliding + latch click
//   5. Disk eject — spring release + slide out
//
// Drive profiles:
//   FM-7    : 5" external drive  — heavier, lower pitch, longer steps
//   FM77AV  : 3.5" internal drive — lighter, higher pitch, shorter steps

const HEAD_LOAD_DEBOUNCE_SEC = 0.2;
const MAX_STEPS_PER_SEEK     = 160;
const NOISE_BUFFER_SEC       = 0.5;
const MOTOR_FADE_OUT_SEC     = 0.15;  // motor stops quickly after last access
const MOTOR_IDLE_TIMEOUT_MS  = 2000;  // stop motor after 2s idle

// FM-7: 5-inch external drive — heavy, low-pitched mechanical sounds
const PROFILE_FM7 = {
    // Seek step
    stepInterval:    0.008,    // time between steps (slower, heavier)
    stepAttack:      0.0004,   // attack time
    stepDur:         0.018,    // envelope duration per step
    // Noise band (main texture)
    noiseBpFreq:     350,
    noiseBpQ:        1.8,
    noiseGain:       0.7,
    // Impact thump (low frequency sine impulse)
    impactFreq:      120,
    impactDur:       0.012,
    impactGain:      0.5,
    // Metallic resonance (high-Q ringing)
    metalFreq:       1800,
    metalQ:          12,
    metalGain:       0.15,
    // Head load click
    loadAttack:      0.0003,
    loadDur:         0.025,
    loadNoiseFreq:   500,
    loadNoiseQ:      2.0,
    loadNoiseGain:   0.8,
    loadImpactFreq:  150,
    loadImpactGain:  0.6,
    loadMetalFreq:   2200,
    loadMetalQ:      15,
    loadMetalGain:   0.2,
    // Motor
    motorFreq:       55,
    motorGain:       0.06,
    motorNoiseGain:  0.03,
    motorNoiseBp:    200,
    // Insert/Eject
    insertDur:       0.25,
    insertClickGain: 0.5,
    ejectDur:        0.20,
    ejectClickGain:  0.4,
};

// FM77AV: 3.5-inch internal drive — lighter, higher-pitched
const PROFILE_FM77AV = {
    stepInterval:    0.004,
    stepAttack:      0.0003,
    stepDur:         0.012,
    noiseBpFreq:     800,
    noiseBpQ:        2.2,
    noiseGain:       0.55,
    impactFreq:      200,
    impactDur:       0.008,
    impactGain:      0.35,
    metalFreq:       2800,
    metalQ:          14,
    metalGain:       0.12,
    loadAttack:      0.0002,
    loadDur:         0.018,
    loadNoiseFreq:   900,
    loadNoiseQ:      2.5,
    loadNoiseGain:   0.65,
    loadImpactFreq:  220,
    loadImpactGain:  0.4,
    loadMetalFreq:   3200,
    loadMetalQ:      18,
    loadMetalGain:   0.15,
    motorFreq:       72,
    motorGain:       0.04,
    motorNoiseGain:  0.02,
    motorNoiseBp:    300,
    insertDur:       0.18,
    insertClickGain: 0.35,
    ejectDur:        0.15,
    ejectClickGain:  0.3,
};

export class FddSound {
    constructor() {
        this._audioCtx         = null;
        this._masterGain       = null;
        this._noiseBuffer      = null;
        this._enabled          = true;
        this._volume           = 0.5;
        this._lastHeadLoadTime = -1;
        this._scheduledUntil   = 0;
        // Motor state
        this._motorOsc         = null;
        this._motorNoiseSource = null;
        this._motorGain        = null;
        this._motorRunning     = false;
        this._motorTimer       = null;
    }

    init(audioCtx) {
        if (this._audioCtx || !audioCtx) return;
        this._initWith(audioCtx);
    }

    /** Ensure AudioContext exists (creates one if needed, e.g. for insert/eject while powered off) */
    _ensureAudioCtx() {
        if (this._audioCtx) return true;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            this._initWith(ctx);
            return true;
        } catch (e) {
            return false;
        }
    }

    _initWith(audioCtx) {
        this._audioCtx = audioCtx;

        this._masterGain = audioCtx.createGain();
        this._masterGain.gain.value = this._enabled ? this._volume : 0;
        this._masterGain.connect(audioCtx.destination);

        const len = Math.floor(audioCtx.sampleRate * NOISE_BUFFER_SEC);
        const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        this._noiseBuffer = buf;
    }

    setEnabled(on) {
        this._enabled = !!on;
        if (this._masterGain) {
            this._masterGain.gain.value = this._enabled ? this._volume : 0;
        }
        if (!this._enabled) {
            this._scheduledUntil = 0;
            this._stopMotor();
        }
    }

    isEnabled() { return this._enabled; }

    setVolume(v) {
        this._volume = Math.max(0, Math.min(1, v));
        if (this._masterGain && this._enabled) {
            this._masterGain.gain.value = this._volume;
        }
    }

    getVolume() { return this._volume; }

    _ready() {
        return this._enabled && this._audioCtx && this._noiseBuffer && this._masterGain;
    }

    _profile(isAV) {
        return isAV ? PROFILE_FM77AV : PROFILE_FM7;
    }

    // =========================================================================
    // Primitive sound building blocks
    // =========================================================================

    /** Noise burst through bandpass filter with AD envelope */
    _noiseBurst(t, dur, freq, q, gain, attack) {
        const ctx = this._audioCtx;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        const offsetMax = Math.max(0, NOISE_BUFFER_SEC - dur - 0.005);
        src.start(t, Math.random() * offsetMax, dur + 0.005);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq;
        bp.Q.value = q;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(gain, t + attack);
        env.gain.exponentialRampToValueAtTime(0.001, t + dur);

        src.connect(bp);
        bp.connect(env);
        env.connect(this._masterGain);
    }

    /** Sine impulse (low-frequency thump) */
    _sineImpulse(t, freq, dur, gain) {
        const ctx = this._audioCtx;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        const env = ctx.createGain();
        env.gain.setValueAtTime(gain, t);
        env.gain.exponentialRampToValueAtTime(0.001, t + dur);

        osc.connect(env);
        env.connect(this._masterGain);
        osc.start(t);
        osc.stop(t + dur + 0.01);
    }

    /** High-Q metallic ring */
    _metalRing(t, freq, q, dur, gain) {
        const ctx = this._audioCtx;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        src.start(t, Math.random() * 0.1, 0.003);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = freq;
        bp.Q.value = q;

        const env = ctx.createGain();
        env.gain.setValueAtTime(gain, t);
        env.gain.exponentialRampToValueAtTime(0.001, t + dur);

        src.connect(bp);
        bp.connect(env);
        env.connect(this._masterGain);
    }

    // =========================================================================
    // Composite sounds
    // =========================================================================

    /** Schedule one seek-step click at time t (3 layers: noise + impact + metal) */
    _scheduleStepClick(t, p) {
        // Layer 1: Filtered noise burst (main texture)
        this._noiseBurst(t, p.stepDur, p.noiseBpFreq, p.noiseBpQ, p.noiseGain, p.stepAttack);
        // Layer 2: Low-frequency sine impulse (mechanical thump)
        this._sineImpulse(t, p.impactFreq, p.impactDur, p.impactGain);
        // Layer 3: Metallic resonance ring
        this._metalRing(t, p.metalFreq, p.metalQ, p.stepDur * 1.5, p.metalGain);
    }

    /** Schedule one head-load click at time t (3 layers, stronger) */
    _scheduleLoadClick(t, p) {
        this._noiseBurst(t, p.loadDur, p.loadNoiseFreq, p.loadNoiseQ, p.loadNoiseGain, p.loadAttack);
        this._sineImpulse(t, p.loadImpactFreq, p.loadDur * 0.8, p.loadImpactGain);
        this._metalRing(t, p.loadMetalFreq, p.loadMetalQ, p.loadDur * 1.2, p.loadMetalGain);
    }

    // =========================================================================
    // Public API — seek / headLoad
    // =========================================================================

    seek(steps, isAV) {
        if (!this._ready()) return;
        const n = Math.min(MAX_STEPS_PER_SEEK, Math.max(0, steps | 0));
        if (n === 0) return;

        const p   = this._profile(isAV);
        const now = this._audioCtx.currentTime;
        let   t   = Math.max(now, this._scheduledUntil);

        for (let i = 0; i < n; i++) {
            this._scheduleStepClick(t, p);
            t += p.stepInterval;
        }
        this._scheduledUntil = t;

        this._touchMotor(isAV);
    }

    headLoad(isAV) {
        if (!this._ready()) return;
        const now = this._audioCtx.currentTime;
        if (now - this._lastHeadLoadTime < HEAD_LOAD_DEBOUNCE_SEC) return;
        this._lastHeadLoadTime = now;
        const p = this._profile(isAV);
        this._scheduleLoadClick(now, p);

        this._touchMotor(isAV);
    }

    // =========================================================================
    // Spindle motor sound
    // =========================================================================

    _touchMotor(isAV) {
        if (!this._ready()) return;
        if (!this._motorRunning) this._startMotor(isAV);
        // Reset idle timer
        if (this._motorTimer) clearTimeout(this._motorTimer);
        this._motorTimer = setTimeout(() => this._stopMotor(), MOTOR_IDLE_TIMEOUT_MS);
    }

    _startMotor(isAV) {
        if (this._motorRunning) return;
        const ctx = this._audioCtx;
        const p = this._profile(isAV);
        const now = ctx.currentTime;

        // Motor gain envelope
        this._motorGain = ctx.createGain();
        this._motorGain.gain.setValueAtTime(0, now);
        this._motorGain.gain.linearRampToValueAtTime(1, now + 0.15);
        this._motorGain.connect(this._masterGain);

        // Low-frequency oscillator (motor hum)
        this._motorOsc = ctx.createOscillator();
        this._motorOsc.type = 'sawtooth';
        this._motorOsc.frequency.value = p.motorFreq;
        const oscGain = ctx.createGain();
        oscGain.gain.value = p.motorGain;
        this._motorOsc.connect(oscGain);
        oscGain.connect(this._motorGain);
        this._motorOsc.start(now);

        // Noise component (bearing/friction sound)
        this._motorNoiseSource = ctx.createBufferSource();
        this._motorNoiseSource.buffer = this._noiseBuffer;
        this._motorNoiseSource.loop = true;
        const noiseBp = ctx.createBiquadFilter();
        noiseBp.type = 'bandpass';
        noiseBp.frequency.value = p.motorNoiseBp;
        noiseBp.Q.value = 1.5;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = p.motorNoiseGain;
        this._motorNoiseSource.connect(noiseBp);
        noiseBp.connect(noiseGain);
        noiseGain.connect(this._motorGain);
        this._motorNoiseSource.start(now);

        this._motorRunning = true;
    }

    _stopMotor() {
        if (!this._motorRunning) return;
        const ctx = this._audioCtx;
        if (!ctx) return;
        const now = ctx.currentTime;

        if (this._motorGain) {
            this._motorGain.gain.cancelScheduledValues(now);
            this._motorGain.gain.setValueAtTime(this._motorGain.gain.value, now);
            this._motorGain.gain.linearRampToValueAtTime(0, now + MOTOR_FADE_OUT_SEC);
        }

        const stopTime = now + MOTOR_FADE_OUT_SEC + 0.1;
        if (this._motorOsc)         { try { this._motorOsc.stop(stopTime); } catch(e) {} }
        if (this._motorNoiseSource) { try { this._motorNoiseSource.stop(stopTime); } catch(e) {} }

        this._motorOsc = null;
        this._motorNoiseSource = null;
        this._motorGain = null;
        this._motorRunning = false;
        if (this._motorTimer) { clearTimeout(this._motorTimer); this._motorTimer = null; }
    }

    // =========================================================================
    // Disk insert / eject sounds
    // =========================================================================

    diskInsert(isAV) {
        if (!this._enabled) return;
        if (!this._ensureAudioCtx()) return;
        const ctx = this._audioCtx;
        const p = this._profile(isAV);
        const now = ctx.currentTime;
        const dur = p.insertDur;

        // Sliding noise (frequency sweep low→high)
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        src.start(now, 0, dur + 0.05);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(200, now);
        bp.frequency.linearRampToValueAtTime(1200, now + dur * 0.7);
        bp.frequency.setValueAtTime(1200, now + dur * 0.7);
        bp.Q.value = 1.2;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(0.3, now + 0.01);
        env.gain.setValueAtTime(0.3, now + dur * 0.5);
        env.gain.exponentialRampToValueAtTime(0.001, now + dur);

        src.connect(bp);
        bp.connect(env);
        env.connect(this._masterGain);

        // Latch click at the end
        const clickTime = now + dur * 0.75;
        this._sineImpulse(clickTime, 180, 0.015, p.insertClickGain);
        this._noiseBurst(clickTime, 0.02, 600, 2.0, p.insertClickGain * 0.6, 0.0003);
        this._metalRing(clickTime, 2500, 10, 0.03, p.insertClickGain * 0.3);
    }

    diskEject(isAV) {
        if (!this._enabled) return;
        if (!this._ensureAudioCtx()) return;
        const ctx = this._audioCtx;
        const p = this._profile(isAV);
        const now = ctx.currentTime;
        const dur = p.ejectDur;

        // Spring release click at the start
        this._sineImpulse(now, 160, 0.012, p.ejectClickGain);
        this._noiseBurst(now, 0.015, 700, 2.5, p.ejectClickGain * 0.7, 0.0002);
        this._metalRing(now, 2000, 8, 0.025, p.ejectClickGain * 0.25);

        // Sliding noise (frequency sweep high→low, disk coming out)
        const slideStart = now + 0.03;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        src.start(slideStart, 0.1, dur + 0.05);

        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1000, slideStart);
        bp.frequency.linearRampToValueAtTime(250, slideStart + dur * 0.8);
        bp.Q.value = 1.0;

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.25, slideStart);
        env.gain.linearRampToValueAtTime(0.15, slideStart + dur * 0.5);
        env.gain.exponentialRampToValueAtTime(0.001, slideStart + dur);

        src.connect(bp);
        bp.connect(env);
        env.connect(this._masterGain);
    }
}
