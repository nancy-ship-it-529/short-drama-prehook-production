"""Add a short, user-approved voice-over to an existing video without trimming it."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
from pathlib import Path


from portable_runtime import ffmpeg_path
FFMPEG = ffmpeg_path()


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:] or "FFmpeg 处理失败")
    return result


def media_info(source: Path) -> tuple[float, bool]:
    result = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(source)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise ValueError(f"无法读取视频/音频时长：{source}")
    seconds = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    return seconds, bool(re.search(r"Stream #.*Audio:", result.stderr))


def video_size(source: Path) -> tuple[int, int]:
    result = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(source)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    match = re.search(r"Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b", result.stderr)
    if not match:
        raise ValueError(f"无法读取视频尺寸：{source}")
    return int(match.group(1)), int(match.group(2))


def timecode(value: float) -> str:
    millis = max(0, round(value * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def ass_time(value: float) -> str:
    centis = max(0, round(value * 100))
    hours, centis = divmod(centis, 360000)
    minutes, centis = divmod(centis, 6000)
    seconds, centis = divmod(centis, 100)
    return f"{hours}:{minutes:02}:{seconds:02}.{centis:02}"


def write_ass(cues: list[tuple[float, float, str]], size: tuple[int, int], target: Path) -> None:
    width, height = size
    fontsize = max(16, round(width * 0.052))
    margin_v = round(height * 0.09)
    margin_h = round(width * 0.08)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Narration,Microsoft YaHei,{fontsize},&H00FFFFFF,&H00FFFFFF,&H90000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,{margin_h},{margin_h},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    for begin, end, caption in cues:
        safe = caption.replace("\\", "").replace("{", "").replace("}", "").replace("\n", " ")
        lines.append(f"Dialogue: 0,{ass_time(begin)},{ass_time(end)},Narration,,0,0,0,,{safe}")
    target.write_text(header + "\n".join(lines) + "\n", encoding="utf-8-sig")


async def synthesize(text: str, voice: str, target: Path) -> list[dict]:
    import edge_tts

    boundaries = []
    with target.open("wb") as audio:
        async for event in edge_tts.Communicate(text=text, voice=voice).stream():
            if event["type"] == "audio":
                audio.write(event["data"])
            elif event["type"] in ("WordBoundary", "SentenceBoundary"):
                boundaries.append({"text": event.get("text", ""), "start": event["offset"] / 10_000_000, "end": (event["offset"] + event.get("duration", 0)) / 10_000_000})
    return boundaries


def make_cues(boundaries: list[dict], text: str, start: float, voice_duration: float) -> tuple[list[tuple[float, float, str]], bool]:
    # Voice events provide measured timings. Never silently accept a mismatched transcript.
    spoken = "".join(event["text"] for event in boundaries)
    clean = lambda value: re.sub(r"[\s，。！？、；：,.!?;:]", "", value)
    if not boundaries or clean(spoken) != clean(text):
        return [], False
    if any(len(event["text"]) > 14 for event in boundaries):
        return [], False
    cues = []
    chunk = []
    for event in boundaries:
        chunk.append(event)
        if sum(len(item["text"]) for item in chunk) >= 12 or re.search(r"[，。！？,!?]$", event["text"]):
            cues.append((start + chunk[0]["start"], start + min(voice_duration, chunk[-1]["end"] + 0.08), "".join(item["text"] for item in chunk)))
            chunk = []
    if chunk:
        cues.append((start + chunk[0]["start"], start + min(voice_duration, chunk[-1]["end"] + 0.08), "".join(item["text"] for item in chunk)))
    return cues, True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-file", required=True)
    args = parser.parse_args()
    request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
    source = Path(request["source_video"])
    if not source.is_file():
        raise FileNotFoundError(f"底片不存在：{source}")
    video_duration, source_has_audio = media_info(source)
    start = float(request.get("start_seconds", 0))
    if not 0 <= start < video_duration:
        raise ValueError(f"旁白起点必须在底片的 0–{video_duration:.2f} 秒内")
    text = str(request["narration"]).strip()
    if not text:
        raise ValueError("旁白文案不能为空")
    output_dir = Path(request["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    voice_source = str(request.get("voice_file") or "").strip()
    boundaries = []
    if voice_source:
        narration_audio = Path(voice_source)
        if not narration_audio.is_file():
            raise FileNotFoundError(f"旁白音频不存在：{voice_source}")
    else:
        narration_audio = output_dir / "narration.mp3"
        boundaries = asyncio.run(synthesize(text, request.get("voice", "zh-CN-XiaoxiaoNeural"), narration_audio))
    voice_duration, _ = media_info(narration_audio)
    max_end = request.get("max_end_seconds")
    if max_end is not None and start + voice_duration > min(float(max_end), video_duration - 0.05):
        raise ValueError(f"这一句旁白在 {start + voice_duration:.2f} 秒才念完，超过设定的 {float(max_end):.2f} 秒收尾点；请缩短文案或提前起声")
    if start + voice_duration > video_duration - 0.05:
        raise ValueError(f"旁白长 {voice_duration:.2f} 秒，从 {start:.2f} 秒起会超过底片 {video_duration:.2f} 秒；请缩短文案或提前起声")
    subtitle_requested = bool(request.get("burn_subtitles", False))
    subtitle_path = output_dir / "narration.srt"
    subtitle_status = "not_requested"
    if subtitle_requested:
        if voice_source:
            raise ValueError("上传配音时无法自动证明字幕时码；请先关闭字幕，或改用内置合成旁白")
        cues, matched = make_cues(boundaries, text, start, voice_duration)
        if not matched:
            observed = "".join(event["text"] for event in boundaries)
            raise ValueError(f"合成语音的词级时间与文案不一致，已停止烧录字幕（识别到：{observed[:80]}）；请修改文案或关闭字幕后重试")
        subtitle_path.write_text("\n".join(f"{index}\n{timecode(begin)} --> {timecode(end)}\n{caption}\n" for index, (begin, end, caption) in enumerate(cues, 1)), encoding="utf-8-sig")
        ass_path = output_dir / "narration.ass"
        write_ass(cues, video_size(source), ass_path)
        subtitle_status = "timed_to_tts_speech_boundaries"
    delay = round(start * 1000)
    input_args = [str(FFMPEG), "-hide_banner", "-y", "-i", str(source), "-i", str(narration_audio)]
    if source_has_audio:
        base = f"[0:a]volume=0.28:enable='between(t,{start:.3f},{start + voice_duration:.3f})',aresample=48000[base];"
    else:
        input_args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        base = "[2:a]aresample=48000[base];"
    filters = base + f"[1:a]aresample=48000,adelay={delay}:all=1[voice];[base][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]"
    command = input_args + ["-filter_complex", filters, "-map", "0:v:0", "-map", "[aout]"]
    if subtitle_requested:
        escaped = str(ass_path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        command += ["-vf", f"ass='{escaped}'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    else:
        command += ["-c:v", "copy"]
    output = output_dir / "final.mp4"
    command += ["-c:a", "aac", "-b:a", "192k", "-t", f"{video_duration:.3f}", "-movflags", "+faststart", str(output)]
    run(command)
    final_duration, final_audio = media_info(output)
    if not final_audio or abs(final_duration - video_duration) > 0.25:
        raise RuntimeError("输出音轨或时长校验失败")
    result = {"status": "succeeded", "source_video": str(source), "output": str(output), "duration": final_duration, "narration_audio": str(narration_audio), "narration": text, "narration_start": start, "narration_end": start + voice_duration, "subtitle": str(subtitle_path) if subtitle_requested else None, "subtitle_status": subtitle_status, "source_audio_preserved": source_has_audio}
    (output_dir / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
