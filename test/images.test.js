import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, imageStats } from '../scripts/png-stats.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'docs/images');
const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();

// These screenshots are captured from the real page by `npm run docs:images`.
// This machine cannot hand an image back to a model, so the check is numeric:
// a blank frame, a white frame, or a frame with a dead horizontal band fails.

describe('documentation screenshots', () => {
  it('ships the three states the README shows', () => {
    expect(files).toEqual(['arity-error.png', 'dead-schedule.png', 'overview.png']);
  });

  for (const file of files) {
    it(`${file} is a full-size, non-blank capture of the dark page`, () => {
      const png = decodePng(readFileSync(resolve(dir, file)));
      const stats = imageStats(png);

      expect(stats.width).toBe(1680);
      expect(stats.height).toBe(1050);
      expect(stats.uniqueColors).toBeGreaterThan(200);
      expect(stats.stdevLuma).toBeGreaterThan(12);
      // The demo uses a dark warm theme; a white page means the CSS did not load.
      expect(stats.meanLuma).toBeLessThan(120);
      // Every quarter of the page carries variation, so nothing is half-rendered.
      for (const band of stats.bands) expect(band.stdev).toBeGreaterThan(4);
    });
  }

  it('decodes PNGs the way a reader expects (RGBA, top-left pixel opaque)', () => {
    const png = decodePng(readFileSync(resolve(dir, 'overview.png')));
    expect(png.rgba).toHaveLength(png.width * png.height * 4);
    expect(png.rgba[3]).toBe(255);
    // Top-left corner is the page background, not white.
    expect(png.rgba[0] + png.rgba[1] + png.rgba[2]).toBeLessThan(300);
  });
});
