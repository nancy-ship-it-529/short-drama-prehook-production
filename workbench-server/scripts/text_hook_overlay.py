"""Burn one silent, screenshot-style hook caption onto an existing video."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


from portable_runtime import ffmpeg_path, ocr_python
FFMPEG = ffmpeg_path()
OCR_PYTHON = ocr_python()
LAYOUT_SCRIPT = Path(__file__).with_name("analyze_hook_layout.py")


def media_info(source: Path) -> tuple[float, int, int, bool]:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-i", str(source)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    duration = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    size = re.search(r"Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b", result.stderr)
    if not duration or not size:
        raise ValueError("无法读取底片时长或画面尺寸")
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    return seconds, int(size[1]), int(size[2]), bool(re.search(r"Stream #.*Audio:", result.stderr))


def ass_time(seconds: float) -> str:
    centis = max(0, round(seconds * 100))
    hours, centis = divmod(centis, 360000)
    minutes, centis = divmod(centis, 6000)
    secs, centis = divmod(centis, 100)
    return f"{hours}:{minutes:02}:{secs:02}.{centis:02}"


def units(value: str) -> float:
    return sum(0.55 if ord(char) < 128 else 1 for char in value)


def split_line(value: str, limit: float, protected: list[tuple[int, int]]) -> int | None:
    if units(value) <= limit:
        return None
    options = []
    for index in range(1, len(value)):
        if any(begin < index < end for begin, end in protected):
            continue
        if value[index] in "，,。；;、！？!?":
            continue
        left, right = value[:index], value[index:]
        if units(left) <= limit and units(right) <= limit:
            punctuation_bonus = 4 if value[index - 1] in "，,；;、" else 0
            score = abs(units(left) - units(right)) - punctuation_bonus
            options.append((score, index))
    if not options:
        raise ValueError("文案超过左下角两行安全宽度，请缩短到约30字以内")
    return min(options)[1]


def render_text(value: str, yellow: str, red: str, break_at: int | None) -> str:
    if yellow and yellow not in value:
        raise ValueError("黄色重点词必须完整出现在文案中")
    if red and red not in value:
        raise ValueError("红色重点词必须完整出现在文案中")
    yellow_span = (value.index(yellow), value.index(yellow) + len(yellow)) if yellow else None
    red_span = (value.index(red), value.index(red) + len(red)) if red else None
    if yellow_span and red_span and max(yellow_span[0], red_span[0]) < min(yellow_span[1], red_span[1]):
        raise ValueError("黄色与红色重点词不能重叠")
    palette = {"white": r"{\1c&H00FFFFFF&}", "yellow": r"{\1c&H0000D7FF&}", "red": r"{\1c&H005C4BFF&}"}
    output = ["“"]
    previous = "white"
    for index, char in enumerate(value):
        if break_at == index:
            output.append(r"\N")
        color = "red" if red_span and red_span[0] <= index < red_span[1] else "yellow" if yellow_span and yellow_span[0] <= index < yellow_span[1] else "white"
        if color != previous:
            output.append(palette[color])
            previous = color
        output.append(char)
    if previous != "white":
        output.append(palette["white"])
    output.append("”")
    return "".join(output)


def write_ass(target: Path, text: str, yellow: str, red: str, start: float, end: float, width: int, height: int, anchor: tuple[int, int]) -> None:
    font_size = max(20, round(min(height * 0.055, width * 0.05)))
    margin_left = round(width * 0.05)
    margin_bottom = round(height * (0.23 if height > width else 0.18))
    protected = [(text.index(word), text.index(word) + len(word)) for word in (yellow, red) if word and word in text]
    break_at = split_line(text, 15 if height > width else 14, protected)
    rendered = render_text(text, yellow, red, break_at)
    header = rf"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Microsoft YaHei,{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{max(2, round(font_size * 0.075))},1,7,{margin_left},{margin_left},{margin_bottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,{ass_time(start)},{ass_time(end)},Hook,,0,0,0,,{{\an7\pos({anchor[0]},{anchor[1]})}}{rendered}
"""
    target.write_text(header, encoding="utf-8-sig")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file", required=True)
    request = json.loads(Path(parser.parse_args().request_file).read_text(encoding="utf-8"))
    source = Path(request["source_video"])
    if not source.is_file():
        raise FileNotFoundError(f"底片不存在：{source}")
    duration, width, height, source_has_audio = media_info(source)
    text = str(request.get("narration") or "").strip()
    if text.startswith("“") and text.endswith("”"):
        text = text[1:-1].strip()
    if not text or len(text) > 28 or "\n" in text or "\r" in text or any(char in text for char in r"{}\\"):
        raise ValueError("请填写一条不超过28字、不含换行或特殊控制符的画面文案")
    speed = float(request.get("speed_factor", 1))
    if not 1 <= speed <= 1.2:
        raise ValueError("画面文案版倍速只能在1.0至1.2之间")
    start, end = float(request.get("start_seconds", 0)), float(request.get("max_end_seconds", 10))
    expected_duration = duration / speed
    if not 0 <= start < end <= min(10, expected_duration):
        raise ValueError(f"文案展示必须处于成片前10秒且不超过成片时长 {expected_duration:.2f} 秒")
    yellow = str(request.get("accent_yellow") or "").strip()
    red = str(request.get("accent_red") or "").strip()
    output_dir = Path(request["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    ass_file = output_dir / "hook_text.ass"
    if not OCR_PYTHON.is_file() or not LAYOUT_SCRIPT.is_file():
        raise RuntimeError("本地 OCR 排版组件未就绪，已停止合成以免遮挡原字幕")
    font_size = max(20, round(min(height * 0.055, width * 0.05)))
    protected = [(text.index(word), text.index(word) + len(word)) for word in (yellow, red) if word and word in text]
    break_at = split_line(text, 15 if height > width else 14, protected)
    lines = [text] if break_at is None else [text[:break_at], text[break_at:]]
    # Reserve a modest outline margin; the earlier overly generous estimate
    # pushed visually small text away from a usable lower-left gap.
    caption_width = round(max(units(line) for line in lines) * font_size * 0.92 + 30)
    caption_height = round(len(lines) * font_size * 1.18 + 20)
    layout_request = output_dir / "layout_request.json"
    layout_request.write_text(json.dumps({"source_video": str(source), "frames_dir": str(output_dir / "layout-frames"), "end_seconds": end, "speed_factor": speed, "caption_width": caption_width, "caption_height": caption_height}, ensure_ascii=False), encoding="utf-8")
    analyzed = subprocess.run([str(OCR_PYTHON), str(LAYOUT_SCRIPT), "--request-file", str(layout_request)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    if analyzed.returncode:
        raise RuntimeError(analyzed.stderr[-2000:] or "截图 OCR 排版检查失败，已停止合成")
    layout = json.loads(analyzed.stdout.strip().splitlines()[-1])
    anchor = tuple(layout["selected_box"][:2])
    write_ass(ass_file, text, yellow, red, start, end, width, height, anchor)
    escaped = str(ass_file).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
    output = output_dir / "final.mp4"
    video_filter = f"ass='{escaped}'" if speed == 1 else f"setpts=PTS/{speed:g},ass='{escaped}'"
    command = [str(FFMPEG), "-hide_banner", "-y", "-i", str(source), "-vf", video_filter, "-map", "0:v:0", "-map", "0:a?"]
    command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    if speed == 1:
        command += ["-c:a", "copy"]
    elif source_has_audio:
        command += ["-filter:a", f"atempo={speed:g}", "-c:a", "aac", "-b:a", "192k"]
    command += ["-movflags", "+faststart", str(output)]
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(completed.stderr[-4000:] or "画面文案合成失败")
    final_duration, final_width, final_height, final_has_audio = media_info(output)
    if abs(final_duration - expected_duration) > 0.3 or (final_width, final_height) != (width, height) or final_has_audio != source_has_audio:
        raise RuntimeError("成片时长、尺寸或原声保留校验失败")
    result = {"status": "succeeded", "source_video": str(source), "output": str(output), "duration": final_duration, "narration": text, "narration_start": start, "narration_end": end, "accent_yellow": yellow, "accent_red": red, "speed_factor": speed, "audio_mode": "copy" if speed == 1 else "atempo", "display_only": True, "layout_report": layout["report"], "layout_preview": layout["preview"], "layout_box": layout["selected_box"], "layout_sample_count": layout["sample_count"]}
    (output_dir / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
