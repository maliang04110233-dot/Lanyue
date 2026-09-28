/**
 * domStub 的一个家（收口，口径同 148/151/185「手抄清单必漏」）
 *
 * 来龙：182 → 186 → 193 三份测试各自手抄了一份"形状同前"的桩。193 给 welcome
 * 换掉内联 onclick（改 data-welcome + 事件委托）后，186 抄的那份立刻漏掉三件
 * 真 DOM 语义（innerHTML 解析钮、click 冒泡、querySelectorAll 寻焦），两个行为
 * 测当场炸 TypeError——漂移不是预言，是已经发生了。所以桩收进这一个家，
 * welcome/confirm 的键盘与点击契约测试一律从这里取。
 *
 * 承诺面 = 被测代码真正用到的 DOM 子集，多一个都不给：
 * ① innerHTML 赋值解析出 <button>/<input>/<div> 子元素（class/id/data 属性/文本），序=模板序；
 * ② click 沿 parent 链冒泡（委托型宿主因此能收到钮点击）；
 * ③ querySelectorAll('button') 递归收后代（焦点陷阱的寻焦面）；
 * ④ document 监听分 capture/bubble 两队列，removeEventListener 按 (type,fn,capture) 摘除；
 * ⑤ classList（add/remove/toggle(cls,force)/contains）骑在 className 字符串上，
 * 与真 DOM 同源——直接赋 className 也会反映进 classList（cmdk 用
 *    classList.toggle 高亮行、classList.add('hidden') 关面板）；
 * ⑥ el.id 赋值即注册进 doc 的 getElementById 索引（cmdk 全靠 id 寻物，
 *    模板里解析出的 id 同样入索）。
 * ⑦ 复合选择器（浮层注册表按形状扫描 DOM）：'button' | '#id' |
 *    '[attr]' | '[attr]:not(.cls)' 四种形式，元素级只寻后代、document 级从 body
 *    起走；[attr] 认「属性存在」（值为空串也命中，与真 DOM 裸属性同义），
 *    :not(.cls) 按 class token 精确剔除；其余形式直接 throw——桩宁可炸也不静默
 *    漏答（195-⑦「莫名绿」教训的镜像：静默跳过=另一种说谎）。
 * 182 的 confirm-dialog.test.js 仍自带一份（只喂 confirm 的 createElement 路径，
 * 未触及①②③），并入本家属独立小增量，此处不顺手扩大爆炸半径。
 */

// 选择器解析（承诺面 ⑦）。未知形式 throw，防桩把不认识的键悄悄当"无一人"。
function parseSel(sel) {
  if (sel === 'button') return { kind: 'tag', tag: 'button' };
  let m = /^#([\w-]+)$/.exec(sel);
  if (m) return { kind: 'id', id: m[1] };
  m = /^\[([\w-]+)\](?::not\(\.([\w-]+)\))?$/.exec(sel);
  if (m) return { kind: 'attr', attr: m[1], notClass: m[2] || null };
  throw new Error('桩只承诺 button/#id/[attr](:not(.cls)) 形式，收到: ' + sel);
}
function selMatches(el, s) {
  if (s.kind === 'tag') return el.tag === s.tag;
  if (s.kind === 'id') return el.attrs.id === s.id;
  if (!(s.attr in el.attrs)) return false;
  if (s.notClass && el.classList.contains(s.notClass)) return false;
  return true;
}
function findAll(root, sel) {
  const s = parseSel(sel);
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (selMatches(c, s)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

function stubEl(tag, doc) {
  const el = {
    // style 是承诺面（⑭）：真实模块写 hint.style.cssText，桩缺 style 就 TypeError
    tag, parent: null, children: [], className: '', textContent: '', attrs: {}, _l: {}, _html: '', style: {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'id') doc._ids[this.attrs.id] = this;
    },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
      if (this.attrs.id && doc._ids[this.attrs.id] === this) delete doc._ids[this.attrs.id];
      this.parent = null;
    },
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); },
    focus() { doc.activeElement = this; },
    click() {
      const ev = { type: 'click', target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      let node = this;
      while (node) {
        (node._l.click || []).forEach((fn) => fn(ev));
        node = node.parent;
      }
      return ev;
    },
    querySelectorAll(sel) { return findAll(this, sel); },
    querySelector(sel) { return findAll(this, sel)[0] || null; },
  };
  // id 走真 DOM 语义：赋 el.id = 'x' 即写入 attrs 并注册 getElementById 索引
  Object.defineProperty(el, 'id', {
    get() { return this.attrs.id || ''; },
    set(v) { this.attrs.id = String(v); doc._ids[v] = this; },
  });
  Object.defineProperty(el, 'classList', {
    get() {
      const tokens = () => (el.className ? el.className.split(/\s+/).filter(Boolean) : []);
      const put = (list) => { el.className = list.join(' '); };
      const api = {
        contains: (c) => tokens().includes(c),
        add: (...cs) => { const t = tokens(); cs.forEach((c) => { if (!t.includes(c)) t.push(c); }); put(t); },
        remove: (...cs) => put(tokens().filter((c) => !cs.includes(c))),
      };
      api.toggle = (c, force) => {
        const on = force === undefined ? !api.contains(c) : !!force;
        if (on) api.add(c); else api.remove(c);
        return on;
      };
      return api;
    },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) {
      this._html = v;
      // 展平解析（真 DOM 会保留嵌套；本桩的宿主只把后代当 Tab 序/寻焦面，
      // findClass/querySelectorAll 都递归 children，压平不影响其语义）——
      // 钮文本、input 属性、空 div（如 cmdkList）各按自身形状收。
      let m;
      const bre = /<button([^>]*)>([^<]*)<\/button>/g;
      while ((m = bre.exec(v))) {
        const b = stubEl('button', doc);
        const cm = m[1].match(/class="([^"]*)"/);
        b.className = cm ? cm[1] : '';
        // 任意 data-* 都收（委托认领钮靠的是 data-update-manual）。
        // 原先硬抄 ['data-welcome']，第二个被委托的模块一进来就得再改一次桩——
        // 口径同 193 的"手抄清单必漏"，属性面也一样。
        for (const am of m[1].matchAll(/(data-[\w-]+|id)="([^"]*)"/g)) {
          b.attrs[am[1]] = am[2];
          if (am[1] === 'id') doc._ids[am[2]] = b;
        }
        b.textContent = m[2].trim();
        b.parent = this;
        this.children.push(b);
      }
      const ire = /<input([^>]*?)\/?>/g;
      while ((m = ire.exec(v))) {
        const i = stubEl('input', doc);
        for (const attr of ['id', 'class', 'placeholder', 'autocomplete', 'spellcheck']) {
          const am = m[1].match(new RegExp(attr + '="([^"]*)"'));
          if (am) {
            if (attr === 'class') i.className = am[1];
            else { i.attrs[attr] = am[1]; if (attr === 'id') doc._ids[am[1]] = i; }
          }
        }
        i.parent = this;
        this.children.push(i);
      }
      const dre = /<div([^>]*)><\/div>/g;
      while ((m = dre.exec(v))) {
        const d = stubEl('div', doc);
        const cm = m[1].match(/class="([^"]*)"/);
        d.className = cm ? cm[1] : '';
        const im = m[1].match(/id="([^"]*)"/);
        if (im) { d.attrs.id = im[1]; doc._ids[im[1]] = d; }
        d.parent = this;
        this.children.push(d);
      }
    },
  });
  return el;
}

export function makeDomStub() {
  const doc = {
    activeElement: null, _cap: [], _bub: [], _ids: {},
    createElement: (tag) => stubEl(tag, doc),
    getElementById: (id) => doc._ids[id] || null,
    addEventListener(type, fn, capture) { (capture ? doc._cap : doc._bub).push({ type, fn }); },
    removeEventListener(type, fn, capture) {
      const arr = capture ? doc._cap : doc._bub;
      const i = arr.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  doc.body = stubEl('body', doc);
  // document 级寻物从 body 起走（承诺面 ⑦：浮层注册表的 document.querySelector 走这条）
  doc.querySelector = (sel) => findAll(doc.body, sel)[0] || null;
  doc.querySelectorAll = (sel) => findAll(doc.body, sel);
  return doc;
}

export function findClass(el, cls) {
  if (el.className.split(/\s+/).includes(cls)) return el;
  for (const c of el.children) {
    const hit = findClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

// 相位语义与真 DOM 一致：document capture 按注册序 → 目标元素 → document 冒泡；
// stopImmediatePropagation 掐断同队列后续，stopPropagation 掐断后续相位。
// 第 4 参承 193 调用方传布尔 shiftKey 的老形状，也接受 {shiftKey,ctrlKey,metaKey,isComposing}。
export function dispatchKey(doc, key, target, opts) {
  const o = (opts && typeof opts === 'object') ? opts : { shiftKey: !!opts };
  const ev = {
    key, type: 'keydown', target,
    shiftKey: !!o.shiftKey, ctrlKey: !!o.ctrlKey, metaKey: !!o.metaKey,
    isComposing: !!o.isComposing,
    defaultPrevented: false, propagationStopped: false, immediateStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
  };
  // 目标元素登记的是裸函数数组（addEventListener 直推 fn），document 队列是 {type,fn}——两形都吃。
  // 本行曾只认 {type,fn} 形状，目标监听被静默跳过、无一测试踩到（193 的键全走 capture 层）；
  // 195 第一个消费元素自带 keydown 的文件把它照出来——"莫名绿"也是漂移证据。
  const run = (list) => {
    for (const l of [...list]) {
      if (ev.immediateStopped) return;
      const fn = typeof l === 'function' ? l : (l.type === 'keydown' ? l.fn : null);
      if (fn) fn(ev);
    }
  };
  run(doc._cap);
  if (!ev.propagationStopped) run((target && target._l.keydown) || []);
  if (!ev.propagationStopped) run(doc._bub);
  return ev;
}

export const flush = () => new Promise((r) => setImmediate(r));
