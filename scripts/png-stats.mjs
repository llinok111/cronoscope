/**
 * A PNG reader small enough to audit, used to *measure* screenshots instead of
 * trusting them.
 *
 * This machine's image tooling cannot hand an image back to me, so "the picture
 * looks right" is not a claim I can make. What I can do is decode the pixels and
 * assert things a broken capture cannot satisfy: the page is not blank, it is
 * not a single colour, the ink is dark (our theme) and every horizontal band
 * carries variation (content is distributed, not a white void).
 *
 * Supports the subset Chrome emits for screenshots: 8-bit, non-interlaced,
 * colour type 2 (RGB) or 6 (RGBA). Anything else throws rather than guessing.
 */
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** @returns {{width:number,height:number,colorType:number,bitDepth:number,rgba:Uint8Array}} */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }
  let pos = 8;
  let header = null;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += length + 12;
  }
  if (!header) throw new Error('PNG has no IHDR chunk');
  if (header.bitDepth !== 8) throw new Error(`unsupported bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`unsupported colour type ${header.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const current = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      current[x] = value & 0xff;
    }
    previous = current;
  }

  // Normalise to RGBA so callers do not care about the source layout.
  let rgba;
  if (channels === 4) {
    rgba = new Uint8Array(out);
  } else if (channels === 3) {
    rgba = new Uint8Array((width * height) * 4);
    for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
      rgba[j] = out[i];
      rgba[j + 1] = out[i + 1];
      rgba[j + 2] = out[i + 2];
      rgba[j + 3] = 255;
    }
  } else {
    throw new Error(`colour type ${header.colorType} not normalised by this reader`);
  }

  return { width, height, colorType: header.colorType, bitDepth: header.bitDepth, rgba };
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Pixel statistics over a strided sample.
 * `bands` splits the image into equal horizontal slices and reports each one's
 * spread, which is how a "mostly empty" capture gets caught.
 */
export function imageStats(png, { stride = 3, bands = 4, uniqueCap = 4096 } = {}) {
  const { width, height, rgba } = png;
  const colors = new Set();
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const bandSum = new Array(bands).fill(0);
  const bandSq = new Array(bands).fill(0);
  const bandCount = new Array(bands).fill(0);

  for (let y = 0; y < height; y += stride) {
    const band = Math.min(bands - 1, Math.floor((y / height) * bands));
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const l = luma(r, g, b);
      sum += l;
      sumSq += l * l;
      count += 1;
      bandSum[band] += l;
      bandSq[band] += l * l;
      bandCount[band] += 1;
      if (colors.size < uniqueCap) colors.add((r << 16) | (g << 8) | b);
    }
  }

  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const bandStats = bandSum.map((s, i) => {
    const n = bandCount[i] || 1;
    const m = s / n;
    const v = Math.max(0, bandSq[i] / n - m * m);
    return { mean: Number(m.toFixed(1)), stdev: Number(Math.sqrt(v).toFixed(1)) };
  });

  return {
    width,
    height,
    sampledPixels: count,
    uniqueColors: colors.size,
    meanLuma: Number(mean.toFixed(1)),
    stdevLuma: Number(Math.sqrt(variance).toFixed(1)),
    bands: bandStats,
  };
}

/** Read a file and return its statistics in one call. */
export function statsOfFile(path, options) {
  return imageStats(decodePng(readFileSync(path)), options);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  for (const file of process.argv.slice(2)) {
    const stats = statsOfFile(file);
    console.log(`${file}\n  ${JSON.stringify(stats)}`);
  }
}
