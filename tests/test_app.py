import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import app as vscreen_app  # noqa: E402
import browser_screen  # noqa: E402


GOOD_TOKEN = "a" * 43


class SettingsTests(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(vscreen_app.settings({"VSCREEN_TOKEN": GOOD_TOKEN}), {
            "token": GOOD_TOKEN, "cdp": "127.0.0.1:9222", "port": 8790, "prefix": "/vscreen",
        })

    def test_bad_settings_stop_the_program(self):
        for env in (
            {},
            {"VSCREEN_TOKEN": "short"},
            {"VSCREEN_TOKEN": "a" * 20 + " " + "a" * 20},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_CDP": "0.0.0.0:9222"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_CDP": "192.168.1.2:9222"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_CDP": "127.0.0.1"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_CDP": "127.0.0.1:70000"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_PORT": "abc"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_PORT": "²"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_PORT": "0"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_PATH": "vscreen"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_PATH": "/vscreen/"},
            {"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_PATH": "/v screen"},
        ):
            with self.subTest(env=env), self.assertRaises(SystemExit):
                vscreen_app.settings(env)

    def test_other_good_settings(self):
        config = vscreen_app.settings({"VSCREEN_TOKEN": GOOD_TOKEN, "VSCREEN_CDP": "localhost:9333",
                                       "VSCREEN_PORT": "18790", "VSCREEN_PATH": "/ai/screen"})
        self.assertEqual((config["cdp"], config["port"], config["prefix"]),
                         ("localhost:9333", 18790, "/ai/screen"))


class AppTests(unittest.TestCase):
    def setUp(self):
        web = tempfile.TemporaryDirectory()
        self.addCleanup(web.cleanup)
        Path(web.name, "index.html").write_text("<!doctype html><title>t</title>", encoding="utf-8")
        patcher = mock.patch.object(vscreen_app, "WEB_DIR", Path(web.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(browser_screen.configure, "")
        self.client = TestClient(vscreen_app.build_app(GOOD_TOKEN, prefix="/vscreen"))

    def test_page_is_served_with_the_security_headers(self):
        response = self.client.get("/vscreen/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("<title>t</title>", response.text)
        self.assertIn("script-src 'self'", response.headers["content-security-policy"])
        self.assertIn("frame-ancestors 'none'", response.headers["content-security-policy"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["referrer-policy"], "no-referrer")

    def test_prefix_without_slash_goes_to_the_page(self):
        response = self.client.get("/vscreen", follow_redirects=False)
        self.assertEqual((response.status_code, response.headers["location"]), (308, "/vscreen/"))

    def test_api_needs_the_token_and_keeps_its_own_cache_header(self):
        response = self.client.get("/vscreen/api/windows")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["cache-control"], "no-store")
        response = self.client.get("/vscreen/api/windows", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(response.status_code, 401)

    def test_nothing_outside_the_prefix(self):
        self.assertEqual(self.client.get("/").status_code, 404)
        self.assertEqual(self.client.get("/vscreen/../app.py").status_code, 404)


if __name__ == "__main__":
    unittest.main()
