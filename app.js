/* LayerAI (static): prompt/image -> design spec -> one canvas per element -> layered PSD, all in the browser. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ config
  var PLANNER_URL = (window.LAYERAI_CONFIG && window.LAYERAI_CONFIG.PLANNER_URL) || "";
  var DAILY_LIMIT = 100000; // limit effectively OFF while developing; put back to 3 before going public
  var LIMIT_FALLBACK_MSG = "وصلتي للحد اليومي. جرّب غدا.";
  var currentSpec = null;
  var currentLook = ""; // value of the "style" select (photo, painting, cartoon...)

  // Text added to the picture prompt for each style (the Worker reads it from the "styleHint" field).
  var STYLE_HINTS = {
    photo: "photorealistic, high detail",
    painting: "oil painting style, artistic brush strokes",
    cartoon: "cartoon illustration style, bold outlines, flat colors",
    cinematic: "cinematic film still, dramatic lighting",
    digital: "digital art, vibrant colors, fantasy art",
    educational: "educational illustration, clean vector, infographic style"
  };

  // ----------------------------------------------------------------- planner
  function demoSpec(prompt) {
    var title = (prompt || "LayerAI").trim().slice(0, 40);
    return {
      width: 1280, height: 720,
      elements: [
        { id: "bg", kind: "background", name: "Background", x: 0, y: 0, w: 1280, h: 720, z: 0, color: "#1e3c72", color2: "#2a5298" },
        { id: "bar", kind: "shape", name: "Accent bar", x: 60, y: 520, w: 700, h: 12, z: 1, color: "#ffb703" },
        { id: "img1", kind: "image", name: "Main subject", x: 820, y: 120, w: 380, h: 480, z: 2, description: "main subject (AI image goes here)" },
        { id: "t1", kind: "text", name: "Title", x: 60, y: 260, w: 700, h: 200, z: 3, text: title, font_size: 72, text_color: "#ffffff" }
      ]
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function limitMessage(res) {
    try {
      var j = await res.json();
      if (j && typeof j.message === "string" && j.message) return j.message;
    } catch (_) {}
    return LIMIT_FALLBACK_MSG;
  }

  // The Worker reads: prompt, format (thumbnail, square, portrait, story, banner), style (photo, painting...).
  async function plan(prompt, imageFile, format, look) {
    if (!PLANNER_URL) return demoSpec(prompt);
    try {
      var fd = new FormData();
      if (prompt) fd.append("prompt", prompt);
      if (imageFile) fd.append("image", imageFile);
      if (format) fd.append("format", format);
      if (look) fd.append("style", look);
      var res = await fetch(PLANNER_URL, { method: "POST", body: fd });
      if (res.status === 429) return { limited: true, message: await limitMessage(res) };
      if (!res.ok) throw new Error("planner " + res.status);
      var spec = await res.json();
      if (!spec || !Array.isArray(spec.elements)) throw new Error("bad spec");
      return spec;
    } catch (err) {
      var d = demoSpec(prompt); d.fallback = true;
      d.reason = (err && err.message) || "unknown";
      return d;
    }
  }

  function loadImage(b64) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("image decode")); };
      img.src = "data:image/jpeg;base64," + b64;
    });
  }

  // One image request, with a single automatic retry after a network failure or a 5xx answer.
  // cutout: falsy (keep the picture as it is), "green" / true (green screen) or "magenta" (magenta screen).
  // style: "background" for a full scene background.
  async function fetchImage(description, cutout, style) {
    var url = PLANNER_URL.replace(/\/+$/, "") + "/image", lastErr = null, res = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var fd = new FormData(); fd.append("description", description);
        if (cutout) fd.append("cutout", cutout === "magenta" ? "magenta" : "green");
        if (style) fd.append("style", style);
        if (currentLook && STYLE_HINTS[currentLook]) fd.append("styleHint", STYLE_HINTS[currentLook]);
        res = await fetch(url, { method: "POST", body: fd });
        if (res.status >= 500 && attempt < 1) { await sleep(1500); continue; }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < 1) await sleep(1500);
      }
    }
    if (res) return res;
    throw new Error(((lastErr && lastErr.message) || "network") + " (2 attempts)");
  }

  // Ask the Worker for a real picture for each image element (one after the other).
  // progress(i, total) is called before each request.
  // Returns { failed, limitMsg, reason } (reason = short technical cause of the first failure).
  async function addImages(spec, progress) {
    var out = { failed: false, limitMsg: "", reason: "" };
    if (!PLANNER_URL || spec.fallback) return out;
    var todo = spec.elements.filter(function (e) { return e.kind === "image" && e.description; });
    for (var i = 0; i < todo.length; i++) {
      var e = todo[i];
      if (progress) progress(i + 1, todo.length);
      try {
        var res = await fetchImage(e.description, e.cutout, e.style);
        if (res.status === 429) {
          out.failed = true; out.limitMsg = await limitMessage(res);
          break;
        }
        if (!res.ok) {
          var why = "";
          try { var j = await res.json(); why = j && j.error ? String(j.error) : ""; } catch (_) {}
          throw new Error("image " + res.status + (why ? " " + why : ""));
        }
        var data = await res.json();
        if (!data || !data.image) throw new Error("no image in answer");
        e._img = await loadImage(data.image);
      } catch (err) {
        out.failed = true;
        if (!out.reason) out.reason = (err && err.message) || "unknown";
      }
    }
    // Copies of an element (e.src) reuse the picture of the element they come from.
    spec.elements.forEach(function (e) {
      if (!e.src) return;
      var from = elementById(spec, e.src);
      if (from && from._img) e._img = from._img;
    });
    return out;
  }

  // --------------------------------------------------------------- rendering
  function makeCanvas(w, h) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }

  function roundRectPath(g, x, y, W, H, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + W, y, x + W, y + H, r); g.arcTo(x + W, y + H, x, y + H, r);
    g.arcTo(x, y + H, x, y, r); g.arcTo(x, y, x + W, y, r); g.closePath();
  }

  // Removes the plain background of a picture (green screen, magenta screen or white), in place.
  // Returns false (and changes nothing) if the result looks wrong.
  function removeBackground(canvas) {
    var W = canvas.width, H = canvas.height, g = canvas.getContext("2d");
    var id = g.getImageData(0, 0, W, H), d = id.data, n = W * H;
    // Background colour = average of the four corners (6x6 blocks).
    var sr = 0, sg = 0, sb = 0, cnt = 0, bs = 6, cx = [0, W - bs], cy = [0, H - bs];
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++)
      for (var y = cy[b]; y < cy[b] + bs; y++) for (var x = cx[a]; x < cx[a] + bs; x++) {
        var p = (y * W + x) * 4; sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; cnt++;
      }
    var br = sr / cnt, bg = sg / cnt, bb = sb / cnt;
    var chroma = (Math.max(br, bg, bb) - Math.min(br, bg, bb)) > 80; // coloured screen vs. white/grey
    var T1 = chroma ? 60 : 22, T2 = chroma ? 130 : 55;               // fully background / fully subject
    function dist(i) {
      var dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    }
    var alpha = new Uint8ClampedArray(n); alpha.fill(255);
    function setAlpha(idx) {
      var dd = dist(idx * 4);
      alpha[idx] = dd <= T1 ? 0 : Math.round((dd - T1) / (T2 - T1) * 255);
    }
    if (chroma) {
      for (var i = 0; i < n; i++) if (dist(i * 4) < T2) setAlpha(i);
    } else {
      // white/grey background: only what is connected to the border is background
      var seen = new Uint8Array(n), stack = new Int32Array(n), sp = 0;
      function push(idx) { if (!seen[idx] && dist(idx * 4) < T2) { seen[idx] = 1; stack[sp++] = idx; } }
      for (var x2 = 0; x2 < W; x2++) { push(x2); push((H - 1) * W + x2); }
      for (var y2 = 0; y2 < H; y2++) { push(y2 * W); push(y2 * W + W - 1); }
      while (sp > 0) {
        var idx = stack[--sp]; setAlpha(idx);
        var px = idx % W, py = (idx - px) / W;
        if (px > 0) push(idx - 1); if (px < W - 1) push(idx + 1);
        if (py > 0) push(idx - W); if (py < H - 1) push(idx + W);
      }
    }
    var opaque = 0;
    for (var k = 0; k < n; k++) {
      var al = alpha[k];
      if (al > 128) opaque++;
      d[k * 4 + 3] = al;
    }
    var frac = opaque / n;
    if (frac < 0.03 || frac > 0.97) return false; // nothing or everything removed: keep the original

    // Pixels within R px of a transparent pixel (the outer edge of the subject).
    function markNear(R) {
      var near = new Uint8Array(n);
      for (var yy = 0; yy < H; yy++) {
        for (var xx = 0; xx < W; xx++) {
          if (d[(yy * W + xx) * 4 + 3] >= 40) continue;
          var y0 = Math.max(0, yy - R), y1 = Math.min(H - 1, yy + R), x0 = Math.max(0, xx - R), x1 = Math.min(W - 1, xx + R);
          for (var ny = y0; ny <= y1; ny++) for (var nx = x0; nx <= x1; nx++) near[ny * W + nx] = 1;
        }
      }
      return near;
    }

    if (chroma) {
      var keyGreen = bg > br + 40 && bg > bb + 40;     // green screen
      var keyMagenta = br > bg + 40 && bb > bg + 40;   // magenta screen (used for green plants)

      if (keyGreen) {
        // Step 1: remove green CONNECTED to the transparent background (green reflections, glow under the object).
        // Green in the middle of the object is not reached, so it is kept. If more than 40% of the object would go, undo.
        var seen2 = new Uint8Array(n), st2 = new Int32Array(n), sp2 = 0, removed = new Int32Array(n), rc = 0;
        for (var s0 = 0; s0 < n; s0++) if (d[s0 * 4 + 3] < 40) { seen2[s0] = 1; st2[sp2++] = s0; }
        var greenish = function (ix) {
          var o2 = ix * 4, rr = d[o2], g2 = d[o2 + 1], b2 = d[o2 + 2];
          return g2 > 90 && g2 > Math.max(rr, b2) + 30;
        };
        var spread = function (ix) {
          if (!seen2[ix] && d[ix * 4 + 3] >= 40 && greenish(ix)) { seen2[ix] = 1; removed[rc++] = ix; st2[sp2++] = ix; }
        };
        while (sp2 > 0) {
          var cur = st2[--sp2], cxx = cur % W, cyy = (cur - cxx) / W;
          if (cxx > 0) spread(cur - 1); if (cxx < W - 1) spread(cur + 1);
          if (cyy > 0) spread(cur - W); if (cyy < H - 1) spread(cur + W);
        }
        if (rc <= opaque * 0.4) {
          for (var q = 0; q < rc; q++) { d[removed[q] * 4 + 3] = 0; alpha[removed[q]] = 0; }
        }
      }

      if (keyGreen || keyMagenta) {
        // Step 2: edge clean-up (within 12px of a transparent pixel, or half-transparent pixels).
        var near = markNear(12);
        for (var j = 0; j < n; j++) {
          if (d[j * 4 + 3] === 0) continue;
          var o = j * 4, r = d[o], gg = d[o + 1], bl = d[o + 2];
          if (keyGreen) {
            // Dark olive / dark green leftovers of the shadow the generator casts on the green screen (e.g. under a shoe):
            // clearly saturated yellow-green or green pixels are dropped ANYWHERE. White/grey/black objects are never that saturated.
            if (gg >= r && gg > bl && gg > 25 && (gg - bl) > gg * 0.72) { d[o + 3] = 0; continue; }
            var mx = Math.max(r, bl);
            if (gg > mx) {
              if (near[j] && gg > mx + 40 && gg > 110) d[o + 3] = 0;     // clearly (and brightly) green near the edge: drop it; dark pixels are kept
              else if (near[j] || d[o + 3] < 255) d[o + 1] = mx;         // fringe: remove the green tint
            }
          } else {
            var lo = Math.min(r, bl);
            // Magenta-hued pixels anywhere (the shadow the generator leaves on the screen, dark purple/red patches): drop them.
            // Real objects almost never have red AND blue both well above green; pink cups (green high) and leaves are safe.
            if (lo > 25 && lo > gg * 1.6 + 15) { d[o + 3] = 0; continue; }
            if (lo > gg && (near[j] || d[o + 3] < 255)) {
              var ex = lo - gg;
              if (near[j] && ex > 60 && gg < 100) d[o + 3] = 0;          // pure magenta near the edge: drop it (pink object parts are kept)
              else { d[o] = Math.round(r - ex * 0.95); d[o + 2] = Math.round(bl - ex * 0.95); } // fringe: remove the magenta tint
            }
          }
        }
      }

      if (keyGreen) {
        // Step 3: gentle green-spill removal over the WHOLE object. A white or light object shot on a green screen
        // picks up a green tint inside (not only on its edge). Light pixels (red/blue above 110) with a SMALL green
        // excess (up to 45) lose most of it. Strongly green pixels (real green parts of the object) are left alone.
        for (var m = 0; m < n; m++) {
          var o3 = m * 4;
          if (d[o3 + 3] === 0) continue;
          var mx3 = Math.max(d[o3], d[o3 + 2]), ex3 = d[o3 + 1] - mx3;
          if (ex3 > 0 && ex3 <= 45 && mx3 > 110) d[o3 + 1] = Math.round(mx3 + ex3 * 0.15);
        }
      }

      if (keyGreen) {
        // Step 3b (green): pixels that are semi-transparent but NOT at the outer edge (e.g. a white sole that looks
        // a bit like the screen) become fully opaque, so the object no longer fades inside.
        for (var m4 = 0; m4 < n; m4++) {
          var o6 = m4 * 4, a6 = d[o6 + 3];
          if (a6 > 0 && a6 < 255 && !near[m4]) d[o6 + 3] = 255;
        }
      }

      if (keyMagenta) {
        // Step 3 (magenta): gentle pink-spill removal over the WHOLE object. A white or light object shot on a magenta
        // screen picks up a pink tint. Light pixels (green above 110) with a SMALL red/blue excess (up to 60) lose most of it.
        // Strongly coloured pixels (real pink or purple parts) and green leaves are left alone.
        for (var m2 = 0; m2 < n; m2++) {
          var o4 = m2 * 4;
          if (d[o4 + 3] === 0) continue;
          var gg4 = d[o4 + 1], lo4 = Math.min(d[o4], d[o4 + 2]), ex4 = lo4 - gg4;
          if (ex4 > 0 && ex4 <= 110 && gg4 > 120) {
            d[o4] = Math.round(Math.max(gg4, d[o4] - ex4 * 0.9));
            d[o4 + 2] = Math.round(Math.max(gg4, d[o4 + 2] - ex4 * 0.9));
          }
        }
        // Step 4 (magenta): leftover pure-magenta pixels inside the object (gaps between leaves) become transparent.
        for (var m3 = 0; m3 < n; m3++) {
          var o5 = m3 * 4;
          if (d[o5 + 3] !== 0 && dist(o5) < T1) d[o5 + 3] = 0;
        }
      }

      if (keyGreen || keyMagenta) {
      // Step 5 (green + magenta): remove tiny isolated fragments (black specks / pieces floating away from the subject).
      var lab = new Uint8Array(n), stk = new Int32Array(n), comp = new Int32Array(n);
      var minSize = Math.max(400, Math.round(opaque * 0.004));
      for (var s1 = 0; s1 < n; s1++) {
        if (lab[s1] || d[s1 * 4 + 3] < 40) continue;
        var top = 0, cc = 0; stk[top++] = s1; lab[s1] = 1;
        while (top > 0) {
          var c0 = stk[--top]; comp[cc++] = c0;
          var cx0 = c0 % W, cy0 = (c0 - cx0) / W;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx2 = cx0 + dx, ny2 = cy0 + dy;
            if (nx2 < 0 || ny2 < 0 || nx2 >= W || ny2 >= H) continue;
            var ni = ny2 * W + nx2;
            if (!lab[ni] && d[ni * 4 + 3] >= 40) { lab[ni] = 1; stk[top++] = ni; }
          }
        }
        var dropIt = cc < minSize;
        if (!dropIt && cc < opaque * 0.08) {
          // a medium-small piece that is almost black = leftover shadow streak, not part of the object
          var br2 = 0;
          for (var q3 = 0; q3 < cc; q3++) { var o7 = comp[q3] * 4; br2 += Math.max(d[o7], d[o7 + 1], d[o7 + 2]); }
          if (br2 / cc < 70) dropIt = true;
        }
        if (dropIt) for (var q2 = 0; q2 < cc; q2++) d[comp[q2] * 4 + 3] = 0;
      }
      }
    }
    g.putImageData(id, 0, 0);
    return true;
  }

  // Bounding box of the visible part (alpha > 40) of a canvas, or null.
  function visibleBox(canvas) {
    var W = canvas.width, H = canvas.height, d = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    var x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 40) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function renderBackground(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    if (e.color2) {
      var grad = g.createLinearGradient(0, 0, 0, c.height);
      grad.addColorStop(0, e.color || "#ffffff"); grad.addColorStop(1, e.color2);
      g.fillStyle = grad;
    } else g.fillStyle = e.color || "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    return { canvas: c, x: e.x, y: e.y };
  }

  function renderShape(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    g.fillStyle = e.color || "#ffffff"; g.fillRect(0, 0, c.width, c.height);
    return { canvas: c, x: e.x, y: e.y };
  }

  function renderCircle(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    g.fillStyle = e.color || "#ffffff";
    g.beginPath();
    g.ellipse(c.width / 2, c.height / 2, c.width / 2, c.height / 2, 0, 0, Math.PI * 2);
    g.fill();
    return { canvas: c, x: e.x, y: e.y };
  }

  function renderFrame(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d"), lw = e.line || 8;
    g.strokeStyle = e.color || "#ffffff"; g.lineWidth = lw;
    roundRectPath(g, lw / 2, lw / 2, c.width - lw, c.height - lw, 24);
    g.stroke();
    return { canvas: c, x: e.x, y: e.y };
  }

  // Soft drop shadow. With e.of = id of an image whose background was removed, the shadow follows its shape;
  // otherwise it is the shadow of a rounded rectangle. Only the blur is kept (the shape itself is drawn off-canvas).
  function renderShadow(e) {
    var pad = 80, c = makeCanvas(e.w + pad * 2, e.h + pad * 2), g = c.getContext("2d");
    g.shadowColor = e.color || "rgba(0,0,0,0.9)";
    g.shadowBlur = 40; g.shadowOffsetX = 10000; g.shadowOffsetY = 20;
    var target = null;
    if (e.of && currentSpec) {
      for (var i = 0; i < currentSpec.elements.length; i++) if (currentSpec.elements[i].id === e.of) target = currentSpec.elements[i];
    }
    if (target) renderImage(target); // makes sure the cut-out exists
    if (target && target._cut) {
      g.drawImage(target._cut, pad - 10000, pad);
    } else {
      g.fillStyle = "#000000";
      roundRectPath(g, pad - 10000, pad, e.w, e.h, 24);
      g.fill();
    }
    return { canvas: c, x: e.x - pad, y: e.y - pad };
  }

  function renderText(e) {
    var size = e.font_size || 48, pad = Math.round(size * 0.15);
    var fontFamily = '"Segoe UI", Tahoma, "Noto Sans Arabic", "DejaVu Sans", Arial, sans-serif';
    var probe = makeCanvas(10, 10).getContext("2d");
    probe.font = "bold " + size + "px " + fontFamily;
    var words = String(e.text || "").split(/\s+/), lines = [], line = "", maxW = Math.max(e.w, size);
    words.forEach(function (w) {
      var t = line ? line + " " + w : w;
      if (probe.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    var lh = Math.round(size * 1.3), widest = 0;
    lines.forEach(function (l) { widest = Math.max(widest, probe.measureText(l).width); });
    var c = makeCanvas(Math.ceil(widest) + pad * 2, lines.length * lh + pad * 2), g = c.getContext("2d");
    g.font = "bold " + size + "px " + fontFamily;
    g.fillStyle = e.text_color || "#000000"; g.textBaseline = "top";
    var rtl = /[\u0590-\u08FF]/.test(e.text || "");
    g.direction = rtl ? "rtl" : "ltr"; g.textAlign = rtl ? "right" : "left";
    lines.forEach(function (l, i) { g.fillText(l, rtl ? c.width - pad : pad, pad + i * lh); });
    return { canvas: c, x: e.x - pad, y: e.y - pad };
  }

  function renderImagePlaceholder(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    g.fillStyle = "rgba(255,255,255,0.18)"; g.strokeStyle = "rgba(255,255,255,0.8)"; g.lineWidth = 4;
    roundRectPath(g, 2, 2, c.width - 4, c.height - 4, 24);
    g.fill(); g.stroke();
    g.fillStyle = "#fff"; g.font = "20px sans-serif"; g.textBaseline = "top";
    g.fillText(String(e.description || e.name).slice(0, 36), 16, 16);
    return { canvas: c, x: e.x, y: e.y };
  }

  function drawCover(g, img, W, H) {
    var k = Math.max(W / img.width, H / img.height), dw = img.width * k, dh = img.height * k;
    g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  // Cut-out: remove the plain background on a work copy (max 768px), crop to the visible part,
  // then fit it inside the layer box (with a small margin). Returns a canvas of e.w x e.h, or null.
  //   e.align = "bottom": the object stands at the bottom of the box (instead of being centered).
  //   e.mirror = true: the object is drawn in the left corner and mirrored in the right corner (e.g. plants framing a scene).
  function cutOut(e) {
    var img = e._img, s = Math.min(1, 768 / Math.max(img.width, img.height));
    var work = makeCanvas(img.width * s, img.height * s), wg = work.getContext("2d");
    wg.drawImage(img, 0, 0, work.width, work.height);
    if (!removeBackground(work)) return null;
    var box = visibleBox(work);
    if (!box || box.w < 20 || box.h < 20) return null;
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d"), m = 20;
    var boxW = e.mirror ? c.width / 2 : c.width;
    var k = Math.min((boxW - m * 2) / box.w, (c.height - m * 2) / box.h);
    var dw = box.w * k, dh = box.h * k;
    var dx = e.mirror ? 0 : (boxW - dw) / 2;
    var dy = e.align === "bottom" ? c.height - dh - m : (c.height - dh) / 2;
    g.imageSmoothingQuality = "high";
    g.drawImage(work, box.x, box.y, box.w, box.h, dx, dy, dw, dh);
    if (e.mirror) {
      g.save(); g.translate(c.width, 0); g.scale(-1, 1);
      g.drawImage(work, box.x, box.y, box.w, box.h, dx, dy, dw, dh);
      g.restore();
    }
    return c;
  }

  // Colour harmony: cut-out elements (subject, props) are generated with their own lighting. A gentle tint toward the average
  // colour of the scene picture, a little less saturation and a slight brightness match make them sit in the scene.
  // HARMONIZE = strength (0 = off). Only used when the design has a scene picture ("bgimg").
  var HARMONIZE = 0.4;

  function sceneTone(spec) {
    var bg = elementById(spec, "bgimg");
    if (!HARMONIZE || !bg || !bg._img) return null;
    var c = makeCanvas(16, 16), g = c.getContext("2d");
    drawCover(g, bg._img, 16, 16);
    var d = g.getImageData(0, 0, 16, 16).data, r = 0, gg = 0, b = 0, n = d.length / 4;
    for (var i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    r /= n; gg /= n; b /= n;
    var lum = 0.299 * r + 0.587 * gg + 0.114 * b;
    return lum < 20 ? null : { r: r, g: gg, b: b, lum: lum };
  }

  function harmonizeCanvas(c, tone) {
    var s = HARMONIZE, g = c.getContext("2d"), id = g.getImageData(0, 0, c.width, c.height), d = id.data;
    var mr = 1 - s + s * (tone.r / tone.lum), mg = 1 - s + s * (tone.g / tone.lum), mb = 1 - s + s * (tone.b / tone.lum);
    var bright = 1 + (tone.lum / 128 - 1) * s * 0.5, ds = s * 0.6;
    for (var i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      var r = d[i], gg = d[i + 1], b = d[i + 2], l = 0.299 * r + 0.587 * gg + 0.114 * b;
      r += (l - r) * ds; gg += (l - gg) * ds; b += (l - b) * ds;
      d[i] = Math.max(0, Math.min(255, Math.round(r * mr * bright)));
      d[i + 1] = Math.max(0, Math.min(255, Math.round(gg * mg * bright)));
      d[i + 2] = Math.max(0, Math.min(255, Math.round(b * mb * bright)));
    }
    g.putImageData(id, 0, 0);
  }

  function flipCanvas(src) {
    var c = makeCanvas(src.width, src.height), g = c.getContext("2d");
    g.translate(c.width, 0); g.scale(-1, 1); g.drawImage(src, 0, 0);
    return c;
  }

  function renderImage(e) {
    if (e._layer) return e._layer;
    if (!e._img) return renderImagePlaceholder(e);
    var c = null;
    if (e.cutout) {
      c = cutOut(e);
      if (c && e.flip) c = flipCanvas(c);
      if (c && currentSpec && currentSpec._tone) harmonizeCanvas(c, currentSpec._tone);
      if (c) e._cut = c;
    }
    if (!c) {
      c = makeCanvas(e.w, e.h);
      var g = c.getContext("2d"), rad = typeof e.radius === "number" ? e.radius : 24;
      g.save();
      if (rad > 0) { roundRectPath(g, 0, 0, c.width, c.height, rad); g.clip(); }
      drawCover(g, e._img, c.width, c.height);
      g.restore();
    }
    e._layer = { canvas: c, x: e.x, y: e.y };
    return e._layer;
  }

  // Sunlight rays drawn by code (no AI picture): a soft glow in the top-right corner and 7 translucent beams.
  function renderRays(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    var ox = c.width * 0.8, oy = -c.height * 0.1, L = c.height * 1.8;
    var glow = g.createRadialGradient(ox, oy, 0, ox, oy, c.height * 0.9);
    glow.addColorStop(0, "rgba(255,226,140,0.30)"); glow.addColorStop(1, "rgba(255,226,140,0)");
    g.fillStyle = glow; g.fillRect(0, 0, c.width, c.height);
    try { g.filter = "blur(" + Math.max(6, Math.round(c.width * 0.012)) + "px)"; } catch (_) {}
    for (var i = 0; i < 7; i++) {
      var a = 0.12 + i * 0.14, hw = 0.03 + (i % 3) * 0.015;
      var x1 = ox - Math.sin(a - hw) * L, y1 = oy + Math.cos(a - hw) * L;
      var x2 = ox - Math.sin(a + hw) * L, y2 = oy + Math.cos(a + hw) * L;
      var gr = g.createLinearGradient(ox, oy, ox - Math.sin(a) * L, oy + Math.cos(a) * L);
      gr.addColorStop(0, "rgba(255,226,140,0.30)"); gr.addColorStop(1, "rgba(255,226,140,0)");
      g.fillStyle = gr; g.beginPath(); g.moveTo(ox, oy); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); g.fill();
    }
    return { canvas: c, x: e.x, y: e.y };
  }

  // Soft elliptical shadow on the ground (under the feet of a subject).
  function renderGroundShadow(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d"), r = c.width / 2;
    g.translate(c.width / 2, c.height / 2); g.scale(1, c.height / c.width);
    var gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, "rgba(0,0,0,0.75)"); gr.addColorStop(0.55, "rgba(0,0,0,0.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(-r, -r, r * 2, r * 2);
    return { canvas: c, x: e.x, y: e.y };
  }

  // Soft dark gradient at the top (behind the title of scene designs).
  function renderTopShade(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    var gr = g.createLinearGradient(0, 0, 0, c.height);
    gr.addColorStop(0, "rgba(0,0,0,0.85)"); gr.addColorStop(0.6, "rgba(0,0,0,0.35)"); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    return { canvas: c, x: e.x, y: e.y };
  }

  var RENDER = {
    background: renderBackground, shape: renderShape, text: renderText, image: renderImage,
    circle: renderCircle, frame: renderFrame, shadow: renderShadow, rays: renderRays, groundshadow: renderGroundShadow, topshade: renderTopShade
  };

  function elementById(spec, id) {
    for (var i = 0; i < spec.elements.length; i++) if (spec.elements[i].id === id) return spec.elements[i];
    return null;
  }

  function hexLum(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || ""));
    if (!m) return 0.5;
    var n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  // Full-background designs ("bgimg" + "overlay" layers): measure the real brightness of the picture
  // behind the text, darken it with the overlay accordingly, and use white text (black shadow),
  // so that the title stays readable whatever the picture is.
  function adaptBackgroundText(spec) {
    var bgimg = elementById(spec, "bgimg"), ov = elementById(spec, "overlay");
    if (!bgimg || !bgimg._img || !ov) return;
    var t1 = elementById(spec, "t1"), t1s = elementById(spec, "t1s"), t2 = elementById(spec, "t2"), bar = elementById(spec, "bar");
    var W = spec.width, H = spec.height, s = 8;
    var c = makeCanvas(W / s, H / s), g = c.getContext("2d");
    drawCover(g, bgimg._img, c.width, c.height);
    var top = t1 ? t1.y : 0;
    var bottom = t2 ? t2.y + t2.h : (bar ? bar.y + bar.h : H);
    var left = t1 ? t1.x : 0, right = t1 ? t1.x + t1.w : W;
    var x0 = Math.max(0, Math.floor(left / s)), x1 = Math.min(c.width, Math.ceil(right / s));
    var y0 = Math.max(0, Math.floor(top / s)), y1 = Math.min(c.height, Math.ceil(bottom / s));
    if (x1 <= x0 || y1 <= y0) return;
    var d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data, sum = 0, cnt = d.length / 4;
    for (var i = 0; i < d.length; i += 4) sum += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    var L = sum / cnt;
    ov.opacity = Math.max(0.28, Math.min(0.6, 0.2 + 0.55 * L));
    [t1, t2].forEach(function (t) { if (t) t.text_color = "#ffffff"; });
    if (t1s) t1s.text_color = "#000000";
    if (bar && hexLum(bar.color) < 0.35) bar.color = "#ffffff";
  }

  // Text group layout (works for every canvas size). The title may take 1, 2 or 3 lines (the browser decides),
  // so its REAL height is measured here. The group (title, accent bar, subtitle) keeps the gap and the centre
  // that the Worker chose, and is re-spaced with the measured heights.
  function textHeight(e) {
    var pad = Math.round((e.font_size || 48) * 0.15);
    return renderText(e).canvas.height - pad * 2;
  }
  function flowTextGroup(spec) {
    var t1 = elementById(spec, "t1"), t1s = elementById(spec, "t1s"), bar = elementById(spec, "bar"), t2 = elementById(spec, "t2");
    if (!t1 || !bar) return;
    var barH = bar.h || 12;
    var gap = Math.max(10, Math.round(bar.y - (t1.y + t1.h)));
    var h1 = textHeight(t1), h2 = t2 ? textHeight(t2) : 0;
    var oldTop = t1.y, oldBottom = t2 ? t2.y + t2.h : bar.y + barH;
    var center = (oldTop + oldBottom) / 2;
    var total = h1 + gap + barH + (t2 ? gap + h2 : 0);
    var y = Math.round(center - total / 2);
    y = Math.min(y, spec.height - 30 - total);
    y = Math.max(30, y);
    t1.y = y;
    if (t1s) t1s.y = y + 5;
    bar.y = y + h1 + gap;
    if (t2) t2.y = bar.y + barH + gap;
  }

  // --------------------------------------------------------------------- PSD
  function specToPsd(spec) {
    currentSpec = spec;
    adaptBackgroundText(spec);
    spec._tone = sceneTone(spec);
    // A cut-out element whose background could not be removed would show as a coloured box: drop it (and its shadows).
    var dropIds = {};
    spec.elements.forEach(function (e) {
      if (e.kind === "image" && e.cutout && e._img) { renderImage(e); if (!e._cut) dropIds[e.id] = true; }
    });
    spec._dropped = Object.keys(dropIds).length;
    if (spec._dropped) {
      spec.elements = spec.elements.filter(function (e) {
        return !dropIds[e.id] && !dropIds[String(e.id).replace(/^(gs_|sh_)/, "")];
      });
    }
    flowTextGroup(spec);
    var layers = spec.elements.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).map(function (e) {
      var r = (RENDER[e.kind] || renderShape)(e), c = r.canvas;
      var data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      var op = typeof e.opacity === "number" ? Math.max(0, Math.min(1, e.opacity)) : 1;
      if (op < 1) { for (var i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * op); }
      return { name: e.name || e.id || "Layer", left: Math.round(r.x), top: Math.round(r.y), width: c.width, height: c.height, rgba: data };
    });
    return PSD.buildPsd(spec.width, spec.height, layers);
  }

  // ---------------------------------------------------------------- daily cap
  function usage() {
    try {
      var d = JSON.parse(localStorage.getItem("layerai_usage") || "{}"), today = new Date().toISOString().slice(0, 10);
      return d.day === today ? d : { day: today, n: 0 };
    } catch (_) { return { day: "", n: 0 }; }
  }
  function bumpUsage() {
    try { var u = usage(); u.n++; localStorage.setItem("layerai_usage", JSON.stringify(u)); } catch (_) {}
  }

  // ---------------------------------------------------------------------- UI
  // Elements of index.html: prompt, format, style, image, go, msg, dl.
  var $ = function (id) { return document.getElementById(id); };
  var promptEl = $("prompt"), formatEl = $("format"), styleEl = $("style"), fileInput = $("image");
  var goBtn = $("go"), msgEl = $("msg"), dlEl = $("dl"), blobUrl = null;

  function status(text, type) {
    msgEl.textContent = text;
    msgEl.className = type || "";
  }

  goBtn.addEventListener("click", async function () {
    if (goBtn.disabled) return;
    var prompt = promptEl.value.trim();
    var file = fileInput && fileInput.files && fileInput.files[0];
    var format = formatEl.value || "thumbnail";
    currentLook = styleEl.value || "";
    if (!prompt && !file) { status("اكتب برومت أو اختر صورة (أو الاثنين).", "err"); return; }
    if (usage().n >= DAILY_LIMIT) { status("وصلت الحد اليومي المجاني (" + DAILY_LIMIT + "). عاود غداً.", "err"); return; }
    goBtn.disabled = true; dlEl.replaceChildren(); status("جاري التوليد...");
    try {
      var spec = await plan(prompt, file, format, currentLook);
      if (spec.limited) { status(spec.message, "err"); return; }
      status("جاري توليد الصورة...");
      var imgs = await addImages(spec, function (i, total) {
        status("جاري توليد الصورة " + i + "/" + total + "...");
      });
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var bytes = specToPsd(spec);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/vnd.adobe.photoshop" }));
      bumpUsage();
      var a = document.createElement("a");
      a.className = "dl"; a.href = blobUrl; a.download = "design.psd";
      a.textContent = "تحميل design.psd (" + spec.elements.length + " طبقات، " + spec.width + "×" + spec.height + ")";
      dlEl.replaceChildren(a);

      var notes = [], warn = false;
      if (spec.fallback) {
        warn = true;
        notes.push("الذكاء الاصطناعي غير متاح دابا، فاستعملنا تصميماً تجريبياً." + (spec.reason ? " (" + spec.reason + ")" : ""));
      } else if (imgs.limitMsg) {
        warn = true;
        notes.push(imgs.limitMsg + " (وضعنا مربعاً مؤقتاً مكان الصورة.)");
      } else if (imgs.failed) {
        warn = true;
        notes.push("تعذر توليد الصورة، فوضعنا مربعاً مؤقتاً مكانها." + (imgs.reason ? " (" + imgs.reason + ")" : ""));
      }
      if (spec._dropped) notes.push("حذفنا " + spec._dropped + " عنصراً تعذر قص خلفيته.");
      if (file) notes.push("الصورة المرجعية ما كتتحللش بعد.");

      status((warn ? "" : "نجح إنشاء التصميم. ") + notes.join(" "), warn ? "err" : "ok");
    } catch (err) {
      status("وقع خطأ: " + err.message, "err");
    } finally { goBtn.disabled = false; }
  });
})();
