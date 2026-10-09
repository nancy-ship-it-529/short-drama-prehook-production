from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Any

import cv2
import numpy as np


IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
MODEL_NAME = "face_detection_yunet_2023mar.onnx"
MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
RESOURCE_DIR = Path(__file__).resolve().parent / "resources"

_DETECTORS: dict[tuple[str, float, float], Any] = {}


def ensure_model() -> str:
    """Return bundled YuNet model path, downloading once if the resource is absent."""
    model_path = RESOURCE_DIR / MODEL_NAME
    if not model_path.exists():
        RESOURCE_DIR.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(MODEL_URL, model_path)
    return str(model_path)


def _get_detector(score: float, nms: float):
    model_path = ensure_model()
    key = (model_path, float(score), float(nms))
    if key not in _DETECTORS:
        _DETECTORS[key] = cv2.FaceDetectorYN.create(
            model=model_path,
            config="",
            input_size=(320, 320),
            score_threshold=score,
            nms_threshold=nms,
            top_k=5000,
        )
    return _DETECTORS[key]


def _read_image(image: str | np.ndarray) -> np.ndarray | None:
    if isinstance(image, np.ndarray):
        return image
    # cv2.imread can fail on Windows paths containing Chinese characters.
    # Read bytes with NumPy first so local short-drama assets are not silently
    # treated as "no face" and sent to Seedance without real-person review.
    try:
        data = np.fromfile(str(image), dtype=np.uint8)
        if data.size:
            decoded = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if decoded is not None:
                return decoded
    except (OSError, ValueError):
        pass
    return cv2.imread(str(image))


def detect_faces(
    image: str | np.ndarray,
    score: float = 0.5,
    nms: float = 0.45,
    min_side: int = 640,
) -> dict[str, Any]:
    """Detect real-person faces with OpenCV YuNet.

    Known limits: far-away tiny faces and cluttered scenes can be missed; lowering
    score increases sensitivity but can misclassify text, lamps, food textures, or
    statues as faces. This is best for near/mid-shot people in video references.
    """
    img = _read_image(image)
    if img is None:
        return {"has_face": False, "count": 0, "faces": [], "error": "unreadable"}

    original_h, original_w = img.shape[:2]
    scale = 1.0
    detect_img = img
    if min_side and min(original_h, original_w) < min_side:
        scale = min_side / min(original_h, original_w)
        detect_img = cv2.resize(
            img,
            (int(original_w * scale), int(original_h * scale)),
            interpolation=cv2.INTER_LINEAR,
        )

    detect_h, detect_w = detect_img.shape[:2]
    detector = _get_detector(score, nms)
    detector.setInputSize((detect_w, detect_h))
    _, raw_faces = detector.detect(detect_img)
    if raw_faces is None:
        return {"has_face": False, "count": 0, "faces": []}

    faces = []
    for raw_face in raw_faces:
        x, y, w, h = raw_face[:4]
        box = [
            int(round(x / scale)),
            int(round(y / scale)),
            int(round(w / scale)),
            int(round(h / scale)),
        ]
        box[0] = max(0, min(box[0], original_w))
        box[1] = max(0, min(box[1], original_h))
        box[2] = max(0, min(box[2], original_w - box[0]))
        box[3] = max(0, min(box[3], original_h - box[1]))
        faces.append({"box": box, "score": round(float(raw_face[-1]), 3)})

    return {"has_face": bool(faces), "count": len(faces), "faces": faces}


def detect_folder(
    directory: str | Path,
    score: float = 0.5,
    nms: float = 0.45,
    min_side: int = 640,
) -> dict[str, dict[str, Any]]:
    root = Path(directory)
    results: dict[str, dict[str, Any]] = {}
    for path in sorted(p for p in root.rglob("*") if p.suffix.lower() in IMG_EXTS):
        results[str(path)] = detect_faces(path, score=score, nms=nms, min_side=min_side)
    return results
