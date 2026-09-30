'use strict';
// A minimal OpenStreetMap PBF reader (https://wiki.openstreetmap.org/wiki/PBF_Format): nodes (plain and dense) and ways
// with their tags; relations are skipped. Streams the file one blob at a time with Node's zlib: no dependency.
// read(file, { node(id, lon, lat, tags), way(id, refs, tags) }); tags is null for an untagged element.
const fs = require('fs'), zlib = require('zlib');

// ── protobuf wire format ──────────────────────────────────────────────────────────────────────────────────────
// varints are read as Numbers (ids reach 2^34; safe up to 2^53), never with 32-bit bitwise operators
function reader(buf, pos = 0, end = buf.length) {
  const R = {
    pos, end,
    varint() { let n = 0, m = 1, b; do { b = buf[R.pos++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return n; },
    svarint() { const n = R.varint(); return n % 2 === 0 ? n / 2 : -(n + 1) / 2; },
    bytes() { const l = R.varint(), s = R.pos; R.pos += l; return buf.subarray(s, s + l); },
    sub() { const l = R.varint(), s = R.pos; R.pos += l; return reader(buf, s, s + l); },
    // (the length is read first: `R.pos += R.varint()` would add it to the position from before the length's own bytes)
    skip(w) { if (w === 0) R.varint(); else if (w === 1) R.pos += 8; else if (w === 2) { const l = R.varint(); R.pos += l; } else if (w === 5) R.pos += 4; else throw new Error('pbf: wire type ' + w); },
    // each field: [number, wire type]
    *fields() { while (R.pos < R.end) { const k = R.varint(); yield [Math.floor(k / 8), k % 8]; } },
    packed(fn) { const l = R.varint(), e = R.pos + l, out = []; const save = R.end; R.end = e; while (R.pos < e) out.push(fn()); R.end = save; return out; }
  };
  return R;
}

function* blobs(file) {
  const fd = fs.openSync(file, 'r'), hdr = Buffer.alloc(4);
  try {
    let off = 0;
    for (;;) {
      if (fs.readSync(fd, hdr, 0, 4, off) < 4) return;
      const hl = hdr.readUInt32BE(0), hb = Buffer.alloc(hl); fs.readSync(fd, hb, 0, hl, off + 4);
      let type = '', size = 0; const H = reader(hb);
      for (const [f, w] of H.fields()) { if (f === 1) type = H.bytes().toString(); else if (f === 3) size = H.varint(); else H.skip(w); }
      const bb = Buffer.alloc(size); fs.readSync(fd, bb, 0, size, off + 4 + hl); off += 4 + hl + size;
      let raw = null; const B = reader(bb);
      for (const [f, w] of B.fields()) { if (f === 1) raw = Buffer.from(B.bytes()); else if (f === 3) raw = zlib.inflateSync(B.bytes()); else B.skip(w); }
      if (!raw) throw new Error('pbf: a blob without raw or zlib data (lzma is not supported)');
      yield { type, data: raw };
    }
  } finally { fs.closeSync(fd); }
}

function read(file, cb) {
  const stat = { blobs: 0, nodes: 0, ways: 0, timestamp: null };
  for (const b of blobs(file)) {
    stat.blobs++;
    if (b.type === 'OSMHeader') {
      const H = reader(b.data);
      for (const [f, w] of H.fields()) { if (f === 32) stat.timestamp = new Date(H.varint() * 1000).toISOString(); else H.skip(w); }
      continue;
    }
    if (b.type !== 'OSMData') continue;
    const P = reader(b.data); let strings = [], gran = 100, latOff = 0, lonOff = 0; const groups = [];
    for (const [f, w] of P.fields()) {
      if (f === 1) { const S = P.sub(); for (const [g, ww] of S.fields()) { if (g === 1) strings.push(S.bytes().toString('utf8')); else S.skip(ww); } }
      else if (f === 2) groups.push(P.bytes());
      else if (f === 17) gran = P.varint(); else if (f === 19) latOff = P.varint(); else if (f === 20) lonOff = P.varint(); else P.skip(w);
    }
    const deg = (v, o) => 1e-9 * (o + gran * v);
    const tagsOf = (ks, vs) => { if (!ks.length) return null; const t = {}; for (let i = 0; i < ks.length; i++) t[strings[ks[i]]] = strings[vs[i]]; return t; };
    for (const gb of groups) {
      const G = reader(gb);
      for (const [f, w] of G.fields()) {
        if (f === 1 && cb.node) {   // a plain node
          const N = G.sub(); let id = 0, lat = 0, lon = 0, ks = [], vs = [];
          for (const [g, ww] of N.fields()) { if (g === 1) id = N.svarint(); else if (g === 2) ks = N.packed(N.varint); else if (g === 3) vs = N.packed(N.varint); else if (g === 8) lat = N.svarint(); else if (g === 9) lon = N.svarint(); else N.skip(ww); }
          stat.nodes++; cb.node(id, deg(lon, lonOff), deg(lat, latOff), tagsOf(ks, vs));
        } else if (f === 2 && cb.node) {   // dense nodes: delta-coded ids and coordinates, tags as key, value, ..., 0
          const D = G.sub(); let ids = [], lats = [], lons = [], kv = [];
          for (const [g, ww] of D.fields()) { if (g === 1) ids = D.packed(D.svarint); else if (g === 8) lats = D.packed(D.svarint); else if (g === 9) lons = D.packed(D.svarint); else if (g === 10) kv = D.packed(D.varint); else D.skip(ww); }
          let id = 0, lat = 0, lon = 0, k = 0;
          for (let i = 0; i < ids.length; i++) {
            id += ids[i]; lat += lats[i]; lon += lons[i];
            let t = null;
            if (kv.length) { while (k < kv.length && kv[k] !== 0) { (t = t || {})[strings[kv[k]]] = strings[kv[k + 1]]; k += 2; } k++; }
            stat.nodes++; cb.node(id, deg(lon, lonOff), deg(lat, latOff), t);
          }
        } else if (f === 3 && cb.way) {
          const W = G.sub(); let id = 0, ks = [], vs = [], refs = [];
          for (const [g, ww] of W.fields()) { if (g === 1) id = W.varint(); else if (g === 2) ks = W.packed(W.varint); else if (g === 3) vs = W.packed(W.varint); else if (g === 8) refs = W.packed(W.svarint); else W.skip(ww); }
          for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
          stat.ways++; cb.way(id, refs, tagsOf(ks, vs));
        } else G.skip(w);
      }
    }
  }
  return stat;
}
module.exports = { read };
