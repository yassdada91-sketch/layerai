/* LayerAI (static): prompt/image -> design spec -> one canvas per element -> layered PSD, all in the browser. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ config
  // Leave empty to use the built-in offline demo planner.
  // Later: put the URL of the Cloudflare Worker that talks to the AI model.
  var PLANNER_URL = (window.LAYERAI_CONFIG && window.LAYERAI_CONFIG.PLANNER_URL) || "";
  var DAILY_LIMIT = 3;

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

  async function plan(prompt, imageFile) {
    if (!PLANNER_URL) return demoSpec(prompt);
    try {
      var fd = new FormData();
      if (prompt) fd.append("prompt", prompt);
      if (imageFile) fd.append("image", imageFile);
      var res = await fetch(PLANNER_URL, { method: "POST", body: fd });
      if (!res.ok) throw new Error("planner " + res.status);
      var spec = await res.json();
      if (!spec || !Array.isArray(spec.elements)) throw new Error("bad spec");
      return spec;
    } catch (_) {
      var d = demoSpec(prompt); d.fallback = true; return d; // AI unavailable -> offline demo design
    }
  }

  // --------------------------------------------------------------- rendering
  function makeCanvas(w, h) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
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

  // Real text drawn by the browser -> Arabic shaping and right-to-left work natively.
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
    var rtl = /[֐-ࣿ]/.test(e.text || "");
    g.direction = rtl ? "rtl" : "ltr"; g.textAlign = rtl ? "right" : "left";
    lines.forEach(function (l, i) { g.fillText(l, rtl ? c.width - pad : pad, pad + i * lh); });
    return { canvas: c, x: e.x - pad, y: e.y - pad };
  }

  // Placeholder until an image-generation backend is connected.
  function renderImagePlaceholder(e) {
    var c = makeCanvas(e.w, e.h), g = c.getContext("2d");
    g.fillStyle = "rgba(255,255,255,0.18)"; g.strokeStyle = "rgba(255,255,255,0.8)"; g.lineWidth = 4;
    var r = 24, w = c.width - 4, h = c.height - 4;
    g.beginPath();
    g.moveTo(2 + r, 2); g.arcTo(2 + w, 2, 2 + w, 2 + h, r); g.arcTo(2 + w, 2 + h, 2, 2 + h, r);
    g.arcTo(2, 2 + h, 2, 2, r); g.arcTo(2, 2, 2 + w, 2, r); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = "#fff"; g.font = "20px sans-serif"; g.textBaseline = "top";
    g.fillText(String(e.description || e.name).slice(0, 36), 16, 16);
    return { canvas: c, x: e.x, y: e.y };
  }

  var RENDER = { background: renderBackground, shape: renderShape, text: renderText, image: renderImagePlaceholder };

  // --------------------------------------------------------------------- PSD
  function specToPsd(spec) {
    var layers = spec.elements.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).map(function (e) {
      var r = (RENDER[e.kind] || renderShape)(e), c = r.canvas;
      var data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
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
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      var bytes = specToPsd(spec);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/vnd.adobe.photoshop" }));
      bumpUsage();
      var a = document.createElement("a");
      a.id = "download"; a.className = "dl"; a.href = blobUrl; a.download = "design.psd";
      a.textContent = "تحميل design.psd (" + spec.elements.length + " طبقات)";
      if (spec.fallback) {
        var box = document.createElement("div"), note = document.createElement("p");
        note.textContent = "الذكاء الاصطناعي غير متاح دابا (يمكن وصل الحد اليومي)، فاستعملنا تصميماً تجريبياً.";
        box.appendChild(a); box.appendChild(note); show(box);
      } else show(a);
    } catch (err) {
      show("وقع خطأ: " + err.message, true);
    } finally { $("go").disabled = false; }
  });
})();
