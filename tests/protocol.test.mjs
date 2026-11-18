import assert from 'node:assert/strict';
import test from 'node:test';
import * as P from '../web/protocol.js';

// 虚拟屏幕前端的纯函数部分（web/protocol.js）

/** 把一串手指动作喂给手势判定，收集它说出来的全部意图 */
function play(steps) {
  const tracker = new P.GestureTracker();
  const intents = [];
  for (const [kind, id, x, y] of steps) intents.push(...tracker[kind](id, x, y));
  return intents;
}
const kinds = (intents) => intents.map((intent) => intent.kind);

/** 造一个二进制帧：4 字节大端 generation + 假 JPEG */
function frameBytes(generation) {
  const bytes = new Uint8Array(7);
  new DataView(bytes.buffer).setUint32(0, generation, false);
  bytes.set([0xFF, 0xD8, 0xFF], 4);
  return bytes.buffer;
}

/** 固定种子的伪随机数，测试结果每次一样 */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('服务器消息：认得的转成对象，坏的一律 null，不让一条坏数据弄崩整页', () => {
  assert.deepEqual(P.parseServerText('{"type":"selected","id":"AB12CD34","generation":3}'),
    { type: 'selected', id: 'AB12CD34', generation: 3 });
  assert.equal(P.parseServerText('{"type":"selected","id":"AB12CD34","generation":1.5}'), null);
  assert.deepEqual(P.parseServerText('{"type":"closed","id":"X1"}'), { type: 'closed', id: 'X1' });
  assert.deepEqual(P.parseServerText('{"type":"error","error":"replaced"}'), { type: 'error', error: 'replaced' });
  assert.deepEqual(P.parseServerText('{"type":"warn","error":"no_window"}'), { type: 'warn', error: 'no_window' });
  assert.deepEqual(P.parseServerText('{"type":"status","state":"ready"}'), { type: 'status', state: 'ready' });
  assert.deepEqual(P.parseServerText('{"type":"stopped"}'), { type: 'stopped' });
  assert.deepEqual(P.parseServerText('{"type":"pong"}'), { type: 'pong' });
  assert.equal(P.parseServerText('not json'), null);
  assert.equal(P.parseServerText('[1,2]'), null);
  assert.equal(P.parseServerText('null'), null);
  assert.equal(P.parseServerText('{"type":"mystery"}'), null);
  const windows = P.parseServerText(JSON.stringify({ type: 'windows', windows: [
    { id: 'A1', title: 'T', url: 'https://a.example/', host: 'a.example' },
    { id: '', title: 'no id' }, null, 'junk', { id: 'B2' },
  ] }));
  assert.deepEqual(windows, { type: 'windows', windows: [
    { id: 'A1', title: 'T', url: 'https://a.example/', host: 'a.example' },
    { id: 'B2', title: '', url: '', host: '' },
  ] });
  assert.equal(P.parseWindows({ not: 'a list' }), null);
});

test('二进制帧：前 4 字节大端是 generation，后面原样是 JPEG；太短当坏帧', () => {
  const bytes = new Uint8Array([0, 0, 1, 2, 0xFF, 0xD8, 0xFF]);
  const frame = P.splitFrame(bytes.buffer);
  assert.equal(frame.generation, 258);
  assert.deepEqual([...frame.jpeg], [0xFF, 0xD8, 0xFF]);
  assert.equal(P.splitFrame(new Uint8Array([0, 0, 0, 1]).buffer), null);
});

test('旧 generation 的帧丢掉；selected 到之前来的帧也丢', () => {
  assert.equal(P.pickFrame(frameBytes(3), 4), null, '换网页前路上的旧帧');
  assert.equal(P.pickFrame(frameBytes(5), 4), null, '对不上就丢，不管新旧');
  assert.equal(P.pickFrame(frameBytes(0), -1), null, '还没收到 selected（-1）时来的帧');
  const kept = P.pickFrame(frameBytes(4), 4);
  assert.equal(kept.generation, 4);
  assert.deepEqual([...kept.jpeg], [0xFF, 0xD8, 0xFF]);
  assert.equal(P.pickFrame(new Uint8Array([0, 0, 0, 4]).buffer, 4), null, '只有帧头没有图');
  assert.equal(P.pickFrame(frameBytes(4), 4.5), null);
});

test('点 / 滑的控制消息永远是范围内的整数——服务器收到小数或越界会整场断开', () => {
  assert.deepEqual(P.tapMessage({ x: 10.6, y: -3, width: 960.2, height: 452 }),
    { type: 'tap', x: 11, y: 0, width: 960, height: 452 });
  assert.deepEqual(P.tapMessage({ x: 5000, y: 451.7, width: 960, height: 452 }),
    { type: 'tap', x: 959, y: 451, width: 960, height: 452 });
  assert.deepEqual(P.tapMessage({ x: NaN, y: 1, width: 0, height: 99999 }),
    { type: 'tap', x: 0, y: 1, width: 1, height: 16384 });
  const scroll = P.scrollMessage({ x: 1, y: 2, width: 960, height: 452 }, 0.4, -40000);
  assert.deepEqual(scroll, { type: 'scroll', x: 1, y: 2, width: 960, height: 452, dx: 0, dy: -16384 });

  // 乱给一大堆值（小数、负数、无穷、NaN、超大），出来的每一条都必须合格
  const random = seeded(20);
  const wild = () => {
    const pick = random();
    if (pick < 0.08) return NaN;
    if (pick < 0.16) return Infinity;
    if (pick < 0.24) return -Infinity;
    return (random() - 0.3) * 60000;
  };
  for (let i = 0; i < 500; i++) {
    const pt = { x: wild(), y: wild(), width: wild(), height: wild() };
    const message = P.scrollMessage(pt, wild(), wild());
    for (const [key, value] of Object.entries(message)) {
      if (key !== 'type') assert.ok(Number.isInteger(value), `${key}=${value} 不是整数`);
    }
    assert.ok(message.width >= 1 && message.width <= P.MAX_DIMENSION);
    assert.ok(message.height >= 1 && message.height <= P.MAX_DIMENSION);
    assert.ok(message.x >= 0 && message.x <= message.width - 1);
    assert.ok(message.y >= 0 && message.y <= message.height - 1);
    assert.ok(Math.abs(message.dx) <= P.MAX_DIMENSION && Math.abs(message.dy) <= P.MAX_DIMENSION);
    const tap = P.tapMessage(pt);
    assert.deepEqual(Object.keys(tap).sort(), ['height', 'type', 'width', 'x', 'y']);
  }
});

test('其余控制消息：键只认四个、网页编号要合格、detail 是真布尔值', () => {
  for (const key of ['Enter', 'Backspace', 'Tab', 'Escape']) {
    assert.deepEqual(P.keyMessage(key), { type: 'key', key });
  }
  assert.equal(P.keyMessage('Delete'), null);
  assert.equal(P.keyMessage('enter'), null);
  assert.equal(P.keyMessage(undefined), null);
  assert.deepEqual(P.selectMessage('AB12CD34'), { type: 'select', id: 'AB12CD34' });
  assert.equal(P.selectMessage('short'), null);
  assert.equal(P.selectMessage('AB12CD34 '), null);
  assert.equal(P.selectMessage('../AB12CD34'), null);
  assert.equal(P.selectMessage(12345678), null);
  assert.deepEqual(P.detailMessage(true), { type: 'detail', on: true });
  assert.deepEqual(P.detailMessage(false), { type: 'detail', on: false });
  assert.deepEqual(P.detailMessage('yes'), { type: 'detail', on: false }, '不是 true 就当 false，绝不发字符串');
  assert.deepEqual(P.pingMessage(), { type: 'ping' });
  assert.deepEqual(P.authMessage('abc'), { type: 'auth', token: 'abc' });
});

test('打的字：半个 emoji 洗掉、超长按整字截到 2000，空的不发', () => {
  assert.equal(P.cleanText('a\uD83Db\uDE00c'), 'abc');
  assert.equal(P.cleanText('猫😀'), '猫😀');
  assert.equal(P.cleanText('\uDE00\uD83D'), '', '顺序反了的一对也是两个落单的');
  const long = 'a'.repeat(1999) + '😀' + 'b';
  const cut = P.cleanText(long);
  assert.equal(cut.length, 1999, '最后那个 emoji 放不下就整个不要，不能切成半个');
  assert.equal(P.cleanText('x'.repeat(2500)).length, 2000);
  assert.equal(P.textMessage('\uD83D'), null);
  assert.equal(P.textMessage(''), null);
  assert.equal(P.textMessage(null), null);
  assert.deepEqual(P.textMessage('你好'), { type: 'text', text: '你好' });
  // 洗过的字转 UTF-8 不会出错（服务器那头 encode 失败 = 整场断开）
  const washed = P.cleanText('x\uD800y\uDFFFz😀');
  assert.equal(Buffer.from(washed, 'utf8').toString('utf8'), washed);
});

test('手指落点换算成帧图像素：不放大、竖着拿', () => {
  const frame = { w: 960, h: 448 };
  // 画布显示 300×140，左上角在 (24, 100)
  const flat = { left: 24, top: 100, right: 324, bottom: 240, width: 300, height: 140 };
  assert.deepEqual(P.framePoint(24, 100, flat, frame, false), { x: 0, y: 0, width: 960, height: 448 });
  assert.deepEqual(P.framePoint(174, 170, flat, frame, false), { x: 480, y: 224, width: 960, height: 448 });
  assert.deepEqual(P.framePoint(999, -5, flat, frame, false), { x: 959, y: 0, width: 960, height: 448 });
  assert.equal(P.framePoint(1, 1, { ...flat, width: 0 }, frame, false), null);
  assert.equal(P.framePoint(1, 1, flat, { w: 0, h: 448 }, false), null);
});

test('手指落点换算成帧图像素：横过来看（整层顺时针转 90°）', () => {
  const frame = { w: 960, h: 448 };
  // 眼里 600×280 的画面，在屏幕上的外框是 280 宽 600 高
  const turned = { left: 40, top: 50, right: 320, bottom: 650, width: 280, height: 600 };
  // 画面左上角在眼里是左上，在屏幕上是外框的右上
  assert.deepEqual(P.framePoint(320, 50, turned, frame, true), { x: 0, y: 0, width: 960, height: 448 });
  // 正中间
  assert.deepEqual(P.framePoint(180, 350, turned, frame, true), { x: 480, y: 224, width: 960, height: 448 });
  // 眼里的右下角 = 屏幕外框的左下
  assert.deepEqual(P.framePoint(40, 650, turned, frame, true), { x: 959, y: 447, width: 960, height: 448 });
  assert.deepEqual(P.displayedSize(turned, true), { w: 600, h: 280 });
  assert.deepEqual(P.displayedSize(turned, false), { w: 280, h: 600 });
});

test('手指落点换算成帧图像素：放大平移以后，捏住的那一点还落在同一个帧像素上', () => {
  const frame = { w: 960, h: 448 };
  const box = { w: 300, h: 140 };
  // 画面框 300×140，左上角 (24, 100)，中心 (174, 170)
  const flat = { left: 24, top: 100, right: 324, bottom: 240, width: 300, height: 140 };
  const before = P.framePoint(99, 170, flat, frame, false);
  assert.deepEqual(before, { x: 240, y: 224, width: 960, height: 448 });

  // 在 (99, 170) 附近两指张开到两倍
  const start = P.pinchStart({ x: 74, y: 170 }, { x: 124, y: 170 }, { scale: 1, tx: 0, ty: 0 });
  const view = P.pinchView(start, { x: 49, y: 170 }, { x: 149, y: 170 }, { x: 174, y: 170 }, box);
  assert.deepEqual(view, { scale: 2, tx: 75, ty: 0 });

  // 放大 2 倍、右移 75 以后，画布的外框（getBoundingClientRect 会给出的样子）
  const cx = 174 + view.tx;
  const cy = 170 + view.ty;
  const zoomed = { left: cx - 300, top: cy - 140, right: cx + 300, bottom: cy + 140, width: 600, height: 280 };
  assert.deepEqual(P.framePoint(99, 170, zoomed, frame, false), before);
  // 放大后框的正中间对着帧图上偏左的地方
  assert.deepEqual(P.framePoint(174, 170, zoomed, frame, false), { x: 360, y: 224, width: 960, height: 448 });
});

test('放大和平移：倍数有上限、平移不出界、几乎没放大就弹回', () => {
  const box = { w: 300, h: 140 };
  const origin = { x: 174, y: 170 };
  const start = P.pinchStart({ x: 164, y: 170 }, { x: 184, y: 170 }, { scale: 1, tx: 0, ty: 0 });
  const huge = P.pinchView(start, { x: 0, y: 170 }, { x: 400, y: 170 }, origin, box);
  assert.equal(huge.scale, P.SCALE_MAX, '最多放大到上限');
  const tiny = P.pinchView(start, { x: 173, y: 170 }, { x: 175, y: 170 }, origin, box);
  assert.deepEqual(tiny, { scale: 1, tx: 0, ty: 0 }, '缩不到 1 倍以下，1 倍时不能挪');
  assert.deepEqual(P.clampPan(2, 500, -500, box), { tx: 150, ty: -70 });
  assert.deepEqual(P.clampPan(1, 30, 30, box), { tx: 0, ty: 0 });
  assert.deepEqual(P.panView({ scale: 2, tx: 0, ty: 20 }, -999, box), { scale: 2, tx: -150, ty: 20 });
  assert.equal(P.isZoomed(1.05), false);
  assert.equal(P.isZoomed(1.1), true);
  assert.deepEqual(P.snapView({ scale: 1.04, tx: 3, ty: 1 }), { scale: 1, tx: 0, ty: 0 });
  const kept = { scale: 1.5, tx: 10, ty: 0 };
  assert.equal(P.snapView(kept), kept);
  assert.ok(P.DETAIL_SCALE > 1 && P.DETAIL_SCALE < P.SCALE_MAX);
});

test('横过来看时，往右划 = 屏幕上往下划；往下拉 = 屏幕上往左', () => {
  const a = P.viewPoint(200, 100, true);
  const b = P.viewPoint(200, 160, true);   // 屏幕上往下 60
  assert.equal(b.x - a.x, 60);
  assert.equal(b.y - a.y, 0);
  const c = P.viewPoint(140, 100, true);   // 屏幕上往左 60
  assert.equal(c.y - a.y, 60);
  assert.deepEqual(P.viewPoint(3, 4, false), { x: 3, y: 4 });
});

test('跟手滚：手指往上推，滚轮往下；零头攒着下次发，慢慢推不会被吃掉', () => {
  const acc = new P.ScrollAccumulator();
  acc.push(-10, 150, 452);           // 往上推 10 → 30.13 帧像素
  assert.equal(acc.take(), 30);
  for (let i = 0; i < 10; i++) acc.push(-0.1, 150, 452);   // 每次只有 0.30
  assert.equal(acc.take(), 3, '十次小推攒出来的 3 帧像素 + 上次的零头');
  acc.push(20, 150, 452);
  assert.ok(acc.take() < 0, '手指往下拉 = 往上滚');
  acc.reset();
  assert.equal(acc.take(), 0);
  acc.push(-10, 0, 452);
  assert.equal(acc.take(), 0, '画面还没尺寸时不滚');
});

test('点一下：手指抖在 12 像素以内都算点，落点用按下的位置', () => {
  const out = play([['down', 1, 100, 100], ['move', 1, 104, 103], ['up', 1, 106, 108]]);
  assert.deepEqual(out, [{ kind: 'tap', x: 100, y: 100 }]);
});

test('上下滑 = 跟手滚，跟点击互斥', () => {
  const out = play([['down', 1, 100, 100], ['move', 1, 100, 90], ['move', 1, 100, 80],
    ['move', 1, 101, 60], ['up', 1, 101, 50]]);
  assert.deepEqual(kinds(out), ['scroll', 'scroll']);
  assert.equal(out.reduce((sum, intent) => sum + intent.dy, 0), -30, '锁定方向之后手指走了多少就滚多少');
  assert.ok(!kinds(out).includes('tap'), '滑过就不再算点');
  // 滑出去又滑回原地再抬手，也不算点
  const back = play([['down', 1, 100, 100], ['move', 1, 100, 70], ['move', 1, 100, 100], ['up', 1, 100, 100]]);
  assert.ok(!kinds(back).includes('tap'));
});

test('横着拖 = 拖（放大时挪画面），松手报总位移；中途改竖着也不会串成滚动，也不算点', () => {
  const out = play([['down', 1, 100, 100], ['move', 1, 80, 101], ['move', 1, 40, 103],
    ['move', 1, 38, 160], ['up', 1, 30, 170]]);
  assert.deepEqual(kinds(out), ['hdrag', 'hdrag', 'hdrag', 'hrelease']);
  assert.equal(out[out.length - 1].dx, -70);
});

test('捏合：松手时一根一根抬起来，最后那根绝不算点击', () => {
  const out = play([['down', 1, 100, 100], ['down', 2, 200, 200], ['move', 2, 240, 240],
    ['up', 1, 100, 100], ['up', 2, 240, 240]]);
  assert.deepEqual(kinds(out), ['pinch-start', 'pinch-move', 'pinch-end']);
  // 抬起顺序反过来也一样
  const reversed = play([['down', 1, 100, 100], ['down', 2, 200, 200], ['up', 2, 200, 200], ['up', 1, 100, 100]]);
  assert.deepEqual(kinds(reversed), ['pinch-start', 'pinch-end']);
  // 剩下那根手指几乎没动就抬起，看着像点一下，也不算
  const still = play([['down', 1, 100, 100], ['down', 2, 160, 100], ['up', 2, 160, 100],
    ['move', 1, 101, 100], ['up', 1, 101, 100]]);
  assert.ok(!kinds(still).includes('tap'));
  // 一轮结束后，下一轮的单指点击照常
  const tracker = new P.GestureTracker();
  tracker.down(1, 0, 0); tracker.down(2, 50, 0); tracker.up(1, 0, 0); tracker.up(2, 50, 0);
  tracker.down(3, 10, 10);
  assert.deepEqual(tracker.up(3, 10, 10), [{ kind: 'tap', x: 10, y: 10 }]);
});

test('滚到一半落下第二根手指：滚动停下转捏合，收手也不点', () => {
  const out = play([['down', 1, 100, 100], ['move', 1, 100, 80], ['move', 1, 100, 60],
    ['down', 2, 200, 60], ['move', 1, 100, 40], ['up', 1, 100, 40], ['move', 2, 210, 60], ['up', 2, 210, 60]]);
  assert.deepEqual(kinds(out), ['scroll', 'pinch-start', 'pinch-move', 'pinch-end']);
});

test('横拖到一半落下第二根手指：先把拖动作废，再转捏合', () => {
  const out = play([['down', 1, 100, 100], ['move', 1, 60, 100], ['down', 2, 200, 100], ['up', 2, 200, 100], ['up', 1, 60, 100]]);
  assert.deepEqual(kinds(out), ['hdrag', 'hcancel', 'pinch-start', 'pinch-end']);
});

test('三根手指：抬起一根按剩下两根重新起算，不会跳', () => {
  const out = play([['down', 1, 0, 0], ['down', 2, 10, 0], ['down', 3, 20, 0],
    ['up', 3, 20, 0], ['up', 2, 10, 0], ['up', 1, 0, 0]]);
  assert.deepEqual(kinds(out), ['pinch-start', 'pinch-start', 'pinch-start', 'pinch-end']);
});

test('系统收走手指：这一轮作废，横拖作废、不点', () => {
  const tracker = new P.GestureTracker();
  tracker.down(1, 100, 100);
  tracker.move(1, 50, 100);
  assert.deepEqual(kinds(tracker.cancel(1)), ['hcancel']);
  assert.deepEqual(tracker.up(1, 50, 100), [], '已经收走的手指再抬起什么都不算');
  tracker.down(4, 10, 10);
  assert.deepEqual(tracker.cancel(4), []);
  assert.equal(tracker.active, false);
});

test('横过来看：竖屏时 CSS 转；系统已经横了就不再转（不转两遍）', () => {
  assert.deepEqual(P.landscapeMode(true, 360, 760), { land: true, rotate: true });
  assert.deepEqual(P.landscapeMode(false, 360, 760), { land: false, rotate: false });
  assert.deepEqual(P.landscapeMode(false, 800, 320), { land: true, rotate: false });
  assert.deepEqual(P.landscapeMode(true, 800, 320), { land: true, rotate: false });
  assert.deepEqual(P.landscapeMode(true, 0, 0), { land: true, rotate: true });
});

test('网站短名、卡片上那行字、网页个数', () => {
  assert.equal(P.siteName('zh.wikipedia.org'), '维基百科');
  assert.equal(P.siteName('www.xiaohongshu.com'), '小红书');
  assert.equal(P.siteName('news.ycombinator.com'), 'Hacker News');
  assert.equal(P.siteName('www.example.org'), 'example.org');
  assert.equal(P.siteName(''), '网页');
  assert.equal(P.siteName(undefined), '网页');
  assert.deepEqual(P.captionOf({ id: 'a', title: 'GitHub', url: '', host: 'github.com' }), { site: 'GitHub', title: '' });
  assert.deepEqual(P.captionOf({ id: 'a', title: ' 阿尔贝·加缪 ', url: '', host: 'zh.wikipedia.org' }),
    { site: '维基百科', title: '阿尔贝·加缪' });
  assert.equal(P.countLabel(2), '开着 2 个网页');
  assert.equal(P.countLabel(0), '现在没有开着的网页');
});

test('断开原因：在别处打开了绝不自动重连，其余网络类的才重连', () => {
  assert.equal(P.friendlyError('replaced').retry, false);
  assert.equal(P.friendlyError('replaced').message, '在别的地方打开了，这里先停下');
  assert.equal(P.friendlyError('unauthorized').retry, false);
  assert.equal(P.friendlyError('stream_timeout').retry, true);
  assert.equal(P.friendlyError('browser_unavailable').retry, true);
  assert.equal(P.friendlyError('whatever').retry, true);
  for (const code of ['window_not_found', 'window_unavailable', 'input_failed', 'no_window']) {
    assert.ok(P.friendlyWarn(code) !== P.friendlyWarn('something_else'), `${code} 要有自己的一句话`);
  }
  assert.equal(P.friendlyWarn('window_not_found'), '那个网页已经关掉了');
});

test('重连等待：一次比一次久，有上限；自动重连次数也有上限', () => {
  assert.equal(P.MAX_RETRIES, 2);
  assert.equal(P.retryDelay(1), 1500);
  assert.equal(P.retryDelay(2), 3000);
  assert.ok(P.retryDelay(2) > P.retryDelay(1));
  assert.equal(P.retryDelay(50), P.retryDelay(P.MAX_RETRIES), '再往后不会无限变长');
  assert.equal(P.retryDelay(0), 1500);
  assert.equal(P.retryDelay(NaN), 1500);
});

test('画面装进可用空间：按宽装不下就按高装', () => {
  assert.deepEqual(P.containFit(2, 300, 400), { w: 300, h: 150 });
  assert.deepEqual(P.containFit(2, 600, 200), { w: 400, h: 200 });
  assert.equal(P.containFit(2, 0, 200), null);
  assert.equal(P.containFit(NaN, 300, 200), null);
});

test('WebSocket 地址：协议跟着当前页换成 ws / wss，host 用当前页的，路径只认本站绝对路径', () => {
  assert.equal(P.viewerSocketUrl('https:', 'example.com', '/vscreen/api/stream/abc/viewer'),
    'wss://example.com/vscreen/api/stream/abc/viewer');
  assert.equal(P.viewerSocketUrl('http:', '127.0.0.1:8080', '/api/stream/abc/viewer'),
    'ws://127.0.0.1:8080/api/stream/abc/viewer');
  assert.equal(P.viewerSocketUrl('https:', 'example.com', '//evil.example/x'), null);
  assert.equal(P.viewerSocketUrl('https:', 'example.com', '/\\evil.example/x'), null);
  assert.equal(P.viewerSocketUrl('https:', 'example.com', 'wss://evil.example/x'), null);
  assert.equal(P.viewerSocketUrl('https:', 'example.com', 'relative/path'), null);
  assert.equal(P.viewerSocketUrl('https:', 'example.com', 42), null);
  assert.equal(P.viewerSocketUrl('https:', '', '/x'), null);
});

test('网址里的口令：从 #token=… 取出来，能放进请求头才算数', () => {
  assert.equal(P.tokenFromHash('#token=abc123'), 'abc123');
  assert.equal(P.tokenFromHash('#token=a%2Bb'), 'a+b');
  assert.equal(P.tokenFromHash('#from=chat&token=x-y_z'), 'x-y_z');
  assert.equal(P.tokenFromHash('#token=%E0%A4%A'), '%E0%A4%A', '解码失败就原样');
  assert.equal(P.tokenFromHash(''), null);
  assert.equal(P.tokenFromHash('#'), null);
  assert.equal(P.tokenFromHash('#tokenx=1'), null);
  assert.equal(P.tokenFromHash('#token='), '');
  assert.equal(P.cleanToken('  abc-123_XYZ \n'), 'abc-123_XYZ');
  assert.equal(P.cleanToken('口令'), '');
  assert.equal(P.cleanToken('a b'), '');
  assert.equal(P.cleanToken(''), '');
  assert.equal(P.cleanToken(null), '');
});
