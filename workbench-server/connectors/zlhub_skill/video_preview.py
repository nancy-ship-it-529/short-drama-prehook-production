from __future__ import annotations

import tempfile
from html import escape
from pathlib import Path
from typing import Any


def _safe_filename(value: str) -> str:
    return "".join(char if char.isalnum() or char in "-_" else "-" for char in value)


def _format_cost(cost: dict[str, Any] | None) -> str:
    if not cost:
        return "-"
    total = cost.get("total_cost")
    if total is None:
        return "-"
    try:
        amount = f"{float(total):.2f}"
    except (TypeError, ValueError):
        amount = str(total)
    return f"￥{amount}"


def build_video_preview_html(
    *,
    video_url: str,
    task_id: str,
    prompt: str,
    model: str,
    duration: str,
    resolution: str,
    cost: str,
) -> str:
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZLHub 视频预览 - {escape(task_id)}</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      background: #f4f6f8;
      color: #1f2328;
    }}
    main {{ width: min(1120px, calc(100% - 32px)); margin: 28px auto; }}
    h1 {{ font-size: 22px; line-height: 1.25; margin: 0 0 14px; font-weight: 680; }}
    .layout {{ display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: start; }}
    .panel {{ background: #fff; border: 1px solid #d8dee4; border-radius: 8px; overflow: hidden; }}
    .video-wrap {{ padding: 12px; }}
    video {{ display: block; width: 100%; max-height: 72vh; background: #000; border-radius: 6px; }}
    .meta {{ padding: 14px; }}
    .meta h2 {{ font-size: 15px; margin: 0 0 12px; }}
    .item {{
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 10px;
      padding: 10px 0;
      border-top: 1px solid #edf0f2;
      font-size: 14px;
      line-height: 1.55;
    }}
    .item:first-of-type {{ border-top: 0; padding-top: 0; }}
    .label {{ color: #59636e; white-space: nowrap; }}
    .value {{ min-width: 0; word-break: break-word; }}
    .url {{ margin-top: 10px; color: #59636e; font-size: 12px; word-break: break-all; }}
    @media (max-width: 880px) {{ .layout {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <main>
    <h1>ZLHub 视频预览</h1>
    <section class="layout">
      <div class="panel">
        <div class="video-wrap">
          <video controls playsinline preload="metadata">
            <source src="{escape(video_url, quote=True)}" type="video/mp4">
            当前浏览器不支持视频预览。
          </video>
        </div>
      </div>
      <aside class="panel meta">
        <h2>任务信息</h2>
        <div class="item"><div class="label">任务ID</div><div class="value">{escape(task_id)}</div></div>
        <div class="item"><div class="label">提示词</div><div class="value">{escape(prompt)}</div></div>
        <div class="item"><div class="label">模型</div><div class="value">{escape(model)}</div></div>
        <div class="item"><div class="label">时长</div><div class="value">{escape(duration)}</div></div>
        <div class="item"><div class="label">分辨率</div><div class="value">{escape(resolution)}</div></div>
        <div class="item"><div class="label">花费</div><div class="value">{escape(cost)}</div></div>
        <div class="url">视频链接：请从 Codex 对话框中的生成结果复制或下载。</div>
      </aside>
    </section>
  </main>
</body>
</html>
"""


def create_video_preview_file(
    task_result: dict[str, Any],
    prompt: str,
    output_dir: str | Path | None = None,
) -> Path:
    data = task_result.get("data", task_result)
    content = data.get("content", {})
    video_url = content.get("video_url")
    task_id = data.get("id") or task_result.get("id") or "zlhub-video"
    if not video_url:
        raise ValueError("task result does not contain content.video_url")

    duration_value = data.get("duration", "")
    duration = f"{duration_value} 秒" if duration_value != "" else "-"
    resolution = data.get("resolution", "-")
    ratio = data.get("ratio")
    if ratio:
        resolution = f"{resolution}，{ratio}"

    html = build_video_preview_html(
        video_url=video_url,
        task_id=str(task_id),
        prompt=prompt,
        model=str(data.get("model", "-")),
        duration=duration,
        resolution=str(resolution),
        cost=_format_cost(data.get("cost")),
    )
    output_path = Path(output_dir or tempfile.gettempdir()) / f"zlhub-preview-{_safe_filename(str(task_id))}.html"
    output_path.write_text(html, encoding="utf-8")
    return output_path
