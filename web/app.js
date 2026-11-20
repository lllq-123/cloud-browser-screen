// 虚拟屏幕前端：进门（输口令）→ 列表（每个开着的网页一张卡）→ 看画面（实时画面，能点、滑、捏、打字）。
// 纯计算都在 protocol.js，这里只管页面、请求和连接。
//
// 几条规矩：
// · 服务器给的字符串（标题、网址、网站名……）一律用 textContent 放进页面。
// · 口令只放 localStorage 和 Authorization 请求头，不进网址、不打日志；打的字也不打日志。
// · 从看画面回列表就断开看屏连接（关 WebSocket + DELETE），不然服务器会一直把那个网页拉在最前面。

import {
  DETAIL_SCALE, GestureTracker, LONG_PRESS_MS, MAX_RETRIES, ScrollAccumulator, authMessage, captionOf, clampPan, cleanToken,
  containFit, countLabel, detailMessage, displayedSize, dragMessage, framePoint, friendlyError, friendlyWarn, isZoomed,
  keyMessage, landscapeMode, panView, parseServerText, parseWindows, pickFrame, pinchStart, pinchView, pingMessage,
  retryDelay, scrollMessage, selectMessage, snapView, tapMessage, textMessage, tokenFromHash, viewPoint,
  viewerSocketUrl,
} from './protocol.js';

// ── 口令 ──

const TOKEN_KEY = 'vscreen-token';
/** localStorage 用不了（比如隐私模式）时，口令只放在内存里 */
let memoryToken = '';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

function saveToken(token) {
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 存不进去就只留在内存里，关掉页面要重新输
  }
}

function clearToken() {
  memoryToken = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 本来就没存进去
  }
}

// 网址里带了 #token=…：收进本地存储，马上把 # 后面抹掉，不让口令留在地址栏和历史记录里
let bootNotice = '';
const hashToken = tokenFromHash(location.hash);
if (hashToken !== null) {
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    location.hash = '';
  }
  const token = cleanToken(hashToken);
  if (token) saveToken(token);
  else bootNotice = '口令不对';
}

// ── 接口 ──

/** 接口地址按当前页面的位置算：页面在 <前缀>/，接口就在 <前缀>/api/ */
const API_BASE = new URL('api/', document.baseURI);
const apiUrl = (path) => new URL(path, API_BASE).toString();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const LIST_POLL_MS = 2000;
const THUMB_REFRESH_MS = 6000;
/** 缩略图一轮取完，歇一会儿再看下一轮 */
const THUMB_ROUND_GAP_MS = 1000;
const FETCH_TIMEOUT_MS = 10000;
const STREAM_OPEN_TIMEOUT_MS = 20000;
const STREAM_DELETE_TIMEOUT_MS = 5000;
/** 每 10 秒 ping 一次；30 秒什么都没收到就当断了（服务器那头也是 30 秒） */
const PING_MS = 10000;
const SILENCE_LIMIT_MS = 30000;
/** 发出去还没送走的数据超过这么多，说明网络堵死了，断开重连 */
const MAX_BUFFERED_BYTES = 64 * 1024;
/** 跟手滚的消息最多每 40ms 发一次 */
const SCROLL_FLUSH_MS = 40;
/** 连续拖动只保留最新落点；起点、松手和取消立即发送。 */
const DRAG_FLUSH_MS = 40;
const CLOSED_NOTICE_MS = 1300;
const LIST_TOAST_MS = 4000;
const NOTE_MS = 3000;
/** 第一帧到之前，画面框先按 16:9 占位 */
const FALLBACK_FRAME = { w: 1280, h: 720 };

/** 带超时跑一个请求；超时或断网都会抛错 */
async function timed(ms, run) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await run(abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** 问一次网页列表。kind：ok（带 windows）/ unauthorized / unavailable / offline / bad */
async function fetchWindows(token) {
  try {
    return await timed(FETCH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(apiUrl('windows'), { headers: bearer(token), cache: 'no-store', signal });
      if (response.status === 401) return { kind: 'unauthorized' };
      if (response.status === 503) return { kind: 'unavailable' };
      if (!response.ok) return { kind: 'bad' };
      let data = null;
      try {
        data = await response.json();
      } catch {
        return { kind: 'bad' };
      }
      const list = data && data.ok ? parseWindows(data.windows) : null;
      return list ? { kind: 'ok', windows: list } : { kind: 'bad' };
    });
  } catch {
    return { kind: 'offline' };
  }
}

/** 缩略图要带口令，<img> 直接连会被拒，所以 fetch 成 Blob 再转 objectURL。取不到返回 null */
async function fetchThumb(id, token) {
  try {
    return await timed(FETCH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(apiUrl(`windows/${encodeURIComponent(id)}/thumb`), {
        headers: bearer(token), cache: 'no-store', signal,
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      return blob.size > 0 ? blob : null;
    });
  } catch {
    return null;
  }
}

// ── 三个视图 ──

const byId = (id) => document.getElementById(id);
const views = { login: byId('view-login'), list: byId('view-list'), live: byId('view-live') };
let currentView = '';

function showView(name) {
  currentView = name;
  for (const key of Object.keys(views)) views[key].hidden = key !== name;
}

// ── 前台 / 后台：切到后台就停，列表不再轮询、看画面断开连接，回来再接上 ──

let pageShown = !document.hidden;
let foreground = pageShown;
const isForeground = () => pageShown && !document.hidden;

function onForegroundChange() {
  const now = isForeground();
  if (now === foreground) return;
  foreground = now;
  if (currentView === 'list') {
    if (now) startList();
    else stopList();
  } else if (currentView === 'live') {
    if (now) resumeLive();
    else pauseLive();
  }
}

document.addEventListener('visibilitychange', () => {
  pageShown = !document.hidden;
  onForegroundChange();
});
window.addEventListener('pagehide', () => {
  pageShown = false;
  onForegroundChange();
});
window.addEventListener('pageshow', () => {
  pageShown = !document.hidden;
  onForegroundChange();
});

// ── 进门 ──

const loginForm = byId('login-form');
const loginInput = byId('login-token');
const loginButton = byId('login-go');
const loginMessage = byId('login-msg');
let loginBusy = false;

function updateLoginButton() {
  loginButton.disabled = loginBusy || !loginInput.value.trim();
}

function goLogin(message) {
  stopList();
  if (currentView === 'live') closeLive();
  showView('login');
  loginMessage.textContent = message || '';
  updateLoginButton();
}

loginInput.addEventListener('input', () => {
  loginMessage.textContent = '';
  updateLoginButton();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginBusy || !loginInput.value.trim()) return;
  const token = cleanToken(loginInput.value);
  if (!token) {
    loginMessage.textContent = '口令不对';
    return;
  }
  loginBusy = true;
  updateLoginButton();
  loginMessage.textContent = '';
  const result = await fetchWindows(token);
  loginBusy = false;
  updateLoginButton();
  if (currentView !== 'login') return;
  if (result.kind === 'unauthorized') {
    loginMessage.textContent = '口令不对';
    return;
  }
  // 503 = 口令对、只是服务器上的浏览器暂时没起来：照样进列表，列表那边会提示并接着重试
  if (result.kind !== 'ok' && result.kind !== 'unavailable') {
    loginMessage.textContent = '连不上服务器';
    return;
  }
  saveToken(token);
  loginInput.value = '';
  updateLoginButton();
  if (result.kind === 'ok') setWindows(result.windows);
  goList();
});

// ── 列表 ──

const listCount = byId('list-count');
const listStatus = byId('list-status');
const listEmpty = byId('list-empty');
const listToast = byId('list-toast');
const cardsEl = byId('cards');

/** 当前的网页列表（服务器排好的顺序，新开的在前）；null = 还没拿到过 */
let windows = null;
/** 网页编号 → 卡片上的几个元素 */
const cards = new Map();
/** 网页编号 → 缩略图 objectURL / 上次去取的时间 */
const thumbUrls = new Map();
const thumbFetchedAt = new Map();
let listRunning = false;
let listRound = 0;
let listTimer = null;
let thumbRunning = false;
let thumbRound = 0;
let thumbTimer = null;
let listToastTimer = null;

const LIST_ERRORS = {
  unavailable: '服务器上的浏览器暂时连不上，正在重试…',
  offline: '连不上服务器，正在重试…',
  bad: '列表这会儿没刷新上，正在重试…',
};

function setListStatus(text, isError) {
  listStatus.textContent = text;
  listStatus.hidden = !text;
  listStatus.classList.toggle('is-error', !!isError);
}

function goList() {
  showView('list');
  if (windows === null && listStatus.hidden) setListStatus('正在看看开着哪些网页…', false);
  renderList();
  startList();
}

/** 列表每 2 秒问一次；只在列表页、而且页面在前台时问 */
function startList() {
  if (listRunning || currentView !== 'list' || !isForeground()) return;
  listRunning = true;
  const round = ++listRound;
  void pollList(round);
  startThumbs();
}

function stopList() {
  listRunning = false;
  listRound++;
  if (listTimer !== null) clearTimeout(listTimer);
  listTimer = null;
  stopThumbs();
}

async function pollList(round) {
  const token = readToken();
  if (!token) {
    goLogin('');
    return;
  }
  const result = await fetchWindows(token);
  if (round !== listRound) return;
  if (result.kind === 'unauthorized') {
    clearToken();
    forgetList();
    goLogin('口令不对');
    return;
  }
  if (result.kind === 'ok') {
    setListStatus('', false);
    setWindows(result.windows);
  } else {
    setListStatus(LIST_ERRORS[result.kind] || LIST_ERRORS.bad, true);
  }
  listTimer = setTimeout(() => { void pollList(round); }, LIST_POLL_MS);
}

function setWindows(list) {
  windows = list;
  renderList();
  if (currentView === 'live') updateLiveTitle();
  else kickThumbs();
}

/** 按服务器给的顺序摆卡片：新的建、旧的只改文字、关掉的拿走（缩略图一起收回） */
function renderList() {
  if (windows === null) {
    listCount.textContent = '';
    listEmpty.hidden = true;
    return;
  }
  listCount.textContent = windows.length ? countLabel(windows.length) : '';
  listEmpty.hidden = windows.length > 0;
  const open = new Set(windows.map((win) => win.id));
  for (const [id, card] of [...cards]) {
    if (open.has(id)) continue;
    card.item.remove();
    cards.delete(id);
    dropThumb(id);
  }
  windows.forEach((win, index) => {
    let card = cards.get(win.id);
    if (!card) {
      card = makeCard(win.id);
      cards.set(win.id, card);
    }
    const caption = captionOf(win);
    if (card.site.textContent !== caption.site) card.site.textContent = caption.site;
    if (card.title.textContent !== caption.title) card.title.textContent = caption.title;
    const here = cardsEl.children[index];
    if (here !== card.item) cardsEl.insertBefore(card.item, here || null);
  });
}

function makeCard(id) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card';
  // 按钮里只放 span（块级样式由 CSS 给），HTML 规范不许 button 里套 div
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.hidden = true;
  // 图坏了就退回占位
  img.addEventListener('error', () => { img.hidden = true; });
  thumb.appendChild(img);
  const text = document.createElement('span');
  text.className = 'card-text';
  const site = document.createElement('span');
  site.className = 'card-site';
  const title = document.createElement('span');
  title.className = 'card-title';
  text.append(site, title);
  button.append(thumb, text);
  button.addEventListener('click', () => enterLive(id));
  item.appendChild(button);
  const url = thumbUrls.get(id);
  if (url) showThumb(img, url);
  return { item, img, site, title };
}

function showThumb(img, url) {
  img.hidden = false;
  img.src = url;
}

function setThumb(id, url) {
  const previous = thumbUrls.get(id);
  thumbUrls.set(id, url);
  const card = cards.get(id);
  if (card) showThumb(card.img, url);
  if (previous) URL.revokeObjectURL(previous);
}

function dropThumb(id) {
  const url = thumbUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbUrls.delete(id);
  thumbFetchedAt.delete(id);
}

function startThumbs() {
  if (thumbRunning) return;
  thumbRunning = true;
  const round = ++thumbRound;
  void refreshThumbs(round);
}

function stopThumbs() {
  thumbRunning = false;
  thumbRound++;
  if (thumbTimer !== null) clearTimeout(thumbTimer);
  thumbTimer = null;
}

/** 缩略图每张 6 秒换一次，一张一张取（服务器那头也是一次截一张）；只取还开着的 */
async function refreshThumbs(round) {
  for (const win of windows ? windows.slice() : []) {
    if (round !== thumbRound) return;
    if (!cards.has(win.id)) continue;
    if (Date.now() - (thumbFetchedAt.get(win.id) || 0) < THUMB_REFRESH_MS) continue;
    thumbFetchedAt.set(win.id, Date.now());
    const blob = await fetchThumb(win.id, readToken());
    if (round !== thumbRound) return;
    // 没取到（404 / 503 等）：有旧图先留着，没有就是占位，下一轮再试
    if (!blob || !cards.has(win.id)) continue;
    setThumb(win.id, URL.createObjectURL(blob));
  }
  if (round === thumbRound) {
    thumbTimer = setTimeout(() => {
      thumbTimer = null;
      void refreshThumbs(round);
    }, THUMB_ROUND_GAP_MS);
  }
}

/** 列表刚更新、缩略图正歇着：马上看一轮（新开的网页不用干等），没到 6 秒的照样不取 */
function kickThumbs() {
  if (!thumbRunning || thumbTimer === null) return;
  clearTimeout(thumbTimer);
  thumbTimer = null;
  void refreshThumbs(thumbRound);
}

/** 退出或口令失效：列表、卡片、缩略图全部清掉 */
function forgetList() {
  for (const id of [...thumbUrls.keys()]) dropThumb(id);
  for (const card of cards.values()) card.item.remove();
  cards.clear();
  thumbFetchedAt.clear();
  windows = null;
  setListStatus('', false);
  renderList();
}

function showListToast(text) {
  listToast.textContent = text;
  listToast.hidden = false;
  if (listToastTimer !== null) clearTimeout(listToastTimer);
  listToastTimer = setTimeout(() => {
    listToastTimer = null;
    listToast.hidden = true;
  }, LIST_TOAST_MS);
}

byId('logout').addEventListener('click', () => {
  clearToken();
  stopList();
  forgetList();
  goLogin('');
});

// ── 看屏连接 ──

/** 有的浏览器 createImageBitmap 不认 JPEG Blob：确认是它的问题以后就一直走 <img> 解码 */
let bitmapUsable = typeof createImageBitmap === 'function';

/** JPEG 解码成能画到 canvas 上的东西；release() 用完收回 */
async function decodeJpeg(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  let bitmapFailed = false;
  if (bitmapUsable) {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, w: bitmap.width, h: bitmap.height, release: () => { if (bitmap.close) bitmap.close(); } };
    } catch {
      bitmapFailed = true;
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // <img> 能解开、createImageBitmap 不行：以后不再试它
    if (bitmapFailed) bitmapUsable = false;
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, release: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 一条看屏连接，只看一个网页：
 * POST api/stream 拿一次性通行证 → 开 WebSocket，第一句报通行证 → 收到 ready 后选网页 → 收帧、发操作。
 */
class Viewer {
  constructor(canvas, windowId, token, hooks) {
    this.canvas = canvas;
    this.wanted = windowId;
    this.token = token;
    this.hooks = hooks;
    /** 自己收的尾 */
    this.closed = false;
    /** 连接已经坏了 */
    this.ended = false;
    this.session = null;
    this.opening = Promise.resolve();
    /** POST 发出去了，但不知道服务器开没开场次 */
    this.openUncertain = false;
    this.cleanup = null;
    this.socket = null;
    this.ready = false;
    this.keepalive = null;
    this.lastMessage = Date.now();
    this.lastError = '';
    /** 只画这一代的帧；还没选中时是 -1，什么帧都不画 */
    this.generation = -1;
    this.selectedId = null;
    /** 发了 select、第一帧还没到 */
    this.switching = null;
    this.pending = null;
    this.decoding = false;
    this.image = null;
    this.imageGeneration = -1;
    this.dragState = null;
    this.dragPending = null;
    this.dragTimer = null;
    this.reported = null;
    this.detailOn = false;
    /** 选中网页的第一帧画上去了才算接上；这之前不发点按 */
    this.live = false;
  }

  start() {
    this.opening = this.open();
  }

  /** 横竖切换以后把最后一帧补画上去 */
  repaint() {
    this.paint();
  }

  frameSize() {
    return this.image ? { w: this.image.w, h: this.image.h } : null;
  }

  tap(pt) {
    return this.live && this.send(tapMessage(pt));
  }

  scroll(pt, dy) {
    return this.live && dy !== 0 && this.send(scrollMessage(pt, 0, dy));
  }

  drag(phase, pt) {
    if (phase === 'start') {
      this.cancelDrag();
      if (!this.live || this.switching || this.selectedId !== this.wanted || this.imageGeneration !== this.generation) return false;
      this.dragState = { generation: this.imageGeneration, point: pt };
      if (this.send(dragMessage(pt, 'start', this.imageGeneration))) return true;
      this.clearDrag();
      return false;
    }
    const state = this.dragState;
    if (!state || !this.live || state.generation !== this.generation) return false;
    state.point = pt;
    if (phase === 'end') {
      this.clearDrag();
      return this.send(dragMessage(pt, 'end', state.generation));
    }
    this.dragPending = pt;
    if (this.dragTimer === null) {
      this.dragTimer = setTimeout(() => {
        this.dragTimer = null;
        const latest = this.dragPending;
        this.dragPending = null;
        if (latest && this.dragState === state && this.live && state.generation === this.generation) {
          this.send(dragMessage(latest, 'move', state.generation));
        }
      }, DRAG_FLUSH_MS);
    }
    return true;
  }

  cancelDrag() {
    const state = this.dragState;
    this.clearDrag();
    if (state) this.send(dragMessage(state.point, 'cancel', state.generation));
  }

  clearDrag() {
    if (this.dragTimer !== null) clearTimeout(this.dragTimer);
    this.dragTimer = null;
    this.dragPending = null;
    this.dragState = null;
  }

  text(value) {
    const message = textMessage(value);
    return !!message && this.live && this.send(message);
  }

  key(name) {
    const message = keyMessage(name);
    return !!message && this.live && this.send(message);
  }

  detail(on) {
    if (on !== this.detailOn && this.send(detailMessage(on))) this.detailOn = on;
  }

  fail(code) {
    if (this.closed || this.ended) return;
    // 失败后不再向拥塞通道补发取消，由关闭连接让服务器松开鼠标。
    this.clearDrag();
    this.ended = true;
    this.live = false;
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    this.hooks.failed(code);
  }

  async open() {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), STREAM_OPEN_TIMEOUT_MS);
    try {
      this.openUncertain = true;
      const response = await fetch(apiUrl('stream'), {
        method: 'POST',
        headers: { ...bearer(this.token), 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
        signal: abort.signal,
      });
      let result = null;
      try {
        result = await response.json();
      } catch {
        // 不是 JSON：下面按状态码报
      }
      const session = result && result.ok && result.session && typeof result.session === 'object' ? result.session : null;
      if (!response.ok || !session || typeof session.id !== 'string' || !session.id
        || typeof session.viewer_token !== 'string' || typeof session.viewer_path !== 'string') {
        if (response.status >= 400 && response.status < 500) this.openUncertain = false;
        const code = result && typeof result.error === 'string' ? result.error : '';
        this.fail(code || (response.status === 401 ? 'unauthorized' : 'browser_unavailable'));
        return;
      }
      this.session = session;
      this.openUncertain = false;
      // 开着的时候人已经走了：留着编号给 stop() 删，别再往下连
      if (this.closed) return;
      const url = viewerSocketUrl(location.protocol, location.host, session.viewer_path);
      if (!url) throw new Error('viewer_path');
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (this.closed) return;
        // 通行证只走通道里的第一句话，不进网址、不进本地存储
        socket.send(JSON.stringify(authMessage(session.viewer_token)));
      };
      socket.onmessage = (event) => {
        if (this.closed || this.ended) return;
        this.lastMessage = Date.now();
        if (typeof event.data === 'string') {
          const message = parseServerText(event.data);
          if (message) this.message(message);
        } else if (event.data instanceof ArrayBuffer) {
          this.binary(event.data);
        }
      };
      socket.onerror = () => this.fail(this.lastError || 'stream_disconnected');
      socket.onclose = () => this.fail(this.lastError || 'stream_disconnected');
      // 服务器 30 秒收不到东西就断；静止的网页几乎不出帧，所以靠 ping 维持
      this.lastMessage = Date.now();
      this.keepalive = setInterval(() => {
        if (Date.now() - this.lastMessage > SILENCE_LIMIT_MS) this.fail('stream_timeout');
        else this.send(pingMessage());
      }, PING_MS);
    } catch {
      this.fail('stream_disconnected');
    } finally {
      clearTimeout(timer);
    }
  }

  message(message) {
    switch (message.type) {
      case 'status': {
        if (this.ready) return;
        this.ready = true;
        const select = selectMessage(this.wanted);
        if (!select) {
          this.hooks.warn('window_not_found');
          return;
        }
        if (this.send(select)) this.switching = this.wanted;
        return;
      }
      case 'windows':
        this.hooks.windows(message.windows);
        return;
      case 'selected':
        this.cancelDrag();
        this.generation = message.generation;
        this.selectedId = message.id;
        this.live = false;
        return;
      case 'closed':
        if (message.id !== this.selectedId) return;
        this.cancelDrag();
        this.generation = -1;
        this.selectedId = null;
        this.live = false;
        this.hooks.closed(message.id);
        return;
      case 'warn':
        if (message.error === 'window_not_found' && this.switching) {
          // 要看的网页刚好关了：服务器没动原来在看的那个（如果有）
          this.switching = null;
          this.live = !!(this.selectedId && this.image && this.generation >= 0);
          if (this.selectedId) this.wanted = this.selectedId;
        } else if (message.error === 'window_unavailable') {
          // 服务器先停了原来的才去连新的，连不上 = 现在什么都没在看
          this.switching = null;
          this.generation = -1;
          this.selectedId = null;
          this.live = false;
        }
        this.hooks.warn(message.error);
        return;
      case 'error':
        this.lastError = message.error;
        this.cancelDrag();
        this.live = false;
        return;
      case 'stopped':
        this.fail(this.lastError || 'stream_disconnected');
        return;
      default:
        return;
    }
  }

  binary(buffer) {
    // generation 对不上的帧（换网页前的旧帧、selected 之前来的帧）直接丢
    const frame = pickFrame(buffer, this.generation);
    if (!frame) return;
    // 只留最新一帧：解码跟不上就跳帧，不排队
    this.pending = frame;
    if (!this.decoding) void this.drain();
  }

  async drain() {
    this.decoding = true;
    try {
      while (this.pending && !this.closed) {
        const { generation, jpeg } = this.pending;
        this.pending = null;
        let decoded;
        try {
          decoded = await decodeJpeg(jpeg);
        } catch {
          continue;   // 坏帧跳过，下一帧会补上
        }
        // 解码的工夫里换了网页或者收了尾：这帧作废
        if (this.closed || generation !== this.generation) {
          decoded.release();
          continue;
        }
        if (this.image) this.image.release();
        this.image = decoded;
        this.imageGeneration = generation;
        this.paint();
        if (!this.live && this.selectedId && (this.switching === null || this.switching === this.selectedId)) {
          this.live = true;
          this.switching = null;
          this.hooks.selected(this.selectedId);
        }
      }
    } finally {
      this.decoding = false;
    }
  }

  paint() {
    const canvas = this.canvas;
    const image = this.image;
    if (!canvas || !image) return;
    if (canvas.width !== image.w || canvas.height !== image.h) {
      canvas.width = image.w;
      canvas.height = image.h;
    }
    if (!this.reported || this.reported.w !== image.w || this.reported.h !== image.h) {
      this.reported = { w: image.w, h: image.h };
      this.hooks.frame(this.reported);
    }
    const context = canvas.getContext('2d');
    if (context) context.drawImage(image.source, 0, 0, image.w, image.h);
  }

  send(message) {
    const socket = this.socket;
    if (!message || this.closed || this.ended || !this.ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.fail('stream_disconnected');
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      this.fail('stream_disconnected');
      return false;
    }
  }

  /** 收尾：关通道 + DELETE 场次（服务器借此把浏览器窗口还给原来在最前面的网页） */
  stop() {
    if (this.cleanup) return this.cleanup;
    this.cancelDrag();
    // 取消发送失败时 failed 回调可能已经收尾，复用那一次 DELETE。
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.live = false;
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.socket) {
      const socket = this.socket;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // 已经断了
      }
      this.socket = null;
    }
    this.pending = null;
    if (this.image) this.image.release();
    this.image = null;
    this.cleanup = this.opening.then(async () => {
      if (!this.session) return !this.openUncertain;
      try {
        return await timed(STREAM_DELETE_TIMEOUT_MS, async (signal) => {
          const response = await fetch(apiUrl(`stream/${encodeURIComponent(this.session.id)}`), {
            method: 'DELETE', headers: bearer(this.token), keepalive: true, cache: 'no-store', signal,
          });
          return response.ok || response.status === 404;
        });
      } catch {
        return false;
      }
    });
    return this.cleanup;
  }
}

// ── 看画面 ──

const liveRoot = views.live;
const layer = byId('live-layer');
const liveSite = byId('live-site');
const liveTitle = byId('live-title');
const stateChips = [byId('live-state'), byId('side-state')];
const stage = byId('stage');
const frameBox = byId('frame');
const clip = byId('frame-clip');
const screenLayer = byId('frame-screen');
const canvas = byId('screen');
const waitBox = byId('frame-wait');
const waitText = byId('frame-wait-text');
const waitButton = byId('frame-wait-btn');
const zoomButton = byId('zoom-reset');
const liveHint = byId('live-hint');
const liveNote = byId('live-note');
const uprightButton = byId('side-upright');
const typeForm = byId('type-form');
const typeInput = byId('type-input');
const sendButton = byId('type-send');
const keyButtons = [...typeForm.querySelectorAll('[data-key]')];
const passwordButton = byId('type-pw');

const STATE_LABELS = { connecting: '连接中', retrying: '重连中', live: '已连上', paused: '已暂停', error: '已断开' };

let currentId = null;

const live = {
  viewer: null,
  /** 收掉当前这条连接（连同它排着的重连） */
  dispose: null,
  retries: 0,
  /** connecting / retrying / live / paused / error / idle */
  phase: 'idle',
  message: '',
  /** 报错时画面上那颗按钮：back = 回列表，retry = 重新连接 */
  action: '',
  /** 选中网页的第一帧画上去了 */
  shown: false,
  /** 正在显示「这个网页关掉了」 */
  closing: false,
  closingTimer: null,
  noteTimer: null,
  forcedLand: false,
  typeOpen: false,
  /** 从 CSS 转的横屏竖回来以后，要把焦点放进打字框 */
  focusType: false,
  rootW: 0,
  rootH: 0,
  sysLand: false,
  land: false,
  rotate: false,
  frame: FALLBACK_FRAME,
  view: { scale: 1, tx: 0, ty: 0 },
  tracker: new GestureTracker(),
  acc: new ScrollAccumulator(),
  flushTimer: null,
  holdTimer: null,
  /** 这一轮滚动落在帧图的哪一点（按下的位置） */
  scrollAnchor: null,
  /** 这一轮第一根手指按下的屏幕坐标：点一下 / 滚动都落在按下的地方 */
  downClient: null,
  pinch: null,
  password: false,
};

const liveReady = () => live.phase === 'live' && live.shown && !live.closing;

function enterLive(id) {
  if (currentView === 'live') return;
  stopList();
  currentId = id;
  live.retries = 0;
  live.closing = false;
  live.forcedLand = false;
  live.typeOpen = false;
  live.focusType = false;
  live.frame = FALLBACK_FRAME;
  live.shown = false;
  hideNote();
  setPassword(false);
  liveSite.textContent = '网页';
  liveTitle.textContent = '';
  showView('live');
  pushLiveHistory();
  updateLiveTitle();
  measureRoot();
  layoutFrame();
  if (isForeground()) connect();
  else setPhase('paused');
}

/** 回列表：先把看屏连接收掉（关 WebSocket + DELETE），服务器才会把浏览器窗口还回去 */
function leaveLive(notice) {
  if (currentView !== 'live') return;
  closeLive();
  goList();
  if (notice) showListToast(notice);
  // 不是按手机返回键回来的：把进画面时记下的那一步历史退掉，免得越积越多
  if (liveHistory) {
    liveHistory = false;
    history.back();
  }
}

// 手机的返回键 / 返回手势：看画面时退回列表，而不是离开整个网页
let liveHistory = false;

function pushLiveHistory() {
  try {
    history.pushState({ vscreen: 'live' }, '');
    liveHistory = true;
  } catch {
    liveHistory = false;
  }
}

window.addEventListener('popstate', () => {
  if (!liveHistory) return;
  liveHistory = false;
  leaveLive(null);
});

function closeLive() {
  disconnect();
  if (live.closingTimer !== null) clearTimeout(live.closingTimer);
  live.closingTimer = null;
  live.closing = false;
  hideNote();
  resetGesture();
  setView({ scale: 1, tx: 0, ty: 0 });
  live.forcedLand = false;
  live.typeOpen = false;
  live.focusType = false;
  applyLand();
  live.phase = 'idle';
  live.shown = false;
  typeInput.value = '';
  if (document.activeElement === typeInput) typeInput.blur();
  // 清掉上一个网页的最后一帧，下次进来不会先闪一下旧画面
  canvas.width = 1;
  canvas.height = 1;
}

function connect() {
  disconnect();
  const token = readToken();
  if (!token) {
    goLogin('');
    return;
  }
  let disposed = false;
  let retryTimer = null;
  live.shown = false;
  resetGesture();
  setView({ scale: 1, tx: 0, ty: 0 });
  if (live.retries) setPhase('retrying', live.message);
  else setPhase('connecting');
  const viewer = new Viewer(canvas, currentId, token, {
    windows(list) {
      if (!disposed) setWindows(list);
    },
    frame(size) {
      if (disposed) return;
      if (size.w !== live.frame.w || size.h !== live.frame.h) resetGesture();
      live.frame = size;
      layoutFrame();
    },
    selected() {
      if (disposed) return;
      resetGesture();
      live.retries = 0;
      live.shown = true;
      setPhase('live');
    },
    closed() {
      if (!disposed) showClosed();
    },
    warn(code) {
      if (disposed) return;
      if (code === 'window_not_found' && viewer.live) showNote(friendlyWarn(code));
      else if (code === 'window_not_found' || code === 'window_unavailable') leaveLive(friendlyWarn(code));
      else showNote(friendlyWarn(code));
    },
    failed(code) {
      if (disposed) return;
      resetGesture();
      void viewer.stop();
      live.shown = false;
      const { message, retry } = friendlyError(code);
      if (retry && live.retries < MAX_RETRIES) {
        live.retries += 1;
        setPhase('retrying', `${message}，马上重连（${live.retries}/${MAX_RETRIES}）…`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!disposed) connect();
        }, retryDelay(live.retries));
      } else {
        // 在别的地方打开了（replaced）等：不自动重连。横着看的时候断了先竖回来
        live.forcedLand = false;
        live.typeOpen = false;
        applyLand();
        setPhase('error', message, code === 'replaced' || code === 'unauthorized' ? 'back' : 'retry');
      }
    },
  });
  live.viewer = viewer;
  live.dispose = () => {
    disposed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    resetGesture();
    void viewer.stop();
    if (live.viewer === viewer) live.viewer = null;
  };
  viewer.start();
}

function disconnect() {
  const dispose = live.dispose;
  live.dispose = null;
  if (dispose) dispose();
}

/** 切到后台：断开（服务器借此把窗口还回去）；停在报错上的不动 */
function pauseLive() {
  if (live.phase === 'error' || live.closing) return;
  disconnect();
  resetGesture();
  live.shown = false;
  setPhase('paused');
}

/** 回到前台、还在看画面：重连。停在报错上的（比如在别的地方打开了）不自动连，等人点按钮 */
function resumeLive() {
  if (live.phase === 'error' || live.closing) return;
  live.retries = 0;
  connect();
}

function setPhase(phase, message, action) {
  live.phase = phase;
  live.message = message || '';
  live.action = action || '';
  renderLiveState();
}

function renderLiveState() {
  const ready = liveReady();
  const state = ready ? 'live' : (live.phase === 'live' || live.phase === 'idle' ? 'connecting' : live.phase);
  const label = STATE_LABELS[state] || STATE_LABELS.connecting;
  for (const chip of stateChips) {
    chip.textContent = label;
    chip.dataset.state = state;
  }
  for (const button of keyButtons) button.disabled = !ready;
  sendButton.disabled = !ready || !typeInput.value;
  renderOverlay();
}

/** 画面上盖着的那层字：连接中 / 重连中 / 暂停 / 关掉了 / 报错（带按钮）；接上了就收起来 */
function renderOverlay() {
  let text = '';
  let tone = '';
  let action = '';
  if (live.closing) {
    text = '这个网页关掉了';
    tone = 'closed';
  } else if (live.phase === 'error') {
    text = live.message;
    tone = 'error';
    action = live.action;
  } else if (live.phase === 'paused') {
    text = '画面已暂停，回到这里会自动接上';
  } else if (live.phase === 'retrying') {
    text = live.message || '正在重连…';
  } else if (!liveReady()) {
    text = live.phase === 'live' ? '等网页送来画面…' : '正在连接…';
  }
  waitBox.hidden = !text;
  waitText.textContent = text;
  if (tone) waitBox.dataset.tone = tone;
  else delete waitBox.dataset.tone;
  waitButton.hidden = !action;
  waitButton.dataset.action = action;
  waitButton.textContent = action === 'back' ? '回列表' : '重新连接';
}

waitButton.addEventListener('click', () => {
  if (waitButton.dataset.action === 'back') {
    leaveLive(null);
  } else if (waitButton.dataset.action === 'retry') {
    live.retries = 0;
    connect();
  }
});

function showClosed() {
  resetGesture();
  live.closing = true;
  live.shown = false;
  renderLiveState();
  if (live.closingTimer !== null) clearTimeout(live.closingTimer);
  live.closingTimer = setTimeout(() => {
    live.closingTimer = null;
    leaveLive(null);
  }, CLOSED_NOTICE_MS);
}

function showNote(text) {
  liveNote.textContent = text;
  liveNote.hidden = false;
  if (live.noteTimer !== null) clearTimeout(live.noteTimer);
  live.noteTimer = setTimeout(hideNote, NOTE_MS);
}

function hideNote() {
  if (live.noteTimer !== null) clearTimeout(live.noteTimer);
  live.noteTimer = null;
  liveNote.hidden = true;
}

function updateLiveTitle() {
  const win = windows ? windows.find((item) => item.id === currentId) : null;
  if (!win) return;
  const caption = captionOf(win);
  liveSite.textContent = caption.site;
  liveTitle.textContent = caption.title;
}

// ── 横过来看 ──

/** 量看画面这一节（根节点，横竖切换时它本身不换、不转）来判断横竖 */
function measureRoot() {
  if (live.rootW !== liveRoot.clientWidth || live.rootH !== liveRoot.clientHeight) resetGesture();
  live.rootW = liveRoot.clientWidth;
  live.rootH = liveRoot.clientHeight;
  const sys = live.rootW > live.rootH && live.rootH > 0;
  // 开着自动旋转的话：手机转回竖着，就退出横过来看
  if (live.sysLand && !sys) {
    live.forcedLand = false;
    live.typeOpen = false;
  }
  live.sysLand = sys;
  applyLand();
}

function applyLand() {
  const mode = landscapeMode(live.forcedLand, live.rootW, live.rootH);
  const changed = mode.land !== live.land || mode.rotate !== live.rotate;
  live.land = mode.land;
  live.rotate = mode.rotate;
  if (!mode.land) live.typeOpen = false;
  liveRoot.classList.toggle('is-land', mode.land);
  liveRoot.classList.toggle('is-rotated', mode.rotate);
  liveRoot.classList.toggle('is-typing', mode.land && live.typeOpen);
  uprightButton.hidden = !mode.rotate;
  if (mode.rotate) {
    // 系统没转、是按了「横过来看」：里面那层宽高对调后顺时针转 90°，手机往左转着看
    layer.style.width = `${live.rootH}px`;
    layer.style.height = `${live.rootW}px`;
    layer.style.transform = `translateX(${live.rootW}px) rotate(90deg)`;
  } else {
    layer.style.width = '';
    layer.style.height = '';
    layer.style.transform = '';
  }
  if (!changed) return;
  // 横竖换了：画面框大小变了，放大和手势都归零，再把最后一帧补画上去
  resetGesture();
  resetZoom();
  layoutFrame();
  if (live.viewer) live.viewer.repaint();
  if (!mode.land && live.focusType) {
    live.focusType = false;
    typeInput.focus();
  }
}

function startTyping() {
  if (live.rotate) {
    // CSS 转过来的横屏里弹出来的键盘是歪的，先竖回来再打
    live.focusType = true;
    live.forcedLand = false;
    applyLand();
  } else {
    live.typeOpen = !live.typeOpen;
    applyLand();
    if (live.typeOpen) typeInput.focus();
  }
}

/** 画面框按帧图比例装进中间那块：尺寸由 ResizeObserver 量，JS 实算 */
function layoutFrame() {
  const pad = live.land ? 6 : 12;
  const fit = containFit(live.frame.w / live.frame.h, stage.clientWidth - pad * 2, stage.clientHeight - pad * 2);
  if (!fit) {
    frameBox.style.visibility = 'hidden';
    return;
  }
  const w = Math.floor(fit.w);
  const h = Math.floor(fit.h);
  if (frameBox.style.width !== `${w}px` || frameBox.style.height !== `${h}px`) resetGesture();
  frameBox.style.width = `${w}px`;
  frameBox.style.height = `${h}px`;
  frameBox.style.visibility = '';
  // 框的大小变了，放大时的平移上限跟着变
  if (isZoomed(live.view.scale)) {
    setView({ scale: live.view.scale, ...clampPan(live.view.scale, live.view.tx, live.view.ty, { w, h }) });
  }
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => measureRoot()).observe(liveRoot);
  new ResizeObserver(() => layoutFrame()).observe(stage);
}
window.addEventListener('resize', () => {
  measureRoot();
  layoutFrame();
});

// ── 放大 ──

function setView(view) {
  live.view = view;
  screenLayer.style.transform = view.scale === 1 && !view.tx && !view.ty
    ? '' : `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  const zoomed = isZoomed(view.scale);
  liveHint.textContent = zoomed ? '单指挪画面 · 长按拖动控件' : '点按网页 · 上下滑滚动 · 长按拖动控件 · 两指捏放大';
  zoomButton.hidden = !zoomed;
  if (zoomed) zoomButton.textContent = `${view.scale.toFixed(1)}×`;
}

function resetZoom() {
  resetGesture();
  setView({ scale: 1, tx: 0, ty: 0 });
  if (live.viewer) live.viewer.detail(false);
}

const clipBox = () => ({ w: clip.clientWidth, h: clip.clientHeight });

// ── 手势 ──

function resetGesture() {
  if (live.holdTimer !== null) clearTimeout(live.holdTimer);
  live.holdTimer = null;
  if (live.viewer) live.viewer.cancelDrag();
  live.tracker.reset();
  live.downClient = null;
  live.pinch = null;
  live.scrollAnchor = null;
  live.acc.reset();
  if (live.flushTimer !== null) clearTimeout(live.flushTimer);
  live.flushTimer = null;
}

/** 屏幕坐标 → 帧图像素（含放大平移和旋转，都在画布的外框里了） */
function toFrame(clientX, clientY) {
  const size = live.viewer ? live.viewer.frameSize() : null;
  if (!size) return null;
  return framePoint(clientX, clientY, canvas.getBoundingClientRect(), size, live.rotate);
}

function flushScroll() {
  if (live.flushTimer !== null) clearTimeout(live.flushTimer);
  live.flushTimer = null;
  const dy = live.acc.take();
  const anchor = live.scrollAnchor;
  if (dy && anchor && live.viewer) live.viewer.scroll(anchor, dy);
}

function handle(intents) {
  for (const intent of intents) {
    switch (intent.kind) {
      case 'remote-start':
      case 'remote-move':
      case 'remote-end': {
        // 先换回屏幕坐标，再复用点按的缩放和平移、旋转换算。
        const client = live.rotate ? { x: -intent.y, y: intent.x } : intent;
        const pt = toFrame(client.x, client.y);
        if (pt && live.viewer) live.viewer.drag(intent.kind === 'remote-start' ? 'start'
          : intent.kind === 'remote-move' ? 'move' : 'end', pt);
        else if (live.viewer) live.viewer.cancelDrag();
        break;
      }
      case 'remote-cancel':
        if (live.viewer) live.viewer.cancelDrag();
        break;
      case 'tap': {
        const down = live.downClient;
        const pt = down && toFrame(down.x, down.y);
        if (pt && live.viewer) live.viewer.tap(pt);
        break;
      }
      case 'scroll': {
        const size = live.viewer ? live.viewer.frameSize() : null;
        if (!size) break;
        if (!live.scrollAnchor) {
          const down = live.downClient;
          live.scrollAnchor = down ? toFrame(down.x, down.y) : null;
        }
        live.acc.push(intent.dy, displayedSize(canvas.getBoundingClientRect(), live.rotate).h, size.h);
        if (live.flushTimer === null) {
          live.flushTimer = setTimeout(() => {
            live.flushTimer = null;
            flushScroll();
          }, SCROLL_FLUSH_MS);
        }
        break;
      }
      case 'pan-view': {
        setView(panView(live.view, live.view.tx + intent.dx, clipBox(), live.view.ty + intent.dy));
        break;
      }
      // 原大小横划不切网页，也不向网页发操作；选择网页始终回列表。
      case 'hdrag':
      case 'hrelease':
      case 'hcancel':
        break;
      case 'pinch-start':
        flushScroll();
        live.acc.reset();
        live.pinch = pinchStart(intent.a, intent.b, live.view);
        break;
      case 'pinch-move': {
        if (!live.pinch) break;
        // 画面框中心（换成眼里方向的坐标）就是没变换时画面的中心
        const r = clip.getBoundingClientRect();
        const origin = viewPoint(r.left + r.width / 2, r.top + r.height / 2, live.rotate);
        setView(pinchView(live.pinch, intent.a, intent.b, origin, clipBox()));
        break;
      }
      case 'pinch-end': {
        live.pinch = null;
        const snapped = snapView(live.view);
        setView(snapped);
        // 放大到 1.2 倍以上请服务器发高清帧，回到以下改回普通帧
        if (live.viewer) live.viewer.detail(snapped.scale > DETAIL_SCALE);
        break;
      }
      default:
        break;
    }
  }
  if (!live.tracker.waitingForHold && live.holdTimer !== null) {
    clearTimeout(live.holdTimer);
    live.holdTimer = null;
  }
  if (!live.tracker.active) {
    flushScroll();
    live.scrollAnchor = null;
  }
}

// 指针事件统一手指和鼠标；坐标先换成「眼里的方向」再判手势（横过来看时屏幕坐标是转了 90° 的）
canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  if (!liveReady() || !live.viewer || !live.viewer.live) return;
  const first = !live.tracker.active;
  if (first) {
    live.downClient = { x: event.clientX, y: event.clientY };
    live.scrollAnchor = null;
  }
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // 拿不到时由 pointerleave 取消，避免遗漏松手。
  }
  const p = viewPoint(event.clientX, event.clientY, live.rotate);
  handle(live.tracker.down(event.pointerId, p.x, p.y, Date.now(), isZoomed(live.view.scale)));
  if (first) {
    live.holdTimer = setTimeout(() => {
      live.holdTimer = null;
      handle(live.tracker.hold());
    }, LONG_PRESS_MS);
  }
});
canvas.addEventListener('pointermove', (event) => {
  const p = viewPoint(event.clientX, event.clientY, live.rotate);
  handle(live.tracker.move(event.pointerId, p.x, p.y));
});
canvas.addEventListener('pointerup', (event) => {
  const p = viewPoint(event.clientX, event.clientY, live.rotate);
  handle(live.tracker.up(event.pointerId, p.x, p.y));
  try {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  } catch {
    // 没拿到过就算了
  }
});
const cancelPointer = (event) => handle(live.tracker.cancel(event.pointerId));
canvas.addEventListener('pointercancel', cancelPointer);
canvas.addEventListener('lostpointercapture', cancelPointer);
canvas.addEventListener('pointerleave', (event) => {
  if (!canvas.hasPointerCapture(event.pointerId)) cancelPointer(event);
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
// iOS Safari 不理 user-scalable=no：在画面上两指捏时别让整页跟着缩放
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  stage.addEventListener(type, (event) => event.preventDefault());
}
window.addEventListener('blur', () => resetGesture());

// ── 打字栏 ──

function setPassword(on) {
  live.password = on;
  typeInput.type = on ? 'password' : 'text';
  typeInput.setAttribute('autocomplete', on ? 'new-password' : 'off');
  typeInput.placeholder = on ? '打密码，键盘不会记住' : '先点网页里的框，再在这里打字';
  // 切换时清空：明文和圆点来回切，不让刚打的密码露出来
  typeInput.value = '';
  passwordButton.setAttribute('aria-pressed', on ? 'true' : 'false');
  sendButton.disabled = !liveReady() || !typeInput.value;
}

function sendText() {
  if (live.viewer && liveReady() && live.viewer.text(typeInput.value)) {
    typeInput.value = '';
    sendButton.disabled = true;
  }
}

/** 发送 / 回车 / 删除 / Tab 按下去时不抢输入框的焦点，键盘就不会一按一收 */
const keepFocus = (event) => event.preventDefault();

typeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendText();
});
typeInput.addEventListener('input', () => {
  sendButton.disabled = !liveReady() || !typeInput.value;
});
sendButton.addEventListener('pointerdown', keepFocus);
for (const button of keyButtons) {
  button.addEventListener('pointerdown', keepFocus);
  button.addEventListener('click', () => {
    if (live.viewer && liveReady()) live.viewer.key(button.dataset.key);
  });
}
passwordButton.addEventListener('click', () => setPassword(!live.password));

// ── 看画面里的按钮 ──

byId('live-back').addEventListener('click', () => leaveLive(null));
byId('side-back').addEventListener('click', () => leaveLive(null));
byId('rotate-btn').addEventListener('click', () => {
  live.forcedLand = true;
  applyLand();
});
uprightButton.addEventListener('click', () => {
  live.forcedLand = false;
  live.typeOpen = false;
  applyLand();
});
byId('side-type').addEventListener('click', startTyping);
zoomButton.addEventListener('click', resetZoom);

// ── 开始 ──

if (bootNotice) goLogin(bootNotice);
else if (readToken()) goList();
else goLogin('');
