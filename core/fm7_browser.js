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
//   The emulation itself (memory map, I/O, scheduler, sound generation) is
//   lives in the core FM7 class.
// =============================================================================
import { FM7 } from './fm7.js';
import { WebPSG, WebOPN } from './audio_output.js';
import { FddSound } from './fdd_sound.js';
import { renderToCanvas } from './display_canvas.js';

export {
    MACHINE_FM7, MACHINE_FM77, MACHINE_FM77AV, MACHINE_FM77AV20,
    MACHINE_FM77AV20EX, MACHINE_FM77AV40, MACHINE_FM77AV40EX,
} from './fm7.js';

export class FM7Browser extends FM7 {
    /**
     * @param {object} [parts] - see FM7. Defaults to WebPSG / WebOPN
     *   (Web Audio output) and a FddSound synthesiser.
     */
    constructor(parts = {}) {
        super({
            psg:      parts.psg || new WebPSG(),
            opn:      parts.opn || new WebOPN(),
            fddSound: (parts.fddSound !== undefined) ? parts.fddSound : new FddSound(),
        });

        // BEEP (Web Audio nodes on the PSG's context)
        this._beepOsc = null;
        this._beepGain = null;
        this._beepTimer = null;

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
        // BREAK key (Backquote `) is handled separately — it doesn't go
        // through the keyboard encoder buffer; instead it directly drives
        // $FD04 bit 1 (active low).
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
                this._breakKey = true;
                // BREAK press asserts main CPU FIRQ (shared line with
                // sub→main attention). Level-triggered in hardware, but
                // edge on press is sufficient: FIRQ handler reads $FD04
                // bit1 to identify BREAK and acts accordingly.
                this.mainCPU.firq();
                return;
            }
            this.keyboard.keyDown(e);
        };
        this._keyUpHandler = (e) => {
            if (this._breakKeyCodes.includes(e.code)) {
                e.preventDefault();
                this._breakKey = false;
                return;
            }
            this.keyboard.keyUp(e);
        };
        document.addEventListener('keydown', this._keyDownHandler);
        document.addEventListener('keyup', this._keyUpHandler);

        // When the window loses focus (Alt+Tab, minimize, tab switch) the
        // browser stops delivering keyup, so a held modifier — notably GRPH,
        // which is mapped to Alt and whose keyup Alt+Tab consumes — would stay
        // stuck on.  Release all held keys on focus-loss; toggle states
        // (CAPS / KANA / INS) are preserved.
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

        // Stop any active BEEP sound
        this._beepStop();

        // Final UI update
        if (this._frameCallback) this._frameCallback();

        console.log('FM-7 emulation stopped');
    }

    /**
     * Execute a single emulation frame.
     * Called by requestAnimationFrame. Frame-limited to ~60fps
     * so high-refresh displays (120/360Hz) don't speed up emulation.
     */
    _frame() {
        if (!this._running) return;

        // Wall-clock based pacing: advance emulation by actual elapsed time
        // so that low-refresh-rate rAF environments (30 Hz) still run at real-time speed.
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
        this._pollGamepads();

        // Run scheduler for the actual wall-clock interval just elapsed.
        // CMT turbo: run 50x faster only when actively reading a tape
        const cmtTurbo = (this.cmt.motor && this.cmt.loaded) ? 50 : 1;
        try {
            this.scheduler.exec(Math.round(simMs * 1000) * cmtTurbo);
        } catch (e) {
            console.error('Emulation error:', e);
            this.stop();
            return;
        }
        // NOTE: auto-type (TXT/BAS paste) is advanced by the scheduler's
        // 'autotype' event (see _wireScheduler), not from this render loop, so
        // it stays on emulated time regardless of display refresh rate.

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

    /** Poll Gamepad API and update joystick state based on per-port assignments. */
    _pollGamepads() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        this._gamepadState[0] = 0xFF;
        this._gamepadState[1] = 0xFF;

        for (let fmPort = 0; fmPort < 2; fmPort++) {
            const idx = this._joystickAssign[fmPort];
            if (idx == null) continue;
            const gp = gamepads[idx];
            if (!gp || !gp.connected) continue;
            this._gamepadState[fmPort] = this._readGamepadState(gp);
        }
    }

    // =========================================================================
    // BEEP Sound (Web Audio)
    // =========================================================================

    /**
     * Start BEEP tone.
     * @param {number} durationMs - Duration in ms, or -1 for continuous
     */
    _beepStart(durationMs) {
        // Use PSG's AudioContext if available
        const ctx = this.psg._audioCtx;
        if (!ctx) return;

        this._beepStop(); // Stop any existing beep

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 1200; // FM-7 BEEP frequency ~1.2kHz

        // Smooth gain ramp to avoid click noise
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.003); // 3ms fade-in

        osc.connect(gain);
        // Route through PSG volume control so BEEP respects the volume slider
        gain.connect(this.psg._gainNode || ctx.destination);
        osc.start(now);

        this._beepOsc = osc;
        this._beepGain = gain;
        this._beepContinuous = (durationMs < 0);

        if (durationMs > 0) {
            // Use Web Audio API scheduling instead of setTimeout for precise timing
            const endTime = now + durationMs / 1000;
            gain.gain.setValueAtTime(0.15, endTime - 0.003);
            gain.gain.linearRampToValueAtTime(0, endTime); // 3ms fade-out
            osc.stop(endTime + 0.001);
            // Clean up references after oscillator ends
            osc.onended = () => {
                if (this._beepOsc === osc) {
                    this._beepOsc = null;
                    this._beepGain = null;
                    this._beepContinuous = false;
                }
            };
        }
    }

    /** Stop BEEP tone. */
    _beepStop() {
        if (this._beepOsc) {
            const ctx = this.psg._audioCtx;
            if (ctx && this._beepGain) {
                // Smooth fade-out to avoid click
                const now = ctx.currentTime;
                this._beepGain.gain.cancelScheduledValues(now);
                this._beepGain.gain.setValueAtTime(this._beepGain.gain.value, now);
                this._beepGain.gain.linearRampToValueAtTime(0, now + 0.003);
                try { this._beepOsc.stop(now + 0.005); } catch (e) { /* ignore */ }
            } else {
                try { this._beepOsc.stop(); } catch (e) { /* ignore */ }
                this._beepOsc.disconnect();
            }
            this._beepOsc = null;
        }
        if (this._beepGain) {
            // Don't disconnect immediately - let fade-out complete
            const g = this._beepGain;
            this._beepGain = null;
            setTimeout(() => { try { g.disconnect(); } catch (e) {} }, 10);
        }
        this._beepContinuous = false;
    }

    // =========================================================================
    // Debug helpers that need the page
    // =========================================================================

    /** Trigger browser download of the FDC log as a text file. */
    downloadFdcLog(filename = 'webm7_fdc.log') {
        const text = this.fdc.dumpLogText();
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`FDC log saved: ${filename} (${this.fdc.log.length} events)`);
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
