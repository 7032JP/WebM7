// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// Web Audio output for the PSG and OPN sound generators.
//
//   The core PSG / OPN classes generate samples and hand full chunks to
//   `_workletNode.port` when one is attached; creating the AudioContext, the
//   AudioWorkletNode and the GainNode is the host's job. WebPSG / WebOPN add
//   exactly that (startAudio / resumeAudio / stopAudio) on top of the core
//   classes. FM7Browser constructs these in place of the core PSG / OPN.
// =============================================================================
import { PSG } from './psg.js';
import { OPN } from './opn.js';

const SAMPLE_RATE = 44100;   // must match the core's sample rate (psg.js / opn.js)

export class WebPSG extends PSG {
    /**
     * Initialise the AudioContext.  Must be called from a user-gesture
     * handler (click / keydown) to satisfy browser autoplay policy.
     */
    startAudio() {
        if (this._audioCtx) return;

        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this._audioCtx = new AC({ sampleRate: SAMPLE_RATE });

            // GainNode for volume control
            this._gainNode = this._audioCtx.createGain();
            this._gainNode.gain.value = this._volume;
            this._gainNode.connect(this._audioCtx.destination);

            // AudioWorkletNode replaces ScriptProcessorNode (deprecated).
            // Module load is async; node is wired up once ready. Until then
            // step() drops samples (audible only as a brief silence at boot).
            this._audioCtx.audioWorklet
                .addModule(new URL('./audio-worklet-processor.js', import.meta.url))
                .then(() => {
                    this._workletNode = new AudioWorkletNode(
                        this._audioCtx,
                        'ring-buffer-processor',
                        {
                            numberOfInputs: 0,
                            numberOfOutputs: 1,
                            outputChannelCount: [1],
                        },
                    );
                    this._workletNode.connect(this._gainNode);
                    console.log('PSG: AudioWorklet ready (' + this._audioCtx.sampleRate + ' Hz)');
                })
                .catch((e) => {
                    console.warn('PSG: AudioWorklet load failed:', e);
                });

            console.log('PSG: audio started (' + this._audioCtx.sampleRate + ' Hz)');
        } catch (e) {
            console.warn('PSG: audio init failed:', e);
        }
    }

    /** Resume a suspended AudioContext (call from user gesture). */
    resumeAudio() {
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }
    }

    stopAudio() {
        if (this._workletNode) {
            this._workletNode.disconnect();
            this._workletNode = null;
        }
        if (this._gainNode) {
            this._gainNode.disconnect();
            this._gainNode = null;
        }
        if (this._audioCtx) {
            this._audioCtx.close().catch(() => {});
            this._audioCtx = null;
        }
    }
}

export class WebOPN extends OPN {
    startAudio() {
        if (this._audioCtx) return;

        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            this._audioCtx = new AC({ sampleRate: SAMPLE_RATE });

            this._gainNode = this._audioCtx.createGain();
            this._gainNode.gain.value = this._volume;
            this._gainNode.connect(this._audioCtx.destination);

            // AudioWorkletNode replaces ScriptProcessorNode (deprecated).
            // See psg.js for the same pattern. Module load is async; node
            // is wired up once ready and step() drops samples until then.
            this._audioCtx.audioWorklet
                .addModule(new URL('./audio-worklet-processor.js', import.meta.url))
                .then(() => {
                    this._workletNode = new AudioWorkletNode(
                        this._audioCtx,
                        'ring-buffer-processor',
                        {
                            numberOfInputs: 0,
                            numberOfOutputs: 1,
                            outputChannelCount: [1],
                        },
                    );
                    this._workletNode.connect(this._gainNode);
                    console.log('OPN: AudioWorklet ready (' + this._audioCtx.sampleRate + ' Hz)');
                })
                .catch((e) => {
                    console.warn('OPN: AudioWorklet load failed:', e);
                });

            console.log('OPN: audio started (' + this._audioCtx.sampleRate + ' Hz)');
        } catch (e) {
            console.warn('OPN: audio init failed:', e);
        }
    }

    resumeAudio() {
        if (this._audioCtx && this._audioCtx.state === 'suspended') {
            this._audioCtx.resume();
        }
    }

    stopAudio() {
        if (this._workletNode) {
            this._workletNode.disconnect();
            this._workletNode = null;
        }
        if (this._gainNode) {
            this._gainNode.disconnect();
            this._gainNode = null;
        }
        if (this._audioCtx) {
            this._audioCtx.close().catch(() => {});
            this._audioCtx = null;
        }
    }
}
