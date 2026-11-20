"""Live view and light control of the pages open in the shared opencli browser.

Every opencli session -- the AI's own, scheduled jobs -- opens its pages in a
single headless Chromium whose DevTools endpoint is 127.0.0.1:9222 by default
(see configure). This module lists those pages, serves small thumbnails, and
relays one viewer at a time: JPEG screencast frames out, a whitelisted set of
inputs in.

Nothing is stored on disk. Typed text never reaches a log line; logs carry only
operation kinds and lengths. Only page ids from the current list are accepted:
no caller-supplied address, no raw CDP passthrough.

Viewer protocol, after POST /stream and the WebSocket auth message:
  server -> {"type": "status", "state": "ready"}, then {"type": "windows", ...}
            again whenever the page list changes (checked every POLL_SECONDS)
  client -> {"type": "select", "id": ...}
  server -> {"type": "selected", "id": ..., "generation": n}, then binary
            frames: 4-byte big-endian generation + JPEG. A frame tagged with an
            older generation belongs to the previously selected page.
  client -> tap {x, y, width, height} and scroll {..., dx, dy} in frame
            pixels (optional generation for older clients); drag
            {phase: start|move|end|cancel, x, y, width, height, generation}
            in the same pixels, with the generation of the displayed frame;
            text {text}; key {key}; detail {on}; ping
            A main-frame navigation also sends selected with a new generation.
  server -> closed {id} / warn {error} / pong; error {error} + stopped at the end
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import html
import json
import logging
import math
import re
import secrets
import struct
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx
import websockets
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect


log = logging.getLogger("vscreen")

# configure() can change these three before get_routes() is called.
BASE_PATH = "/vscreen/api"
CDP_HTTP = "http://127.0.0.1:9222"
CDP_PAGE_WS = "ws://127.0.0.1:9222/devtools/page/"
ATTACH_TIMEOUT_SECONDS = 30.0
AUTH_TIMEOUT_SECONDS = 5.0
VIEWER_TIMEOUT_SECONDS = 30.0
SEND_TIMEOUT_SECONDS = 10.0
CDP_TIMEOUT_SECONDS = 10.0
QUICK_TIMEOUT_SECONDS = 3.0
TEARDOWN_TIMEOUT_SECONDS = 15.0
POLL_SECONDS = 2.0
MAX_FPS = 15
NORMAL_CAST = (960, 50)    # (max width, JPEG quality)
DETAIL_CAST = (1920, 60)   # the viewport's own width, for when the viewer zooms in
THUMB_CAST = (480, 50)
THUMB_CACHE_SECONDS = 5.0
MAX_JSON_BYTES = 16 * 1024
MAX_TEXT_CHARS = 2000
MAX_DIMENSION = 16384
MAX_PENDING_CONTROLS = 64
MAX_CDP_MESSAGE_BYTES = 32 * 1024 * 1024
HIDDEN_URL_PREFIXES = ("about:", "chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:")
TARGET_ID_RE = re.compile(r"^[0-9A-Za-z]{8,64}$")
KEYS = {
    "Enter": {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r"},
    "Backspace": {"key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8},
    "Tab": {"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9},
    "Escape": {"key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27},
}

_token = ""
_session: _Session | None = None
_order: dict[str, int] = {}
_order_next = 0
_thumbs: dict[str, tuple[float, bytes]] = {}
_thumb_lock = asyncio.Lock()


class _ProtocolError(Exception):
    pass


class _CdpError(Exception):
    pass


@dataclass
class _Peer:
    socket: WebSocket
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, payload: dict[str, Any] | bytes) -> None:
        async def write() -> None:
            async with self.lock:
                if isinstance(payload, bytes):
                    await self.socket.send_bytes(payload)
                else:
                    await self.socket.send_json(payload)

        # Includes lock wait: a stalled phone ends the session, never grows a queue.
        await asyncio.wait_for(write(), SEND_TIMEOUT_SECONDS)

    async def close(self, code: int = 1000) -> None:
        async def close_locked() -> None:
            async with self.lock:
                await self.socket.close(code=code)

        try:
            await asyncio.wait_for(close_locked(), SEND_TIMEOUT_SECONDS)
        except (Exception, asyncio.CancelledError):
            pass


class _Cdp:
    """One DevTools connection to one page: calls, plus an event callback."""

    def __init__(self, ws: Any) -> None:
        self._ws = ws
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self.on_event: Callable[[str, dict[str, Any]], None] | None = None
        self.on_close: Callable[[], None] | None = None
        self.closed = asyncio.Event()
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if not isinstance(message, dict):
                    continue
                if type(message.get("id")) is int:
                    future = self._pending.get(message["id"])
                    if future is not None and not future.done():
                        future.set_result(message)
                elif isinstance(message.get("method"), str) and self.on_event is not None:
                    params = message.get("params")
                    try:
                        self.on_event(message["method"], params if isinstance(params, dict) else {})
                    except Exception:
                        log.exception("vscreen cdp event handler failed")
        except Exception:
            pass
        finally:
            self.closed.set()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(_CdpError("cdp_closed"))
            if self.on_close is not None:
                self.on_close()

    async def call(self, method: str, params: dict[str, Any] | None = None,
                   timeout: float = CDP_TIMEOUT_SECONDS) -> dict[str, Any]:
        if self.closed.is_set():
            raise _CdpError("cdp_closed")
        self._next_id += 1
        call_id = self._next_id
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        try:
            await self._ws.send(json.dumps({"id": call_id, "method": method, "params": params or {}}))
            message = await asyncio.wait_for(future, timeout)
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as exc:
            raise _CdpError(f"{method}: {type(exc).__name__}") from None
        finally:
            self._pending.pop(call_id, None)
        error = message.get("error")
        if error is not None:
            raise _CdpError(f"{method}: {error.get('message') if isinstance(error, dict) else 'error'}")
        result = message.get("result")
        return result if isinstance(result, dict) else {}

    async def close(self) -> None:
        self.on_event = self.on_close = None
        try:
            await asyncio.wait_for(self._ws.close(), QUICK_TIMEOUT_SECONDS)
        except Exception:
            pass
        finally:
            self._reader.cancel()


@dataclass
class _Frame:
    data: bytes
    generation: int
    cdp: _Cdp | None = None   # set for screencast frames, which Chrome wants acked
    ack_id: int | None = None


@dataclass
class _Drag:
    cdp: _Cdp
    generation: int
    x: float
    y: float
    release_task: asyncio.Task[None] | None = None


@dataclass
class _Session:
    id: str
    viewer_token: str
    created: float = field(default_factory=time.monotonic)
    viewer: _Peer | None = None
    stopping: bool = False
    error: str | None = None
    ended: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    expiry: asyncio.TimerHandle | None = None
    pages: list[dict[str, str]] = field(default_factory=list)
    target_id: str | None = None
    cdp: _Cdp | None = None
    generation: int = 0
    viewport: tuple[float, float] = (0.0, 0.0)
    drag: _Drag | None = None
    detail: bool = False
    # The listed page to hand the window back to when the viewer leaves:
    # whichever was in front before the first select, or whichever later
    # pushed the watched page to the back.
    restore_id: str | None = None
    restore_known: bool = False
    controls: deque[dict[str, Any]] = field(default_factory=deque)
    controls_ready: asyncio.Event = field(default_factory=asyncio.Event)
    frame: _Frame | None = None
    frame_ready: asyncio.Event = field(default_factory=asyncio.Event)
    frame_sent_at: float = 0.0
    poke: asyncio.Event = field(default_factory=asyncio.Event)
    background: set[asyncio.Task[None]] = field(default_factory=set)
    counts: dict[str, int] = field(default_factory=dict)


def configure(token: str, base_path: str = "/vscreen/api", cdp_address: str = "127.0.0.1:9222") -> None:
    """Set the access token, the URL prefix of the API, and the browser's DevTools host:port."""
    global _token, _thumb_lock, _order_next, BASE_PATH, CDP_HTTP, CDP_PAGE_WS
    if _session is not None:
        raise RuntimeError("cannot configure during a vscreen session")
    _token = token
    BASE_PATH = base_path
    CDP_HTTP = f"http://{cdp_address}"
    CDP_PAGE_WS = f"ws://{cdp_address}/devtools/page/"
    _thumb_lock = asyncio.Lock()
    _thumbs.clear()
    _order.clear()
    _order_next = 0


def _matches(given: Any, expected: str) -> bool:
    return bool(
        isinstance(given, str) and given and expected
        and hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
    )


def _operator_authorized(request: Request) -> bool:
    auth = request.headers.get("authorization", "")
    return auth.startswith("Bearer ") and _matches(auth[7:].strip(), _token)


def _error(error: str, status: int) -> JSONResponse:
    return JSONResponse({"ok": False, "error": error}, status_code=status,
                        headers={"Cache-Control": "no-store"})


def _positive(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value > 0


# ---------------------------------------------------------------- the browser

async def _connect(target_id: str) -> _Cdp:
    try:
        ws = await websockets.connect(
            CDP_PAGE_WS + target_id, max_size=MAX_CDP_MESSAGE_BYTES, ping_interval=None,
            open_timeout=QUICK_TIMEOUT_SECONDS, compression=None, proxy=None,
        )
    except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as exc:
        raise _CdpError(f"connect: {type(exc).__name__}") from None
    return _Cdp(ws)


async def _fetch_targets() -> Any:
    async with httpx.AsyncClient(timeout=QUICK_TIMEOUT_SECONDS, trust_env=False) as client:
        response = await client.get(CDP_HTTP + "/json/list")
        response.raise_for_status()
        return response.json()


def _pages(targets: list[Any]) -> list[dict[str, str]]:
    """Real pages only, newest first, and stable: the overview never reshuffles.

    /json/list itself is sorted by last activation, which bringToFront changes,
    so order comes from when a page was first seen. Pages first seen together
    are numbered least recently active first, which approximates opening order.
    """
    global _order_next
    pages = []
    for target in targets:
        if not isinstance(target, dict) or target.get("type") != "page":
            continue
        target_id, url, title = target.get("id"), target.get("url"), target.get("title")
        if (not isinstance(target_id, str) or not TARGET_ID_RE.fullmatch(target_id)
                or not isinstance(url, str) or not url
                or url.lower().startswith(HIDDEN_URL_PREFIXES)):
            continue
        try:
            host = urlsplit(url).hostname or ""
        except ValueError:
            host = ""
        # /json/list HTML-escapes titles ("Tom &amp; Jerry"); viewers show them as plain text.
        pages.append({"id": target_id, "title": html.unescape(title)[:300] if isinstance(title, str) else "",
                      "url": url[:2048], "host": host})
    live = _ids(pages)
    for gone in [target_id for target_id in _order if target_id not in live]:
        del _order[gone]
    for page in reversed(pages):
        if page["id"] not in _order:
            _order[page["id"]] = _order_next
            _order_next += 1
    return sorted(pages, key=lambda page: -_order[page["id"]])


def _ids(pages: list[dict[str, str]]) -> set[str]:
    return {page["id"] for page in pages}


async def _list_pages() -> list[dict[str, str]]:
    try:
        targets = await _fetch_targets()
    except (httpx.HTTPError, ValueError) as exc:
        raise _CdpError(f"list: {type(exc).__name__}") from None
    return _pages(targets if isinstance(targets, list) else [])


async def _capture(cdp: _Cdp, width: int, quality: int) -> tuple[bytes, tuple[float, float]]:
    """JPEG of the part of the page on screen, at most `width` pixels wide."""
    view = (await cdp.call("Page.getLayoutMetrics", timeout=QUICK_TIMEOUT_SECONDS)).get("cssVisualViewport")
    if not isinstance(view, dict):
        raise _CdpError("no_viewport")
    left, top = view.get("pageX", 0), view.get("pageY", 0)
    view_width, view_height = view.get("clientWidth"), view.get("clientHeight")
    if not (_positive(view_width) and _positive(view_height)
            and type(left) in (int, float) and type(top) in (int, float)):
        raise _CdpError("no_viewport")
    # clip is in document coordinates: the scroll offset picks what is on screen.
    shot = await cdp.call("Page.captureScreenshot", {
        "format": "jpeg", "quality": quality,
        "clip": {"x": left, "y": top, "width": view_width, "height": view_height,
                 "scale": min(1.0, width / view_width)},
    })
    try:
        data = base64.b64decode(shot.get("data", ""), validate=True)
    except (TypeError, ValueError):
        raise _CdpError("bad_screenshot") from None
    if not data:
        raise _CdpError("bad_screenshot")
    return data, (float(view_width), float(view_height))


async def _visibility(cdp: _Cdp) -> Any:
    result = await cdp.call("Runtime.evaluate", {
        "expression": "document.visibilityState", "returnByValue": True,
    }, timeout=QUICK_TIMEOUT_SECONDS)
    value = result.get("result")
    return value.get("value") if isinstance(value, dict) else None


async def _front_page(pages: list[dict[str, str]], exclude: str | None = None) -> str | None:
    """The listed page its window is showing, if any.

    opencli puts every session's tab into one automation window (measured:
    opening a second session hid the first), and only the page in front
    gets clicks and typing at full speed (hidden: about 6 s instead of 1 s).
    """
    async def shown(target_id: str) -> bool:
        cdp = await _connect(target_id)
        try:
            return await _visibility(cdp) == "visible"
        finally:
            await cdp.close()

    candidates = [page["id"] for page in pages if page["id"] != exclude]
    results = await asyncio.gather(*(shown(target_id) for target_id in candidates),
                                   return_exceptions=True)
    return next((target_id for target_id, result in zip(candidates, results) if result is True), None)


async def _bring_to_front(target_id: str) -> None:
    cdp = await _connect(target_id)
    try:
        await cdp.call("Page.bringToFront", timeout=QUICK_TIMEOUT_SECONDS)
    finally:
        await cdp.close()


# ------------------------------------------------------------------- HTTP API

async def list_windows(request: Request) -> JSONResponse:
    if not _operator_authorized(request):
        return _error("unauthorized", 401)
    try:
        pages = await _list_pages()
    except _CdpError:
        return _error("browser_unavailable", 503)
    return JSONResponse({"ok": True, "windows": pages}, headers={"Cache-Control": "no-store"})


async def window_thumb(request: Request) -> Response:
    if not _operator_authorized(request):
        return _error("unauthorized", 401)
    target_id = request.path_params["target_id"]
    try:
        pages = await _list_pages()
    except _CdpError:
        return _error("browser_unavailable", 503)
    live = _ids(pages)
    if target_id not in live:
        return _error("window_not_found", 404)
    # One capture at a time; the overview asks for every page at once.
    async with _thumb_lock:
        for gone in [known for known in _thumbs if known not in live]:
            del _thumbs[gone]
        cached = _thumbs.get(target_id)
        if cached is None or time.monotonic() - cached[0] >= THUMB_CACHE_SECONDS:
            try:
                cdp = await _connect(target_id)
                try:
                    data, _ = await _capture(cdp, *THUMB_CAST)
                finally:
                    await cdp.close()
            except _CdpError:
                return _error("thumb_unavailable", 503)
            cached = _thumbs[target_id] = (time.monotonic(), data)
    return Response(cached[1], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


async def create_stream(request: Request) -> JSONResponse:
    global _session
    if not _operator_authorized(request):
        return _error("unauthorized", 401)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_JSON_BYTES:
            return _error("payload_too_large", 413)
    try:
        if json.loads(body or b"{}") != {}:
            return _error("invalid_payload", 400)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return _error("invalid_json", 400)
    if _session is not None:
        # One viewer at a time; a newly opened screen takes over.
        await _finish(_session, "replaced")
    session = _Session(secrets.token_hex(16), secrets.token_urlsafe(32))
    _session = session

    def expire() -> None:
        if _session is session and session.viewer is None:
            asyncio.create_task(_finish(session))

    session.expiry = asyncio.get_running_loop().call_later(ATTACH_TIMEOUT_SECONDS, expire)
    return JSONResponse({"ok": True, "session": {
        "id": session.id,
        "viewer_token": session.viewer_token,
        "viewer_path": f"{BASE_PATH}/stream/{session.id}/viewer",
    }}, headers={"Cache-Control": "no-store"})


async def delete_stream(request: Request) -> JSONResponse:
    if not _operator_authorized(request):
        return _error("unauthorized", 401)
    session = _session
    if session is not None and session.id == request.path_params["session_id"]:
        await _finish(session)
    return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})


async def _finish(session: _Session, error: str | None = None) -> None:
    """End a session from outside its viewer task; teardown runs in that task."""
    global _session
    if session.viewer is None:
        # Never attached: nothing in the browser to undo.
        session.stopping = True
        if session.expiry is not None:
            session.expiry.cancel()
            session.expiry = None
        session.ended.set()
        if _session is session:
            _session = None
        session.finished.set()
        return
    if not session.ended.is_set():
        session.error = session.error or error
        session.ended.set()
    try:
        await asyncio.wait_for(session.finished.wait(), TEARDOWN_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        pass


async def _teardown(session: _Session, error: str | None) -> None:
    global _session
    session.stopping = True
    session.ended.set()
    error = session.error or error
    try:
        try:
            await asyncio.wait_for(_release_browser(session), TEARDOWN_TIMEOUT_SECONDS)
        except Exception:
            pass
        peer = session.viewer
        try:
            if error:
                await peer.send({"type": "error", "error": error})
            await peer.send({"type": "stopped"})
        except Exception:
            pass
        finally:
            await peer.close(1011 if error else 1000)
    finally:
        for task in list(session.background):
            task.cancel()
        if _session is session:
            _session = None
        session.finished.set()
        log.info("vscreen session end reason=%s ops=%s", error or "ok",
                 json.dumps(session.counts, sort_keys=True))


async def _release_browser(session: _Session) -> None:
    restore_id = session.restore_id
    await _stop_cast(session)
    if restore_id is None:
        return
    try:
        if restore_id in _ids(await _list_pages()):
            await _bring_to_front(restore_id)
    except _CdpError:
        pass


# ------------------------------------------------------------- viewer socket

def _json_message(message: dict[str, Any]) -> dict[str, Any]:
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    text = message.get("text")
    if not isinstance(text, str):
        raise _ProtocolError("invalid_message")
    try:
        if len(text.encode("utf-8")) > MAX_JSON_BYTES:
            raise _ProtocolError("payload_too_large")
        payload = json.loads(text)
    except (ValueError, UnicodeError, RecursionError):
        raise _ProtocolError("invalid_json") from None
    if not isinstance(payload, dict):
        raise _ProtocolError("invalid_message")
    return payload


def _integer(payload: dict[str, Any], key: str, low: int, high: int) -> int:
    value = payload.get(key)
    if type(value) is not int or not low <= value <= high:
        raise _ProtocolError("invalid_control")
    return value


def _control(payload: dict[str, Any]) -> dict[str, Any]:
    kind = payload.get("type")
    if kind == "ping":
        return {"type": kind}
    if kind == "select":
        target_id = payload.get("id")
        if isinstance(target_id, str) and TARGET_ID_RE.fullmatch(target_id):
            return {"type": kind, "id": target_id}
    elif kind in ("tap", "scroll", "drag"):
        width = _integer(payload, "width", 1, MAX_DIMENSION)
        height = _integer(payload, "height", 1, MAX_DIMENSION)
        control = {
            "type": kind,
            "x": _integer(payload, "x", 0, width - 1),
            "y": _integer(payload, "y", 0, height - 1),
            "width": width, "height": height,
        }
        if kind == "scroll":
            control["dx"] = _integer(payload, "dx", -MAX_DIMENSION, MAX_DIMENSION)
            control["dy"] = _integer(payload, "dy", -MAX_DIMENSION, MAX_DIMENSION)
        if kind == "drag":
            phase = payload.get("phase")
            if not isinstance(phase, str) or phase not in ("start", "move", "end", "cancel"):
                raise _ProtocolError("invalid_control")
            control["phase"] = phase
        if kind == "drag" or "generation" in payload:
            control["generation"] = _integer(payload, "generation", 0, 0xFFFFFFFF)
        return control
    elif kind == "text":
        text = payload.get("text")
        if isinstance(text, str) and 0 < len(text) <= MAX_TEXT_CHARS:
            try:
                text.encode("utf-8")
            except UnicodeError:
                raise _ProtocolError("invalid_control") from None
            return {"type": kind, "text": text}
    elif kind == "key":
        key = payload.get("key")
        if isinstance(key, str) and key in KEYS:
            return {"type": kind, "key": key}
    elif kind == "detail":
        if type(payload.get("on")) is bool:
            return {"type": kind, "on": payload["on"]}
    raise _ProtocolError("invalid_control")


def _frame_scale(control: dict[str, Any], viewport: tuple[float, float]) -> tuple[float, float]:
    """CSS pixels per frame pixel.

    Headless desktop pages report offsetTop 0 and pageScaleFactor 1
    (measured), so a frame is a plainly scaled copy of the viewport.
    """
    return viewport[0] / control["width"], viewport[1] / control["height"]


def _enqueue(session: _Session, control: dict[str, Any]) -> None:
    queue = session.controls
    kind = control["type"]
    last = queue[-1] if queue else None
    if kind.startswith("_"):
        # Internal housekeeping is never refused and never queued twice.
        if control in queue:
            return
        # Release on navigation/closure before any queued input can hit a new DOM.
        if kind in ("_recast", "_gone"):
            queue.appendleft(control)
        else:
            queue.append(control)
    elif (kind == "drag" and control["phase"] == "move" and last is not None
          and last["type"] == "drag" and last["phase"] == "move"
          and (last["generation"], last["width"], last["height"])
          == (control["generation"], control["width"], control["height"])):
        # Only unsent moves collapse; press/release/cancel remain ordered barriers.
        last.update(x=control["x"], y=control["y"])
    elif (kind == "scroll" and last is not None and last["type"] == "scroll"
          and (last["width"], last["height"], last.get("generation"))
          == (control["width"], control["height"], control.get("generation"))):
        # Finger-follow scrolling sends a stream of small moves; while the page
        # is busy, unsent moves merge instead of piling up.
        last.update(
            x=control["x"], y=control["y"],
            dx=max(-MAX_DIMENSION, min(MAX_DIMENSION, last["dx"] + control["dx"])),
            dy=max(-MAX_DIMENSION, min(MAX_DIMENSION, last["dy"] + control["dy"])),
        )
    elif len(queue) >= MAX_PENDING_CONTROLS:
        raise _ProtocolError("control_backlog")
    else:
        queue.append(control)
    session.controls_ready.set()


def _offer(session: _Session, frame: _Frame) -> None:
    """Latest-wins mailbox: a frame replaced before it was sent is acked unsent."""
    previous, session.frame = session.frame, frame
    if previous is not None:
        _ack_later(session, previous)
    session.frame_ready.set()


def _ack_later(session: _Session, frame: _Frame) -> None:
    if frame.cdp is None or frame.ack_id is None:
        return
    task = asyncio.create_task(_ack(frame.cdp, frame.ack_id))
    session.background.add(task)
    task.add_done_callback(session.background.discard)


async def _ack(cdp: _Cdp, ack_id: int) -> None:
    try:
        await cdp.call("Page.screencastFrameAck", {"sessionId": ack_id}, timeout=QUICK_TIMEOUT_SECONDS)
    except _CdpError:
        pass


def _on_cdp_event(session: _Session, cdp: _Cdp, method: str, params: dict[str, Any]) -> None:
    if cdp is not session.cdp or session.stopping:
        return
    if method == "Page.screencastFrame":
        ack_id = params.get("sessionId")
        frame = _Frame(b"", session.generation, cdp, ack_id if type(ack_id) is int else None)
        metadata = params.get("metadata")
        if (isinstance(metadata, dict) and _positive(metadata.get("deviceWidth"))
                and _positive(metadata.get("deviceHeight"))):
            session.viewport = (float(metadata["deviceWidth"]), float(metadata["deviceHeight"]))
        try:
            frame.data = base64.b64decode(params.get("data", ""), validate=True)
        except (TypeError, ValueError):
            frame.data = b""
        if frame.data:
            _offer(session, frame)
        else:
            _ack_later(session, frame)
    elif method == "Page.frameNavigated":
        navigated = params.get("frame")
        if isinstance(navigated, dict) and not navigated.get("parentId"):
            # A cross-site navigation silently ends the screencast (measured).
            _enqueue(session, {"type": "_recast", "generation": session.generation})


async def _start_cast(session: _Session, cdp: _Cdp) -> None:
    width, quality = DETAIL_CAST if session.detail else NORMAL_CAST
    await cdp.call("Page.startScreencast", {
        "format": "jpeg", "quality": quality, "maxWidth": width, "maxHeight": width,
        "everyNthFrame": 1,
    })


async def _restart_cast(session: _Session) -> None:
    cdp = session.cdp
    if cdp is None:
        return
    try:
        await cdp.call("Page.stopScreencast", timeout=QUICK_TIMEOUT_SECONDS)
    except _CdpError:
        pass
    await _start_cast(session, cdp)


async def _stop_cast(session: _Session) -> None:
    await _release_drag(session)
    session.generation += 1
    cdp, session.cdp, session.target_id, session.frame = session.cdp, None, None, None
    if cdp is None:
        return
    cdp.on_event = cdp.on_close = None
    try:
        await cdp.call("Page.stopScreencast", timeout=QUICK_TIMEOUT_SECONDS)
    except _CdpError:
        pass
    finally:
        await cdp.close()


async def _refresh_pages(session: _Session) -> None:
    pages = await _list_pages()
    if pages != session.pages:
        session.pages = pages
        await session.viewer.send({"type": "windows", "windows": pages})


async def _select(session: _Session, target_id: str) -> None:
    if target_id not in _ids(session.pages):
        await _refresh_pages(session)   # it may have opened since the last poll
        if target_id not in _ids(session.pages):
            await session.viewer.send({"type": "warn", "error": "window_not_found"})
            return
    if not session.restore_known:
        session.restore_id = await _front_page(session.pages)
        session.restore_known = True
    await _stop_cast(session)
    generation = session.generation
    try:
        cdp = await _connect(target_id)
        session.cdp, session.target_id = cdp, target_id
        cdp.on_event = lambda method, params: _on_cdp_event(session, cdp, method, params)
        cdp.on_close = session.poke.set
        await cdp.call("Page.enable")
        # A page in the back gets ~0 frames and slow input (measured).
        await cdp.call("Page.bringToFront")
        first, session.viewport = await _capture(cdp, *(DETAIL_CAST if session.detail else NORMAL_CAST))
        await session.viewer.send({"type": "selected", "id": target_id, "generation": generation})
        _offer(session, _Frame(first, generation))
        await _start_cast(session, cdp)
    except _CdpError as exc:
        log.info("vscreen select %s failed: %s", target_id[:8], exc)
        await _stop_cast(session)
        await session.viewer.send({"type": "warn", "error": "window_unavailable"})
        return
    log.info("vscreen select %s", target_id[:8])


async def _check_front(session: _Session) -> None:
    cdp, target_id = session.cdp, session.target_id
    if cdp is None or await _visibility(cdp) != "hidden":
        return
    # Someone opened or switched to another tab in the automation window. Keep
    # the watched page live (our choice over letting it freeze) and remember who
    # pushed it back, so that page gets the window again when the viewer leaves.
    displaced_by = await _front_page(session.pages, exclude=target_id)
    if displaced_by is not None:
        session.restore_id = displaced_by
    await cdp.call("Page.bringToFront", timeout=QUICK_TIMEOUT_SECONDS)
    log.info("vscreen refront %s", target_id[:8])


async def _tap(cdp: _Cdp, x: float, y: float) -> None:
    for kind, buttons in (("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)):
        event: dict[str, Any] = {"type": kind, "x": x, "y": y}
        if kind != "mouseMoved":
            event.update(button="left", buttons=buttons, clickCount=1)
        await cdp.call("Input.dispatchMouseEvent", event)


async def _release_drag(session: _Session) -> None:
    drag = session.drag
    if drag is None:
        return
    if drag.release_task is None:
        async def release() -> None:
            try:
                await drag.cdp.call("Input.dispatchMouseEvent", {
                    "type": "mouseReleased", "x": drag.x, "y": drag.y,
                    "button": "left", "buttons": 0, "clickCount": 1,
                }, timeout=QUICK_TIMEOUT_SECONDS)
            except _CdpError:
                # A vanished page cannot receive input; never release on a different page.
                pass

        drag.release_task = asyncio.create_task(release())
    # Cancellation of a control must not cancel or resend its release. Teardown
    # joins the same task, including when its CDP command has not been sent yet.
    await asyncio.shield(drag.release_task)
    if session.drag is drag:
        session.drag = None


async def _drag_input(session: _Session, phase: str, x: float, y: float) -> None:
    cdp = session.cdp
    if phase == "start":
        await _release_drag(session)
        await cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y,
                                                    "buttons": 0})
        # Record before awaiting: cancellation/error may follow a delivered press.
        session.drag = _Drag(cdp, session.generation, x, y)
        await cdp.call("Input.dispatchMouseEvent", {
            "type": "mousePressed", "x": x, "y": y,
            "button": "left", "buttons": 1, "clickCount": 1,
        })
    elif session.drag is not None:
        drag = session.drag
        if drag.cdp is not cdp or drag.generation != session.generation:
            await _release_drag(session)
            return
        if phase == "cancel":
            # Cancellation drops an unfinished endpoint; release where the last
            # acknowledged move left the pointer, without moving the control.
            await _release_drag(session)
        else:
            if phase == "move" or (x, y) != (drag.x, drag.y):
                # The client throttles moves; the final endpoint may only arrive
                # in end. Controls listening to mousemove need that last segment.
                await cdp.call("Input.dispatchMouseEvent", {
                    "type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1,
                })
                drag.x, drag.y = x, y
            if phase == "end":
                await _release_drag(session)


async def _press(cdp: _Cdp, name: str) -> None:
    key = KEYS[name]
    down = dict(key, type="keyDown" if "text" in key else "rawKeyDown")
    up = {prop: value for prop, value in key.items() if prop != "text"}
    up["type"] = "keyUp"
    await cdp.call("Input.dispatchKeyEvent", down)
    await cdp.call("Input.dispatchKeyEvent", up)


async def _apply_input(session: _Session, control: dict[str, Any]) -> None:
    if "generation" in control and control["generation"] != session.generation:
        return   # A queued gesture must never reach the newly selected page.
    cdp = session.cdp
    if cdp is None:
        await session.viewer.send({"type": "warn", "error": "no_window"})
        return
    kind = control["type"]
    if kind != "drag":
        await _release_drag(session)
    if kind in ("tap", "scroll", "drag"):
        scale_x, scale_y = _frame_scale(control, session.viewport)
        x, y = round(control["x"] * scale_x, 1), round(control["y"] * scale_y, 1)
        if kind == "tap":
            await _tap(cdp, x, y)
        elif kind == "drag":
            await _drag_input(session, control["phase"], x, y)
        else:
            await cdp.call("Input.dispatchMouseEvent", {
                "type": "mouseWheel", "x": x, "y": y,
                "deltaX": round(control["dx"] * scale_x, 1), "deltaY": round(control["dy"] * scale_y, 1),
            })
    elif kind == "text":
        await cdp.call("Input.insertText", {"text": control["text"]})
        log.info("vscreen text chars=%d", len(control["text"]))
    elif kind == "key":
        await _press(cdp, control["key"])


async def _apply(session: _Session, control: dict[str, Any]) -> None:
    kind = control["type"]
    if kind == "select":
        await _select(session, control["id"])
    elif kind == "detail":
        if control["on"] != session.detail:
            session.detail = control["on"]
            await _restart_cast(session)
    elif kind == "_recast":
        if control["generation"] == session.generation:
            await _release_drag(session)
            session.generation += 1
            frame, session.frame = session.frame, None
            if frame is not None:
                _ack_later(session, frame)
            await session.viewer.send({"type": "selected", "id": session.target_id,
                                       "generation": session.generation})
            await _restart_cast(session)
    elif kind == "_gone":
        if control["id"] == session.target_id:
            await _stop_cast(session)
            await session.viewer.send({"type": "closed", "id": control["id"]})
    elif kind == "_check_front":
        await _check_front(session)
    else:
        await _apply_input(session, control)
    if not kind.startswith("_"):
        session.counts[kind] = session.counts.get(kind, 0) + 1


async def _run_controls(session: _Session) -> None:
    while not session.stopping:
        await session.controls_ready.wait()
        session.controls_ready.clear()
        while session.controls and not session.stopping:
            control = session.controls.popleft()
            try:
                await _apply(session, control)
            except _CdpError as exc:
                await _release_drag(session)
                log.info("vscreen %s failed: %s", control["type"], exc)
                if not control["type"].startswith("_"):
                    await session.viewer.send({"type": "warn", "error": "input_failed"})


async def _read_controls(session: _Session) -> None:
    peer = session.viewer
    while not session.stopping:
        message = await asyncio.wait_for(peer.socket.receive(), VIEWER_TIMEOUT_SECONDS)
        control = _control(_json_message(message))
        if control["type"] == "ping":
            await peer.send({"type": "pong"})
        else:
            _enqueue(session, control)


async def _pump_frames(session: _Session) -> None:
    gap = 1.0 / MAX_FPS
    while not session.stopping:
        await session.frame_ready.wait()
        session.frame_ready.clear()
        delay = session.frame_sent_at + gap - time.monotonic()
        if delay > 0:
            # Newer frames replace the waiting one meanwhile. The fps cap has to
            # drop frames here: Chrome keeps two in flight however late the ack
            # comes (measured).
            await asyncio.sleep(delay)
        frame, session.frame = session.frame, None
        if frame is None:
            continue
        if frame.generation == session.generation:
            await session.viewer.send(struct.pack(">I", frame.generation) + frame.data)
            session.frame_sent_at = time.monotonic()
        _ack_later(session, frame)


async def _poll(session: _Session) -> None:
    while not session.stopping:
        try:
            await asyncio.wait_for(session.poke.wait(), POLL_SECONDS)
        except asyncio.TimeoutError:
            pass
        session.poke.clear()
        try:
            await _refresh_pages(session)
        except _CdpError:
            continue   # browser restarting: keep showing the last list
        target_id = session.target_id
        if target_id is None:
            continue
        if target_id not in _ids(session.pages) or session.cdp is None or session.cdp.closed.is_set():
            _enqueue(session, {"type": "_gone", "id": target_id})
        else:
            _enqueue(session, {"type": "_check_front"})


async def _authenticate(peer: _Peer) -> str:
    await asyncio.wait_for(peer.socket.accept(), AUTH_TIMEOUT_SECONDS)
    payload = _json_message(await asyncio.wait_for(peer.socket.receive(), AUTH_TIMEOUT_SECONDS))
    token = payload.get("token")
    if payload.get("type") != "auth" or not isinstance(token, str) or not 0 < len(token) <= 1024:
        raise _ProtocolError("unauthorized")
    try:
        token.encode("utf-8")
    except UnicodeError:
        raise _ProtocolError("unauthorized") from None
    return token


async def _run_until_ended(session: _Session, *workers: Any) -> None:
    tasks = [asyncio.create_task(worker) for worker in workers]
    ended = asyncio.create_task(session.ended.wait())
    try:
        done, _ = await asyncio.wait((*tasks, ended), return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:
            if task in done:
                await task
    finally:
        for task in (*tasks, ended):
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, ended, return_exceptions=True)


async def viewer_socket(socket: WebSocket) -> None:
    peer = _Peer(socket)
    session: _Session | None = None
    attached = False
    error: str | None = None
    try:
        token = await _authenticate(peer)
        session = _session
        if (session is None or session.id != socket.path_params["session_id"]
                or not _matches(token, session.viewer_token)):
            raise _ProtocolError("unauthorized")
        if session.stopping or session.viewer is not None:
            raise _ProtocolError("vscreen_in_use")
        if time.monotonic() - session.created >= ATTACH_TIMEOUT_SECONDS:
            await _finish(session)
            raise _ProtocolError("session_expired")
        session.viewer = peer
        attached = True
        if session.expiry is not None:
            session.expiry.cancel()
            session.expiry = None
        try:
            session.pages = await _list_pages()
        except _CdpError:
            raise _ProtocolError("browser_unavailable") from None
        await peer.send({"type": "status", "state": "ready"})
        await peer.send({"type": "windows", "windows": session.pages})
        log.info("vscreen session start")
        await _run_until_ended(session, _read_controls(session), _run_controls(session),
                               _pump_frames(session), _poll(session))
    except _ProtocolError as exc:
        error = str(exc)
    except asyncio.TimeoutError:
        error = "stream_timeout"
    except WebSocketDisconnect:
        pass
    except Exception:
        error = "stream_disconnected"
    finally:
        if attached and session is not None:
            await _teardown(session, error)
        else:
            # An unauthenticated or duplicate connection must not end the owner's session.
            await peer.close(4401 if error == "unauthorized" else 4409)


def get_routes() -> list[Route | WebSocketRoute]:
    return [
        Route(BASE_PATH + "/windows", list_windows, methods=["GET"]),
        Route(BASE_PATH + "/windows/{target_id}/thumb", window_thumb, methods=["GET"]),
        Route(BASE_PATH + "/stream", create_stream, methods=["POST"]),
        Route(BASE_PATH + "/stream/{session_id}", delete_stream, methods=["DELETE"]),
        WebSocketRoute(BASE_PATH + "/stream/{session_id}/viewer", viewer_socket),
    ]
