from __future__ import annotations

import argparse
import difflib
import json
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np
from faster_whisper import WhisperModel
from PIL import Image, ImageDraw, ImageFont
from rapidocr_onnxruntime import RapidOCR

from portable_runtime import ffmpeg_path
FFMPEG = ffmpeg_path()
FONT = Path(r"C:\Windows\Fonts\msyhbd.ttc")

# 多条成片并行处理时，限制 OpenCV 内部线程，避免 RapidOCR 的 resize
# 偶发抛出 Unknown C++ exception，导致整条免费字幕修复任务失败。
cv2.setNumThreads(1)


def clean(text: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text)


def split_expected(text: str, lengths: list[int]) -> list[str]:
    chars = [(index, char) for index, char in enumerate(text) if re.match(r"[\u4e00-\u9fffA-Za-z0-9]", char)]
    total = len(chars)
    if not total or not lengths:
        return [text]
    boundaries = []
    consumed = 0
    length_total = max(1, sum(lengths))
    for length in lengths[:-1]:
        consumed += length
        boundaries.append(round(total * consumed / length_total))
    source_positions = [0] + [chars[min(max(0, value), total - 1)][0] for value in boundaries] + [len(text)]
    parts = []
    for index in range(len(source_positions) - 1):
        start, end = source_positions[index], source_positions[index + 1]
        parts.append(text[start:end].strip("，，。！？ ") + ("！" if index == len(source_positions) - 2 and text.rstrip().endswith("！") else ""))
    return parts


def split_expected_fuzzy(text: str, actuals: list[str]) -> list[str]:
    clean_expected = clean(text)
    positions = [index for index, char in enumerate(text) if re.match(r"[\u4e00-\u9fffA-Za-z0-9]", char)]
    cursor = 0
    parts = []
    for group_index, actual in enumerate(actuals):
        if group_index == len(actuals) - 1:
            consume = len(clean_expected) - cursor
        else:
            actual_clean = clean(actual)
            candidates = []
            for consume_size in range(max(1, len(actual_clean) - 2), min(len(clean_expected) - cursor, len(actual_clean) + 2) + 1):
                candidate = clean_expected[cursor:cursor + consume_size]
                ratio = difflib.SequenceMatcher(None, actual_clean, candidate).ratio() - abs(len(actual_clean) - consume_size) * 0.035
                candidates.append((ratio, consume_size))
            consume = max(candidates)[1] if candidates else max(0, len(clean_expected) - cursor)
        start_pos = positions[cursor] if cursor < len(positions) else len(text)
        next_cursor = min(len(positions), cursor + consume)
        end_pos = positions[next_cursor] if next_cursor < len(positions) else len(text)
        part = text[start_pos:end_pos].strip("，,。！？；;：: ")
        if group_index == len(actuals) - 1 and text.rstrip().endswith(("！", "？", "。", "!", "?", ".")):
            part += text.rstrip()[-1]
        parts.append(part)
        cursor = next_cursor
    return parts


def subtitle_rows(engine: RapidOCR, frame: np.ndarray) -> list[dict]:
    height, width = frame.shape[:2]
    offset = int(height * 0.58)
    crop = frame[offset:, :]
    if crop.size == 0:
        return []
    try:
        result, _ = engine(crop)
    except Exception:
        # 单帧 OCR 失败不能拖垮整条视频；后续相邻采样帧仍可提供字幕坐标。
        return []
    rows = []
    for box, text, score in result or []:
        text = re.sub(r"\s+", "", str(text))
        if float(score) < 0.72 or not re.search(r"[\u4e00-\u9fff]", text):
            continue
        points = np.array([[float(x), float(y) + offset] for x, y in box])
        x1, y1 = points.min(axis=0)
        x2, y2 = points.max(axis=0)
        if y1 < height * 0.64:
            continue
        rows.append({"text": text, "x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1), "score": float(score)})
    return rows


def erase_cell(frame: np.ndarray, row: dict) -> None:
    height, width = frame.shape[:2]
    # Reconstruct only the OCR text box from its nearby pixels. A wide Gaussian
    # rectangle stays visible on moving clothes and faces, even with soft edges.
    pad_x, pad_y = max(5, int(row["h"] * 0.18)), max(5, int(row["h"] * 0.22))
    x1, x2 = max(0, row["x"] - pad_x), min(width, row["x"] + row["w"] + pad_x)
    y1, y2 = max(1, row["y"] - pad_y), min(height - 2, row["y"] + row["h"] + pad_y)
    if x2 <= x1 or y2 <= y1:
        return
    context = max(12, int(row["h"] * 0.65))
    ox1, ox2 = max(0, x1 - context), min(width, x2 + context)
    oy1, oy2 = max(0, y1 - context), min(height, y2 + context)
    roi = frame[oy1:oy2, ox1:ox2]
    mask = np.zeros(roi.shape[:2], dtype=np.uint8)
    mask[y1 - oy1:y2 - oy1, x1 - ox1:x2 - ox1] = 255
    restored = cv2.inpaint(roi, mask, 3, cv2.INPAINT_TELEA)
    feather = cv2.GaussianBlur(mask, (0, 0), sigmaX=2.2, sigmaY=2.2).astype(np.float32)[..., None] / 255.0
    frame[oy1:oy2, ox1:ox2] = np.clip(restored * feather + roi * (1.0 - feather), 0, 255).astype(np.uint8)


def draw_caption(frame: np.ndarray, text: str, y: int, size: int) -> np.ndarray:
    image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(image)
    safe_width = int(image.width * 0.88)
    font = ImageFont.truetype(str(FONT), size=size)
    stroke = max(2, round(size * 0.075))
    lines, current = [], ""
    for char in text.strip():
        candidate = current + char
        box = draw.textbbox((0, 0), candidate, font=font, stroke_width=stroke)
        if current and box[2] - box[0] > safe_width:
            lines.append(current.rstrip())
            current = char
        else:
            current = candidate
    if current:
        lines.append(current.rstrip())
    line_height = int(size * 1.25)
    start_y = y - max(0, len(lines) - 1) * line_height
    for index, line in enumerate(lines):
        box = draw.textbbox((0, 0), line, font=font, stroke_width=stroke)
        x = (image.width - (box[2] - box[0])) // 2 - box[0]
        draw.text((x, start_y + index * line_height - box[1]), line, font=font, fill=(255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0))
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def blur_subtitle_band(frame: np.ndarray, y: int, h: int) -> None:
    """Softly remove the whole generated subtitle line without a black strip."""
    height, width = frame.shape[:2]
    x1, x2 = int(width * 0.035), int(width * 0.965)
    y1, y2 = max(0, y - max(10, h // 3)), min(height, y + h + max(12, h // 2))
    roi = frame[y1:y2, x1:x2]
    if not roi.size:
        return
    tiny_w, tiny_h = max(2, roi.shape[1] // 24), max(2, roi.shape[0] // 10)
    softened = cv2.resize(roi, (tiny_w, tiny_h), interpolation=cv2.INTER_AREA)
    frame[y1:y2, x1:x2] = cv2.resize(softened, (roi.shape[1], roi.shape[0]), interpolation=cv2.INTER_CUBIC)


def split_comma_cues(cues: list[dict]) -> list[dict]:
    result = []
    for cue in cues:
        parts = [part.strip() for part in re.findall(r"[^，,]+[，,]?", cue["caption"]) if part.strip()]
        if len(parts) <= 1:
            result.append(cue)
            continue
        duration = max(0.20, cue["end"] - cue["start"])
        weights = [max(1, len(clean(part))) for part in parts]
        cursor = cue["start"]
        words = [item for item in cue.get("words", []) if clean(item.get("text", ""))]
        word_total = sum(max(1, len(clean(item["text"]))) for item in words)
        cumulative_word_lengths = []
        word_cursor = 0
        for word in words:
            word_cursor += max(1, len(clean(word["text"])))
            cumulative_word_lengths.append(word_cursor)
        for index, (part, weight) in enumerate(zip(parts, weights)):
            if index == len(parts) - 1:
                end = cue["end"]
            elif words and word_total:
                target = word_total * sum(weights[:index + 1]) / sum(weights)
                word_index = next((i for i, value in enumerate(cumulative_word_lengths) if value >= target), len(words) - 1)
                current_end = float(words[word_index]["end"])
                next_start = float(words[word_index + 1]["start"]) if word_index + 1 < len(words) else current_end
                end = min(cue["end"], max(cursor + 0.08, (current_end + next_start) / 2))
            else:
                end = cursor + duration * weight / sum(weights)
            child = dict(cue)
            child.update({"start": cursor, "end": end, "caption": part, "needs_patch": True})
            result.append(child)
            cursor = end
    return result


def align_timed_cues_to_speech(cues: list[dict], asr: list[dict]) -> list[dict]:
    """Keep approved captions, but derive their boundaries from the actual voice track."""
    if not cues or not asr:
        return cues
    if len(cues) == len(asr):
        aligned = []
        for cue, spoken in zip(cues, asr):
            item = dict(cue)
            item.update({"start": spoken["start"], "end": spoken["end"], "asr_text": spoken["text"]})
            aligned.append(item)
        return aligned
    spoken_weights = [max(1, len(clean(item["text"]))) for item in asr]
    spoken_total = sum(spoken_weights)
    caption_weights = [max(1, len(clean(item["caption"]))) for item in cues]
    caption_total = sum(caption_weights)

    def speech_time(position: float) -> float:
        consumed = 0.0
        for item, weight in zip(asr, spoken_weights):
            if position <= consumed + weight:
                ratio = min(1.0, max(0.0, (position - consumed) / weight))
                return item["start"] + (item["end"] - item["start"]) * ratio
            consumed += weight
        return asr[-1]["end"]

    aligned, consumed_caption = [], 0
    for cue, weight in zip(cues, caption_weights):
        start_position = spoken_total * consumed_caption / caption_total
        consumed_caption += weight
        end_position = spoken_total * consumed_caption / caption_total
        item = dict(cue)
        item.update({"start": speech_time(start_position), "end": speech_time(end_position)})
        aligned.append(item)
    return aligned


def align_caption_lines_to_speech(lines: list[str], asr: list[dict]) -> list[dict]:
    """Map approved caption lines to one or more contiguous ASR segments."""
    n, m = len(lines), len(asr)
    if not n or m < n:
        return []
    dp = {(0, 0): (0.0, [])}
    for i in range(n):
        for j in range(m + 1):
            if (i, j) not in dp:
                continue
            score, groups = dp[(i, j)]
            max_end = m - (n - i - 1)
            for end in range(j + 1, max_end + 1):
                spoken = "".join(item["text"] for item in asr[j:end])
                similarity = difflib.SequenceMatcher(None, clean(lines[i]), clean(spoken)).ratio()
                candidate = score + (1.0 - similarity) + 0.04 * max(0, end - j - 1)
                key = (i + 1, end)
                if key not in dp or candidate < dp[key][0]:
                    dp[key] = (candidate, groups + [(j, end)])
    if (n, m) not in dp:
        return []
    result = []
    for caption, (start_index, end_index) in zip(lines, dp[(n, m)][1]):
        result.append({
            "start": asr[start_index]["start"], "end": asr[end_index - 1]["end"],
            "caption": caption.strip(), "needs_patch": True,
            "asr_text": "".join(item["text"] for item in asr[start_index:end_index]),
            "words": [word for item in asr[start_index:end_index] for word in item.get("words", [])],
        })
    return result


def seed_cues(scan_rows: dict[int, list[dict]], fps: float, interval: int, expected: str) -> list[dict]:
    observations = []
    for frame_index, rows in sorted(scan_rows.items()):
        if not rows:
            continue
        ordered = sorted(rows, key=lambda item: (item["y"], item["x"]))
        text = "".join(item["text"] for item in ordered)
        observations.append({
            "frame": frame_index, "text": text,
            "x": min(item["x"] for item in ordered), "y": min(item["y"] for item in ordered),
            "w": max(item["x"] + item["w"] for item in ordered) - min(item["x"] for item in ordered),
            "h": max(item["y"] + item["h"] for item in ordered) - min(item["y"] for item in ordered),
        })
    groups = []
    for item in observations:
        if groups:
            previous = groups[-1]
            ratio = difflib.SequenceMatcher(None, clean(previous["items"][-1]["text"]), clean(item["text"])).ratio()
            if item["frame"] - previous["items"][-1]["frame"] <= interval * 2 and ratio >= 0.58:
                previous["items"].append(item)
                continue
        groups.append({"items": [item]})
    if not groups:
        return []
    actuals = [max(group["items"], key=lambda row: len(clean(row["text"])))["text"] for group in groups]
    parts = split_expected_fuzzy(expected, actuals)
    cues = []
    for group, caption in zip(groups, parts):
        items = group["items"]
        actual = max(items, key=lambda row: len(clean(row["text"])))["text"]
        cues.append({
            "start": max(0.0, items[0]["frame"] / fps - 0.04),
            "end": items[-1]["frame"] / fps + interval / fps + 0.04,
            "text": actual, "caption": caption,
            "needs_patch": clean(actual) != clean(caption),
            "x": int(np.median([item["x"] for item in items])),
            "y": int(np.median([item["y"] for item in items])),
            "w": int(np.median([item["w"] for item in items])),
            "h": int(np.median([item["h"] for item in items])),
        })
    return cues


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--timing-source", choices=["seed", "asr"], default="seed")
    parser.add_argument("--subtitle-y", type=int, help="按原片字幕样本指定字幕上沿像素坐标")
    parser.add_argument("--font-size", type=int, help="按原片字幕样本指定字号")
    args = parser.parse_args()
    video, output, report_path = Path(args.video), Path(args.output), Path(args.report)
    raw_expected = Path(args.expected).read_text(encoding="utf-8").strip()
    timed_cues = []
    for line in raw_expected.splitlines():
        match = re.match(r"^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\](.+)$", line.strip())
        if match and float(match.group(2)) > float(match.group(1)):
            timed_cues.append({"start": float(match.group(1)), "end": float(match.group(2)), "caption": match.group(3).strip(), "needs_patch": True})
    timed_expected = []
    for line in raw_expected.splitlines():
        match = re.match(r"^\[\d+(?:\.\d+)?-\d+(?:\.\d+)?\](.+)$", line.strip())
        if match:
            timed_expected.append(match.group(1).strip())
    expected = "".join(timed_expected) if timed_expected else raw_expected
    expected_lines = [line.strip() for line in raw_expected.splitlines() if line.strip()]

    model = WhisperModel("base", device="cpu", compute_type="int8")
    segment_iter, _ = model.transcribe(str(video), language="zh", vad_filter=True, beam_size=5, word_timestamps=True, condition_on_previous_text=False)
    asr = []
    for item in segment_iter:
        if not clean(item.text):
            continue
        words = []
        for word in item.words or []:
            if word.start is None or word.end is None or not clean(word.word):
                continue
            words.append({"start": float(word.start), "end": float(word.end), "text": word.word.strip()})
        asr.append({"start": float(item.start), "end": float(item.end), "text": item.text.strip(), "words": words})
    captions = split_expected(expected, [len(clean(item["text"])) for item in asr])
    for item, caption in zip(asr, captions):
        item["caption"] = caption

    capture = cv2.VideoCapture(str(video))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    capture.release()
    silent = output.with_name("subtitle-rebuilt-silent.mp4")
    writer = cv2.VideoWriter(str(silent), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    engine = RapidOCR()
    samples, scan_rows = [], {}
    ocr_interval = max(1, round(fps / 6))

    # Pre-scan before rendering so a subtitle that appears between sampling
    # instants is erased from its very first frame instead of lingering until
    # the next OCR sample.
    scanner = cv2.VideoCapture(str(video))
    for scan_index in range(0, total_frames, ocr_interval):
        scanner.set(cv2.CAP_PROP_POS_FRAMES, scan_index)
        ok, scan_frame = scanner.read()
        if not ok:
            continue
        rows = subtitle_rows(engine, scan_frame)
        scan_rows[scan_index] = rows
        samples.extend(rows)
    scanner.release()

    if timed_cues and asr:
        # 文案采用人工给定的正确句子；整句边界和逗号分句边界都从真实音轨取得。
        # 不能把多句提示词按总字数横跨静音区，否则会造成动物尚未开口字幕已出现，
        # 或人物说完后字幕才出现。先按句义匹配连续 ASR 段，再按词级时间拆逗号。
        approved_lines = [item["caption"] for item in timed_cues]
        cues = align_caption_lines_to_speech(approved_lines, asr)
        if not cues:
            cues = align_timed_cues_to_speech(timed_cues, asr)
    elif len(expected_lines) > 1 and asr:
        cues = align_caption_lines_to_speech(expected_lines, asr)
    else:
        cues = timed_cues if timed_cues else (seed_cues(scan_rows, fps, ocr_interval, expected) if args.timing_source == "seed" else asr)
    cues = split_comma_cues(cues)

    global_y = int(np.median([row["y"] for row in samples])) if samples else int(height * 0.72)
    global_h = int(np.median([row["h"] for row in samples])) if samples else int(height * 0.035)
    fixed_font_size = max(30, min(44, int(global_h * 0.82)))
    if args.subtitle_y is not None:
        global_y = max(0, min(height - 1, args.subtitle_y))
    if args.font_size is not None:
        fixed_font_size = max(20, min(80, args.font_size))

    capture = cv2.VideoCapture(str(video))
    frame_index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        timestamp = frame_index / fps
        previous_index = (frame_index // ocr_interval) * ocr_interval
        next_index = min(((frame_index + ocr_interval - 1) // ocr_interval) * ocr_interval, max(scan_rows.keys(), default=0))
        nearby_rows = scan_rows.get(previous_index, []) + scan_rows.get(next_index, [])
        active = next((item for item in cues if item["start"] <= timestamp <= item["end"]), None)
        if active:
            # 只擦除OCR实际检测到的原字幕小框，不再横向模糊整条画面。
            # 相邻采样帧共同覆盖字幕刚出现/刚消失的边缘帧。
            for row in nearby_rows:
                erase_cell(frame, row)
            frame = draw_caption(frame, active["caption"], global_y, fixed_font_size)
        elif nearby_rows and (timed_cues or args.timing_source == "asr"):
            # This input is only the AI segment. Remove generated captions even
            # after the final spoken syllable, so a stale word cannot survive at
            # the splice while the approved speech-aligned caption is inactive.
            for row in nearby_rows:
                erase_cell(frame, row)
        writer.write(frame)
        frame_index += 1
    capture.release(); writer.release()
    completed = subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(silent), "-i", str(video), "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-shortest", "-movflags", "+faststart", str(output)], capture_output=True, text=True)
    if completed.returncode:
        raise RuntimeError(completed.stderr[-3000:])
    report = {"ok": True, "mode": "seed_text_patch" if args.timing_source == "seed" else "asr_rebuild", "segments": cues, "asr": asr, "output": str(output.resolve())}
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
