// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * AudioWorkletProcessor for queued audio chunk playback.
 * Used by both PSG and OPN audio output.
 *
 * Communication via MessagePort:
 *   Main → Worklet: { type: 'samples', data: Float32Array }
 *   Worklet → Main: (none needed)
 */
class RingBufferProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];     // Queue of Float32Array chunks
        this._offset = 0;     // Current offset in first chunk

        // Cap queued chunks to bound output latency when producers run
        // faster than real-time.
        const MAX_CHUNKS = 8;

        this.port.onmessage = (ev) => {
            if (ev.data.type === 'samples') {
                this._queue.push(ev.data.data);
                while (this._queue.length > MAX_CHUNKS) {
                    this._queue.shift();
                    this._offset = 0;
                }
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output[0]) return true;

        const buf = output[0];
        let written = 0;

        while (written < buf.length && this._queue.length > 0) {
            const chunk = this._queue[0];
            const available = chunk.length - this._offset;
            const needed = buf.length - written;
            const toCopy = Math.min(available, needed);

            for (let i = 0; i < toCopy; i++) {
                buf[written + i] = chunk[this._offset + i];
            }

            written += toCopy;
            this._offset += toCopy;

            if (this._offset >= chunk.length) {
                this._queue.shift();
                this._offset = 0;
            }
        }

        // Fill remainder with silence
        for (let i = written; i < buf.length; i++) {
            buf[i] = 0;
        }

        return true;
    }
}

registerProcessor('ring-buffer-processor', RingBufferProcessor);
