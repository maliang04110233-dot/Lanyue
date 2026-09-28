/**
 * 极小 DOM 替身：只为"分片渲染 / 定位正在播放 / 拖拽落点"这三条路径提供够用的语义。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * 三个视图的分片渲染都吃 `document` 与 `requestAnimationFrame`，而 node 里两者都没有；
 * 本仓 devDependencies 里**没有 jsdom**（player-sync.test.js 头注记过同一件事），
 * 也不该为了三条路径装一个新 devDependency。所以走打桩。
 *
 * ── 它能测到 / 测不到什么（诚实划界，别把绿灯读成"浏览器里也一定对"）──
 * 能：
 *   · innerHTML / insertAdjacentHTML('beforeend') 的**累积结果**（分片有没有把每一片接上）；
 *   · data-pidx / class / tag 属性选择器与选择器组（定位、拖拽落点、清理高亮读的正是这些）；
 *   · rAF 的**分帧**语义（可手动 flush，于是"同步那一刻只有 100 行"成为可断言的事实）；
 *   · 反馈出口（showToast 记调用），所以"报没报『不在可见列表』"可断言。
 * 不能：
 *   · **不解析 HTML 结构**。它把 innerHTML 当一串拼接文本，按标签开头正则取属性。
 *     片段嵌套错乱、引号不配对这类问题它照样绿 —— 那属于 index.html 与真实 DOM 的地盘。
 *   · `querySelector` 只认 SUPPORTED 列出的形状（tag / #id / .class / [attr] / [attr="v"]，
 *     可空格组合、可逗号分组）。撞上不认得的形状**直接抛**，而不是静默返回 null ——
 *     静默 null 会把"选择器写法变了"伪装成"行不在 DOM"，那正是本次要抓的病。
 *
 * ── 修过的两处（都曾把"测试写对"伪装成"产品写对了"，必须留字）──
 *   ① **#id 曾被当成 class**（2026-09）。`parseSimple` 用同一个 `([#.][\w-]+)`
 *      分支处理井号与点号，两者都推进 `classes`。于是
 *      `document.querySelector('#playlistDetailSongs .song-row[data-pidx="149"]')`
 *      的容器段拿不到 id 属性，走不进"按 id 定位容器"那条分支，恒定返回 null ——
 *      而 `locatePlayingInDetail` 恰恰用这条选择器。症状极具误导性：产品代码是对的，
 *      测试却报"第 150 行不在 DOM"，看起来像缺陷 1 没修好，实则查询根本没生效。
 *      现在 `#` 单独进 `ids`，`matchesSimple` 对 `attrs.id` 判定。
 *   ② **api 桩曾被 extraGlobals 整个顶掉**（同上）。顶掉之后 `api.getPref`
 *      之类的方法不存在，而 `player/lyrics.js:22` 的模块级 `setTimeout` 正好在
 *      import 之后调 `api.getPref(...)` —— 于是一条**定时器里的 TypeError** 把用例
 *      打成 "generated asynchronous activity after the test ended"。
 *      现在 extraGlobals.api 与默认桩共用同一个 Proxy 兜底，测试仍然可以只写
 *      自己关心的两三个通道，其余方法继续有"异步 no-op"可调。
 *   · 元素身份不保持：每次 query 都现造一个伪元素，classList 改动对后续 query 不可见。
 *     断言请落在 data-pidx / 反馈出口调用上，别落在 class 名上。
 *   · 伪元素只参与"它是从哪个容器里被找到的"这一层父子关系（parent/closest/contains 够用），
 *     不模拟真实树的兄弟顺序、不做布局。
 */
'use strict';

const CJK = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;

class SelectorError extends Error {}

// ── 选择器：只认 tag / #id / .class / [attr] / [attr="v"]，可空格组合、可逗号分组 ──
//
// 已知边界：按空白切分，所以**属性值里带空格的选择器**（[title="a b"]）会被切成两半
// 并抛 SelectorError。报错而不是静默 —— 本仓在测的选择器（#容器 .行[data-pidx="N"]、
// .行.pl-dragging 组）都不含带空格的值，真撞上了就该有人来扩这个解析器。
function parseSelector(sel) {
  if (typeof sel !== 'string' || !sel.trim()) throw new SelectorError(`空选择器：${sel}`);
  return sel.split(',').map((group) => {
    const raw = group.trim().split(/\s+/).filter(Boolean);
    if (!raw.length) throw new SelectorError(`空选择器分组：${sel}`);
    // text 保留原始片段：后代查询要拿"容器段之外的那几段"重新拼成 tail，
    // 只凭解析结果拼不回去。
    return raw.map((p) => Object.assign(parseSimple(p), { text: p }));
  });
}

function parseSimple(part) {
  const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(part);
  if (!m) throw new SelectorError(`替身不认得这个选择器片段「${part}」`);
  const [, tag, rest] = m;
  // # 与 . 必须分开收：井号进 ids（对 attrs.id 判定），点号进 classes。
  // 合成一个数组会让 `#container .row` 这种后代查询永远匹配不上（见文件头①）。
  const ids = [];
  const classes = [];
  const attrs = [];
  const re = /#([\w-]+)|\.([\w-]+)|(\[[^\]]+\])/g;
  let r;
  while ((r = re.exec(rest || ''))) {
    if (r[1]) { ids.push(r[1]); continue; }
    if (r[2]) { classes.push(r[2]); continue; }
    const inner = r[3].slice(1, -1);
    const eq = inner.indexOf('=');
    if (eq < 0) attrs.push({ name: inner, value: null });
    else attrs.push({ name: inner.slice(0, eq), value: inner.slice(eq + 1).replace(/^["']|["']$/g, '') });
  }
  return { tag: tag || null, ids, classes, attrs };
}

function matchesSimple(node, simple) {
  if (!node) return false;
  if (simple.tag && node.tag !== simple.tag) return false;
  for (const id of simple.ids) if (String(node.attrs.id) !== id) return false;
  for (const c of simple.classes) if (!node.classes.includes(c)) return false;
  for (const a of simple.attrs) {
    if (!(a.name in node.attrs)) return false;
    if (a.value !== null && String(node.attrs[a.name]) !== a.value) return false;
  }
  return true;
}

/** 从一段 HTML 文本里抽出标签开头的 tag/class/属性（够用即可：见文件头"不解析 HTML 结构"） */
function* tagOpenings(html) {
  const re = /<([a-zA-Z][\w-]*)((?:\s+[^\s=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const are = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = are.exec(m[2] || ''))) {
      attrs[a[1]] = a[2] !== undefined ? a[2]
        : a[3] !== undefined ? a[3]
          : a[4] !== undefined ? a[4] : '';
    }
    yield { tag: m[1].toLowerCase(), attrs, classes: String(attrs.class || '').split(/\s+/).filter(Boolean) };
  }
}

class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this._id = id;
    this._attrs = {};
    this._classes = new Set();
    this._html = '';
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._listeners = new Map();
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
      toggle: (c, on) => { if (on === undefined ? this._classes.has(c) : !on) this._classes.delete(c); else this._classes.add(c); },
    };
    if (id) this._attrs.id = id;
  }

  get id() { return this._id; }
  set id(v) { this._id = v; this._attrs.id = v; }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  getAttribute(name) {
    if (name === 'class') return this.className;
    return name in this._attrs ? this._attrs[name] : null;
  }
  setAttribute(name, value) {
    if (name === 'class') { this.className = value; return; }
    this._attrs[name] = String(value);
  }
  hasAttribute(name) { return name === 'class' ? this.className !== '' : name in this._attrs; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
  insertAdjacentHTML(pos, html) {
    if (pos !== 'beforeend') throw new SelectorError(`替身只实现了 beforeend，收到 ${pos}`);
    this._html += String(html);
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  remove() {}
  focus() {}
  click() {}
  contains(node) {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  closest(sel) {
    const groups = parseSelector(sel);
    for (let n = this; n; n = n.parent) {
      const node = { tag: n.tagName.toLowerCase(), attrs: n._attrs, classes: [...n._classes] };
      if (groups.some((parts) => matchesAllParts(node, parts))) return n;
    }
    return null;
  }
  querySelectorAll(sel) { return selectIn([this], sel, false); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((f) => f !== fn));
  }
  dispatch(type, ev = {}) { return dispatchOn(this, type, ev); }
  scrollIntoView() { this.scrolledIntoView = (this.scrolledIntoView || 0) + 1; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
}

function matchesAllParts(node, parts) {
  // 从右往左看：只校验"末段命中"+"其余段是祖先链上的 id/类"。本替身不做真 DOM 遍历，
  // 祖先段只在 document 级查询里按 id 定位容器时用得上（见 FakeDoc.querySelectorAll）。
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!matchesSimple(node, parts[i])) return false;
  }
  return true;
}

function nodeToFake(node, owner) {
  const el = new FakeEl(node.tag);
  el._attrs = { ...node.attrs };
  el._classes = new Set(node.classes);
  el.parent = owner || null;
  el.style = {};
  return el;
}

/** 在若干容器的 innerHTML 文本里按选择器找节点 */
function selectIn(roots, sel, includeSelf) {
  const groups = parseSelector(sel);
  const out = [];
  for (const root of roots) {
    if (includeSelf) {
      const self = { tag: root.tagName.toLowerCase(), attrs: root._attrs, classes: [...root._classes] };
      if (groups.some((parts) => matchesAllParts(self, parts))) out.push(root);
    }
    for (const node of tagOpenings(root.innerHTML || '')) {
      if (groups.some((parts) => matchesAllParts(node, parts))) out.push(nodeToFake(node, root));
    }
  }
  return out;
}

function makeEvent(type, ev, target) {
  const e = {
    type,
    target,
    dataTransfer: ev.dataTransfer,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { e.defaultPrevented = true; },
    stopPropagation() { e.propagationStopped = true; },
  };
  return e;
}

function dispatchOn(owner, type, ev = {}) {
  const e = makeEvent(type, ev, ev.target || owner);
  for (const fn of owner._listeners.get(type) || []) fn(e);
  return e;
}

class FakeDoc {
  constructor() {
    this._byId = new Map();
    this._listeners = new Map();
    /**
     * 每一次 querySelector* 返回过的伪元素都留一份。
     * 为什么需要：伪元素每次现造，"行有没有被 flashRow 闪过"这种**行为**只能靠
     * "被返回出去的那个对象身上留下了痕迹"来观察（flashRow 会调 row.scrollIntoView
     * 并写 row.style.outline）。不记这一笔就只能断言"没报 toast"，那太弱。
     */
    this.queried = [];
    this.body = new FakeEl('body');
    this.documentElement = new FakeEl('html');
  }
  /** 登记一个 id → 元素（测试自己摆容器） */
  register(id, el) { el.id = id; this._byId.set(id, el); return el; }
  /**
   * 取 id；没登记过就**现造一个并缓存**。
   *
   * 为什么不是返回 null：player.js 顶层就有 `document.getElementById('audioPlayer').addEventListener`，
   * 而视图模块的依赖图会去摸几十个 id（真身都在 index.html 里）。返回 null 会让
   * "本测试没摆这个容器"变成一条看不懂的 TypeError；现造一个空壳能让依赖图安静求值，
   * 注意力回到被测的那三段。测试要断言的容器一律**预先 register**，读回同一个实例。
   */
  getElementById(id) {
    if (!this._byId.has(id)) this._byId.set(id, this._makeStub(id));
    return this._byId.get(id);
  }
  _makeStub(id) {
    const el = new FakeEl('div');
    el.id = id;
    return el;
  }
  createElement(tag) { return new FakeEl(tag); }
  /**
   * 支持 "#container .song-row[data-pidx=\"7\"]" 这种后代查询：按 id 定位容器，
   * 再在容器的 innerHTML 里找末段。没有 #id 前缀时扫所有已登记元素。
   *
   * 两处坑，都在文件头①里提过，这里再说一遍是因为它们各自伪装成"产品有 bug"：
   *   ① 容器 id 要从**井号**（simple.ids）取，不是从 [id="…"] 属性取；
   *   ② 判定条件是"**首段**是不是 id"，**不是** groups[0].length === 1。
   *      后代选择器的首段与末段都在 groups[0] 里（长度 2），首版拿 === 1 去卡，
   *      于是这条分支对任何后代查询都进不去，静默掉进"扫所有元素"那条路 ——
   *      那条路要求所有段命中同一个节点，容器段永远匹配不上，查询恒返回 null。
   */
  querySelectorAll(sel) {
    const groups = parseSelector(sel);
    const head = groups[0][0];
    const byHash = head.ids && head.ids.length ? head.ids[0] : null;
    const byAttr = head.attrs.find((a) => a.name === 'id' && a.value !== null);
    const ancestorId = byHash || (byAttr ? byAttr.value : null);
    if (ancestorId) {
      const box = this._byId.get(ancestorId);
      if (!box) return [];
      if (groups[0].length === 1) { this.queried.push(box); return [box]; }
      const tail = groups[0].slice(1).map((s) => s.text).join(' ');
      const out = box.querySelectorAll(tail);
      this.queried.push(...out);
      return out;
    }
    const out = selectIn([...this._byId.values()], sel, false);
    this.queried.push(...out);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter((f) => f !== fn));
  }
  dispatch(type, ev = {}) { return dispatchOn(this, type, ev); }
}

/**
 * 装一套浏览器全局，返回控制句柄。
 * @param {object} opts
 *   - raf: 'auto'（setTimeout 0）或 'manual'（测试自己 flush 帧）
 *   - ids: 预先登记的空元素 id
 *   - extraGlobals: 追加/覆盖的全局（api / getState / showToast …）
 */
function installBrowserGlobals(opts = {}) {
  const doc = new FakeDoc();
  for (const id of opts.ids || []) doc.register(id, new FakeEl('div'));
  const rafQueue = [];
  const toasts = [];

  // api 用 Proxy 兜住"依赖图在模块顶层摸过某个通道"这件事：任何方法名都返回一个
  // 异步 no-op。测试要观察某条通道时用 extraGlobals.api 覆盖掉这个默认值。
  //
  // queryHistory 故意抛错：dlStatus.dlEnsureHistoryLoaded() 拿到回执后会 _fire()，
  // playlist.js 由此注册了一个 **300ms 防抖** 的重渲染定时器 —— 那是产品行为，不是被测
  // 行为，却会在测试里凭空插一次重渲染把断言搅乱（实测踩过：定位测试莫名其妙地
  // 报「不在可见列表」）。让懒回填直接失败，那条防抖链就不会被点燃。
  //
  // ⚠️ extraGlobals.api 也必须过这层兜底（见文件头②）：测试只写自己关心的两三个通道
  //   是对的写法，但"其余通道不存在"会让依赖图里那条模块级 setTimeout 在**定时器里**
  //   抛 TypeError —— 报错点在测试体之外，红起来像异步活动泄漏，实则是桩漏了一个方法。
  const makeApiStub = (own) => new Proxy({
    queryHistory: async () => { throw new Error('dl history intentionally not loaded in tests'); },
    ...(own || {}),
  }, {
    get: (t, k) => (k in t ? t[k] : (t[k] = async () => ({ success: true }))),
  });

  const base = {
    document: doc,
    window: globalThis,
    location: { hostname: 'localhost', protocol: 'http:' },
    addEventListener: () => {},
    removeEventListener: () => {},
    cancelAnimationFrame: () => {},
    showToast: (msg, kind) => { toasts.push({ msg, kind }); },
    showActionToast: (o) => { toasts.push({ msg: o && o.text, kind: 'action' }); },
    askConfirm: async () => true,
    setState: () => {},
    getState: () => null,
    api: makeApiStub(),
    esc: (s) => String(s),
    escAttr: (s) => String(s),
    escQ: (s) => String(s),
    fmtDuration: (s) => String(s),
    formatBytes: (s) => String(s),
    applyTheme: () => {},
    renderQueue: () => {},
    audio: new FakeEl('audio'),
    confirm: () => true,
    alert: () => {},
  };
  const apply = () => {
    globalThis.requestAnimationFrame = opts.raf === 'manual'
      ? (cb) => { rafQueue.push(cb); }
      : (cb) => setTimeout(() => cb(Date.now()), 0);
    for (const [k, v] of Object.entries(base)) globalThis[k] = v;
    // api 走兜底桩而不是裸对象：见上面 makeApiStub 的注（extraGlobals.api 只写关心的通道）
    for (const [k, v] of Object.entries(opts.extraGlobals || {})) {
      globalThis[k] = k === 'api' ? makeApiStub(v) : v;
    }
  };
  apply();

  return {
    doc,
    toasts,
    /**
     * 把全局桩**重新钉一遍**。
     *
     * 为什么需要：视图模块的依赖图里有 src/renderer/js/state.js，它的模块顶层写着
     * `window.getState = getState; window.setState = setState;`（state.js:244）——
     * 一 import 就把测试的桩顶掉，之后 getState 读的是真 store（空的）。
     * 所以顺序必须是：先装桩 → import 视图 → 再钉回去。loadView 会自动做后一步。
     */
    reinstall: apply,
    /** 累计被 querySelector* 返回过的伪元素（观察"行有没有真的被闪"） */
    queried() { return doc.queried; },
    /** 跑掉一帧 rAF（manual 模式用）；返回"还有没有待跑帧" */
    flushFrame() {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(0);
      return rafQueue.length > 0;
    },
    pendingFrames() { return rafQueue.length; },
    element(id) { return doc.getElementById(id); },
  };
}

/** 让出事件循环若干轮（auto 模式下 rAF 是 setTimeout(0)，必须真的让出去） */
function tick(times = 1) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

module.exports = { FakeEl, FakeDoc, SelectorError, installBrowserGlobals, tick, CJK, parseSelector };
