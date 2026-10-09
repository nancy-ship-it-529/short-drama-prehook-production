#!/usr/bin/env python3
"""Portable TOS uploader. Python 3.10+; tos==2.9.2 and requests.

Only JSON progress is printed. Download URLs stay in private manifests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import mimetypes
import os
import re
import stat
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit

DEFAULTS = dict(bucket="", region="cn-beijing",
                endpoint="https://tos-cn-beijing.volces.com", link_mode="permanent",
                expires_seconds=604800)
VIDEO = set(".mp4 .mov .mkv .avi .webm .flv .m4v .wmv .mpeg .mpg .3gp .ts .mts .m2ts .vob".split())
IMAGE = set(".jpg .jpeg .png .webp .gif .bmp .tiff .tif .heic .heif .avif .apng".split())
MEDIA = VIDEO | IMAGE
MIB, SAMPLE = 1024 * 1024, 64 * 1024


class CliError(Exception):
    """Only fixed, non-sensitive diagnostic identifiers belong here."""


def emit(event, **data):
    print(json.dumps(dict(event=event, **data), ensure_ascii=False), flush=True)


def now():
    return datetime.now(timezone.utc)


def run_id():
    return now().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex


def safe_error(exc):
    # Never serialize str(exc), response bodies, headers, or request URLs.
    result = {"error": exc.args[0] if isinstance(exc, CliError) else type(exc).__name__}
    status_code = getattr(exc, "status_code", None)
    if type(status_code) is int:
        result["http_status"] = status_code
    code = getattr(exc, "code", None)
    if code in {"AccessDenied", "NoSuchBucket", "NoSuchKey", "NoSuchLifecycleConfiguration",
                "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken",
                "EntityAlreadyExists", "PreconditionFailed", "RequestTimeTooSkewed"}:
        result["service_code"] = code
    return result


def read_json(path):
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise CliError("json_object_required")
    return value


def private_write(path, value):
    """Replace atomically, with 0600 from creation; never follow an output link."""
    path = Path(path)
    if path.is_symlink():
        raise CliError("report_symlink_rejected")
    fd, temporary = tempfile.mkstemp(prefix=".manifest-", dir=path.parent)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_config(path):
    config = dict(DEFAULTS)
    for key, env_key in {"bucket": "TOS_BUCKET", "region": "TOS_REGION", "endpoint": "TOS_ENDPOINT"}.items():
        if os.environ.get(env_key):
            config[key] = os.environ[env_key]
    if path.exists():
        supplied = read_json(path)
        if set(supplied) - set(DEFAULTS):
            raise CliError("unknown_config_keys")
        config.update(supplied)
    elif path != Path(__file__).resolve().parents[1] / "config.json":
        raise CliError("config_file_missing")
    if not isinstance(config["bucket"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", config["bucket"]):
        raise CliError("invalid_bucket")
    if not isinstance(config["region"], str) or not re.fullmatch(r"[a-z0-9-]+", config["region"]):
        raise CliError("invalid_region")
    endpoint = urlsplit(config["endpoint"])
    if endpoint.scheme != "https" or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment or endpoint.path not in ("", "/"):
        raise CliError("endpoint_must_be_https_origin")
    if type(config["expires_seconds"]) is not int or not 1 <= config["expires_seconds"] <= 604800:
        raise CliError("expires_must_be_1_to_604800")
    if config["link_mode"] not in ("permanent", "signed"):
        raise CliError("invalid_link_mode")
    return config


def credentials_path():
    root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".config")) if os.name == "nt" else Path.home() / ".config"
    return root / "lianshan-tos-upload" / "credentials.json"


def make_client(config, credential_file):
    import tos
    # An explicit file wins. Never silently mix an environment AK with a file SK.
    if credential_file:
        credentials = read_json(credential_file)
    elif os.environ.get("TOS_ACCESS_KEY") or os.environ.get("TOS_SECRET_KEY"):
        credentials = dict(access_key=os.environ.get("TOS_ACCESS_KEY"),
                           secret_key=os.environ.get("TOS_SECRET_KEY"),
                           security_token=os.environ.get("TOS_SECURITY_TOKEN"))
    else:
        credentials = read_json(credentials_path())
    if not all(isinstance(credentials.get(key), str) and credentials[key].strip() for key in ("access_key", "secret_key")):
        raise CliError("credentials_incomplete")
    if credentials.get("security_token") is not None and not isinstance(credentials["security_token"], str):
        raise CliError("security_token_must_be_string")

    class NoOverwriteClient(tos.TosClientV2):
        # SDK 2.9.2 upload_file does not expose forbid_overwrite itself.
        def create_multipart_upload(self, *args, **kwargs):
            kwargs["forbid_overwrite"] = True
            return super().create_multipart_upload(*args, **kwargs)

        def complete_multipart_upload(self, *args, **kwargs):
            kwargs["forbid_overwrite"] = True
            return super().complete_multipart_upload(*args, **kwargs)

    return NoOverwriteClient(credentials["access_key"], credentials["secret_key"],
                             endpoint=config["endpoint"], region=config["region"],
                             security_token=credentials.get("security_token"),
                             enable_crc=True, enable_verify_ssl=True, max_retry_count=2,
                             connection_time=10, socket_timeout=60)


def reject_symlink(path):
    # resolve() alone would silently dereference a symlink.
    for component in (path, *path.parents):
        if component.is_symlink():
            raise CliError("source_symlink_rejected")


def collect_files(paths, recursive, media_type="all"):
    files, seen = [], set()
    allowed = {"video": VIDEO, "image": IMAGE, "all": MEDIA}[media_type]

    def add(path, explicit=False):
        reject_symlink(path)
        if path.name.startswith("."):
            return
        mode = path.stat().st_mode
        if not stat.S_ISREG(mode):
            if not stat.S_ISDIR(mode):
                raise CliError("non_regular_source_rejected")
            return
        if explicit and path.suffix.lower() not in allowed:
            raise CliError("explicit_file_media_type_mismatch")
        if path.suffix.lower() in allowed and path not in seen:
            seen.add(path)
            files.append(path)

    for supplied in paths:
        root = Path(supplied).expanduser().absolute()
        reject_symlink(root)
        if root.name.startswith("."):
            continue
        if not root.is_dir():
            add(root, explicit=True)
            continue
        for current, directories, names in os.walk(root, followlinks=False):
            for name in directories + names:
                candidate = Path(current) / name
                if not name.startswith("."):
                    reject_symlink(candidate)
            directories[:] = sorted(name for name in directories if not name.startswith(".")) if recursive else []
            for name in sorted(names):
                add(Path(current) / name)
    if not files:
        raise CliError("no_eligible_files")
    return files


def fingerprint(path):
    reject_symlink(path)
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(MIB):
            digest.update(chunk)
        size = handle.tell()
        ranges = [(0, min(SAMPLE, size))]
        if size > SAMPLE:
            ranges.append((max(SAMPLE, size - SAMPLE), size))
        samples = []
        for start, end in ranges:
            handle.seek(start)
            samples.append(dict(start=start, end=end, sha256=hashlib.sha256(handle.read(end - start)).hexdigest()))
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise CliError("source_changed_during_hash")
    return dict(size=size, sha256=digest.hexdigest(), samples=samples)


def new_report(args, config, kind, identifier=None):
    identifier = identifier or run_id()
    base = Path(args.output or "tos-upload-reports").expanduser().absolute()
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = base / identifier
    directory.mkdir(mode=0o700)
    report = dict(schema_version=2, kind=kind, run_id=identifier, created_at=now().isoformat(),
                  bucket=config["bucket"], region=config["region"], endpoint=config["endpoint"], items=[])
    if kind != "check":
        report["link_mode"] = args.link_mode
    args.report_manifest = str(directory / "manifest.json")
    return directory / "manifest.json", report


def save(manifest, report):
    report["updated_at"] = now().isoformat()
    private_write(manifest, report)


def disposition(filename):
    extension = Path(filename).suffix.lower()
    extension = extension if re.fullmatch(r"\.[a-z0-9]{1,10}", extension) else ""
    return 'attachment; filename="download' + extension + '"; filename*=UTF-8\'\'' + quote(filename, safe="")


def sign(client, config, item, expires):
    import tos
    signed_at = now()
    output = client.pre_signed_url(tos.HttpMethodType.Http_Method_Get, config["bucket"],
                                   key=item["object_key"], expires=expires,
                                   query={"response-content-disposition": disposition(item["filename"])})
    item.update(url=output.signed_url, link_mode="signed", signed_url=output.signed_url, signed_at=signed_at.isoformat(),
                expires_seconds=expires, expires_at=(signed_at + timedelta(seconds=expires)).isoformat())


def set_link(client, config, item, link_mode, expires=None):
    # Never let a refreshed permanent link retain an old signed URL or expiry.
    for field in ("url", "link_mode", "signed_url", "signed_at", "expires_seconds", "expires_at"):
        item.pop(field, None)
    if link_mode == "signed":
        sign(client, config, item, expires or config["expires_seconds"])
    else:
        endpoint = urlsplit(config["endpoint"])
        item.update(url=f"https://{config['bucket']}.{endpoint.netloc}/{quote(item['object_key'], safe='/')}",
                    link_mode="permanent", expires_at=None)


def check_public_access(item, response):
    if item["link_mode"] == "permanent" and response.status_code == 403:
        raise CliError("public_read_required")


def verify(item, mode):
    import requests
    size = item["size"]
    with requests.Session() as session:
        # Do not let local .netrc credentials authenticate a public-link check.
        session.trust_env = False
        options = dict(stream=True, timeout=(10, 60), verify=True, allow_redirects=False)
        if mode == "full" or size == 0:
            with session.get(item["url"], headers={"Accept-Encoding": "identity"}, **options) as response:
                check_public_access(item, response)
                if response.status_code != 200:
                    raise CliError("download_http_status_" + str(response.status_code))
                digest, downloaded = hashlib.sha256(), 0
                for chunk in response.iter_content(MIB):
                    downloaded += len(chunk)
                    if downloaded > size:
                        raise CliError("download_size_mismatch")
                    digest.update(chunk)
                if downloaded != size or digest.hexdigest() != item["sha256"]:
                    raise CliError("download_sha256_or_size_mismatch")
            return dict(status="passed", mode="full", bytes_checked=downloaded,
                        sha256=digest.hexdigest(), checked_at=now().isoformat())
        checked = 0
        for sample in item["samples"]:
            start, end = sample["start"], sample["end"]
            headers = {"Accept-Encoding": "identity", "Range": f"bytes={start}-{end - 1}"}
            with session.get(item["url"], headers=headers, **options) as response:
                check_public_access(item, response)
                if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end - 1}/{size}":
                    raise CliError("sample_range_or_total_size_mismatch")
                digest, count = hashlib.sha256(), 0
                for chunk in response.iter_content(SAMPLE):
                    count += len(chunk)
                    if count > end - start:
                        raise CliError("sample_size_mismatch")
                    digest.update(chunk)
                if count != end - start or (sample.get("sha256") and digest.hexdigest() != sample["sha256"]):
                    raise CliError("sample_sha256_or_size_mismatch")
                checked += count
        compared = all(sample.get("sha256") for sample in item["samples"])
        return dict(status="passed", mode="sample", bytes_checked=checked,
                    compared_with_source=compared,
                    note="仅抽样验证 Range 与总大小，未验证完整文件" + ("；抽样摘要与原文件匹配" if compared else "；无原始抽样摘要，未比较原文件内容"),
                    checked_at=now().isoformat())


def progress(key):
    last = [0.0]

    def listener(consumed, total, once, event):
        if time.monotonic() - last[0] >= 1 or consumed == total:
            emit("upload_progress", object_key=key, bytes=consumed, total=total)
            last[0] = time.monotonic()
    return listener


def run_upload(args, config):
    paths = collect_files(args.paths, args.recursive, args.media_type)
    identifier = run_id()
    manifest, report = new_report(args, config, "dry_run" if args.dry_run else "upload", identifier)
    counts = {}
    for path in paths:
        counts[path.name] = counts.get(path.name, 0) + 1
        suffix = f"{counts[path.name]}/" if counts[path.name] > 1 else ""
        report["items"].append(dict(source=str(path), filename=path.name, size=path.stat().st_size,
                                    object_key=f"uploads/{identifier}/{suffix}{path.name}", status="planned"))
    save(manifest, report)
    emit("plan", files=len(paths), bytes=sum(item["size"] for item in report["items"]), manifest=str(manifest))
    if args.dry_run:
        for item in report["items"]:
            emit("planned_file", source=item["source"], object_key=item["object_key"], size=item["size"])
        emit("complete", dry_run=True, manifest=str(manifest), files=len(paths))
        return 0
    client = make_client(config, args.credentials)
    failures = 0
    for path, item in zip(paths, report["items"]):
        stage = "hash"
        try:
            item.update(fingerprint(path))
            item["status"] = "uploading"
            save(manifest, report)
            stage = "upload"
            options = dict(bucket=config["bucket"], key=item["object_key"], file_path=str(path),
                           content_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                           content_disposition=disposition(path.name), data_transfer_listener=progress(item["object_key"]))
            if args.public_read:
                import tos
                # Applies only when this operation creates a new object.
                options["acl"] = tos.ACLType.ACL_Public_Read
            reject_symlink(path)
            if item["size"] <= 20 * MIB:
                result = client.put_object_from_file(**options, forbid_overwrite=True)
            else:
                checkpoint_dir = manifest.parent / "checkpoints"
                checkpoint_dir.mkdir(exist_ok=True, mode=0o700)
                result = client.upload_file(**options, enable_checkpoint=True, part_size=20 * MIB,
                                            task_num=2, checkpoint_file=str(checkpoint_dir / "upload"))
            item.update(status="uploaded", uploaded_at=now().isoformat(), etag=getattr(result, "etag", None),
                        hash_crc64_ecma=getattr(result, "hash_crc64_ecma", None),
                        version_id=getattr(result, "version_id", None))
            # Persist this fact before link generation or an anonymous download.
            save(manifest, report)
            emit("uploaded", object_key=item["object_key"], size=item["size"])
            stage = "link"
            set_link(client, config, item, args.link_mode, args.expires)
            save(manifest, report)
            stage = "verify"
            item["verification"] = verify(item, args.verify)
            emit("verified", object_key=item["object_key"], mode=item["verification"]["mode"])
        except Exception as exc:
            failures += 1
            item["failure"] = dict(stage=stage, **safe_error(exc))
            if item["status"] != "uploaded":
                item["status"] = "upload_uncertain" if stage == "upload" else "failed"
            emit("file_failed", object_key=item["object_key"], **item["failure"])
        save(manifest, report)
    report["failed_count"] = failures
    save(manifest, report)
    emit("complete", manifest=str(manifest), files=len(paths), failed=failures)
    return int(failures > 0)


def run_refresh(args, config):
    original = read_json(args.manifest)
    if original.get("bucket") != config["bucket"]:
        raise CliError("manifest_bucket_mismatch")
    items = original.get("items", original.get("results"))
    if not isinstance(items, list):
        raise CliError("manifest_items_invalid")
    selected = []
    fields = {"source", "filename", "size", "object_key", "sha256", "samples", "etag", "hash_crc64_ecma", "version_id", "uploaded_at", "status"}
    for entry in items:
        if not isinstance(entry, dict):
            raise CliError("manifest_item_invalid")
        if entry.get("bucket", config["bucket"]) != config["bucket"]:
            raise CliError("manifest_item_bucket_mismatch")
        if entry.get("status") not in {"uploaded", "verified", "download_failed", "verification_failed", "sign_failed", "url_failed", "uploading", "upload_uncertain"}:
            continue
        item = {key: value for key, value in entry.items() if key in fields}
        item["filename"] = entry.get("filename", entry.get("file_name"))
        item["size"] = entry.get("size", entry.get("size_bytes"))
        item["status"] = "upload_uncertain" if entry["status"] in {"uploading", "upload_uncertain"} else "uploaded"
        if not isinstance(item.get("object_key"), str) or not item["object_key"] or not isinstance(item.get("filename"), str):
            raise CliError("manifest_object_invalid")
        if type(item.get("size")) is not int or item["size"] < 0 or not re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")):
            raise CliError("manifest_integrity_metadata_invalid")
        expected = [(0, min(SAMPLE, item["size"]))]
        if item["size"] > SAMPLE:
            expected.append((max(SAMPLE, item["size"] - SAMPLE), item["size"]))
        samples = item.get("samples")
        if not samples:
            samples = [dict(start=start, end=end) for start, end in expected]
        if args.verify == "sample" and (not isinstance(samples, list) or len(samples) != len(expected) or any(
                not isinstance(s, dict) or (s.get("start"), s.get("end")) != bounds or
                (s.get("sha256") is not None and not re.fullmatch(r"[a-f0-9]{64}", s["sha256"])) for s, bounds in zip(samples, expected))):
            raise CliError("manifest_sample_metadata_invalid")
        item["samples"] = samples
        selected.append(item)
    if not selected:
        raise CliError("manifest_has_no_uploaded_objects")
    manifest, report = new_report(args, config, "refresh")
    report["items"] = selected
    save(manifest, report)
    # Permanent refresh neither needs credentials nor changes any object's ACL.
    client = make_client(config, args.credentials) if args.link_mode == "signed" else None
    failures = 0
    for item in selected:
        stage = "link"
        try:
            set_link(client, config, item, args.link_mode, args.expires)
            save(manifest, report)
            stage = "verify"
            item["verification"] = verify(item, "full" if item["status"] == "upload_uncertain" else args.verify)
            if item["status"] == "upload_uncertain":
                item.update(status="uploaded", recovered_at=now().isoformat())
            emit("refreshed", object_key=item["object_key"], mode=item["verification"]["mode"])
        except Exception as exc:
            failures += 1
            item["failure"] = dict(stage=stage, **safe_error(exc))
            emit("file_failed", object_key=item["object_key"], **item["failure"])
        save(manifest, report)
    report["failed_count"] = failures
    save(manifest, report)
    emit("complete", manifest=str(manifest), files=len(selected), failed=failures)
    return int(failures > 0)


def run_check(args, config):
    manifest, report = new_report(args, config, "check")
    report["checks"], failures = {}, 0
    save(manifest, report)
    client = make_client(config, args.credentials)
    for method in ("head_bucket", "get_bucket_location", "get_bucket_lifecycle"):
        try:
            result = getattr(client, method)(config["bucket"])
            check = {"status": "ok"}
            if method == "get_bucket_lifecycle":
                rules = getattr(result, "rules", []) or []
                check.update(lifecycle="configured" if rules else "no_rules", rules=[])
                for rule in rules:
                    expiration = getattr(rule, "expiration", None)
                    abort = getattr(rule, "abort_in_complete_multipart_upload", None)
                    check["rules"].append(dict(id=rule.id, prefix=rule.prefix,
                        status=getattr(rule.status, "value", rule.status),
                        expiration_days=getattr(expiration, "days", None),
                        expiration_date=str(expiration.date) if expiration and expiration.date else None,
                        abort_incomplete_days=getattr(abort, "days_after_init", None)))
            else:
                check["region"] = getattr(result, "region", None)
                if check["region"] and check["region"] != config["region"]:
                    check["status"] = "region_mismatch"
                    failures += 1
        except Exception as exc:
            if method == "get_bucket_lifecycle" and getattr(exc, "status_code", None) == 404 and getattr(exc, "code", None) == "NoSuchLifecycleConfiguration":
                check = dict(status="ok", lifecycle="no_rules", rules=[])
            else:
                denied = getattr(exc, "status_code", None) == 403
                head_ok = report["checks"].get("head_bucket", {}).get("status") == "ok"
                if not (denied and method != "head_bucket" and head_ok):
                    failures += 1
                check = dict(status="permission_denied" if denied else "failed", **safe_error(exc))
                if denied:
                    check["note"] = "无权读取此配置；不能推断配置不存在"
        report["checks"][method] = check
        save(manifest, report)
        emit("check", operation=method, **check)
    emit("complete", manifest=str(manifest), failed=failures)
    return int(failures > 0)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default may echo an accidentally supplied secret argument.
        emit("error", error="invalid_arguments", hint="请运行 --help 查看参数")
        raise SystemExit(2)


def main(argv=None):
    logging.disable(logging.CRITICAL)
    if os.name != "nt":
        os.umask(0o077)
    parser = Parser(description=__doc__)
    common = lambda p, default: (p.add_argument("--config", default=default), p.add_argument("--credentials", default=default))
    common(parser, None)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("check", "upload", "refresh"):
        sub = commands.add_parser(name)
        common(sub, argparse.SUPPRESS)
        sub.add_argument("--output", help="报告根目录；每次在其中创建独立目录")
        if name != "check":
            sub.add_argument("--link-mode", choices=("permanent", "signed"), help="默认 permanent；signed 使用限时签名")
            sub.add_argument("--expires", type=int, help="仅 signed 模式：签名有效秒数，1–604800")
            sub.add_argument("--verify", choices=("full", "sample"), default="full")
        if name == "upload":
            sub.add_argument("paths", nargs="+")
            sub.add_argument("--media-type", choices=("video", "image", "all"), default="all")
            sub.add_argument("--recursive", action="store_true")
            sub.add_argument("--dry-run", action="store_true")
            sub.add_argument("--public-read", action="store_true", help="仅 permanent 模式：新上传对象设为公共读")
        if name == "refresh":
            sub.add_argument("manifest")
    args = parser.parse_args(argv)
    try:
        if getattr(args, "expires", None) is not None and not 1 <= args.expires <= 604800:
            raise CliError("expires_must_be_1_to_604800")
        config_path = Path(args.config).expanduser() if args.config else Path(__file__).resolve().parents[1] / "config.json"
        config = load_config(config_path)
        if args.command != "check":
            args.link_mode = args.link_mode or config["link_mode"]
            if args.link_mode != "signed" and args.expires is not None:
                raise CliError("expires_requires_signed_link_mode")
            if args.link_mode == "signed" and getattr(args, "public_read", False):
                raise CliError("public_read_requires_permanent_link_mode")
        return {"check": run_check, "upload": run_upload, "refresh": run_refresh}[args.command](args, config)
    except KeyboardInterrupt:
        emit("error", error="interrupted", manifest=getattr(args, "report_manifest", None), hint="已写入的清单和断点文件保留；不要直接重复上传成功项")
        return 130
    except Exception as exc:
        emit("error", manifest=getattr(args, "report_manifest", None), **safe_error(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
