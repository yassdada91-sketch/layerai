"""Planner: turns (prompt | image | image + prompt) into a DesignSpec.

The three input modes only differ in what we send to the vision/LLM backend:
  - prompt only      -> "design a layout for: <prompt>"
  - image only       -> "describe every element of this design as JSON"
  - image + prompt   -> "use this image as reference, apply these changes: <prompt>"
"""
import base64
import json
import os
from typing import Optional

import requests

from schema import DesignSpec

SYSTEM = """You are a design analyst. Return ONLY valid JSON matching:
{"width":int,"height":int,"elements":[{"id":str,"kind":"background|shape|text|image",
"name":str,"x":int,"y":int,"w":int,"h":int,"z":int,"color":"#hex","color2":"#hex|null",
"text":str|null,"font_size":int,"text_color":"#hex","description":str|null}]}
Rules: one element per distinct visual item. Each person/animal/object/icon is its own
kind=image element with a rich standalone description (isolated subject, no background).
Text is kind=text with the exact string. Backgrounds/shapes are drawn by code. Lower z = further back."""


def build_user_message(prompt: Optional[str], has_image: bool) -> str:
    if has_image and prompt:
        return f"Use the attached image as the reference design. Apply these instructions: {prompt}"
    if has_image:
        return "Reconstruct the attached design as a list of independent elements."
    return f"Create a design layout for: {prompt}"


def plan(prompt: Optional[str] = None, image_bytes: Optional[bytes] = None) -> DesignSpec:
    if not prompt and not image_bytes:
        raise ValueError("Provide a prompt, an image, or both.")
    backend = os.getenv("PLANNER_BACKEND", "mock")
    if backend == "gemini":
        return _plan_gemini(prompt, image_bytes)
    return _plan_mock(prompt, image_bytes)


def _plan_gemini(prompt, image_bytes) -> DesignSpec:
    """Gemini free tier (check current limits). Set GEMINI_API_KEY."""
    key = os.environ["GEMINI_API_KEY"]
    model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
    parts = [{"text": build_user_message(prompt, bool(image_bytes))}]
    if image_bytes:
        parts.append({"inline_data": {"mime_type": "image/png",
                                      "data": base64.b64encode(image_bytes).decode()}})
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        json={"system_instruction": {"parts": [{"text": SYSTEM}]},
              "contents": [{"parts": parts}],
              "generationConfig": {"response_mime_type": "application/json"}},
        timeout=90,
    )
    r.raise_for_status()
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
    return DesignSpec(**json.loads(text))


def _plan_mock(prompt, image_bytes) -> DesignSpec:
    """Offline stub so the whole pipeline runs with zero cost/keys."""
    title = (prompt or "LayerAI")[:30]
    return DesignSpec(width=1280, height=720, elements=[
        {"id": "bg", "kind": "background", "name": "Background", "x": 0, "y": 0,
         "w": 1280, "h": 720, "z": 0, "color": "#1e3c72", "color2": "#2a5298"},
        {"id": "sh1", "kind": "shape", "name": "Accent bar", "x": 60, "y": 520,
         "w": 700, "h": 12, "z": 1, "color": "#ffb703"},
        {"id": "img1", "kind": "image", "name": "Main subject", "x": 820, "y": 120,
         "w": 380, "h": 480, "z": 2, "description": "a friendly cartoon robot, isolated"},
        {"id": "t1", "kind": "text", "name": "Title", "x": 60, "y": 260,
         "w": 700, "h": 120, "z": 3, "text": title, "font_size": 72, "text_color": "#ffffff"},
    ])
