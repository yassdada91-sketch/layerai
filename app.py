"""FastAPI: serves the web page and POST /generate (image and/or prompt -> PSD file)."""
import os
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from assembler import build_psd
from planner import plan

DAILY_LIMIT = int(os.getenv("DAILY_LIMIT", "3"))          # free generations per IP per day
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_MB", "8")) * 1024 * 1024
INDEX_FILE = Path(__file__).parent / "index.html"

app = FastAPI(title="LayerAI")
# Allow the page to be hosted elsewhere (e.g. Cloudflare Pages). Set ALLOWED_ORIGINS to restrict.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["POST"],
    allow_headers=["*"],
)

_usage: dict[str, list[float]] = defaultdict(list)       # in-memory; resets on restart


def _check_limit(ip: str) -> None:
    now = time.time()
    _usage[ip] = [t for t in _usage[ip] if now - t < 86400]
    if len(_usage[ip]) >= DAILY_LIMIT:
        raise HTTPException(429, "وصلت الحد اليومي المجاني. عاود غداً.")
    _usage[ip].append(now)


@app.post("/generate")
async def generate(request: Request,
                   prompt: Optional[str] = Form(None),
                   image: Optional[UploadFile] = File(None)):
    data = await image.read() if image else None
    if data and len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "الصورة كبيرة بزاف.")
    prompt = (prompt or "").strip() or None
    if not prompt and not data:
        raise HTTPException(400, "Send a prompt, an image, or both.")
    _check_limit(request.client.host if request.client else "unknown")
    spec = plan(prompt, data)
    out = tempfile.NamedTemporaryFile(suffix=".psd", delete=False).name
    build_psd(spec, out)
    return FileResponse(out, filename="design.psd", media_type="image/vnd.adobe.photoshop")


@app.get("/")
def home():
    return FileResponse(INDEX_FILE, media_type="text/html")
