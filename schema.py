"""Design spec: the JSON the planner produces and the rest of the pipeline consumes."""
from typing import Literal, Optional
from pydantic import BaseModel, Field


class Element(BaseModel):
    id: str
    kind: Literal["background", "shape", "text", "image"]
    name: str
    x: int
    y: int
    w: int
    h: int
    z: int = 0
    # shape / background
    color: Optional[str] = "#ffffff"
    color2: Optional[str] = None          # second color -> vertical gradient
    # text
    text: Optional[str] = None
    font_size: int = 48
    text_color: str = "#000000"
    # image (person, object, icon...) -> generated independently
    description: Optional[str] = None


class DesignSpec(BaseModel):
    width: int = 1280
    height: int = 720
    elements: list[Element] = Field(default_factory=list)
