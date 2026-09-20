// SPDX-License-Identifier: MIT
// Copyright (c) 2026 7032 / Naomitsu Tsugiiwa
/**
 * CG ROM glyph renderer
 *
 * FM-7 CG ROM holds ANK (half-width) glyphs in 8×8, 1bpp format.
 * Each character occupies 8 bytes (one byte per row, MSB = leftmost pixel).
 * Bank 0 (offset 0x000–0x7FF) contains ASCII, half-width kana ($A0–$DF),
 * and semi-graphics ($80–$9F / $E0–$FF) — which is what GRPH/KANA keys emit.
 *
 * This module renders a single glyph to a PNG data URL, cached per
 * (code, scale, fg, bg) tuple so repeated lookups are cheap.
 */

const cache = new Map();

function glyphIsBlank(cgROM, fm7Code) {
    const off = (fm7Code & 0xFF) * 8;
    if (off + 8 > cgROM.length) return true;
    for (let i = 0; i < 8; i++) if (cgROM[off + i] !== 0) return false;
    return true;
}

/**
 * @param {Uint8Array|null} cgROM - CG ROM bytes (≥ 2 KB). null or empty returns null.
 * @param {number} fm7Code - 0x00–0xFF character code
 * @param {{scale?:number, fg?:string, bg?:string}} [opts]
 * @returns {string|null} data URL (image/png) or null if ROM unavailable / glyph blank
 */
export function getCGGlyphDataURL(cgROM, fm7Code, opts = {}) {
    if (!cgROM || cgROM.length < 0x800) return null;
    if (glyphIsBlank(cgROM, fm7Code)) return null;

    const scale = opts.scale ?? 2;
    const fg = opts.fg ?? '#e8eef8';
    const bg = opts.bg ?? 'transparent';
    const code = fm7Code & 0xFF;
    const key = `${code}|${scale}|${fg}|${bg}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const W = 8 * scale, H = 8 * scale;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    if (bg !== 'transparent') {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = fg;
    const off = code * 8;
    for (let y = 0; y < 8; y++) {
        const row = cgROM[off + y];
        if (!row) continue;
        for (let x = 0; x < 8; x++) {
            if (row & (0x80 >> x)) ctx.fillRect(x * scale, y * scale, scale, scale);
        }
    }
    const url = c.toDataURL('image/png');
    cache.set(key, url);
    return url;
}

/**
 * Draw a single 8×8 glyph from CG ROM (bank 0) onto an existing 2D context
 * at (x, y), pixel-perfect, in the given CSS color. Returns true if any
 * pixel was drawn.
 */
export function drawCGGlyphInto(ctx, cgROM, fm7Code, x, y, color) {
    if (!cgROM || cgROM.length < 0x800) return false;
    const off = (fm7Code & 0xFF) * 8;
    if (off + 8 > cgROM.length) return false;
    ctx.fillStyle = color;
    let any = false;
    for (let yy = 0; yy < 8; yy++) {
        const row = cgROM[off + yy];
        if (!row) continue;
        for (let xx = 0; xx < 8; xx++) {
            if (row & (0x80 >> xx)) {
                ctx.fillRect(x + xx, y + yy, 1, 1);
                any = true;
            }
        }
    }
    return any;
}

/**
 * Composite renderer: up to four 8×8 glyphs laid out in a "+" pattern
 * (left / top / right / bottom) on a `size`×`size` canvas. The glyph at
 * `active` position is drawn in `activeColor`; the rest in `dimColor`.
 *
 * @param {Uint8Array|null} cgROM
 * @param {{left?:number|null, top?:number|null, right?:number|null, bottom?:number|null}} glyphs
 * @param {'left'|'top'|'right'|'bottom'} active
 * @param {{size?:number, activeColor?:string, dimColor?:string}} [opts]
 * @returns {string|null}
 */
const compositeCache = new Map();
export function getCGKeyCompositeDataURL(cgROM, glyphs, active, opts = {}) {
    if (!cgROM || cgROM.length < 0x800) return null;
    const size = opts.size ?? 22;
    const activeColor = opts.activeColor ?? '#ffffff';
    const dimColor = opts.dimColor ?? '#8899aa';
    const g = 8;
    const mid = Math.floor((size - g) / 2);
    const far = size - g;
    const positions = {
        top:    { x: mid, y: 0 },
        left:   { x: 0,   y: mid },
        right:  { x: far, y: mid },
        bottom: { x: mid, y: far },
    };
    const k = [glyphs.left, glyphs.top, glyphs.right, glyphs.bottom]
        .map(v => (v === null || v === undefined) ? 'n' : v).join(',');
    const key = `${size}|${k}|${active}|${activeColor}|${dimColor}`;
    const hit = compositeCache.get(key);
    if (hit !== undefined) return hit;

    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    let any = false;
    for (const pos of ['left', 'top', 'right', 'bottom']) {
        const code = glyphs[pos];
        if (code === null || code === undefined) continue;
        const color = pos === active ? activeColor : dimColor;
        const { x, y } = positions[pos];
        if (drawCGGlyphInto(ctx, cgROM, code, x, y, color)) any = true;
    }
    if (!any) {
        compositeCache.set(key, null);
        return null;
    }
    const url = c.toDataURL('image/png');
    compositeCache.set(key, url);
    return url;
}

export function clearCGGlyphCache() {
    cache.clear();
    compositeCache.clear();
}
