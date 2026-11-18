# 第 1 步：在服务器上装好虚拟屏幕

> 这一步做完：服务器上多一个后台服务，只在本机 `127.0.0.1:8790` 上听着。本机 `curl` 一下：不带口令回 401，带口令回 200 和一份网页列表。

这一篇全是小机做的事。可能要你的只有两处：系统缺东西的时候给一次 sudo（缺 `python3-venv`、没开 linger 才要），以及在私聊里收下口令。

## 0. 先确认浏览器在

虚拟屏幕看的是小机已经在用的那个无头浏览器，这份教程不教怎么装它。照[让小机逛小红书](https://github.com/lllq-123/cloud-browser-home-exit)第 2 篇装过的，调试端口就在 `127.0.0.1:9222`：

```bash
curl --noproxy '*' -s http://127.0.0.1:9222/json/version
```

**做完你会看到**：一段 JSON，里面有 `"Browser"`。

| 看到什么 | 说明 |
|---|---|
| 一段 JSON | 浏览器在，往下走 ✅ |
| 什么都没有 / `Connection refused` | 浏览器没开，或者调试端口不是 9222。看下面怎么找端口 |

不知道浏览器的调试端口是多少，看它是带什么参数启动的：

```bash
ps -eo args | grep -oE -- '--remote-debugging-port=[0-9]+' | sort -u
```

输出 `--remote-debugging-port=9222` 就是 9222。是别的数字的，记下来，第 3 节要用；把上面那条 `curl` 里的 9222 换成它再验一次。什么都没输出，就是浏览器没在跑，先把浏览器弄好。

调试端口**必须只听本机**（启动参数里是 `--remote-debugging-address=127.0.0.1`，或者干脆不写这个参数）。它能控制整个浏览器：读 cookie、执行脚本、打开任何网页。千万别为了「方便」把它开到外网，也别在防火墙上放行它。

核一下它真的只听本机（9222 换成你的端口）：

```bash
ss -ltn | grep ':9222 '
```

**做完你会看到**：`127.0.0.1:9222`（或者 `[::1]:9222`）。看到的是 `0.0.0.0:9222`、`*:9222`、或者服务器的公网地址，就是对外开着：先改浏览器的启动参数，把它关回本机，再往下走。

## 1. 拿代码

```bash
git clone https://github.com/lllq-123/cloud-browser-screen.git ~/cloud-browser-screen
cd ~/cloud-browser-screen
```

后面的命令都默认仓库在 `~/cloud-browser-screen`。放别的地方也行，记得把 `examples/vscreen.service` 里的路径一起改掉。

## 2. 装依赖

要 Python 3.10 或更新的版本（我们用的是 3.12）。先建一个只给它用的虚拟环境，再装依赖：

```bash
python3 --version
python3 -m venv ~/cloud-browser-screen/.venv
~/cloud-browser-screen/.venv/bin/pip install -r ~/cloud-browser-screen/server/requirements.txt
```

**做完你会看到**：最后一行是 `Successfully installed ...`，里面有 starlette、uvicorn、httpx、websockets。

第二行报错、里面提到 `ensurepip` 或者让你装 `python3-venv` 的，是系统少一个包，要问主人要一次 sudo。Ubuntu / Debian 上这样装，装完重建虚拟环境，再跑一遍上面第三行：

```bash
sudo apt-get install -y python3-venv
python3 -m venv --clear ~/cloud-browser-screen/.venv
```

版本是钉死的，因为这四个就是我们家在跑的版本。服务器上 pip 很慢的话，可以加 `-i` 换国内镜像。

## 3. 生成口令和设置文件

口令就是进虚拟屏幕的钥匙：谁拿到它，谁就能操作这个浏览器，也就能用小机登着的所有账号。所以它**不经过命令行**，由下面这段直接生成、直接写进一个只有你自己能读的文件：

```bash
mkdir -p ~/.config/vscreen
python3 - <<'PY'
import os, pathlib, secrets
path = pathlib.Path.home() / ".config/vscreen/vscreen.env"
if path.exists():
    raise SystemExit(f"{path} 已经有了，没有覆盖。要换口令，照 docs/2-nginx.md 第 5 节只换口令那一行。")
token = secrets.token_urlsafe(32)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(f"VSCREEN_TOKEN={token}\n"
            "VSCREEN_CDP=127.0.0.1:9222\n"
            "VSCREEN_PORT=8790\n"
            "VSCREEN_PATH=/vscreen\n")
print("写好了：", path)
PY
ls -l ~/.config/vscreen/vscreen.env
```

**做完你会看到**：`写好了：…`，下一行开头是 `-rw-------`（只有自己能读写）。

四项设置是什么意思，见 [examples/vscreen.env.example](../examples/vscreen.env.example)。

**浏览器调试端口不是 9222 的**，现在改（把 `9333` 换成第 0 节查到的端口）：

```bash
sed -i 's/^VSCREEN_CDP=.*/VSCREEN_CDP=127.0.0.1:9333/' ~/.config/vscreen/vscreen.env
```

**看一眼 8790 端口有没有被别的程序占着**：

```bash
ss -ltn | grep ':8790 '
```

没有输出就是空着，往下走。有输出的，换一个空着的端口（比如 8791），第 2 步贴进 nginx 的那段里，`proxy_pass` 的端口也要跟着改：

```bash
sed -i 's/^VSCREEN_PORT=.*/VSCREEN_PORT=8791/' ~/.config/vscreen/vscreen.env
```

口令怎么交给主人，第 2 步做完再说（那时才有完整的网址）。

## 4. 装成后台服务

```bash
mkdir -p ~/.config/systemd/user
cp ~/cloud-browser-screen/examples/vscreen.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vscreen.service
sleep 2
systemctl --user status vscreen.service --no-pager | head -5
```

**做完你会看到**：`Active: active (running)`。

想让它在退出 SSH 以后也接着跑，这个用户要开着 linger。先看开没开：

```bash
loginctl show-user "$USER" -p Linger
```

`Linger=yes` 就是开着的（照小红书那份做过的，已经开了），往下走。`Linger=no`、或者报 `is not logged in or lingering` 的，问主人要一次 sudo：

```bash
sudo loginctl enable-linger "$USER"
```

在某些 SSH 环境里，`systemctl --user` 会报找不到用户会话，先执行一句 `export XDG_RUNTIME_DIR=/run/user/$(id -u)` 再试。

日志看这里（只记操作的种类和次数，打过的字一个都不记）：

```bash
journalctl --user -u vscreen.service -n 30 --no-pager
```

## 5. 本机自检

带口令的那一条，口令从文件里读出来、经管道交给 curl，不显示在屏幕上，也不会出现在别人用 `ps` 看得到的命令行里：

```bash
curl --noproxy '*' -s -o /dev/null -w '不带口令：%{http_code}\n' http://127.0.0.1:8790/vscreen/api/windows
sed -n 's/^VSCREEN_TOKEN=/Authorization: Bearer /p' ~/.config/vscreen/vscreen.env \
  | curl --noproxy '*' -s -w '\n带口令：%{http_code}\n' -H @- http://127.0.0.1:8790/vscreen/api/windows
```

第 3 节换过端口的，把这里的 8790 换成你的。

**做完你会看到**：

```
不带口令：401
{"ok":true,"windows":[...]}
带口令：200
```

`windows` 里是浏览器现在开着的网页，没开就是 `[]`，都算对。

| 看到什么 | 说明 |
|---|---|
| `000` | 服务没起来。看上面的日志：设置文件哪一项不对，日志里会用中文说；端口被占了，日志里是 `address already in use` |
| 带口令也是 `401` | 读口令那句没读到。`ls -l ~/.config/vscreen/vscreen.env` 看文件在不在 |
| `503` 加 `browser_unavailable` | 服务好了，但连不上浏览器的调试端口。回第 0 节 |

---

下一步：[接到 nginx 上](2-nginx.md)。
