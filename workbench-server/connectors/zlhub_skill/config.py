"""Public connector: explicit user configuration only; no embedded defaults."""
import os
from pathlib import Path

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "credentials.env"
REQUIRED_KEYS = ["ZLHUB_API_BASE", "ZLHUB_API_KEY"]
ASSET_KEYS = ["ZLHUB_ASSET_API_BASE", "ZLHUB_ASSET_ACCESS_TOKEN", "TOS_AK", "TOS_SK", "TOS_REGION", "TOS_BUCKET", "TOS_ENDPOINT", "TOS_PUBLIC_BASE_URL"]


def load_env_config(path=None):
    source = Path(path or os.environ.get("ZLHUB_CONFIG_PATH", DEFAULT_CONFIG_PATH))
    config = {}
    if source.is_file():
        for raw in source.read_text(encoding="utf-8-sig").splitlines():
            if not raw.strip() or raw.lstrip().startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            config[key.strip()] = value.strip().strip("\"'")
    for key in REQUIRED_KEYS + ASSET_KEYS:
        if os.environ.get(key):
            config[key] = os.environ[key]
    return config


def missing_required_keys(config):
    return [key for key in REQUIRED_KEYS if not config.get(key)]
