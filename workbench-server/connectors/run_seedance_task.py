#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from zlhub_skill.config import load_env_config, missing_required_keys
from zlhub_skill.video_preview import create_video_preview_file


def _load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.payload_base64:
        try:
            raw = base64.b64decode(args.payload_base64).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            raise SystemExit(f"--payload-base64 不是有效的 UTF-8 JSON base64: {exc}") from exc
        return json.loads(raw)
    if args.payload_stdin:
        raw = sys.stdin.read()
        if not raw.strip():
            raise SystemExit("标准输入中没有 payload JSON")
        return json.loads(raw)
    if args.payload_file:
        return json.loads(Path(args.payload_file).read_text(encoding="utf-8"))
    if args.payload_json:
        return json.loads(args.payload_json)
    raise SystemExit("缺少请求参数：请提供 --payload-base64、--payload-stdin、--payload-json 或 --payload-file")


def _extract_prompt_from_payload(payload: dict[str, Any]) -> str:
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str):
                return text
    return ""


def _validate_payload_text(payload: dict[str, Any]) -> None:
    """Stop before billing if the local transport already corrupted prompt text."""
    prompt = _extract_prompt_from_payload(payload)
    if not prompt.strip():
        raise SystemExit("payload 中缺少非空的 content 文本提示词")
    if "\ufffd" in prompt or re.search(r"\?{4,}", prompt):
        raise SystemExit(
            "检测到提示词疑似乱码（连续 ???? 或 Unicode 替换字符）。"
            "请求未发送；请通过系统临时目录中的 UTF-8 JSON 文件，使用 --payload-file 重新提交。"
        )


def _request_json(req: urllib.request.Request, timeout: int = 60) -> tuple[int, dict[str, Any]]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            result = {"raw": raw}
        return e.code, result


def create_task(payload: dict[str, Any], config: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{config['ZLHUB_API_BASE'].rstrip('/')}/v1/task/create",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['ZLHUB_API_KEY']}",
        },
    )
    status, result = _request_json(req, timeout=90)
    if status >= 400:
        raise SystemExit(json.dumps({"http_status": status, "response": result}, ensure_ascii=False, indent=2))
    return result


def get_task(task_id: str, config: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{config['ZLHUB_API_BASE'].rstrip('/')}/v1/task/get/{task_id}",
        method="GET",
        headers={"Authorization": f"Bearer {config['ZLHUB_API_KEY']}"},
    )
    status, result = _request_json(req, timeout=60)
    if status >= 400:
        raise SystemExit(json.dumps({"http_status": status, "response": result}, ensure_ascii=False, indent=2))
    return result


def _task_status(result: dict[str, Any]) -> str:
    data = result.get("data") if isinstance(result, dict) else None
    if isinstance(data, dict):
        return str(data.get("status", ""))
    return str(result.get("status", ""))


def _task_id(create_result: dict[str, Any]) -> str:
    task_id = create_result.get("id") or create_result.get("data", {}).get("id")
    if not task_id:
        raise SystemExit("创建任务响应中没有任务 ID")
    return str(task_id)


def _emit_task_created(task_id: str, create_result: dict[str, Any]) -> None:
    """Expose the task ID before long polling begins without changing final JSON output."""
    event = {
        "event": "task_created",
        "task_id": task_id,
        "status": _task_status(create_result) or "queued",
    }
    print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)


def _is_fast_model(model: str) -> bool:
    return model.endswith("-fast")


def _default_timeout_seconds(model: str) -> int:
    return 900 if _is_fast_model(model) else 1200


def _next_poll_delay_seconds(model: str, elapsed_seconds: float, poll_count: int) -> int:
    """Return the next polling delay using the Seedance model-specific schedule."""
    if _is_fast_model(model):
        if poll_count == 0:
            return 45
        if elapsed_seconds < 360:
            return 15
        if elapsed_seconds < 720:
            return 60
        return 120

    if poll_count == 0:
        return 60
    if elapsed_seconds < 90:
        return 30
    if elapsed_seconds < 600:
        return 15
    if elapsed_seconds < 900:
        return 60
    return 120


def _format_total_cost(cost: dict[str, Any] | None) -> str | None:
    if not cost:
        return None
    total = cost.get("total_cost")
    if total is None:
        return None
    try:
        amount = f"{float(total):.2f}"
    except (TypeError, ValueError):
        amount = str(total)
    return f"￥{amount}"


def run(args: argparse.Namespace) -> dict[str, Any]:
    config = load_env_config()
    missing = missing_required_keys(config)
    if missing:
        raise SystemExit(
            "ZLHub 配置不完整。若缺少 ZLHUB_API_KEY，请先向用户询问 API_KEY，"
            "并由 Codex 自动调用 scripts/set_zlhub_api_key.py 保存。缺失配置: "
            + ", ".join(missing)
        )

    payload = _load_payload(args)
    _validate_payload_text(payload)
    prompt = _extract_prompt_from_payload(payload)
    model = str(payload.get("model", ""))
    timeout_seconds = args.timeout_seconds or _default_timeout_seconds(model)
    create_result = create_task(payload, config)
    task_id = _task_id(create_result)
    _emit_task_created(task_id, create_result)

    if args.no_poll:
        return {"task_id": task_id, "create_result": create_result}

    polls = []
    start = time.time()
    check_count = 0
    last_result: dict[str, Any] | None = None

    while True:
        elapsed = time.time() - start
        if elapsed > timeout_seconds:
            return {
                "task_id": task_id,
                "status": "TIMEOUT",
                "timeout_seconds": timeout_seconds,
                "polls": polls,
                "last_result": last_result,
            }

        sleep_seconds = _next_poll_delay_seconds(model, elapsed, check_count)
        sleep_seconds = min(sleep_seconds, max(1, int(timeout_seconds - elapsed)))
        time.sleep(sleep_seconds)
        check_count += 1
        result = get_task(task_id, config)
        last_result = result
        status = _task_status(result)
        polls.append({"index": check_count, "elapsed_seconds": int(time.time() - start), "status": status})

        if status == "succeeded":
            preview_path = create_video_preview_file(result, prompt)
            data = result.get("data", {})
            return {
                "task_id": task_id,
                "status": status,
                "video_url": data.get("content", {}).get("video_url"),
                "preview_path": str(preview_path),
                "cost": data.get("cost"),
                "total_cost_display": _format_total_cost(data.get("cost")),
                "polls": polls,
                "result": result,
            }
        if status == "failed":
            return {
                "task_id": task_id,
                "status": status,
                "polls": polls,
                "result": result,
            }


def main() -> None:
    parser = argparse.ArgumentParser(description="创建 Seedance 视频任务、轮询结果并生成预览页。")
    parser.add_argument("--payload-file", help="UTF-8 JSON payload 文件；正式任务的唯一推荐输入方式")
    parser.add_argument("--payload-base64", help="兼容旧调用；仅限已确认由正确 UTF-8 字节生成的 base64")
    parser.add_argument("--payload-stdin", action="store_true", help="仅限已确认标准输入为 UTF-8 的环境")
    parser.add_argument("--payload-json", help="仅限短 ASCII JSON payload")
    parser.add_argument("--no-poll", action="store_true", help="只创建任务，不轮询")
    parser.add_argument("--timeout-seconds", type=int, default=None, help="覆盖默认超时时间；默认按模型自动选择")
    args = parser.parse_args()
    print(json.dumps(run(args), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
