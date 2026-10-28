"""Builds a layered PSD: one real pixel layer per generated element."""
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

from generator import generate
from schema import DesignSpec


def build_psd(spec: DesignSpec, out_path: str) -> str:
    psd = PSDImage.new("RGBA", (spec.width, spec.height))
    for e in sorted(spec.elements, key=lambda el: el.z):   # back -> front
        img = generate(e)
        layer = PixelLayer.frompil(img, psd, e.name, top=e.y, left=e.x)
        psd.append(layer)
    psd.save(out_path)
    return out_path
