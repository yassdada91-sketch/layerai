/* LayerAI (static): prompt/image -> design spec -> one canvas per element -> layered PSD, all in the browser. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ config
  var PLANNER_URL = (window.LAYERAI_CONFIG && window.LAYERAI_CONFIG.PLANNER_URL) || "";
  var DAILY_LIMIT = 10; // TEMPORARY for testing: put back to 3 before going public
  var LIMIT_FALLBACK_MSG = "وصلتي للحد اليومي. جرّب غدا.";
  var currentSpec = null;

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

  async function plan(prompt, imageFile) {
    if (!PLANNER_URL) return demoSpec(prompt);
    try {
      var fd = new FormData();
      if (prompt) fd.append("prompt", prompt);
      if (imageFile) fd.append("image", imageFile);
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
  async function fetchImage(description, cutout) {
    var url = PLANNER_URL.replace(/\/+$/, "") + "/image", lastErr = null, res = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var fd = new FormData(); fd.append("description", description);
        if (cutout) fd.append("cutout", "1");
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

  // Ask the Worker for a real picture for each image element.
  // Returns { failed, limitMsg, reason } (reason = short technical cause of the first failure).
  async function addImages(spec) {
    var out = { failed: false, limitMsg: "", reason: "" };
    if (!PLANNER_URL || spec.fallback) return out;
    for (var i = 0; i < spec.elements.length; i++) {
      var e = spec.elements[i];
      if (e.kind !== "image" || !e.description) continue;
      try {
        var res = await fetchImage(e.description, e.cutout);
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

  // Removes the plain background of a picture (green screen or white), in place.
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
    var chroma = (Math.max(br, bg, bb) - Math.min(br, bg, bb)) > 80; // green screen vs. white/grey
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

    if (chroma) {
      // Step 1: remove green that is CONNECTED to the transparent background (green reflections, glow under the object).
      // Starting from every transparent pixel, spread into neighbours that are clearly green (green well above red and blue).
      // Green in the middle of the object is not reached, so it is kept. If more than 40% of the object would go, undo.
      var seen2 = new Uint8Array(n), st2 = new Int32Array(n), sp2 = 0, removed = new Int32Array(n), rc = 0;
      for (var s0 = 0; s0 < n; s0++) if (d[s0 * 4 + 3] < 40) { seen2[s0] = 1; st2[sp2++] = s0; }
      function greenish(ix) {
        var o2 = ix * 4, rr = d[o2], g2 = d[o2 + 1], b2 = d[o2 + 2];
        return g2 > 90 && g2 > Math.max(rr, b2) + 30;
      }
      function spread(ix) {
        if (!seen2[ix] && d[ix * 4 + 3] >= 40 && greenish(ix)) { seen2[ix] = 1; removed[rc++] = ix; st2[sp2++] = ix; }
      }
      while (sp2 > 0) {
        var cur = st2[--sp2], cxx = cur % W, cyy = (cur - cxx) / W;
        if (cxx > 0) spread(cur - 1); if (cxx < W - 1) spread(cur + 1);
        if (cyy > 0) spread(cur - W); if (cyy < H - 1) spread(cur + W);
      }
      if (rc <= opaque * 0.4) {
        for (var q = 0; q < rc; q++) { d[removed[q] * 4 + 3] = 0; alpha[removed[q]] = 0; }
      }

      // Step 2: near the outer edge (within 12px of a transparent pixel), drop clearly green pixels
      // and reduce the green tint of the others (green fringe).
      var R = 12, near = new Uint8Array(n);
      for (var yy = 0; yy < H; yy++) {
        for (var xx = 0; xx < W; xx++) {
          var ii = yy * W + xx;
          if (d[ii * 4 + 3] >= 40) continue;
          var y0 = Math.max(0, yy - R), y1 = Math.min(H - 1, yy + R), x0 = Math.max(0, xx - R), x1 = Math.min(W - 1, xx + R);
          for (var ny = y0; ny <= y1; ny++) for (var nx = x0; nx <= x1; nx++) near[ny * W + nx] = 1;
        }
      }
      for (var j = 0; j < n; j++) {
        if (d[j * 4 + 3] === 0) continue;
        var o = j * 4, r = d[o], gg = d[o + 1], bl = d[o + 2], mx = Math.max(r, bl);
        if (gg > mx) {
          if (near[j] && gg > mx + 40) d[o + 3] = 0;                 // clearly green and near the edge: drop it
          else if (near[j] || d[o + 3] < 255) d[o + 1] = mx;         // fringe: remove the green tint
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
  // then scale it to fill the layer box (with a small margin). Returns a canvas of e.w x e.h, or null.
  function cutOut(e) {
    var img = e._img, s = Math.min(1, 768 / Math.max(img.width, img.height));
    var work = makeCanvas(img.width * s, img.height * s), wg = work.getContext("2d");
    wg.drawImage(img, 0, 0, work.width, work.height);
    if (!removeBackground(work)) return null;
    var box = visibleBox(work);
    if (!box || box.w < 20 || box.h < 20) return null;
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d"), m = 20;
    var k = Math.min((c.width - m * 2) / box.w, (c.height - m * 2) / box.h);
    var dw = box.w * k, dh = box.h * k;
    g.imageSmoothingQuality = "high";
    g.drawImage(work, box.x, box.y, box.w, box.h, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    return c;
  }

  function renderImage(e) {
    if (e._layer) return e._layer;
    if (!e._img) return renderImagePlaceholder(e);
    var c = null;
    if (e.cutout) {
      c = cutOut(e);
      if (c) e._cut = c;
    }
    if (!c) {
      c = makeCanvas(e.w, e.h);
      var g = c.getContext("2d");
      g.save(); roundRectPath(g, 0, 0, c.width, c.height, 24); g.clip(); drawCover(g, e._img, c.width, c.height); g.restore();
    }
    e._layer = { canvas: c, x: e.x, y: e.y };
    return e._layer;
  }

  var RENDER = {
    background: renderBackground, shape: renderShape, text: renderText, image: renderImage,
    circle: renderCircle, frame: renderFrame, shadow: renderShadow
  };

  // Text group layout. The title may take 1, 2 or 3 lines (the browser decides), so its REAL height is measured here
  // and the accent bar and subtitle are placed right under it; the whole group is centered vertically around y = 360.
  function elementById(spec, id) {
    for (var i = 0; i < spec.elements.length; i++) if (spec.elements[i].id === id) return spec.elements[i];
    return null;
  }
  function textHeight(e) {
    var pad = Math.round((e.font_size || 48) * 0.15);
    return renderText(e).canvas.height - pad * 2;
  }
  function flowTextGroup(spec) {
    var t1 = elementById(spec, "t1"), t1s = elementById(spec, "t1s"), bar = elementById(spec, "bar"), t2 = elementById(spec, "t2");
    if (!t1 || !bar) return;
    var gap = 28, h1 = textHeight(t1), h2 = t2 ? textHeight(t2) : 0, barH = bar.h || 12;
    var total = h1 + gap + barH + (t2 ? gap + h2 : 0);
    var y = Math.max(40, Math.round(360 - total / 2));
    t1.y = y;
    if (t1s) t1s.y = y + 5;
    bar.y = y + h1 + gap;
    if (t2) t2.y = bar.y + barH + gap;
  }

  // --------------------------------------------------------------------- PSD
  function specToPsd(spec) {
    currentSpec = spec;
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
  var $ = function (id) { return document.getElementById(id); };
  var fileInput = $("file"), drop = $("drop"), dropText = $("dropText"), blobUrl = null;

  drop.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    var f = fileInput.files[0]; if (!f) return;
    var img = document.createElement("img"); img.src = URL.createObjectURL(f);
    dropText.replaceChildren(img, document.createTextNode(f.name)); $("clear").hidden = false;
  });
  $("clear").addEventListener("click", function () {
    fileInput.value = ""; dropText.textContent = "اضغط لاختيار صورة"; $("clear").hidden = true;
  });

  function show(content, isErr) {
    var el = $("msg"); el.className = "msg" + (isErr ? " err" : ""); el.replaceChildren();
    if (typeof content === "string") el.textContent = content; else el.appendChild(content);
  }

  $("go").addEventListener("click", async function () {
    var prompt = $("prompt").value.trim(), file = fileInput.files[0];
    if (!prompt && !file) { show("اكتب برومت أو اختر صورة (أو الاثنين).", true); return; }
    if (usage().n >= DAILY_LIMIT) { show("وصلت الحد اليومي المجاني (" + DAILY_LIMIT + "). عاود غداً.", true); return; }
    $("go").disabled = true; show("جاري التوليد...");
    try {
      var spec = await plan(prompt, file);
      if (spec.limited) { show(spec.message, true); return; }
      show("جاري توليد الصورة...");
      var imgs = await addImages(spec);
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var bytes = specToPsd(spec);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/vnd.adobe.photoshop" }));
      bumpUsage();
      var a = document.createElement("a");
      a.id = "download"; a.className = "dl"; a.href = blobUrl; a.download = "design.psd";
      a.textContent = "تحميل design.psd (" + spec.elements.length + " طبقات)";

      var notes = [];
      if (spec.fallback) {
        notes.push("الذكاء الاصطناعي غير متاح دابا، فاستعملنا تصميماً تجريبياً." + (spec.reason ? " (" + spec.reason + ")" : ""));
      } else if (imgs.limitMsg) {
        notes.push(imgs.limitMsg + " (وضعنا مربعاً مؤقتاً مكان الصورة.)");
      } else if (imgs.failed) {
        notes.push("تعذر توليد الصورة، فوضعنا مربعاً مؤقتاً مكانها." + (imgs.reason ? " (" + imgs.reason + ")" : ""));
      }
      var cutFailed = spec.elements.some(function (e) { return e.cutout && e._img && !e._cut; });
      if (cutFailed) notes.push("تعذر قص خلفية الصورة، فتركناها بخلفيتها.");

      if (notes.length) {
        var box = document.createElement("div");
        box.appendChild(a);
        notes.forEach(function (t) { var p = document.createElement("p"); p.textContent = t; box.appendChild(p); });
        show(box);
      } else show(a);
    } catch (err) {
      show("وقع خطأ: " + err.message, true);
    } finally { $("go").disabled = false; }
  });
})();
