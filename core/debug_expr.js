// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
// =============================================================================
// debug_expr.js — expressions over the registers and the memory of a CPU
//
//   Used for watches, conditions of breakpoints and log messages. The text
//   is parsed here into a tree and evaluated by walking it; no JavaScript is
//   made from it.
//
//   Numbers   $1F  0x1F  &H1F  %1011 (where a value may start)  31
//   Registers a b d x y u s pc dp cc, and the CC bits cc.e cc.f cc.h cc.i
//             cc.n cc.z cc.v cc.c (0 or 1). Case does not matter.
//   Memory    [expr] is the byte at expr, w[expr] the big-endian word.
//   Operators (lowest first)  ||  &&  |  ^  &  == !=  < <= > >=  << >>  + -
//             * / %  and the unary - ~ !. Parentheses group.
//   Every value is an integer; / and % truncate, and division by 0 is an error.
// =============================================================================

const REGISTER_NAMES = new Set(['a', 'b', 'd', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc']);
const CC_BIT_NAMES = { e: 0x80, f: 0x40, h: 0x20, i: 0x10, n: 0x08, z: 0x04, v: 0x02, c: 0x01 };

/** Operators of each binary level, lowest binding first. */
const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
const SYMBOLS = ['||', '&&', '==', '!=', '<=', '>=', '<<', '>>', '|', '^', '&', '<', '>', '+', '-', '*', '/', '%', '~', '!', '(', ')', '[', ']'];

function tokenize(src) {
    const tokens = [];
    let i = 0;
    const text = String(src);
    while (i < text.length) {
        const ch = text[i];
        if (/\s/.test(ch)) { i++; continue; }
        let m;
        const rest = text.slice(i);
        if ((m = /^\$([0-9a-f]+)/i.exec(rest)) || (m = /^0x([0-9a-f]+)/i.exec(rest)) || (m = /^&h([0-9a-f]+)/i.exec(rest))) {
            tokens.push({ t: 'num', v: parseInt(m[1], 16) }); i += m[0].length; continue;
        }
        const last = tokens[tokens.length - 1];
        const afterValue = last && (last.t !== 'sym' || last.v === ')' || last.v === ']');
        if (!afterValue && (m = /^%([01]+)/.exec(rest))) { tokens.push({ t: 'num', v: parseInt(m[1], 2) }); i += m[0].length; continue; }
        if ((m = /^[0-9]+/.exec(rest))) { tokens.push({ t: 'num', v: parseInt(m[0], 10) }); i += m[0].length; continue; }
        if ((m = /^[a-z_][a-z0-9_]*(\.[a-z])?/i.exec(rest))) { tokens.push({ t: 'name', v: m[0].toLowerCase() }); i += m[0].length; continue; }
        const sym = SYMBOLS.find((s) => rest.startsWith(s));
        if (!sym) throw new Error(`unexpected '${ch}' at ${i + 1}`);
        tokens.push({ t: 'sym', v: sym });
        i += sym.length;
    }
    return tokens;
}

function parse(src) {
    const tokens = tokenize(src);
    let k = 0;
    const peek = () => tokens[k];
    const isSym = (v) => peek() && peek().t === 'sym' && peek().v === v;
    const expect = (v) => {
        if (!isSym(v)) throw new Error(`'${v}' expected`);
        k++;
    };
    const binary = (level) => {
        if (level === LEVELS.length) return unary();
        let left = binary(level + 1);
        while (peek() && peek().t === 'sym' && LEVELS[level].includes(peek().v)) {
            const op = tokens[k++].v;
            left = { op, args: [left, binary(level + 1)] };
        }
        return left;
    };
    const unary = () => {
        if (isSym('-') || isSym('~') || isSym('!')) {
            const op = tokens[k++].v;
            return { op: `u${op}`, args: [unary()] };
        }
        return primary();
    };
    const primary = () => {
        const tok = peek();
        if (!tok) throw new Error('expression ends too early');
        if (tok.t === 'num') { k++; return { num: tok.v }; }
        if (isSym('(')) { k++; const e = binary(0); expect(')'); return e; }
        if (isSym('[')) { k++; const e = binary(0); expect(']'); return { op: 'byte', args: [e] }; }
        if (tok.t === 'name') {
            k++;
            if (tok.v === 'w' && isSym('[')) { k++; const e = binary(0); expect(']'); return { op: 'word', args: [e] }; }
            if (REGISTER_NAMES.has(tok.v)) return { reg: tok.v };
            const bit = /^cc\.([a-z])$/.exec(tok.v);
            if (bit && CC_BIT_NAMES[bit[1]]) return { ccBit: CC_BIT_NAMES[bit[1]] };
            throw new Error(`unknown name '${tok.v}'`);
        }
        throw new Error(`unexpected '${tok.v}'`);
    };
    if (tokens.length === 0) throw new Error('empty expression');
    const tree = binary(0);
    if (k !== tokens.length) throw new Error(`unexpected '${tokens[k].v}'`);
    return tree;
}

/**
 * @typedef {object} ExprContext
 * @property {(name: string) => number} reg  register value ('a', 'pc', ...)
 * @property {(addr: number) => number} peek byte at an address
 */

function evaluateTree(n, ctx) {
    if (n.num !== undefined) return n.num;
    if (n.reg !== undefined) return ctx.reg(n.reg);
    if (n.ccBit !== undefined) return (ctx.reg('cc') & n.ccBit) ? 1 : 0;
    const [p, q] = n.args;
    const v = (e) => evaluateTree(e, ctx);
    switch (n.op) {
        case 'byte': return ctx.peek(v(p) & 0xFFFF) & 0xFF;
        case 'word': { const a = v(p) & 0xFFFF; return ((ctx.peek(a) & 0xFF) << 8) | (ctx.peek((a + 1) & 0xFFFF) & 0xFF); }
        case 'u-': return -v(p);
        case 'u~': return ~v(p);
        case 'u!': return v(p) ? 0 : 1;
        case '||': return (v(p) || v(q)) ? 1 : 0;
        case '&&': return (v(p) && v(q)) ? 1 : 0;
        case '|': return v(p) | v(q);
        case '^': return v(p) ^ v(q);
        case '&': return v(p) & v(q);
        case '==': return v(p) === v(q) ? 1 : 0;
        case '!=': return v(p) !== v(q) ? 1 : 0;
        case '<': return v(p) < v(q) ? 1 : 0;
        case '<=': return v(p) <= v(q) ? 1 : 0;
        case '>': return v(p) > v(q) ? 1 : 0;
        case '>=': return v(p) >= v(q) ? 1 : 0;
        case '<<': return v(p) << v(q);
        case '>>': return v(p) >> v(q);
        case '+': return v(p) + v(q);
        case '-': return v(p) - v(q);
        case '*': return Math.imul(v(p), v(q));
        case '/': case '%': {
            const a = v(p), b = v(q);
            if (b === 0) throw new Error('division by 0');
            return n.op === '/' ? Math.trunc(a / b) : a % b;
        }
        default: throw new Error(`bad operator ${n.op}`);
    }
}

/**
 * Parse an expression once.
 * @param {string} src
 * @returns {(ctx: ExprContext) => number} evaluates it; throws on a parse error here
 */
export function compileExpression(src) {
    const tree = parse(src);
    return (ctx) => evaluateTree(tree, ctx);
}

/**
 * Fill the {expr} parts of a log message: hex ($ and 2 or 4 digits) by
 * default, decimal with {expr,d}. A part that fails reads <error: ...>.
 * @param {string} text
 * @param {(expr: string) => number} evaluate
 */
export function fillLogText(text, evaluate) {
    return String(text).replace(/\{([^{}]+)\}/g, (_, body) => {
        const m = /^(.*?)(?:,\s*([dx]))?$/i.exec(body);
        try {
            const value = evaluate(m[1]);
            if (m[2] && m[2].toLowerCase() === 'd') return String(value);
            const u = value & 0xFFFF;
            return '$' + u.toString(16).toUpperCase().padStart(u > 0xFF ? 4 : 2, '0');
        } catch (e) {
            return `<error: ${e.message}>`;
        }
    });
}
