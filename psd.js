/* Minimal PSD writer (RGB, 8-bit, raw pixel layers, unicode layer names).
 * Layers: [{name, left, top, width, height, rgba: Uint8ClampedArray (non-premultiplied), text?}]  bottom -> top
 * Optional layer.text makes the layer a real, editable text layer (the pixels stay as the preview):
 *   text = { lines: [{t, size, color: [r,g,b], bold, leading?}], justify: 0 left | 1 right | 2 center,
 *            x, y (origin of the first line: x depends on the justification, y is the first baseline), w }
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
    var b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); this.bytes(b);
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

  // ------------------------------------------------------------------ text layers ('TySh')
  var FONT_REGULAR = "ArialMT", FONT_BOLD = "Arial-BoldMT"; // Arial has Arabic letters and exists in Photopea

  // Engine data is a PostScript-like text; strings are UTF-16BE with a BOM, with ( ) \ escaped.
  function esc(s) {
    var out = "\u00fe\u00ff";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), two = [c >> 8, c & 255];
      for (var k = 0; k < 2; k++) {
        if (two[k] === 0x28 || two[k] === 0x29 || two[k] === 0x5c) out += "\\";
        out += String.fromCharCode(two[k]);
      }
    }
    return "(" + out + ")";
  }
  function f(v) { var r = Math.round(v * 10000) / 10000, s = String(r); return s.indexOf(".") < 0 ? s + ".0" : s; }
  // D("Key", value, "Key2", value2 ...) -> {d: "<<...>>"} ; a value is a string (scalar / array) or another D(...)
  function D() {
    var s = "<<\n";
    for (var i = 0; i < arguments.length; i += 2) {
      var v = arguments[i + 1];
      if (v && typeof v === "object") s += "/" + arguments[i] + "\n" + v.d + "\n";
      else s += "/" + arguments[i] + " " + v + "\n";
    }
    return { d: s + ">>" };
  }
  function list(items) { return "[\n" + items.map(function (x) { return x.d; }).join("\n") + "\n]"; }

  function paraProps(just) {
    return D("Justification", String(just), "FirstLineIndent", "0.0", "StartIndent", "0.0", "EndIndent", "0.0",
      "SpaceBefore", "0.0", "SpaceAfter", "0.0", "AutoHyphenate", "false", "HyphenatedWordSize", "6",
      "PreHyphen", "2", "PostHyphen", "2", "ConsecutiveHyphens", "8", "Zone", "36.0",
      "WordSpacing", "[ 0.8 1.0 1.33 ]", "LetterSpacing", "[ 0.0 0.0 0.0 ]", "GlyphSpacing", "[ 1.0 1.0 1.0 ]",
      "AutoLeading", "1.2", "LeadingType", "0", "Hanging", "false", "Burasagari", "false",
      "KinsokuOrder", "0", "EveryLineComposer", "false");
  }
  function styleData(fontIdx, size, color, leading) {
    var col = "[ 1.0 " + f(color[0] / 255) + " " + f(color[1] / 255) + " " + f(color[2] / 255) + " ]";
    return D("Font", String(fontIdx), "FontSize", f(size), "FauxBold", "false", "FauxItalic", "false",
      "AutoLeading", leading ? "false" : "true", "Leading", f(leading || size * 1.2),
      "HorizontalScale", "1.0", "VerticalScale", "1.0", "Tracking", "0", "AutoKerning", "true", "Kerning", "0",
      "BaselineShift", "0.0", "FontCaps", "0", "FontBaseline", "0", "Underline", "false", "Strikethrough", "false",
      "Ligatures", "true", "DLigatures", "false", "BaselineDirection", "2", "Tsume", "0.0", "StyleRunAlignment", "2",
      "Language", "0", "NoBreak", "false", "FillColor", D("Type", "1", "Values", col),
      "StrokeColor", D("Type", "1", "Values", "[ 1.0 0.0 0.0 0.0 ]"), "FillFlag", "true", "StrokeFlag", "false",
      "FillFirst", "true", "YUnderline", "1", "OutlineWidth", "1.0", "CharacterDirection", "0",
      "HindiNumbers", "false", "Kashida", "1", "DiacriticPos", "2");
  }
  function resources(just) {
    return D("KinsokuSet", "[ ]", "MojiKumiSet", "[ ]", "TheNormalStyleSheet", "0", "TheNormalParagraphSheet", "0",
      "ParagraphSheetSet", list([D("Name", esc("Normal RGB"), "DefaultStyleSheet", "0", "Properties", paraProps(just))]),
      "StyleSheetSet", list([D("Name", esc("Normal RGB"), "StyleSheetData", styleData(0, 12, [0, 0, 0], 0))]),
      "FontSet", list([
        D("Name", esc(FONT_REGULAR), "Script", "0", "FontType", "1", "Synthetic", "0"),
        D("Name", esc(FONT_BOLD), "Script", "0", "FontType", "1", "Synthetic", "0")]),
      "SuperscriptSize", "0.583", "SuperscriptPosition", "0.333", "SubscriptSize", "0.583",
      "SubscriptPosition", "0.333", "SmallCapSize", "0.7");
  }

  function engineData(t) {
    var texts = t.lines.map(function (l) { return l.t; }), full = texts.join("\r") + "\r";
    var paras = [], paraLens = [], styles = [], styleLens = [];
    t.lines.forEach(function (l) {
      paras.push(D("ParagraphSheet", D("DefaultStyleSheet", "0", "Properties", paraProps(t.justify)),
        "Adjustments", D("Axis", "[ 1.0 0.0 1.0 ]", "XY", "[ 0.0 0.0 ]")));
      paraLens.push(l.t.length + 1);
      styles.push(D("StyleSheet", D("StyleSheetData", styleData(l.bold ? 1 : 0, l.size, l.color, l.leading))));
      styleLens.push(l.t.length + 1);
    });
    var engine = D(
      "Editor", D("Text", esc(full)),
      "ParagraphRun", D("DefaultRunData", D("ParagraphSheet", D("DefaultStyleSheet", "0", "Properties", D()),
        "Adjustments", D("Axis", "[ 1.0 0.0 1.0 ]", "XY", "[ 0.0 0.0 ]")),
        "RunArray", list(paras), "RunLengthArray", "[ " + paraLens.join(" ") + " ]", "IsJoinable", "1"),
      "StyleRun", D("DefaultRunData", D("StyleSheet", D("StyleSheetData", D())),
        "RunArray", list(styles), "RunLengthArray", "[ " + styleLens.join(" ") + " ]", "IsJoinable", "2"),
      "GridInfo", D("GridIsOn", "false", "ShowGrid", "false", "GridSize", "18.0", "GridLeading", "22.0",
        "GridColor", D("Type", "1", "Values", "[ 0.0 0.0 0.0 1.0 ]"),
        "GridLeadingFillColor", D("Type", "1", "Values", "[ 0.0 0.0 0.0 1.0 ]"), "AlignLineHeightToGridFlags", "false"),
      "AntiAlias", "4", "UseFractionalGlyphWidths", "true",
      "Rendered", D("Version", "1", "Shapes", D("WritingDirection", "0", "Children", list([
        D("ShapeType", "0", "Procession", "0", "Lines", D("WritingDirection", "0", "Children", "[ ]"),
          "Cookie", D("Photoshop", D("ShapeType", "0", "PointBase", "[ 0.0 0.0 ]",
            "Base", D("ShapeType", "0", "TransformPoint0", "[ 1.0 0.0 ]", "TransformPoint1", "[ 0.0 1.0 ]",
              "TransformPoint2", "[ 0.0 0.0 ]"))))]))));
    var top = D("EngineDict", engine, "ResourceDict", resources(t.justify), "DocumentResources", resources(t.justify));
    var s = "\n\n" + top.d + "\n", out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  // Descriptor helpers
  function uni(w, s, withNull) {
    w.u32(s.length + (withNull ? 1 : 0));
    for (var i = 0; i < s.length; i++) w.u16(s.charCodeAt(i));
    if (withNull) w.u16(0);
  }
  function idv(w, s) { w.u32(s.length === 4 ? 0 : s.length); w.ascii(s); }
  // items: [key, type, a, b]
  function descriptor(w, classId, items) {
    w.u32(0);                 // name (empty unicode string)
    idv(w, classId);
    w.u32(items.length);
    items.forEach(function (it) {
      idv(w, it[0]); w.ascii(it[1]);
      if (it[1] === "TEXT") uni(w, it[2], true);
      else if (it[1] === "enum") { idv(w, it[2]); idv(w, it[3]); }
      else if (it[1] === "long") w.i32(it[2]);
      else if (it[1] === "doub") w.f64(it[2]);
      else if (it[1] === "tdta") { w.u32(it[2].length); w.bytes(it[2]); }
    });
  }

  // Older, simpler text description: one style for all lines ({lines:[string], size, bold, color:"#rrggbb", align, x, y, leading, width}).
  function normalizeText(t) {
    if (!t.lines.length || typeof t.lines[0] !== "string") return t;
    var m = /^#?([0-9a-f]{6})$/i.exec(String(t.color || "")), n = m ? parseInt(m[1], 16) : 0;
    var col = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return {
      lines: t.lines.map(function (s) { return { t: s, size: t.size || 48, color: col, bold: !!t.bold, leading: t.leading }; }),
      justify: t.align === "center" ? 2 : (t.align === "right" ? 1 : 0), x: t.x, y: t.y, w: t.width || t.w
    };
  }

  function tyshBlock(L) {
    var t = normalizeText(L.text), body = new Writer(), joined = t.lines.map(function (l) { return l.t; }).join("\r");
    body.u16(1);
    body.f64(1); body.f64(0); body.f64(0); body.f64(1); body.f64(t.x); body.f64(t.y);   // transform: origin of the text
    body.u16(50); body.u32(16);
    descriptor(body, "TxLr", [
      ["Txt ", "TEXT", joined],
      ["textGridding", "enum", "textGridding", "None"],
      ["Ornt", "enum", "Ornt", "Hrzn"],
      ["AntA", "enum", "Annt", "antiAliasSharp"],
      ["TextIndex", "long", 0],
      ["EngineData", "tdta", engineData(t)]
    ]);
    body.u16(1); body.u32(16);
    descriptor(body, "warp", [
      ["warpStyle", "enum", "warpStyle", "warpNone"],
      ["warpValue", "doub", 0],
      ["warpPerspective", "doub", 0],
      ["warpPerspectiveOther", "doub", 0],
      ["warpRotate", "enum", "Ornt", "Hrzn"]
    ]);
    var size = t.lines[0].size;
    body.f64(0); body.f64(-size); body.f64(t.w || 100); body.f64(size * 0.4);              // text bounds
    body.zeros(pad(body.len, 4));
    var data = body.toUint8Array(), w = new Writer();
    w.ascii("8BIM"); w.ascii("TySh"); w.u32(data.length); w.bytes(data);
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
      var tysh = L.text ? tyshBlock(L) : new Uint8Array(0);
      rec.u32(4 + 4 + name.length + luni.length + tysh.length);
      rec.u32(0);        // layer mask data
      rec.u32(0);        // blending ranges
      rec.bytes(name);
      rec.bytes(luni);
      if (tysh.length) rec.bytes(tysh);
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
