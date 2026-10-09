"""Recipient-local executable discovery; no author-specific paths or credentials."""
import os
import shutil
import sys
from pathlib import Path


def ffmpeg_path() -> Path:
    configured = os.environ.get("FFMPEG_BIN")
    candidates = [configured, shutil.which("ffmpeg"), str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "magic-cut/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise FileNotFoundError("未找到 FFmpeg；请安装或配置 FFMPEG_BIN")


def ocr_python() -> Path:
    configured = os.environ.get("OCR_PYTHON")
    if configured:
        return Path(configured)
    root = Path(__file__).resolve().parents[1]
    legacy = root / ".venv-ocr" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return legacy if legacy.is_file() else Path(sys.executable)
