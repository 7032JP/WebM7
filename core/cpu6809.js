// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// MC6809 CPU Simulator for FM-7 Web Simulator
// MC6809 instruction set simulator
// Complete, cycle-accurate 6809 instruction set
// =============================================================================

// Condition Code Register bit masks
const CC_C = 0x01; // Carry
const CC_V = 0x02; // Overflow
const CC_Z = 0x04; // Zero
const CC_N = 0x08; // Negative
const CC_I = 0x10; // IRQ mask
const CC_H = 0x20; // Half-carry
const CC_F = 0x40; // FIRQ mask
const CC_E = 0x80; // Entire flag

// Interrupt request flags
const INTR_NMI     = 0x01;  // NMI request
const INTR_FIRQ    = 0x02;  // FIRQ request
const INTR_IRQ     = 0x04;  // IRQ request
const INTR_NMI_ARMED = 0x08;  // NMI armed (set when S is loaded: LDS / LEAS / TFR,EXG with S as a destination)
const INTR_SYNC      = 0x10;  // SYNC wait state
const INTR_CWAI      = 0x20;  // CWAI wait state
const INTR_HALT    = 0x40;  // CPU halted

// TFR/EXG postbyte register code for S (see getRegValue / setRegValue)
const REG_S = 0x04;

// Interrupt vectors
const VEC_NMI  = 0xFFFC;
const VEC_FIRQ = 0xFFF6;
const VEC_IRQ  = 0xFFF8;
const VEC_SWI  = 0xFFFA;
const VEC_SWI2 = 0xFFF4;
const VEC_SWI3 = 0xFFF2;
const VEC_RST  = 0xFFFE;

// Cycle tables
// Page 1 opcodes ($00-$FF)
const CYCLES_PAGE1 = [
//  0   1   2   3   4   5   6   7   8   9   A   B   C   D   E   F
    6,  0,  0,  6,  6,  0,  6,  6,  6,  6,  6,  0,  6,  6,  3,  6, // 0x
    0,  0,  2,  4,  0,  0,  5,  9,  0,  2,  3,  0,  3,  2,  8,  6, // 1x
    3,  3,  3,  3,  3,  3,  3,  3,  3,  3,  3,  3,  3,  3,  3,  3, // 2x
    4,  4,  4,  4,  5,  5,  5,  5,  0,  5,  3,  6, 20, 11,  0, 19, // 3x
    2,  0,  0,  2,  2,  0,  2,  2,  2,  2,  2,  0,  2,  2,  0,  2, // 4x
    2,  0,  0,  2,  2,  0,  2,  2,  2,  2,  2,  0,  2,  2,  0,  2, // 5x
    6,  0,  0,  6,  6,  0,  6,  6,  6,  6,  6,  0,  6,  6,  3,  6, // 6x
    7,  0,  0,  7,  7,  0,  7,  7,  7,  7,  7,  0,  7,  7,  4,  7, // 7x
    2,  2,  2,  4,  2,  2,  2,  0,  2,  2,  2,  2,  4,  7,  3,  0, // 8x
    4,  4,  4,  6,  4,  4,  4,  4,  4,  4,  4,  4,  6,  7,  5,  5, // 9x
    4,  4,  4,  6,  4,  4,  4,  4,  4,  4,  4,  4,  6,  7,  5,  5, // Ax
    5,  5,  5,  7,  5,  5,  5,  5,  5,  5,  5,  5,  7,  8,  6,  6, // Bx
    2,  2,  2,  4,  2,  2,  2,  0,  2,  2,  2,  2,  3,  0,  3,  0, // Cx
    4,  4,  4,  6,  4,  4,  4,  4,  4,  4,  4,  4,  5,  5,  5,  5, // Dx
    4,  4,  4,  6,  4,  4,  4,  4,  4,  4,  4,  4,  5,  5,  5,  5, // Ex
    5,  5,  5,  7,  5,  5,  5,  5,  5,  5,  5,  5,  6,  6,  6,  6  // Fx
];

// Page 2 opcodes ($10xx) - only valid ones have non-zero cycles
const CYCLES_PAGE2 = [
//  0   1   2   3   4   5   6   7   8   9   A   B   C   D   E   F
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 0x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 1x
    0,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5,  5, // 2x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, 20, // 3x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 4x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 5x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 6x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 7x
    0,  0,  0,  5,  0,  0,  0,  0,  0,  0,  0,  0,  5,  0,  4,  0, // 8x
    0,  0,  0,  7,  0,  0,  0,  0,  0,  0,  0,  0,  7,  0,  6,  6, // 9x
    0,  0,  0,  7,  0,  0,  0,  0,  0,  0,  0,  0,  7,  0,  6,  6, // Ax
    0,  0,  0,  8,  0,  0,  0,  0,  0,  0,  0,  0,  8,  0,  7,  7, // Bx
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  4,  0, // Cx
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  6,  6, // Dx
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  6,  6, // Ex
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  7,  7  // Fx
];

// Page 3 opcodes ($11xx)
const CYCLES_PAGE3 = [
//  0   1   2   3   4   5   6   7   8   9   A   B   C   D   E   F
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 0x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 1x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 2x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, 20, // 3x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 4x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 5x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 6x
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // 7x
    0,  0,  0,  5,  0,  0,  0,  0,  0,  0,  0,  0,  5,  0,  0,  0, // 8x
    0,  0,  0,  7,  0,  0,  0,  0,  0,  0,  0,  0,  7,  0,  0,  0, // 9x
    0,  0,  0,  7,  0,  0,  0,  0,  0,  0,  0,  0,  7,  0,  0,  0, // Ax
    0,  0,  0,  8,  0,  0,  0,  0,  0,  0,  0,  0,  8,  0,  0,  0, // Bx
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // Cx
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // Dx
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, // Ex
    0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0  // Fx
];

// Extra cycles for indexed addressing modes
const INDEXED_CYCLES = [
//  Non-indirect  Indirect
    2, 3, 2, 3, 0, 1, 1, 0, 1, 4, 0, 4, 1, 5, 0, 0, // 0x00-0x0F
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5  // 0x10-0x1F
];

const INDEXED_CYCLES_INDIRECT = [
    0, 3, 0, 3, 0, 1, 1, 0, 1, 4, 0, 4, 1, 5, 0, 0,
    0, 6, 0, 6, 3, 4, 4, 0, 4, 7, 0, 7, 4, 8, 0, 5
];

export class CPU6809 {
    constructor() {
        // Registers
        this.a = 0;      // Accumulator A (8-bit)
        this.b = 0;      // Accumulator B (8-bit)
        this.x = 0;      // Index register X (16-bit)
        this.y = 0;      // Index register Y (16-bit)
        this.u = 0;      // User stack pointer (16-bit)
        this.s = 0;      // System stack pointer (16-bit)
        this.pc = 0;     // Program counter (16-bit)
        this.dp = 0;     // Direct page register (8-bit)
        this.cc = 0;     // Condition code register (8-bit)

        // Internal state
        this.intr = 0;   // Interrupt flags (16-bit)
        this.cycle = 0;  // Cycles for current instruction
        this.total = 0;  // Total cycles executed

        // Memory callbacks
        this._readMem = null;
        this._writeMem = null;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    setReadMem(fn) { this._readMem = fn; }
    setWriteMem(fn) { this._writeMem = fn; }

    reset() {
        this.a = 0;
        this.b = 0;
        this.x = 0;
        this.y = 0;
        this.u = 0;
        this.s = 0;
        this.dp = 0;
        this.cc = CC_I | CC_F;  // Interrupts masked on reset
        this.intr = 0;
        this.total = 0;
        this.cycle = 0;

        // Load PC from reset vector
        this.pc = this.read16(VEC_RST);
    }

    nmi() { this.intr |= INTR_NMI; }
    firq() { this.intr |= INTR_FIRQ; }
    irq() { this.intr |= INTR_IRQ; }
    halt(on) {
        if (on) this.intr |= INTR_HALT;
        else this.intr &= ~INTR_HALT;
    }

    // Execute one instruction, return cycles consumed
    exec() {
        // Check HALT
        if (this.intr & INTR_HALT) {
            this.cycle = 2;
            this.total += 2;
            return 2;
        }

        // Check interrupts
        if (this._checkInterrupts()) {
            const c = this.cycle;
            this.total += c;
            return c;
        }

        // Check SYNC state
        if (this.intr & INTR_SYNC) {
            this.cycle = 1;
            this.total += 1;
            return 1;
        }

        // Fetch and execute opcode
        this.cycle = 0;
        const opcode = this.fetchByte();

        if (opcode === 0x10) {
            this._execPage2();
        } else if (opcode === 0x11) {
            this._execPage3();
        } else {
            this._execPage1(opcode);
        }

        this.total += this.cycle;
        return this.cycle;
    }

    // =========================================================================
    // Memory access helpers
    // =========================================================================

    read(addr) {
        return this._readMem(addr & 0xFFFF) & 0xFF;
    }

    write(addr, val) {
        this._writeMem(addr & 0xFFFF, val & 0xFF);
    }

    read16(addr) {
        const hi = this.read(addr);
        const lo = this.read((addr + 1) & 0xFFFF);
        return (hi << 8) | lo;
    }

    write16(addr, val) {
        this.write(addr, (val >> 8) & 0xFF);
        this.write((addr + 1) & 0xFFFF, val & 0xFF);
    }

    fetchByte() {
        const val = this.read(this.pc);
        this.pc = (this.pc + 1) & 0xFFFF;
        return val;
    }

    fetchWord() {
        const val = this.read16(this.pc);
        this.pc = (this.pc + 2) & 0xFFFF;
        return val;
    }

    // Sign-extend 8-bit to 16-bit
    sign8(v) {
        return (v & 0x80) ? (v | 0xFF00) : v;
    }

    // Sign-extend 5-bit to 16-bit
    sign5(v) {
        return (v & 0x10) ? (v | 0xFFE0) : v;
    }

    // Get D register (A:B)
    get d() { return (this.a << 8) | this.b; }
    set d(val) {
        val &= 0xFFFF;
        this.a = (val >> 8) & 0xFF;
        this.b = val & 0xFF;
    }

    // =========================================================================
    // Stack operations
    // =========================================================================

    pushByteS(val) {
        this.s = (this.s - 1) & 0xFFFF;
        this.write(this.s, val);
    }

    pushWordS(val) {
        this.s = (this.s - 1) & 0xFFFF;
        this.write(this.s, val & 0xFF);
        this.s = (this.s - 1) & 0xFFFF;
        this.write(this.s, (val >> 8) & 0xFF);
    }

    pullByteS() {
        const val = this.read(this.s);
        this.s = (this.s + 1) & 0xFFFF;
        return val;
    }

    pullWordS() {
        const hi = this.read(this.s);
        this.s = (this.s + 1) & 0xFFFF;
        const lo = this.read(this.s);
        this.s = (this.s + 1) & 0xFFFF;
        return (hi << 8) | lo;
    }

    pushByteU(val) {
        this.u = (this.u - 1) & 0xFFFF;
        this.write(this.u, val);
    }

    pushWordU(val) {
        this.u = (this.u - 1) & 0xFFFF;
        this.write(this.u, val & 0xFF);
        this.u = (this.u - 1) & 0xFFFF;
        this.write(this.u, (val >> 8) & 0xFF);
    }

    pullByteU() {
        const val = this.read(this.u);
        this.u = (this.u + 1) & 0xFFFF;
        return val;
    }

    pullWordU() {
        const hi = this.read(this.u);
        this.u = (this.u + 1) & 0xFFFF;
        const lo = this.read(this.u);
        this.u = (this.u + 1) & 0xFFFF;
        return (hi << 8) | lo;
    }

    // Push all registers to S stack (for interrupts/CWAI)
    pushAllS() {
        this.pushWordS(this.pc);
        this.pushWordS(this.u);
        this.pushWordS(this.y);
        this.pushWordS(this.x);
        this.pushByteS(this.dp);
        this.pushByteS(this.b);
        this.pushByteS(this.a);
        this.pushByteS(this.cc);
    }

    // Pull all registers from S stack
    pullAllS() {
        this.cc = this.pullByteS();
        this.a = this.pullByteS();
        this.b = this.pullByteS();
        this.dp = this.pullByteS();
        this.x = this.pullWordS();
        this.y = this.pullWordS();
        this.u = this.pullWordS();
        this.pc = this.pullWordS();
    }

    // =========================================================================
    // Interrupt handling
    // =========================================================================

    _checkInterrupts() {
        // NMI - highest priority, only once NMI is armed (S has been loaded)
        if ((this.intr & INTR_NMI) && (this.intr & INTR_NMI_ARMED)) {
            this.intr &= ~INTR_NMI;

            if (this.intr & INTR_CWAI) {
                // CWAI already pushed regs
                this.intr &= ~INTR_CWAI;
                this.cc |= CC_E;
                this.cycle = 7;
            } else if (this.intr & INTR_SYNC) {
                this.intr &= ~INTR_SYNC;
                this.cc |= CC_E;
                this.pushAllS();
                this.cycle = 19;
            } else {
                this.cc |= CC_E;
                this.pushAllS();
                this.cycle = 19;
            }
            this.cc |= CC_I | CC_F;
            this.pc = this.read16(VEC_NMI);
            return true;
        }

        // FIRQ
        if ((this.intr & INTR_FIRQ) && !(this.cc & CC_F)) {
            this.intr &= ~INTR_FIRQ;

            if (this.intr & INTR_CWAI) {
                this.intr &= ~INTR_CWAI;
                this.cc |= CC_E;  // CWAI already set E and pushed all
                this.cycle = 7;
            } else if (this.intr & INTR_SYNC) {
                this.intr &= ~INTR_SYNC;
                this.cc &= ~CC_E;
                this.pushWordS(this.pc);  // Push PC first (higher address)
                this.pushByteS(this.cc);  // Push CC second (top of stack)
                this.cycle = 10;
            } else {
                this.cc &= ~CC_E;
                this.pushWordS(this.pc);
                this.pushByteS(this.cc);
                this.cycle = 10;
            }
            this.cc |= CC_I | CC_F;
            this.pc = this.read16(VEC_FIRQ);
            return true;
        }

        // IRQ
        if ((this.intr & INTR_IRQ) && !(this.cc & CC_I)) {
            this.intr &= ~INTR_IRQ;

            if (this.intr & INTR_CWAI) {
                this.intr &= ~INTR_CWAI;
                this.cc |= CC_E;
                this.cycle = 7;
            } else if (this.intr & INTR_SYNC) {
                this.intr &= ~INTR_SYNC;
                this.cc |= CC_E;
                this.pushAllS();
                this.cycle = 19;
            } else {
                this.cc |= CC_E;
                this.pushAllS();
                this.cycle = 19;
            }
            this.cc |= CC_I;
            this.pc = this.read16(VEC_IRQ);
            return true;
        }

        // SYNC with no pending interrupt just waits
        // CWAI with no pending interrupt just waits
        if (this.intr & INTR_SYNC) {
            // Check if any interrupt is pending (even masked ones break SYNC)
            if (this.intr & (INTR_NMI | INTR_FIRQ | INTR_IRQ)) {
                this.intr &= ~INTR_SYNC;
                // If the interrupt is masked, just continue execution
                // The interrupt service itself will be handled next exec()
            }
        }

        return false;
    }

    // =========================================================================
    // Addressing modes
    // =========================================================================

    // Direct addressing: DP:imm8
    addrDirect() {
        return ((this.dp << 8) | this.fetchByte()) & 0xFFFF;
    }

    // Extended addressing: imm16
    addrExtended() {
        return this.fetchWord();
    }

    // Indexed addressing with postbyte
    addrIndexed() {
        const postbyte = this.fetchByte();
        let addr = 0;
        let reg;

        // Get the register
        const regCode = (postbyte >> 5) & 0x03;
        switch (regCode) {
            case 0: reg = this.x; break;
            case 1: reg = this.y; break;
            case 2: reg = this.u; break;
            case 3: reg = this.s; break;
        }

        if (!(postbyte & 0x80)) {
            // 5-bit signed offset
            const offset = this.sign5(postbyte & 0x1F);
            addr = (reg + offset) & 0xFFFF;
            this.cycle += 1;
            return addr;
        }

        const mode = postbyte & 0x1F;
        const indirect = postbyte & 0x10;

        switch (mode & 0x0F) {
            case 0x00: // ,R+
                addr = reg;
                reg = (reg + 1) & 0xFFFF;
                this.cycle += 2;
                break;
            case 0x01: // ,R++
                addr = reg;
                reg = (reg + 2) & 0xFFFF;
                this.cycle += indirect ? 6 : 3;
                break;
            case 0x02: // ,-R
                reg = (reg - 1) & 0xFFFF;
                addr = reg;
                this.cycle += 2;
                break;
            case 0x03: // ,--R
                reg = (reg - 2) & 0xFFFF;
                addr = reg;
                this.cycle += indirect ? 6 : 3;
                break;
            case 0x04: // ,R (no offset)
                addr = reg;
                this.cycle += indirect ? 3 : 0;
                break;
            case 0x05: // B,R
                addr = (reg + this.sign8(this.b)) & 0xFFFF;
                this.cycle += indirect ? 4 : 1;
                break;
            case 0x06: // A,R
                addr = (reg + this.sign8(this.a)) & 0xFFFF;
                this.cycle += indirect ? 4 : 1;
                break;
            case 0x08: // 8-bit offset,R
                addr = (reg + this.sign8(this.fetchByte())) & 0xFFFF;
                this.cycle += indirect ? 4 : 1;
                break;
            case 0x09: // 16-bit offset,R
                addr = (reg + this.sign16(this.fetchWord())) & 0xFFFF;
                this.cycle += indirect ? 7 : 4;
                break;
            case 0x0B: // D,R
                addr = (reg + this.sign16(this.d)) & 0xFFFF;
                this.cycle += indirect ? 7 : 4;
                break;
            case 0x0C: // 8-bit offset,PC
                {
                    const off = this.sign8(this.fetchByte());
                    addr = (this.pc + off) & 0xFFFF;
                    this.cycle += indirect ? 4 : 1;
                }
                break;
            case 0x0D: // 16-bit offset,PC
                {
                    const off = this.sign16(this.fetchWord());
                    addr = (this.pc + off) & 0xFFFF;
                    this.cycle += indirect ? 8 : 5;
                }
                break;
            case 0x0F: // Extended indirect [addr16]
                // Only valid with indirect flag (postbyte $1F = [nn]).
                // Non-indirect $0F is undefined on 6809 — do NOT fetch address.
                // このアドレス指定はレジスタからの変位を 0 として扱う。
                if (indirect) {
                    addr = this.fetchWord();
                    this.cycle += 5;
                } else {
                    addr = reg;
                    this.cycle += 1;
                }
                break;
            default:
                // Undefined - treat as ,R
                addr = reg;
                break;
        }

        // Write back modified register (for auto inc/dec)
        switch (regCode) {
            case 0: this.x = reg; break;
            case 1: this.y = reg; break;
            case 2: this.u = reg; break;
            case 3: this.s = reg; break;
        }

        // Indirect: dereference
        if (indirect) {
            addr = this.read16(addr);
        }

        return addr & 0xFFFF;
    }

    sign16(v) {
        v &= 0xFFFF;
        return (v & 0x8000) ? (v - 0x10000) : v;
    }

    // =========================================================================
    // Flag helpers
    // =========================================================================

    // Set N and Z flags for 8-bit result
    flagsNZ8(val) {
        val &= 0xFF;
        this.cc &= ~(CC_N | CC_Z);
        if (val & 0x80) this.cc |= CC_N;
        if (val === 0) this.cc |= CC_Z;
        return val;
    }

    // Set N and Z flags for 16-bit result
    flagsNZ16(val) {
        val &= 0xFFFF;
        this.cc &= ~(CC_N | CC_Z);
        if (val & 0x8000) this.cc |= CC_N;
        if (val === 0) this.cc |= CC_Z;
        return val;
    }

    // =========================================================================
    // ALU operations (8-bit)
    // =========================================================================

    // ADD 8-bit: reg + val
    opADD8(reg, val) {
        val &= 0xFF;
        const result = reg + val;
        this.cc &= ~(CC_H | CC_N | CC_Z | CC_V | CC_C);
        if ((reg ^ val ^ result) & 0x10) this.cc |= CC_H;
        if (result & 0x80) this.cc |= CC_N;
        if ((result & 0xFF) === 0) this.cc |= CC_Z;
        if ((reg ^ result) & (val ^ result) & 0x80) this.cc |= CC_V;
        if (result & 0x100) this.cc |= CC_C;
        return result & 0xFF;
    }

    // ADC 8-bit: reg + val + carry
    opADC8(reg, val) {
        val &= 0xFF;
        const c = (this.cc & CC_C) ? 1 : 0;
        const result = reg + val + c;
        this.cc &= ~(CC_H | CC_N | CC_Z | CC_V | CC_C);
        if ((reg ^ val ^ result) & 0x10) this.cc |= CC_H;
        if (result & 0x80) this.cc |= CC_N;
        if ((result & 0xFF) === 0) this.cc |= CC_Z;
        if ((reg ^ result) & (val ^ result) & 0x80) this.cc |= CC_V;
        if (result & 0x100) this.cc |= CC_C;
        return result & 0xFF;
    }

    // SUB 8-bit: reg - val
    opSUB8(reg, val) {
        val &= 0xFF;
        const result = reg - val;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (result & 0x80) this.cc |= CC_N;
        if ((result & 0xFF) === 0) this.cc |= CC_Z;
        if ((reg ^ val) & (reg ^ result) & 0x80) this.cc |= CC_V;
        if (result & 0x100) this.cc |= CC_C;
        return result & 0xFF;
    }

    // SBC 8-bit: reg - val - carry
    opSBC8(reg, val) {
        val &= 0xFF;
        const c = (this.cc & CC_C) ? 1 : 0;
        const result = reg - val - c;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (result & 0x80) this.cc |= CC_N;
        if ((result & 0xFF) === 0) this.cc |= CC_Z;
        if ((reg ^ val) & (reg ^ result) & 0x80) this.cc |= CC_V;
        if (result & 0x100) this.cc |= CC_C;
        return result & 0xFF;
    }

    // CMP 8-bit (same as SUB but discard result)
    opCMP8(reg, val) {
        this.opSUB8(reg, val);
    }

    // AND 8-bit
    opAND8(reg, val) {
        const result = (reg & val) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        return result;
    }

    // OR 8-bit
    opOR8(reg, val) {
        const result = (reg | val) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        return result;
    }

    // EOR 8-bit
    opEOR8(reg, val) {
        const result = (reg ^ val) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        return result;
    }

    // BIT (AND without storing result)
    opBIT8(reg, val) {
        this.opAND8(reg, val);
    }

    // LD 8-bit
    opLD8(val) {
        val &= 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (val & 0x80) this.cc |= CC_N;
        if (val === 0) this.cc |= CC_Z;
        return val;
    }

    // ST 8-bit (set flags for stored value)
    opST8(val) {
        val &= 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (val & 0x80) this.cc |= CC_N;
        if (val === 0) this.cc |= CC_Z;
        return val;
    }

    // NEG 8-bit
    opNEG8(val) {
        const result = (-val) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        if (val === 0x80) this.cc |= CC_V;
        if (result !== 0) this.cc |= CC_C;
        return result;
    }

    // COM 8-bit
    opCOM8(val) {
        const result = (~val) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        this.cc |= CC_C;
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        return result;
    }

    // LSR 8-bit (logical shift right)
    opLSR8(val) {
        this.cc &= ~(CC_N | CC_Z | CC_C);
        if (val & 0x01) this.cc |= CC_C;
        const result = (val >> 1) & 0xFF;
        if (result === 0) this.cc |= CC_Z;
        // N is always cleared for LSR
        return result;
    }

    // ROR 8-bit (rotate right through carry)
    opROR8(val) {
        const oldC = (this.cc & CC_C) ? 0x80 : 0;
        this.cc &= ~(CC_N | CC_Z | CC_C);
        if (val & 0x01) this.cc |= CC_C;
        const result = ((val >> 1) | oldC) & 0xFF;
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        return result;
    }

    // ASR 8-bit (arithmetic shift right)
    opASR8(val) {
        this.cc &= ~(CC_N | CC_Z | CC_C);
        if (val & 0x01) this.cc |= CC_C;
        const result = ((val >> 1) | (val & 0x80)) & 0xFF;
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        return result;
    }

    // ASL/LSL 8-bit (arithmetic/logical shift left)
    opASL8(val) {
        const result = (val << 1) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (val & 0x80) this.cc |= CC_C;
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        if ((val ^ result) & 0x80) this.cc |= CC_V;
        return result;
    }

    // ROL 8-bit (rotate left through carry)
    opROL8(val) {
        const oldC = (this.cc & CC_C) ? 1 : 0;
        const result = ((val << 1) | oldC) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (val & 0x80) this.cc |= CC_C;
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        if ((val ^ result) & 0x80) this.cc |= CC_V;
        return result;
    }

    // DEC 8-bit
    opDEC8(val) {
        const result = (val - 1) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        if (val === 0x80) this.cc |= CC_V;
        return result;
    }

    // INC 8-bit
    opINC8(val) {
        const result = (val + 1) & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (result & 0x80) this.cc |= CC_N;
        if (result === 0) this.cc |= CC_Z;
        if (val === 0x7F) this.cc |= CC_V;
        return result;
    }

    // TST 8-bit
    opTST8(val) {
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (val & 0x80) this.cc |= CC_N;
        if ((val & 0xFF) === 0) this.cc |= CC_Z;
    }

    // CLR 8-bit
    opCLR8() {
        this.cc &= ~(CC_N | CC_V | CC_C);
        this.cc |= CC_Z;
        return 0;
    }

    // DAA - Decimal Adjust Accumulator
    opDAA() {
        let msn = this.a & 0xF0;
        let lsn = this.a & 0x0F;
        let cf = 0;

        if (lsn > 0x09 || (this.cc & CC_H)) cf |= 0x06;
        if (msn > 0x80 && lsn > 0x09) cf |= 0x60;
        if (msn > 0x90 || (this.cc & CC_C)) cf |= 0x60;

        const result = this.a + cf;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (result & 0x100) this.cc |= CC_C;
        this.a = result & 0xFF;
        if (this.a & 0x80) this.cc |= CC_N;
        if (this.a === 0) this.cc |= CC_Z;
    }

    // MUL - A * B -> D (unsigned)
    opMUL() {
        const result = this.a * this.b;
        this.d = result & 0xFFFF;
        this.cc &= ~(CC_Z | CC_C);
        if (result === 0) this.cc |= CC_Z;
        if (this.b & 0x80) this.cc |= CC_C; // bit 7 of LSB
        return result;
    }

    // =========================================================================
    // ALU operations (16-bit)
    // =========================================================================

    opADD16(reg, val) {
        val &= 0xFFFF;
        const result = reg + val;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (result & 0x8000) this.cc |= CC_N;
        if ((result & 0xFFFF) === 0) this.cc |= CC_Z;
        if ((reg ^ result) & (val ^ result) & 0x8000) this.cc |= CC_V;
        if (result & 0x10000) this.cc |= CC_C;
        return result & 0xFFFF;
    }

    opSUB16(reg, val) {
        val &= 0xFFFF;
        const result = reg - val;
        this.cc &= ~(CC_N | CC_Z | CC_V | CC_C);
        if (result & 0x8000) this.cc |= CC_N;
        if ((result & 0xFFFF) === 0) this.cc |= CC_Z;
        if ((reg ^ val) & (reg ^ result) & 0x8000) this.cc |= CC_V;
        if (result & 0x10000) this.cc |= CC_C;
        return result & 0xFFFF;
    }

    opCMP16(reg, val) {
        this.opSUB16(reg, val);
    }

    opLD16(val) {
        val &= 0xFFFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (val & 0x8000) this.cc |= CC_N;
        if (val === 0) this.cc |= CC_Z;
        return val;
    }

    opST16(val) {
        val &= 0xFFFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (val & 0x8000) this.cc |= CC_N;
        if (val === 0) this.cc |= CC_Z;
        return val;
    }

    // =========================================================================
    // Branch helpers
    // =========================================================================

    branchShort(cond) {
        const offset = this.sign8(this.fetchByte());
        if (cond) {
            this.pc = (this.pc + offset) & 0xFFFF;
        }
    }

    branchLong(cond) {
        const offset = this.sign16(this.fetchWord());
        if (cond) {
            this.pc = (this.pc + offset) & 0xFFFF;
            this.cycle += 1; // Extra cycle when branch taken
        }
    }

    // =========================================================================
    // TFR/EXG register mapping
    // =========================================================================

    getRegValue(code) {
        switch (code & 0x0F) {
            case 0x00: return this.d;
            case 0x01: return this.x;
            case 0x02: return this.y;
            case 0x03: return this.u;
            case 0x04: return this.s;
            case 0x05: return this.pc;
            case 0x08: return this.a;
            case 0x09: return this.b;
            case 0x0A: return this.cc;
            case 0x0B: return this.dp;
            default: return 0;
        }
    }

    setRegValue(code, val) {
        switch (code & 0x0F) {
            case 0x00: this.d = val & 0xFFFF; break;
            case 0x01: this.x = val & 0xFFFF; break;
            case 0x02: this.y = val & 0xFFFF; break;
            case 0x03: this.u = val & 0xFFFF; break;
            case 0x04: this.s = val & 0xFFFF; break;
            case 0x05: this.pc = val & 0xFFFF; break;
            case 0x08: this.a = val & 0xFF; break;
            case 0x09: this.b = val & 0xFF; break;
            case 0x0A: this.cc = val & 0xFF; break;
            case 0x0B: this.dp = val & 0xFF; break;
        }
    }

    // Check if TFR/EXG register code is 8-bit
    isReg8(code) {
        return (code & 0x08) !== 0;
    }

    // =========================================================================
    // PSHS/PULS/PSHU/PULU
    // =========================================================================

    opPSHS() {
        const postbyte = this.fetchByte();
        // Push order: PC, U/S, Y, X, DP, B, A, CC (high bit first)
        if (postbyte & 0x80) { this.pushWordS(this.pc); this.cycle += 2; }
        if (postbyte & 0x40) { this.pushWordS(this.u);  this.cycle += 2; }
        if (postbyte & 0x20) { this.pushWordS(this.y);  this.cycle += 2; }
        if (postbyte & 0x10) { this.pushWordS(this.x);  this.cycle += 2; }
        if (postbyte & 0x08) { this.pushByteS(this.dp); this.cycle += 1; }
        if (postbyte & 0x04) { this.pushByteS(this.b);  this.cycle += 1; }
        if (postbyte & 0x02) { this.pushByteS(this.a);  this.cycle += 1; }
        if (postbyte & 0x01) { this.pushByteS(this.cc); this.cycle += 1; }
    }

    opPULS() {
        const postbyte = this.fetchByte();
        // Pull order: CC, A, B, DP, X, Y, U/S, PC (low bit first)
        if (postbyte & 0x01) { this.cc = this.pullByteS(); this.cycle += 1; }
        if (postbyte & 0x02) { this.a  = this.pullByteS(); this.cycle += 1; }
        if (postbyte & 0x04) { this.b  = this.pullByteS(); this.cycle += 1; }
        if (postbyte & 0x08) { this.dp = this.pullByteS(); this.cycle += 1; }
        if (postbyte & 0x10) { this.x  = this.pullWordS(); this.cycle += 2; }
        if (postbyte & 0x20) { this.y  = this.pullWordS(); this.cycle += 2; }
        if (postbyte & 0x40) { this.u  = this.pullWordS(); this.cycle += 2; }
        if (postbyte & 0x80) { this.pc = this.pullWordS(); this.cycle += 2; }
    }

    opPSHU() {
        const postbyte = this.fetchByte();
        if (postbyte & 0x80) { this.pushWordU(this.pc); this.cycle += 2; }
        if (postbyte & 0x40) { this.pushWordU(this.s);  this.cycle += 2; }
        if (postbyte & 0x20) { this.pushWordU(this.y);  this.cycle += 2; }
        if (postbyte & 0x10) { this.pushWordU(this.x);  this.cycle += 2; }
        if (postbyte & 0x08) { this.pushByteU(this.dp); this.cycle += 1; }
        if (postbyte & 0x04) { this.pushByteU(this.b);  this.cycle += 1; }
        if (postbyte & 0x02) { this.pushByteU(this.a);  this.cycle += 1; }
        if (postbyte & 0x01) { this.pushByteU(this.cc); this.cycle += 1; }
    }

    opPULU() {
        const postbyte = this.fetchByte();
        if (postbyte & 0x01) { this.cc = this.pullByteU(); this.cycle += 1; }
        if (postbyte & 0x02) { this.a  = this.pullByteU(); this.cycle += 1; }
        if (postbyte & 0x04) { this.b  = this.pullByteU(); this.cycle += 1; }
        if (postbyte & 0x08) { this.dp = this.pullByteU(); this.cycle += 1; }
        if (postbyte & 0x10) { this.x  = this.pullWordU(); this.cycle += 2; }
        if (postbyte & 0x20) { this.y  = this.pullWordU(); this.cycle += 2; }
        if (postbyte & 0x40) { this.s  = this.pullWordU(); this.cycle += 2; }
        if (postbyte & 0x80) { this.pc = this.pullWordU(); this.cycle += 2; }
    }

    // =========================================================================
    // Page 1 instruction dispatch ($00-$FF)
    // =========================================================================

    _execPage1(opcode) {
        this.cycle = CYCLES_PAGE1[opcode];

        switch (opcode) {
            // -----------------------------------------------------------------
            // $00-$0F: Direct addressing ALU (memory)
            // -----------------------------------------------------------------
            case 0x00: { // NEG direct
                const addr = this.addrDirect();
                this.write(addr, this.opNEG8(this.read(addr)));
                break;
            }
            case 0x03: { // COM direct
                const addr = this.addrDirect();
                this.write(addr, this.opCOM8(this.read(addr)));
                break;
            }
            case 0x04: { // LSR direct
                const addr = this.addrDirect();
                this.write(addr, this.opLSR8(this.read(addr)));
                break;
            }
            case 0x06: { // ROR direct
                const addr = this.addrDirect();
                this.write(addr, this.opROR8(this.read(addr)));
                break;
            }
            case 0x07: { // ASR direct
                const addr = this.addrDirect();
                this.write(addr, this.opASR8(this.read(addr)));
                break;
            }
            case 0x08: { // ASL/LSL direct
                const addr = this.addrDirect();
                this.write(addr, this.opASL8(this.read(addr)));
                break;
            }
            case 0x09: { // ROL direct
                const addr = this.addrDirect();
                this.write(addr, this.opROL8(this.read(addr)));
                break;
            }
            case 0x0A: { // DEC direct
                const addr = this.addrDirect();
                this.write(addr, this.opDEC8(this.read(addr)));
                break;
            }
            case 0x0C: { // INC direct
                const addr = this.addrDirect();
                this.write(addr, this.opINC8(this.read(addr)));
                break;
            }
            case 0x0D: { // TST direct
                const addr = this.addrDirect();
                this.opTST8(this.read(addr));
                break;
            }
            case 0x0E: { // JMP direct
                this.pc = this.addrDirect();
                break;
            }
            case 0x0F: { // CLR direct
                const addr = this.addrDirect();
                this.write(addr, this.opCLR8());
                break;
            }

            // -----------------------------------------------------------------
            // $10, $11 handled externally (page prefix)
            // -----------------------------------------------------------------

            // -----------------------------------------------------------------
            // $12-$1F: Inherent / Misc
            // -----------------------------------------------------------------
            case 0x12: { // NOP
                break;
            }
            case 0x13: { // SYNC
                this.intr |= INTR_SYNC;
                break;
            }
            case 0x16: { // LBRA (long branch always)
                const offset = this.sign16(this.fetchWord());
                this.pc = (this.pc + offset) & 0xFFFF;
                break;
            }
            case 0x17: { // LBSR (long branch to subroutine)
                const offset = this.sign16(this.fetchWord());
                this.pushWordS(this.pc);
                this.pc = (this.pc + offset) & 0xFFFF;
                break;
            }
            case 0x19: { // DAA
                this.opDAA();
                break;
            }
            case 0x1A: { // ORCC immediate
                this.cc |= this.fetchByte();
                break;
            }
            case 0x1C: { // ANDCC immediate
                this.cc &= this.fetchByte();
                break;
            }
            case 0x1D: { // SEX (sign extend B -> A:B)
                if (this.b & 0x80) {
                    this.a = 0xFF;
                } else {
                    this.a = 0x00;
                }
                this.cc &= ~(CC_N | CC_Z);
                if (this.a & 0x80) this.cc |= CC_N;
                if (this.d === 0) this.cc |= CC_Z;
                break;
            }
            case 0x1E: { // EXG
                const postbyte = this.fetchByte();
                const r1 = (postbyte >> 4) & 0x0F;
                const r2 = postbyte & 0x0F;
                const v1 = this.getRegValue(r1);
                const v2 = this.getRegValue(r2);
                // If mixing 8/16 bit, 8-bit value goes to low byte, high byte = 0xFF
                if (this.isReg8(r1) && !this.isReg8(r2)) {
                    this.setRegValue(r1, v2 & 0xFF);
                    this.setRegValue(r2, (0xFF00 | v1));
                } else if (!this.isReg8(r1) && this.isReg8(r2)) {
                    this.setRegValue(r1, (0xFF00 | v2));
                    this.setRegValue(r2, v1 & 0xFF);
                } else {
                    this.setRegValue(r1, v2);
                    this.setRegValue(r2, v1);
                }
                // Writing S (either side of the exchange) counts as setting the stack pointer,
                // which enables NMI after reset just like LDS / LEAS.
                if (r1 === REG_S || r2 === REG_S) this.intr |= INTR_NMI_ARMED;
                break;
            }
            case 0x1F: { // TFR
                const postbyte = this.fetchByte();
                const r1 = (postbyte >> 4) & 0x0F;
                const r2 = postbyte & 0x0F;
                let val = this.getRegValue(r1);
                if (this.isReg8(r1) && !this.isReg8(r2)) {
                    val = 0xFF00 | val;
                } else if (!this.isReg8(r1) && this.isReg8(r2)) {
                    val = val & 0xFF;
                }
                this.setRegValue(r2, val);
                // Transferring into S counts as setting the stack pointer,
                // which enables NMI after reset just like LDS / LEAS.
                if (r2 === REG_S) this.intr |= INTR_NMI_ARMED;
                break;
            }

            // -----------------------------------------------------------------
            // $20-$2F: Short branches (relative 8-bit)
            // -----------------------------------------------------------------
            case 0x20: // BRA
                this.branchShort(true);
                break;
            case 0x21: // BRN
                this.branchShort(false);
                break;
            case 0x22: // BHI (C=0 and Z=0)
                this.branchShort(!(this.cc & (CC_C | CC_Z)));
                break;
            case 0x23: // BLS (C=1 or Z=1)
                this.branchShort(!!(this.cc & (CC_C | CC_Z)));
                break;
            case 0x24: // BCC/BHS (C=0)
                this.branchShort(!(this.cc & CC_C));
                break;
            case 0x25: // BCS/BLO (C=1)
                this.branchShort(!!(this.cc & CC_C));
                break;
            case 0x26: // BNE (Z=0)
                this.branchShort(!(this.cc & CC_Z));
                break;
            case 0x27: // BEQ (Z=1)
                this.branchShort(!!(this.cc & CC_Z));
                break;
            case 0x28: // BVC (V=0)
                this.branchShort(!(this.cc & CC_V));
                break;
            case 0x29: // BVS (V=1)
                this.branchShort(!!(this.cc & CC_V));
                break;
            case 0x2A: // BPL (N=0)
                this.branchShort(!(this.cc & CC_N));
                break;
            case 0x2B: // BMI (N=1)
                this.branchShort(!!(this.cc & CC_N));
                break;
            case 0x2C: // BGE (N^V=0)
                this.branchShort(!((this.cc & CC_N) ? 1 : 0) === !((this.cc & CC_V) ? 1 : 0));
                break;
            case 0x2D: // BLT (N^V=1)
                this.branchShort(((this.cc & CC_N) ? 1 : 0) !== ((this.cc & CC_V) ? 1 : 0));
                break;
            case 0x2E: // BGT (Z=0 and N^V=0)
                this.branchShort(!(this.cc & CC_Z) &&
                    (((this.cc & CC_N) ? 1 : 0) === ((this.cc & CC_V) ? 1 : 0)));
                break;
            case 0x2F: // BLE (Z=1 or N^V=1)
                this.branchShort(!!(this.cc & CC_Z) ||
                    (((this.cc & CC_N) ? 1 : 0) !== ((this.cc & CC_V) ? 1 : 0)));
                break;

            // -----------------------------------------------------------------
            // $30-$3F: Misc
            // -----------------------------------------------------------------
            case 0x30: { // LEAX indexed
                this.x = this.addrIndexed();
                this.cc &= ~CC_Z;
                if (this.x === 0) this.cc |= CC_Z;
                break;
            }
            case 0x31: { // LEAY indexed
                this.y = this.addrIndexed();
                this.cc &= ~CC_Z;
                if (this.y === 0) this.cc |= CC_Z;
                break;
            }
            case 0x32: { // LEAS indexed
                this.s = this.addrIndexed();
                this.intr |= INTR_NMI_ARMED;
                break;
            }
            case 0x33: { // LEAU indexed
                this.u = this.addrIndexed();
                break;
            }
            case 0x34: { // PSHS
                this.opPSHS();
                break;
            }
            case 0x35: { // PULS
                this.opPULS();
                break;
            }
            case 0x36: { // PSHU
                this.opPSHU();
                break;
            }
            case 0x37: { // PULU
                this.opPULU();
                break;
            }
            case 0x39: { // RTS
                this.pc = this.pullWordS();
                break;
            }
            case 0x3A: { // ABX (X = X + unsigned B)
                this.x = (this.x + this.b) & 0xFFFF;
                break;
            }
            case 0x3B: { // RTI
                this.cc = this.pullByteS();
                if (this.cc & CC_E) {
                    // Entire state was saved
                    this.a = this.pullByteS();
                    this.b = this.pullByteS();
                    this.dp = this.pullByteS();
                    this.x = this.pullWordS();
                    this.y = this.pullWordS();
                    this.u = this.pullWordS();
                    this.cycle = 15;
                }
                this.pc = this.pullWordS();
                break;
            }
            case 0x3C: { // CWAI
                const imm = this.fetchByte();
                this.cc &= imm;
                this.cc |= CC_E;
                this.pushAllS();
                this.intr |= INTR_CWAI;
                break;
            }
            case 0x3D: { // MUL
                this.opMUL();
                break;
            }
            case 0x3F: { // SWI
                this.cc |= CC_E;
                this.pushAllS();
                this.cc |= CC_I | CC_F;
                this.pc = this.read16(VEC_SWI);
                break;
            }

            // -----------------------------------------------------------------
            // $40-$4F: Inherent A register
            // -----------------------------------------------------------------
            case 0x40: this.a = this.opNEG8(this.a); break;     // NEGA
            case 0x43: this.a = this.opCOM8(this.a); break;     // COMA
            case 0x44: this.a = this.opLSR8(this.a); break;     // LSRA
            case 0x46: this.a = this.opROR8(this.a); break;     // RORA
            case 0x47: this.a = this.opASR8(this.a); break;     // ASRA
            case 0x48: this.a = this.opASL8(this.a); break;     // ASLA/LSLA
            case 0x49: this.a = this.opROL8(this.a); break;     // ROLA
            case 0x4A: this.a = this.opDEC8(this.a); break;     // DECA
            case 0x4C: this.a = this.opINC8(this.a); break;     // INCA
            case 0x4D: this.opTST8(this.a); break;              // TSTA
            case 0x4F: this.a = this.opCLR8(); break;            // CLRA

            // -----------------------------------------------------------------
            // $50-$5F: Inherent B register
            // -----------------------------------------------------------------
            case 0x50: this.b = this.opNEG8(this.b); break;     // NEGB
            case 0x53: this.b = this.opCOM8(this.b); break;     // COMB
            case 0x54: this.b = this.opLSR8(this.b); break;     // LSRB
            case 0x56: this.b = this.opROR8(this.b); break;     // RORB
            case 0x57: this.b = this.opASR8(this.b); break;     // ASRB
            case 0x58: this.b = this.opASL8(this.b); break;     // ASLB/LSLB
            case 0x59: this.b = this.opROL8(this.b); break;     // ROLB
            case 0x5A: this.b = this.opDEC8(this.b); break;     // DECB
            case 0x5C: this.b = this.opINC8(this.b); break;     // INCB
            case 0x5D: this.opTST8(this.b); break;              // TSTB
            case 0x5F: this.b = this.opCLR8(); break;            // CLRB

            // -----------------------------------------------------------------
            // $60-$6F: Indexed addressing ALU (memory)
            // -----------------------------------------------------------------
            case 0x60: { // NEG indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opNEG8(this.read(addr)));
                break;
            }
            case 0x63: { // COM indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opCOM8(this.read(addr)));
                break;
            }
            case 0x64: { // LSR indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opLSR8(this.read(addr)));
                break;
            }
            case 0x66: { // ROR indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opROR8(this.read(addr)));
                break;
            }
            case 0x67: { // ASR indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opASR8(this.read(addr)));
                break;
            }
            case 0x68: { // ASL/LSL indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opASL8(this.read(addr)));
                break;
            }
            case 0x69: { // ROL indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opROL8(this.read(addr)));
                break;
            }
            case 0x6A: { // DEC indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opDEC8(this.read(addr)));
                break;
            }
            case 0x6C: { // INC indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opINC8(this.read(addr)));
                break;
            }
            case 0x6D: { // TST indexed
                const addr = this.addrIndexed();
                this.opTST8(this.read(addr));
                break;
            }
            case 0x6E: { // JMP indexed
                this.pc = this.addrIndexed();
                break;
            }
            case 0x6F: { // CLR indexed
                const addr = this.addrIndexed();
                this.write(addr, this.opCLR8());
                break;
            }

            // -----------------------------------------------------------------
            // $70-$7F: Extended addressing ALU (memory)
            // -----------------------------------------------------------------
            case 0x70: { // NEG extended
                const addr = this.addrExtended();
                this.write(addr, this.opNEG8(this.read(addr)));
                break;
            }
            case 0x73: { // COM extended
                const addr = this.addrExtended();
                this.write(addr, this.opCOM8(this.read(addr)));
                break;
            }
            case 0x74: { // LSR extended
                const addr = this.addrExtended();
                this.write(addr, this.opLSR8(this.read(addr)));
                break;
            }
            case 0x76: { // ROR extended
                const addr = this.addrExtended();
                this.write(addr, this.opROR8(this.read(addr)));
                break;
            }
            case 0x77: { // ASR extended
                const addr = this.addrExtended();
                this.write(addr, this.opASR8(this.read(addr)));
                break;
            }
            case 0x78: { // ASL/LSL extended
                const addr = this.addrExtended();
                this.write(addr, this.opASL8(this.read(addr)));
                break;
            }
            case 0x79: { // ROL extended
                const addr = this.addrExtended();
                this.write(addr, this.opROL8(this.read(addr)));
                break;
            }
            case 0x7A: { // DEC extended
                const addr = this.addrExtended();
                this.write(addr, this.opDEC8(this.read(addr)));
                break;
            }
            case 0x7C: { // INC extended
                const addr = this.addrExtended();
                this.write(addr, this.opINC8(this.read(addr)));
                break;
            }
            case 0x7D: { // TST extended
                const addr = this.addrExtended();
                this.opTST8(this.read(addr));
                break;
            }
            case 0x7E: { // JMP extended
                this.pc = this.addrExtended();
                break;
            }
            case 0x7F: { // CLR extended
                const addr = this.addrExtended();
                this.write(addr, this.opCLR8());
                break;
            }

            // -----------------------------------------------------------------
            // $80-$8F: Immediate 8-bit (A register)
            // -----------------------------------------------------------------
            case 0x80: this.a = this.opSUB8(this.a, this.fetchByte()); break;  // SUBA imm
            case 0x81: this.opCMP8(this.a, this.fetchByte()); break;           // CMPA imm
            case 0x82: this.a = this.opSBC8(this.a, this.fetchByte()); break;  // SBCA imm
            case 0x83: this.d = this.opSUB16(this.d, this.fetchWord()); break; // SUBD imm
            case 0x84: this.a = this.opAND8(this.a, this.fetchByte()); break;  // ANDA imm
            case 0x85: this.opBIT8(this.a, this.fetchByte()); break;           // BITA imm
            case 0x86: this.a = this.opLD8(this.fetchByte()); break;           // LDA imm
            // 0x87: STA imm - illegal
            case 0x88: this.a = this.opEOR8(this.a, this.fetchByte()); break;  // EORA imm
            case 0x89: this.a = this.opADC8(this.a, this.fetchByte()); break;  // ADCA imm
            case 0x8A: this.a = this.opOR8(this.a, this.fetchByte()); break;   // ORA imm
            case 0x8B: this.a = this.opADD8(this.a, this.fetchByte()); break;  // ADDA imm
            case 0x8C: this.opCMP16(this.x, this.fetchWord()); break;          // CMPX imm
            case 0x8D: { // BSR (branch to subroutine)
                const offset = this.sign8(this.fetchByte());
                this.pushWordS(this.pc);
                this.pc = (this.pc + offset) & 0xFFFF;
                break;
            }
            case 0x8E: this.x = this.opLD16(this.fetchWord()); break;         // LDX imm
            // 0x8F: STX imm - illegal

            // -----------------------------------------------------------------
            // $90-$9F: Direct 8-bit (A register)
            // -----------------------------------------------------------------
            case 0x90: { const a = this.addrDirect(); this.a = this.opSUB8(this.a, this.read(a)); break; } // SUBA dir
            case 0x91: { const a = this.addrDirect(); this.opCMP8(this.a, this.read(a)); break; }          // CMPA dir
            case 0x92: { const a = this.addrDirect(); this.a = this.opSBC8(this.a, this.read(a)); break; } // SBCA dir
            case 0x93: { const a = this.addrDirect(); this.d = this.opSUB16(this.d, this.read16(a)); break; } // SUBD dir
            case 0x94: { const a = this.addrDirect(); this.a = this.opAND8(this.a, this.read(a)); break; } // ANDA dir
            case 0x95: { const a = this.addrDirect(); this.opBIT8(this.a, this.read(a)); break; }          // BITA dir
            case 0x96: { const a = this.addrDirect(); this.a = this.opLD8(this.read(a)); break; }          // LDA dir
            case 0x97: { const a = this.addrDirect(); this.write(a, this.opST8(this.a)); break; }          // STA dir
            case 0x98: { const a = this.addrDirect(); this.a = this.opEOR8(this.a, this.read(a)); break; } // EORA dir
            case 0x99: { const a = this.addrDirect(); this.a = this.opADC8(this.a, this.read(a)); break; } // ADCA dir
            case 0x9A: { const a = this.addrDirect(); this.a = this.opOR8(this.a, this.read(a)); break; }  // ORA dir
            case 0x9B: { const a = this.addrDirect(); this.a = this.opADD8(this.a, this.read(a)); break; } // ADDA dir
            case 0x9C: { const a = this.addrDirect(); this.opCMP16(this.x, this.read16(a)); break; }       // CMPX dir
            case 0x9D: { // JSR direct
                const a = this.addrDirect();
                this.pushWordS(this.pc);
                this.pc = a;
                break;
            }
            case 0x9E: { const a = this.addrDirect(); this.x = this.opLD16(this.read16(a)); break; }       // LDX dir
            case 0x9F: { const a = this.addrDirect(); const v = this.opST16(this.x); this.write16(a, v); break; } // STX dir

            // -----------------------------------------------------------------
            // $A0-$AF: Indexed 8-bit (A register)
            // -----------------------------------------------------------------
            case 0xA0: { const a = this.addrIndexed(); this.a = this.opSUB8(this.a, this.read(a)); break; } // SUBA idx
            case 0xA1: { const a = this.addrIndexed(); this.opCMP8(this.a, this.read(a)); break; }          // CMPA idx
            case 0xA2: { const a = this.addrIndexed(); this.a = this.opSBC8(this.a, this.read(a)); break; } // SBCA idx
            case 0xA3: { const a = this.addrIndexed(); this.d = this.opSUB16(this.d, this.read16(a)); break; } // SUBD idx
            case 0xA4: { const a = this.addrIndexed(); this.a = this.opAND8(this.a, this.read(a)); break; } // ANDA idx
            case 0xA5: { const a = this.addrIndexed(); this.opBIT8(this.a, this.read(a)); break; }          // BITA idx
            case 0xA6: { const a = this.addrIndexed(); this.a = this.opLD8(this.read(a)); break; }          // LDA idx
            case 0xA7: { const a = this.addrIndexed(); this.write(a, this.opST8(this.a)); break; }          // STA idx
            case 0xA8: { const a = this.addrIndexed(); this.a = this.opEOR8(this.a, this.read(a)); break; } // EORA idx
            case 0xA9: { const a = this.addrIndexed(); this.a = this.opADC8(this.a, this.read(a)); break; } // ADCA idx
            case 0xAA: { const a = this.addrIndexed(); this.a = this.opOR8(this.a, this.read(a)); break; }  // ORA idx
            case 0xAB: { const a = this.addrIndexed(); this.a = this.opADD8(this.a, this.read(a)); break; } // ADDA idx
            case 0xAC: { const a = this.addrIndexed(); this.opCMP16(this.x, this.read16(a)); break; }       // CMPX idx
            case 0xAD: { // JSR indexed
                const a = this.addrIndexed();
                this.pushWordS(this.pc);
                this.pc = a;
                break;
            }
            case 0xAE: { const a = this.addrIndexed(); this.x = this.opLD16(this.read16(a)); break; }       // LDX idx
            case 0xAF: { const a = this.addrIndexed(); const v = this.opST16(this.x); this.write16(a, v); break; } // STX idx

            // -----------------------------------------------------------------
            // $B0-$BF: Extended 8-bit (A register)
            // -----------------------------------------------------------------
            case 0xB0: { const a = this.addrExtended(); this.a = this.opSUB8(this.a, this.read(a)); break; } // SUBA ext
            case 0xB1: { const a = this.addrExtended(); this.opCMP8(this.a, this.read(a)); break; }          // CMPA ext
            case 0xB2: { const a = this.addrExtended(); this.a = this.opSBC8(this.a, this.read(a)); break; } // SBCA ext
            case 0xB3: { const a = this.addrExtended(); this.d = this.opSUB16(this.d, this.read16(a)); break; } // SUBD ext
            case 0xB4: { const a = this.addrExtended(); this.a = this.opAND8(this.a, this.read(a)); break; } // ANDA ext
            case 0xB5: { const a = this.addrExtended(); this.opBIT8(this.a, this.read(a)); break; }          // BITA ext
            case 0xB6: { const a = this.addrExtended(); this.a = this.opLD8(this.read(a)); break; }          // LDA ext
            case 0xB7: { const a = this.addrExtended(); this.write(a, this.opST8(this.a)); break; }          // STA ext
            case 0xB8: { const a = this.addrExtended(); this.a = this.opEOR8(this.a, this.read(a)); break; } // EORA ext
            case 0xB9: { const a = this.addrExtended(); this.a = this.opADC8(this.a, this.read(a)); break; } // ADCA ext
            case 0xBA: { const a = this.addrExtended(); this.a = this.opOR8(this.a, this.read(a)); break; }  // ORA ext
            case 0xBB: { const a = this.addrExtended(); this.a = this.opADD8(this.a, this.read(a)); break; } // ADDA ext
            case 0xBC: { const a = this.addrExtended(); this.opCMP16(this.x, this.read16(a)); break; }       // CMPX ext
            case 0xBD: { // JSR extended
                const a = this.addrExtended();
                this.pushWordS(this.pc);
                this.pc = a;
                break;
            }
            case 0xBE: { const a = this.addrExtended(); this.x = this.opLD16(this.read16(a)); break; }       // LDX ext
            case 0xBF: { const a = this.addrExtended(); const v = this.opST16(this.x); this.write16(a, v); break; } // STX ext

            // -----------------------------------------------------------------
            // $C0-$CF: Immediate 8-bit (B register)
            // -----------------------------------------------------------------
            case 0xC0: this.b = this.opSUB8(this.b, this.fetchByte()); break;  // SUBB imm
            case 0xC1: this.opCMP8(this.b, this.fetchByte()); break;           // CMPB imm
            case 0xC2: this.b = this.opSBC8(this.b, this.fetchByte()); break;  // SBCB imm
            case 0xC3: this.d = this.opADD16(this.d, this.fetchWord()); break; // ADDD imm
            case 0xC4: this.b = this.opAND8(this.b, this.fetchByte()); break;  // ANDB imm
            case 0xC5: this.opBIT8(this.b, this.fetchByte()); break;           // BITB imm
            case 0xC6: this.b = this.opLD8(this.fetchByte()); break;           // LDB imm
            // 0xC7: STB imm - illegal
            case 0xC8: this.b = this.opEOR8(this.b, this.fetchByte()); break;  // EORB imm
            case 0xC9: this.b = this.opADC8(this.b, this.fetchByte()); break;  // ADCB imm
            case 0xCA: this.b = this.opOR8(this.b, this.fetchByte()); break;   // ORB imm
            case 0xCB: this.b = this.opADD8(this.b, this.fetchByte()); break;  // ADDB imm
            case 0xCC: this.d = this.opLD16(this.fetchWord()); break;          // LDD imm
            // 0xCD: illegal
            case 0xCE: this.u = this.opLD16(this.fetchWord()); break;          // LDU imm
            // 0xCF: STU imm - illegal

            // -----------------------------------------------------------------
            // $D0-$DF: Direct 8-bit (B register)
            // -----------------------------------------------------------------
            case 0xD0: { const a = this.addrDirect(); this.b = this.opSUB8(this.b, this.read(a)); break; } // SUBB dir
            case 0xD1: { const a = this.addrDirect(); this.opCMP8(this.b, this.read(a)); break; }          // CMPB dir
            case 0xD2: { const a = this.addrDirect(); this.b = this.opSBC8(this.b, this.read(a)); break; } // SBCB dir
            case 0xD3: { const a = this.addrDirect(); this.d = this.opADD16(this.d, this.read16(a)); break; } // ADDD dir
            case 0xD4: { const a = this.addrDirect(); this.b = this.opAND8(this.b, this.read(a)); break; } // ANDB dir
            case 0xD5: { const a = this.addrDirect(); this.opBIT8(this.b, this.read(a)); break; }          // BITB dir
            case 0xD6: { const a = this.addrDirect(); this.b = this.opLD8(this.read(a)); break; }          // LDB dir
            case 0xD7: { const a = this.addrDirect(); this.write(a, this.opST8(this.b)); break; }          // STB dir
            case 0xD8: { const a = this.addrDirect(); this.b = this.opEOR8(this.b, this.read(a)); break; } // EORB dir
            case 0xD9: { const a = this.addrDirect(); this.b = this.opADC8(this.b, this.read(a)); break; } // ADCB dir
            case 0xDA: { const a = this.addrDirect(); this.b = this.opOR8(this.b, this.read(a)); break; }  // ORB dir
            case 0xDB: { const a = this.addrDirect(); this.b = this.opADD8(this.b, this.read(a)); break; } // ADDB dir
            case 0xDC: { const a = this.addrDirect(); this.d = this.opLD16(this.read16(a)); break; }       // LDD dir
            case 0xDD: { const a = this.addrDirect(); const v = this.opST16(this.d); this.write16(a, v); break; } // STD dir
            case 0xDE: { const a = this.addrDirect(); this.u = this.opLD16(this.read16(a)); break; }       // LDU dir
            case 0xDF: { const a = this.addrDirect(); const v = this.opST16(this.u); this.write16(a, v); break; } // STU dir

            // -----------------------------------------------------------------
            // $E0-$EF: Indexed 8-bit (B register)
            // -----------------------------------------------------------------
            case 0xE0: { const a = this.addrIndexed(); this.b = this.opSUB8(this.b, this.read(a)); break; } // SUBB idx
            case 0xE1: { const a = this.addrIndexed(); this.opCMP8(this.b, this.read(a)); break; }          // CMPB idx
            case 0xE2: { const a = this.addrIndexed(); this.b = this.opSBC8(this.b, this.read(a)); break; } // SBCB idx
            case 0xE3: { const a = this.addrIndexed(); this.d = this.opADD16(this.d, this.read16(a)); break; } // ADDD idx
            case 0xE4: { const a = this.addrIndexed(); this.b = this.opAND8(this.b, this.read(a)); break; } // ANDB idx
            case 0xE5: { const a = this.addrIndexed(); this.opBIT8(this.b, this.read(a)); break; }          // BITB idx
            case 0xE6: { const a = this.addrIndexed(); this.b = this.opLD8(this.read(a)); break; }          // LDB idx
            case 0xE7: { const a = this.addrIndexed(); this.write(a, this.opST8(this.b)); break; }          // STB idx
            case 0xE8: { const a = this.addrIndexed(); this.b = this.opEOR8(this.b, this.read(a)); break; } // EORB idx
            case 0xE9: { const a = this.addrIndexed(); this.b = this.opADC8(this.b, this.read(a)); break; } // ADCB idx
            case 0xEA: { const a = this.addrIndexed(); this.b = this.opOR8(this.b, this.read(a)); break; }  // ORB idx
            case 0xEB: { const a = this.addrIndexed(); this.b = this.opADD8(this.b, this.read(a)); break; } // ADDB idx
            case 0xEC: { const a = this.addrIndexed(); this.d = this.opLD16(this.read16(a)); break; }       // LDD idx
            case 0xED: { const a = this.addrIndexed(); const v = this.opST16(this.d); this.write16(a, v); break; } // STD idx
            case 0xEE: { const a = this.addrIndexed(); this.u = this.opLD16(this.read16(a)); break; }       // LDU idx
            case 0xEF: { const a = this.addrIndexed(); const v = this.opST16(this.u); this.write16(a, v); break; } // STU idx

            // -----------------------------------------------------------------
            // $F0-$FF: Extended 8-bit (B register)
            // -----------------------------------------------------------------
            case 0xF0: { const a = this.addrExtended(); this.b = this.opSUB8(this.b, this.read(a)); break; } // SUBB ext
            case 0xF1: { const a = this.addrExtended(); this.opCMP8(this.b, this.read(a)); break; }          // CMPB ext
            case 0xF2: { const a = this.addrExtended(); this.b = this.opSBC8(this.b, this.read(a)); break; } // SBCB ext
            case 0xF3: { const a = this.addrExtended(); this.d = this.opADD16(this.d, this.read16(a)); break; } // ADDD ext
            case 0xF4: { const a = this.addrExtended(); this.b = this.opAND8(this.b, this.read(a)); break; } // ANDB ext
            case 0xF5: { const a = this.addrExtended(); this.opBIT8(this.b, this.read(a)); break; }          // BITB ext
            case 0xF6: { const a = this.addrExtended(); this.b = this.opLD8(this.read(a)); break; }          // LDB ext
            case 0xF7: { const a = this.addrExtended(); this.write(a, this.opST8(this.b)); break; }          // STB ext
            case 0xF8: { const a = this.addrExtended(); this.b = this.opEOR8(this.b, this.read(a)); break; } // EORB ext
            case 0xF9: { const a = this.addrExtended(); this.b = this.opADC8(this.b, this.read(a)); break; } // ADCB ext
            case 0xFA: { const a = this.addrExtended(); this.b = this.opOR8(this.b, this.read(a)); break; }  // ORB ext
            case 0xFB: { const a = this.addrExtended(); this.b = this.opADD8(this.b, this.read(a)); break; } // ADDB ext
            case 0xFC: { const a = this.addrExtended(); this.d = this.opLD16(this.read16(a)); break; }       // LDD ext
            case 0xFD: { const a = this.addrExtended(); const v = this.opST16(this.d); this.write16(a, v); break; } // STD ext
            case 0xFE: { const a = this.addrExtended(); this.u = this.opLD16(this.read16(a)); break; }       // LDU ext
            case 0xFF: { const a = this.addrExtended(); const v = this.opST16(this.u); this.write16(a, v); break; } // STU ext

            default:
                // Illegal/undefined opcode - treat as NOP with 2 cycles
                this.cycle = 2;
                break;
        }
    }

    // =========================================================================
    // Page 2 instruction dispatch ($10xx)
    // =========================================================================

    _execPage2() {
        const opcode = this.fetchByte();
        this.cycle = CYCLES_PAGE2[opcode];

        switch (opcode) {
            // Long branches (16-bit relative offset)
            case 0x21: // LBRN
                this.branchLong(false);
                break;
            case 0x22: // LBHI
                this.branchLong(!(this.cc & (CC_C | CC_Z)));
                break;
            case 0x23: // LBLS
                this.branchLong(!!(this.cc & (CC_C | CC_Z)));
                break;
            case 0x24: // LBCC/LBHS
                this.branchLong(!(this.cc & CC_C));
                break;
            case 0x25: // LBCS/LBLO
                this.branchLong(!!(this.cc & CC_C));
                break;
            case 0x26: // LBNE
                this.branchLong(!(this.cc & CC_Z));
                break;
            case 0x27: // LBEQ
                this.branchLong(!!(this.cc & CC_Z));
                break;
            case 0x28: // LBVC
                this.branchLong(!(this.cc & CC_V));
                break;
            case 0x29: // LBVS
                this.branchLong(!!(this.cc & CC_V));
                break;
            case 0x2A: // LBPL
                this.branchLong(!(this.cc & CC_N));
                break;
            case 0x2B: // LBMI
                this.branchLong(!!(this.cc & CC_N));
                break;
            case 0x2C: // LBGE
                this.branchLong(((this.cc & CC_N) ? 1 : 0) === ((this.cc & CC_V) ? 1 : 0));
                break;
            case 0x2D: // LBLT
                this.branchLong(((this.cc & CC_N) ? 1 : 0) !== ((this.cc & CC_V) ? 1 : 0));
                break;
            case 0x2E: // LBGT
                this.branchLong(!(this.cc & CC_Z) &&
                    (((this.cc & CC_N) ? 1 : 0) === ((this.cc & CC_V) ? 1 : 0)));
                break;
            case 0x2F: // LBLE
                this.branchLong(!!(this.cc & CC_Z) ||
                    (((this.cc & CC_N) ? 1 : 0) !== ((this.cc & CC_V) ? 1 : 0)));
                break;

            case 0x3F: { // SWI2
                this.cc |= CC_E;
                this.pushAllS();
                this.pc = this.read16(VEC_SWI2);
                break;
            }

            // CMPD (compare D register)
            case 0x83: this.opCMP16(this.d, this.fetchWord()); break;                                        // CMPD imm
            case 0x93: { const a = this.addrDirect(); this.opCMP16(this.d, this.read16(a)); break; }         // CMPD dir
            case 0xA3: { const a = this.addrIndexed(); this.opCMP16(this.d, this.read16(a)); break; }        // CMPD idx
            case 0xB3: { const a = this.addrExtended(); this.opCMP16(this.d, this.read16(a)); break; }       // CMPD ext

            // LDY
            case 0x8E: this.y = this.opLD16(this.fetchWord()); break;                                        // LDY imm
            case 0x9E: { const a = this.addrDirect(); this.y = this.opLD16(this.read16(a)); break; }         // LDY dir
            case 0xAE: { const a = this.addrIndexed(); this.y = this.opLD16(this.read16(a)); break; }        // LDY idx
            case 0xBE: { const a = this.addrExtended(); this.y = this.opLD16(this.read16(a)); break; }       // LDY ext

            // STY
            case 0x9F: { const a = this.addrDirect(); const v = this.opST16(this.y); this.write16(a, v); break; }   // STY dir
            case 0xAF: { const a = this.addrIndexed(); const v = this.opST16(this.y); this.write16(a, v); break; }  // STY idx
            case 0xBF: { const a = this.addrExtended(); const v = this.opST16(this.y); this.write16(a, v); break; } // STY ext

            // CMPY
            case 0x8C: this.opCMP16(this.y, this.fetchWord()); break;                                        // CMPY imm
            case 0x9C: { const a = this.addrDirect(); this.opCMP16(this.y, this.read16(a)); break; }         // CMPY dir
            case 0xAC: { const a = this.addrIndexed(); this.opCMP16(this.y, this.read16(a)); break; }        // CMPY idx
            case 0xBC: { const a = this.addrExtended(); this.opCMP16(this.y, this.read16(a)); break; }       // CMPY ext

            // LDS (also sets INTR_NMI_ARMED)
            case 0xCE: this.s = this.opLD16(this.fetchWord()); this.intr |= INTR_NMI_ARMED; break;               // LDS imm
            case 0xDE: { const a = this.addrDirect(); this.s = this.opLD16(this.read16(a)); this.intr |= INTR_NMI_ARMED; break; }   // LDS dir
            case 0xEE: { const a = this.addrIndexed(); this.s = this.opLD16(this.read16(a)); this.intr |= INTR_NMI_ARMED; break; }  // LDS idx
            case 0xFE: { const a = this.addrExtended(); this.s = this.opLD16(this.read16(a)); this.intr |= INTR_NMI_ARMED; break; } // LDS ext

            // STS
            case 0xDF: { const a = this.addrDirect(); const v = this.opST16(this.s); this.write16(a, v); break; }   // STS dir
            case 0xEF: { const a = this.addrIndexed(); const v = this.opST16(this.s); this.write16(a, v); break; }  // STS idx
            case 0xFF: { const a = this.addrExtended(); const v = this.opST16(this.s); this.write16(a, v); break; } // STS ext

            default:
                // Undefined page 2 opcode: real MC6809 executes the base
                // page 1 instruction (the $10 prefix is simply consumed).
                this._execPage1(opcode);
                break;
        }
    }

    // =========================================================================
    // Page 3 instruction dispatch ($11xx)
    // =========================================================================

    _execPage3() {
        const opcode = this.fetchByte();
        this.cycle = CYCLES_PAGE3[opcode];

        switch (opcode) {
            case 0x3F: { // SWI3
                this.cc |= CC_E;
                this.pushAllS();
                this.pc = this.read16(VEC_SWI3);
                break;
            }

            // CMPU
            case 0x83: this.opCMP16(this.u, this.fetchWord()); break;                                        // CMPU imm
            case 0x93: { const a = this.addrDirect(); this.opCMP16(this.u, this.read16(a)); break; }         // CMPU dir
            case 0xA3: { const a = this.addrIndexed(); this.opCMP16(this.u, this.read16(a)); break; }        // CMPU idx
            case 0xB3: { const a = this.addrExtended(); this.opCMP16(this.u, this.read16(a)); break; }       // CMPU ext

            // CMPS
            case 0x8C: this.opCMP16(this.s, this.fetchWord()); break;                                        // CMPS imm
            case 0x9C: { const a = this.addrDirect(); this.opCMP16(this.s, this.read16(a)); break; }         // CMPS dir
            case 0xAC: { const a = this.addrIndexed(); this.opCMP16(this.s, this.read16(a)); break; }        // CMPS idx
            case 0xBC: { const a = this.addrExtended(); this.opCMP16(this.s, this.read16(a)); break; }       // CMPS ext

            default:
                // Undefined page 3 opcode: same as page 2 — execute base instruction
                this._execPage1(opcode);
                break;
        }
    }
}
