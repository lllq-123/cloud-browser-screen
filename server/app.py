"""Serve the virtual screen: the phone page in ../web plus the API in browser_screen.py.

Settings come from environment variables (the service file loads them from an
env file that only you can read):

  VSCREEN_TOKEN  required. At least 32 characters, no spaces. Make one with
                 python3 -c "import secrets; print(secrets.token_urlsafe(32))"
  VSCREEN_CDP    the browser's DevTools address, default 127.0.0.1:9222.
                 Loopback only: that port controls the whole browser.
  VSCREEN_PORT   the port to listen on, default 8790. Always on 127.0.0.1:
                 nginx, with HTTPS, sits in front.
  VSCREEN_PATH   the URL prefix, default /vscreen. The page is at /vscreen/,
                 the API under /vscreen/api.

Run:  python3 app.py
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Mapping

import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import RedirectResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

import browser_screen


HOST = "127.0.0.1"
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
TOKEN_RE = re.compile(r"[\x21-\x7e]{32,256}")   # printable ASCII, no spaces
CDP_RE = re.compile(r"(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})")
PORT_RE = re.compile(r"[0-9]{1,5}")
PATH_RE = re.compile(r"(?:/[A-Za-z0-9._~-]+)+")
SECURITY_HEADERS = (
    (b"content-security-policy",
     b"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
     b"connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"cache-control", b"no-cache"),   # the API sets its own no-store and keeps it
)


class SecurityHeaders:
    """Adds SECURITY_HEADERS to every HTTP response that does not set them itself."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {name.lower() for name, _ in headers}
                headers.extend(item for item in SECURITY_HEADERS if item[0] not in present)
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


def settings(environ: Mapping[str, str] = os.environ) -> dict[str, Any]:
    """Read and check the settings. A bad one stops the program with a message saying which."""
    token = environ.get("VSCREEN_TOKEN", "")
    if not TOKEN_RE.fullmatch(token):
        raise SystemExit(
            "VSCREEN_TOKEN 没设、太短或带了空格：要至少 32 个字符。生成一个：\n"
            "  python3 -c \"import secrets; print(secrets.token_urlsafe(32))\"")
    cdp = environ.get("VSCREEN_CDP", "127.0.0.1:9222")
    match = CDP_RE.fullmatch(cdp)
    if match is None or not 0 < int(match.group(1)) < 65536:
        raise SystemExit("VSCREEN_CDP 要写成 127.0.0.1:端口——浏览器的调试端口只能在本机")
    port = environ.get("VSCREEN_PORT", "8790")
    if not PORT_RE.fullmatch(port) or not 0 < int(port) < 65536:
        raise SystemExit("VSCREEN_PORT 要是 1 到 65535 之间的数字")
    prefix = environ.get("VSCREEN_PATH", "/vscreen")
    if not PATH_RE.fullmatch(prefix):
        raise SystemExit("VSCREEN_PATH 要以 / 开头、不以 / 结尾，比如 /vscreen")
    return {"token": token, "cdp": cdp, "port": int(port), "prefix": prefix}


def build_app(token: str, cdp: str = "127.0.0.1:9222", prefix: str = "/vscreen") -> Starlette:
    browser_screen.configure(token, base_path=prefix + "/api", cdp_address=cdp)

    async def to_page(request: Request) -> RedirectResponse:
        return RedirectResponse(prefix + "/", status_code=308)

    routes = [
        *browser_screen.get_routes(),
        Route(prefix, to_page),
        Mount(prefix, app=StaticFiles(directory=WEB_DIR, html=True)),
    ]
    return Starlette(routes=routes, middleware=[Middleware(SecurityHeaders)])


def main() -> None:
    config = settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    app = build_app(config["token"], config["cdp"], config["prefix"])
    logging.getLogger("vscreen").info("listening on http://%s:%d%s/ (browser at %s)",
                                      HOST, config["port"], config["prefix"], config["cdp"])
    uvicorn.run(app, host=HOST, port=config["port"], log_level="info", log_config=None,
                access_log=False)


if __name__ == "__main__":
    main()
