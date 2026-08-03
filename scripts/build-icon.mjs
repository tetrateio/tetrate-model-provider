/**
 * Renders images/icon.png from images/logo.svg.
 *
 * images/logo.svg is the Tetrate mark from https://docs.tetrate.ai/img/logo.svg.
 * It is portrait (867x1001) and the marketplace wants a square icon, so the mark
 * is scaled to fit inside a square canvas with a margin and centred.
 *
 * Run with: npm run icon
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;

/** Fraction of the canvas left empty around the mark on its longest axis. */
const MARGIN = 0.09;

const here = dirname(fileURLToPath(import.meta.url));
const images = join(here, '..', 'images');

const source = readFileSync(join(images, 'logo.svg'), 'utf8');

const viewBox = source.match(
    /viewBox="([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)"/
);
if (!viewBox) {
    throw new Error('logo.svg has no viewBox, cannot determine its aspect');
}
const [, minX, minY, width, height] = viewBox.map(Number);

const inner = SIZE * (1 - 2 * MARGIN);
const scale = Math.min(inner / width, inner / height);
const drawWidth = width * scale;
const drawHeight = height * scale;

// Wrap the original mark in a square canvas rather than editing it in place, so
// re-fetching the upstream logo stays a straight file copy.
const squared = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <g transform="translate(${(SIZE - drawWidth) / 2} ${(SIZE - drawHeight) / 2}) scale(${scale}) translate(${-minX} ${-minY})">
    ${source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}
  </g>
</svg>`;

const png = new Resvg(squared, {
    fitTo: { mode: 'width', value: SIZE },
    font: { loadSystemFonts: false },
})
    .render()
    .asPng();

const output = join(images, 'icon.png');
writeFileSync(output, png);
console.log(`Wrote ${output} (${SIZE}x${SIZE})`);
