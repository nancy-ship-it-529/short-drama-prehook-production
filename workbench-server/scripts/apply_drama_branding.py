from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from portable_runtime import ffmpeg_path
FFMPEG = ffmpeg_path()


def run(command: list[str], cwd: Path | None = None) -> None:
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(completed.stderr[-3000:] or "FFmpeg执行失败")


def ass_escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")


def reference_layout(highlight: Path, work: Path) -> tuple[int, int, int, Path]:
    """Match the source's visible title band and corner warning; never guess a badge."""
    frame_path = work / "reference-frame.png"
    run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", str(highlight), "-frames:v", "1", "-update", "1", str(frame_path)])
    with Image.open(frame_path) as source:
        frame = source.convert("RGB")
    width, height = frame.size
    pixels = frame.load()
    active = []
    for y in range(height):
        lit = sum(max(pixels[x, y]) > 18 for x in range(0, width, 8))
        if lit >= max(4, width // 80):
            active.append(y)
    if not active:
        raise ValueError("原片画面全黑，无法核对剧名和警示语位置")
    top, bottom = min(active), max(active)
    if bottom - top < height // 8:
        raise ValueError("原片有效画面过小，无法核对警示语位置")
    red = []
    for y in range(top, min(bottom + 1, top + (bottom - top) // 3)):
        for x in range(int(width * .75), width):
            r, g, b = pixels[x, y]
            if r > 170 and r > 1.6 * g and r > 1.6 * b:
                red.append((x, y))
    if len(red) < 150:
        raise ValueError("未在原片右上角识别到固定警示标识；请人工核对位置，不能套用左侧竖排模板")
    left = min(x for x, _ in red)
    badge_top = min(y for _, y in red)
    badge_bottom = max(y for _, y in red)
    if left < width * .75 or max(x for x, _ in red) < width - 3 or badge_bottom - badge_top < 20:
        raise ValueError("原片警示标识边界不明确，请人工核对后再包装")
    span = width - left
    polygon = [(left - 3, badge_top - 2), (min(width - 1, left + round(span * .55)), badge_top - 2),
               (width - 1, min(height - 1, badge_top + round(span * .58))),
               (width - 1, min(height - 1, badge_bottom + 2))]
    mask = Image.new("L", frame.size)
    ImageDraw.Draw(mask).polygon(polygon, fill=255)
    warning = frame.convert("RGBA")
    warning.putalpha(mask)
    warning_path = work / "source-warning.png"
    warning.save(warning_path)
    return width, height, top, warning_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ai", required=True)
    parser.add_argument("--highlight", default="")
    parser.add_argument("--title", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    ai, output = Path(args.ai).resolve(), Path(args.output).resolve()
    highlight = Path(args.highlight).resolve() if args.highlight else None
    if not ai.is_file():
        raise FileNotFoundError(f"前贴视频不存在：{ai}")
    if highlight and not highlight.is_file():
        raise FileNotFoundError(f"原片视频不存在：{highlight}")
    if not highlight:
        raise ValueError("必须提供原片，才能匹配警示语位置与字号")
    output.parent.mkdir(parents=True, exist_ok=True)
    work = output.parent / "_branding_work"
    work.mkdir(exist_ok=True)
    ass = work / "branding.ass"
    branded_ai = work / "branded-ai.mp4"
    width, height, active_top, warning = reference_layout(highlight, work)
    title_size = max(12, round(width * 19 / 720))
    title_y = active_top + max(2, round(height * 4 / 1280))
    title = ass_escape(f"《{args.title.strip('《》 ')}》")
    ass.write_text(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Title,Microsoft YaHei,{title_size},&H00FFFFFF,&H00FFFFFF,&H90000000,&H00000000,-1,0,0,0,100,100,0,0,1,1,1,8,20,20,0,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,9:59:59.00,Title,,0,0,0,,{{\\pos({width // 2},{title_y})}}{title}
""", encoding="utf-8-sig")

    run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(ai), "-loop", "1", "-i", str(warning),
         "-filter_complex", "[0:v][1:v]overlay=0:0:shortest=1,ass=branding.ass[v]", "-map", "[v]", "-map", "0:a?",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-shortest", "-movflags", "+faststart", str(branded_ai)], cwd=work)
    concat = work / "concat.txt"
    concat.write_text(f"file '{branded_ai.as_posix()}'\nfile '{highlight.as_posix()}'\n", encoding="utf-8")
    run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(output)])


if __name__ == "__main__":
    main()
