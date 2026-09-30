'use strict';
// A minimal zip reader (the GTFS feed) and a CSV parser: stored and deflated entries, from the central directory.
// No zip64 (the feed is ~16 MB). No dependency.
const fs = require('fs'), zlib = require('zlib');

function entries(file) {
  const buf = fs.readFileSync(file);
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;   // end of central directory
  if (e < 0) throw new Error('zip: no central directory in ' + file);
  const n = buf.readUInt16LE(e + 10), cdOff = buf.readUInt32LE(e + 16), out = {};
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    out[name] = () => {
      const ln = buf.readUInt16LE(lo + 26), lx = buf.readUInt16LE(lo + 28), s = lo + 30 + ln + lx, raw = buf.subarray(s, s + csize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error('zip: compression method ' + method + ' in ' + name);
    };
    p += 46 + nl + xl + cl;
  }
  return out;
}

// CSV (RFC 4180): rows as objects keyed by the header; `cols` limits which columns are kept (a large file)
function csv(text, cols) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [], row = []; let f = '', q = false, i = 0, header = null, keep = null;
  const endRow = () => {
    row.push(f); f = '';
    if (!header) { header = row.map((h) => h.trim()); keep = header.map((h, k) => (!cols || cols.includes(h)) ? k : -1).filter((k) => k >= 0); }
    else if (row.length > 1 || row[0] !== '') { const o = {}; for (const k of keep) o[header[k]] = row[k] === undefined ? '' : row[k]; rows.push(o); }
    row.length = 0;
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') endRow();
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) endRow();
  return rows;
}
module.exports = { entries, csv };
