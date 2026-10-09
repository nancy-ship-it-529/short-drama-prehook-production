from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Chinese subtitle OCR")
    parser.add_argument("--image", required=True)
    parser.add_argument("--subtitle-region", action="store_true", help="Prefer the lower 45 percent of the frame")
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.is_file():
        raise FileNotFoundError(f"图片不存在：{image_path}")
    image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"无法读取图片：{image_path}")

    height, width = image.shape[:2]
    offset_y = 0
    scan = image
    if args.subtitle_region:
        offset_y = int(height * 0.55)
        scan = image[offset_y:, :]

    engine = RapidOCR()
    result, elapsed = engine(scan)
    rows = []
    for entry in result or []:
        box, text, score = entry
        mapped = [[round(float(x), 2), round(float(y) + offset_y, 2)] for x, y in box]
        xs = [point[0] for point in mapped]
        ys = [point[1] for point in mapped]
        rows.append({
            "text": str(text),
            "score": round(float(score), 4),
            "box": mapped,
            "bbox": {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)},
            "containsChinese": bool(re.search(r"[\u4e00-\u9fff]", str(text))),
        })

    print(json.dumps({
        "ok": True,
        "image": str(image_path.resolve()),
        "width": width,
        "height": height,
        "subtitleRegion": bool(args.subtitle_region),
        "elapsed": elapsed,
        "items": rows,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
