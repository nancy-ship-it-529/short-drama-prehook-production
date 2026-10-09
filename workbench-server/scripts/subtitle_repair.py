from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from rapidocr_onnxruntime import RapidOCR

cv2.setNumThreads(1)


from portable_runtime import ffmpeg_path
FFMPEG = ffmpeg_path()
FONT_CANDIDATES = [Path(r"C:\Windows\Fonts\msyh.ttc"), Path(r"C:\Windows\Fonts\msyhbd.ttc"), Path(r"C:\Windows\Fonts\simhei.ttf")]
FONT = next((item for item in FONT_CANDIDATES if item.is_file()), None)


def run(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(completed.stderr[-4000:] or "FFmpeg执行失败")


def video_duration(path: Path) -> float:
    completed = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", completed.stderr)
    if not match:
        raise RuntimeError("无法读取视频时长")
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def parse_cues(text: str) -> list[dict]:
    cues = []
    for line in text.splitlines():
        match = re.match(r"^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\](.+)$", line.strip())
        if match and float(match.group(2)) > float(match.group(1)):
            cues.append({"start": float(match.group(1)), "end": float(match.group(2)), "text": match.group(3).strip()})
    return cues


def read_image(path: Path):
    if not path.is_file():
        return None
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)


def ocr_rows(engine: RapidOCR, frame: Path) -> list[dict]:
    image = read_image(frame)
    if image is None:
        return []
    height, _ = image.shape[:2]
    offset_y = int(height * 0.50)
    result, _ = engine(image[offset_y:, :])
    rows = []
    for box, text, score in result or []:
        text = re.sub(r"\s+", "", str(text))
        if not re.search(r"[\u4e00-\u9fff]", text):
            continue
        points = [[float(x), float(y) + offset_y] for x, y in box]
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        x1, y1, x2, y2 = max(0, int(min(xs))), max(0, int(min(ys))), min(image.shape[1], int(max(xs))), min(image.shape[0], int(max(ys)))
        crop = image[y1:y2, x1:x2]
        font_color = "FFFFFF"
        if crop.size:
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).reshape(-1, 3)
            brightness = rgb.mean(axis=1)
            bright = rgb[brightness >= np.percentile(brightness, 88)]
            if len(bright):
                color = np.median(bright, axis=0).astype(int)
                font_color = "".join(f"{value:02X}" for value in color)
        rows.append({"text": text, "score": float(score), "x": min(xs), "y": min(ys), "w": max(xs) - min(xs), "h": max(ys) - min(ys), "fontcolor": font_color})
    if len(rows) > 1:
        ordered = sorted(rows, key=lambda row: (row["y"], row["x"]))
        rows.append({
            "text": "".join(row["text"] for row in ordered), "score": sum(row["score"] for row in ordered) / len(ordered),
            "x": min(row["x"] for row in ordered), "y": min(row["y"] for row in ordered),
            "w": max(row["x"] + row["w"] for row in ordered) - min(row["x"] for row in ordered),
            "h": max(row["y"] + row["h"] for row in ordered) - min(row["y"] for row in ordered),
            "fontcolor": ordered[0].get("fontcolor", "FFFFFF"),
        })
    return rows


def choose_row(rows: list[dict], expected: str) -> dict | None:
    expected = re.sub(r"\s+", "", expected)
    if not rows:
        return None
    return max(rows, key=lambda row: (difflib.SequenceMatcher(None, row["text"], expected).ratio(), row["score"]))


def escape_drawtext(text: str) -> str:
    return text.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:").replace("%", "\\%")


def build_repairs(actual: str, expected: str, row: dict, start: float, end: float) -> list[dict]:
    actual = re.sub(r"\s+", "", actual)
    expected = re.sub(r"\s+", "", expected)
    similarity = difflib.SequenceMatcher(None, actual, expected).ratio()
    if actual == expected:
        return []
    opcodes = difflib.SequenceMatcher(None, actual, expected).get_opcodes()
    changes = [item for item in opcodes if item[0] != "equal"]
    changed_chars = sum(max(i2 - i1, j2 - j1) for _, i1, i2, j1, j2 in changes)
    if not actual or similarity < 0.80 or len(changes) > 1 or changed_chars > 2 or len(actual) != len(expected):
        raise ValueError(f"不是可安全自动修补的单字差异：{actual} -> {expected}")
    unit = row["w"] / max(1, len(actual))
    repairs = []
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            continue
        x = row["x"] + unit * i1
        width_units = max(1, i2 - i1, j2 - j1)
        replacement = expected[j1:j2] if tag in {"replace", "insert"} else ""
        repairs.append({
            "from": actual[i1:i2], "to": replacement, "start": start, "end": end,
            "x": max(2, int(round(x - unit * 0.30))), "y": max(2, int(round(row["y"] - row["h"] * 0.28))),
            "w": max(8, int(round(unit * width_units + unit * 0.60))), "h": max(8, int(round(row["h"] * 1.58))),
            "fontsize": max(12, int(round(row["h"] * 0.82))), "borderw": max(1, int(round(row["h"] * 0.075))), "fontcolor": row.get("fontcolor", "FFFFFF"),
        })
    return repairs


def detect_untimed_cue(engine: RapidOCR, video: Path, expected: str, temp: Path) -> tuple[dict | None, float, float]:
    total = video_duration(video)
    samples = []
    moment = 0.25
    index = 0
    while moment < total:
        frame = temp / f"scan-{index:03}.png"
        run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{moment:.3f}", "-i", str(video), "-frames:v", "1", "-update", "1", str(frame)])
        row = choose_row(ocr_rows(engine, frame), expected)
        if row:
            ratio = difflib.SequenceMatcher(None, row["text"], re.sub(r"\s+", "", expected)).ratio()
            if ratio >= 0.45:
                samples.append((moment, ratio, row))
        moment += 0.45
        index += 1
    if not samples:
        return None, 0.0, total
    best = max(samples, key=lambda item: (item[1], item[2]["score"]))
    nearby = [item for item in samples if difflib.SequenceMatcher(None, item[2]["text"], best[2]["text"]).ratio() >= 0.72]
    start = max(0.0, min(item[0] for item in nearby) - 0.20)
    end = min(total, max(item[0] for item in nearby) + 0.55)
    return best[2], start, end


def patch_video(video: Path, output: Path, repairs: list[dict]) -> None:
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError("无法打开待修补视频")
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    silent = output.with_name("patched-silent.mp4")
    writer = cv2.VideoWriter(str(silent), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    frame_index = 0
    font_cache = {}
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        timestamp = frame_index / fps
        active = [repair for repair in repairs if repair["start"] <= timestamp <= repair["end"]]
        for repair in active:
            x, y, w, h = repair["x"], repair["y"], repair["w"], repair["h"]
            x2, y2 = min(width, x + w), min(height, y + h)
            # Only blur the wrong glyph cell, including its outline. Correct cells
            # are never included in repairs and therefore remain untouched.
            roi = frame[y:y2, x:x2]
            if roi.size:
                sigma = max(9.0, h * 0.34)
                frame[y:y2, x:x2] = cv2.GaussianBlur(roi, (0, 0), sigmaX=sigma, sigmaY=sigma)
            if repair["to"]:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = Image.fromarray(rgb)
                draw = ImageDraw.Draw(image)
                size = max(repair["fontsize"], int(h * 0.68))
                if size not in font_cache:
                    font_cache[size] = ImageFont.truetype(str(FONT), size=size)
                color = tuple(int(repair["fontcolor"][i:i + 2], 16) for i in (0, 2, 4))
                glyph_box = draw.textbbox((0, 0), repair["to"], font=font_cache[size], stroke_width=repair["borderw"])
                glyph_w, glyph_h = glyph_box[2] - glyph_box[0], glyph_box[3] - glyph_box[1]
                draw_x = x + max(0, (w - glyph_w) // 2) - glyph_box[0]
                draw_y = y + max(0, (h - glyph_h) // 2) - glyph_box[1]
                draw.text((draw_x, draw_y), repair["to"], font=font_cache[size], fill=color,
                          stroke_width=repair["borderw"], stroke_fill=(0, 0, 0))
                frame = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        writer.write(frame)
        frame_index += 1
    capture.release(); writer.release()
    run([str(FFMPEG), "-hide_banner", "-y", "-i", str(silent), "-i", str(video), "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-shortest", "-movflags", "+faststart", str(output)])


def main() -> None:
    parser = argparse.ArgumentParser(description="OCR based single-character subtitle repair")
    parser.add_argument("--video", required=True)
    parser.add_argument("--subtitle-text-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    if FFMPEG is None or FONT is None:
        raise FileNotFoundError("未找到FFmpeg或中文字体")
    video, output, report_path = Path(args.video), Path(args.output), Path(args.report)
    subtitle_text = Path(args.subtitle_text_file).read_text(encoding="utf-8")
    cues = parse_cues(subtitle_text)
    untimed = [line.strip() for line in subtitle_text.splitlines() if line.strip()] if not cues else []
    if not cues and not untimed:
        raise ValueError("缺少正确对白，无法执行字幕检查")
    engine = RapidOCR()
    repairs, checks, missing_captions = [], [], []
    total = video_duration(video)
    with tempfile.TemporaryDirectory(prefix="subtitle-ocr-") as temp_dir:
        temp = Path(temp_dir)
        if untimed:
            for expected in untimed:
                row, start, end = detect_untimed_cue(engine, video, expected, temp)
                cues.append({"start": start, "end": end, "text": expected, "detectedRow": row})
        for index, cue in enumerate(cues, 1):
            frame = temp / f"cue-{index}.png"
            row = cue.pop("detectedRow", None)
            if row is None:
                midpoint = cue["start"] + (cue["end"] - cue["start"]) * 0.55
                if cue["start"] < total and total > 0.1:
                    midpoint = min(midpoint, total - 0.1)
                    run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{midpoint:.3f}", "-i", str(video), "-frames:v", "1", "-update", "1", str(frame)])
                    row = choose_row(ocr_rows(engine, frame), cue["text"])
            if row is None:
                checks.append({**cue, "state": "needs_review", "ocr": "", "error": "取帧越界或未检测到Seedance原字幕，转入音频对齐字幕重建"})
                continue
            ratio = difflib.SequenceMatcher(None, row["text"], re.sub(r"\s+", "", cue["text"])).ratio()
            try:
                cue_repairs = build_repairs(row["text"], cue["text"], row, cue["start"], cue["end"])
                repairs.extend(cue_repairs)
                checks.append({**cue, "state": "exact" if not cue_repairs else "patched", "ocr": row["text"], "score": row["score"], "similarity": round(ratio, 4), "repairs": cue_repairs})
            except ValueError as error:
                checks.append({**cue, "state": "needs_review", "ocr": row["text"], "score": row["score"], "similarity": round(ratio, 4), "error": str(error)})

    if repairs:
        patch_video(video, output, repairs)
    else:
        run([str(FFMPEG), "-hide_banner", "-y", "-i", str(video), "-c", "copy", "-movflags", "+faststart", str(output)])
    report = {"ok": True, "video": str(video.resolve()), "output": str(output.resolve()), "font": str(FONT), "checks": checks, "repairCount": len(repairs), "needsReview": any(item["state"] == "needs_review" for item in checks)}
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
