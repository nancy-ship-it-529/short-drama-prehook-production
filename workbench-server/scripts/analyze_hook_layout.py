"""Choose a hook-caption region from sampled source frames and local OCR."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR


def overlap(a: list[float], b: list[float]) -> float:
    x = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    y = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return x * y


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
    source = Path(request["source_video"])
    frames_dir = Path(request["frames_dir"])
    frames_dir.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError("无法读取底片抽帧，已停止自动排版")
    width = round(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    caption_w = min(round(float(request["caption_width"])), round(width * 0.88))
    caption_h = round(float(request["caption_height"]))
    output_end = float(request["end_seconds"])
    speed = float(request.get("speed_factor", 1))
    sample_times = sorted(set(round(max(0.15, min(output_end - 0.08, t)), 2) for t in (0.35, 1.3, 2.6, 4.2, 6.0, 8.1) if t < output_end))
    if not sample_times:
        sample_times = [round(output_end / 2, 2)]
    engine = RapidOCR()
    face_file = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    face_detector = cv2.CascadeClassifier(str(face_file)) if face_file.is_file() else None
    samples = []
    frames = []
    for index, time in enumerate(sample_times):
        capture.set(cv2.CAP_PROP_POS_MSEC, time * speed * 1000)
        ok, frame = capture.read()
        if not ok:
            continue
        image_path = frames_dir / f"frame-{index + 1:02d}-{time:.2f}s.jpg"
        encoded, jpg = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if not encoded:
            continue
        jpg.tofile(str(image_path))
        try:
            recognized, _ = engine(frame)
        except Exception as error:
            raise RuntimeError(f"本地 OCR 未能完成抽帧检查：{error}") from error
        text_boxes = []
        for polygon, text, confidence in recognized or []:
            if float(confidence) < 0.42 or not str(text).strip():
                continue
            points = np.asarray(polygon, dtype=float)
            x1, y1 = points.min(axis=0)
            x2, y2 = points.max(axis=0)
            text_boxes.append({"text": str(text), "confidence": round(float(confidence), 3), "box": [round(x1), round(y1), round(x2), round(y2)]})
        faces = []
        if face_detector is not None and not face_detector.empty():
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            for x, y, w, h in face_detector.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=4, minSize=(40, 40)):
                faces.append([int(x), int(y), int(x + w), int(y + h)])
        samples.append({"time": time, "image": str(image_path), "ocr": text_boxes, "faces": faces})
        frames.append(frame)
    capture.release()
    if len(samples) < 2:
        raise RuntimeError("有效截图不足两张，无法确认原字幕位置，已停止自动排版")

    # Existing subtitles are normally in the bottom third. Keep the hook above it
    # even if OCR misses a blurred or tiny subtitle in one screenshot.
    candidates = []
    for y_ratio in (0.18, 0.29, 0.40, 0.51, 0.56, 0.60, 0.64):
        top = round(height * y_ratio)
        if top + caption_h > height * 0.70:
            continue
        for x in (round(width * 0.05), round(width * 0.14), round(width * 0.20), round((width - caption_w) / 2), round(width * 0.95 - caption_w)):
            box = [x, top, x + caption_w, top + caption_h]
            if box[0] < width * 0.035 or box[2] > width * 0.965:
                continue
            text_collisions = 0
            face_collisions = 0
            # Portrait faces may be turned away, obscured by a hand, or stylized;
            # face detection alone is not a reliable subject-protection gate.
            subject_risk = height > width and overlap(box, [width * 0.22, height * 0.14, width * 0.86, height * 0.51]) > 0
            edge_cost = 0.0
            for sample, frame in zip(samples, frames):
                for item in sample["ocr"]:
                    x1, y1, x2, y2 = item["box"]
                    expanded = [x1 - 12, y1 - 10, x2 + 12, y2 + 10]
                    if overlap(box, expanded):
                        text_collisions += 1
                for x1, y1, x2, y2 in sample["faces"]:
                    if overlap(box, [x1 - 18, y1 - 18, x2 + 18, y2 + 18]):
                        face_collisions += 1
                crop = frame[max(0, box[1]):min(height, box[3]), max(0, box[0]):min(width, box[2])]
                if crop.size:
                    edge_cost += float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
            edge_cost /= len(samples)
            # Favor visual quiet and a stable upper/middle location only after
            # excluding OCR text and faces across every sampled frame.
            # Prefer the user's lower-left area above dialogue subtitles, but
            # never trade OCR/face clearance for the stylistic preference.
            score = text_collisions * 10000 + face_collisions * 4000 + int(subject_risk) * 2000 + min(edge_cost, 3000) / 80 + abs(y_ratio - 0.56) * 9 + abs(x / width - 0.14) * 3
            candidates.append({"box": box, "text_collisions": text_collisions, "face_collisions": face_collisions, "subject_risk": subject_risk, "edge_cost": round(edge_cost, 2), "score": round(score, 2)})
    if not candidates:
        raise RuntimeError("没有适合放文案的安全区域，已停止合成")
    best = min(candidates, key=lambda item: item["score"])
    if best["text_collisions"] or best["face_collisions"] or best["subject_risk"]:
        raise RuntimeError("抽帧发现所有候选位置可能遮挡原字幕或人物主体，已停止合成，请人工确认")
    preview = frames[len(frames) // 2].copy()
    x1, y1, x2, y2 = best["box"]
    cv2.rectangle(preview, (x1, y1), (x2, y2), (38, 210, 80), 3)
    preview_file = frames_dir.parent / "layout-preview.jpg"
    cv2.imencode(".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 90])[1].tofile(str(preview_file))
    result = {"source": str(source), "width": width, "height": height, "sampled_frames": samples, "selected_box": best["box"], "selected_score": best["score"], "preview": str(preview_file), "candidates": candidates, "method": "sampled_frames_local_ocr_face_check"}
    report = frames_dir.parent / "layout_report.json"
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"selected_box": best["box"], "report": str(report), "preview": str(preview_file), "sample_count": len(samples)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
