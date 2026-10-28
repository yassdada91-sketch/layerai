"""Generates each element independently as its own RGBA image (never cropped from a source)."""
import io
import os

import requests
from PIL import Image, ImageDraw, ImageFont

from schema import Element


def _rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _font(size: int):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_background(e: Element) -> Image.Image:
    img = Image.new("RGBA", (e.w, e.h), _rgb(e.color) + (255,))
    if e.color2:
        a, b = _rgb(e.color), _rgb(e.color2)
        d = ImageDraw.Draw(img)
        for y in range(e.h):
            t = y / max(e.h - 1, 1)
            d.line([(0, y), (e.w, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,))
    return img


def draw_shape(e: Element) -> Image.Image:
    return Image.new("RGBA", (e.w, e.h), _rgb(e.color) + (255,))


def draw_text(e: Element) -> Image.Image:
    # NOTE: arabic needs arabic_reshaper + python-bidi before drawing (see README TODO)
    img = Image.new("RGBA", (e.w, e.h), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((0, 0), e.text or "", font=_font(e.font_size), fill=_rgb(e.text_color) + (255,))
    return img


def generate_image_element(e: Element) -> Image.Image:
    """Independent generation of a person/object/icon with transparent background."""
    backend = os.getenv("IMAGE_BACKEND", "mock")
    if backend == "hf":
        return _generate_hf(e)
    return _placeholder(e)


def _generate_hf(e: Element) -> Image.Image:
    """Hugging Face Inference API (free tier, rate-limited). Set HF_TOKEN. Then remove bg with rembg."""
    from rembg import remove
    model = os.getenv("HF_MODEL", "black-forest-labs/FLUX.1-schnell")
    prompt = f"{e.description}, single isolated subject, plain white background, centered, high quality"
    r = requests.post(f"https://api-inference.huggingface.co/models/{model}",
                      headers={"Authorization": f"Bearer {os.environ['HF_TOKEN']}"},
                      json={"inputs": prompt}, timeout=180)
    r.raise_for_status()
    img = remove(Image.open(io.BytesIO(r.content)).convert("RGB"))
    return img.resize((e.w, e.h))


def _placeholder(e: Element) -> Image.Image:
    img = Image.new("RGBA", (e.w, e.h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, e.w - 1, e.h - 1], 24, fill=(255, 255, 255, 60), outline=(255, 255, 255, 200), width=4)
    d.text((16, 16), (e.description or e.name)[:40], font=_font(20), fill=(255, 255, 255, 255))
    return img


def generate(e: Element) -> Image.Image:
    return {"background": draw_background, "shape": draw_shape,
            "text": draw_text, "image": generate_image_element}[e.kind](e)
