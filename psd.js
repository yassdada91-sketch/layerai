/* Minimal PSD writer (RGB, 8-bit, raw pixel layers, unicode layer names).
 * Layers: [{name, left, top, width, height, rgba: Uint8ClampedArray (non-premultiplied), text?}]  bottom -> top
 * Optional layer.text makes it a REAL editable text layer (Photoshop "TySh" block) that also keeps its pixels:
 *   text: { lines:[string], size:px, bold:bool, color:"#rrggbb", align:"left"|"center"|"right", x:anchor x, y:baseline y, leading:px, width:px }
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
  Writer.prototype.f64 = function (v) {
    var b = new ArrayBuffer(8); new DataView(b).setFloat64(0, v, false); this.bytes(new Uint8Array(b));
  };
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

  // ------------------------------------------------------------------ editable text layer (TySh)
  // Photoshop "descriptor" helpers
  function dKey(w, k) { if (k.length === 4) { w.u32(0); w.ascii(k); } else { w.u32(k.length); w.ascii(k); } }
  function dUni(w, s) { w.u32(s.length + 1); for (var i = 0; i < s.length; i++) w.u16(s.charCodeAt(i)); w.u16(0); }
  // items: [[key, osType, writerFn]]
  function dDescr(w, cls, items) {
    w.u32(0);                // descriptor name (empty unicode string)
    dKey(w, cls);
    w.u32(items.length);
    items.forEach(function (it) { dKey(w, it[0]); w.ascii(it[1]); it[2](w); });
  }
  function vText(s) { return function (w) { dUni(w, s); }; }
  function vLong(n) { return function (w) { w.i32(n); }; }
  function vDoub(n) { return function (w) { w.f64(n); }; }
  function vUnit(n) { return function (w) { w.ascii("#Pxl"); w.f64(n); }; }
  function vEnum(a, b) { return function (w) { dKey(w, a); dKey(w, b); }; }
  function vObjc(cls, items) { return function (w) { dDescr(w, cls, items); }; }
  function vRaw(u8) { return function (w) { w.u32(u8.length); w.bytes(u8); }; }

  // EngineData: PDF-like text. Serializes a JS value (object / array / string / number / boolean) to bytes.
  function engineBytes(root) {
    var out = [];
    function p(s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255); }
    function str(s) {
      out.push(0x28, 0xFE, 0xFF);
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i), hi = (c >> 8) & 255, lo = c & 255;
        [hi, lo].forEach(function (b) { if (b === 0x28 || b === 0x29 || b === 0x5C) out.push(0x5C); out.push(b); });
      }
      out.push(0x29);
    }
    function num(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000); }
    function val(v, ind) {
      if (typeof v === "string") str(v);
      else if (typeof v === "boolean") p(v ? "true" : "false");
      else if (typeof v === "number") p(num(v));
      else if (Array.isArray(v)) {
        var complex = v.some(function (x) { return x && typeof x === "object"; });
        if (!complex) { p("["); v.forEach(function (x) { p(" "); val(x, ind); }); p(" ]"); }
        else {
          p("[\n");
          v.forEach(function (x) { p(ind + "\t"); val(x, ind + "\t"); p("\n"); });
          p(ind + "]");
        }
      } else {
        p("<<\n");
        Object.keys(v).forEach(function (k) {
          var x = v[k];
          p(ind + "\t/" + k);
          if (x && typeof x === "object" && !Array.isArray(x)) { p("\n" + ind + "\t"); val(x, ind + "\t"); }
          else { p(" "); val(x, ind + "\t"); }
          p("\n");
        });
        p(ind + ">>");
      }
    }
    p("\n\n"); val(root, "");
    return Uint8Array.from(out);
  }

  function hexRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || ""));
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function textEngine(T) {
    var lines = T.lines && T.lines.length ? T.lines : [""], size = T.size || 48;
    var text = lines.join("\r") + "\r";
    var just = T.align === "right" ? 1 : (T.align === "center" ? 2 : 0);
    var rgb = hexRgb(T.color), font = T.bold ? "Arial-BoldMT" : "ArialMT";
    var leading = T.leading || size * 1.2;
    var styleData = {
      Font: 0, FontSize: size, FauxBold: false, FauxItalic: false, AutoLeading: false, Leading: leading,
      HorizontalScale: 1, VerticalScale: 1, Tracking: 0, AutoKerning: true, Kerning: 0, BaselineShift: 0,
      FontCaps: 0, FontBaseline: 0, Underline: false, Strikethrough: false, Ligatures: true, DLigatures: false,
      BaselineDirection: 2, Tsume: 0, StyleRunAlignment: 2, Language: 0, NoBreak: false,
      FillColor: { Type: 1, Values: [1, rgb[0], rgb[1], rgb[2]] },
      StrokeColor: { Type: 1, Values: [1, 0, 0, 0] }, FillFlag: true, StrokeFlag: false, FillFirst: true,
      YUnderline: 1, OutlineWidth: 1, CharacterDirection: 0, HindiNumbers: false, Kashida: 1, DiacriticPos: 2
    };
    var paraProps = {
      Justification: just, FirstLineIndent: 0, StartIndent: 0, EndIndent: 0, SpaceBefore: 0, SpaceAfter: 0,
      AutoHyphenate: false, HyphenatedWordSize: 6, PreHyphen: 2, PostHyphen: 2, ConsecutiveHyphens: 8, Zone: 36,
      WordSpacing: [0.8, 1, 1.33], LetterSpacing: [0, 0, 0], GlyphSpacing: [1, 1, 1], AutoLeading: 1.2,
      LeadingType: 0, Hanging: false, Burasagari: false, KinsokuOrder: 0, EveryLineComposer: false
    };
    var paraRuns = [], paraLens = [];
    lines.forEach(function (l) {
      paraRuns.push({ ParagraphSheet: { DefaultStyleSheet: 0, Properties: paraProps }, Adjustments: { Axis: [1, 0, 1], XY: [0, 0] } });
      paraLens.push(l.length + 1);
    });
    var resources = {
      KinsokuSet: [], MojiKumiSet: [],
      TheNormalStyleSheet: 0, TheNormalParagraphSheet: 0,
      ParagraphSheetSet: [{ Name: "Normal RGB", DefaultStyleSheet: 0, Properties: paraProps }],
      StyleSheetSet: [{ Name: "Normal RGB", StyleSheetData: styleData }],
      FontSet: [{ Name: font, Script: 0, FontType: 1, Synthetic: 0 }],
      SuperscriptSize: 0.583, SuperscriptPosition: 0.333, SubscriptSize: 0.583, SubscriptPosition: 0.333, SmallCapSize: 0.7
    };
    return engineBytes({
      EngineDict: {
        Editor: { Text: text },
        ParagraphRun: {
          DefaultRunData: { ParagraphSheet: { DefaultStyleSheet: 0, Properties: {} }, Adjustments: { Axis: [1, 0, 1], XY: [0, 0] } },
          RunArray: paraRuns, RunLengthArray: paraLens, IsJoinable: 1
        },
        StyleRun: {
          DefaultRunData: { StyleSheet: { StyleSheetData: {} } },
          RunArray: [{ StyleSheet: { StyleSheetData: styleData } }], RunLengthArray: [text.length], IsJoinable: 2
        },
        GridInfo: { GridIsOn: false, ShowGrid: false, GridSize: 18, GridLeading: 22, GridColor: { Type: 1, Values: [0, 0, 0, 1] }, GridLeadingFillColor: { Type: 1, Values: [0, 0, 0, 1] }, AlignLineHeightToGridFlags: false },
        AntiAlias: 4, UseFractionalGlyphWidths: true,
        Rendered: { Version: 1, Shapes: { WritingDirection: 0, Children: [{ ShapeType: 0, Procession: 0, Lines: { WritingDirection: 0, Children: [] }, Cookie: { Photoshop: { ShapeType: 0, PointBase: [0, 0], Base: { ShapeType: 0, TransformPoint0: [1, 0], TransformPoint1: [0, 1], TransformPoint2: [0, 0] } } } }] } }
      },
      ResourceDict: resources,
      DocumentResources: resources
    });
  }

  function tyshBlock(T) {
    var size = T.size || 48, boxW = T.width || 400, nLines = (T.lines && T.lines.length) || 1;
    var left = T.align === "right" ? -boxW : (T.align === "center" ? -boxW / 2 : 0);
    var top = -size, right = left + boxW, bottom = (T.leading || size * 1.2) * (nLines - 1) + size * 0.3;
    var plainText = (T.lines || [""]).join("\r") + "\r";
    var boxItems = function (cls) {
      return vObjc(cls, [["Left", "UntF", vUnit(left)], ["Top ", "UntF", vUnit(top)], ["Rght", "UntF", vUnit(right)], ["Btom", "UntF", vUnit(bottom)]]);
    };
    var w = new Writer();
    w.u16(1);                                                          // TySh version
    [1, 0, 0, 1, T.x, T.y].forEach(function (n) { w.f64(n); });      // transform: xx xy yx yy tx ty (tx, ty = text origin)
    w.u16(50);                                                         // text version
    w.u32(16);                                                         // descriptor version
    dDescr(w, "TxLr", [
      ["Txt ", "TEXT", vText(plainText)],
      ["textGridding", "enum", vEnum("textGridding", "None")],
      ["Ornt", "enum", vEnum("Ornt", "Hrzn")],
      ["AntA", "enum", vEnum("Annt", "antiAliasSmooth")],
      ["bounds", "Objc", boxItems("bounds")],
      ["boundingBox", "Objc", boxItems("boundingBox")],
      ["TextIndex", "long", vLong(0)],
      ["EngineData", "tdta", vRaw(textEngine(T))]
    ]);
    w.u16(1);                                                          // warp version
    w.u32(16);
    dDescr(w, "warp", [
      ["warpStyle", "enum", vEnum("warpStyle", "warpNone")],
      ["warpValue", "doub", vDoub(0)],
      ["warpPerspective", "doub", vDoub(0)],
      ["warpPerspectiveOther", "doub", vDoub(0)],
      ["warpRotate", "enum", vEnum("Ornt", "Hrzn")]
    ]);
    w.f64(left); w.f64(top); w.f64(right); w.f64(bottom);              // text bounds
    var body = w.toUint8Array(), padN = pad(body.length, 4);
    var out = new Writer();
    out.ascii("8BIM"); out.ascii("TySh"); out.u32(body.length + padN); out.bytes(body); out.zeros(padN);
    return out.toUint8Array();
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
      var tysh = L.text ? tyshBlock(L.text) : null;
      rec.u32(4 + 4 + name.length + luni.length + (tysh ? tysh.length : 0));
      rec.u32(0);        // layer mask data
      rec.u32(0);        // blending ranges
      rec.bytes(name);
      rec.bytes(luni);
      if (tysh) rec.bytes(tysh);
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
