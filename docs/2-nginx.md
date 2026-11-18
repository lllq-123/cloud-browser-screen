# 第 2 步：接到 nginx 上，手机才进得来

> 这一步做完：在手机浏览器里打开 `https://你的域名/vscreen/`，能看到「虚拟屏幕」的进门页。

虚拟屏幕服务只听本机，手机是经 nginx 的 HTTPS 进来的。这一步要动 nginx，需要 sudo，小机会问你要。

**为什么一定要 HTTPS**：手机和服务器之间传的是口令、你打的字（包括密码）、浏览器的画面。走 HTTP 的话，这些在路上都是明文。没有域名和证书的，这份教程先不适合你（见 README「不适合」）。

## 1. 挑一个网站，找到它的配置

先问主人：手机上要用哪个域名打开。挑的时候守两条：

- **这个网站上所有的页面和脚本，都是你们信得过的人管着的。**口令会存在主人的手机浏览器里，浏览器是按网站存东西的：同一个域名下别的页面里的脚本也读得到它，放在不同的路径下也挡不住。网站上有别人能上传的网页、或者装着你们不放心的网页应用的，给虚拟屏幕单独开一个子域名（比如 `vscreen.你的域名`）。
- **这个网站只走 HTTPS。**第 4 节会验一次。

然后看 nginx 读了哪些配置文件、每个文件里有哪些域名：

```bash
sudo nginx -T 2>/dev/null | grep -n -E '^# configuration file|listen .*443|server_name'
```

**做完你会看到**：类似 `# configuration file /etc/nginx/sites-enabled/xxx:` 的一行，下面几行是这个文件里的 `listen 443 ssl` 和 `server_name 某个域名`。找到 `server_name` 是主人说的那个域名、旁边有 `listen 443` 的那一段，它在哪个文件里，要改的就是那个文件里的那个 `server { ... }`。

- 同一个文件里常常还有一个只听 80 端口、专门把人跳到 HTTPS 的 `server`，别贴到那里面去。
- 用宝塔这类面板管网站的，也可以在面板里那个网站的「配置文件」里改，道理一样（我们没用过面板）。

## 2. 先备份，再贴一段 location 进去

**先备份，而且备份要放到 nginx 不会去读的地方。**别放在原文件旁边：像 `sites-enabled/` 这种目录，nginx 会把里面的文件全读进去，备份也会被当成一个网站，`nginx -t` 就报错了（实测：报 `a duplicate default server`）。

```bash
sudo mkdir -p /root/nginx-backup
sudo cp <那个文件> /root/nginx-backup/
```

然后把 [examples/nginx-location.conf](../examples/nginx-location.conf) 里那段，贴进那个 `server { ... }` 的花括号里面，跟其它 `location` 并排，放前放后都行。小机不方便用交互式的编辑器，可以先拷一份到自己的目录里改好，再 `sudo cp` 回去。

```nginx
location ^~ /vscreen/ {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # 实时画面走 WebSocket，要把「升级」请求原样转过去
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

**`location` 后面那个 `^~` 别删。**有的站点带着「js、css、图片走缓存」的规则（宝塔面板建的站默认就有两条），按 nginx 的规矩，这种规则会抢在前面，把手机网页的 js 和 css 接走，手机上打开就是一张白页。加了 `^~`，`/vscreen/` 下面的请求就都归这一段管。我们照宝塔的那两条规则实测过：不加 `^~`，js 和 css 是 404；加了，都是 200。

第 1 步改过 `VSCREEN_PORT` 或 `VSCREEN_PATH` 的，这里的端口和路径跟着改（路径两头都带 `/`），后面几条命令里的 `/vscreen/` 也一样。

## 3. 检查、生效

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**做完你会看到**：`syntax is ok` 和 `test is successful`，reload 不出声。`reload` 不会断开正在用的连接。

`nginx -t` 报错就**别 reload**，按它说的行号改。改不对，就用备份恢复，再检查一次：

```bash
sudo cp /root/nginx-backup/<文件名> <那个文件>
sudo nginx -t
```

## 4. 从外面再验一次

把 `你的域名` 换成真的。带口令的那一条，口令从文件里读出来、经管道交给 curl，不显示在屏幕上，也不会出现在别人用 `ps` 看得到的命令行里：

```bash
curl -s -o /dev/null -w '进门页：%{http_code}\n' https://你的域名/vscreen/
curl -s -o /dev/null -w '不带口令：%{http_code}\n' https://你的域名/vscreen/api/windows
sed -n 's/^VSCREEN_TOKEN=/Authorization: Bearer /p' ~/.config/vscreen/vscreen.env \
  | curl -s -o /dev/null -w '带口令：%{http_code}\n' -H @- https://你的域名/vscreen/api/windows
curl -s -o /dev/null -w '用 HTTP 打开：%{http_code} %{redirect_url}\n' http://你的域名/vscreen/
```

**做完你会看到**：`200`、`401`、`200`。最后一行是 `301`（或者 `308`），后面跟着 `https://你的域名/vscreen/`；是 `404`、或者连不上（`000`）也行。**只有最后一行是 `200` 不行**：那说明用 HTTP 也能打开虚拟屏幕，口令会走明文。多半是你贴进去的那个 `server` 同时听着 80 端口：把这段 location 挪到只听 443 的 `server` 里，或者让 80 端口整个跳到 HTTPS，reload 以后再验一次。

| 看到什么 | 说明 |
|---|---|
| 进门页 `404` | location 贴错了 `server`（贴进了 80 端口那个），或者没 reload |
| `502` | nginx 找不到虚拟屏幕服务：服务没在跑，或者端口对不上（回第 1 步第 4、5 节） |
| 进门页 `200`，可是手机上是一张白页、或者没有样式 | `location` 后面少了 `^~`，js 和 css 被站点别的规则接走了（见第 2 节） |
| 进门页 `200`，可是手机上画面一直「连接中」 | 多半少了 `Upgrade` / `Connection` 那两行，实时画面的 WebSocket 没转过去 |

网址最后的 `/` 少打了也没关系，nginx 会自己跳到带 `/` 的地址（实测）。

## 5. 把钥匙交给主人

有两种给法，小机挑一种，**只在你们俩的私聊里发**：

- **一个链接（推荐）**：`https://你的域名/vscreen/#token=口令`。主人点开就直接进去，口令会存在主人的手机浏览器里，地址栏里 `#` 后面那段马上被抹掉。`#` 后面的东西浏览器不会发给服务器，所以也不会出现在 nginx 的日志里。
- **只发口令**：主人自己打开 `https://你的域名/vscreen/`，在进门页粘贴口令。

小机拼链接的时候，口令从文件里读，别让它出现在别的地方：

```bash
printf 'https://你的域名/vscreen/#token=%s\n' "$(sed -n 's/^VSCREEN_TOKEN=//p' ~/.config/vscreen/vscreen.env)"
```

这一句的输出就是钥匙：终端的记录、小机自己的工具记录里都会留一份，跟私聊一样当密码保管。发完之后，聊天记录里有这条链接的地方（比如群聊转发）也要留心。

哪天觉得口令可能泄露了，换一个。下面这段只换口令那一行，别的设置不动。设置文件里 `VSCREEN_TOKEN` 要正好一行；没有、或者有好几行，它会停下，不改文件：

```bash
python3 - <<'PY'
import pathlib, re, secrets
path = pathlib.Path.home() / ".config/vscreen/vscreen.env"
text = path.read_text(encoding="utf-8")
new, count = re.subn(r"(?m)^VSCREEN_TOKEN=.*$", "VSCREEN_TOKEN=" + secrets.token_urlsafe(32), text)
if count != 1:
    raise SystemExit(f"{path} 里 VSCREEN_TOKEN 要正好一行，现在是 {count} 行，没有改。")
path.write_text(new, encoding="utf-8")
print("口令换好了：", path)
PY
```

上面打印出「口令换好了」，再重启服务，旧口令立刻作废：

```bash
systemctl --user restart vscreen.service
```

然后用上面拼链接那句拼一条新链接，私聊发给主人。主人那边：先把开着虚拟屏幕的标签页都关掉，再点新链接进。

---

下一步：[在手机上用](3-phone.md)。
