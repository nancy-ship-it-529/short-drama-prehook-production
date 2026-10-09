from __future__ import annotations

import json
import os
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import tos

from .config import load_env_config
from .face_detection import detect_faces


def upload_to_tos(local_file_path: str | Path, config: dict[str, str]) -> str:
    local_path = Path(local_file_path)
    client = tos.TosClientV2(
        config["TOS_AK"],
        config["TOS_SK"],
        config["TOS_ENDPOINT"],
        config["TOS_REGION"],
    )
    ext = local_path.suffix.lower()
    object_key = f"images/{uuid.uuid4().hex}{ext}"
    with local_path.open("rb") as f:
        client.put_object(config["TOS_BUCKET"], object_key, content=f)
    return f"{config['TOS_PUBLIC_BASE_URL'].rstrip('/')}/{object_key}"


def submit_asset_review_sync(source_url: str, config: dict[str, str]) -> dict[str, Any]:
    payload = {"images": [source_url], "asset_type": "Image"}
    body = json.dumps(payload).encode("utf-8")
    track_id = uuid.uuid4().hex
    req = urllib.request.Request(
        f"{config['ZLHUB_ASSET_API_BASE'].rstrip('/')}/api/asset/upload/sync",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Access-Token": config["ZLHUB_ASSET_ACCESS_TOKEN"],
            "X-Track-Id": track_id,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8")
            result = json.loads(raw)
            result["_http_status"] = resp.status
            result["_track_id"] = resp.headers.get("X-Track-Id", track_id)
            return result
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            result = {"raw": raw}
        result["_http_status"] = e.code
        result["_track_id"] = e.headers.get("X-Track-Id", track_id)
        return result


def extract_first_asset_url(review_result: dict[str, Any]) -> str:
    items = review_result.get("result", {}).get("items", [])
    if not items:
        raise ValueError("asset review response has no result.items")
    item = items[0]
    if item.get("submit_review_status") != 1 or not item.get("asset_url"):
        raise ValueError(
            f"asset review failed: {item.get('error_code', '')} {item.get('error_message', '')}".strip()
        )
    return item["asset_url"]


def prepare_reference_image(
    local_file_path: str | Path,
    config: dict[str, str] | None = None,
    face_score: float = 0.5,
) -> dict[str, Any]:
    """Prepare one local reference image for Seedance.

    If a face is detected, upload to public TOS and run real-person asset review,
    returning the approved asset_url. If no face is detected, return the public TOS
    URL directly for use as image_url.url.
    """
    config = config or load_env_config()
    face_result = detect_faces(str(local_file_path), score=face_score)
    if face_result.get("error"):
        raise ValueError(
            f"reference image face detection failed: {local_file_path}: {face_result['error']}"
        )
    public_url = upload_to_tos(local_file_path, config)

    if face_result.get("has_face"):
        review_result = submit_asset_review_sync(public_url, config)
        asset_url = extract_first_asset_url(review_result)
        return {
            "input_path": str(local_file_path),
            "has_face": True,
            "faces": face_result,
            "tos_url": public_url,
            "seedance_url": asset_url,
            "review_result": review_result,
        }

    return {
        "input_path": str(local_file_path),
        "has_face": False,
        "faces": face_result,
        "tos_url": public_url,
        "seedance_url": public_url,
        "review_result": None,
    }


def build_seedance_content(prompt: str, prepared_images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for prepared in prepared_images:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": prepared["seedance_url"]},
                "role": "reference_image",
            }
        )
    return content


def create_seedance_payload(
    prompt: str,
    prepared_images: list[dict[str, Any]],
    model: str = "doubao-seedance-2.0-fast",
    duration: int = 5,
    resolution: str = "480p",
    ratio: str = "16:9",
    generate_audio: bool = True,
    watermark: bool = False,
) -> dict[str, Any]:
    return {
        "model": model,
        "content": build_seedance_content(prompt, prepared_images),
        "duration": duration,
        "resolution": resolution,
        "ratio": ratio,
        "generate_audio": generate_audio,
        "watermark": watermark,
    }
