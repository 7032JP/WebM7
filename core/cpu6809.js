// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// MC6809 CPU Simulator for FM-7 Web Simulator
// 6809 instruction set simulation with per-instruction cycle counts
// =============================================================================

// Condition Code Register bit masks. Source: MC6809 data sheet, the
// condition code register section (bit assignment of CC).
const CC_C = 0x01; // Carry
const CC_V = 0x02; // Overflow
const CC_Z = 0x04; // Zero
const CC_N = 0x08; // Negative
const CC_I = 0x10; // IRQ mask
const CC_H = 0x20; // Half-carry
const CC_F = 0x40; // FIRQ mask
const CC_E = 0x80; // Entire flag

// EXG / TFR postbyte register codes. Source: MC6809 data sheet, the
// transfer/exchange post byte table. Codes with bit 3 set are 8-bit
// registers; null = code not assigned.
const TRANSFER_REGISTERS = [
    'd', 'x', 'y', 'u', 's', 'pc', null, null,
    'a', 'b', 'cc', 'dp', null, null, null, null,
];

// PSH / PUL postbyte. Source: MC6809 datasheet, the push/pull post byte
// figure and the stacking order. Bit, register, size in bytes, in the order a pull
// takes them from the stack (a push stores them in the reverse order).
// Bit 6 names the other stack pointer (U for the S stack, S for the U stack).
const STACK_SLOTS = [
    [0x01, 'cc', 1], [0x02, 'a', 1], [0x04, 'b', 1], [0x08, 'dp', 1],
    [0x10, 'x', 2], [0x20, 'y', 2], [0x40, null, 2], [0x80, 'pc', 2],
];
const STACK_SLOT_SIZES = Uint8Array.from(STACK_SLOTS, (slot) => slot[2]);

// For every postbyte, the indices of STACK_SLOTS it selects (in the order a
// pull takes them) and the number of bytes it moves. Built once from
// STACK_SLOTS so that an instruction does not walk the whole table.
const STACK_SLOT_LISTS = [];
const STACK_SLOT_BYTES = new Uint8Array(256);
for (let mask = 0; mask < 256; mask++) {
    const list = [];
    for (let k = 0; k < STACK_SLOTS.length; k++) {
        if (!(mask & STACK_SLOTS[k][0])) continue;
        list.push(k);
        STACK_SLOT_BYTES[mask] += STACK_SLOTS[k][2];
    }
    STACK_SLOT_LISTS.push(Uint8Array.from(list));
}

// Interrupt vectors. Source: MC6809 data sheet, the memory map for
// interrupt vectors table.
const VEC_NMI  = 0xFFFC;
const VEC_FIRQ = 0xFFF6;
const VEC_IRQ  = 0xFFF8;
const VEC_SWI  = 0xFFFA;
const VEC_SWI2 = 0xFFF4;
const VEC_SWI3 = 0xFFF2;
const VEC_RST  = 0xFFFE;

// Where the processor is in the data sheet flowchart (Figure 15) between
// instructions: running, in the SYNC loop, or in the CWAI loop.
export const RUNNING   = 0;
export const IN_SYNC   = 1;   // SYNC: waiting for any interrupt line
export const IN_CWAI   = 2;   // CWAI: registers stacked, waiting for an interrupt

// Base cycle counts. Source: MC6809 datasheet, the instruction set tables
// (the "~" cycle columns for each addressing mode, and the long branch and
// prefixed-opcode entries). They exclude the cycles that depend on the operand: the
// indexed postbyte, a taken long branch and the registers that PSH / PUL /
// RTI move; the executing code adds those. 0 = no such instruction.
export const BASE_CYCLES = (() => {
    const page1 = new Array(256).fill(0);
    const page2 = new Array(256).fill(0);
    const page3 = new Array(256).fill(0);

    // $80-$FF: bits 5-4 of the opcode give the addressing mode
    // (immediate, direct, indexed, extended); bit 6 picks the A side
    // ($80-$BF) or the B side ($C0-$FF); the low four bits the operation.
    const BYTE_OP    = [2, 4, 4, 5];
    const BYTE_STORE = [0, 4, 4, 5];
    const WORD_OP    = [4, 6, 6, 7];   // SUBD ADDD CMPX
    const WORD_LOAD  = [3, 5, 5, 6];
    const WORD_STORE = [0, 5, 5, 6];
    const CALL       = [7, 7, 7, 8];   // BSR (immediate column), JSR
    const sideA = new Array(16).fill(BYTE_OP);
    sideA[0x3] = WORD_OP;   sideA[0x7] = BYTE_STORE; sideA[0xC] = WORD_OP;
    sideA[0xD] = CALL;      sideA[0xE] = WORD_LOAD;  sideA[0xF] = WORD_STORE;
    const sideB = new Array(16).fill(BYTE_OP);
    sideB[0x3] = WORD_OP;   sideB[0x7] = BYTE_STORE; sideB[0xC] = WORD_LOAD;
    sideB[0xD] = WORD_STORE; sideB[0xE] = WORD_LOAD; sideB[0xF] = WORD_STORE;
    for (let op = 0x80; op <= 0xFF; op++) {
        const forms = (op & 0x40) ? sideB : sideA;
        page1[op] = forms[op & 0x0F][(op >> 4) & 0x03];
    }

    // $00-$7F single-operand group: direct ($0x), A ($4x), B ($5x),
    // indexed ($6x), extended ($7x). JMP has no register form.
    const SINGLE_OPERAND = [0x0, 0x3, 0x4, 0x6, 0x7, 0x8, 0x9, 0xA, 0xC, 0xD, 0xF];
    const singleByRow = { 0x0: 6, 0x4: 2, 0x5: 2, 0x6: 6, 0x7: 7 };
    const jumpByRow   = { 0x0: 3, 0x6: 3, 0x7: 4 };
    for (const [row, n] of Object.entries(singleByRow)) {
        for (const low of SINGLE_OPERAND) page1[(row << 4) | low] = n;
    }
    for (const [row, n] of Object.entries(jumpByRow)) page1[(row << 4) | 0xE] = n;

    // Short branches $20-$2F.
    for (let op = 0x20; op <= 0x2F; op++) page1[op] = 3;

    // Instructions listed one by one.
    const single = {
        0x12: 2,  /* NOP */   0x13: 4,  /* SYNC */  0x16: 5,  /* LBRA */
        0x17: 9,  /* LBSR */  0x19: 2,  /* DAA */   0x1A: 3,  /* ORCC */
        0x1C: 3,  /* ANDCC */ 0x1D: 2,  /* SEX */   0x1E: 8,  /* EXG */
        0x1F: 6,  /* TFR */   0x30: 4,  /* LEAX */  0x31: 4,  /* LEAY */
        0x32: 4,  /* LEAS */  0x33: 4,  /* LEAU */  0x34: 5,  /* PSHS */
        0x35: 5,  /* PULS */  0x36: 5,  /* PSHU */  0x37: 5,  /* PULU */
        0x39: 5,  /* RTS */   0x3A: 3,  /* ABX */   0x3B: 6,  /* RTI */
        0x3C: 20, /* CWAI */  0x3D: 11, /* MUL */   0x3F: 19, /* SWI */
    };
    for (const [op, n] of Object.entries(single)) page1[op] = n;

    // Prefixed pages: the long conditional branches and SWI2 / SWI3, and
    // register forms that take one cycle more than the unprefixed
    // instruction in the same position (CMPD CMPY LDY STY LDS STS on $10,
    // CMPU CMPS on $11).
    for (let op = 0x21; op <= 0x2F; op++) page2[op] = 5;
    page2[0x3F] = 20;
    page3[0x3F] = 20;
    const longer = (page, sideALows, sideBLows) => {
        for (let op = 0x80; op <= 0xFF; op++) {
            const lows = (op & 0x40) ? sideBLows : sideALows;
            if (lows.includes(op & 0x0F) && page1[op] !== 0) page[op] = page1[op] + 1;
        }
    };
    longer(page2, [0x3, 0xC, 0xE, 0xF], [0xE, 0xF]);
    longer(page3, [0x3, 0xC], []);

    return { page1, page2, page3 };
})();

// Which second bytes have an instruction on the prefixed pages: exactly
// those with a cycle count there.  The prefix is dropped for the others
// and the second byte runs as its page 1 instruction.
const PAGE2_DEFINED = Uint8Array.from(BASE_CYCLES.page2, (n) => (n > 0 ? 1 : 0));
const PAGE3_DEFINED = Uint8Array.from(BASE_CYCLES.page3, (n) => (n > 0 ? 1 : 0));

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

        // Interrupt inputs and the waiting loops
        this.nmiRequest = false;   // NMI edge seen, not yet taken
        this.firqRequest = false;  // FIRQ requested, not yet taken
        this.irqRequest = false;   // IRQ requested, not yet taken
        this.nmiArmed = false;     // set when LDS, LEAS or TFR / EXG writes S after reset
        this.waitState = RUNNING;  // RUNNING, IN_SYNC or IN_CWAI

        this.instrCycles = 0;      // cycles of the instruction just executed
        this.elapsedCycles = 0;    // cycles since reset

        // Memory access (the system's bus)
        this._readCycleHandler = null;
        this._writeCycleHandler = null;

        // Bus cycle accounting. When a map is set, each
        // byte the instruction moves on the bus is counted, and so is each
        // access whose address the map marks as a long bus cycle. Cycles of
        // the instruction that move no byte are internal (VMA) cycles.
        this.longCycleMap = null;   // Uint8Array(65536) of 0/1, or null
        this.busBytes = 0;          // bus accesses in the current instruction
        this.longBusBytes = 0;      // of those, accesses to long-cycle addresses

        // Direct page tables. Entry n is a 256-byte view of the memory that
        // answers $nn00-$nnFF with no side effect, or null when the access
        // goes to the read / write handler. The system that owns the memory
        // keeps them up to date; all null means every access uses the handler.
        this.readPages = new Array(256).fill(null);
        this.writePages = new Array(256).fill(null);
    }

    // =========================================================================
    // Public API
    // =========================================================================

    setReadMem(fn) { this._readCycleHandler = fn; }
    setWriteMem(fn) { this._writeCycleHandler = fn; }

    reset() {
        this.a = 0;
        this.b = 0;
        this.x = 0;
        this.y = 0;
        this.u = 0;
        this.s = 0;
        this.dp = 0;
        this.cc = CC_I | CC_F;  // Interrupts masked on reset
        this.nmiRequest = this.firqRequest = this.irqRequest = false;
        this.nmiArmed = false;
        this.waitState = RUNNING;
        this.elapsedCycles = 0;
        this.instrCycles = 0;

        // Load PC from reset vector
        this.pc = this.read16(VEC_RST);
    }

    nmi() { this.nmiRequest = true; }
    firq() { this.firqRequest = true; }
    irq() { this.irqRequest = true; }

    /**
     * One pass of the MC6809 flowchart (data sheet Figure 15): an interrupt
     * entry, one bus cycle of the SYNC or CWAI loop, or one instruction.
     * Returns the cycles it took.
     */
    exec() {
        this.busBytes = 0;
        this.longBusBytes = 0;
        // With no request and no waiting loop there is nothing to look at
        // before the instruction (the checks below would all fall through).
        if (this.nmiRequest || this.firqRequest || this.irqRequest || this.waitState !== RUNNING) {
            // SYNC loop: any asserted interrupt line, masked or not, leaves the
            // loop (Figure 15, SYNC; "SYNC Acknowledge").
            if (this.waitState === IN_SYNC && (this.nmiRequest || this.firqRequest || this.irqRequest)) {
                this.waitState = RUNNING;
            }
            const entryCycles = this._serviceInterrupt();
            if (entryCycles > 0) return this._spend(entryCycles);
            // Still in the SYNC or CWAI loop: one bus cycle, then look again.
            if (this.waitState !== RUNNING) return this._spend(1);
        }

        this.instrCycles = 0;
        const opcode = this.fetchByte();
        if (opcode === 0x10 || opcode === 0x11) {
            // $10 / $11 prefix: the next byte picks from page 2 / 3.  A
            // byte with no entry there keeps the prefix consumed but is
            // run as the page 1 instruction with its page 1 cycles.
            const second = this.fetchByte();
            const defined = (opcode === 0x10) ? PAGE2_DEFINED : PAGE3_DEFINED;
            if (!defined[second]) this._execPage1(second);
            else if (opcode === 0x10) this._execPage2(second);
            else this._execPage3(second);
        } else {
            this._execPage1(opcode);
        }
        this.elapsedCycles += this.instrCycles;
        return this.instrCycles;
    }

    _spend(cycles) {
        this.instrCycles = cycles;
        this.elapsedCycles += cycles;
        return cycles;
    }

    // =========================================================================
    // Memory access helpers
    // =========================================================================

    read(addr) {
        addr &= 0xFFFF;
        const map = this.longCycleMap;
        if (map !== null) { this.busBytes++; this.longBusBytes += map[addr]; }
        const page = this.readPages[addr >> 8];
        if (page !== null) return page[addr & 0xFF];
        return this._readCycleHandler(addr) & 0xFF;
    }

    write(addr, val) {
        addr &= 0xFFFF;
        const map = this.longCycleMap;
        if (map !== null) { this.busBytes++; this.longBusBytes += map[addr]; }
        const page = this.writePages[addr >> 8];
        if (page !== null) { page[addr & 0xFF] = val; return; }
        this._writeCycleHandler(addr, val & 0xFF);
    }

    /**
     * Length of the instruction just executed, in master clock periods.
     * Short bus cycles take `shortLen`, long ones and internal cycles take
     * `longLen` (an internal cycle puts $FFFF on the bus, which lies in the
     * long range).
     */
    instructionTicks(shortLen, longLen) {
        const bytes = this.busBytes;
        const internal = this.instrCycles > bytes ? this.instrCycles - bytes : 0;
        const longCount = this.longBusBytes + internal;
        return (bytes - this.longBusBytes) * shortLen + longCount * longLen;
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

    /**
     * The register in slot `k` of STACK_SLOTS. Slot 6 is the other stack
     * pointer: U when `useS` (the S stack), S otherwise.
     */
    _slotValue(k, useS) {
        switch (k) {
            case 0: return this.cc;
            case 1: return this.a;
            case 2: return this.b;
            case 3: return this.dp;
            case 4: return this.x;
            case 5: return this.y;
            case 6: return useS ? this.u : this.s;
            default: return this.pc;
        }
    }

    /** Set the register in slot `k` of STACK_SLOTS (see _slotValue). */
    _setSlotValue(k, useS, value) {
        switch (k) {
            case 0: this.cc = value; break;
            case 1: this.a = value; break;
            case 2: this.b = value; break;
            case 3: this.dp = value; break;
            case 4: this.x = value; break;
            case 5: this.y = value; break;
            case 6: if (useS) this.u = value; else this.s = value; break;
            default: this.pc = value; break;
        }
    }

    /**
     * Put `bytes` (1 or 2) bytes of `value` on the S stack (`useS`) or the
     * U stack. The stack grows down and a 16-bit value ends with its high
     * byte at the lower address.
     */
    _stackPut(useS, value, bytes) {
        let p = useS ? this.s : this.u;
        for (let shift = 0; shift < bytes * 8; shift += 8) {
            p = (p - 1) & 0xFFFF;
            this.write(p, (value >> shift) & 0xFF);
        }
        if (useS) this.s = p; else this.u = p;
    }

    /** Take `bytes` (1 or 2) bytes off the S stack (`useS`) or the U stack. */
    _stackTake(useS, bytes) {
        let p = useS ? this.s : this.u;
        let value = 0;
        for (let k = 0; k < bytes; k++) {
            value = (value << 8) | this.read(p);
            p = (p + 1) & 0xFFFF;
        }
        if (useS) this.s = p; else this.u = p;
        return value;
    }

    /**
     * Save the registers chosen by a PSH-style postbyte `mask` on stack `sp`
     * (PC first, CC last). Returns the number of bytes stored.
     */
    _saveRegisters(sp, mask) {
        const useS = sp === 's';
        const list = STACK_SLOT_LISTS[mask];
        for (let n = list.length - 1; n >= 0; n--) {
            const k = list[n];
            this._stackPut(useS, this._slotValue(k, useS), STACK_SLOT_SIZES[k]);
        }
        return STACK_SLOT_BYTES[mask];
    }

    /**
     * Load the registers chosen by a PUL-style postbyte `mask` from stack
     * `sp` (CC first, PC last). Returns the number of bytes loaded.
     */
    _restoreRegisters(sp, mask) {
        const useS = sp === 's';
        const list = STACK_SLOT_LISTS[mask];
        for (let n = 0; n < list.length; n++) {
            const k = list[n];
            this._setSlotValue(k, useS, this._stackTake(useS, STACK_SLOT_SIZES[k]));
        }
        return STACK_SLOT_BYTES[mask];
    }

    // =========================================================================
    // Interrupt handling
    // =========================================================================

    /**
     * Interrupt check of Figure 15: NMI (only once armed by a load of S),
     * then FIRQ with F clear, then IRQ with I clear. The accepted request is
     * cleared, the state is stacked (FIRQ: PC and CC with E = 0; NMI and IRQ:
     * every register with E = 1; nothing more after CWAI) and the vector is
     * fetched. Returns the cycles of the entry (data sheet Figures 9 and 10,
     * and the CWAI case), or 0 when nothing is accepted.
     */
    _serviceInterrupt() {
        let vector, fastEntry, setMask;
        if (this.nmiArmed && this.nmiRequest) {
            this.nmiRequest = false;
            vector = VEC_NMI; fastEntry = false; setMask = CC_I | CC_F;
        } else if (this.firqRequest && (this.cc & CC_F) === 0) {
            this.firqRequest = false;
            vector = VEC_FIRQ; fastEntry = true; setMask = CC_I | CC_F;
        } else if (this.irqRequest && (this.cc & CC_I) === 0) {
            this.irqRequest = false;
            vector = VEC_IRQ; fastEntry = false; setMask = CC_I;
        } else {
            return 0;
        }
        let cycles;
        if (this.waitState === IN_CWAI) {
            this.cc |= CC_E;                  // already stacked by CWAI
            cycles = 7;
        } else if (fastEntry) {
            this.cc &= ~CC_E;
            this._saveRegisters('s', 0x81);   // PC, then CC
            cycles = 10;
        } else {
            this.cc |= CC_E;
            this._saveRegisters('s', 0xFF);
            cycles = 19;
        }
        this.waitState = RUNNING;
        this.cc |= setMask;
        this.pc = this.read16(vector);
        return cycles;
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

    // Indexed addressing with postbyte. The extra cycles of each mode are
    // the "+~" column of the indexed addressing table (MC6809 data sheet).
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
            this.instrCycles += 1;
            return addr;
        }

        const mode = postbyte & 0x1F;
        const indirect = postbyte & 0x10;

        switch (mode & 0x0F) {
            case 0x00: // ,R+
                addr = reg;
                reg = (reg + 1) & 0xFFFF;
                this.instrCycles += 2;
                break;
            case 0x01: // ,R++
                addr = reg;
                reg = (reg + 2) & 0xFFFF;
                this.instrCycles += indirect ? 6 : 3;
                break;
            case 0x02: // ,-R
                reg = (reg - 1) & 0xFFFF;
                addr = reg;
                this.instrCycles += 2;
                break;
            case 0x03: // ,--R
                reg = (reg - 2) & 0xFFFF;
                addr = reg;
                this.instrCycles += indirect ? 6 : 3;
                break;
            case 0x04: // ,R (no offset)
                addr = reg;
                this.instrCycles += indirect ? 3 : 0;
                break;
            case 0x05: // B,R
                addr = (reg + this.sign8(this.b)) & 0xFFFF;
                this.instrCycles += indirect ? 4 : 1;
                break;
            case 0x06: // A,R
                addr = (reg + this.sign8(this.a)) & 0xFFFF;
                this.instrCycles += indirect ? 4 : 1;
                break;
            case 0x08: // 8-bit offset,R
                addr = (reg + this.sign8(this.fetchByte())) & 0xFFFF;
                this.instrCycles += indirect ? 4 : 1;
                break;
            case 0x09: // 16-bit offset,R
                addr = (reg + this.sign16(this.fetchWord())) & 0xFFFF;
                this.instrCycles += indirect ? 7 : 4;
                break;
            case 0x0B: // D,R
                addr = (reg + this.sign16(this.d)) & 0xFFFF;
                this.instrCycles += indirect ? 7 : 4;
                break;
            case 0x0C: // 8-bit offset,PC
                {
                    const off = this.sign8(this.fetchByte());
                    addr = (this.pc + off) & 0xFFFF;
                    this.instrCycles += indirect ? 4 : 1;
                }
                break;
            case 0x0D: // 16-bit offset,PC
                {
                    const off = this.sign16(this.fetchWord());
                    addr = (this.pc + off) & 0xFFFF;
                    this.instrCycles += indirect ? 8 : 5;
                }
                break;
            case 0x0F: // Extended indirect [addr16]; the non-indirect form is undefined
                if (indirect) {
                    addr = this.fetchWord();
                    this.instrCycles += 5;
                } else {
                    addr = reg;
                    this.instrCycles += 1;
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

    // DAA (MC6809 datasheet): after a BCD addition, add $06 when H is set
    // or the low digit is above 9, and $60 when C is set or A is above $99.
    // C becomes 1 on a carry out and otherwise keeps its value; N and Z
    // follow the result; H is unchanged; V (undefined in the datasheet) is cleared.
    decimalAdjustA() {
        const before = this.a;
        let adjust = 0;
        if ((this.cc & CC_H) || (before & 0x0F) > 0x09) adjust |= 0x06;
        if ((this.cc & CC_C) || before > 0x99) adjust |= 0x60;
        const sum = before + adjust;
        this.a = sum & 0xFF;
        this.cc &= ~(CC_N | CC_Z | CC_V);
        if (sum > 0xFF) this.cc |= CC_C;
        if (this.a & 0x80) this.cc |= CC_N;
        if (this.a === 0) this.cc |= CC_Z;
    }

    // MUL - A * B -> D (unsigned)
    opMUL() {
        const result = this.a * this.b;
        this.d = result & 0xFFFF;
        this.cc &= ~(CC_Z | CC_C);
        if (result === 0) this.cc |= CC_Z;
        if (this.b & 0x80) this.cc |= CC_C;
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
            this.instrCycles += 1;
        }
    }

    // =========================================================================
    // EXG / TFR register access
    // =========================================================================

    /** Read the register an EXG / TFR code names (unassigned codes read 0). */
    _transferRead(code) {
        const name = TRANSFER_REGISTERS[code & 0x0F];
        return name ? this[name] : 0;
    }

    /**
     * Write the register an EXG / TFR code names (unassigned codes ignore it).
     * The datasheet leaves moves between an 8-bit and a 16-bit register
     * undefined. Here the number itself moves: an 8-bit value lands in a
     * 16-bit register with a zero high byte, and an 8-bit register keeps
     * the low byte of a 16-bit value.
     */
    _transferWrite(code, value) {
        const name = TRANSFER_REGISTERS[code & 0x0F];
        if (name) this[name] = value & ((code & 0x08) ? 0xFF : 0xFFFF);
    }

    // =========================================================================
    // PSHS / PULS / PSHU / PULU
    // =========================================================================

    /** PSH (pull = false) or PUL (pull = true) on stack `sp`; one cycle per byte. */
    _pushPullInstr(sp, pull) {
        const mask = this.fetchByte();
        this.instrCycles += pull ? this._restoreRegisters(sp, mask)
                                 : this._saveRegisters(sp, mask);
    }

    // =========================================================================
    // Page 1 instruction dispatch ($00-$FF)
    // =========================================================================

    _execPage1(opcode) {
        this.instrCycles = BASE_CYCLES.page1[opcode];
        PAGE1_OPS[opcode](this);
    }

    // =========================================================================
    // Page 2 instruction dispatch ($10xx); `opcode` is in PAGE2_DEFINED
    // =========================================================================

    _execPage2(opcode) {
        this.instrCycles = BASE_CYCLES.page2[opcode];
        PAGE2_OPS[opcode](this);
    }

    // =========================================================================
    // Page 3 instruction dispatch ($11xx); `opcode` is in PAGE3_DEFINED
    // =========================================================================

    _execPage3(opcode) {
        this.instrCycles = BASE_CYCLES.page3[opcode];
        PAGE3_OPS[opcode](this);
    }
}

// =============================================================================
// Page 1 instructions ($00-$FF): one function per opcode, called as
// PAGE1_OPS[opcode](cpu) after _execPage1 has set the base cycle count.
// An opcode without an instruction runs PAGE1_UNDEFINED.
// =============================================================================

const PAGE1_OPS = new Array(256);
// -----------------------------------------------------------------
// $00-$0F: Direct addressing ALU (memory)
// -----------------------------------------------------------------
// NEG direct
PAGE1_OPS[0x00] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opNEG8(cpu.read(addr)));
};
// COM direct
PAGE1_OPS[0x03] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opCOM8(cpu.read(addr)));
};
// LSR direct
PAGE1_OPS[0x04] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opLSR8(cpu.read(addr)));
};
// ROR direct
PAGE1_OPS[0x06] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opROR8(cpu.read(addr)));
};
// ASR direct
PAGE1_OPS[0x07] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opASR8(cpu.read(addr)));
};
// ASL/LSL direct
PAGE1_OPS[0x08] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opASL8(cpu.read(addr)));
};
// ROL direct
PAGE1_OPS[0x09] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opROL8(cpu.read(addr)));
};
// DEC direct
PAGE1_OPS[0x0A] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opDEC8(cpu.read(addr)));
};
// INC direct
PAGE1_OPS[0x0C] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opINC8(cpu.read(addr)));
};
// TST direct
PAGE1_OPS[0x0D] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.opTST8(cpu.read(addr));
};
// JMP direct
PAGE1_OPS[0x0E] = (cpu) => { cpu.pc = cpu.addrDirect(); };
// CLR direct
PAGE1_OPS[0x0F] = (cpu) => {
    const addr = cpu.addrDirect();
    cpu.write(addr, cpu.opCLR8());
};

// -----------------------------------------------------------------
// $10, $11 handled externally (page prefix)
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// $12-$1F: Inherent / Misc
// -----------------------------------------------------------------
// NOP
PAGE1_OPS[0x12] = () => {};
// SYNC
PAGE1_OPS[0x13] = (cpu) => { cpu.waitState = IN_SYNC; };
// LBRA (long branch always)
PAGE1_OPS[0x16] = (cpu) => {
    const offset = cpu.sign16(cpu.fetchWord());
    cpu.pc = (cpu.pc + offset) & 0xFFFF;
};
// LBSR (long branch to subroutine)
PAGE1_OPS[0x17] = (cpu) => {
    const offset = cpu.sign16(cpu.fetchWord());
    cpu._saveRegisters('s', 0x80);
    cpu.pc = (cpu.pc + offset) & 0xFFFF;
};
// DAA
PAGE1_OPS[0x19] = (cpu) => { cpu.decimalAdjustA(); };
// ORCC immediate
PAGE1_OPS[0x1A] = (cpu) => { cpu.cc |= cpu.fetchByte(); };
// ANDCC immediate
PAGE1_OPS[0x1C] = (cpu) => { cpu.cc &= cpu.fetchByte(); };
// SEX (sign extend B -> A:B)
PAGE1_OPS[0x1D] = (cpu) => {
    if (cpu.b & 0x80) {
        cpu.a = 0xFF;
    } else {
        cpu.a = 0x00;
    }
    cpu.cc &= ~(CC_N | CC_Z);
    if (cpu.a & 0x80) cpu.cc |= CC_N;
    if (cpu.d === 0) cpu.cc |= CC_Z;
};
// EXG
PAGE1_OPS[0x1E] = (cpu) => {
    const postbyte = cpu.fetchByte();
    const first = postbyte >> 4;
    const second = postbyte & 0x0F;
    const firstValue = cpu._transferRead(first);
    const secondValue = cpu._transferRead(second);
    cpu._transferWrite(first, secondValue);
    cpu._transferWrite(second, firstValue);
    // Loading S arms NMI
    if (TRANSFER_REGISTERS[first] === 's' || TRANSFER_REGISTERS[second] === 's') cpu.nmiArmed = true;
};
// TFR
PAGE1_OPS[0x1F] = (cpu) => {
    const postbyte = cpu.fetchByte();
    const source = postbyte >> 4;
    const dest = postbyte & 0x0F;
    cpu._transferWrite(dest, cpu._transferRead(source));
    // Loading S arms NMI
    if (TRANSFER_REGISTERS[dest] === 's') cpu.nmiArmed = true;
};

// -----------------------------------------------------------------
// $20-$2F: Short branches (relative 8-bit)
// -----------------------------------------------------------------
// BRA
PAGE1_OPS[0x20] = (cpu) => { cpu.branchShort(true); };
// BRN
PAGE1_OPS[0x21] = (cpu) => { cpu.branchShort(false); };
// BHI (C=0 and Z=0)
PAGE1_OPS[0x22] = (cpu) => { cpu.branchShort(!(cpu.cc & (CC_C | CC_Z))); };
// BLS (C=1 or Z=1)
PAGE1_OPS[0x23] = (cpu) => { cpu.branchShort(!!(cpu.cc & (CC_C | CC_Z))); };
// BCC/BHS (C=0)
PAGE1_OPS[0x24] = (cpu) => { cpu.branchShort(!(cpu.cc & CC_C)); };
// BCS/BLO (C=1)
PAGE1_OPS[0x25] = (cpu) => { cpu.branchShort(!!(cpu.cc & CC_C)); };
// BNE (Z=0)
PAGE1_OPS[0x26] = (cpu) => { cpu.branchShort(!(cpu.cc & CC_Z)); };
// BEQ (Z=1)
PAGE1_OPS[0x27] = (cpu) => { cpu.branchShort(!!(cpu.cc & CC_Z)); };
// BVC (V=0)
PAGE1_OPS[0x28] = (cpu) => { cpu.branchShort(!(cpu.cc & CC_V)); };
// BVS (V=1)
PAGE1_OPS[0x29] = (cpu) => { cpu.branchShort(!!(cpu.cc & CC_V)); };
// BPL (N=0)
PAGE1_OPS[0x2A] = (cpu) => { cpu.branchShort(!(cpu.cc & CC_N)); };
// BMI (N=1)
PAGE1_OPS[0x2B] = (cpu) => { cpu.branchShort(!!(cpu.cc & CC_N)); };
// BGE (N^V=0)
PAGE1_OPS[0x2C] = (cpu) => { cpu.branchShort(!((cpu.cc & CC_N) ? 1 : 0) === !((cpu.cc & CC_V) ? 1 : 0)); };
// BLT (N^V=1)
PAGE1_OPS[0x2D] = (cpu) => { cpu.branchShort(((cpu.cc & CC_N) ? 1 : 0) !== ((cpu.cc & CC_V) ? 1 : 0)); };
// BGT (Z=0 and N^V=0)
PAGE1_OPS[0x2E] = (cpu) => {
    cpu.branchShort(!(cpu.cc & CC_Z) &&
        (((cpu.cc & CC_N) ? 1 : 0) === ((cpu.cc & CC_V) ? 1 : 0)));
};
// BLE (Z=1 or N^V=1)
PAGE1_OPS[0x2F] = (cpu) => {
    cpu.branchShort(!!(cpu.cc & CC_Z) ||
        (((cpu.cc & CC_N) ? 1 : 0) !== ((cpu.cc & CC_V) ? 1 : 0)));
};

// -----------------------------------------------------------------
// $30-$3F: Misc
// -----------------------------------------------------------------
// LEAX indexed
PAGE1_OPS[0x30] = (cpu) => {
    cpu.x = cpu.addrIndexed();
    cpu.cc &= ~CC_Z;
    if (cpu.x === 0) cpu.cc |= CC_Z;
};
// LEAY indexed
PAGE1_OPS[0x31] = (cpu) => {
    cpu.y = cpu.addrIndexed();
    cpu.cc &= ~CC_Z;
    if (cpu.y === 0) cpu.cc |= CC_Z;
};
// LEAS indexed
PAGE1_OPS[0x32] = (cpu) => {
    cpu.s = cpu.addrIndexed();
    cpu.nmiArmed = true;
};
// LEAU indexed
PAGE1_OPS[0x33] = (cpu) => { cpu.u = cpu.addrIndexed(); };
// PSHS
PAGE1_OPS[0x34] = (cpu) => { cpu._pushPullInstr('s', false); };
// PULS
PAGE1_OPS[0x35] = (cpu) => { cpu._pushPullInstr('s', true); };
// PSHU
PAGE1_OPS[0x36] = (cpu) => { cpu._pushPullInstr('u', false); };
// PULU
PAGE1_OPS[0x37] = (cpu) => { cpu._pushPullInstr('u', true); };
// RTS
PAGE1_OPS[0x39] = (cpu) => { cpu._restoreRegisters('s', 0x80); };
// ABX (X = X + unsigned B)
PAGE1_OPS[0x3A] = (cpu) => { cpu.x = (cpu.x + cpu.b) & 0xFFFF; };
// RTI
PAGE1_OPS[0x3B] = (cpu) => {
    cpu._restoreRegisters('s', 0x01);   // CC
    if (cpu.cc & CC_E) {
        // Entire state was saved
        cpu._restoreRegisters('s', 0x7E);   // A B DP X Y U
        cpu.instrCycles = 15;
    }
    cpu._restoreRegisters('s', 0x80);
};
// CWAI
PAGE1_OPS[0x3C] = (cpu) => {
    const imm = cpu.fetchByte();
    cpu.cc &= imm;
    cpu.cc |= CC_E;
    cpu._saveRegisters('s', 0xFF);
    cpu.waitState = IN_CWAI;
};
// MUL
PAGE1_OPS[0x3D] = (cpu) => { cpu.opMUL(); };
// SWI
PAGE1_OPS[0x3F] = (cpu) => {
    cpu.cc |= CC_E;
    cpu._saveRegisters('s', 0xFF);
    cpu.cc |= CC_I | CC_F;
    cpu.pc = cpu.read16(VEC_SWI);
};

// -----------------------------------------------------------------
// $40-$4F: Inherent A register
// -----------------------------------------------------------------
// NEGA
PAGE1_OPS[0x40] = (cpu) => { cpu.a = cpu.opNEG8(cpu.a); };
// COMA
PAGE1_OPS[0x43] = (cpu) => { cpu.a = cpu.opCOM8(cpu.a); };
// LSRA
PAGE1_OPS[0x44] = (cpu) => { cpu.a = cpu.opLSR8(cpu.a); };
// RORA
PAGE1_OPS[0x46] = (cpu) => { cpu.a = cpu.opROR8(cpu.a); };
// ASRA
PAGE1_OPS[0x47] = (cpu) => { cpu.a = cpu.opASR8(cpu.a); };
// ASLA/LSLA
PAGE1_OPS[0x48] = (cpu) => { cpu.a = cpu.opASL8(cpu.a); };
// ROLA
PAGE1_OPS[0x49] = (cpu) => { cpu.a = cpu.opROL8(cpu.a); };
// DECA
PAGE1_OPS[0x4A] = (cpu) => { cpu.a = cpu.opDEC8(cpu.a); };
// INCA
PAGE1_OPS[0x4C] = (cpu) => { cpu.a = cpu.opINC8(cpu.a); };
// TSTA
PAGE1_OPS[0x4D] = (cpu) => { cpu.opTST8(cpu.a); };
// CLRA
PAGE1_OPS[0x4F] = (cpu) => { cpu.a = cpu.opCLR8(); };

// -----------------------------------------------------------------
// $50-$5F: Inherent B register
// -----------------------------------------------------------------
// NEGB
PAGE1_OPS[0x50] = (cpu) => { cpu.b = cpu.opNEG8(cpu.b); };
// COMB
PAGE1_OPS[0x53] = (cpu) => { cpu.b = cpu.opCOM8(cpu.b); };
// LSRB
PAGE1_OPS[0x54] = (cpu) => { cpu.b = cpu.opLSR8(cpu.b); };
// RORB
PAGE1_OPS[0x56] = (cpu) => { cpu.b = cpu.opROR8(cpu.b); };
// ASRB
PAGE1_OPS[0x57] = (cpu) => { cpu.b = cpu.opASR8(cpu.b); };
// ASLB/LSLB
PAGE1_OPS[0x58] = (cpu) => { cpu.b = cpu.opASL8(cpu.b); };
// ROLB
PAGE1_OPS[0x59] = (cpu) => { cpu.b = cpu.opROL8(cpu.b); };
// DECB
PAGE1_OPS[0x5A] = (cpu) => { cpu.b = cpu.opDEC8(cpu.b); };
// INCB
PAGE1_OPS[0x5C] = (cpu) => { cpu.b = cpu.opINC8(cpu.b); };
// TSTB
PAGE1_OPS[0x5D] = (cpu) => { cpu.opTST8(cpu.b); };
// CLRB
PAGE1_OPS[0x5F] = (cpu) => { cpu.b = cpu.opCLR8(); };

// -----------------------------------------------------------------
// $60-$6F: Indexed addressing ALU (memory)
// -----------------------------------------------------------------
// NEG indexed
PAGE1_OPS[0x60] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opNEG8(cpu.read(addr)));
};
// COM indexed
PAGE1_OPS[0x63] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opCOM8(cpu.read(addr)));
};
// LSR indexed
PAGE1_OPS[0x64] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opLSR8(cpu.read(addr)));
};
// ROR indexed
PAGE1_OPS[0x66] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opROR8(cpu.read(addr)));
};
// ASR indexed
PAGE1_OPS[0x67] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opASR8(cpu.read(addr)));
};
// ASL/LSL indexed
PAGE1_OPS[0x68] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opASL8(cpu.read(addr)));
};
// ROL indexed
PAGE1_OPS[0x69] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opROL8(cpu.read(addr)));
};
// DEC indexed
PAGE1_OPS[0x6A] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opDEC8(cpu.read(addr)));
};
// INC indexed
PAGE1_OPS[0x6C] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opINC8(cpu.read(addr)));
};
// TST indexed
PAGE1_OPS[0x6D] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.opTST8(cpu.read(addr));
};
// JMP indexed
PAGE1_OPS[0x6E] = (cpu) => { cpu.pc = cpu.addrIndexed(); };
// CLR indexed
PAGE1_OPS[0x6F] = (cpu) => {
    const addr = cpu.addrIndexed();
    cpu.write(addr, cpu.opCLR8());
};

// -----------------------------------------------------------------
// $70-$7F: Extended addressing ALU (memory)
// -----------------------------------------------------------------
// NEG extended
PAGE1_OPS[0x70] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opNEG8(cpu.read(addr)));
};
// COM extended
PAGE1_OPS[0x73] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opCOM8(cpu.read(addr)));
};
// LSR extended
PAGE1_OPS[0x74] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opLSR8(cpu.read(addr)));
};
// ROR extended
PAGE1_OPS[0x76] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opROR8(cpu.read(addr)));
};
// ASR extended
PAGE1_OPS[0x77] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opASR8(cpu.read(addr)));
};
// ASL/LSL extended
PAGE1_OPS[0x78] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opASL8(cpu.read(addr)));
};
// ROL extended
PAGE1_OPS[0x79] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opROL8(cpu.read(addr)));
};
// DEC extended
PAGE1_OPS[0x7A] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opDEC8(cpu.read(addr)));
};
// INC extended
PAGE1_OPS[0x7C] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opINC8(cpu.read(addr)));
};
// TST extended
PAGE1_OPS[0x7D] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.opTST8(cpu.read(addr));
};
// JMP extended
PAGE1_OPS[0x7E] = (cpu) => { cpu.pc = cpu.addrExtended(); };
// CLR extended
PAGE1_OPS[0x7F] = (cpu) => {
    const addr = cpu.addrExtended();
    cpu.write(addr, cpu.opCLR8());
};

// -----------------------------------------------------------------
// $80-$8F: Immediate operand, and BSR
// -----------------------------------------------------------------
// SUBA imm
PAGE1_OPS[0x80] = (cpu) => { cpu.a = cpu.opSUB8(cpu.a, cpu.fetchByte()); };
// CMPA imm
PAGE1_OPS[0x81] = (cpu) => { cpu.opCMP8(cpu.a, cpu.fetchByte()); };
// SBCA imm
PAGE1_OPS[0x82] = (cpu) => { cpu.a = cpu.opSBC8(cpu.a, cpu.fetchByte()); };
// SUBD imm
PAGE1_OPS[0x83] = (cpu) => { cpu.d = cpu.opSUB16(cpu.d, cpu.fetchWord()); };
// ANDA imm
PAGE1_OPS[0x84] = (cpu) => { cpu.a = cpu.opAND8(cpu.a, cpu.fetchByte()); };
// BITA imm
PAGE1_OPS[0x85] = (cpu) => { cpu.opBIT8(cpu.a, cpu.fetchByte()); };
// LDA imm
PAGE1_OPS[0x86] = (cpu) => { cpu.a = cpu.opLD8(cpu.fetchByte()); };
// 0x87: STA imm - illegal
// EORA imm
PAGE1_OPS[0x88] = (cpu) => { cpu.a = cpu.opEOR8(cpu.a, cpu.fetchByte()); };
// ADCA imm
PAGE1_OPS[0x89] = (cpu) => { cpu.a = cpu.opADC8(cpu.a, cpu.fetchByte()); };
// ORA imm
PAGE1_OPS[0x8A] = (cpu) => { cpu.a = cpu.opOR8(cpu.a, cpu.fetchByte()); };
// ADDA imm
PAGE1_OPS[0x8B] = (cpu) => { cpu.a = cpu.opADD8(cpu.a, cpu.fetchByte()); };
// CMPX imm
PAGE1_OPS[0x8C] = (cpu) => { cpu.opCMP16(cpu.x, cpu.fetchWord()); };
// BSR (branch to subroutine)
PAGE1_OPS[0x8D] = (cpu) => {
    const offset = cpu.sign8(cpu.fetchByte());
    cpu._saveRegisters('s', 0x80);
    cpu.pc = (cpu.pc + offset) & 0xFFFF;
};
// LDX imm
PAGE1_OPS[0x8E] = (cpu) => { cpu.x = cpu.opLD16(cpu.fetchWord()); };
// 0x8F: STX imm - illegal

// -----------------------------------------------------------------
// $90-$9F: Direct addressing
// -----------------------------------------------------------------
// SUBA dir
PAGE1_OPS[0x90] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opSUB8(cpu.a, cpu.read(a)); };
// CMPA dir
PAGE1_OPS[0x91] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP8(cpu.a, cpu.read(a)); };
// SBCA dir
PAGE1_OPS[0x92] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opSBC8(cpu.a, cpu.read(a)); };
// SUBD dir
PAGE1_OPS[0x93] = (cpu) => { const a = cpu.addrDirect(); cpu.d = cpu.opSUB16(cpu.d, cpu.read16(a)); };
// ANDA dir
PAGE1_OPS[0x94] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opAND8(cpu.a, cpu.read(a)); };
// BITA dir
PAGE1_OPS[0x95] = (cpu) => { const a = cpu.addrDirect(); cpu.opBIT8(cpu.a, cpu.read(a)); };
// LDA dir
PAGE1_OPS[0x96] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opLD8(cpu.read(a)); };
// STA dir
PAGE1_OPS[0x97] = (cpu) => { const a = cpu.addrDirect(); cpu.write(a, cpu.opST8(cpu.a)); };
// EORA dir
PAGE1_OPS[0x98] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opEOR8(cpu.a, cpu.read(a)); };
// ADCA dir
PAGE1_OPS[0x99] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opADC8(cpu.a, cpu.read(a)); };
// ORA dir
PAGE1_OPS[0x9A] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opOR8(cpu.a, cpu.read(a)); };
// ADDA dir
PAGE1_OPS[0x9B] = (cpu) => { const a = cpu.addrDirect(); cpu.a = cpu.opADD8(cpu.a, cpu.read(a)); };
// CMPX dir
PAGE1_OPS[0x9C] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP16(cpu.x, cpu.read16(a)); };
// JSR direct
PAGE1_OPS[0x9D] = (cpu) => {
    const a = cpu.addrDirect();
    cpu._saveRegisters('s', 0x80);
    cpu.pc = a;
};
// LDX dir
PAGE1_OPS[0x9E] = (cpu) => { const a = cpu.addrDirect(); cpu.x = cpu.opLD16(cpu.read16(a)); };
// STX dir
PAGE1_OPS[0x9F] = (cpu) => { const a = cpu.addrDirect(); const v = cpu.opST16(cpu.x); cpu.write16(a, v); };

// -----------------------------------------------------------------
// $A0-$AF: Indexed addressing
// -----------------------------------------------------------------
// SUBA idx
PAGE1_OPS[0xA0] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opSUB8(cpu.a, cpu.read(a)); };
// CMPA idx
PAGE1_OPS[0xA1] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP8(cpu.a, cpu.read(a)); };
// SBCA idx
PAGE1_OPS[0xA2] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opSBC8(cpu.a, cpu.read(a)); };
// SUBD idx
PAGE1_OPS[0xA3] = (cpu) => { const a = cpu.addrIndexed(); cpu.d = cpu.opSUB16(cpu.d, cpu.read16(a)); };
// ANDA idx
PAGE1_OPS[0xA4] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opAND8(cpu.a, cpu.read(a)); };
// BITA idx
PAGE1_OPS[0xA5] = (cpu) => { const a = cpu.addrIndexed(); cpu.opBIT8(cpu.a, cpu.read(a)); };
// LDA idx
PAGE1_OPS[0xA6] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opLD8(cpu.read(a)); };
// STA idx
PAGE1_OPS[0xA7] = (cpu) => { const a = cpu.addrIndexed(); cpu.write(a, cpu.opST8(cpu.a)); };
// EORA idx
PAGE1_OPS[0xA8] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opEOR8(cpu.a, cpu.read(a)); };
// ADCA idx
PAGE1_OPS[0xA9] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opADC8(cpu.a, cpu.read(a)); };
// ORA idx
PAGE1_OPS[0xAA] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opOR8(cpu.a, cpu.read(a)); };
// ADDA idx
PAGE1_OPS[0xAB] = (cpu) => { const a = cpu.addrIndexed(); cpu.a = cpu.opADD8(cpu.a, cpu.read(a)); };
// CMPX idx
PAGE1_OPS[0xAC] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP16(cpu.x, cpu.read16(a)); };
// JSR indexed
PAGE1_OPS[0xAD] = (cpu) => {
    const a = cpu.addrIndexed();
    cpu._saveRegisters('s', 0x80);
    cpu.pc = a;
};
// LDX idx
PAGE1_OPS[0xAE] = (cpu) => { const a = cpu.addrIndexed(); cpu.x = cpu.opLD16(cpu.read16(a)); };
// STX idx
PAGE1_OPS[0xAF] = (cpu) => { const a = cpu.addrIndexed(); const v = cpu.opST16(cpu.x); cpu.write16(a, v); };

// -----------------------------------------------------------------
// $B0-$BF: Extended addressing
// -----------------------------------------------------------------
// SUBA ext
PAGE1_OPS[0xB0] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opSUB8(cpu.a, cpu.read(a)); };
// CMPA ext
PAGE1_OPS[0xB1] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP8(cpu.a, cpu.read(a)); };
// SBCA ext
PAGE1_OPS[0xB2] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opSBC8(cpu.a, cpu.read(a)); };
// SUBD ext
PAGE1_OPS[0xB3] = (cpu) => { const a = cpu.addrExtended(); cpu.d = cpu.opSUB16(cpu.d, cpu.read16(a)); };
// ANDA ext
PAGE1_OPS[0xB4] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opAND8(cpu.a, cpu.read(a)); };
// BITA ext
PAGE1_OPS[0xB5] = (cpu) => { const a = cpu.addrExtended(); cpu.opBIT8(cpu.a, cpu.read(a)); };
// LDA ext
PAGE1_OPS[0xB6] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opLD8(cpu.read(a)); };
// STA ext
PAGE1_OPS[0xB7] = (cpu) => { const a = cpu.addrExtended(); cpu.write(a, cpu.opST8(cpu.a)); };
// EORA ext
PAGE1_OPS[0xB8] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opEOR8(cpu.a, cpu.read(a)); };
// ADCA ext
PAGE1_OPS[0xB9] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opADC8(cpu.a, cpu.read(a)); };
// ORA ext
PAGE1_OPS[0xBA] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opOR8(cpu.a, cpu.read(a)); };
// ADDA ext
PAGE1_OPS[0xBB] = (cpu) => { const a = cpu.addrExtended(); cpu.a = cpu.opADD8(cpu.a, cpu.read(a)); };
// CMPX ext
PAGE1_OPS[0xBC] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP16(cpu.x, cpu.read16(a)); };
// JSR extended
PAGE1_OPS[0xBD] = (cpu) => {
    const a = cpu.addrExtended();
    cpu._saveRegisters('s', 0x80);
    cpu.pc = a;
};
// LDX ext
PAGE1_OPS[0xBE] = (cpu) => { const a = cpu.addrExtended(); cpu.x = cpu.opLD16(cpu.read16(a)); };
// STX ext
PAGE1_OPS[0xBF] = (cpu) => { const a = cpu.addrExtended(); const v = cpu.opST16(cpu.x); cpu.write16(a, v); };

// -----------------------------------------------------------------
// $C0-$CF: Immediate operand
// -----------------------------------------------------------------
// SUBB imm
PAGE1_OPS[0xC0] = (cpu) => { cpu.b = cpu.opSUB8(cpu.b, cpu.fetchByte()); };
// CMPB imm
PAGE1_OPS[0xC1] = (cpu) => { cpu.opCMP8(cpu.b, cpu.fetchByte()); };
// SBCB imm
PAGE1_OPS[0xC2] = (cpu) => { cpu.b = cpu.opSBC8(cpu.b, cpu.fetchByte()); };
// ADDD imm
PAGE1_OPS[0xC3] = (cpu) => { cpu.d = cpu.opADD16(cpu.d, cpu.fetchWord()); };
// ANDB imm
PAGE1_OPS[0xC4] = (cpu) => { cpu.b = cpu.opAND8(cpu.b, cpu.fetchByte()); };
// BITB imm
PAGE1_OPS[0xC5] = (cpu) => { cpu.opBIT8(cpu.b, cpu.fetchByte()); };
// LDB imm
PAGE1_OPS[0xC6] = (cpu) => { cpu.b = cpu.opLD8(cpu.fetchByte()); };
// 0xC7: STB imm - illegal
// EORB imm
PAGE1_OPS[0xC8] = (cpu) => { cpu.b = cpu.opEOR8(cpu.b, cpu.fetchByte()); };
// ADCB imm
PAGE1_OPS[0xC9] = (cpu) => { cpu.b = cpu.opADC8(cpu.b, cpu.fetchByte()); };
// ORB imm
PAGE1_OPS[0xCA] = (cpu) => { cpu.b = cpu.opOR8(cpu.b, cpu.fetchByte()); };
// ADDB imm
PAGE1_OPS[0xCB] = (cpu) => { cpu.b = cpu.opADD8(cpu.b, cpu.fetchByte()); };
// LDD imm
PAGE1_OPS[0xCC] = (cpu) => { cpu.d = cpu.opLD16(cpu.fetchWord()); };
// 0xCD: illegal
// LDU imm
PAGE1_OPS[0xCE] = (cpu) => { cpu.u = cpu.opLD16(cpu.fetchWord()); };
// 0xCF: STU imm - illegal

// -----------------------------------------------------------------
// $D0-$DF: Direct addressing
// -----------------------------------------------------------------
// SUBB dir
PAGE1_OPS[0xD0] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opSUB8(cpu.b, cpu.read(a)); };
// CMPB dir
PAGE1_OPS[0xD1] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP8(cpu.b, cpu.read(a)); };
// SBCB dir
PAGE1_OPS[0xD2] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opSBC8(cpu.b, cpu.read(a)); };
// ADDD dir
PAGE1_OPS[0xD3] = (cpu) => { const a = cpu.addrDirect(); cpu.d = cpu.opADD16(cpu.d, cpu.read16(a)); };
// ANDB dir
PAGE1_OPS[0xD4] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opAND8(cpu.b, cpu.read(a)); };
// BITB dir
PAGE1_OPS[0xD5] = (cpu) => { const a = cpu.addrDirect(); cpu.opBIT8(cpu.b, cpu.read(a)); };
// LDB dir
PAGE1_OPS[0xD6] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opLD8(cpu.read(a)); };
// STB dir
PAGE1_OPS[0xD7] = (cpu) => { const a = cpu.addrDirect(); cpu.write(a, cpu.opST8(cpu.b)); };
// EORB dir
PAGE1_OPS[0xD8] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opEOR8(cpu.b, cpu.read(a)); };
// ADCB dir
PAGE1_OPS[0xD9] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opADC8(cpu.b, cpu.read(a)); };
// ORB dir
PAGE1_OPS[0xDA] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opOR8(cpu.b, cpu.read(a)); };
// ADDB dir
PAGE1_OPS[0xDB] = (cpu) => { const a = cpu.addrDirect(); cpu.b = cpu.opADD8(cpu.b, cpu.read(a)); };
// LDD dir
PAGE1_OPS[0xDC] = (cpu) => { const a = cpu.addrDirect(); cpu.d = cpu.opLD16(cpu.read16(a)); };
// STD dir
PAGE1_OPS[0xDD] = (cpu) => { const a = cpu.addrDirect(); const v = cpu.opST16(cpu.d); cpu.write16(a, v); };
// LDU dir
PAGE1_OPS[0xDE] = (cpu) => { const a = cpu.addrDirect(); cpu.u = cpu.opLD16(cpu.read16(a)); };
// STU dir
PAGE1_OPS[0xDF] = (cpu) => { const a = cpu.addrDirect(); const v = cpu.opST16(cpu.u); cpu.write16(a, v); };

// -----------------------------------------------------------------
// $E0-$EF: Indexed addressing
// -----------------------------------------------------------------
// SUBB idx
PAGE1_OPS[0xE0] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opSUB8(cpu.b, cpu.read(a)); };
// CMPB idx
PAGE1_OPS[0xE1] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP8(cpu.b, cpu.read(a)); };
// SBCB idx
PAGE1_OPS[0xE2] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opSBC8(cpu.b, cpu.read(a)); };
// ADDD idx
PAGE1_OPS[0xE3] = (cpu) => { const a = cpu.addrIndexed(); cpu.d = cpu.opADD16(cpu.d, cpu.read16(a)); };
// ANDB idx
PAGE1_OPS[0xE4] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opAND8(cpu.b, cpu.read(a)); };
// BITB idx
PAGE1_OPS[0xE5] = (cpu) => { const a = cpu.addrIndexed(); cpu.opBIT8(cpu.b, cpu.read(a)); };
// LDB idx
PAGE1_OPS[0xE6] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opLD8(cpu.read(a)); };
// STB idx
PAGE1_OPS[0xE7] = (cpu) => { const a = cpu.addrIndexed(); cpu.write(a, cpu.opST8(cpu.b)); };
// EORB idx
PAGE1_OPS[0xE8] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opEOR8(cpu.b, cpu.read(a)); };
// ADCB idx
PAGE1_OPS[0xE9] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opADC8(cpu.b, cpu.read(a)); };
// ORB idx
PAGE1_OPS[0xEA] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opOR8(cpu.b, cpu.read(a)); };
// ADDB idx
PAGE1_OPS[0xEB] = (cpu) => { const a = cpu.addrIndexed(); cpu.b = cpu.opADD8(cpu.b, cpu.read(a)); };
// LDD idx
PAGE1_OPS[0xEC] = (cpu) => { const a = cpu.addrIndexed(); cpu.d = cpu.opLD16(cpu.read16(a)); };
// STD idx
PAGE1_OPS[0xED] = (cpu) => { const a = cpu.addrIndexed(); const v = cpu.opST16(cpu.d); cpu.write16(a, v); };
// LDU idx
PAGE1_OPS[0xEE] = (cpu) => { const a = cpu.addrIndexed(); cpu.u = cpu.opLD16(cpu.read16(a)); };
// STU idx
PAGE1_OPS[0xEF] = (cpu) => { const a = cpu.addrIndexed(); const v = cpu.opST16(cpu.u); cpu.write16(a, v); };

// -----------------------------------------------------------------
// $F0-$FF: Extended addressing
// -----------------------------------------------------------------
// SUBB ext
PAGE1_OPS[0xF0] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opSUB8(cpu.b, cpu.read(a)); };
// CMPB ext
PAGE1_OPS[0xF1] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP8(cpu.b, cpu.read(a)); };
// SBCB ext
PAGE1_OPS[0xF2] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opSBC8(cpu.b, cpu.read(a)); };
// ADDD ext
PAGE1_OPS[0xF3] = (cpu) => { const a = cpu.addrExtended(); cpu.d = cpu.opADD16(cpu.d, cpu.read16(a)); };
// ANDB ext
PAGE1_OPS[0xF4] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opAND8(cpu.b, cpu.read(a)); };
// BITB ext
PAGE1_OPS[0xF5] = (cpu) => { const a = cpu.addrExtended(); cpu.opBIT8(cpu.b, cpu.read(a)); };
// LDB ext
PAGE1_OPS[0xF6] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opLD8(cpu.read(a)); };
// STB ext
PAGE1_OPS[0xF7] = (cpu) => { const a = cpu.addrExtended(); cpu.write(a, cpu.opST8(cpu.b)); };
// EORB ext
PAGE1_OPS[0xF8] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opEOR8(cpu.b, cpu.read(a)); };
// ADCB ext
PAGE1_OPS[0xF9] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opADC8(cpu.b, cpu.read(a)); };
// ORB ext
PAGE1_OPS[0xFA] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opOR8(cpu.b, cpu.read(a)); };
// ADDB ext
PAGE1_OPS[0xFB] = (cpu) => { const a = cpu.addrExtended(); cpu.b = cpu.opADD8(cpu.b, cpu.read(a)); };
// LDD ext
PAGE1_OPS[0xFC] = (cpu) => { const a = cpu.addrExtended(); cpu.d = cpu.opLD16(cpu.read16(a)); };
// STD ext
PAGE1_OPS[0xFD] = (cpu) => { const a = cpu.addrExtended(); const v = cpu.opST16(cpu.d); cpu.write16(a, v); };
// LDU ext
PAGE1_OPS[0xFE] = (cpu) => { const a = cpu.addrExtended(); cpu.u = cpu.opLD16(cpu.read16(a)); };
// STU ext
PAGE1_OPS[0xFF] = (cpu) => { const a = cpu.addrExtended(); const v = cpu.opST16(cpu.u); cpu.write16(a, v); };

// Illegal/undefined opcode fallback
const PAGE1_UNDEFINED = (cpu) => { cpu.instrCycles = 2; };

for (let op = 0; op < 256; op++) {
    if (PAGE1_OPS[op] === undefined) PAGE1_OPS[op] = PAGE1_UNDEFINED;
}

// =============================================================================
// Page 2 ($10xx) and page 3 ($11xx) instructions: one function per opcode,
// called as PAGE2_OPS[opcode](cpu) / PAGE3_OPS[opcode](cpu) after
// _execPage2 / _execPage3 has set the base cycle count. Only the opcodes in
// PAGE2_DEFINED / PAGE3_DEFINED reach them (exec() runs any other byte as
// the page 1 instruction); the rest of each table does nothing.
// =============================================================================

const PAGE_NOTHING = () => {};
const PAGE2_OPS = new Array(256).fill(PAGE_NOTHING);
const PAGE3_OPS = new Array(256).fill(PAGE_NOTHING);

// Long branches (16-bit relative offset)
PAGE2_OPS[0x21] = (cpu) => { cpu.branchLong(false); };                          // LBRN
PAGE2_OPS[0x22] = (cpu) => { cpu.branchLong(!(cpu.cc & (CC_C | CC_Z))); };      // LBHI
PAGE2_OPS[0x23] = (cpu) => { cpu.branchLong(!!(cpu.cc & (CC_C | CC_Z))); };     // LBLS
PAGE2_OPS[0x24] = (cpu) => { cpu.branchLong(!(cpu.cc & CC_C)); };               // LBCC/LBHS
PAGE2_OPS[0x25] = (cpu) => { cpu.branchLong(!!(cpu.cc & CC_C)); };              // LBCS/LBLO
PAGE2_OPS[0x26] = (cpu) => { cpu.branchLong(!(cpu.cc & CC_Z)); };               // LBNE
PAGE2_OPS[0x27] = (cpu) => { cpu.branchLong(!!(cpu.cc & CC_Z)); };              // LBEQ
PAGE2_OPS[0x28] = (cpu) => { cpu.branchLong(!(cpu.cc & CC_V)); };               // LBVC
PAGE2_OPS[0x29] = (cpu) => { cpu.branchLong(!!(cpu.cc & CC_V)); };              // LBVS
PAGE2_OPS[0x2A] = (cpu) => { cpu.branchLong(!(cpu.cc & CC_N)); };               // LBPL
PAGE2_OPS[0x2B] = (cpu) => { cpu.branchLong(!!(cpu.cc & CC_N)); };              // LBMI
PAGE2_OPS[0x2C] = (cpu) => {                                                    // LBGE
    cpu.branchLong(((cpu.cc & CC_N) ? 1 : 0) === ((cpu.cc & CC_V) ? 1 : 0));
};
PAGE2_OPS[0x2D] = (cpu) => {                                                    // LBLT
    cpu.branchLong(((cpu.cc & CC_N) ? 1 : 0) !== ((cpu.cc & CC_V) ? 1 : 0));
};
PAGE2_OPS[0x2E] = (cpu) => {                                                    // LBGT
    cpu.branchLong(!(cpu.cc & CC_Z) &&
        (((cpu.cc & CC_N) ? 1 : 0) === ((cpu.cc & CC_V) ? 1 : 0)));
};
PAGE2_OPS[0x2F] = (cpu) => {                                                    // LBLE
    cpu.branchLong(!!(cpu.cc & CC_Z) ||
        (((cpu.cc & CC_N) ? 1 : 0) !== ((cpu.cc & CC_V) ? 1 : 0)));
};

// SWI2
PAGE2_OPS[0x3F] = (cpu) => {
    cpu.cc |= CC_E;
    cpu._saveRegisters('s', 0xFF);
    cpu.pc = cpu.read16(VEC_SWI2);
};

// CMPD (compare D register)
PAGE2_OPS[0x83] = (cpu) => { cpu.opCMP16(cpu.d, cpu.fetchWord()); };                                  // CMPD imm
PAGE2_OPS[0x93] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP16(cpu.d, cpu.read16(a)); };       // CMPD dir
PAGE2_OPS[0xA3] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP16(cpu.d, cpu.read16(a)); };      // CMPD idx
PAGE2_OPS[0xB3] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP16(cpu.d, cpu.read16(a)); };     // CMPD ext

// LDY
PAGE2_OPS[0x8E] = (cpu) => { cpu.y = cpu.opLD16(cpu.fetchWord()); };                                  // LDY imm
PAGE2_OPS[0x9E] = (cpu) => { const a = cpu.addrDirect(); cpu.y = cpu.opLD16(cpu.read16(a)); };       // LDY dir
PAGE2_OPS[0xAE] = (cpu) => { const a = cpu.addrIndexed(); cpu.y = cpu.opLD16(cpu.read16(a)); };      // LDY idx
PAGE2_OPS[0xBE] = (cpu) => { const a = cpu.addrExtended(); cpu.y = cpu.opLD16(cpu.read16(a)); };     // LDY ext

// STY
PAGE2_OPS[0x9F] = (cpu) => { const a = cpu.addrDirect(); const v = cpu.opST16(cpu.y); cpu.write16(a, v); };     // STY dir
PAGE2_OPS[0xAF] = (cpu) => { const a = cpu.addrIndexed(); const v = cpu.opST16(cpu.y); cpu.write16(a, v); };    // STY idx
PAGE2_OPS[0xBF] = (cpu) => { const a = cpu.addrExtended(); const v = cpu.opST16(cpu.y); cpu.write16(a, v); };   // STY ext

// CMPY
PAGE2_OPS[0x8C] = (cpu) => { cpu.opCMP16(cpu.y, cpu.fetchWord()); };                                  // CMPY imm
PAGE2_OPS[0x9C] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP16(cpu.y, cpu.read16(a)); };       // CMPY dir
PAGE2_OPS[0xAC] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP16(cpu.y, cpu.read16(a)); };      // CMPY idx
PAGE2_OPS[0xBC] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP16(cpu.y, cpu.read16(a)); };     // CMPY ext

// LDS (also arms NMI)
PAGE2_OPS[0xCE] = (cpu) => { cpu.s = cpu.opLD16(cpu.fetchWord()); cpu.nmiArmed = true; };                                  // LDS imm
PAGE2_OPS[0xDE] = (cpu) => { const a = cpu.addrDirect(); cpu.s = cpu.opLD16(cpu.read16(a)); cpu.nmiArmed = true; };       // LDS dir
PAGE2_OPS[0xEE] = (cpu) => { const a = cpu.addrIndexed(); cpu.s = cpu.opLD16(cpu.read16(a)); cpu.nmiArmed = true; };      // LDS idx
PAGE2_OPS[0xFE] = (cpu) => { const a = cpu.addrExtended(); cpu.s = cpu.opLD16(cpu.read16(a)); cpu.nmiArmed = true; };     // LDS ext

// STS
PAGE2_OPS[0xDF] = (cpu) => { const a = cpu.addrDirect(); const v = cpu.opST16(cpu.s); cpu.write16(a, v); };     // STS dir
PAGE2_OPS[0xEF] = (cpu) => { const a = cpu.addrIndexed(); const v = cpu.opST16(cpu.s); cpu.write16(a, v); };    // STS idx
PAGE2_OPS[0xFF] = (cpu) => { const a = cpu.addrExtended(); const v = cpu.opST16(cpu.s); cpu.write16(a, v); };   // STS ext

// SWI3
PAGE3_OPS[0x3F] = (cpu) => {
    cpu.cc |= CC_E;
    cpu._saveRegisters('s', 0xFF);
    cpu.pc = cpu.read16(VEC_SWI3);
};

// CMPU
PAGE3_OPS[0x83] = (cpu) => { cpu.opCMP16(cpu.u, cpu.fetchWord()); };                                  // CMPU imm
PAGE3_OPS[0x93] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP16(cpu.u, cpu.read16(a)); };       // CMPU dir
PAGE3_OPS[0xA3] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP16(cpu.u, cpu.read16(a)); };      // CMPU idx
PAGE3_OPS[0xB3] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP16(cpu.u, cpu.read16(a)); };     // CMPU ext

// CMPS
PAGE3_OPS[0x8C] = (cpu) => { cpu.opCMP16(cpu.s, cpu.fetchWord()); };                                  // CMPS imm
PAGE3_OPS[0x9C] = (cpu) => { const a = cpu.addrDirect(); cpu.opCMP16(cpu.s, cpu.read16(a)); };       // CMPS dir
PAGE3_OPS[0xAC] = (cpu) => { const a = cpu.addrIndexed(); cpu.opCMP16(cpu.s, cpu.read16(a)); };      // CMPS idx
PAGE3_OPS[0xBC] = (cpu) => { const a = cpu.addrExtended(); cpu.opCMP16(cpu.s, cpu.read16(a)); };     // CMPS ext
