from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


from portable_runtime import ffmpeg_path
FFMPEG = ffmpeg_path()


def run(command: list[str], cwd: Path | None = None) -> None:
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(completed.stderr[-3000:] or "FFmpeg执行失败")


def ass_escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")


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
    output.parent.mkdir(parents=True, exist_ok=True)
    work = output.parent / "_branding_work"
    work.mkdir(exist_ok=True)
    ass = work / "branding.ass"
    branded_ai = work / "branded-ai.mp4"
    title = ass_escape(f"《{args.title.strip('《》 ')}》")
    ass.write_text(f"""[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Title,Microsoft YaHei,28,&H00FFFFFF,&H00FFFFFF,&H90000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,1,8,20,20,18,1
Style: Warning,Microsoft YaHei,24,&H00FFFFFF,&H00FFFFFF,&H90000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,9:59:59.00,Title,,0,0,0,,{{\\pos(360,18)}}{title}
Dialogue: 0,0:00:00.00,9:59:59.00,Warning,,0,0,0,,{{\\pos(34,450)\\c&H0000FFFF&}}内\\N容\\N{{\\c&H00FFFFFF&}}纯\\N属\\N{{\\c&H0000FFFF&}}虚\\N构\\N{{\\c&H00FFFFFF&}}请\\N勿\\N模\\N仿
""", encoding="utf-8-sig")

    run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-i", str(ai), "-vf", "ass=branding.ass", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", str(branded_ai)], cwd=work)
    if not highlight:
        shutil.copy2(branded_ai, output)
        return
    concat = work / "concat.txt"
    concat.write_text(f"file '{branded_ai.as_posix()}'\nfile '{highlight.as_posix()}'\n", encoding="utf-8")
    run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(output)])


if __name__ == "__main__":
    main()
