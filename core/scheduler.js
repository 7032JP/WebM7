// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * FM-7 Event Scheduler
 *
 * デュアル CPU と周期イベントの実行を管理する。サブ CPU はクロック比に応じて実行する。
 */

// Main and sub CPU clocks differ. Every machine (FM-7, FM-77, FM77AV family)
// shares the same base pair:
//   Main CPU effective  = 1.794 MHz (nominal 2 MHz minus memory wait states)
//   Sub  CPU            = 2.000 MHz
// On the FM77AV family the main value is lowered further while MMR/TWR is
// enabled; the sub value never changes.
// Scheduler advances sub by `mainCycles × (SUB_CLOCK / MAIN_CLOCK)` each step.
let CPU_CLOCK_HZ = 1794000;         // Main CPU effective clock
let SUB_CLOCK_HZ = 2000000;         // Sub CPU clock (independent)
let CYCLES_PER_MICROSECOND = CPU_CLOCK_HZ / 1000000;
let SUB_CYCLE_RATIO = SUB_CLOCK_HZ / CPU_CLOCK_HZ;

/**
 * Set main CPU clock speed. Called when the machine type changes and when
 * MMR/TWR shift the effective rate on the FM77AV family.
 * Sub CPU keeps its own rate (see setSubCPUClock) — MMR/TWR slowdown must not
 * propagate to the sub system.
 */
function setCPUClock(hz) {
    CPU_CLOCK_HZ = hz;
    CYCLES_PER_MICROSECOND = hz / 1000000;
    SUB_CYCLE_RATIO = SUB_CLOCK_HZ / CPU_CLOCK_HZ;
}

/**
 * Set sub CPU clock speed (2.000 MHz on every machine so far). Kept separate
 * from setCPUClock so the main CPU's MMR/TWR slowdown cannot leak into it.
 */
function setSubCPUClock(hz) {
    SUB_CLOCK_HZ = hz;
    SUB_CYCLE_RATIO = SUB_CLOCK_HZ / CPU_CLOCK_HZ;
}

/**
 * Convert microseconds to CPU cycles.
 */
function usToCycles(us) {
    return Math.round(us * CYCLES_PER_MICROSECOND);
}

/**
 * Convert CPU cycles to microseconds.
 */
function cyclesToUs(cycles) {
    return cycles / CYCLES_PER_MICROSECOND;
}

/**
 * A single scheduled event that fires periodically.
 *
 * The event's period is stored in microseconds (`intervalUs`) so it survives
 * CPU clock changes — `recomputeForClock()` re-derives `reload` (in cycles)
 * whenever the main CPU clock shifts (e.g. MMR/TWR turning on or off).
 */
class SchedulerEvent {
    /**
     * @param {string}   id           - unique identifier
     * @param {number}   intervalUs   - reload interval in microseconds
     * @param {function} callback     - called when event fires
     */
    constructor(id, intervalUs, callback) {
        this.id = id;
        this.intervalUs = intervalUs;            // canonical period in µs
        this.reload = usToCycles(intervalUs);    // derived cycles for current clock
        this.current = this.reload;              // countdown in cycles (mutable)
        this.callback = callback;
        this.enabled = true;
    }

    /**
     * Re-derive `reload` from `intervalUs` for the current CPU clock, and
     * scale `current` proportionally so the event's relative phase within
     * its period is preserved across the clock change.
     */
    recomputeForClock() {
        const oldReload = this.reload;
        const newReload = usToCycles(this.intervalUs);
        if (oldReload > 0 && newReload > 0) {
            this.current = Math.max(1, Math.round(this.current * (newReload / oldReload)));
        } else {
            this.current = newReload;
        }
        this.reload = newReload;
    }

    /**
     * Update the canonical interval (µs) and immediately re-derive cycles.
     * Used by callbacks that change the period (e.g. timer 2034↔2035 µs).
     */
    setIntervalUs(intervalUs) {
        this.intervalUs = intervalUs;
        this.reload = usToCycles(intervalUs);
    }

    /**
     * Subtract elapsed cycles; return true if the event fired.
     */
    tick(elapsed) {
        if (!this.enabled) return false;

        this.current -= elapsed;
        if (this.current <= 0) {
            // Reload, carrying over any overshoot so long-term timing stays accurate
            this.current += this.reload;
            // Guard against pathological case where elapsed >> reload
            if (this.current <= 0) {
                this.current = this.reload;
            }
            this.callback();
            return true;
        }
        return false;
    }

    reset() {
        this.current = this.reload;
    }
}

export class Scheduler {
    constructor() {
        /** @type {SchedulerEvent[]} */
        this.events = [];

        /** Main 6809 CPU instance (must implement exec() returning cycles used) */
        this.mainCPU = null;
        /** Sub 6809 CPU instance */
        this.subCPU = null;

        /**
         * When true the sub CPU is halted (e.g. main CPU wrote to $FD05)
         * and we skip its execution.
         */
        this.subHalted = false;

        // Book-keeping for dual-CPU sync
        this.mainCyclesTotal = 0;
        this.subCyclesTotal = 0;
        // Sub CPU cycle budget, accumulated incrementally per main instruction
        // as `mainElapsed × SUB_CYCLE_RATIO`. Incremental accumulation (rather
        // than `mainCyclesTotal × ratio`) keeps the budget correct across
        // main-clock changes (MMR/TWR on/off) — the ratio at the time each
        // main cycle was consumed is what counts.
        this.subCyclesTarget = 0;

        // Timer IRQ alternation state (2034 / 2035 us)
        this._timerAlternate = false;
    }

    // ------------------------------------------------------------------
    // CPU wiring
    // ------------------------------------------------------------------

    /**
     * Attach the main 6809 CPU.
     * The CPU object must expose:
     *   exec()  - execute one instruction, return cycles consumed
     *   irq()   - assert IRQ line  (optional, used by timer event)
     */
    setMainCPU(cpu) {
        this.mainCPU = cpu;
    }

    /**
     * Attach the sub 6809 CPU.
     * Same interface as main CPU.
     */
    setSubCPU(cpu) {
        this.subCPU = cpu;
    }

    /**
     * Control whether the sub CPU is halted.
     */
    setSubHalted(halted) {
        this.subHalted = halted;
        // Sync cycle counters on HALT and RUN transitions.
        this.subCyclesTotal = this.subCyclesTarget;
    }

    // ------------------------------------------------------------------
    // Event management
    // ------------------------------------------------------------------

    /**
     * Register a repeating event.
     *
     * @param {string}   id            - unique name (e.g. "timer", "vsync")
     * @param {number}   microseconds  - interval in microseconds
     * @param {function} callback      - fired each time the event expires
     * @returns {SchedulerEvent}
     */
    addEvent(id, microseconds, callback) {
        // Remove any existing event with same id
        this.removeEvent(id);

        const evt = new SchedulerEvent(id, microseconds, callback);
        this.events.push(evt);
        return evt;
    }

    /**
     * Re-derive every event's reload-in-cycles from its canonical µs period.
     * Call this immediately after `setCPUClock(hz)` so that real-time event
     * periods stay constant across MMR/TWR clock transitions.
     */
    onClockChange() {
        for (const evt of this.events) {
            evt.recomputeForClock();
        }
    }

    /**
     * Disable and remove event by id.
     */
    removeEvent(id) {
        const idx = this.events.findIndex(e => e.id === id);
        if (idx !== -1) {
            this.events.splice(idx, 1);
        }
    }

    /**
     * Return event by id or null.
     */
    getEvent(id) {
        return this.events.find(e => e.id === id) || null;
    }

    // ------------------------------------------------------------------
    // Timer helpers (convenience for the most common FM-7 events)
    // ------------------------------------------------------------------

    /**
     * Install the standard FM-7 timer IRQ event (~2034.5 us period,
     * alternating between 2034 and 2035 us to approximate 2034.5).
     *
     * @param {function} callback - called on each timer tick
     */
    addTimerEvent(callback) {
        // Start with 2034 us; the wrapper alternates each firing
        const self = this;
        self._timerAlternate = false;

        const wrapper = () => {
            callback();
            // Alternate the reload value for next period
            const evt = self.getEvent('timer');
            if (evt) {
                self._timerAlternate = !self._timerAlternate;
                evt.setIntervalUs(self._timerAlternate ? 2035 : 2034);
            }
        };

        return this.addEvent('timer', 2034, wrapper);
    }

    /**
     * Install the standard 60 Hz VSync event.
     *
     * @param {function} callback - called on each VSync
     */
    addVSyncEvent(callback) {
        return this.addEvent('vsync', 16667, callback);
    }

    // ------------------------------------------------------------------
    // Execution
    // ------------------------------------------------------------------

    /**
     * Run both CPUs for approximately the given number of microseconds.
     *
     * Execution proceeds instruction-by-instruction on the main CPU.
     * After each main CPU instruction the sub CPU is run until it has
     * caught up with its cycle budget (main cycles times the clock ratio),
     * unless it is halted.  After each main instruction, all scheduler
     * events are ticked by the number of cycles just consumed.
     *
     * @param {number} microseconds - target wall-time to simulate
     * @returns {number} actual microseconds executed
     */
    exec(microseconds) {
        if (!this.mainCPU) {
            throw new Error('Scheduler: main CPU not attached');
        }

        const targetCycles = usToCycles(microseconds);
        const startMain = this.mainCyclesTotal;

        while (this.mainCyclesTotal - startMain < targetCycles) {
            // --- Main CPU: execute one instruction ---
            const mainElapsed = this.mainCPU.exec();
            this.mainCyclesTotal += mainElapsed;
            this.subCyclesTarget += mainElapsed * SUB_CYCLE_RATIO;

            // --- Sub CPU: catch up to its own cycle budget ---
            // サブ CPU の実行量はクロック比 (SUB_CYCLE_RATIO) で決める。
            if (!this.subHalted && this.subCPU) {
                while (this.subCyclesTotal < this.subCyclesTarget) {
                    const subElapsed = this.subCPU.exec();
                    this.subCyclesTotal += subElapsed;
                }
            }

            // --- Tick all scheduler events ---
            for (let i = 0; i < this.events.length; i++) {
                this.events[i].tick(mainElapsed);
            }
        }

        const actualCycles = this.mainCyclesTotal - startMain;
        return cyclesToUs(actualCycles);
    }

    /**
     * Execute a single main CPU instruction, sync sub CPU, tick events.
     * Returns the number of main CPU cycles consumed.
     * Useful for step-by-step debugging.
     */
    step() {
        if (!this.mainCPU) {
            throw new Error('Scheduler: main CPU not attached');
        }

        const mainElapsed = this.mainCPU.exec();
        this.mainCyclesTotal += mainElapsed;
        this.subCyclesTarget += mainElapsed * SUB_CYCLE_RATIO;

        if (!this.subHalted && this.subCPU) {
            while (this.subCyclesTotal < this.subCyclesTarget) {
                const subElapsed = this.subCPU.exec();
                this.subCyclesTotal += subElapsed;
            }
        }

        for (let i = 0; i < this.events.length; i++) {
            this.events[i].tick(mainElapsed);
        }

        return mainElapsed;
    }

    // ------------------------------------------------------------------
    // Reset
    // ------------------------------------------------------------------

    /**
     * Reset all scheduler state.  Does NOT reset the CPU instances
     * themselves - call their own reset() for that.
     */
    reset() {
        this.mainCyclesTotal = 0;
        this.subCyclesTotal = 0;
        this.subCyclesTarget = 0;
        this.subHalted = false;
        this._timerAlternate = false;

        for (const evt of this.events) {
            evt.reset();
        }
    }
}

/** Current sub/main clock ratio (recomputed on setCPUClock/setSubCPUClock). */
function getSubCycleRatio() {
    return SUB_CYCLE_RATIO;
}

// Export constants for external use
export { CPU_CLOCK_HZ, CYCLES_PER_MICROSECOND, usToCycles, cyclesToUs, setCPUClock, setSubCPUClock, getSubCycleRatio };
