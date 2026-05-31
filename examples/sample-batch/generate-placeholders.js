'use strict';

/**
 * Generate small, valid PLACEHOLDER assets for the sample batch so the example
 * runs out of the box. Replace these with your real images/PDF for actual posts.
 * No dependencies — a tiny PNG encoder (zlib) + a minimal PDF.
 *
 *   node examples/sample-batch/generate-placeholders.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, 'assets');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Solid-colour RGB PNG of w×h. */
function png(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Minimal single-page PDF with a correct xref table. */
function pdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // 4 = content stream (built below)
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets[i + 1] = Buffer.byteLength(body);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(body);
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body, 'binary');
}

fs.mkdirSync(ASSETS, { recursive: true });
const out = (name, buf) => {
  fs.writeFileSync(path.join(ASSETS, name), buf);
  return `${name} (${buf.length} bytes)`;
};

const made = [
  out('li-image.png', png(1200, 675, [37, 99, 235])),
  out('x-image.png', png(1200, 675, [13, 148, 136])),
  out('x-1.png', png(1080, 1080, [244, 63, 94])),
  out('x-2.png', png(1080, 1080, [217, 119, 6])),
  out('x-3.png', png(1080, 1080, [22, 163, 74])),
  out('x-4.png', png(1080, 1080, [124, 58, 237])),
  out('li-doc.pdf', pdf('Placeholder document slide - replace me')),
];
process.stdout.write('Generated placeholder assets:\n  ' + made.join('\n  ') + '\n');
