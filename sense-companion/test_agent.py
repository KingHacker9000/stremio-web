from __future__ import annotations

import importlib.util
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("sense_agent.py")
spec = importlib.util.spec_from_file_location("sense_agent", MODULE_PATH)
assert spec and spec.loader
sense_agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sense_agent)

DownloadLibrary = sense_agent.DownloadLibrary
build_server = sense_agent.build_server
safe_filename = sense_agent.safe_filename
safe_id = sense_agent.safe_id

PAYLOAD = b"stremio-sense" * 100_000


class RangeSource(BaseHTTPRequestHandler):
    def log_message(self, _fmt, *_args):
        return

    def do_GET(self):
        start = 0
        range_header = self.headers.get("Range")
        if range_header:
            start = int(range_header.split("=", 1)[1].split("-", 1)[0] or 0)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        else:
            self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD) - start))
        self.end_headers()
        self.wfile.write(PAYLOAD[start:])


class FakeStremio(BaseHTTPRequestHandler):
    def log_message(self, _fmt, *_args):
        return

    def do_GET(self):
        if self.path == "/settings":
            body = json.dumps({
                "baseUrl": f"http://127.0.0.1:{self.server.server_port}",
                "values": {"cacheSize": 0},
                "options": [],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/movie":
            start = 0
            range_header = self.headers.get("Range")
            if range_header:
                start = int(range_header.split("=", 1)[1].split("-", 1)[0] or 0)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
            else:
                self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(len(PAYLOAD) - start))
            self.end_headers()
            self.wfile.write(PAYLOAD[start:])
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        body = b"POST:" + data
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def wait_for(library: DownloadLibrary, download_id: str, status: str, timeout: float = 8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        item = library.get(download_id)
        if item and item["status"] == status:
            return item
        time.sleep(0.02)
    raise AssertionError(f"download {download_id!r} did not reach {status!r}")


def test_safe_names():
    assert safe_id("Dune: Part Two / 4K") == "Dune_Part_Two_4K"
    assert safe_filename('Dune: Part Two / 4K?') == "Dune_ Part Two _ 4K_"


def test_native_download_persists_real_file_and_metadata(tmp_path: Path):
    source = ThreadingHTTPServer(("127.0.0.1", 0), RangeSource)
    source_thread = threading.Thread(target=source.serve_forever, daemon=True)
    source_thread.start()
    try:
        library = DownloadLibrary(tmp_path)
        queued = library.enqueue({
            "id": "movie-1",
            "url": f"http://127.0.0.1:{source.server_port}/movie.mp4",
            "name": "Test Movie",
        })
        assert queued["background"] is True
        assert queued["backend"] == "native"

        done = wait_for(library, "movie-1", "complete")
        media_path = Path(done["filePath"])
        assert media_path.parent == tmp_path
        assert media_path.suffix == ".mp4"
        assert media_path.read_bytes() == PAYLOAD
        assert done["downloadedBytes"] == len(PAYLOAD)
        assert done["totalBytes"] == len(PAYLOAD)

        reloaded = DownloadLibrary(tmp_path)
        persisted = reloaded.get("movie-1")
        assert persisted is not None
        assert persisted["status"] == "complete"
        assert persisted["filePath"] == str(media_path)
    finally:
        source.shutdown()
        source.server_close()


def test_agent_serves_bundled_ui_and_health(tmp_path: Path):
    downloads = tmp_path / "downloads"
    web_root = tmp_path / "web-ui"
    web_root.mkdir()
    (web_root / "index.html").write_text("<html>Sense UI</html>", encoding="utf-8")
    (web_root / "asset.js").write_text("console.log('sense')", encoding="utf-8")

    server = build_server("127.0.0.1", 0, downloads, web_root, {"http://127.0.0.1:11471"})
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        assert b"Sense UI" in urllib.request.urlopen(f"{base}/ui/", timeout=2).read()
        assert b"console.log" in urllib.request.urlopen(f"{base}/ui/asset.js", timeout=2).read()
        health = json.loads(urllib.request.urlopen(f"{base}/v1/health", timeout=2).read())
        assert health["ok"] is True
        assert Path(health["downloadRoot"]) == downloads.resolve()
        assert health["stremioProxy"] == "/stremio/"
    finally:
        server.shutdown()
        server.server_close()


def test_same_origin_stremio_proxy_rewrites_base_url_and_streams_ranges(tmp_path: Path):
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeStremio)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()

    web_root = tmp_path / "web-ui"
    web_root.mkdir()
    (web_root / "index.html").write_text("ok", encoding="utf-8")
    server = build_server(
        "127.0.0.1",
        0,
        tmp_path / "downloads",
        web_root,
        {"*"},
        f"http://127.0.0.1:{upstream.server_port}/",
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"

    try:
        settings = json.loads(urllib.request.urlopen(base + "/stremio/settings", timeout=2).read())
        assert settings["values"]["cacheSize"] == 0
        assert settings["baseUrl"] == base + "/stremio/"

        request = urllib.request.Request(base + "/stremio/movie", headers={"Range": "bytes=10-"})
        with urllib.request.urlopen(request, timeout=2) as response:
            assert response.status == 206
            assert response.headers["Content-Range"].startswith("bytes 10-")
            assert response.read() == PAYLOAD[10:]

        request = urllib.request.Request(base + "/stremio/echo", data=b"abc", method="POST")
        assert urllib.request.urlopen(request, timeout=2).read() == b"POST:abc"
    finally:
        server.shutdown()
        server.server_close()
        upstream.shutdown()
        upstream.server_close()
