#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from zlhub_skill.config import load_env_config
from zlhub_skill.config import missing_required_keys, ASSET_KEYS
from zlhub_skill.seedance_assets import create_seedance_payload, prepare_reference_image


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Detect faces in reference images and prepare Seedance image_url inputs."
    )
    parser.add_argument("images", nargs="*", help="Local reference image paths")
    parser.add_argument("--prompt", help="Seedance text prompt")
    parser.add_argument("--request-file", help="UTF-8 JSON request file; preferred for Chinese prompts")
    parser.add_argument("--score", type=float, default=0.5, help="Face detection score threshold")
    parser.add_argument("--model", default="doubao-seedance-2.0-fast")
    parser.add_argument("--duration", type=int, default=5)
    parser.add_argument("--resolution", default="480p")
    parser.add_argument("--ratio", default="16:9")
    parser.add_argument("--generate-audio", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--watermark", action=argparse.BooleanOptionalAction, default=False)
    args = parser.parse_args()

    request = {}
    if args.request_file:
        request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
    prompt = request.get("prompt", args.prompt)
    images = request.get("images", args.images)
    if not isinstance(prompt, str) or not prompt.strip():
        raise SystemExit("缺少非空的 Seedance 提示词")
    if not isinstance(images, list):
        raise SystemExit("images 必须是本地图片路径数组")
    model = request.get("model", args.model)
    duration = int(request.get("duration", args.duration))
    resolution = request.get("resolution", args.resolution)
    ratio = request.get("ratio", args.ratio)
    generate_audio = bool(request.get("generate_audio", args.generate_audio))
    watermark = bool(request.get("watermark", args.watermark))

    config = load_env_config()
    missing = missing_required_keys(config)
    if images:
        missing += [key for key in ASSET_KEYS if not config.get(key)]
    if missing:
        raise SystemExit(
            "ZLHub 配置不完整，请在接收者本机 credentials.env 配置；不要在聊天中暴露密钥。"
            "缺失配置: " + ", ".join(missing)
        )
    prepared = [
        prepare_reference_image(path, config=config, face_score=args.score)
        for path in images
    ]
    payload = create_seedance_payload(
        prompt,
        prepared,
        model=model,
        duration=duration,
        resolution=resolution,
        ratio=ratio,
        generate_audio=generate_audio,
        watermark=watermark,
    )
    print(json.dumps({"prepared_images": prepared, "seedance_payload": payload}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
