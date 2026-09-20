// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// Canvas frame sink — connects the core Display to an HTML canvas.
//
//   The core renders RGBA pixels into a frame obtained from Display.frameSink.
//   CanvasFrameSink hands the core an ImageData created on the canvas's 2D
//   context, so the core writes straight into the canvas back buffer and each
//   present() updates the changed rectangle with putImageData.
// =============================================================================
import { SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_HEIGHT_400, DISPLAY_MODE_400 } from './display.js';

export class CanvasFrameSink {
    /** @param {HTMLCanvasElement|OffscreenCanvas} canvas */
    constructor(canvas) {
        this.canvas = canvas;
        this._ctx = null;
        this._imageData = null;
    }

    /**
     * Return an ImageData of the requested size bound to the canvas.
     * The canvas and its context are resized when the requested size changes.
     */
    acquireFrame(w, h) {
        const canvas = this.canvas;
        if (!this._ctx || !this._imageData ||
            canvas.width !== w || canvas.height !== h ||
            this._imageData.width !== w || this._imageData.height !== h) {
            canvas.width = w;
            canvas.height = h;
            this._ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
            this._imageData = this._ctx.createImageData(w, h);
        }
        return this._imageData;
    }

    present(frame, x, y, w, h) {
        if (x === 0 && y === 0 && w === frame.width && h === frame.height) {
            this._ctx.putImageData(frame, 0, 0);
        } else {
            this._ctx.putImageData(frame, 0, 0, x, y, w, h);
        }
    }
}

/**
 * Render the display onto `canvas`, attaching a CanvasFrameSink for it if
 * the display is not already bound to that canvas.
 * @param {import('./display.js').Display} display
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {boolean} [force]
 */
export function renderToCanvas(display, canvas, force = false) {
    const sink = display.frameSink;
    if (!(sink instanceof CanvasFrameSink) || sink.canvas !== canvas) {
        display.frameSink = new CanvasFrameSink(canvas);
    }
    display.render(force);
}

/**
 * Render at native resolution into an OffscreenCanvas, then draw it onto
 * `canvas` doubled in height (line-doubled 200-line modes). The display's
 * previous sink is restored afterwards.
 */
export function renderDoubled(display, canvas, force = false) {
    const h = (display.displayMode === DISPLAY_MODE_400) ? SCREEN_HEIGHT_400 : SCREEN_HEIGHT;
    if (!display._offscreenCanvas || display._offscreenCanvas.height !== h) {
        display._offscreenCanvas = new OffscreenCanvas(SCREEN_WIDTH, h);
    }
    const savedSink = display.frameSink;
    renderToCanvas(display, display._offscreenCanvas, force);
    display.frameSink = savedSink;

    canvas.width = SCREEN_WIDTH;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(display._offscreenCanvas, 0, 0, SCREEN_WIDTH, h * 2);
}
