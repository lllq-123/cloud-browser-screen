// 虚拟屏幕的纯计算部分：消息检查、控制消息构造、坐标换算、手势判定、文案。
// 不碰 DOM、不发请求，所以能直接在 node 里测（tests/protocol.test.mjs）。
//
// 跟服务器的约定里最要紧的两条：
// 1) 点 / 滑发的坐标、宽高、位移必须是范围内的整数。服务器收到不合格的控制消息不是丢掉，
//    而是整场断开，所以控制消息一律走下面的 *Message 构造函数。
// 2) 二进制帧 = 4 字节大端 generation + JPEG。generation 跟当前选中的对不上就丢。

/** 服务器的上限：宽高和位移的最大值、一次最多打多少字 */
export const MAX_DIMENSION = 16384;
export const MAX_TEXT_CHARS = 2000;
/** 服务器只认这四个键 */
export const KEYS = Object.freeze(['Enter', 'Backspace', 'Tab', 'Escape']);
/** 网页编号的格式，跟服务器一致；不合格的编号发过去也会被整场断开 */
const WINDOW_ID = /^[0-9A-Za-z]{8,64}$/;

const isString = (value) => typeof value === 'string';
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// ── 服务器发来的东西 ──

/** 网页列表：只认编号是非空字符串的项，缺的字段补空串；坏项跳过，不让一条坏数据弄崩整页 */
export function parseWindows(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, url, host } = item;
    if (!isString(id) || !id) continue;
    out.push({ id, title: isString(title) ? title : '', url: isString(url) ? url : '', host: isString(host) ? host : '' });
  }
  return out;
}

/** 文字消息 → 对象；认不出的返回 null，调用处直接忽略 */
export function parseServerText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  switch (raw.type) {
    case 'status':
      return { type: 'status', state: isString(raw.state) ? raw.state : '' };
    case 'windows': {
      const windows = parseWindows(raw.windows);
      return windows ? { type: 'windows', windows } : null;
    }
    case 'selected':
      return isString(raw.id) && Number.isInteger(raw.generation)
        ? { type: 'selected', id: raw.id, generation: raw.generation }
        : null;
    case 'closed':
      return isString(raw.id) ? { type: 'closed', id: raw.id } : null;
    case 'warn':
    case 'error':
      return { type: raw.type, error: isString(raw.error) ? raw.error : '' };
    case 'stopped':
    case 'pong':
      return { type: raw.type };
    default:
      return null;
  }
}

/** 二进制帧拆成 generation + JPEG；太短的当坏帧，返回 null */
export function splitFrame(buffer) {
  if (!buffer || !(buffer.byteLength > 4)) return null;
  return { generation: new DataView(buffer).getUint32(0, false), jpeg: new Uint8Array(buffer, 4) };
}

/**
 * 这一帧要不要画。expected 是当前选中网页的 generation；还没收到 selected 时传 -1。
 * 对不上的（换网页前路上的旧帧、selected 之前来的帧）一律丢。
 */
export function pickFrame(buffer, expected) {
  if (!Number.isInteger(expected) || expected < 0) return null;
  const frame = splitFrame(buffer);
  return frame && frame.generation === expected ? frame : null;
}

// ── 发给服务器的控制消息：全部经这里出去，保证类型对、整数、在范围内 ──

const toInt = (value, lo, hi) => clamp(Math.round(Number.isFinite(value) ? value : 0), lo, hi);

/** 点一下。坐标是帧图上的像素，width / height 是帧图宽高，换算交给服务器 */
export function tapMessage(pt) {
  const width = toInt(pt.width, 1, MAX_DIMENSION);
  const height = toInt(pt.height, 1, MAX_DIMENSION);
  return { type: 'tap', x: toInt(pt.x, 0, width - 1), y: toInt(pt.y, 0, height - 1), width, height };
}

export function scrollMessage(pt, dx, dy) {
  return { ...tapMessage(pt), type: 'scroll',
    dx: toInt(dx, -MAX_DIMENSION, MAX_DIMENSION), dy: toInt(dy, -MAX_DIMENSION, MAX_DIMENSION) };
}

/**
 * 打的字：去掉落单的代理项（半个 emoji），超长按「整字」截到 2000。
 * 半个 emoji 到了服务器那头转不成 UTF-8，会被当成坏消息整场断开，所以必须在这边洗干净。
 */
export function cleanText(text) {
  if (!isString(text)) return '';
  let out = '';
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        if (units + 2 > MAX_TEXT_CHARS) break;
        out += text[i] + text[i + 1];
        units += 2;
        i++;
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    if (units + 1 > MAX_TEXT_CHARS) break;
    out += text[i];
    units++;
  }
  return out;
}

/** 洗完是空的就不发，返回 null */
export function textMessage(text) {
  const clean = cleanText(text);
  return clean ? { type: 'text', text: clean } : null;
}

/** 只认 Enter / Backspace / Tab / Escape，别的返回 null */
export function keyMessage(key) {
  return KEYS.includes(key) ? { type: 'key', key } : null;
}

/** 选中哪个网页；编号格式不对返回 null */
export function selectMessage(id) {
  return isString(id) && WINDOW_ID.test(id) ? { type: 'select', id } : null;
}

/** 放大看细节时请服务器改发高清帧；on 必须是真正的布尔值 */
export function detailMessage(on) {
  return { type: 'detail', on: on === true };
}

export function pingMessage() {
  return { type: 'ping' };
}

/** 连上 WebSocket 后的第一句：报一次性通行证 */
export function authMessage(token) {
  return { type: 'auth', token: isString(token) ? token : '' };
}

// ── 坐标 ──

/**
 * 「横过来看」是把画面层用 CSS 顺时针转 90°（手机往左转着拿）。转了以后：
 * 层里的 x 轴 = 屏幕向下，层里的 y 轴 = 屏幕向左。手势一律先换成「看的人眼里的方向」再判，
 * 横着竖着用同一套逻辑。
 */
export function viewPoint(clientX, clientY, rotated) {
  return rotated ? { x: clientY, y: -clientX } : { x: clientX, y: clientY };
}

/**
 * 手指落点 → 帧图像素。rect 是画布的 getBoundingClientRect()（已经包含放大、平移和旋转），
 * frame 是帧图本身的宽高。返回 null = 画布还没有尺寸。
 */
export function framePoint(clientX, clientY, rect, frame, rotated) {
  if (!(rect.width > 0 && rect.height > 0 && frame.w > 0 && frame.h > 0)) return null;
  const u = rotated ? (clientY - rect.top) / rect.height : (clientX - rect.left) / rect.width;
  const v = rotated ? (rect.right - clientX) / rect.width : (clientY - rect.top) / rect.height;
  return {
    x: toInt(u * frame.w, 0, frame.w - 1),
    y: toInt(v * frame.h, 0, frame.h - 1),
    width: frame.w,
    height: frame.h,
  };
}

/** 画布在看的人眼里的宽高（转过来时宽高互换） */
export function displayedSize(rect, rotated) {
  return rotated ? { w: rect.height, h: rect.width } : { w: rect.width, h: rect.height };
}

/**
 * 跟手滚：手指往上推 d 像素，网页内容就跟着往上走 d 像素 = 滚轮往下 d × (帧高 / 画面显示高)。
 * 不到 1 帧像素的零头攒着下次凑，不然慢慢推会一直被四舍五入吃掉。
 */
export class ScrollAccumulator {
  constructor() {
    this.rest = 0;
  }

  push(fingerDy, shownHeight, frameHeight) {
    if (shownHeight > 0 && frameHeight > 0) this.rest += (-fingerDy * frameHeight) / shownHeight;
  }

  /** 取出能发的整数部分；没有就返回 0 */
  take() {
    const whole = Math.trunc(this.rest);
    this.rest -= whole;
    return whole;
  }

  reset() {
    this.rest = 0;
  }
}

/** 画面按比例装进可用空间：按宽装不下就按高装。尺寸由 ResizeObserver 量出来再在这里算 */
export function containFit(ratio, availW, availH) {
  if (!(ratio > 0 && availW > 0 && availH > 0)) return null;
  const heightIfFull = availW / ratio;
  if (heightIfFull <= availH) return { w: availW, h: heightIfFull };
  return { w: availH * ratio, h: availH };
}

// ── 放大和平移 ──
// 画面层用 transform: translate(tx, ty) scale(scale)，变换原点是画面框的中心。

export const SCALE_MIN = 1;
export const SCALE_MAX = 4;
/** 松手时比 1 倍大不了这么多，就弹回 1 倍 */
const SCALE_SNAP_EPSILON = 0.06;
/** 放大过这一档，请服务器改发高清帧 */
export const DETAIL_SCALE = 1.2;

export function isZoomed(scale) {
  return scale > SCALE_MIN + SCALE_SNAP_EPSILON;
}

/** 平移上限：放大后画面比框大出多少，就最多能挪多少；1 倍时上限是 0，自动归位 */
export function clampPan(scale, tx, ty, box) {
  const maxTx = Math.max(0, (box.w * (scale - 1)) / 2);
  const maxTy = Math.max(0, (box.h * (scale - 1)) / 2);
  // || 0：把 -0 规整成 0
  return { tx: clamp(tx, -maxTx, maxTx) || 0, ty: clamp(ty, -maxTy, maxTy) || 0 };
}

/** 两指刚落下：记下起手时的距离、中点和当时的放大状态 */
export function pinchStart(a, b, view) {
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    scale: view.scale,
    tx: view.tx,
    ty: view.ty,
  };
}

/**
 * 两指在动：按距离变化放大，并让起手时捏住的那一点一直待在两指中点底下。
 * origin = 画面框中心（换成眼里方向的坐标），box = 画面框的布局宽高。
 */
export function pinchView(start, a, b, origin, box) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const scale = clamp((start.scale * dist) / start.dist, SCALE_MIN, SCALE_MAX);
  const tx = cx - origin.x - (scale * (start.cx - origin.x - start.tx)) / start.scale;
  const ty = cy - origin.y - (scale * (start.cy - origin.y - start.ty)) / start.scale;
  return { scale, ...clampPan(scale, tx, ty, box) };
}

/** 放大后单指横着拖：只挪左右 */
export function panView(view, tx, box) {
  return { scale: view.scale, ...clampPan(view.scale, tx, view.ty, box) };
}

/** 捏完松手：几乎没放大就弹回原样 */
export function snapView(view) {
  return isZoomed(view.scale) ? view : { scale: 1, tx: 0, ty: 0 };
}

// ── 手势 ──

/** 手指挪过这么远（眼里的像素）才算「在滑」，以内都算点一下 */
export const TOUCH_SLOP = 12;

/**
 * 判定一轮触摸是什么手势。坐标都是 viewPoint 换过的。说出来的意图：
 *   tap {x, y} / scroll {dy} / hdrag {dx} / hrelease {dx} / hcancel
 *   pinch-start {a, b} / pinch-move {a, b} / pinch-end
 *
 * - 没挪出 TOUCH_SLOP 就抬手 = 点一下（落点用按下的位置，抬手时手指常会滑一点）
 * - 挪出去以后按第一下的方向锁定：竖着 = 跟手滚，横着 = 拖（放大时用来挪画面）
 * - 这一轮只要出现过第二根手指，就是捏合：之后谁抬手都不算点击。
 *   捏完两根手指是一根一根抬的，最后那根看着跟单指点一下一模一样。
 */
export class GestureTracker {
  constructor() {
    this.fingers = new Map();
    this.start = null;
    this.axis = 'none';
    this.lastY = 0;
    this.multi = false;
  }

  get active() {
    return this.fingers.size > 0;
  }

  down(id, x, y) {
    this.fingers.set(id, { x, y });
    if (this.fingers.size === 1 && !this.multi) {
      this.start = { id, x, y };
      this.axis = 'none';
      this.lastY = y;
      return [];
    }
    // 第二根手指落下：这一轮从此是捏合
    const out = [];
    if (!this.multi && this.axis === 'h') out.push({ kind: 'hcancel' });
    this.multi = true;
    this.start = null;
    this.axis = 'none';
    const pair = this.pair();
    if (pair) out.push({ kind: 'pinch-start', a: pair[0], b: pair[1] });
    return out;
  }

  move(id, x, y) {
    if (!this.fingers.has(id)) return [];
    this.fingers.set(id, { x, y });
    if (this.multi) {
      const pair = this.pair();
      return pair && this.fingers.size >= 2 ? [{ kind: 'pinch-move', a: pair[0], b: pair[1] }] : [];
    }
    const start = this.start;
    if (!start || start.id !== id) return [];
    const dx = x - start.x;
    const dy = y - start.y;
    if (this.axis === 'none') {
      if (Math.hypot(dx, dy) <= TOUCH_SLOP) return [];
      this.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      // 从锁定那一刻起算，前面那段死区不补发，免得一锁定就猛跳一下
      this.lastY = y;
      return this.axis === 'h' ? [{ kind: 'hdrag', dx }] : [];
    }
    if (this.axis === 'h') return [{ kind: 'hdrag', dx }];
    const step = y - this.lastY;
    this.lastY = y;
    return step ? [{ kind: 'scroll', dy: step }] : [];
  }

  up(id, x, y) {
    if (!this.fingers.has(id)) return [];
    this.fingers.delete(id);
    if (this.multi) return this.afterMultiLift();
    const start = this.start;
    this.start = null;
    const axis = this.axis;
    this.axis = 'none';
    if (!start || start.id !== id) return [];
    if (axis === 'h') return [{ kind: 'hrelease', dx: x - start.x }];
    if (axis === 'v') {
      const step = y - this.lastY;
      return step ? [{ kind: 'scroll', dy: step }] : [];
    }
    return [{ kind: 'tap', x: start.x, y: start.y }];
  }

  /** 系统收走了手指（来电、切后台、滑出屏幕）：这一轮作废，什么都不发 */
  cancel(id) {
    if (!this.fingers.has(id)) return [];
    this.fingers.delete(id);
    if (this.multi) return this.afterMultiLift();
    const out = this.axis === 'h' ? [{ kind: 'hcancel' }] : [];
    this.start = null;
    this.axis = 'none';
    return out;
  }

  /** 捏合里抬起一根：还剩两根以上就按剩下的重新起算，剩一根就收工（那根抬起时什么都不算） */
  afterMultiLift() {
    if (this.fingers.size === 0) {
      this.multi = false;
      return [];
    }
    if (this.fingers.size === 1) return [{ kind: 'pinch-end' }];
    const pair = this.pair();
    return pair ? [{ kind: 'pinch-start', a: pair[0], b: pair[1] }] : [];
  }

  reset() {
    this.fingers.clear();
    this.start = null;
    this.axis = 'none';
    this.multi = false;
  }

  pair() {
    const points = [...this.fingers.values()];
    return points.length >= 2 ? [points[0], points[1]] : null;
  }
}

// ── 横过来看 ──

/**
 * forced = 按了「横过来看」；width / height = 看画面这一层量出来的尺寸。
 * 系统自己已经是横屏（开着自动旋转）就不再用 CSS 转，不然会转两遍。
 */
export function landscapeMode(forced, width, height) {
  const systemLand = width > height && height > 0;
  return { land: forced || systemLand, rotate: forced && !systemLand };
}

// ── 地址和口令 ──

/**
 * WebSocket 地址 = 当前页的协议换成 ws / wss + 当前页的 host + 服务器给的 viewer_path。
 * viewer_path 必须是本站的绝对路径（以单个 / 开头），否则返回 null 不连。
 */
export function viewerSocketUrl(pageProtocol, host, viewerPath) {
  if (!isString(host) || !host || !isString(viewerPath)) return null;
  if (viewerPath.charAt(0) !== '/' || viewerPath.charAt(1) === '/' || viewerPath.charAt(1) === '\\') return null;
  return `${pageProtocol === 'https:' ? 'wss:' : 'ws:'}//${host}${viewerPath}`;
}

/** 从网址的 # 后面取口令（#token=…）。没有这一项返回 null */
export function tokenFromHash(hash) {
  if (!isString(hash)) return null;
  const body = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  const match = /(?:^|&)token=([^&]*)/.exec(body);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** 口令只能是能放进请求头的可见 ASCII 字符；复制时常带上的首尾空白去掉。不合格返回空串 */
export function cleanToken(raw) {
  if (!isString(raw)) return '';
  const token = raw.trim();
  return /^[\x21-\x7E]+$/.test(token) ? token : '';
}

// ── 文案 ──

const SITE_NAMES = [
  [/(^|\.)wikipedia\.org$/, '维基百科'],
  [/(^|\.)github\.com$/, 'GitHub'],
  [/(^|\.)news\.ycombinator\.com$/, 'Hacker News'],
  [/(^|\.)xiaohongshu\.com$/, '小红书'],
  [/(^|\.)(x|twitter)\.com$/, 'X'],
  [/(^|\.)bilibili\.com$/, 'B 站'],
  [/(^|\.)zhihu\.com$/, '知乎'],
  [/(^|\.)weibo\.(com|cn)$/, '微博'],
  [/(^|\.)douban\.com$/, '豆瓣'],
  [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)google\.[a-z.]+$/, 'Google'],
  [/(^|\.)baidu\.com$/, '百度'],
  [/(^|\.)taobao\.com$/, '淘宝'],
  [/(^|\.)jd\.com$/, '京东'],
  [/(^|\.)anthropic\.com$/, 'Anthropic'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)openai\.com$/, 'OpenAI'],
  [/(^|\.)arxiv\.org$/, 'arXiv'],
];

/** 网站短名：认识的写中文名 / 品牌名，不认识的就是去掉 www. 的域名 */
export function siteName(host) {
  const clean = isString(host) ? host.trim().toLowerCase().replace(/^www\./, '') : '';
  if (!clean) return '网页';
  for (const [pattern, name] of SITE_NAMES) if (pattern.test(clean)) return name;
  return clean;
}

/** 卡片和顶栏上的那行：网站名 + 标题（标题就是网站名时不重复） */
export function captionOf(win) {
  const site = siteName(win.host);
  const title = isString(win.title) ? win.title.trim() : '';
  return { site, title: title && title !== site ? title : '' };
}

export function countLabel(n) {
  return n > 0 ? `开着 ${n} 个网页` : '现在没有开着的网页';
}

/** 整场断开的原因 → 给人看的话 + 要不要自动重连。在别处打开了（replaced）绝不自动重连 */
export function friendlyError(code) {
  switch (code) {
    case 'replaced':
      return { message: '在别的地方打开了，这里先停下', retry: false };
    case 'unauthorized':
      return { message: '口令不对了，回列表重新进', retry: false };
    case 'vscreen_in_use':
      return { message: '虚拟屏幕正被别的地方占着', retry: false };
    case 'browser_unavailable':
      return { message: '服务器上的浏览器暂时连不上', retry: true };
    case 'stream_timeout':
      return { message: '太久没动静，连接断了', retry: true };
    case 'session_expired':
      return { message: '连接超时了', retry: true };
    default:
      return { message: '连接断开了', retry: true };
  }
}

/** 单次操作没成功（连接还在） */
export function friendlyWarn(code) {
  switch (code) {
    case 'window_not_found':
      return '那个网页已经关掉了';
    case 'window_unavailable':
      return '那个网页暂时连不上';
    case 'input_failed':
      return '刚才那下没送到网页上';
    case 'no_window':
      return '画面还没接上，刚才那下没送出去';
    default:
      return '刚才那下没成功';
  }
}

/** 自动重连最多几次；第 n 次之前等多久（一次比一次久，到上限就不再变长） */
export const MAX_RETRIES = 2;
const RETRY_STEP_MS = 1500;
export function retryDelay(attempt) {
  const n = Math.floor(Number(attempt)) || 1;
  return clamp(n, 1, MAX_RETRIES) * RETRY_STEP_MS;
}
