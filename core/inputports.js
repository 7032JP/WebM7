// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// Mouse and joystick ports
//
//   MouseSetCard   the bus mouse interface card: X/Y up-down counters and
//                  switches at $FDE8 and an MB8873H programmable
//                  timer at $FDE0-$FDE7
//   SoundChipPorts the two I/O ports of the OPN (registers 7, 14, 15) with
//                  the two joystick connectors behind them
//   ConnectorMouse a mouse plugged into a joystick connector
// =============================================================================

/** External clock inputs (C1-C3) of the timer: 19.2 kHz. */
const TIMER_EXT_CLOCK_HZ = 19200;

// -----------------------------------------------------------------------------
// MB8873H (MC6840) programmable timer
// -----------------------------------------------------------------------------

/** One of the three timers. Counts are kept as clocks left to time-out. */
class TimerChannel {
    constructor() {
        this.control = 0;
        this.latch = 0xFFFF;
        this.clocksLeft = 0;   // clocks until the next time-out
        this.flag = false;     // interrupt flag
        this.flagSeen = false; // status was read while the flag was set
        this.fired = false;    // single-shot mode: time-out already reported
    }

    /** Clocks from load to time-out for the current latch and count mode. */
    period() {
        if (this.control & 0x04) {   // two 8-bit counters
            return ((this.latch & 0xFF) + 1) * ((this.latch >> 8) + 1);
        }
        return this.latch + 1;
    }

    /** Counter initialization: load from the latch, clear the flag. */
    initialize() {
        this.clocksLeft = this.period();
        this.flag = false;
        this.flagSeen = false;
        this.fired = false;
    }

    /** Value of the counter as the CPU reads it. */
    counterValue() {
        const n = Math.max(0, this.clocksLeft - 1);
        if (this.control & 0x04) {
            const lsbSpan = (this.latch & 0xFF) + 1;
            return ((Math.floor(n / lsbSpan) & 0xFF) << 8) | (n % lsbSpan);
        }
        return n & 0xFFFF;
    }

    /** Counting modes (bit 3 = 0) run; the measurement modes need gate inputs. */
    counts() {
        return (this.control & 0x08) === 0;
    }

    advance(clocks) {
        if (clocks <= 0 || !this.counts()) return;
        const p = this.period();
        let left = this.clocksLeft - clocks;
        while (left <= 0) {
            left += p;
            const singleShot = (this.control & 0x20) !== 0;
            if (!singleShot || !this.fired) {
                this.flag = true;
                this.flagSeen = false;
            }
            this.fired = true;
        }
        this.clocksLeft = left;
    }
}

export class ProgrammableTimer {
    constructor() {
        this.channels = [new TimerChannel(), new TimerChannel(), new TimerChannel()];
        this.msbBuffer = 0;           // MSB write buffer (shared)
        this.lsbBuffer = 0;           // LSB read buffer (shared)
        this.extClockTicks = 0;       // remainder of ticks x TIMER_EXT_CLOCK_HZ, carried to the next external clock
        this.timer3Prescale = 0;      // timer 3 clocks not yet divided by 8
        this.reset();
    }

    /** RESET: latches at maximum, CR1 bit 0 set, counters preset, flags off. */
    reset() {
        for (const ch of this.channels) {
            ch.control = 0;
            ch.latch = 0xFFFF;
            ch.initialize();
        }
        this.channels[0].control = 0x01;
        this.msbBuffer = 0;
        this.lsbBuffer = 0;
        this.extClockTicks = 0;
        this.timer3Prescale = 0;
    }

    /** CR1 bit 0: all timers held preset. */
    get heldInReset() {
        return (this.channels[0].control & 0x01) !== 0;
    }

    /** Composite interrupt flag (status bit 7). */
    get interrupt() {
        return this.channels.some(ch => ch.flag && (ch.control & 0x40));
    }

    status() {
        let v = this.interrupt ? 0x80 : 0x00;
        this.channels.forEach((ch, i) => {
            if (ch.flag) { v |= 1 << i; ch.flagSeen = true; }
        });
        return v;
    }

    read(offset) {
        switch (offset) {
            case 1: return this.status();
            case 2: case 4: case 6: {
                const ch = this.channels[(offset >> 1) - 1];
                const v = ch.counterValue();
                this.lsbBuffer = v & 0xFF;
                // Reading the counter after the status clears the flag.
                if (ch.flagSeen) { ch.flag = false; ch.flagSeen = false; }
                return v >> 8;
            }
            case 3: case 5: case 7:
                return this.lsbBuffer;
            default:
                return 0xFF;   // $FDE0 has no read function
        }
    }

    write(offset, val) {
        val &= 0xFF;
        switch (offset) {
            case 0: {
                // CR2 bit 0 selects CR1 (1) or CR3 (0).
                const target = (this.channels[1].control & 0x01) ? 0 : 2;
                this._setControl(target, val);
                return;
            }
            case 1:
                this._setControl(1, val);
                return;
            case 2: case 4: case 6:
                this.msbBuffer = val;
                return;
            default: {
                const ch = this.channels[((offset - 1) >> 1) - 1];
                ch.latch = (this.msbBuffer << 8) | val;
                ch.flag = false;
                ch.flagSeen = false;
                // Counting modes with bit 4 = 0 initialize on a latch write.
                if (ch.counts() && !(ch.control & 0x10)) ch.initialize();
                return;
            }
        }
    }

    _setControl(index, val) {
        const wasHeld = this.heldInReset;
        this.channels[index].control = val;
        if (this.heldInReset) {
            for (const ch of this.channels) ch.initialize();
        } else if (wasHeld && index === 0) {
            for (const ch of this.channels) ch.initialize();
        }
    }

    /**
     * Advance by elapsed time.
     * @param {number} ticks      master clock periods (for the external clock inputs)
     * @param {number} eClocks    main CPU E clocks in the same span
     * @param {number} tickRateHz master clock rate
     */
    advance(ticks, eClocks, tickRateHz) {
        if (this.heldInReset) return;
        this.extClockTicks += ticks * TIMER_EXT_CLOCK_HZ;
        const extClocks = Math.floor(this.extClockTicks / tickRateHz);
        this.extClockTicks -= extClocks * tickRateHz;
        this.channels.forEach((ch, i) => {
            let clocks = (ch.control & 0x02) ? eClocks : extClocks;
            if (i === 2 && (ch.control & 0x01)) {
                this.timer3Prescale += clocks;
                clocks = this.timer3Prescale >> 3;
                this.timer3Prescale &= 7;
            }
            ch.advance(clocks);
        });
    }
}

// -----------------------------------------------------------------------------
// Bus mouse counters and switches ($FDE8)
// -----------------------------------------------------------------------------

export class MouseSetCard {
    constructor() {
        this.timer = new ProgrammableTimer();
        this.reset();
    }

    reset() {
        this.countX = 0;          // internal 8-bit up/down counters
        this.countY = 0;
        this.outX = 0;            // output (held) data
        this.outY = 0;
        this.control = 0;         // last control register value
        this.readIndex = 0;       // 0..3: X low, X high, Y low, Y high
        this.left = false;
        this.right = false;
        this.timer.reset();
    }

    /** Counting stops while either hold bit is set. */
    get counting() {
        return (this.control & 0x03) === 0;
    }

    /** Pointer movement in counts; right and down are positive. */
    move(dx, dy) {
        if (!this.counting) return;   // movement during a hold is not kept
        this.countX = (this.countX + dx) & 0xFF;
        this.countY = (this.countY + dy) & 0xFF;
    }

    setButtons(left, right) {
        this.left = !!left;
        this.right = !!right;
    }

    readStatus() {
        const nibbles = [this.outX & 0x0F, this.outX >> 4, this.outY & 0x0F, this.outY >> 4];
        const v = 0x80 | (this.right ? 0x20 : 0) | (this.left ? 0x10 : 0) | nibbles[this.readIndex];
        this.readIndex = (this.readIndex + 1) & 3;
        return v;
    }

    setControl(val) {
        // Both hold bits latch the counters into the output data; HC also
        // clears the counters, E only stops them.
        if (val & 0x03) {
            this.outX = this.countX;
            this.outY = this.countY;
            if (val & 0x02) { this.countX = 0; this.countY = 0; }
        }
        this.control = val & 0x03;
        this.readIndex = 0;
    }
}

// -----------------------------------------------------------------------------
// Mouse on a joystick connector
// -----------------------------------------------------------------------------

/**
 * A packet whose first nibble went out longer ago than this (us) is
 * abandoned: the next strobe change starts a new packet from X high
 * (3 ms counted from the first nibble).
 */
const PACKET_TIMEOUT_US = 3000;

export class ConnectorMouse {
    constructor() {
        this.reset();
    }

    reset() {
        this.pendingX = 0;        // movement since the last packet; left/up positive
        this.pendingY = 0;
        this.packet = 0;          // 16-bit packet being sent: X in the high byte, Y in the low
        this.nibblesSent = 4;     // nibbles of `packet` already put on the lines (4 = done)
        this.lines = 0;           // value on the four data lines
        this.strobe = null;       // last strobe level seen
        this.packetStartUs = -Infinity;  // time the first nibble of `packet` went out
        this.left = false;
        this.right = false;
    }

    /** Pointer movement in counts; right and down are positive. */
    move(dx, dy) {
        this.pendingX -= dx;
        this.pendingY -= dy;
    }

    setButtons(left, right) {
        this.left = !!left;
        this.right = !!right;
    }

    /** Take the movement so far as a new packet (each axis limited to one signed byte). */
    _startPacket(nowUs) {
        const toByte = (v) => (v < -128 ? -128 : v > 127 ? 127 : v) & 0xFF;
        this.packet = (toByte(this.pendingX) << 8) | toByte(this.pendingY);
        this.pendingX = 0;
        this.pendingY = 0;
        this.nibblesSent = 0;
        this.packetStartUs = nowUs;
    }

    /**
     * Called with the strobe (COM output) level whenever register 7, 14 or
     * 15 is written. The level is taken from the value last written to
     * register 15 (portBOut), so it changes only on a write to 15.
     * Every change of level puts the next nibble of the packet on the data
     * lines, most significant first. A new packet starts on the change
     * after the whole packet has gone, or on the first change once
     * PACKET_TIMEOUT_US has passed since the packet began.
     * `nowUs` is the emulated time of that register write.
     */
    setStrobe(level, nowUs = 0) {
        const previous = this.strobe;
        this.strobe = level;
        if (previous === null || previous === level) return;
        const expired = nowUs - this.packetStartUs > PACKET_TIMEOUT_US;
        if (this.nibblesSent >= 4 || expired) this._startPacket(nowUs);
        this.lines = (this.packet >> (12 - 4 * this.nibblesSent)) & 0x0F;
        this.nibblesSent++;
    }

    /** The six input lines (bit 5 trigger 2, bit 4 trigger 1, bits 3-0 data). */
    inputLines() {
        return (this.right ? 0 : 0x20) | (this.left ? 0 : 0x10) | this.lines;
    }
}

// -----------------------------------------------------------------------------
// OPN I/O ports and the joystick connectors
// -----------------------------------------------------------------------------

export class SoundChipPorts {
    constructor() {
        // Switches of a joystick on each connector, active low:
        // bit 0 up, 1 down, 2 left, 3 right, 4 trigger 1, 5 trigger 2.
        this.joystickSwitches = new Uint8Array([0xFF, 0xFF]);
        /** @type {(ConnectorMouse|null)[]} a mouse plugged into J1 / J2 */
        this.mice = [null, null];
        this.reset();
    }

    reset() {
        this.mixer = 0;       // register 7 (bit 7: port B output, bit 6: port A output)
        this.portBOut = 0;    // last value written to register 15
    }

    /**
     * Register 15 as read back: the written value when port B is an output
     * (register 7 bit 7), else pulled up. The connector lines use the
     * written value whatever bit 7 is (_connectorLines).
     */
    portBPins() {
        return (this.mixer & 0x80) ? this.portBOut : 0xFF;
    }

    /** Register write hook for registers 7, 14 and 15. */
    write(reg, val, nowUs = 0) {
        if (reg === 7) this.mixer = val;
        else if (reg === 15) this.portBOut = val;
        else if (reg !== 14) return;
        const pins = this.portBOut;
        this.mice.forEach((m, i) => {
            if (m) m.setStrobe((pins >> (4 + i)) & 1, nowUs);
        });
    }

    /** Lines of connector `i` as seen on port A, before the select switch. */
    _connectorLines(i) {
        const pins = this.portBOut;
        const triggerOut = (pins >> (2 * i)) & 0x03;      // trigger-equivalent outputs
        let lines;
        if (this.mice[i]) {
            lines = this.mice[i].inputLines();
        } else {
            // A pressed switch pulls its line to the connector's COM output.
            const com = (pins >> (4 + i)) & 1;
            const pressed = (~this.joystickSwitches[i]) & 0x3F;
            lines = com ? 0x3F : (0x3F & ~pressed);
        }
        // Open-collector trigger outputs share the trigger lines.
        return lines & (0x0F | (triggerOut << 4));
    }

    /**
     * Register 14 as read by the CPU: the lines of the selected connector,
     * whatever register 7 bit 6 is. Software that sets bit 6 still reads the
     * joystick here (register 7 also holds the tone and noise mix).
     */
    readPortA() {
        const select = (this.portBOut >> 6) & 1;      // 0: J1, 1: J2
        return 0xC0 | this._connectorLines(select);
    }
}
