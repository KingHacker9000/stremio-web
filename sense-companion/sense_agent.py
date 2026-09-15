from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

VERSION = "0.2.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11471
CHUNK_SIZE = 1024 * 1024
MEDIA_EXTENSIONS = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".ts"}


def default_download_root() -> Path:
    configured = os.environ.get("SENSE_DOWNLOAD_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "Videos" / "Stremio Sense"


def default_web_root() -> Path:
    configured = os.environ.get("SENSE_WEB_ROOT")
    if configured:
        return Path(configured).expanduser()
    base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    return base / "web-ui"


def safe_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value)).strip("._")
    return cleaned[:180] or "download"


def safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(value)).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:160] or "Video"


def infer_extension(url: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in MEDIA_EXTENSIONS else ".media"


def parse_total(headers: Any, resumed_from: int) -> int | None:
    content_range = headers.get("Content-Range")
    if content_range:
        match = re.search(r"/(\d+)$", content_range)
        if match:
            return int(match.group(1))
    length = headers.get("Content-Length")
    if length and str(length).isdigit():
        return int(length) + resumed_from
    return None


class DownloadLibrary:
    def __init__(self, root: Path):
        self.root = Path(root).expanduser().resolve()
        self.state_dir = self.root / ".sense"
        self.state_file = self.state_dir / "downloads.json"
        self.lock = threading.RLock()
        self.jobs: dict[str, tuple[threading.Thread, threading.Event]] = {}
        self.items: dict[str, dict[str, Any]] = {}
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        if not self.state_file.exists():
            return
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                return
            for item in data:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                if item.get("status") == "downloading":
                    item["status"] = "paused"
                self.items[str(item["id"])] = item
        except (OSError, json.JSONDecodeError):
            self.items = {}

    def _save(self) -> None:
        payload = sorted(self.items.values(), key=lambda item: item.get("updatedAt", 0), reverse=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.state_file)

    def list(self) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(item) for item in sorted(self.items.values(), key=lambda item: item.get("updatedAt", 0), reverse=True)]

    def get(self, download_id: str) -> dict[str, Any] | None:
        with self.lock:
            item = self.items.get(safe_id(download_id))
            return dict(item) if item else None

    def enqueue(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_id = str(payload.get("id") or "")
        url = str(payload.get("url") or "")
        if not raw_id or not url:
            raise ValueError("download id and url are required")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("only http(s) media URLs are supported")

        download_id = safe_id(raw_id)
        with self.lock:
            active = self.jobs.get(download_id)
            if active and active[0].is_alive():
                return dict(self.items[download_id])

            existing = self.items.get(download_id, {})
            name = str(payload.get("name") or existing.get("name") or download_id)
            file_path = existing.get("filePath")
            if not file_path:
                candidate = self.root / f"{safe_filename(name)}{infer_extension(url)}"
                if candidate.exists():
                    candidate = self.root / f"{safe_filename(name)}-{download_id[-8:]}{candidate.suffix}"
                file_path = str(candidate)

            path = Path(file_path)
            downloaded = path.stat().st_size if path.exists() else 0
            item = {
                **existing,
                "id": download_id,
                "name": name,
                "type": payload.get("type", existing.get("type", "video")),
                "poster": payload.get("poster", existing.get("poster")),
                "contentId": payload.get("contentId", existing.get("contentId")),
                "videoId": payload.get("videoId", existing.get("videoId")),
                "sourceUrl": url,
                "filePath": file_path,
                "downloadedBytes": downloaded,
                "totalBytes": existing.get("totalBytes"),
                "status": "downloading",
                "error": None,
                "updatedAt": int(time.time() * 1000),
                "backend": "native",
                "background": True,
            }
            self.items[download_id] = item
            self._save()
            stop = threading.Event()
            thread = threading.Thread(target=self._worker, args=(download_id, stop), daemon=True, name=f"sense-{download_id[:24]}")
            self.jobs[download_id] = (thread, stop)
            thread.start()
            return dict(item)

    def pause(self, download_id: str) -> dict[str, Any]:
        download_id = safe_id(download_id)
        with self.lock:
            item = self.items.get(download_id)
            if not item:
                raise KeyError(download_id)
            job = self.jobs.get(download_id)
            if job:
                job[1].set()
            item["status"] = "paused"
            item["updatedAt"] = int(time.time() * 1000)
            self._save()
            return dict(item)

    def resume(self, download_id: str) -> dict[str, Any]:
        item = self.get(download_id)
        if not item:
            raise KeyError(download_id)
        return self.enqueue({
            "id": item["id"],
            "url": item["sourceUrl"],
            "name": item.get("name"),
            "type": item.get("type"),
            "poster": item.get("poster"),
            "contentId": item.get("contentId"),
            "videoId": item.get("videoId"),
        })

    def remove(self, download_id: str) -> None:
        download_id = safe_id(download_id)
        with self.lock:
            job = self.jobs.get(download_id)
            if job:
                job[1].set()
            item = self.items.pop(download_id, None)
            self._save()
        if item:
            try:
                Path(item["filePath"]).unlink(missing_ok=True)
            except OSError:
                pass

    def _worker(self, download_id: str, stop: threading.Event) -> None:
        item = self.get(download_id)
        if not item:
            return
        path = Path(item["filePath"])
        try:
            existing = path.stat().st_size if path.exists() else 0
            headers = {"User-Agent": f"Stremio-Sense/{VERSION}"}
            if existing:
                headers["Range"] = f"bytes={existing}-"
            response = urllib.request.urlopen(urllib.request.Request(item["sourceUrl"], headers=headers), timeout=30)
            status = getattr(response, "status", 200)
            if existing and status != HTTPStatus.PARTIAL_CONTENT:
                response.close()
                existing = 0
                path.write_bytes(b"")
                headers.pop("Range", None)
                response = urllib.request.urlopen(urllib.request.Request(item["sourceUrl"], headers=headers), timeout=30)

            total = parse_total(response.headers, existing)
            downloaded = existing
            last_save = 0.0
            with response, path.open("ab" if existing else "wb") as stream:
                while not stop.is_set():
                    chunk = response.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    stream.write(chunk)
                    downloaded += len(chunk)
                    now = time.monotonic()
                    if now - last_save >= 0.75:
                        last_save = now
                        with self.lock:
                            current = self.items.get(download_id)
                            if current:
                                current["downloadedBytes"] = downloaded
                                current["totalBytes"] = total
                                current["updatedAt"] = int(time.time() * 1000)
                                self._save()

            with self.lock:
                current = self.items.get(download_id)
                if current:
                    current["downloadedBytes"] = path.stat().st_size if path.exists() else downloaded
                    current["totalBytes"] = total or current["downloadedBytes"]
                    current["status"] = "paused" if stop.is_set() else "complete"
                    current["updatedAt"] = int(time.time() * 1000)
                    self._save()
        except Exception as exc:
            with self.lock:
                current = self.items.get(download_id)
                if current:
                    current["status"] = "paused" if stop.is_set() else "error"
                    current["error"] = None if stop.is_set() else str(exc)
                    current["updatedAt"] = int(time.time() * 1000)
                    self._save()
        finally:
            with self.lock:
                job = self.jobs.get(download_id)
                if job and job[1] is stop:
                    self.jobs.pop(download_id, None)


class SenseRequestHandler(BaseHTTPRequestHandler):
    server_version = f"StremioSense/{VERSION}"

    @property
    def library(self) -> DownloadLibrary:
        return self.server.library  # type: ignore[attr-defined]

    @property
    def web_root(self) -> Path:
        return self.server.web_root  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[sense-agent] {self.address_string()} - {fmt % args}")

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        allowed = self.server.allowed_origins  # type: ignore[attr-defined]
        return "*" in allowed or origin in allowed

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed():
            allowed = self.server.allowed_origins  # type: ignore[attr-defined]
            self.send_header("Access-Control-Allow-Origin", "*" if "*" in allowed else origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1024 * 1024:
            raise ValueError("request body too large")
        raw = self.rfile.read(length) if length else b"{}"
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON object required")
        return value

    def _segments(self) -> list[str]:
        return [urllib.parse.unquote(part) for part in urllib.parse.urlparse(self.path).path.split("/") if part]

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/" or path.startswith("/ui"):
            self._serve_ui(path)
            return
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
            return
        parts = self._segments()
        if parts == ["v1", "health"]:
            self._json(HTTPStatus.OK, {"ok": True, "name": "stremio-sense-agent", "version": VERSION, "downloadRoot": str(self.library.root), "webRoot": str(self.web_root)})
            return
        if parts == ["v1", "downloads"]:
            self._json(HTTPStatus.OK, self.library.list())
            return
        if len(parts) == 4 and parts[:2] == ["v1", "downloads"] and parts[3] == "file":
            self._serve_download(parts[2])
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
            return
        parts = self._segments()
        try:
            if parts == ["v1", "downloads"]:
                self._json(HTTPStatus.ACCEPTED, self.library.enqueue(self._read_json()))
                return
            if len(parts) == 4 and parts[:2] == ["v1", "downloads"] and parts[3] == "pause":
                self._json(HTTPStatus.OK, self.library.pause(parts[2]))
                return
            if len(parts) == 4 and parts[:2] == ["v1", "downloads"] and parts[3] == "resume":
                self._json(HTTPStatus.ACCEPTED, self.library.resume(parts[2]))
                return
        except KeyError:
            self._json(HTTPStatus.NOT_FOUND, {"error": "download not found"})
            return
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_DELETE(self) -> None:
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
            return
        parts = self._segments()
        if len(parts) == 3 and parts[:2] == ["v1", "downloads"]:
            self.library.remove(parts[2])
            self._json(HTTPStatus.OK, {"ok": True})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _serve_ui(self, request_path: str) -> None:
        if not self.web_root.exists():
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "bundled Web UI is missing"})
            return
        relative = urllib.parse.unquote(request_path)
        if relative in {"/", "/ui", "/ui/"}:
            relative = "index.html"
        else:
            relative = relative.removeprefix("/ui/")
        root = self.web_root.resolve()
        target = (root / relative).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            self._json(HTTPStatus.FORBIDDEN, {"error": "invalid path"})
            return
        if not target.is_file():
            target = root / "index.html"
        if not target.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "Web UI file not found"})
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-cache" if target.name == "index.html" else "public, max-age=31536000, immutable")
        self.end_headers()
        if self.command != "HEAD":
            with target.open("rb") as stream:
                while chunk := stream.read(CHUNK_SIZE):
                    self.wfile.write(chunk)

    def _serve_download(self, download_id: str) -> None:
        item = self.library.get(download_id)
        if not item or item.get("status") != "complete":
            self._json(HTTPStatus.NOT_FOUND, {"error": "completed download not found"})
            return
        path = Path(item["filePath"])
        if not path.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "file missing"})
            return

        size = path.stat().st_size
        start, end = 0, size - 1
        status = HTTPStatus.OK
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)$", range_header)
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                return
            start_text, end_text = match.groups()
            if start_text:
                start = int(start_text)
                end = int(end_text) if end_text else end
            elif end_text:
                length = int(end_text)
                start = max(0, size - length)
            if start >= size or start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = HTTPStatus.PARTIAL_CONTENT

        length = end - start + 1
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as stream:
            stream.seek(start)
            remaining = length
            while remaining > 0:
                chunk = stream.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def build_server(host: str, port: int, download_root: Path, web_root: Path, allowed_origins: set[str]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), SenseRequestHandler)
    server.library = DownloadLibrary(download_root)  # type: ignore[attr-defined]
    server.web_root = web_root.resolve()  # type: ignore[attr-defined]
    server.allowed_origins = allowed_origins  # type: ignore[attr-defined]
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Stremio Sense local companion")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--download-dir", type=Path, default=default_download_root())
    parser.add_argument("--web-root", type=Path, default=default_web_root())
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args()

    allowed = {
        "http://127.0.0.1:11471",
        "http://localhost:11471",
        "https://web.stremio.com",
        "http://web.stremio.com",
        *args.allow_origin,
    }
    server = build_server(args.host, args.port, args.download_dir, args.web_root, allowed)
    print(f"Stremio Sense {VERSION} listening on http://{args.host}:{args.port}")
    print(f"Web UI: http://{args.host}:{args.port}/ui/")
    print(f"Downloads: {server.library.root}")  # type: ignore[attr-defined]
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
