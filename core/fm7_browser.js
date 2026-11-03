// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// FM7Browser — the FM7 core bound to a browser page.
//
//   Browser APIs handled by this module:
//     - keyboard and focus events of the document / window
//     - the requestAnimationFrame frame loop (start / stop / _frame)
//     - Gamepad API polling
//     - BEEP tone generation on the PSG's AudioContext
//     - audio start / resume on user gesture, FDD sound synthesiser
//     - FDC log download
//   The emulation itself (memory map, I/O, scheduler, sound generation)
//   lives in the core FM7 class.
// =============================================================================
import { FM7, BUZZER_TONE_HZ } from './fm7.js';
import { WebPSG, WebOPN } from './audio_output.js';
import { DriveNoiseSynth } from './fdd_sound.js';
import { renderToCanvas } from './display_canvas.js';

export {
    MACHINE_FM7, MACHINE_FM77, MACHINE_FM77AV, MACHINE_FM77AV20,
    MACHINE_FM77AV20EX, MACHINE_FM77AV40, MACHINE_FM77AV40EX,
} from './fm7.js';

export class FM7Browser extends FM7 {
    /**
     * @param {object} [parts] - see FM7. Defaults to WebPSG / WebOPN
     *   (Web Audio output) and a DriveNoiseSynth.
     */
    constructor(parts = {}) {
        super({
            psg:      parts.psg || new WebPSG(),
            opn:      parts.opn || new WebOPN(),
            fddSound: (parts.fddSound !== undefined) ? parts.fddSound : new DriveNoiseSynth(),
        });

        // Buzzer tone (Web Audio nodes on the PSG's context)
        this._toneOsc = null;
        this._toneGain = null;

        // Frame loop state
        this._animFrameId = null;
        this._canvas      = null;
        this._fpsCounter  = 0;
        this._fpsTime     = 0;
        this._lastFrameTime = 0;

        this._wireBrowserKeyboard();
        this._wireGamepad();
    }

    // =========================================================================
    // Keyboard / focus events
    // =========================================================================

    /**
     * Bind keyboard / focus events of the page to the machine.
     * The core handles encoder wiring and exposes pressBreak() /
     * releaseBreak() for hosts without a physical BREAK key.
     */
    _wireBrowserKeyboard() {
        // Bind keyboard events to document
        // The configurable BREAK key is checked first; other keys go to the keyboard encoder.
        this._keyDownHandler = (e) => {
            // Start / resume audio on first user gesture
            if (!this.psg._audioCtx) {
                this.psg.startAudio();
            } else {
                this.psg.resumeAudio();
            }
            if (!this.opn._audioCtx) {
                this.opn.startAudio();
            } else {
                this.opn.resumeAudio();
            }
            this.fddSound.init(this.psg._audioCtx);

            if (this._breakKeyCodes.includes(e.code)) {
                e.preventDefault();
                if (e.repeat) {
                    // Auto-repeat: FIRQ only; the make code is sent once.
                    this._breakKey = true;
                    this.mainCPU.firq();
                } else {
                    this.pressBreak();
                }
                return;
            }
            this.keyboard.keyDown(e);
        };
        this._keyUpHandler = (e) => {
            if (this._breakKeyCodes.includes(e.code)) {
                e.preventDefault();
                this.releaseBreak();
                return;
            }
            this.keyboard.keyUp(e);
        };
        document.addEventListener('keydown', this._keyDownHandler);
        document.addEventListener('keyup', this._keyUpHandler);

        // Release held keys on focus loss; toggle states are preserved.
        this._blurHandler = () => {
            this.keyboard.releaseAllHeld();
            this._breakKey = false;
        };
        this._visHandler = () => {
            if (document.hidden) this._blurHandler();
        };
        window.addEventListener('blur', this._blurHandler);
        document.addEventListener('visibilitychange', this._visHandler);
    }

    // =========================================================================
    // Emulation Loop (requestAnimationFrame)
    // =========================================================================

    /**
     * Start the emulation loop.
     * @param {HTMLCanvasElement} canvas - Canvas element for display output
     */
    start(canvas) {
        if (this._running) return;

        this._canvas = canvas || this._canvas;
        this._running = true;
        this._fpsTime = performance.now();
        this._fpsCounter = 0;

        // Start audio on emulation start (user gesture context)
        if (!this.psg._audioCtx) {
            this.psg.startAudio();
        } else {
            this.psg.resumeAudio();
        }
        if (!this.opn._audioCtx) {
            this.opn.startAudio();
        } else {
            this.opn.resumeAudio();
        }
        this.fddSound.init(this.psg._audioCtx);

        // Bind frame method
        this._boundFrame = () => this._frame();
        this._animFrameId = requestAnimationFrame(this._boundFrame);

        console.log('FM-7 emulation started');
    }

    /**
     * Stop the emulation loop.
     */
    stop() {
        if (!this._running) return;

        this._running = false;
        if (this._animFrameId !== null) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = null;
        }

        // Silence the buzzer while stopped; the next change of the buzzer
        // state starts it again.
        this._toneOff();
        this._buzzerSounding = false;

        // Final UI update
        if (this._frameCallback) this._frameCallback();

        console.log('FM-7 emulation stopped');
    }

    /**
     * Execute a single emulation frame.
     * Called by requestAnimationFrame. Paced by wall-clock time so the
     * emulation speed stays the same across display refresh rates.
     */
    _frame() {
        if (!this._running) return;

        const now = performance.now();
        const elapsed = now - this._lastFrameTime;
        if (elapsed < 15.5) {
            this._animFrameId = requestAnimationFrame(this._boundFrame);
            return;
        }
        // Clamp to avoid huge catch-up after tab suspension or pauses.
        const simMs = Math.min(elapsed, 50);
        this._lastFrameTime = now;

        // Poll gamepads for joystick input
        this._readPads();

        // Run scheduler for the clamped interval, accelerated while a tape
        // is loaded and its motor is on.
        const cmtTurbo = (this.cmt.motor && this.cmt.loaded) ? 50 : 1;
        try {
            this.scheduler.runFor(Math.round(simMs * 1000) * cmtTurbo);
        } catch (e) {
            console.error('Emulation error:', e);
            this.stop();
            return;
        }
        // Render display to canvas (through the canvas frame sink)
        if (this._canvas) {
            renderToCanvas(this.display, this._canvas);
        }

        // FPS calculation (reuse 'now' from frame limiter above)
        this._fpsCounter++;
        if (now - this._fpsTime >= 1000) {
            this._currentFPS = this._fpsCounter;
            this._fpsCounter = 0;
            this._fpsTime = now;
        }

        // Per-frame callback (UI status update etc.)
        if (this._frameCallback) this._frameCallback();

        // Schedule next frame
        this._animFrameId = requestAnimationFrame(this._boundFrame);
    }

    // =========================================================================
    // Gamepad Polling
    // =========================================================================

    /** Set up gamepad connection event tracking. */
    _wireGamepad() {
        this._gamepadHandler = (e) => {
            console.log('Gamepad connected:', e.gamepad.id);
        };
        window.addEventListener('gamepadconnected', this._gamepadHandler);
    }

    /** Read a single gamepad into an FM-7 joystick state byte (active low). */
    _readGamepadState(gp) {
        let state = 0xFF;
        const deadzone = 0.3;
        const ax0 = gp.axes[0] || 0;
        const ax1 = gp.axes[1] || 0;
        if (ax1 < -deadzone || (gp.buttons[12] && gp.buttons[12].pressed)) state &= ~0x01;
        if (ax1 >  deadzone || (gp.buttons[13] && gp.buttons[13].pressed)) state &= ~0x02;
        if (ax0 < -deadzone || (gp.buttons[14] && gp.buttons[14].pressed)) state &= ~0x04;
        if (ax0 >  deadzone || (gp.buttons[15] && gp.buttons[15].pressed)) state &= ~0x08;
        if ((gp.buttons[0] && gp.buttons[0].pressed) ||
            (gp.buttons[2] && gp.buttons[2].pressed)) state &= ~0x10;
        if ((gp.buttons[1] && gp.buttons[1].pressed) ||
            (gp.buttons[3] && gp.buttons[3].pressed)) state &= ~0x20;
        return state;
    }

    /** Poll the Gamepad API into the joystick on each connector. */
    _readPads() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let fmPort = 0; fmPort < 2; fmPort++) {
            const idx = this.joystickHostIndex[fmPort];
            const gp = idx == null ? null : gamepads[idx];
            this.setJoystickState(fmPort, (gp && gp.connected) ? this._readGamepadState(gp) : 0xFF);
        }
    }

    // =========================================================================
    // Buzzer tone (Web Audio)
    // =========================================================================

    /** The core switches the buzzer on and off; make or stop the tone. */
    buzzerOutput(on) {
        if (on) this._toneOn();
        else this._toneOff();
    }

    _toneOn() {
        const ctx = this.psg._audioCtx;
        if (!ctx || this._toneOsc) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = BUZZER_TONE_HZ;
        // Short ramps keep the edges from clicking.
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.003);
        osc.connect(gain);
        // Through the PSG volume so the volume slider applies.
        gain.connect(this.psg._gainNode || ctx.destination);
        osc.start(now);
        this._toneOsc = osc;
        this._toneGain = gain;
    }

    _toneOff() {
        const osc = this._toneOsc, gain = this._toneGain;
        this._toneOsc = null;
        this._toneGain = null;
        if (!osc) return;
        const ctx = this.psg._audioCtx;
        if (ctx && gain) {
            const now = ctx.currentTime;
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(gain.gain.value, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.003);
            try { osc.stop(now + 0.005); } catch (e) { /* already stopped */ }
            setTimeout(() => { try { gain.disconnect(); } catch (e) { /* gone */ } }, 10);
        } else {
            try { osc.stop(); } catch (e) { /* already stopped */ }
            osc.disconnect();
        }
    }

    // =========================================================================
    // Debug helpers that need the page
    // =========================================================================

    /** Trigger browser download of the FDC log as a text file. */
    downloadFdcLog(filename = 'webm7_fdc.log') {
        const text = this.fdc.traceText();
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`FDC log saved: ${filename} (${this.fdc.trace.length} records)`);
    }

    /**
     * Clean up event listeners.
     */
    destroy() {
        this.stop();
        this.psg.stopAudio();
        this.opn.stopAudio();
        document.removeEventListener('keydown', this._keyDownHandler);
        document.removeEventListener('keyup', this._keyUpHandler);
        if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);
        if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
        if (this._gamepadHandler) {
            window.removeEventListener('gamepadconnected', this._gamepadHandler);
                }
    }
}
