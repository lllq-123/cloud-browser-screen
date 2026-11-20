import asyncio
import base64
import json
import math
import struct
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import browser_screen  # noqa: E402


BASE = browser_screen.BASE_PATH
PAGE_X = "8D3F00000000000000000000000000A1"
PAGE_Y = "8D3F00000000000000000000000000B2"
PAGE_Z = "8D3F00000000000000000000000000C3"


def _request(path, *, method="POST", token="test-token", path_params=None, body=b"{}"):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [
            (b"authorization", f"Bearer {token}".encode()),
            (b"content-type", b"application/json"),
        ],
        "path_params": path_params or {},
    }, receive)


def _body(response):
    return json.loads(response.body)


def _b64(text):
    return base64.b64encode(text.encode()).decode()


async def _until(predicate, timeout=1.0):
    async def poll():
        while True:
            value = predicate()
            if value:
                return value
            await asyncio.sleep(0.002)

    return await asyncio.wait_for(poll(), timeout)


class FakeBrowser:
    """Stands in for the shared Chromium: /json/list plus per-page connections."""

    def __init__(self):
        self.targets = []
        self.visible = set()
        self.connections = []
        self.calls = []      # (target_id, method, params)
        self.timeline = []   # ("sent", frame) / ("ack", sessionId), in order
        self.hold = {}       # method -> asyncio.Event the call waits on

    def add(self, target_id, url, title="", kind="page"):
        self.targets.append({"id": target_id, "type": kind, "url": url, "title": title})

    def remove(self, target_id):
        self.targets = [target for target in self.targets if target["id"] != target_id]

    async def fetch_targets(self):
        return [dict(target) for target in self.targets]

    async def connect(self, target_id):
        cdp = FakeCdp(self, target_id)
        self.connections.append(cdp)
        return cdp

    def live(self, target_id):
        return [cdp for cdp in self.connections
                if cdp.target_id == target_id and not cdp.closed.is_set()][-1]

    def methods(self, method, target_id=None):
        return [params for called, name, params in self.calls
                if name == method and target_id in (None, called)]

    def fronts(self):
        return [called for called, name, _ in self.calls if name == "Page.bringToFront"]

    async def wait_for_call(self, method, target_id=None, count=1):
        await _until(lambda: len(self.methods(method, target_id)) >= count)


class FakeCdp:
    def __init__(self, browser, target_id):
        self.browser = browser
        self.target_id = target_id
        self.on_event = None
        self.on_close = None
        self.closed = asyncio.Event()

    async def call(self, method, params=None, timeout=None):
        if self.closed.is_set():
            raise browser_screen._CdpError("cdp_closed")
        params = params or {}
        self.browser.calls.append((self.target_id, method, params))
        gate = self.browser.hold.get(method)
        if gate is not None:
            await gate.wait()
        if method == "Page.bringToFront":
            self.browser.visible = {self.target_id}   # one automation window
        elif method == "Page.screencastFrameAck":
            self.browser.timeline.append(("ack", params["sessionId"]))
        elif method == "Runtime.evaluate":
            state = "visible" if self.target_id in self.browser.visible else "hidden"
            return {"result": {"type": "string", "value": state}}
        elif method == "Page.getLayoutMetrics":
            return {"cssVisualViewport": {"pageX": 0, "pageY": 300,
                                          "clientWidth": 1920, "clientHeight": 897}}
        elif method == "Page.captureScreenshot":
            return {"data": _b64(f"shot:{self.target_id}")}
        return {}

    def emit(self, method, params):
        self.on_event(method, params)

    async def close(self):
        self.closed.set()


class FakeSocket:
    def __init__(self, session_id, timeline):
        self.path_params = {"session_id": session_id}
        self.incoming = asyncio.Queue()
        self.sent = []
        self.timeline = timeline
        self.closed_code = None

    def push(self, payload):
        self.incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def disconnect(self):
        self.incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})

    def frames(self):
        return [message for message in self.sent if isinstance(message, bytes)]

    async def wait_for(self, predicate):
        return await _until(lambda: next((m for m in self.sent if predicate(m)), None))

    async def accept(self):
        pass

    async def receive(self):
        return await self.incoming.get()

    async def send_json(self, payload):
        self.sent.append(payload)

    async def send_bytes(self, payload):
        self.sent.append(payload)
        self.timeline.append(("sent", payload[4:]))

    async def close(self, code=1000):
        self.closed_code = code


class BrowserScreenTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        browser_screen.configure("test-token")
        self.browser = FakeBrowser()
        self.browser.add(PAGE_X, "https://zh.wikipedia.org/wiki/%E5%8A%A0%E7%BC%AA", "加缪")
        self.browser.add(PAGE_Y, "https://www.xiaohongshu.com/notification", "通知")
        self.browser.visible = {PAGE_Y}
        for name, value in (("_fetch_targets", self.browser.fetch_targets),
                            ("_connect", self.browser.connect),
                            ("POLL_SECONDS", 3600.0)):   # polls run only when a test pokes
            patcher = mock.patch.object(browser_screen, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def asyncTearDown(self):
        if browser_screen._session is not None:
            await browser_screen._finish(browser_screen._session)
        browser_screen.configure("")

    async def open_viewer(self):
        created = await browser_screen.create_stream(_request(f"{BASE}/stream"))
        self.assertEqual(created.status_code, 200, _body(created))
        session = _body(created)["session"]
        self.assertEqual(session["viewer_path"], f"{BASE}/stream/{session['id']}/viewer")
        socket = FakeSocket(session["id"], self.browser.timeline)
        socket.push({"type": "auth", "token": session["viewer_token"]})
        task = asyncio.create_task(browser_screen.viewer_socket(socket))
        await socket.wait_for(lambda m: m == {"type": "status", "state": "ready"})
        return socket, task

    async def select(self, socket, target_id):
        before = len(self.browser.methods("Page.startScreencast"))
        socket.push({"type": "select", "id": target_id})
        await self.browser.wait_for_call("Page.startScreencast", count=before + 1)
        return [m for m in socket.sent if isinstance(m, dict) and m.get("type") == "selected"][-1]

    async def leave(self, socket, task):
        socket.disconnect()
        await asyncio.wait_for(task, 1)

    def drag(self, phase, generation, x=100, y=100):
        return {"type": "drag", "phase": phase, "generation": generation,
                "x": x, "y": y, "width": 960, "height": 448}

    async def test_window_list_keeps_only_real_pages_newest_first(self):
        self.browser.targets[:0] = [
            {"id": "0B1A000000000000000000000000000D", "type": "page", "url": "about:blank", "title": ""},
            {"id": "0C2B000000000000000000000000000D", "type": "page", "url": "chrome://newtab/",
             "title": "新标签页"},
            {"id": "0D3C000000000000000000000000000D", "type": "service_worker",
             "url": "chrome-extension://ext/background.js", "title": ""},
            {"id": "0E4D000000000000000000000000000D", "type": "page",
             "url": "chrome-extension://ext/popup.html", "title": ""},
            {"id": "0F5E000000000000000000000000000D", "type": "page",
             "url": "devtools://devtools/inspector.html", "title": ""},
            {"id": "../json/new?evil", "type": "page", "url": "https://example.com/", "title": ""},
        ]
        listed = _body(await browser_screen.list_windows(_request(f"{BASE}/windows", method="GET")))
        self.assertEqual(listed["windows"], [
            {"id": PAGE_X, "title": "加缪", "url": "https://zh.wikipedia.org/wiki/%E5%8A%A0%E7%BC%AA",
             "host": "zh.wikipedia.org"},
            {"id": PAGE_Y, "title": "通知", "url": "https://www.xiaohongshu.com/notification",
             "host": "www.xiaohongshu.com"},
        ])
        # /json/list re-sorts on every tab activation; the overview must not. A page
        # opened later goes in front.
        self.browser.targets.reverse()
        self.browser.add(PAGE_Z, "https://example.com/", "新开的")
        again = _body(await browser_screen.list_windows(_request(f"{BASE}/windows", method="GET")))
        self.assertEqual([window["id"] for window in again["windows"]], [PAGE_Z, PAGE_X, PAGE_Y])

    async def test_titles_come_back_unescaped(self):
        # Chrome's /json/list escapes titles for HTML; the list must carry the real text.
        self.browser.targets = []
        self.browser.add(PAGE_X, "https://example.com/", "Tom &amp; Jerry &quot;x&quot; &lt;b&gt; it&#39;s")
        listed = _body(await browser_screen.list_windows(_request(f"{BASE}/windows", method="GET")))
        self.assertEqual(listed["windows"][0]["title"], "Tom & Jerry \"x\" <b> it's")

    async def test_http_routes_require_the_token(self):
        for handler, path, method, params in (
            (browser_screen.list_windows, f"{BASE}/windows", "GET", {}),
            (browser_screen.window_thumb, f"{BASE}/windows/{PAGE_X}/thumb", "GET", {"target_id": PAGE_X}),
            (browser_screen.create_stream, f"{BASE}/stream", "POST", {}),
            (browser_screen.delete_stream, f"{BASE}/stream/abc", "DELETE", {"session_id": "abc"}),
        ):
            with self.subTest(path=path):
                response = await handler(_request(path, method=method, token="wrong", path_params=params))
                self.assertEqual(response.status_code, 401)
        self.assertEqual(self.browser.connections, [])
        self.assertIsNone(browser_screen._session)

    async def test_wrong_viewer_token_is_refused_without_ending_the_session(self):
        created = _body(await browser_screen.create_stream(_request(f"{BASE}/stream")))["session"]
        socket = FakeSocket(created["id"], [])
        socket.push({"type": "auth", "token": "not-the-viewer-token"})
        await asyncio.wait_for(browser_screen.viewer_socket(socket), 1)
        self.assertEqual(socket.closed_code, 4401)
        self.assertEqual(socket.sent, [])
        self.assertEqual(browser_screen._session.id, created["id"])

    async def test_unattached_session_expires(self):
        with mock.patch.object(browser_screen, "ATTACH_TIMEOUT_SECONDS", 0.05):
            await browser_screen.create_stream(_request(f"{BASE}/stream"))
            await _until(lambda: browser_screen._session is None)

    async def test_page_outside_the_list_is_refused_and_never_contacted(self):
        socket, task = await self.open_viewer()
        socket.push({"type": "ping"})
        socket.push({"type": "select", "id": PAGE_Z})
        await socket.wait_for(lambda m: m == {"type": "warn", "error": "window_not_found"})
        self.assertIn({"type": "pong"}, socket.sent)
        self.assertNotIn(PAGE_Z, [cdp.target_id for cdp in self.browser.connections])
        thumb = await browser_screen.window_thumb(_request(
            f"{BASE}/windows/{PAGE_Z}/thumb", method="GET", path_params={"target_id": PAGE_Z}))
        self.assertEqual(thumb.status_code, 404)
        await self.leave(socket, task)

    async def test_controls_outside_the_whitelist_end_the_session(self):
        for bad in (
            {"type": "eval", "expression": "document.cookie"},
            {"type": "cdp", "method": "Runtime.evaluate", "params": {}},
            {"type": "navigate", "url": "https://example.com/"},
            {"type": "key", "key": "F5"},
            {"type": "key", "key": ["Enter"]},
            {"type": "text", "text": "x" * (browser_screen.MAX_TEXT_CHARS + 1)},
            {"type": "tap", "x": 960, "y": 10, "width": 960, "height": 448},
            {"type": "scroll", "x": 1, "y": 1, "width": 960, "height": 448, "dx": 0, "dy": 0.5},
            {"type": "select", "id": "../../json/new"},
        ):
            with self.subTest(bad=bad):
                socket, task = await self.open_viewer()
                socket.push(bad)
                await asyncio.wait_for(task, 1)
                self.assertIn({"type": "error", "error": "invalid_control"}, socket.sent)
                self.assertEqual(socket.sent[-1], {"type": "stopped"})
                self.assertIsNone(browser_screen._session)
        self.assertEqual(self.browser.calls, [])

    async def test_tap_and_scroll_map_frame_pixels_onto_the_page(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        # 960×448 frame of a 1920×897 viewport
        socket.push({"type": "tap", "x": 480, "y": 224, "width": 960, "height": 448})
        socket.push({"type": "scroll", "x": 100, "y": 100, "width": 960, "height": 448, "dx": -5, "dy": 150})
        await self.browser.wait_for_call("Input.dispatchMouseEvent", count=4)
        mouse = self.browser.methods("Input.dispatchMouseEvent", PAGE_X)
        self.assertEqual([event["type"] for event in mouse],
                         ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"])
        self.assertEqual((mouse[1]["x"], mouse[1]["y"], mouse[1]["button"], mouse[1]["clickCount"]),
                         (960.0, 448.5, "left", 1))
        self.assertEqual((mouse[3]["x"], mouse[3]["y"], mouse[3]["deltaX"], mouse[3]["deltaY"]),
                         (200.0, 200.2, -10.0, 300.3))
        await self.leave(socket, task)

    async def test_scrolls_queued_behind_a_busy_page_merge_into_one(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        gate = self.browser.hold["Input.dispatchMouseEvent"] = asyncio.Event()
        move = {"type": "scroll", "x": 100, "y": 100, "width": 960, "height": 448, "dx": 0}
        socket.push({**move, "dy": 10})
        await self.browser.wait_for_call("Input.dispatchMouseEvent")   # stuck in a busy page
        for dy in (20, 30, 40):
            socket.push({**move, "dy": dy})
        await _until(lambda: browser_screen._session.controls
                     and browser_screen._session.controls[0]["dy"] == 90)
        gate.set()
        await self.browser.wait_for_call("Input.dispatchMouseEvent", count=2)
        self.assertEqual([wheel["deltaY"] for wheel in self.browser.methods("Input.dispatchMouseEvent")],
                         [20.0, 180.2])
        await self.leave(socket, task)

    async def test_drag_validates_phase_generation_and_frame_coordinates(self):
        valid = self.drag("start", 1)
        for change in ({"phase": "hover"}, {"phase": []}, {"generation": None},
                       {"generation": True}, {"generation": -1}, {"generation": 2**32},
                       {"x": 960}, {"y": -1}, {"width": 0}, {"height": 448.5}):
            with self.subTest(change=change):
                with self.assertRaises(browser_screen._ProtocolError):
                    browser_screen._control({**valid, **change})
        no_generation = dict(valid)
        del no_generation["generation"]
        with self.assertRaises(browser_screen._ProtocolError):
            browser_screen._control(no_generation)
        self.assertEqual(browser_screen._control({**valid, "method": "Runtime.evaluate",
                                                 "button": "right"}), valid)

    async def test_drag_press_move_and_release_follow_frame_coordinates(self):
        socket, task = await self.open_viewer()
        selected = await self.select(socket, PAGE_X)
        generation = selected["generation"]
        socket.push(self.drag("start", generation, 100, 100))
        socket.push(self.drag("move", generation, 240, 200))
        socket.push(self.drag("end", generation, 480, 224))
        await self.browser.wait_for_call("Input.dispatchMouseEvent", count=5)
        mouse = self.browser.methods("Input.dispatchMouseEvent", PAGE_X)
        self.assertEqual([(m["type"], m["x"], m["y"], m["buttons"]) for m in mouse], [
            ("mouseMoved", 200.0, 200.2, 0), ("mousePressed", 200.0, 200.2, 1),
            ("mouseMoved", 480.0, 400.4, 1), ("mouseMoved", 960.0, 448.5, 1),
            ("mouseReleased", 960.0, 448.5, 0),
        ])
        self.assertIsNone(browser_screen._session.drag)
        await self.leave(socket, task)
        self.assertEqual(len(self.browser.methods("Input.dispatchMouseEvent")), 5)

    async def test_drag_end_without_a_move_delivers_only_a_changed_endpoint(self):
        for end_x in (100, 240):
            with self.subTest(end_x=end_x):
                socket, task = await self.open_viewer()
                generation = (await self.select(socket, PAGE_X))["generation"]
                before = len(self.browser.methods("Input.dispatchMouseEvent"))
                socket.push(self.drag("start", generation))
                socket.push(self.drag("end", generation, x=end_x))
                expected = [("mouseMoved", 200.0, 0), ("mousePressed", 200.0, 1)]
                if end_x != 100:
                    expected.append(("mouseMoved", 480.0, 1))
                expected.append(("mouseReleased", end_x * 2.0, 0))
                await self.browser.wait_for_call("Input.dispatchMouseEvent", count=before + len(expected))
                mouse = self.browser.methods("Input.dispatchMouseEvent")[before:]
                self.assertEqual([(m["type"], m["x"], m["buttons"]) for m in mouse], expected)
                await self.leave(socket, task)

    async def test_busy_drag_moves_merge_without_losing_end_or_cancel(self):
        socket, task = await self.open_viewer()
        generation = (await self.select(socket, PAGE_X))["generation"]
        gate = self.browser.hold["Input.dispatchMouseEvent"] = asyncio.Event()
        socket.push(self.drag("start", generation))
        await self.browser.wait_for_call("Input.dispatchMouseEvent")
        for x in (110, 120, 130):
            socket.push(self.drag("move", generation, x=x))
        socket.push(self.drag("cancel", generation, x=140))
        await _until(lambda: len(browser_screen._session.controls) == 2)
        self.assertEqual([(c["phase"], c["x"]) for c in browser_screen._session.controls],
                         [("move", 130), ("cancel", 140)])
        gate.set()
        await self.browser.wait_for_call("Input.dispatchMouseEvent", count=4)
        mouse = self.browser.methods("Input.dispatchMouseEvent")
        self.assertEqual([(m["type"], m["x"]) for m in mouse], [
            ("mouseMoved", 200.0), ("mousePressed", 200.0),
            ("mouseMoved", 260.0), ("mouseReleased", 260.0),
        ])
        # Unmatched tail events must not turn into a new press or move.
        socket.push(self.drag("move", generation))
        socket.push(self.drag("end", generation))
        socket.push({"type": "key", "key": "Tab"})
        await self.browser.wait_for_call("Input.dispatchKeyEvent", count=2)
        self.assertEqual(len(self.browser.methods("Input.dispatchMouseEvent")), 4)
        await self.leave(socket, task)

    async def test_drag_releases_on_disconnect_select_protocol_error_and_page_closure(self):
        for reason in ("disconnect", "select", "protocol_error", "page_closed", "replace"):
            with self.subTest(reason=reason):
                socket, task = await self.open_viewer()
                generation = (await self.select(socket, PAGE_X))["generation"]
                before = len(self.browser.methods("Input.dispatchMouseEvent", PAGE_X))
                socket.push(self.drag("start", generation, 240, 200))
                await self.browser.wait_for_call("Input.dispatchMouseEvent", PAGE_X, before + 2)
                if reason == "select":
                    await self.select(socket, PAGE_Y)
                    await self.leave(socket, task)
                elif reason == "protocol_error":
                    socket.push({"type": "cdp", "method": "Runtime.evaluate"})
                    await asyncio.wait_for(task, 1)
                elif reason == "page_closed":
                    self.browser.remove(PAGE_X)
                    browser_screen._session.poke.set()
                    await socket.wait_for(lambda m: m == {"type": "closed", "id": PAGE_X})
                    await self.leave(socket, task)
                    self.browser.add(PAGE_X, "https://example.com/", "ordinary page")
                elif reason == "replace":
                    next_socket, next_task = await self.open_viewer()
                    await asyncio.wait_for(task, 1)
                    await self.leave(next_socket, next_task)
                else:
                    await self.leave(socket, task)
                events = self.browser.methods("Input.dispatchMouseEvent", PAGE_X)[before:]
                self.assertEqual([e["type"] for e in events],
                                 ["mouseMoved", "mousePressed", "mouseReleased"])
                self.assertEqual((events[-1]["x"], events[-1]["y"], events[-1]["buttons"]),
                                 (480.0, 400.4, 0))
                self.assertEqual(self.browser.methods("Input.dispatchMouseEvent", PAGE_Y), [])

    async def test_stale_generations_never_deliver_input_to_a_new_page(self):
        socket, task = await self.open_viewer()
        old = (await self.select(socket, PAGE_X))["generation"]
        new = (await self.select(socket, PAGE_Y))["generation"]
        for phase in ("start", "move", "end", "cancel"):
            socket.push(self.drag(phase, old))
        socket.push({"type": "tap", "generation": old, "x": 1, "y": 1, "width": 960, "height": 448})
        socket.push({"type": "scroll", "generation": old, "x": 1, "y": 1,
                     "width": 960, "height": 448, "dx": 0, "dy": 10})
        socket.push(self.drag("start", new))
        # An old cancel must not release the current generation's drag.
        socket.push(self.drag("cancel", old))
        socket.push(self.drag("end", new, x=200))
        await self.browser.wait_for_call("Input.dispatchMouseEvent", count=4)
        self.assertEqual([e["type"] for e in self.browser.methods("Input.dispatchMouseEvent")],
                         ["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"])
        self.assertEqual(self.browser.methods("Input.dispatchMouseEvent", PAGE_X), [])
        await self.leave(socket, task)

    async def test_navigation_releases_drag_and_invalidates_queued_old_input(self):
        socket, task = await self.open_viewer()
        old = (await self.select(socket, PAGE_X))["generation"]
        await socket.wait_for(lambda m: isinstance(m, bytes))
        socket.push(self.drag("start", old))
        await self.browser.wait_for_call("Input.dispatchMouseEvent", count=2)
        cdp = self.browser.live(PAGE_X)
        # Keep an unsent cast frame in the mailbox while navigation invalidates it.
        browser_screen._session.frame = browser_screen._Frame(b"unsent-old-frame", old, cdp, 31)
        cdp.emit("Page.frameNavigated", {"frame": {"id": "main", "url": "https://example.com/"}})
        socket.push(self.drag("move", old, x=200))
        socket.push(self.drag("start", old, x=300))
        selected = await socket.wait_for(lambda m: isinstance(m, dict) and m.get("type") == "selected"
                                         and m["generation"] != old)
        await self.browser.wait_for_call("Page.startScreencast", count=2)
        await self.browser.wait_for_call("Page.screencastFrameAck")
        self.assertIn({"sessionId": 31}, self.browser.methods("Page.screencastFrameAck"))
        self.assertNotIn(struct.pack(">I", old) + b"unsent-old-frame", socket.frames())
        socket.push({"type": "key", "key": "Tab"})
        await self.browser.wait_for_call("Input.dispatchKeyEvent", count=2)
        self.assertEqual([e["type"] for e in self.browser.methods("Input.dispatchMouseEvent")],
                         ["mouseMoved", "mousePressed", "mouseReleased"])
        cdp.emit("Page.screencastFrame", {"data": _b64("after-navigation"), "sessionId": 1,
                                          "metadata": {}})
        await socket.wait_for(lambda m: m == struct.pack(">I", selected["generation"]) + b"after-navigation")
        await self.leave(socket, task)

    async def test_drag_press_failure_and_cancellation_release_on_original_connection(self):
        for failure in ("error", "disconnect"):
            with self.subTest(failure=failure):
                socket, task = await self.open_viewer()
                generation = (await self.select(socket, PAGE_X))["generation"]
                cdp = self.browser.live(PAGE_X)
                original_call = cdp.call
                pressed = asyncio.Event()

                async def interrupt_press(method, params=None, timeout=None):
                    result = await original_call(method, params, timeout)
                    if method == "Input.dispatchMouseEvent" and params["type"] == "mousePressed":
                        pressed.set()
                        if failure == "error":
                            raise browser_screen._CdpError("press acknowledgement lost")
                        await asyncio.Event().wait()
                    return result

                cdp.call = interrupt_press
                before = len(self.browser.methods("Input.dispatchMouseEvent"))
                socket.push(self.drag("start", generation))
                await asyncio.wait_for(pressed.wait(), 1)
                if failure == "error":
                    await socket.wait_for(lambda m: m == {"type": "warn", "error": "input_failed"})
                await self.leave(socket, task)
                self.assertEqual([m["type"] for m in self.browser.methods("Input.dispatchMouseEvent")[before:]],
                                 ["mouseMoved", "mousePressed", "mouseReleased"])

    async def test_failed_or_cancelled_final_move_releases_at_last_acknowledged_position(self):
        for failure in ("error", "disconnect"):
            with self.subTest(failure=failure):
                socket, task = await self.open_viewer()
                generation = (await self.select(socket, PAGE_X))["generation"]
                before = len(self.browser.methods("Input.dispatchMouseEvent"))
                socket.push(self.drag("start", generation))
                socket.push(self.drag("move", generation, x=120))
                await self.browser.wait_for_call("Input.dispatchMouseEvent", count=before + 3)
                cdp = self.browser.live(PAGE_X)
                original_call = cdp.call
                final_move = asyncio.Event()

                async def interrupt_final_move(method, params=None, timeout=None):
                    result = await original_call(method, params, timeout)
                    if (method == "Input.dispatchMouseEvent" and params["type"] == "mouseMoved"
                            and params["x"] == 400.0):
                        final_move.set()
                        if failure == "error":
                            raise browser_screen._CdpError("move acknowledgement lost")
                        await asyncio.Event().wait()
                    return result

                cdp.call = interrupt_final_move
                socket.push(self.drag("end", generation, x=200))
                await asyncio.wait_for(final_move.wait(), 1)
                if failure == "error":
                    await socket.wait_for(lambda m: m == {"type": "warn", "error": "input_failed"})
                await self.leave(socket, task)
                mouse = self.browser.methods("Input.dispatchMouseEvent")[before:]
                self.assertEqual([(m["type"], m["x"], m["buttons"]) for m in mouse], [
                    ("mouseMoved", 200.0, 0), ("mousePressed", 200.0, 1),
                    ("mouseMoved", 240.0, 1), ("mouseMoved", 400.0, 1),
                    ("mouseReleased", 240.0, 0),
                ])

    async def test_disconnect_joins_release_before_dispatch_or_while_ack_is_pending(self):
        for held_at in ("before_dispatch", "after_dispatch"):
            with self.subTest(held_at=held_at):
                socket, task = await self.open_viewer()
                generation = (await self.select(socket, PAGE_X))["generation"]
                session = browser_screen._session
                cdp = self.browser.live(PAGE_X)
                original_call = cdp.call
                release_started, gate = asyncio.Event(), asyncio.Event()
                attempts = []

                async def held_release(method, params=None, timeout=None):
                    if method != "Input.dispatchMouseEvent" or params["type"] != "mouseReleased":
                        return await original_call(method, params, timeout)
                    attempts.append(params)
                    if held_at == "before_dispatch":
                        release_started.set()
                        await gate.wait()
                    result = await original_call(method, params, timeout)
                    if held_at == "after_dispatch":
                        release_started.set()
                        await gate.wait()
                    return result

                cdp.call = held_release
                before = len(self.browser.methods("Input.dispatchMouseEvent"))
                socket.push(self.drag("start", generation))
                socket.push(self.drag("cancel", generation, x=200))
                await asyncio.wait_for(release_started.wait(), 1)
                socket.disconnect()
                await _until(lambda: session.stopping)
                try:
                    self.assertEqual(len(attempts), 1)
                    self.assertFalse(session.drag.release_task.cancelled())
                    released = [m for m in self.browser.methods("Input.dispatchMouseEvent")[before:]
                                if m["type"] == "mouseReleased"]
                    self.assertEqual(len(released), int(held_at == "after_dispatch"))
                finally:
                    gate.set()
                    await asyncio.wait_for(task, 1)
                mouse = self.browser.methods("Input.dispatchMouseEvent")[before:]
                self.assertEqual([m["type"] for m in mouse],
                                 ["mouseMoved", "mousePressed", "mouseReleased"])
                self.assertEqual((mouse[-1]["x"], mouse[-1]["buttons"]), (200.0, 0))
                self.assertIsNone(session.drag)
                self.assertEqual(len(attempts), 1)

    async def test_concurrent_release_waiters_share_one_command_after_cancellation(self):
        cdp = await self.browser.connect(PAGE_X)
        session = browser_screen._Session("test-session", "test-token")
        session.drag = browser_screen._Drag(cdp, 1, 240.0, 200.2)
        original_call = cdp.call
        release_started, gate = asyncio.Event(), asyncio.Event()
        attempts = []

        async def held_release(method, params=None, timeout=None):
            attempts.append(params)
            release_started.set()
            await gate.wait()
            return await original_call(method, params, timeout)

        cdp.call = held_release
        first = asyncio.create_task(browser_screen._release_drag(session))
        await asyncio.wait_for(release_started.wait(), 1)
        second = asyncio.create_task(browser_screen._release_drag(session))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        teardown = asyncio.create_task(browser_screen._release_drag(session))
        await asyncio.sleep(0)
        try:
            self.assertEqual(len(attempts), 1)
            self.assertIsNotNone(session.drag)
        finally:
            gate.set()
            await asyncio.wait_for(asyncio.gather(second, teardown), 1)
            await cdp.close()
        self.assertEqual(self.browser.methods("Input.dispatchMouseEvent"), [{
            "type": "mouseReleased", "x": 240.0, "y": 200.2,
            "button": "left", "buttons": 0, "clickCount": 1,
        }])
        self.assertIsNone(session.drag)

    async def test_only_the_newest_frame_is_sent_and_each_frame_is_acked_after_delivery(self):
        socket, task = await self.open_viewer()
        selected = await self.select(socket, PAGE_X)
        prefix = struct.pack(">I", selected["generation"])
        first = await socket.wait_for(lambda m: isinstance(m, bytes))
        self.assertEqual(first, prefix + f"shot:{PAGE_X}".encode())
        cdp = self.browser.live(PAGE_X)
        for n in range(1, 31):
            cdp.emit("Page.screencastFrame", {"data": _b64(f"frame-{n}"), "sessionId": n,
                                              "metadata": {"deviceWidth": 1920, "deviceHeight": 897}})
        await socket.wait_for(lambda m: m == prefix + b"frame-30")
        await self.browser.wait_for_call("Page.screencastFrameAck", count=30)
        self.assertEqual(len(socket.frames()), 2)   # the first shot, then only the newest
        timeline = self.browser.timeline
        self.assertLess(timeline.index(("sent", b"frame-30")), timeline.index(("ack", 30)))
        await self.leave(socket, task)

    async def test_frame_rate_stays_under_the_cap(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        await socket.wait_for(lambda m: isinstance(m, bytes))
        cdp = self.browser.live(PAGE_X)
        start, emitted = time.monotonic(), 0
        while time.monotonic() - start < 0.6:
            emitted += 1
            cdp.emit("Page.screencastFrame", {"data": _b64(f"f{emitted}"), "sessionId": emitted,
                                              "metadata": {}})
            await asyncio.sleep(0.005)
        await asyncio.sleep(0.1)
        elapsed = time.monotonic() - start
        sent = len(socket.frames()) - 1
        self.assertGreater(emitted, 30)
        self.assertGreaterEqual(sent, 2)
        self.assertLessEqual(sent, math.ceil(elapsed * browser_screen.MAX_FPS) + 1)
        await self.leave(socket, task)

    async def test_typed_text_never_reaches_the_log(self):
        secret = "hunter2-我的密码"
        with self.assertLogs("vscreen", "INFO") as logs:
            socket, task = await self.open_viewer()
            await self.select(socket, PAGE_X)
            socket.push({"type": "text", "text": secret})
            socket.push({"type": "key", "key": "Enter"})
            await self.browser.wait_for_call("Input.dispatchKeyEvent", count=2)
            await self.leave(socket, task)
        self.assertEqual(self.browser.methods("Input.insertText"), [{"text": secret}])
        keys = self.browser.methods("Input.dispatchKeyEvent")
        self.assertEqual([(key["type"], key["key"], key.get("text")) for key in keys],
                         [("keyDown", "Enter", "\r"), ("keyUp", "Enter", None)])
        output = "\n".join(logs.output)
        for fragment in (secret, "hunter2", "密码"):
            self.assertNotIn(fragment, output)
        self.assertIn(f"chars={len(secret)}", output)

    async def test_closed_page_is_reported_and_no_longer_watched(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        self.browser.remove(PAGE_X)
        browser_screen._session.poke.set()
        await socket.wait_for(lambda m: m == {"type": "closed", "id": PAGE_X})
        await socket.wait_for(lambda m: isinstance(m, dict) and m.get("type") == "windows"
                              and [window["id"] for window in m["windows"]] == [PAGE_Y])
        self.assertIsNone(browser_screen._session.target_id)
        self.assertTrue(all(cdp.closed.is_set() for cdp in self.browser.connections))
        await self.leave(socket, task)

    async def test_new_stream_replaces_the_old_viewer(self):
        old_socket, old_task = await self.open_viewer()
        await self.select(old_socket, PAGE_X)
        new_socket, new_task = await self.open_viewer()
        await asyncio.wait_for(old_task, 1)
        self.assertIn({"type": "error", "error": "replaced"}, old_socket.sent)
        self.assertEqual(old_socket.sent[-1], {"type": "stopped"})
        self.assertEqual(old_socket.closed_code, 1011)
        await self.select(new_socket, PAGE_Y)
        await self.leave(new_socket, new_task)
        self.assertEqual(new_socket.closed_code, 1000)

    async def test_leaving_hands_the_window_back(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        self.assertEqual(self.browser.visible, {PAGE_X})
        await self.leave(socket, task)
        self.assertEqual(self.browser.fronts(), [PAGE_X, PAGE_Y])
        self.assertEqual(self.browser.visible, {PAGE_Y})

    async def test_watched_page_pushed_back_is_pulled_forward_and_the_newcomer_gets_the_window_after(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        self.browser.add(PAGE_Z, "https://example.com/", "新开的")
        self.browser.visible = {PAGE_Z}   # opencli opened a page and it took the window
        browser_screen._session.poke.set()
        await _until(lambda: self.browser.visible == {PAGE_X})
        await self.leave(socket, task)
        self.assertEqual(self.browser.fronts(), [PAGE_X, PAGE_X, PAGE_Z])

    async def test_main_frame_navigation_and_detail_restart_the_screencast(self):
        socket, task = await self.open_viewer()
        await self.select(socket, PAGE_X)
        cdp = self.browser.live(PAGE_X)
        cdp.emit("Page.frameNavigated", {"frame": {"id": "child", "parentId": "main"}})
        cdp.emit("Page.frameNavigated", {"frame": {"id": "main", "url": "https://zh.wikipedia.org/"}})
        await self.browser.wait_for_call("Page.startScreencast", count=2)
        socket.push({"type": "detail", "on": True})
        await self.browser.wait_for_call("Page.startScreencast", count=3)
        casts = [name for _, name, _ in self.browser.calls if name.endswith("Screencast")]
        self.assertEqual(casts, ["Page.startScreencast", "Page.stopScreencast", "Page.startScreencast",
                                 "Page.stopScreencast", "Page.startScreencast"])
        starts = self.browser.methods("Page.startScreencast")
        self.assertEqual([(start["maxWidth"], start["quality"]) for start in starts],
                         [(960, 50), (960, 50), (1920, 60)])
        await self.leave(socket, task)

    async def test_thumbnails_are_cached_and_taken_one_at_a_time(self):
        def request():
            return _request(f"{BASE}/windows/{PAGE_Y}/thumb", method="GET", path_params={"target_id": PAGE_Y})

        gate = self.browser.hold["Page.captureScreenshot"] = asyncio.Event()
        first = asyncio.create_task(browser_screen.window_thumb(request()))
        second = asyncio.create_task(browser_screen.window_thumb(request()))
        await self.browser.wait_for_call("Page.captureScreenshot")
        await asyncio.sleep(0.02)
        self.assertEqual(len(self.browser.methods("Page.captureScreenshot")), 1)
        gate.set()
        a, b = await asyncio.gather(first, second)
        self.assertEqual((a.status_code, a.media_type, a.body), (200, "image/jpeg", f"shot:{PAGE_Y}".encode()))
        self.assertEqual(b.body, a.body)
        shots = self.browser.methods("Page.captureScreenshot")
        self.assertEqual(len(shots), 1)
        # what is on screen of a page scrolled down 300 px, at a quarter size
        self.assertEqual(shots[0]["clip"], {"x": 0, "y": 300, "width": 1920, "height": 897, "scale": 0.25})
        self.assertTrue(all(cdp.closed.is_set() for cdp in self.browser.connections))

    async def test_configure_moves_the_api_and_the_browser_address(self):
        browser_screen.configure("test-token", base_path="/screen/api", cdp_address="127.0.0.1:9333")
        self.assertEqual(browser_screen.CDP_HTTP, "http://127.0.0.1:9333")
        self.assertEqual(browser_screen.CDP_PAGE_WS, "ws://127.0.0.1:9333/devtools/page/")
        self.assertEqual([route.path for route in browser_screen.get_routes()], [
            "/screen/api/windows", "/screen/api/windows/{target_id}/thumb", "/screen/api/stream",
            "/screen/api/stream/{session_id}", "/screen/api/stream/{session_id}/viewer",
        ])
        created = _body(await browser_screen.create_stream(_request("/screen/api/stream")))["session"]
        self.assertEqual(created["viewer_path"], f"/screen/api/stream/{created['id']}/viewer")


if __name__ == "__main__":
    unittest.main()
