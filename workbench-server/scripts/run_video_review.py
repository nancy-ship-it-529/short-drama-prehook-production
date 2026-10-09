from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

import sys
import os

ZLHUB_SCRIPTS = Path(os.environ.get("ZLHUB_SCRIPTS", str(Path(__file__).resolve().parents[1] / "connectors")))
sys.path.insert(0, str(ZLHUB_SCRIPTS))
from zlhub_skill.config import load_env_config, missing_required_keys  # noqa: E402


def extract_json(text: str) -> dict:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.I)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if not match:
            raise ValueError("审片模型没有返回JSON")
        return json.loads(match.group(0))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-file", required=True)
    args = parser.parse_args()
    payload = json.loads(Path(args.payload_file).read_text(encoding="utf-8"))
    config = load_env_config(); missing = missing_required_keys(config)
    if missing:
        raise SystemExit("ZLHub配置不完整：" + ", ".join(missing))
    request = urllib.request.Request(
        config["ZLHUB_API_BASE"].rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Authorization": "Bearer " + config["ZLHUB_API_KEY"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise SystemExit(error.read().decode("utf-8", errors="replace")) from error
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
    review = extract_json(str(content))
    score = int(round(float(review.get("total_score", 0))))
    review["total_score"] = max(0, min(100, score))
    review["passed"] = review["total_score"] >= 80
    cost = result.get("cost") or result.get("data", {}).get("cost") or {}
    total = cost.get("total_cost")
    output = {"status": "succeeded", "review": review, "cost": cost, "total_cost_display": f"￥{float(total):.2f}" if total is not None else None}
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
