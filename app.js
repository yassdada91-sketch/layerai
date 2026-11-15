import os
import re
import time
import tempfile
import urllib.request

import cv2
import gradio as gr
import numpy as np
import spaces
import torch
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
from rembg import new_session, remove
from scipy.optimize import linear_sum_assignment
from segment_anything import SamAutomaticMaskGenerator, SamPredictor, sam_model_registry
from torchvision.ops import batched_nms, nms
from torchvision.ops import box_iou as tv_box_iou
from transformers import Owlv2ForObjectDetection, Owlv2Processor

from utils import (
    TEXT_DROPS,
    ERRORS,
    BG_INFO,
    box_iou,
    build_main,
    detect_text,
    draw_points,
    fill_background,
    fit,
    kernel,
    overlap_frac,
    safe,
    soft_layer,
    refine_layer,
    reset_matte,
    _MATTE_T,
    _MATTE_ERR,
)

MAX_DIM = 1024
OUT_DIM = 1536
MAX_OBJECTS = 60
MAX_PERSONS = 10
MAX_QUERIES = 10       # أقصى عدد عناصر في وصف المستخدم
MODE_AUTO = "تلقائي (مقترح)"
BG_AUTO = "تلقائي (يترك الأصل إن كانت الإزالة كبيرة)"
BG_FILL = "ترميم الخلفية دائمًا"
BG_KEEP = "إبقاء الأصل (لا يُزال الأشخاص من الخلفية)"
MODE_DESIGN = "تصميم أو ملصق (بلا قص تلقائي لعنصر رئيسي)"
MODE_PHOTO = "صورة فوتوغرافية (بلا استخراج نصوص)"
MODE_ALL = "قص كل العناصر (تجريبي، أبطأ)"
ALL_MAX = 40
ALL_MIN_AREA = 0.0004
ALL_MAX_AREA = 0.25
REFINE_EDGES = False  # v25: تحسين الحواف التجريبي (guided filter) أنتج إطارًا ملونًا على الحواف، أُوقف
MAX_LOGOS = 4
GREEN = "هذا هو العنصر (أخضر)"
RED = "عنصر منفصل / ليس من الرئيسي (أحمر)"
KEEP = "إبقاء البكسلات تحت العناصر (قد تبقى بقايا)"
CUT = "قص العناصر من الرئيسي (قد يظهر ثقب)"
ALGO_NEW = "ترميم جديد v31 (ناعم + حبيبات)"
ALGO_OLD = "ترميم قديم v27"
# v31b: قناع النص من kmeans يلتقط لون الحبر فقط، فتبقى الحواف والتوهج أشباحًا في الخلفية.
# نوسّع قناع النص عند المسح بنسبة من ارتفاعه (0 = تعطيل، يعود سلوك v31). قيمة تخمينية.
TEXT_GROW_K = 0.15
TEXT_GROW_MAX = 17

# كلمات في وصف المستخدم تعني "النصوص" (تُعالج بـ EasyOCR لا بـ OWL)
TEXT_WORDS = {
    "text", "texts", "the text", "the texts", "title", "titles", "the title",
    "words", "writing", "letters", "caption", "captions", "headline", "all text",
}
TR_ID = "Helsinki-NLP/opus-mt-ar-en"
_ARABIC = re.compile(r"[\u0600-\u06ff]")

# إعدادات الوصف المخصص
CUSTOM_MIN_AREA = 0.004   # v41: كان 0.0015. أصغر مساحة صندوق (نسبة من الصورة)؛ يحيد المربعات الصغيرة (≈0.17%)
                          # ويبقي الأزرار والأيقونات (≥3%). خفّضه إن أردت أيقونات صغيرة مثل ✓
CUSTOM_FLOOR = 0.03       # أدنى درجة خام مقبولة إطلاقًا
CUSTOM_CAND_REL = 0.3     # نقبل كمرشّحين الصناديق التي درجتها ≥ هذه النسبة من أعلى درجة للوصف
CUSTOM_DBG = []           # تشخيص الوصف المخصص (يظهر في حقل الحالة)
POINT_MAX_AREA = 0.06     # أكبر قناع (نسبة من الصورة) تقبله النقطة اليدوية إن وُجد أصغر منه


def grow_text(m):
    if TEXT_GROW_K <= 0:
        return m
    ys, _ = np.where(m)
    if len(ys) == 0:
        return m
    bh = int(ys.max() - ys.min() + 1)
    k = int(min(TEXT_GROW_MAX, TEXT_GROW_K * bh)) | 1
    if k < 3:
        return m
    return cv2.dilate(m.astype(np.uint8), kernel(k)).astype(bool)

# 0 = شخص، 1 = شعار/أيقونة، 2 = جسم عام (منتج/حيوان)
QUERIES = [
    "a photo of a person",
    "a logo",
    "an app icon",
    "an emblem or badge",
    "a product",
    "an animal",
]
KIND = torch.tensor([0, 1, 1, 1, 2, 2])

CHECKPOINT = "sam_vit_b_01ec64.pth"
URL = "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"



def get_sam_checkpoint():
    """v31: موقع Meta انتهت شهادته (SSL)، فنحمّل من Hugging Face أولًا (نسخة مرآة رسمية
    لنفس الملف)، ونرجع إلى الرابط الأصلي احتياطًا."""
    if os.path.exists(CHECKPOINT):
        return CHECKPOINT
    try:
        from huggingface_hub import hf_hub_download

        return hf_hub_download("ybelkada/segment-anything", "checkpoints/sam_vit_b_01ec64.pth")
    except Exception as e:
        print(f"[warn] HF checkpoint failed: {e}")
    urllib.request.urlretrieve(URL, CHECKPOINT)
    return CHECKPOINT


sam = sam_model_registry["vit_b"](checkpoint=get_sam_checkpoint())
predictor = SamPredictor(sam)

_all_gen = [None]


def get_all_generator():
    """يُنشأ عند أول استعمال فقط (لا يؤثر على بقية الأوضاع)."""
    if _all_gen[0] is None:
        _all_gen[0] = SamAutomaticMaskGenerator(
            sam,
            points_per_side=24,
            pred_iou_thresh=0.88,
            stability_score_thresh=0.92,
            min_mask_region_area=60,
        )
    return _all_gen[0]


def sam_all_masks(arr, h, w):
    """كل القطع التي يجدها SAM، من الأكبر إلى الأصغر، بعد حذف الصغيرة جدًا والكبيرة جدًا."""
    out = []
    for d in get_all_generator().generate(arr):
        m = d["segmentation"].astype(bool)
        a = int(m.sum())
        if a < ALL_MIN_AREA * h * w or a > ALL_MAX_AREA * h * w:
            continue
        out.append((a, m))
    out.sort(key=lambda t: -t[0])
    return [m for _, m in out]

OWL_ID = "google/owlv2-base-patch16-ensemble"
owl_proc = Owlv2Processor.from_pretrained(OWL_ID)
owl = Owlv2ForObjectDetection.from_pretrained(OWL_ID).eval()

session = new_session("isnet-general-use")


# دالة فارغة: ZeroGPU يشترط وجود دالة مزخرفة، ولا تُستدعى أبدًا
@spaces.GPU(duration=1)
def _gpu_placeholder():
    return None


# ---------------------------------------------------------------- وصف المستخدم
_tr = [None]


def translate_ar(texts):
    """ترجمة عربية ← إنجليزية بنموذج Marian مجاني (يُحمَّل عند أول استعمال فقط).
    عند أي فشل نرجع النص الأصلي."""
    try:
        if _tr[0] is None:
            from transformers import MarianMTModel, MarianTokenizer

            tok = MarianTokenizer.from_pretrained(TR_ID)
            mdl = MarianMTModel.from_pretrained(TR_ID).eval()
            _tr[0] = (tok, mdl)
        tok, mdl = _tr[0]
        batch = tok(texts, return_tensors="pt", padding=True)
        with torch.no_grad():
            gen = mdl.generate(**batch, max_new_tokens=32, num_beams=4)
        outs = tok.batch_decode(gen, skip_special_tokens=True)
        return [o.strip().lower().rstrip(".") or t for o, t in zip(outs, texts)]
    except Exception as e:
        print(f"[warn] translate failed: {e}")
        ERRORS.append(f"translate: {str(e)[:80]}")
        return texts


def parse_desc(desc):
    """يقسّم الوصف إلى عناصر (فاصلة / و / and / سطر جديد) ويترجم العربي إلى الإنجليزية."""
    parts = re.split(r"\s*[,\n،;؛]\s*|\s+و\s+|\s+and\s+", desc or "")
    items = [p.strip() for p in parts if p and p.strip()][:MAX_QUERIES]
    ar_idx = [i for i, t in enumerate(items) if _ARABIC.search(t)]
    if ar_idx:
        tr = translate_ar([items[i] for i in ar_idx])
        for i, t in zip(ar_idx, tr):
            items[i] = t
    seen, out = set(), []
    for t in items:
        t = t.lower()
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def owl_custom(img, queries, thr=0.15, min_area=CUSTOM_MIN_AREA):
    """v40: توزيع أمثل بين الأوصاف والصناديق. كل وصف يأخذ صندوقًا واحدًا، ولا يتشارك
    وصفان الصندوق نفسه (كان وصفان يختاران نفس العنصر ويضيع الثاني).
    الدرجات تُطبَّع لكل وصف (درجة الصندوق ÷ أعلى درجة للوصف) ثم تُحلّ مسألة التعيين
    (linear_sum_assignment). حساسية الوصف (thr) تحدد أدنى درجة مطبَّعة = 2×thr.
    يرجع [(صندوق، درجة خام، وصف)]."""
    w, h = img.size
    inputs = owl_proc(text=[queries], images=img, return_tensors="pt")
    with torch.no_grad():
        out = owl(**inputs)
    probs = torch.sigmoid(out.logits[0])  # [N, عدد الأوصاف]
    cx, cy, bw, bh = out.pred_boxes[0].unbind(-1)
    S = max(h, w)  # الصورة تُحشى إلى مربع
    boxes = torch.stack(
        [(cx - bw / 2) * S, (cy - bh / 2) * S, (cx + bw / 2) * S, (cy + bh / 2) * S], dim=-1
    )
    boxes[:, 0::2] = boxes[:, 0::2].clamp(0, w - 1)
    boxes[:, 1::2] = boxes[:, 1::2].clamp(0, h - 1)
    bw_ = boxes[:, 2] - boxes[:, 0]
    bh_ = boxes[:, 3] - boxes[:, 1]
    valid = (bw_ >= 6) & (bh_ >= 6) & (bw_ * bh_ >= min_area * h * w)
    pv = probs * valid[:, None].float()  # الصناديق الصغيرة/المنحلة تصير درجتها صفرًا

    tops, cand = [], []
    for qi, q in enumerate(queries):
        sc = pv[:, qi]
        top = float(sc.max())
        tops.append(top)
        CUSTOM_DBG.append(f"{q}:{top:.2f}")
        if top < CUSTOM_FLOOR:
            continue
        idx = (sc >= max(CUSTOM_FLOOR, CUSTOM_CAND_REL * top)).nonzero().flatten()
        keep = nms(boxes[idx], sc[idx], 0.5)
        cand += idx[keep].tolist()

    qs_ok = [qi for qi, t in enumerate(tops) if t >= CUSTOM_FLOOR]
    if not qs_ok or not cand:
        return []

    # دمج الصناديق المتشابهة بين الأوصاف (IoU ≥ 0.6) في صندوق واحد
    uniq = []
    for i in cand:
        if all(float(tv_box_iou(boxes[i:i + 1], boxes[j:j + 1])[0, 0]) < 0.6 for j in uniq):
            uniq.append(i)

    M = np.zeros((len(qs_ok), len(uniq)), np.float32)  # الدرجة المطبَّعة
    R = np.zeros_like(M)                                # الدرجة الخام
    for c, j in enumerate(uniq):
        near = tv_box_iou(boxes[j:j + 1], boxes)[0] >= 0.6
        for r, qi in enumerate(qs_ok):
            raw = float(pv[near, qi].max())
            R[r, c] = raw
            M[r, c] = raw / tops[qi]

    rows, cols = linear_sum_assignment(-M)
    min_norm = max(0.1, 2.0 * thr)
    res = []
    for r, c in zip(rows, cols):
        if R[r, c] < CUSTOM_FLOOR or M[r, c] < min_norm:
            continue
        res.append((boxes[uniq[c]].tolist(), float(R[r, c]), queries[qs_ok[r]]))
    res.sort(key=lambda t: -t[1])
    return res


def add_layer(psd, img, name, left=0, top=0, visible=True):
    layer = PixelLayer.frompil(img, psd, top=top, left=left)
    layer.name = name
    psd.append(layer)
    if not visible:
        try:
            layer.visible = False
        except Exception as e:
            ERRORS.append(f"hide: {str(e)[:60]}")


# ---------------------------------------------------------------- UI events
def on_upload(img):
    if img is None:
        return None, None, []
    full = fit(img, OUT_DIM)
    return full, fit(full, MAX_DIM), []


def on_click(orig, pts, mode, evt: gr.SelectData):
    if orig is None:
        return None, pts
    small = fit(orig, MAX_DIM)
    x, y = evt.index[0], evt.index[1]
    pts = pts + [(int(x), int(y), 1 if mode == GREEN else 0)]
    return draw_points(small, pts), pts


def on_clear(orig):
    if orig is None:
        return None, []
    return fit(orig, MAX_DIM), []


# ---------------------------------------------------------------- detection
def owl_detect(img, pthr, lthr, othr):
    w, h = img.size
    inputs = owl_proc(text=[QUERIES], images=img, return_tensors="pt")
    with torch.no_grad():
        out = owl(**inputs)

    probs = torch.sigmoid(out.logits[0])
    scores, labels = probs.max(dim=-1)
    pred = out.pred_boxes[0]

    S = max(h, w)  # الصورة تُحشى إلى مربع
    cx, cy, bw, bh = pred.unbind(-1)
    boxes = torch.stack(
        [
            (cx - bw / 2) * S,
            (cy - bh / 2) * S,
            (cx + bw / 2) * S,
            (cy + bh / 2) * S,
        ],
        dim=-1,
    )

    keep = scores > 0.1
    boxes, scores, labels = boxes[keep], scores[keep], labels[keep]
    if len(boxes) == 0:
        return [], [], []

    kinds = KIND[labels]
    keep = batched_nms(boxes, scores, kinds, 0.4)
    boxes = boxes[keep].cpu().numpy()
    scores = scores[keep].cpu().numpy()
    kinds = kinds[keep].cpu().numpy()

    persons, logos, objs = [], [], []
    for b, s, k in zip(boxes, scores, kinds):
        b = [
            max(float(b[0]), 0),
            max(float(b[1]), 0),
            min(float(b[2]), w - 1),
            min(float(b[3]), h - 1),
        ]
        if b[2] - b[0] < 8 or b[3] - b[1] < 8:
            continue
        if k == 0 and s >= pthr:
            persons.append((b, float(s)))
        elif k == 1 and s >= lthr:
            logos.append((b, float(s)))
        elif k == 2 and s >= othr:
            objs.append((b, float(s)))

    for lst in (persons, logos, objs):
        lst.sort(key=lambda t: -t[1])
    return persons, logos, objs


def sam_box(box, h, w):
    b = np.array(box, dtype=np.float32)
    ms, scores, _ = predictor.predict(box=b, multimask_output=True)
    ba = (b[2] - b[0]) * (b[3] - b[1])
    best, best_r = None, -1.0
    for m, s in zip(ms, scores):
        a = int(m.sum())
        if a < 40 or a > 0.9 * h * w or a > 1.15 * ba:
            continue
        # v10: القناع الجيد يملأ الصندوق (لا رأسًا فقط من شخص كامل)
        ys, xs = np.where(m)
        fill = box_iou([xs.min(), ys.min(), xs.max() + 1, ys.max() + 1], b)
        r = 0.6 * fill + 0.4 * float(s)
        if r > best_r:
            best, best_r = m.astype(bool), r
    return best


def subject_from_points(pts):
    coords = np.array([[x, y] for x, y, _ in pts], dtype=np.float32)
    labels = np.array([l for _, _, l in pts], dtype=np.int32)
    multi = len(pts) == 1
    ms, scores, _ = predictor.predict(
        point_coords=coords, point_labels=labels, multimask_output=multi
    )
    m = ms[int(scores.argmax())] if multi else ms[0]
    return m.astype(bool)


def subject_fallback(small):
    m = remove(small, session=session, only_mask=True)
    return np.array(m.convert("L")) > 127


def element_at_point(arr, x, y, text_masks):
    """v39: نفضّل القناع بحجم عنصر عادي (حتى POINT_MAX_AREA من الصورة) كي لا تبتلع
    النقطة الجيران (نص كبير، لائحة...). وإلا نأخذ أصغر قناع متاح."""
    h, w = arr.shape[:2]
    for tm in text_masks:
        d = cv2.dilate(tm.astype(np.uint8), kernel(15))
        if d[y, x]:
            return tm
    ms, scores, _ = predictor.predict(
        point_coords=np.array([[x, y]], dtype=np.float32),
        point_labels=np.array([1], dtype=np.int32),
        multimask_output=True,
    )
    cands = [(int(m.sum()), float(s), m) for m, s in zip(ms, scores) if int(m.sum()) >= 100]
    pool = [c for c in cands if c[0] <= POINT_MAX_AREA * h * w]
    if not pool:
        pool = sorted(cands, key=lambda c: c[0])[:1]
    return max(pool, key=lambda c: c[1])[2] if pool else None


def drop_crowd_boxes(boxes, h, w):
    """v23: صندوق "شخص" يغطي شريط جمهور أو مجموعة (عريض جدًا، أو يحوي 3 صناديق أخرى
    على الأقل) ليس شخصًا واحدًا. نتجاهله عند اختيار العنصر الرئيسي إن وُجد غيره."""
    keep = []
    for b in boxes:
        bw, bh = b[2] - b[0], b[3] - b[1]
        wide = bw > 0.6 * w and bh < 0.6 * bw
        inside = sum(
            1 for o in boxes
            if o is not b and b[0] <= (o[0] + o[2]) / 2 <= b[2] and b[1] <= (o[1] + o[3]) / 2 <= b[3]
        )
        if not (wide or inside >= 3):
            keep.append(b)
    return keep if keep else list(boxes)


def pick_subject(pts, persons, objs, small, h, w, allow_rembg=True):
    """يرجع (قناع، مصدر، صناديق، أشخاص إضافيون). المسارات: نقاط ← أشخاص ← جسم ← rembg."""
    if any(p[2] == 1 for p in pts):
        return subject_from_points(pts), "نقاطك", [], []
    found = []
    cand = [b for b, _ in persons[:MAX_PERSONS + 4]]
    cand = drop_crowd_boxes(cand, h, w)
    for b in cand:
        if (b[2] - b[0]) * (b[3] - b[1]) < 0.004 * h * w:
            continue
        m = safe(sam_box, None, b, h, w)
        if m is not None:
            # v23: في الصور الجماعية قد يعيد SAM قناع المدرجات/الحشد (عرضه كامل الصورة) لصندوق
            # شخص؛ لا يصلح أن يكون شخصًا ولا عنصرًا رئيسيًا
            if len(cand) >= 3:
                xs_ = np.where(m.any(axis=0))[0]
                if len(xs_) and (xs_[-1] - xs_[0] + 1) > 0.6 * w:
                    continue
                # v26: قطع الجمهور في أعلى الصورة: قناع داكن (إضاءة متوسطة < 70) ينتهي
                # في النصف العلوي. قياسات الصورة الجماعية: الجمهور 30-34 وينتهي عند 0.38-0.40 من
                # الارتفاع، واللاعبون 140 فأكثر وينتهون عند 0.9 فأكثر
                ys_ = np.where(m.any(axis=1))[0]
                a_ = np.asarray(small)
                if len(ys_) and a_.ndim == 3 and a_.shape[:2] == m.shape:
                    lum_ = float((0.299 * a_[..., 0] + 0.587 * a_[..., 1] + 0.114 * a_[..., 2])[m].mean())
                    if (ys_[-1] + 1) / float(h) < 0.55 and lum_ < 70:
                        continue
            found.append((int(m.sum()), m, b))
    found.sort(key=lambda t: -t[0])
    found = found[:MAX_PERSONS]
    if found:
        # الأكبر = العنصر الرئيسي، والباقون طبقات مستقلة
        return found[0][1], "شخص", [t[2] for t in found], [t[1] for t in found[1:]]
    for b, _ in objs[:1]:
        m = safe(sam_box, None, b, h, w)
        if m is not None:
            return m, "جسم", [b], []
    fb = safe(subject_fallback, None, small) if allow_rembg else None
    # v14: قناع rembg الذي يغطي أكثر من 45% غالبًا تصميم كامل لا عنصر رئيسي
    if fb is not None and 0.01 <= fb.mean() <= 0.45:
        return fb, "rembg", [], []
    return np.zeros((h, w), bool), "لا شيء", [], []


# ---------------------------------------------------------------- pipeline
def process(orig, pts, auto, pthr, lthr, othr, keep_mode, use_lama, proc_mode=MODE_AUTO,
            bg_pol=BG_AUTO, bg_algo=ALGO_NEW, desc="", cthr=0.15):
    if orig is None:
        return None, None, "ارفع صورة أولًا."

    ERRORS.clear()
    pts = pts or []

    small = fit(orig, MAX_DIM)
    arr = np.array(small)
    h, w = arr.shape[:2]
    full = np.array(orig.convert("RGB"))
    H, W = full.shape[:2]

    def up(m):
        if (H, W) == (h, w):
            return m.astype(bool)
        r = cv2.resize(m.astype(np.uint8) * 255, (W, H), interpolation=cv2.INTER_LINEAR)
        return r > 127

    # إن كتب المستخدم وصفًا نستخرج ما طلبه فقط (بلا كشف تلقائي)
    qs_all = parse_desc(desc)
    custom = len(qs_all) > 0
    qs = [q for q in qs_all if q not in TEXT_WORDS]
    wants_text = len(qs) != len(qs_all)

    _t0 = time.time()
    predictor.set_image(arr)

    persons, logos, objs = [], [], []
    if auto and not custom:
        persons, logos, objs = safe(owl_detect, ([], [], []), small, pthr, lthr, othr)

    if custom and not any(p[2] == 1 for p in pts):
        subj, src, used_boxes, extras = np.zeros((h, w), bool), "وصف", [], []
    else:
        subj, src, used_boxes, extras = pick_subject(
            pts, persons, objs, small, h, w,
            allow_rembg=(proc_mode not in (MODE_DESIGN, MODE_ALL)),
        )
    no_subject = subj.sum() == 0
    # v12: قناع rembg يغطي المحتوى كله في التصاميم، فلا نتجاهل النصوص داخله
    ref = subj if (subj.mean() < 0.6 and src != "rembg") else np.zeros_like(subj)

    _t1 = time.time()
    if custom:
        run_text = auto and wants_text
    else:
        run_text = auto and proc_mode != MODE_PHOTO
    texts = safe(detect_text, [], arr, ref) if run_text else []
    _t2 = time.time()
    text_masks = [t[0] for t in texts]

    elems, names, union = [], [], np.zeros((h, w), bool)

    def add(m, name):
        nonlocal union
        if m is None or len(elems) >= MAX_OBJECTS:
            return None
        m = m.astype(bool)
        if m.sum() < 40 or overlap_frac(m, union) > 0.5:
            return None
        elems.append(m & ~union)
        names.append(name)
        union |= m
        return elems[-1]

    # العناصر التي وصفها المستخدم (OWLv2 يحدد الصندوق وSAM يقص القناع).
    # تُعالج قبل النقاط اليدوية، كي لا يبتلع قناع نقطة كبير ما وجده الوصف.
    CUSTOM_DBG.clear()
    custom_found = {}
    if qs:
        for b, sc, lbl in safe(owl_custom, [], small, qs, cthr):
            sm = safe(sam_box, None, b, h, w)
            how = "صندوق"
            if sm is None:
                # احتياط: نقطة في وسط الصندوق (بقناع بحجم عنصر عادي)
                sm = safe(element_at_point, None, arr,
                          int((b[0] + b[2]) / 2), int((b[1] + b[3]) / 2), [])
                how = "نقطة" if sm is not None else "فشل"
            ok = add(sm, f"{lbl} {sc:.2f}") is not None
            if ok:
                custom_found[lbl] = custom_found.get(lbl, 0) + 1
            CUSTOM_DBG.append(
                f"[{lbl[:16]} {sc:.2f} صندوق={int(b[0])},{int(b[1])},{int(b[2])},{int(b[3])}"
                f" SAM={how} {'أُضيف' if ok else 'رُفض'}]"
            )

    for x, y, lab in pts:
        if lab == 0:
            add(safe(element_at_point, None, arr, x, y, text_masks), "عنصر يدوي")

    for i, pm in enumerate(extras, start=2):
        add(pm, f"شخص {i}")

    if src in ("شخص", "جسم"):
        for b, _ in objs[:4]:
            if any(box_iou(b, pb) > 0.3 for pb in used_boxes):
                continue
            add(safe(sam_box, None, b, h, w), "جسم")

    # v11: الشعارات قبل النصوص (كي لا تُقرأ أيقونة كنص) + تشديد فلترة الشعارات (مساحة معقولة، ليست نصًا، قناع ممتلئ)
    text_union = np.zeros((h, w), bool)
    for tm in text_masks:
        text_union |= tm
    text_zone = cv2.dilate(text_union.astype(np.uint8), kernel(max(9, w // 80))).astype(bool)

    logos_added = 0
    for b, sc in logos[:MAX_LOGOS]:
        x0, y0, x1, y1 = int(b[0]), int(b[1]), int(b[2]), int(b[3])
        area = (x1 - x0) * (y1 - y0)
        if area > 0.08 * h * w or area < 0.0003 * h * w:
            continue
        if any(box_iou(b, pb) > 0.5 for pb in used_boxes):
            continue
        if sc < 0.25 and text_zone[y0:y1, x0:x1].mean() > 0.4:
            continue
        lm = safe(sam_box, None, b, h, w)
        if lm is None or lm.sum() < 0.2 * area:
            continue
        if add(lm, f"شعار {sc:.2f}") is not None:
            logos_added += 1

    flat = []  # نصوص على خلفية موحدة اللون: تُملأ بلون الخلفية بدل LaMa
    text_grown = np.zeros((h, w), bool)
    flat_grown = np.zeros((h, w), bool)
    for tm, txt, col in texts:
        got = add(tm, "نص: " + txt if txt else "نص")
        if got is not None:
            g_ = grow_text(got)
            if col is not None:
                flat.append((got, col))
                flat_grown |= g_
            else:
                text_grown |= g_

    # وضع "قص كل العناصر": قطع SAM التلقائية تُضاف بعد النصوص والشعارات (كي لا تتداخل معها)
    auto_added = 0
    _ta0 = time.time()
    if proc_mode == MODE_ALL and not custom:
        for am in safe(sam_all_masks, [], arr, h, w):
            if len(elems) >= MAX_OBJECTS or auto_added >= ALL_MAX:
                break
            if subj.sum() > 0 and overlap_frac(am, subj) > 0.5:
                continue  # داخل العنصر الرئيسي: لا نقطّعه لأجزاء
            if add(am, f"عنصر {auto_added + 1}") is not None:
                auto_added += 1
    _ta1 = time.time()

    keep_under = keep_mode != CUT
    main_mask = safe(build_main, subj, subj, elems, keep_under)

    flat_union = np.zeros((h, w), bool)
    for fm, _ in flat:
        flat_union |= fm
    # v27: في الصور الجماعية يترك الترميم تلطيخًا وأشباحًا؛ فنُبقي الأشخاص في الخلفية الأصلية
    # (هم موجودون أيضًا كطبقات مستقلة) إلا إن اختار المستخدم الترميم دائمًا
    person_u = np.zeros((h, w), bool)
    for m_, nm_ in zip(elems, names):
        if nm_.startswith(("شخص", "جسم")):
            person_u |= m_
    person_u |= main_mask
    n_people = len(extras) + (1 if src == "شخص" else 0)
    keep_orig = (bg_pol == BG_KEEP) or (
        bg_pol == BG_AUTO and n_people >= 3 and float(person_u.mean()) > 0.12
    )
    rm_mask = (main_mask | union | text_grown) & ~flat_grown & ~flat_union
    if keep_orig:
        rm_mask = rm_mask & ~person_u
    _t3 = time.time()
    bg = fill_background(full, up(rm_mask), bool(use_lama), new=(bg_algo != ALGO_OLD)).copy()
    _t4 = time.time()
    for fm, col in flat:
        d = cv2.dilate(up(grow_text(fm)).astype(np.uint8), kernel(5)).astype(bool)
        bg[d] = col

    psd = PSDImage.new("RGB", (W, H))
    add_layer(psd, Image.fromarray(full).convert("RGBA"), "الصورة الأصلية (مخفية)", visible=False)
    add_layer(psd, Image.fromarray(bg).convert("RGBA"), "الخلفية")

    main_preview = None
    reset_matte()
    if main_mask.sum() > 0:
        res = (refine_layer if REFINE_EDGES else soft_layer)(full, up(main_mask))
        if res is not None:
            img, x, y = res
            add_layer(psd, img, "العنصر الرئيسي", left=x, top=y)
            main_preview = img

    count = 0
    for m, nm in zip(elems, names):
        # حواف ناعمة للأشخاص والأجسام فقط؛ النصوص والشعارات تبقى بحوافها الحادة
        fn = refine_layer if (REFINE_EDGES and nm.startswith(("شخص", "جسم"))) else soft_layer
        res = fn(full, up(m))
        if res is None:
            continue
        img, x, y = res
        count += 1
        add_layer(psd, img, f"{count}. {nm}", left=x, top=y)
        if main_preview is None:
            main_preview = img

    path = os.path.join(tempfile.mkdtemp(), "output.psd")
    psd.save(path)

    msg = f"تم: مصدر الرئيسي = {src} | أشخاص مفصولون = {len(extras) + (src == 'شخص')} | عناصر = {count}"
    if no_subject:
        msg += " (لا عنصر رئيسي: خلفية + عناصر فقط)"
    if custom:
        got_ = ", ".join(f"{k}×{v}" for k, v in custom_found.items()) or "لا شيء"
        miss_ = [q for q in qs if q not in custom_found]
        msg += f" | طلبك (مترجم): {', '.join(qs_all)} | وُجد: {got_}"
        if wants_text:
            msg += f" | نصوص={len(texts)}"
        if miss_:
            msg += f" | لم يُعثر على: {', '.join(miss_)} (جرّب وصفًا أوضح، أو خفّض حساسية الوصف، أو انقر على العنصر بنقطة حمراء)"
        if CUSTOM_DBG:
            msg += " | تشخيص الوصف: " + " ; ".join(CUSTOM_DBG)
    else:
        msg += (
            f" [v41 | أشخاص={len(persons)} | أجسام={len(objs)}"
            f" | شعارات={logos_added}/{len(logos)} | نصوص={len(texts)}]"
        )
    msg += f" | زمن(ث): قص={_t1-_t0:.0f} نص={_t2-_t1:.0f} خلفية={_t4-_t3:.0f}"
    if proc_mode == MODE_ALL and not custom:
        msg += f" | عناصر تلقائية={auto_added} (زمن={_ta1-_ta0:.0f}ث)"
    if _MATTE_ERR[0]:
        msg += " | خطأ تنعيم: " + _MATTE_ERR[0]
    if BG_INFO:
        msg += " | ترميم: " + " ; ".join(BG_INFO[:8])
    if keep_orig:
        msg += " | خلفية: أُبقي الأصل (إزالة الأشخاص كبيرة)"
    if TEXT_DROPS and auto and run_text:
        msg += " | تشخيص النص: " + " ; ".join(TEXT_DROPS[:9])
    if logos:
        msg += " | درجات الشعارات: " + ",".join(f"{s:.2f}" for _, s in logos[:8])
    if ERRORS:
        msg += " | أخطاء: " + " ; ".join(ERRORS[:3])
    return path, main_preview, msg


# ---------------------------------------------------------------- UI
with gr.Blocks(title="Image to PSD") as demo:
    gr.Markdown(
        "# تحويل الصورة إلى طبقات منفصلة\n"
        "ارفع صورتك، **واكتب ما تريد استخراجه كطبقات** (أو اتركه فارغًا للتفكيك التلقائي)، "
        "ثم اضغط «استخراج الطبقات».\n\n"
        "⚠️ **اقتراح طبقات وليس فصلًا مثاليًا:** قد تبقى بقايا في الخلفية."
    )

    orig_state = gr.State(None)
    pts_state = gr.State([])
    auto_state = gr.State(True)

    inp = gr.Image(type="pil", label="الصورة", sources=["upload", "clipboard"])
    desc = gr.Textbox(
        label="ماذا تريد أن أستخرج كطبقات؟ (افصل بفاصلة)",
        placeholder="مثال: أيقونة Ps, مجلد zip أصفر, زر التحميل, النصوص   —   أو بالإنجليزية: a Photoshop Ps app icon, a yellow folder with a zipper, a yellow rounded button with a download arrow, text",
        lines=2,
    )
    run_btn = gr.Button("استخراج الطبقات", variant="primary")
    proc_mode = gr.Radio(
        [MODE_AUTO, MODE_DESIGN, MODE_PHOTO, MODE_ALL],
        value=MODE_AUTO,
        label="وضع المعالجة (عند ترك الوصف فارغًا فقط)",
    )
    bg_pol = gr.Radio(
        [BG_AUTO, BG_FILL, BG_KEEP],
        value=BG_AUTO,
        label="طريقة الخلفية (بعد فصل الأشخاص)",
    )
    status = gr.Textbox(label="الحالة", interactive=False)
    out_file = gr.File(label="ملف PSD الناتج")
    out_main = gr.Image(label="معاينة العنصر الرئيسي / أول طبقة", type="pil")

    with gr.Accordion("تصحيح (اختياري)", open=False):
        gr.Markdown(
            "اضبط الحساسية أو انقر على الصورة لوضع نقاط "
            "(اختر «عنصر منفصل (أحمر)» ثم انقر على العنصر الذي فاته الوصف)، "
            "ثم اضغط «استخراج الطبقات»."
        )
        cthr = gr.Slider(0.05, 0.6, value=0.15, step=0.01, label="حساسية الوصف (أقل = يلتقط أكثر)")
        pthr = gr.Slider(0.10, 0.8, value=0.10, step=0.05, label="حساسية الأشخاص (أقل = يلتقط أكثر)")
        othr = gr.Slider(0.10, 0.8, value=0.10, step=0.05, label="حساسية الأجسام/المنتجات")
        lthr = gr.Slider(0.05, 0.8, value=0.25, step=0.05, label="حساسية الشعارات")
        keep_mode = gr.Radio([KEEP, CUT], value=KEEP, label="معالجة ما تحت الشعارات والنصوص")
        use_lama = gr.Checkbox(value=True, label="تنظيف الخلفية بـ LaMa (أبطأ وأجمل)")
        bg_algo = gr.Radio([ALGO_NEW, ALGO_OLD], value=ALGO_NEW, label="خوارزمية ترميم الخلفية (للمقارنة)")
        annotated = gr.Image(type="pil", label="انقر لوضع نقاط", interactive=False)
        mode = gr.Radio([GREEN, RED], value=GREEN, label="نوع النقطة")
        clear_btn = gr.Button("مسح النقاط")

    ctrl = [orig_state, pts_state, auto_state, pthr, lthr, othr, keep_mode, use_lama,
            proc_mode, bg_pol, bg_algo, desc, cthr]
    outs = [out_file, out_main, status]

    # الرفع يحفظ الصورة فقط؛ المعالجة بالزر (أو Enter في حقل الوصف) لتوفير وقت CPU
    inp.upload(on_upload, inp, [orig_state, annotated, pts_state])
    inp.clear(
        lambda: (None, None, [], None, None, ""),
        None,
        [orig_state, annotated, pts_state, out_file, out_main, status],
    )
    annotated.select(on_click, [orig_state, pts_state, mode], [annotated, pts_state])
    clear_btn.click(on_clear, orig_state, [annotated, pts_state])
    run_btn.click(process, ctrl, outs)
    desc.submit(process, ctrl, outs)


if __name__ == "__main__":
    demo.queue().launch()
