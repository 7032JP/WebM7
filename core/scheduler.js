// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * Emulated time keeping.
 *
 * Time is counted in periods of the 8 MHz master clock (125 ns, "ticks").
 * Every main CPU bus cycle length in the hardware manual is a whole number
 * of these periods (4, 5, 6 or 7 ticks), so the main CPU
 * adds the exact length of each instruction and no fractional main clock is
 * needed. The sub CPU runs from its own 2.016 MHz clock: elapsed ticks
 * earn it sub cycles, which it then spends on instructions.
 */

/**
 * Master clock that all main CPU bus cycle lengths are multiples of
 * (FM-7 User's Manual, system specification 1.1.1: clock 8 MHz).
 */
export const MASTER_CLOCK_HZ = 8000000;
export const TICKS_PER_US = MASTER_CLOCK_HZ / 1000000;

/** Sub CPU clock: 16.128 MHz / 8 (FM77AV Hardware Manual 7.1 (1)). */
export const SUB_CPU_CLOCK_HZ = 2016000;
/** Sub CPU cycles that elapse per master tick. */
export const SUB_CYCLES_PER_TICK = SUB_CPU_CLOCK_HZ / MASTER_CLOCK_HZ;

/** Microseconds to master ticks (rounded). */
export function usToTicks(us) {
    return Math.round(us * TICKS_PER_US);
}

/** Master ticks to microseconds. */
export function ticksToUs(ticks) {
    return ticks / TICKS_PER_US;
}

/**
 * A repeating deadline. The period is held in ticks; `fire()` runs the
 * handler. `advance()` is called with the ticks that just elapsed.
 * The scheduler that owns the event is told before and after its wait
 * changes, so that it can apply the ticks it is holding back first and
 * look for the nearest deadline again afterwards.
 */
class PeriodicEvent {
    constructor(name, periodUs, handler, owner = null) {
        this.name = name;
        this.handler = handler;
        this.owner = owner;
        this.periodTicks = Math.max(1, usToTicks(periodUs));
        this.ticksLeft = this.periodTicks;
    }

    /** Change the period; takes effect at the next expiry. */
    setPeriodUs(us) {
        this.periodTicks = Math.max(1, usToTicks(us));
    }

    /** Change the period and start a fresh wait of that length now. */
    restartWithPeriodUs(us) {
        if (this.owner) this.owner.settleEvents();
        this.setPeriodUs(us);
        this.ticksLeft = this.periodTicks;
        if (this.owner) this.owner.findNextDeadline();
    }

    /** Run the handler once. */
    fire() {
        this.handler();
    }

    advance(ticks) {
        this.ticksLeft -= ticks;
        if (this.ticksLeft > 0) return;
        // Keep the overshoot so that the long-term rate stays exact.
        this.ticksLeft += this.periodTicks;
        if (this.ticksLeft <= 0) this.ticksLeft = this.periodTicks;
        this.handler();
    }

    restart() {
        if (this.owner) this.owner.settleEvents();
        this.ticksLeft = this.periodTicks;
        if (this.owner) this.owner.findNextDeadline();
    }
}

export class Scheduler {
    constructor() {
        /** @type {PeriodicEvent[]} */
        this.events = [];
        this.mainCPU = null;
        this.subCPU = null;
        /** Master ticks elapsed since reset. */
        this.elapsedTicks = 0;
        /**
         * Sub CPU cycles converted from the elapsed master ticks (at the
         * 2.016 MHz sub clock) and not yet executed. An instruction may end
         * past them; the excess is taken off the next conversion.
         */
        this.subCyclesPending = 0;
        /** True while the sub CPU is held (HALT). */
        this.subHalted = false;
        /**
         * Ticks given to advanceEvents() and not yet taken off the events.
         * While they stay below the nearest deadline no event can expire,
         * so the events are advanced only when it is reached (or when the
         * list or a wait changes). Ticks are whole numbers, so one
         * subtraction of the sum leaves the same wait as many small ones.
         */
        this.eventTicksHeld = 0;
        /** The smallest ticksLeft of the events (Infinity with no events). */
        this.ticksToNextDeadline = Infinity;
    }

    setMainCPU(cpu) { this.mainCPU = cpu; }
    setSubCPU(cpu) { this.subCPU = cpu; }

    /**
     * Hold or release the sub CPU. A held CPU earns nothing, and whatever
     * it had earned or overspent is dropped at both edges.
     */
    setSubHalted(halted) {
        this.subHalted = halted;
        this.subCyclesPending = 0;
    }

    /** Credit the sub CPU with cycles (nothing while it is held). */
    grantSubCycles(cycles) {
        if (!this.subHalted) this.subCyclesPending += cycles;
    }

    /** Register (or replace) a repeating event. */
    addEvent(name, periodUs, handler) {
        this.removeEvent(name);
        const evt = new PeriodicEvent(name, periodUs, handler, this);
        this.events.push(evt);
        this.findNextDeadline();
        return evt;
    }

    removeEvent(name) {
        this.settleEvents();
        const i = this.events.findIndex(e => e.name === name);
        if (i >= 0) this.events.splice(i, 1);
        this.findNextDeadline();
    }

    /** The event of that name, with every tick given so far taken off its wait. */
    findEvent(name) {
        this.settleEvents();
        return this.events.find(e => e.name === name) || null;
    }

    /**
     * Advance every event by the given ticks. The events expire on the
     * same call as when each call advanced them all.
     *
     * When the nearest deadline is reached, the ticks held from the earlier
     * calls are taken off every wait first. They are below every wait, so
     * no event expires on them. Then the events are advanced by this call's
     * ticks alone, in list order, as if every call advanced them all: a
     * handler that restarts, adds or removes another event leaves the same
     * waits as it would there.
     */
    advanceEvents(ticks) {
        const earlier = this.eventTicksHeld;
        if (earlier + ticks < this.ticksToNextDeadline) {
            this.eventTicksHeld = earlier + ticks;
            return;
        }
        this.eventTicksHeld = 0;
        const list = this.events;
        if (earlier !== 0) {
            for (let i = 0; i < list.length; i++) list[i].ticksLeft -= earlier;
        }
        for (let i = 0; i < list.length; i++) list[i].advance(ticks);
        this.findNextDeadline();
    }

    /** Take the held ticks off every event now. */
    settleEvents() {
        const held = this.eventTicksHeld;
        if (held === 0) return;
        this.eventTicksHeld = 0;
        const list = this.events;
        for (let i = 0; i < list.length; i++) list[i].advance(held);
        this.findNextDeadline();
    }

    /** Look for the nearest deadline again after the events or a wait changed. */
    findNextDeadline() {
        let next = Infinity;
        const list = this.events;
        for (let i = 0; i < list.length; i++) {
            if (list[i].ticksLeft < next) next = list[i].ticksLeft;
        }
        this.ticksToNextDeadline = next;
    }

    /** Let the sub CPU spend its earned cycles. */
    spendSubCycles() {
        if (!this.subCPU) return;
        while (!this.subHalted && this.subCyclesPending > 0) {
            this.subCyclesPending -= this.subCPU.exec();
        }
    }

    /**
     * Generic run loop for a stand-alone pair of CPUs: every main CPU
     * instruction counts its CPU cycles as fast bus cycles. The machine
     * class installs its own loop with the real bus cycle lengths.
     *
     * @param {number} microseconds  time to run for
     * @returns {number} master ticks actually run (the last instruction may end past the goal)
     */
    runFor(microseconds) {
        if (!this.mainCPU) throw new Error('Scheduler: main CPU not attached');
        const goal = this.elapsedTicks + usToTicks(microseconds);
        const start = this.elapsedTicks;
        while (this.elapsedTicks < goal) {
            const ticks = this.mainCPU.exec() * 4;
            this.elapsedTicks += ticks;
            this.grantSubCycles(ticks * SUB_CYCLES_PER_TICK);
            this.spendSubCycles();
            this.advanceEvents(ticks);
        }
        return this.elapsedTicks - start;
    }

    /** Clear the time counters and restart every event's wait. */
    restartClock() {
        this.elapsedTicks = 0;
        this.subCyclesPending = 0;
        this.subHalted = false;
        this.eventTicksHeld = 0;
        for (const evt of this.events) evt.restart();
        this.findNextDeadline();
    }
}
