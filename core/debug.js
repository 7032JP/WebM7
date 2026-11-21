// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// debug.js — stopping, stepping and looking into the machine for a debugger
//            (no UI, no DOM)
//
//   Threads: the main CPU is thread 1 and the sub CPU thread 2. A stop of
//   either stops the whole machine (the CPUs, the timers and the sound),
//   because nothing runs while FM7.halted is true: scheduler.runFor runs
//   nothing and returns 0, so a host that calls runFor once per frame keeps
//   calling it and only the time stops.
//
//   The machine calls a hook (FM7.pcHook, FM7.subPcHook) before each pass of
//   a CPU only while there is something to check for it. Without one the run
//   loop pays one test per pass. Watched memory (data breakpoints) goes
//   through FM7.setWatch, which costs nothing while nothing is watched.
//
//   Breakpoints are checked against the PC at the start of an instruction the
//   CPU is about to execute; a pass that takes an interrupt (or waits in
//   SYNC / CWAI) executes no instruction and is not checked. A stop ends the
//   run before that instruction.
//
//   Resuming skips the checks once, for the instruction at the PC each CPU
//   stopped at, so that the run does not stop again where it stopped. This
//   holds only for the first instruction the CPU executes after the resume
//   (when an interrupt is taken first, the handler's first instruction is
//   checked). Later visits to the same PC stop as usual.
//
//   A data breakpoint stops after the instruction that made the access,
//   before the next pass of either CPU. Instruction fetches count as reads.
//
//   The call stack is kept while call tracking is on: a call (JSR / BSR /
//   LBSR), a software interrupt and an accepted interrupt add a frame, and a
//   frame goes when S rises above the value it had just after the entry.
//
//   Memory goes through FM7.peekMain / pokeMain and peekSub / pokeSub: the
//   I/O areas read $FF and are not written.
// =============================================================================

import { decodeInstruction, listInstructions, codeClass, CODE_CALL, CODE_SWI, CODE_RETURN, CODE_UNDEFINED } from './disasm6809.js';
import { compileExpression, fillLogText } from './debug_expr.js';
import { CC_FLAGS, VECTOR_ADDRESSES } from './isa_tables.generated.js';

export const THREAD_MAIN = 1;
export const THREAD_SUB = 2;

/** The registers getRegisters() returns and setRegisters() accepts, with their widths. */
const REGISTER_MASKS = { a: 0xFF, b: 0xFF, x: 0xFFFF, y: 0xFFFF, u: 0xFFFF, s: 0xFFFF, pc: 0xFFFF, dp: 0xFF, cc: 0xFF };
/** Order the registers are listed in. */
const REGISTER_ORDER = ['pc', 'a', 'b', 'd', 'x', 'y', 'u', 's', 'dp', 'cc'];

/** Longest emulated time one stepIn() may run before it gives up (µs). */
const STEP_LIMIT_US = 2_000_000;
/** Emulated time a step over, a step out or a run to an address runs before it returns and lets the host run on (µs). */
const QUICK_RUN_US = 100_000;
/** Slice of emulated time a step runs per call of the run loop (µs). */
const STEP_SLICE_US = 1000;

/** The stops on exceptions a debugger can choose. */
export const EXCEPTION_FILTERS = [
    { filter: 'undefined', label: 'Undefined code', description: 'Stop before a code the CPU does not define' },
    { filter: 'swi', label: 'SWI / SWI2 / SWI3', description: 'Stop before a software interrupt' },
    { filter: 'irq', label: 'IRQ', description: 'Stop at the handler after an IRQ is accepted' },
    { filter: 'firq', label: 'FIRQ', description: 'Stop at the handler after an FIRQ is accepted' },
    { filter: 'nmi', label: 'NMI', description: 'Stop at the handler after an NMI is accepted' },
];
const INTERRUPT_KIND = new Map([[VECTOR_ADDRESSES.NMI, 'nmi'], [VECTOR_ADDRESSES.FIRQ, 'firq'], [VECTOR_ADDRESSES.IRQ, 'irq']]);
const EXCEPTION_TEXT = { undefined: 'Undefined code', swi: 'Software interrupt', irq: 'IRQ accepted', firq: 'FIRQ accepted', nmi: 'NMI accepted' };

const hex4 = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const hex2 = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');

/**
 * Parse a LOADM image: blocks of 00 / length (2) / address (2) / data,
 * then FF 00 00 / execution address (2).
 * @param {Uint8Array} bytes
 * @returns {{ entry: number, blocks: { addr: number, length: number, offset: number }[] }} entry is the execution address
 */
export function parseLoadM(bytes) {
    const blocks = [];
    let i = 0;
    while (i + 5 <= bytes.length) {
        const kind = bytes[i];
        const length = (bytes[i + 1] << 8) | bytes[i + 2];
        const addr = (bytes[i + 3] << 8) | bytes[i + 4];
        if (kind === 0xFF) return { entry: addr, blocks };
        if (kind !== 0x00) throw new Error(`not a LOADM image (byte ${i} is ${kind})`);
        if (i + 5 + length > bytes.length) throw new Error(`LOADM block at byte ${i} runs past the end`);
        blocks.push({ addr, length, offset: i + 5 });
        i += 5 + length;
    }
    throw new Error('LOADM image has no end block');
}

/**
 * A hit condition: "N" or ">=N" stops from the Nth hit on, "==N" only on the
 * Nth, ">N", "<N", "<=N" as written, "%N" on every Nth.
 * @returns {(hits: number) => boolean}
 */
export function parseHitCondition(text) {
    const m = /^\s*(>=|==|<=|>|<|%)?\s*(\d+)\s*$/.exec(String(text));
    if (!m) throw new Error(`hit condition '${text}' is not understood`);
    const n = Number(m[2]);
    switch (m[1] || '>=') {
        case '>=': return (h) => h >= n;
        case '==': return (h) => h === n;
        case '<=': return (h) => h <= n;
        case '>': return (h) => h > n;
        case '<': return (h) => h < n;
        default: return (h) => n > 0 && h % n === 0;
    }
}

function registerValue(cpu, name) {
    if (name === 'd') return (cpu.a << 8) | cpu.b;
    return cpu[name];
}

/** What the debugger keeps for one CPU. */
class ThreadState {
    constructor(id, name, cpu, peek, poke) {
        this.id = id;
        this.name = name;
        this.cpu = cpu;
        this.peek = peek;
        this.poke = poke;
        // Reads that take the CPU's direct pages first (no side effect either way).
        this.read = (a) => {
            const page = cpu.readPages[a >> 8];
            return page !== null ? page[a & 0xFF] : peek(a);
        };
        this.context = { reg: (n) => registerValue(cpu, n), peek };
        this.breaks = new Uint8Array(0x10000);   // 1 where an enabled breakpoint is
        this.codeBreaks = new Map();            // addr -> breakpoint
        this.clearRun();
        this.frames = [];          // call stack, outermost first
        this.pendingFrame = null;  // a frame whose entry is being executed
        this.entryException = null; // an interrupt was accepted for a stop at its handler
    }

    /** Forget what a run was asked to do. */
    clearRun() {
        this.skipPc = -1;      // PC not checked by the first instruction after a resume
        this.stepsLeft = -1;   // instructions still to execute in a step in; -1 for none
        this.over = null;      // step over: { ret, s }
        this.outS = -1;        // step out: S when it began; -1 for none
        this.outReturned = false;
        this.gotoAddr = -1;    // run to an address; -1 for none
    }

    get runArmed() {
        return this.stepsLeft >= 0 || this.over !== null || this.outS >= 0 || this.outReturned || this.gotoAddr >= 0;
    }
}

export class M7DebugSession {
    /** @param {object} fm7 the machine (FM7) */
    constructor(fm7) {
        this.fm7 = fm7;
        /** Called with the stop event { reason, thread, pc, description, hitBreakpointIds?, exception?, dataAccess? }. */
        this.onStop = null;
        /** Called with (text, thread) for a log message of a breakpoint. */
        this.onOutput = null;
        /** Called with no arguments when the machine runs again. */
        this.onContinue = null;
        this._threads = [
            new ThreadState(THREAD_MAIN, 'Main CPU', fm7.mainCPU, (a) => fm7.peekMain(a), (a, v) => fm7.pokeMain(a, v)),
            new ThreadState(THREAD_SUB, 'Sub CPU', fm7.subCPU, (a) => fm7.peekSub(a), (a, v) => fm7.pokeSub(a, v)),
        ];
        this._hooks = this._threads.map((t) => (cpu) => this._check(t, cpu));
        this._nextId = 1;
        this._stop = null;          // stop event set by a hook
        this._pendingStop = null;   // data breakpoint hit, stops before the next pass
        this._lastStop = null;
        this._exceptions = new Set();
        this._tracking = false;
        this._dataBreakpoints = [];
        this._attached = false;
    }

    /** True while the machine is stopped (FM7.halted). */
    get halted() { return this.fm7.halted; }

    _thread(id = THREAD_MAIN) {
        const t = this._threads[(id === THREAD_SUB) ? 1 : 0];
        return t;
    }

    /** @returns {{ id: number, name: string }[]} */
    threads() { return this._threads.map((t) => ({ id: t.id, name: t.name })); }

    // ---- attaching -------------------------------------------------------

    /** Take the machine's stop notice (once). */
    attach() {
        if (this._attached) return this;
        this._attached = true;
        this.fm7.onHalt = () => this._stopped();
        return this;
    }

    /** Let go of the machine: no hooks, no watches, no stop. */
    detach() {
        if (!this._attached) return;
        this._attached = false;
        this.fm7.onHalt = null;
        this.fm7.pcHook = null;
        this.fm7.subPcHook = null;
        this.fm7.setWatch(THREAD_MAIN, null);
        this.fm7.setWatch(THREAD_SUB, null);
        this.fm7.halted = false;
    }

    // ---- hooks -------------------------------------------------------------

    _updateHooks() {
        const always = this._exceptions.size > 0 || this._tracking || this._dataBreakpoints.length > 0 || this._pendingStop !== null;
        for (const t of this._threads) {
            const need = always || t.codeBreaks.size > 0 || t.runArmed || t.entryException !== null || t.pendingFrame !== null;
            t.wantsCode = this._tracking || t.outS >= 0 || this._exceptions.has('undefined') || this._exceptions.has('swi');
            const hook = need ? this._hooks[t.id - 1] : null;
            if (t.id === THREAD_MAIN) this.fm7.pcHook = hook;
            else this.fm7.subPcHook = hook;
        }
    }

    /** The hook of thread `t`: true ends the run before this pass. */
    _check(t, cpu) {
        if (this._pendingStop !== null) {
            const ev = this._pendingStop;
            this._pendingStop = null;
            ev.pc = this._thread(ev.thread).cpu.pc;
            ev.description += ` before ${hex4(ev.pc)}`;
            this._stop = ev;
            return true;
        }
        if (t.entryException !== null) {
            const kind = t.entryException;
            t.entryException = null;
            this._stop = { reason: 'exception', thread: t.id, pc: cpu.pc, exception: kind, description: EXCEPTION_TEXT[kind] };
            return true;
        }
        if (this._tracking) this._trackFrames(t, cpu);
        if (!cpu.nextPassExecutes()) {
            const vector = cpu.interruptToAccept();
            if (vector !== 0) {
                const kind = INTERRUPT_KIND.get(vector);
                if (this._tracking) t.pendingFrame = { kind, callerPc: cpu.pc, resumeAt: cpu.pc, entry: -1, sAfter: -1 };
                if (this._exceptions.has(kind)) t.entryException = kind;
                t.skipPc = -1;
            }
            return false;
        }
        const pc = cpu.pc;
        if (t.stepsLeft === 0 || t.outReturned || (t.over !== null && pc === t.over.ret && cpu.s >= t.over.s)) {
            this._stop = { reason: 'step', thread: t.id, pc };
            return true;
        }
        if (pc === t.gotoAddr) {
            this._stop = { reason: 'goto', thread: t.id, pc };
            return true;
        }
        const skip = t.skipPc;
        if (skip >= 0) t.skipPc = -1;
        const cls = t.wantsCode ? codeClass(t.read, pc) : 0;
        if (skip !== pc) {
            if (t.breaks[pc] && this._breakpointHit(t, pc)) return true;
            if ((cls === CODE_UNDEFINED && this._exceptions.has('undefined')) || (cls === CODE_SWI && this._exceptions.has('swi'))) {
                const kind = cls === CODE_SWI ? 'swi' : 'undefined';
                this._stop = { reason: 'exception', thread: t.id, pc, exception: kind, description: EXCEPTION_TEXT[kind] };
                return true;
            }
        }
        if (t.stepsLeft > 0) t.stepsLeft--;
        if (cls === CODE_RETURN && t.outS >= 0 && cpu.s >= t.outS) t.outReturned = true;
        if (this._tracking && (cls === CODE_CALL || cls === CODE_SWI)) {
            t.pendingFrame = { kind: cls === CODE_CALL ? 'call' : 'swi', callerPc: pc, resumeAt: -1, entry: -1, sAfter: -1 };
        }
        return false;
    }

    /** A breakpoint at `pc`: true when it stops the run. */
    _breakpointHit(t, pc) {
        const bp = t.codeBreaks.get(pc);
        if (!bp || !bp.enabled) return false;
        if (bp.condition) {
            let ok;
            try {
                ok = bp.condition(t.context) !== 0;
            } catch (e) {
                this._stop = { reason: 'breakpoint', thread: t.id, pc, hitBreakpointIds: [bp.id], description: `Condition error: ${e.message}` };
                return true;
            }
            if (!ok) return false;
        }
        bp.hits++;
        if (bp.hitTest && !bp.hitTest(bp.hits)) return false;
        if (bp.logMessage) {
            if (this.onOutput) this.onOutput(fillLogText(bp.logMessage, (e) => compileExpression(e)(t.context)), t.id);
            return false;
        }
        this._stop = { reason: 'breakpoint', thread: t.id, pc, hitBreakpointIds: [bp.id] };
        return true;
    }

    /** Call stack upkeep before a pass of thread `t`. */
    _trackFrames(t, cpu) {
        const f = t.pendingFrame;
        if (f !== null) {
            t.pendingFrame = null;
            f.entry = cpu.pc;
            f.sAfter = cpu.s;
            if (f.kind === 'call') f.resumeAt = (t.peek(cpu.s) << 8) | t.peek((cpu.s + 1) & 0xFFFF);
            else if (f.kind === 'swi') f.resumeAt = (t.peek((cpu.s + 10) & 0xFFFF) << 8) | t.peek((cpu.s + 11) & 0xFFFF);
            t.frames.push(f);
        }
        const frames = t.frames;
        while (frames.length > 0 && cpu.s > frames[frames.length - 1].sAfter) frames.pop();
        if (frames.length > 256) frames.splice(0, frames.length - 256);
    }

    _stopped() {
        const ev = this._stop || { reason: 'pause', thread: THREAD_MAIN, pc: this.fm7.mainCPU.pc };
        this._stop = null;
        this.fm7.halted = true;
        for (const t of this._threads) t.clearRun();
        this._updateHooks();
        if (!ev.description) ev.description = this._describe(ev);
        this._lastStop = ev;
        if (this.onStop) this.onStop(ev);
    }

    _describe(ev) {
        const where = `${this._thread(ev.thread).name} at ${hex4(ev.pc)}`;
        switch (ev.reason) {
            case 'breakpoint': return `Breakpoint (${where})`;
            case 'step': return `Step (${where})`;
            case 'goto': return `Reached the address (${where})`;
            case 'entry': return `Entry (${where})`;
            case 'data breakpoint': return `Data breakpoint (${where})`;
            default: return `Paused (${where})`;
        }
    }

    // ---- run control -----------------------------------------------------

    /** Stop now (between runs). Returns the stop event; nothing happens when already halted. */
    halt(reason = 'pause') {
        if (this.fm7.halted) return null;
        this._stop = { reason, thread: THREAD_MAIN, pc: this.fm7.mainCPU.pc };
        this._stopped();
        return this._lastStop;
    }

    pause() { return this.halt('pause'); }

    /** Let the machine run again. The instruction at each PC is not checked once. */
    resume() {
        if (!this.fm7.halted) return;
        this._letRun();
    }

    continue() { this.resume(); }

    _letRun(notify = true) {
        this.fm7.halted = false;
        for (const t of this._threads) t.skipPc = t.cpu.pc;
        this._updateHooks();
        if (notify && this.onContinue) this.onContinue();
    }

    /** Run a step that may take long: here for a while, then (still running) tell the host to run it on. */
    _runArmed() {
        this._letRun(false);
        const ev = this._runHere(QUICK_RUN_US);
        if (!ev && this.onContinue) this.onContinue();
        return ev;
    }

    _runHere(limitUs) {
        const fm7 = this.fm7;
        this._lastStop = null;
        for (let spent = 0; !fm7.halted && spent < limitUs; spent += STEP_SLICE_US) {
            fm7.scheduler.runFor(STEP_SLICE_US);
        }
        return fm7.halted ? this._lastStop : null;
    }

    _requireHalted(what) {
        if (!this.fm7.halted) throw new Error(`${what}: the machine is not halted`);
    }

    /**
     * Execute `count` instructions of a thread and stop before the next one
     * (reason 'step'), or earlier at a breakpoint. Only while halted. Runs
     * the machine here and now; gives up after STEP_LIMIT_US of emulated time
     * (a CPU waiting in SYNC / CWAI, or a sub CPU held by HALT) and stops there.
     * @returns {object} the stop event
     */
    stepIn(thread = THREAD_MAIN, count = 1) {
        this._requireHalted('step');
        const t = this._thread(thread);
        t.stepsLeft = Math.max(1, Math.floor(Number(count) || 1));
        this._letRun(false);
        const ev = this._runHere(STEP_LIMIT_US);
        if (ev) return ev;
        this._stop = { reason: 'step', thread: t.id, pc: t.cpu.pc };
        this._stopped();
        return this._lastStop;
    }

    /** `count` instructions of the main CPU (see stepIn). */
    step(count = 1) { return this.stepIn(THREAD_MAIN, count); }

    /**
     * Step over a call: when the next instruction calls a subroutine (or is
     * a software interrupt), run until it comes back with S where it was;
     * otherwise step in. Returns the stop event, or null when the machine
     * is still running (the host keeps running it; onStop tells the stop).
     */
    stepOver(thread = THREAD_MAIN) {
        this._requireHalted('step over');
        const t = this._thread(thread);
        const ins = decodeInstruction(t.peek, t.cpu.pc);
        if (ins.kind !== 'call' && ins.kind !== 'swi') return this.stepIn(thread);
        t.over = { ret: (t.cpu.pc + ins.length) & 0xFFFF, s: t.cpu.s };
        return this._runArmed();
    }

    /** Run until the current subroutine returns (see stepOver for the result). */
    stepOut(thread = THREAD_MAIN) {
        this._requireHalted('step out');
        const t = this._thread(thread);
        t.outS = t.cpu.s;
        return this._runArmed();
    }

    /** Run until the thread is about to execute the instruction at `addr` (reason 'goto'; see stepOver for the result). */
    runTo(addr, thread = THREAD_MAIN) {
        this._requireHalted('run to');
        const t = this._thread(thread);
        t.gotoAddr = Number(addr) & 0xFFFF;
        return this._runArmed();
    }

    /**
     * Reset the machine and run again from the start. The breakpoints stay;
     * their hit counts, the steps and the call stacks start again. With
     * stopOnEntry the machine stops before its first instruction ('entry').
     */
    restart({ stopOnEntry = false } = {}) {
        for (const t of this._threads) {
            t.clearRun();
            t.frames = [];
            t.pendingFrame = null;
            t.entryException = null;
            for (const bp of t.codeBreaks.values()) bp.hits = 0;
        }
        for (const d of this._dataBreakpoints) d.hits = 0;
        this._pendingStop = null;
        this._stop = null;
        this.fm7.halted = false;
        this.fm7.reset();
        this._updateHooks();
        if (stopOnEntry) return this.halt('entry');
        if (this.onContinue) this.onContinue();
        return null;
    }

    /** Forget the breakpoints, the data breakpoints and any stop (after a power cycle or a reset of the machine). */
    reset() {
        for (const t of this._threads) {
            this._setThreadBreakpoints(t, []);
            t.clearRun();
            t.frames = [];
            t.pendingFrame = null;
            t.entryException = null;
        }
        this.setDataBreakpoints([]);
        this._pendingStop = null;
        this._stop = null;
        this.fm7.halted = false;
        this._updateHooks();
    }

    // ---- breakpoints -----------------------------------------------------

    /** Replace the main CPU breakpoints with plain ones at `addrs`. */
    setBreakpoints(addrs) {
        this.setInstructionBreakpoints(THREAD_MAIN, [...addrs].map((addr) => ({ addr })));
    }

    get breakAddresses() { return [...this._thread(THREAD_MAIN).codeBreaks.keys()]; }

    /**
     * Replace the breakpoints of a thread.
     * @param {number} thread
     * @param {{ addr: number, enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string }[]} specs
     * @returns {{ id: number, addr: number, verified: boolean, message?: string }[]}
     */
    setInstructionBreakpoints(thread, specs) {
        return this._setThreadBreakpoints(this._thread(thread), specs);
    }

    _setThreadBreakpoints(t, specs) {
        for (const a of t.codeBreaks.keys()) t.breaks[a] = 0;
        t.codeBreaks.clear();
        const results = [];
        for (const spec of specs) {
            const addr = Number(spec.addr) & 0xFFFF;
            const bp = {
                id: this._nextId++, addr, enabled: spec.enabled !== false, hits: 0,
                conditionText: spec.condition || '', hitConditionText: spec.hitCondition || '', logMessage: spec.logMessage || '',
                condition: null, hitTest: null,
            };
            let message;
            try {
                if (bp.conditionText) bp.condition = compileExpression(bp.conditionText);
                if (bp.hitConditionText) bp.hitTest = parseHitCondition(bp.hitConditionText);
            } catch (e) {
                message = e.message;
            }
            if (message !== undefined) { results.push({ id: bp.id, addr, verified: false, message }); continue; }
            if (t.codeBreaks.has(addr)) { results.push({ id: t.codeBreaks.get(addr).id, addr, verified: true, message: 'same address as another breakpoint' }); continue; }
            t.codeBreaks.set(addr, bp);
            if (bp.enabled) t.breaks[addr] = 1;
            results.push({ id: bp.id, addr, verified: true });
        }
        // a resume made while there were none skipped nothing yet; it is over now
        if (!this.fm7.halted) t.skipPc = -1;
        this._updateHooks();
        return results;
    }

    /** The breakpoints of a thread, with their hit counts. */
    instructionBreakpoints(thread = THREAD_MAIN) {
        return [...this._thread(thread).codeBreaks.values()].map((bp) => ({
            id: bp.id, addr: bp.addr, enabled: bp.enabled, condition: bp.conditionText,
            hitCondition: bp.hitConditionText, logMessage: bp.logMessage, hits: bp.hits,
        }));
    }

    // ---- data breakpoints --------------------------------------------------

    /**
     * Which data breakpoint an expression names: its address in the thread.
     * @returns {{ dataId: string|null, description: string, accessTypes?: string[] }}
     */
    dataBreakpointInfo(expr, thread = THREAD_MAIN) {
        try {
            const addr = this.evaluate(expr, thread) & 0xFFFF;
            return { dataId: `${thread}:${addr}`, description: `${this._thread(thread).name} ${hex4(addr)}`, accessTypes: ['read', 'write', 'readWrite'] };
        } catch (e) {
            return { dataId: null, description: e.message };
        }
    }

    /**
     * Replace the data breakpoints.
     * @param {{ thread?: number, addr: number, length?: number, access?: 'read'|'write'|'readWrite',
     *   enabled?: boolean, condition?: string, hitCondition?: string }[]} specs
     * @returns {{ id: number, verified: boolean, message?: string }[]}
     */
    setDataBreakpoints(specs) {
        const results = [];
        const list = [];
        for (const spec of specs) {
            const d = {
                id: this._nextId++, thread: spec.thread === THREAD_SUB ? THREAD_SUB : THREAD_MAIN,
                addr: Number(spec.addr) & 0xFFFF, length: Math.max(1, Math.min(0x10000, Number(spec.length) || 1)),
                access: ['read', 'write', 'readWrite'].includes(spec.access) ? spec.access : 'write',
                enabled: spec.enabled !== false, hits: 0, conditionText: spec.condition || '', hitConditionText: spec.hitCondition || '',
                condition: null, hitTest: null,
            };
            try {
                if (d.conditionText) d.condition = compileExpression(d.conditionText);
                if (d.hitConditionText) d.hitTest = parseHitCondition(d.hitConditionText);
            } catch (e) {
                results.push({ id: d.id, verified: false, message: e.message });
                continue;
            }
            list.push(d);
            results.push({ id: d.id, verified: true });
        }
        this._dataBreakpoints = list;
        for (const t of this._threads) {
            const mine = list.filter((d) => d.thread === t.id && d.enabled);
            if (mine.length === 0) { this.fm7.setWatch(t.id, null); continue; }
            const kinds = new Uint8Array(0x10000);   // bit 0 read, bit 1 write
            const pages = new Uint8Array(256);
            for (const d of mine) {
                const bits = d.access === 'read' ? 1 : d.access === 'write' ? 2 : 3;
                for (let k = 0; k < d.length; k++) {
                    const a = (d.addr + k) & 0xFFFF;
                    kinds[a] |= bits;
                    pages[a >> 8] = 1;
                }
            }
            this.fm7.setWatch(t.id, { pages, onAccess: (addr, isWrite, value) => this._access(t, mine, kinds, addr, isWrite, value) });
        }
        this._updateHooks();
        return results;
    }

    get dataBreakpoints() {
        return this._dataBreakpoints.map((d) => ({
            id: d.id, thread: d.thread, addr: d.addr, length: d.length, access: d.access, enabled: d.enabled,
            condition: d.conditionText, hitCondition: d.hitConditionText, hits: d.hits,
        }));
    }

    _access(t, list, kinds, addr, isWrite, value) {
        const k = kinds[addr];
        if (k === 0 || (k & (isWrite ? 2 : 1)) === 0 || this._pendingStop !== null) return;
        for (const d of list) {
            if (((addr - d.addr) & 0xFFFF) >= d.length) continue;
            if (d.access === 'read' ? isWrite : d.access === 'write' ? !isWrite : false) continue;
            if (d.condition) {
                try { if (d.condition(t.context) === 0) continue; } catch { /* an error stops */ }
            }
            d.hits++;
            if (d.hitTest && !d.hitTest(d.hits)) continue;
            this._pendingStop = {
                reason: 'data breakpoint', thread: t.id, pc: t.cpu.pc, hitBreakpointIds: [d.id],
                dataAccess: { addr, write: isWrite, value: isWrite ? value : t.peek(addr) },
                description: `${isWrite ? 'Write' : 'Read'} ${hex4(addr)}${isWrite ? ` = ${hex2(value)}` : ''} (${t.name})`,
            };
            this._updateHooks();
            return;
        }
    }

    // ---- exceptions and call tracking ---------------------------------------

    /** Choose the stops on exceptions (ids of EXCEPTION_FILTERS). */
    setExceptionFilters(ids) {
        const known = new Set(EXCEPTION_FILTERS.map((f) => f.filter));
        this._exceptions = new Set([...ids].filter((id) => known.has(id)));
        this._updateHooks();
    }

    exceptionFilters() { return EXCEPTION_FILTERS.map((f) => ({ ...f, enabled: this._exceptions.has(f.filter) })); }

    /** Keep the call stacks (costs a check per pass while on). Turning it on starts them empty. */
    setCallTracking(on) {
        on = !!on;
        if (on === this._tracking) return;
        this._tracking = on;
        for (const t of this._threads) { t.frames = []; t.pendingFrame = null; }
        this._updateHooks();
    }

    get callTracking() { return this._tracking; }

    /**
     * Call stack of a thread, innermost first. The first frame is where the
     * CPU is now. Each frame tells the entry address of its routine when it is
     * known (entry, or -1), and how that routine was entered (kind: 'call',
     * 'swi', 'irq', 'firq', 'nmi', or 'top' for the outermost known one).
     */
    callFrames(thread = THREAD_MAIN) {
        const t = this._thread(thread);
        const frames = t.frames;
        const out = [];
        let pc = t.cpu.pc;
        for (let i = frames.length - 1; i >= -1; i--) {
            const f = i >= 0 ? frames[i] : null;
            const entry = f ? f.entry : -1;
            const kind = f ? f.kind : 'top';
            out.push({ id: out.length, pc, entry, kind, name: entry >= 0 ? `${hex4(entry)} (${kind})` : '(outermost)' });
            if (f) pc = f.callerPc;
        }
        return out;
    }

    // ---- registers -------------------------------------------------------

    getRegisters(thread = THREAD_MAIN) {
        const c = this._thread(thread).cpu;
        return { a: c.a, b: c.b, x: c.x, y: c.y, u: c.u, s: c.s, pc: c.pc, dp: c.dp, cc: c.cc, cycles: c.elapsedCycles };
    }

    /** Set some of a, b, d, x, y, u, s, pc, dp, cc. Other keys are ignored. */
    setRegisters(regs, thread = THREAD_MAIN) {
        const c = this._thread(thread).cpu;
        for (const [k, mask] of Object.entries(REGISTER_MASKS)) {
            if (regs[k] !== undefined && regs[k] !== null) c[k] = Number(regs[k]) & mask;
        }
        if (regs.d !== undefined && regs.d !== null) {
            const d = Number(regs.d) & 0xFFFF;
            c.a = d >> 8;
            c.b = d & 0xFF;
        }
    }

    setPC(addr, thread = THREAD_MAIN) { this.setRegisters({ pc: addr }, thread); }

    /**
     * Set one register by name (a, b, d, x, y, u, s, pc, dp, cc) or one CC bit
     * (cc.e ... cc.c, any non-zero value sets it). The value may be an expression.
     * @returns {number} the new value
     */
    writeRegister(name, value, thread = THREAD_MAIN) {
        const n = String(name).trim().toLowerCase();
        const v = typeof value === 'number' ? value : this.evaluate(String(value), thread);
        const c = this._thread(thread).cpu;
        const bit = /^cc\.([a-z])$/.exec(n);
        if (bit) {
            const flag = CC_FLAGS.find(([f]) => f.toLowerCase() === bit[1]);
            if (!flag) throw new Error(`no CC bit '${bit[1]}'`);
            c.cc = v ? (c.cc | flag[1]) : (c.cc & ~flag[1] & 0xFF);
            return v ? 1 : 0;
        }
        if (n !== 'd' && !(n in REGISTER_MASKS)) throw new Error(`no register '${name}'`);
        this.setRegisters({ [n]: v }, thread);
        return registerValue(c, n);
    }

    /**
     * The registers as variables: name, value text and number; CC has its bits as children.
     * @returns {{ name: string, value: string, number: number, children?: { name: string, value: string, number: number }[] }[]}
     */
    variables(thread = THREAD_MAIN) {
        const c = this._thread(thread).cpu;
        return REGISTER_ORDER.map((n) => {
            const v = registerValue(c, n);
            const wide = n === 'd' || REGISTER_MASKS[n] === 0xFFFF;
            const item = { name: n.toUpperCase(), value: wide ? hex4(v) : hex2(v), number: v };
            if (n === 'cc') item.children = CC_FLAGS.map(([f, bit]) => ({ name: f, value: (v & bit) ? '1' : '0', number: (v & bit) ? 1 : 0 }));
            return item;
        });
    }

    // ---- memory, code and expressions ---------------------------------------

    /** Read memory as the CPU of the thread sees it now (the I/O areas read $FF). */
    readMemory(addr, length, thread = THREAD_MAIN) {
        const t = this._thread(thread);
        const out = new Uint8Array(Math.max(0, length | 0));
        for (let k = 0; k < out.length; k++) out[k] = t.peek((addr + k) & 0xFFFF);
        return out;
    }

    /** Write memory as the CPU of the thread would (bytes for the I/O areas are dropped). */
    writeMemory(addr, bytes, thread = THREAD_MAIN) {
        const t = this._thread(thread);
        for (let k = 0; k < bytes.length; k++) t.poke((addr + k) & 0xFFFF, bytes[k]);
    }

    /** Instructions from `addr` (with `before` instructions in front of it). */
    listInstructions(addr, count, { thread = THREAD_MAIN, before = 0 } = {}) {
        return listInstructions(this._thread(thread).peek, Number(addr) & 0xFFFF, count, before);
    }

    /** Value of an expression over the registers and memory of a thread (see debug_expr.js). */
    evaluate(expr, thread = THREAD_MAIN) {
        return compileExpression(expr)(this._thread(thread).context);
    }

    loadBinary(bytes, org) {
        const start = Number(org) & 0xFFFF;
        this.writeMemory(start, bytes);
        return { start, end: start + bytes.length };
    }

    /** Write the blocks of a LOADM image. Returns the execution address and the blocks. */
    loadLoadM(bytes) {
        const { entry, blocks } = parseLoadM(bytes);
        for (const b of blocks) this.writeMemory(b.addr, bytes.subarray(b.offset, b.offset + b.length));
        return { entry, blocks: blocks.map((b) => ({ addr: b.addr, length: b.length })) };
    }
}
