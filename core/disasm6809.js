// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// disasm6809.js — reading 6809 code back as text (for a debugger)
//
//   The instruction set comes from isa_tables.generated.js, made from
//   isa/mc6809.yaml; nothing here lists the codes.
//
//   A $10 / $11 prefix followed by a byte that has no code on that page is
//   read the way the CPU runs it: as the page 1 instruction of that byte,
//   one byte longer, and marked undefinedCode. A page 1 byte with no code is
//   one byte, shown as FCB, and marked undefinedCode too.
// =============================================================================

import { CODE_PAGES, INDEX_FORMS, INDEX_BASES, TRANSFER_NAMES, STACK_ORDER_S, STACK_ORDER_U } from './isa_tables.generated.js';

/** Mnemonics that call a subroutine and come back after themselves. */
const CALL_NAMES = new Set(['JSR', 'BSR', 'LBSR']);
/** Software interrupts: they come back after themselves through RTI. */
const SOFTWARE_INTERRUPTS = new Set(['SWI', 'SWI2', 'SWI3']);
/** Unconditional jumps. */
const JUMP_NAMES = new Set(['JMP', 'BRA', 'LBRA']);

const hex2 = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const signedHex = (v) => (v < 0 ? '-' + hex2(-v) : hex2(v));
const signedHex16 = (v) => (v < 0 ? '-' + hex4(-v) : hex4(v));
const sign8 = (v) => (v & 0x80 ? v - 0x100 : v);
const sign16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

/** Register names of a PSH / PUL postbyte, in the order the bits are listed. */
function registerList(order, postbyte) {
    const names = [];
    for (const [bit, name] of order) if (postbyte & bit) names.push(name);
    return names.join(',');
}

/**
 * Operand of an indexed instruction whose postbyte is at `at`.
 * @returns {{ text: string, extra: number, undefinedCode: boolean, pcRelative: number }}
 *   extra: offset bytes after the postbyte; pcRelative: offset from the end of
 *   the instruction for the PCR forms, or null
 */
function indexedOperand(read, at, endBeforeOffset) {
    const pb = read(at & 0xFFFF);
    const base = INDEX_BASES[(pb >> 5) & 3];
    if ((pb & 0x80) === 0) {
        const n = pb & 0x10 ? (pb & 0x1F) - 0x20 : pb & 0x1F;
        return { text: `${n < 0 ? '-' : ''}${hex2(Math.abs(n))},${base}`, extra: 0, undefinedCode: false, pcRelative: null };
    }
    const indirect = (pb & 0x10) !== 0;
    const form = INDEX_FORMS[pb & 0x0F];
    if (!form || !(indirect ? form[3] : form[2])) {
        return { text: '?', extra: 0, undefinedCode: true, pcRelative: null };
    }
    const [shape, extra] = form;
    let offset = 0;
    if (extra === 1) offset = sign8(read((at + 1) & 0xFFFF));
    else if (extra === 2) offset = (read((at + 1) & 0xFFFF) << 8) | read((at + 2) & 0xFFFF);
    const end = endBeforeOffset + extra;
    let text;
    let pcRelative = null;
    if (shape === '[n]') {
        return { text: `[${hex4(offset)}]`, extra, undefinedCode: false, pcRelative: null };
    } else if (shape === 'n,PCR') {
        const rel = extra === 2 ? sign16(offset) : offset;
        pcRelative = rel;
        text = `${hex4(end + rel)},PCR`;
    } else if (shape === 'n,R') {
        text = `${extra === 2 ? signedHex16(sign16(offset)) : signedHex(offset)},${base}`;
    } else {
        text = shape.replace('R', base);
    }
    return { text: indirect ? `[${text}]` : text, extra, undefinedCode: false, pcRelative };
}

/**
 * Read one instruction.
 * @param {(addr: number) => number} read byte at an address
 * @param {number} addr
 * @returns {{ addr: number, length: number, bytes: number[], mnemonic: string, operand: string,
 *   text: string, kind: string, target: number|null, undefinedCode: boolean }}
 *   kind: 'call', 'swi', 'return', 'jump', 'branch' or 'other'; target: the
 *   address a call, jump or branch goes to when the instruction itself tells it
 */
export function decodeInstruction(read, addr) {
    addr &= 0xFFFF;
    const at = (k) => read((addr + k) & 0xFFFF) & 0xFF;
    const first = at(0);
    let pos = 1;
    let entry = null;
    let undefinedCode = false;
    let codeBytes = 1;        // prefix and code bytes the table entry counts in its length
    if (first === 0x10 || first === 0x11) {
        const code = at(1);
        pos = 2;
        entry = CODE_PAGES[first === 0x10 ? 1 : 2][code];
        codeBytes = 2;
        if (!entry) {
            undefinedCode = true;
            entry = CODE_PAGES[0][code];
            codeBytes = 1;
        }
    } else {
        entry = CODE_PAGES[0][first];
    }
    if (!entry) {
        const length = pos;
        const bytes = Array.from({ length }, (_, k) => at(k));
        return {
            addr, length, bytes, mnemonic: 'FCB', operand: bytes.map(hex2).join(','),
            text: `FCB ${bytes.map(hex2).join(',')}`, kind: 'other', target: null, undefinedCode: true,
        };
    }
    const [mnemonic, shape, entryLength] = entry;
    let length = pos + (entryLength - codeBytes);
    let operand = '';
    let target = null;
    switch (shape) {
        case 'inh': break;
        case 'imm8': operand = '#' + hex2(at(pos)); break;
        case 'imm16': operand = '#' + hex4((at(pos) << 8) | at(pos + 1)); break;
        case 'dir': operand = '<' + hex2(at(pos)); break;
        case 'ext': target = (at(pos) << 8) | at(pos + 1); operand = hex4(target); break;
        case 'rel8': target = (addr + length + sign8(at(pos))) & 0xFFFF; operand = hex4(target); break;
        case 'rel16': target = (addr + length + sign16((at(pos) << 8) | at(pos + 1))) & 0xFFFF; operand = hex4(target); break;
        case 'pair': {
            const pb = at(pos);
            operand = `${TRANSFER_NAMES[pb >> 4] || '?'},${TRANSFER_NAMES[pb & 0x0F] || '?'}`;
            if (!TRANSFER_NAMES[pb >> 4] || !TRANSFER_NAMES[pb & 0x0F]) undefinedCode = true;
            break;
        }
        case 'listS': operand = registerList(STACK_ORDER_S, at(pos)); break;
        case 'listU': operand = registerList(STACK_ORDER_U, at(pos)); break;
        case 'idx': {
            const ix = indexedOperand(read, addr + pos, addr + length);
            length += ix.extra;
            operand = ix.text;
            if (ix.undefinedCode) undefinedCode = true;
            break;
        }
        default: break;
    }
    let kind = 'other';
    if (CALL_NAMES.has(mnemonic)) kind = 'call';
    else if (SOFTWARE_INTERRUPTS.has(mnemonic)) kind = 'swi';
    else if (mnemonic === 'RTS' || mnemonic === 'RTI') kind = 'return';
    else if (mnemonic === 'PULS' && (at(pos) & 0x80)) kind = 'return';
    else if (JUMP_NAMES.has(mnemonic)) kind = 'jump';
    else if (shape === 'rel8' || shape === 'rel16') kind = 'branch';
    else if ((mnemonic === 'TFR' || mnemonic === 'EXG') && (TRANSFER_NAMES[at(pos) & 0x0F] === 'PC' || (mnemonic === 'EXG' && TRANSFER_NAMES[at(pos) >> 4] === 'PC'))) kind = 'jump';
    else if (mnemonic === 'PULU' && (at(pos) & 0x80)) kind = 'jump';
    if (shape === 'ext' && kind === 'other') target = null;
    const bytes = Array.from({ length }, (_, k) => at(k));
    return { addr, length, bytes, mnemonic, operand, text: operand ? `${mnemonic} ${operand}` : mnemonic, kind, target, undefinedCode };
}

/**
 * Read `count` instructions from `addr`, with `before` instructions in front
 * of it. The ones in front are found by reading again from earlier
 * addresses until a reading lands on `addr`; the reading that starts the
 * farthest back and still lands there is kept.
 */
export function listInstructions(read, addr, count, before = 0) {
    addr &= 0xFFFF;
    const out = [];
    if (before > 0) {
        let best = null;
        for (let back = before * 5; back >= 1; back--) {
            const start = addr - back;
            if (start < 0) continue;
            const seq = [];
            let a = start;
            while (a < addr) {
                const ins = decodeInstruction(read, a);
                seq.push(ins);
                a += ins.length;
            }
            if (a === addr && seq.length >= before) { best = seq; break; }
            if (a === addr && (!best || seq.length > best.length)) best = seq;
        }
        if (best) out.push(...best.slice(-before));
    }
    let a = addr;
    for (let k = 0; k < count; k++) {
        const ins = decodeInstruction(read, a);
        out.push(ins);
        a = (a + ins.length) & 0xFFFF;
    }
    return out;
}

// ---- quick look at the code at an address (for stepping and the call stack) ----

/** Classes codeClass() answers. */
export const CODE_OTHER = 0;
export const CODE_CALL = 1;        // JSR / BSR / LBSR
export const CODE_SWI = 2;         // SWI / SWI2 / SWI3
export const CODE_RETURN = 3;      // RTS / RTI
export const CODE_PULL_S = 4;      // PULS: a return when the postbyte pulls PC
export const CODE_UNDEFINED = 5;   // no code (or a prefix followed by a byte with no code on its page)

function classOf(entry) {
    if (!entry) return CODE_UNDEFINED;
    const name = entry[0];
    if (CALL_NAMES.has(name)) return CODE_CALL;
    if (SOFTWARE_INTERRUPTS.has(name)) return CODE_SWI;
    if (name === 'RTS' || name === 'RTI') return CODE_RETURN;
    if (name === 'PULS') return CODE_PULL_S;
    return CODE_OTHER;
}
const CLASS_PAGES = CODE_PAGES.map((page) => Uint8Array.from(page, classOf));

/**
 * Class of the instruction at `addr`, read with no allocation. A PULS that
 * pulls PC counts as CODE_RETURN.
 * @param {(addr: number) => number} read
 */
export function codeClass(read, addr) {
    const first = read(addr);
    let cls;
    let next = (addr + 1) & 0xFFFF;
    if (first === 0x10 || first === 0x11) {
        const code = read(next);
        next = (next + 1) & 0xFFFF;
        cls = CLASS_PAGES[first === 0x10 ? 1 : 2][code];
        if (cls === CODE_UNDEFINED) return CODE_UNDEFINED;
    } else {
        cls = CLASS_PAGES[0][first];
    }
    if (cls === CODE_PULL_S) return (read(next) & 0x80) ? CODE_RETURN : CODE_OTHER;
    return cls;
}
