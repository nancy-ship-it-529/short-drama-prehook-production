from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path

import edge_tts


from portable_runtime import ffmpeg_path, ocr_python
FFMPEG = ffmpeg_path()
OCR_PYTHON = ocr_python()
SUBTITLE_REPAIR = Path(__file__).resolve().parent / "subtitle_repair.py"
SUBTITLE_REBUILD = Path(__file__).resolve().parent / "subtitle_rebuild.py"


def run(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if completed.returncode:
        raise RuntimeError(completed.stderr[-4000:] or "FFmpeg执行失败")


def duration(path: Path) -> float:
    completed = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", completed.stderr)
    if not match: raise RuntimeError(f"无法读取媒体时长：{path}")
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def has_audio(path: Path) -> bool:
    completed = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return bool(re.search(r"Stream #.*Audio:", completed.stderr))


def acquire(source: str, destination: Path) -> Path:
    if source.lower().startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=180) as response, destination.open("wb") as output:
            shutil.copyfileobj(response, output)
        return destination
    path = Path(source)
    if not path.exists():
        raise FileNotFoundError(f"视频不存在：{source}")
    return path


def normalize(source: Path, destination: Path, start: float = 0.0, speed: float = 1.0) -> None:
    common = [str(FFMPEG), "-hide_banner", "-y"]
    if start > 0:
        common += ["-ss", f"{start:.3f}"]
    common += ["-i", str(source)]
    speed = speed if speed in (1.0, 1.2, 1.5) else 1.0
    video = "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p"
    if speed != 1.0:
        video += f",setpts=PTS/{speed:.1f}"
    if has_audio(source):
        command = common + ["-vf", video]
        if speed != 1.0:
            command += ["-af", f"atempo={speed:.1f}"]
        command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", str(destination)]
    else:
        command = common + ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-vf", video, "-map", "0:v:0", "-map", "1:a:0", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(destination)]
    run(command)


def srt_time(seconds: float) -> str:
    millis = max(0, round(seconds * 1000)); hours, millis = divmod(millis, 3600000); minutes, millis = divmod(millis, 60000); secs, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def write_srt(text: str, total: float, target: Path, speed: float = 1.0) -> None:
    timed = []
    for source_line in text.splitlines():
        match = re.match(r"^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\](.+)$", source_line.strip())
        if match:
            start, end, caption = float(match.group(1)) / speed, float(match.group(2)) / speed, match.group(3).strip()
            if caption and end > start:
                clauses = [part.strip() for part in re.findall(r"[^，,]+[，,]?", caption) if part.strip()]
                if len(clauses) <= 1:
                    timed.append((max(0.0, start), min(total, end), caption))
                else:
                    weights = [max(1, len(re.sub(r"\W", "", part))) for part in clauses]
                    cursor = max(0.0, start)
                    for index, (clause, weight) in enumerate(zip(clauses, weights)):
                        clause_end = min(total, end) if index == len(clauses) - 1 else cursor + (end - start) * weight / sum(weights)
                        timed.append((cursor, clause_end, clause))
                        cursor = clause_end
    if timed:
        chunks = [f"{index}\n{srt_time(start)} --> {srt_time(end)}\n{caption}\n" for index, (start, end, caption) in enumerate(timed, 1)]
        target.write_text("\n".join(chunks), encoding="utf-8-sig")
        return
    lines = []
    for source_line in text.splitlines():
        source_line = source_line.strip()
        if not source_line:
            continue
        sentences = [part.strip() for part in re.findall(r"[^。！？]+[。！？]?", source_line) if part.strip()]
        for sentence in sentences:
            clauses = [part.strip() for part in re.findall(r"[^，,；;：:]+[，,；;：:]?", sentence) if part.strip()]
            if len(clauses) > 1:
                lines.extend(clauses)
            else:
                lines.append(sentence)
    if not lines:
        return
    weights = [max(1, len(line)) for line in lines]; cursor = 0.0; chunks = []
    for index, (line, weight) in enumerate(zip(lines, weights), 1):
        span = total * weight / sum(weights); end = min(total, cursor + span)
        chunks.append(f"{index}\n{srt_time(cursor)} --> {srt_time(end)}\n{line}\n")
        cursor = end
    target.write_text("\n".join(chunks), encoding="utf-8-sig")


async def synthesize(text: str, voice: str, output: Path) -> None:
    await edge_tts.Communicate(text=text, voice=voice).save(str(output))


def subtitle_filter(path: Path, local_cover: bool = False) -> str:
    escaped = str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    style = "FontName=Microsoft YaHei,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=70"
    if local_cover:
        style = "FontName=Microsoft YaHei,FontSize=12,PrimaryColour=&H00FFFFFF,BackColour=&H78000000,OutlineColour=&H78000000,BorderStyle=3,Outline=4,Shadow=0,Alignment=2,MarginV=70"
    return f"subtitles='{escaped}':force_style='{style}'"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
    output_dir = Path(request["output_dir"]); output_dir.mkdir(parents=True, exist_ok=True)
    work = output_dir / "_work"; work.mkdir(exist_ok=True)
    ai = acquire(request["ai_video"], work / "ai-source.mp4")
    highlight_source = request.get("highlight_video", "").strip()
    highlight = acquire(highlight_source, work / "highlight-source.mp4") if highlight_source else None
    highlight_start = max(0.0, float(request.get("highlight_start", 0) or 0))
    speed_factor = float(request.get("speed_factor", 1.2) or 1.2)
    if speed_factor not in (1.2, 1.5):
        speed_factor = 1.2
    ai_norm = work / "01-ai.mp4"; normalize(ai, ai_norm, speed=speed_factor)
    base = ai_norm
    narration = request.get("narration", "").strip(); subtitle_text = request.get("subtitle_text", "").strip() or narration; voice = request.get("voice", "zh-CN-XiaoxiaoNeural")
    tts = work / "narration.mp3"; srt = work / "subtitles.srt"
    inputs = [str(FFMPEG), "-hide_banner", "-y", "-i", str(base)]; audio_filters = ["[0:a]volume=1.0[basea]"]; mix_inputs = ["[basea]"]
    if narration:
        asyncio.run(synthesize(narration, voice, tts)); inputs += ["-i", str(tts)]; audio_filters.append("[1:a]volume=1.2[voice]"); mix_inputs.append("[voice]")
    if subtitle_text:
        write_srt(subtitle_text, duration(base), srt, speed=speed_factor)
    bgm = request.get("bgm", "").strip()
    if bgm:
        bgm_path = Path(bgm)
        if not bgm_path.exists(): raise FileNotFoundError(f"BGM不存在：{bgm}")
        inputs += ["-stream_loop", "-1", "-i", str(bgm_path)]; bgm_index = 2 if narration else 1; audio_filters.append(f"[{bgm_index}:a]volume=0.12[bgm]"); mix_inputs.append("[bgm]")
    audio_filters.append("".join(mix_inputs) + f"amix=inputs={len(mix_inputs)}:duration=first:dropout_transition=2[aout]")
    output = output_dir / "final.mp4"
    smart_repair = bool(request.get("smart_ocr_repair", False) and subtitle_text)
    encoded_output = work / "pre-ocr.mp4" if smart_repair else output
    command = inputs + ["-filter_complex", ";".join(audio_filters), "-map", "0:v:0", "-map", "[aout]"]
    if subtitle_text and request.get("burn_subtitles", True) and not smart_repair:
        subtitle = subtitle_filter(srt, request.get("cover_existing_subtitles", False))
        command += ["-vf", subtitle]
    command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(encoded_output)]
    run(command)
    ocr_report = None
    if smart_repair:
        if not OCR_PYTHON.is_file() or not SUBTITLE_REPAIR.is_file():
            raise FileNotFoundError("本地中文OCR单字修补组件未安装")
        subtitle_spec = work / "subtitle-cues.txt"
        subtitle_spec.write_text(subtitle_text, encoding="utf-8")
        report_file = work / "subtitle-repair-report.json"
        run([str(OCR_PYTHON), str(SUBTITLE_REPAIR), "--video", str(encoded_output), "--subtitle-text-file", str(subtitle_spec), "--output", str(output), "--report", str(report_file)])
        ocr_report = json.loads(report_file.read_text(encoding="utf-8"))
        if ocr_report.get("needsReview"):
            if not SUBTITLE_REBUILD.is_file():
                raise FileNotFoundError("本地语音对齐字幕重建组件未安装")
            rebuild_report = work / "subtitle-rebuild-report.json"
            has_seed_text = any(item.get("ocr") for item in ocr_report.get("checks", []))
            timing_source = "seed" if has_seed_text else "asr"
            run([str(OCR_PYTHON), str(SUBTITLE_REBUILD), "--video", str(encoded_output), "--expected", str(subtitle_spec), "--output", str(output), "--report", str(rebuild_report), "--timing-source", timing_source])
            ocr_report = json.loads(rebuild_report.read_text(encoding="utf-8"))
    if highlight:
        highlight_duration = duration(highlight)
        if highlight_start >= highlight_duration - 0.5:
            raise ValueError(f"原片切入点 {highlight_start:.3f} 秒超出有效画面，原片时长 {highlight_duration:.3f} 秒")
        ai_end = duration(output)
        highlight_norm = work / "02-highlight.mp4"; normalize(highlight, highlight_norm, highlight_start)
        concat_list = work / "concat.txt"; concat_list.write_text("\n".join(f"file '{item.as_posix()}'" for item in [output, highlight_norm]), encoding="utf-8")
        joined = work / "joined.mp4"
        run([str(FFMPEG), "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list), "-c", "copy", "-movflags", "+faststart", str(joined)])
        shutil.copy2(joined, output)
        review_clip = work / "splice-review.mp4"
        run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(0.0, ai_end - 0.9):.3f}", "-i", str(output), "-t", "2.6", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(review_clip)])
    manifest = {"status": "succeeded", "output": str(output), "duration": duration(output), "speed_factor": speed_factor, "narration_audio": str(tts) if narration else None, "subtitle": str(srt) if srt.exists() else None, "ocr_report": ocr_report, "splice": {"video": str(highlight), "start": highlight_start, "ai_end": ai_end, "review_clip": str(review_clip)} if highlight else None}
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
