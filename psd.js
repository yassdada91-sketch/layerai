/* Minimal PSD writer (RGB, 8-bit, raw pixel layers, unicode layer names).
 * Layers: [{name, left, top, width, height, rgba: Uint8ClampedArray (non-premultiplied)}]  bottom -> top
 * No dependencies; works in browsers and Node.
 */
(function (root) {
  "use strict";

  function Writer() { this.parts = []; this.len = 0; }
  Writer.prototype.bytes = function (u8) { this.parts.push(u8); this.len += u8.length; };
  Writer.prototype.u8 = function (v) { this.bytes(Uint8Array.of(v & 255)); };
  Writer.prototype.u16 = function (v) { this.bytes(Uint8Array.of((v >> 8) & 255, v & 255)); };
  Writer.prototype.i16 = function (v) { this.u16(v < 0 ? v + 65536 : v); };
  Writer.prototype.u32 = function (v) {
    this.bytes(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
  };
  Writer.prototype.i32 = function (v) { this.u32(v < 0 ? v + 4294967296 : v); };
  Writer.prototype.ascii = function (s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 127;
    this.bytes(a);
  };
  Writer.prototype.zeros = function (n) { this.bytes(new Uint8Array(n)); };
  Writer.prototype.toUint8Array = function () {
    var out = new Uint8Array(this.len), o = 0;
    for (var i = 0; i < this.parts.length; i++) { out.set(this.parts[i], o); o += this.parts[i].length; }
    return out;
  };

  function pad(n, m) { return (m - (n % m)) % m; }

  // Pascal string (ASCII fallback), total length padded to a multiple of 4
  function pascalName(name) {
    var s = "";
    for (var i = 0; i < name.length && s.length < 31; i++) {
      var c = name.charCodeAt(i);
      s += c >= 32 && c < 127 ? name[i] : "_";
    }
    if (!s) s = "Layer";
    var w = new Writer();
    w.u8(s.length); w.ascii(s);
    w.zeros(pad(1 + s.length, 4));
    return w.toUint8Array();
  }

  // 'luni' block: real unicode layer name (needed for Arabic etc.)
  function luniBlock(name) {
    var data = new Writer();
    data.u32(name.length);
    for (var i = 0; i < name.length; i++) data.u16(name.charCodeAt(i));
    data.zeros(pad(4 + name.length * 2, 4));
    var body = data.toUint8Array();
    var w = new Writer();
    w.ascii("8BIM"); w.ascii("luni"); w.u32(body.length); w.bytes(body);
    return w.toUint8Array();
  }

  function planar(rgba, count, channel) {
    var out = new Uint8Array(count);
    for (var i = 0; i < count; i++) out[i] = rgba[i * 4 + channel];
    return out;
  }

  function buildPsd(width, height, layers) {
    var w = new Writer();

    // --- header
    w.ascii("8BPS"); w.u16(1); w.zeros(6);
    w.u16(3);            // channels in composite (RGB)
    w.u32(height); w.u32(width);
    w.u16(8);            // depth
    w.u16(3);            // color mode: RGB
    w.u32(0);            // color mode data
    w.u32(0);            // image resources

    // --- layer records + channel data
    var rec = new Writer(), chan = new Writer();
    var chIds = [0, 1, 2, -1];
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li];
      var count = L.width * L.height;
      rec.i32(L.top); rec.i32(L.left); rec.i32(L.top + L.height); rec.i32(L.left + L.width);
      rec.u16(4);
      for (var c = 0; c < 4; c++) { rec.i16(chIds[c]); rec.u32(2 + count); }
      rec.ascii("8BIM"); rec.ascii("norm");
      rec.u8(255);       // opacity
      rec.u8(0);         // clipping
      rec.u8(0);         // flags (visible)
      rec.u8(0);         // filler
      var name = pascalName(L.name), luni = luniBlock(L.name);
      rec.u32(4 + 4 + name.length + luni.length);
      rec.u32(0);        // layer mask data
      rec.u32(0);        // blending ranges
      rec.bytes(name);
      rec.bytes(luni);
      for (var k = 0; k < 4; k++) {
        chan.u16(0);     // raw
        chan.bytes(planar(L.rgba, count, k === 3 ? 3 : k));
      }
    }
    var recBytes = rec.toUint8Array(), chanBytes = chan.toUint8Array();
    var layerInfoLen = 2 + recBytes.length + chanBytes.length;
    var padLen = pad(layerInfoLen, 2);
    layerInfoLen += padLen;

    w.u32(4 + layerInfoLen + 4);   // layer & mask info length
    w.u32(layerInfoLen);
    w.i16(layers.length);
    w.bytes(recBytes); w.bytes(chanBytes); w.zeros(padLen);
    w.u32(0);                      // global layer mask info

    // --- flattened composite (alpha-over on white)
    var total = width * height, comp = [new Uint8Array(total), new Uint8Array(total), new Uint8Array(total)];
    for (var i = 0; i < total; i++) { comp[0][i] = comp[1][i] = comp[2][i] = 255; }
    for (var j = 0; j < layers.length; j++) {
      var M = layers[j];
      for (var y = 0; y < M.height; y++) {
        var dy = y + M.top; if (dy < 0 || dy >= height) continue;
        for (var x = 0; x < M.width; x++) {
          var dx = x + M.left; if (dx < 0 || dx >= width) continue;
          var s = (y * M.width + x) * 4, d = dy * width + dx, a = M.rgba[s + 3] / 255;
          if (a === 0) continue;
          for (var ch = 0; ch < 3; ch++) comp[ch][d] = Math.round(M.rgba[s + ch] * a + comp[ch][d] * (1 - a));
        }
      }
    }
    w.u16(0);
    for (var q = 0; q < 3; q++) w.bytes(comp[q]);
    return w.toUint8Array();
  }

  var api = { buildPsd: buildPsd };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PSD = api;
})(typeof self !== "undefined" ? self : this);
