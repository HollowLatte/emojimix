/* ===========================================================
   emojimix 复刻版 · 逻辑
   -----------------------------------------------------------
   原理：
   1. 数据集里每个 emoji 记录了 [码点, 素材批次日期, 关键词]
   2. 合成图是 Google 预先画好的静态图，地址可拼出来：
      https://www.gstatic.com/android/keyboard/emojikitchen/
        {日期}/{左emoji的u码}/{左}_{右}.png
   3. 拼出来的地址可能 404（顺序或批次不对），依次尝试其它组合
   4. 全都不存在时，用 canvas 把两个表情叠一张图作兜底
   =========================================================== */

const API = "https://www.gstatic.com/android/keyboard/emojikitchen/";

/* ---------- 小工具 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const hexOf = (cps) => cps.filter((c) => c !== 0xfe0f).map((c) => c.toString(16)).join("_");
const uOf = (cps) => cps.map((c) => "u" + c.toString(16)).join("-");
const charOf = (cps) => String.fromCodePoint(...cps);

function readVarInt(name, fallback) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

/* ---------- 构建表情模型 ---------- */
const emojis = EMOJI_DATA.map((row, index) => {
  const cps = row[0];
  const key = hexOf(cps);
  const zh = (typeof EMOJI_ZH !== "undefined" && EMOJI_ZH[key]) || "";
  const en = row[2];
  return {
    index,
    cps,
    key,
    date: row[1],
    en,
    zh,
    char: charOf(cps),
    src: `emojis/${key}.svg`,
    haystack: (en.join(" ") + " " + zh + " " + charOf(cps)).toLowerCase(),
  };
});

const byKey = new Map(emojis.map((e) => [e.key, e]));

/* ---------- 本地存储 ---------- */
const LS = {
  fav: "emojimix.fav.v1",
  theme: "emojimix.theme",
  sound: "emojimix.sound",
  vibe: "emojimix.vibe",
  hint: "emojimix.hint",
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/* ---------- 音效 ---------- */
let audioCtx = null;
function beep(freq = 520, ms = 26) {
  if (!store.get(LS.sound, true)) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = 0.05;
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch {}
}

function buzz(pattern = 6) {
  if (!store.get(LS.vibe, true)) return;
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/* ---------- Toast ---------- */
const toastEl = $("#toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 1700);
}

/* ---------- 滚轮 ---------- */
class Wheel {
  constructor(root, onChange) {
    this.root = root;
    this.onChange = onChange;
    this.index = 0;
    this.itemH = readVarInt("--item-h", 52);
    this.frozen = false;
    this.painted = new Set();
    this.build();
    this.bind();
  }

  build() {
    const frag = document.createDocumentFragment();
    emojis.forEach((e, i) => {
      const cell = document.createElement("div");
      cell.className = "wheel-item";
      cell.dataset.i = i;
      const img = document.createElement("img");
      img.src = e.src;
      img.alt = e.zh || e.char;
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      cell.append(img);
      frag.append(cell);
    });
    this.root.append(frag);
    this.cells = [...this.root.children];
  }

  bind() {
    let raf = 0;
    this.animating = false;
    this.settleTimer = 0;

    this.root.addEventListener(
      "scroll",
      () => {
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            this.sync();
          });

        // 手指/滚轮停下后，自动吸到最近的那一格
        if (this.animating) return;
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => this.settle(), 150);
      },
      { passive: true }
    );

    // 点某一格 = 选中它
    this.root.addEventListener("click", (ev) => {
      const cell = ev.target.closest(".wheel-item");
      if (!cell) return;
      this.center(+cell.dataset.i, true);
    });

    // 键盘
    this.root.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        this.center(this.index + 1, true);
        ev.preventDefault();
      } else if (ev.key === "ArrowUp") {
        this.center(this.index - 1, true);
        ev.preventDefault();
      }
    });
  }

  sync() {
    const raw = this.root.scrollTop / this.itemH;
    const i = Math.min(emojis.length - 1, Math.max(0, Math.round(raw)));
    this.paint(i);
    if (i !== this.index) {
      this.index = i;
      if (!this.frozen) this.onChange(i);
    }
  }

  /** 停止滚动后吸附到最近一格 */
  settle() {
    if (this.animating) return;
    const i = Math.min(emojis.length - 1, Math.max(0, Math.round(this.root.scrollTop / this.itemH)));
    const target = i * this.itemH;
    if (Math.abs(this.root.scrollTop - target) > 1.5) {
      this.center(i, true);
    } else if (i !== this.index) {
      this.index = i;
      this.onChange(i);
    }
  }

  paint(center) {
    const from = Math.max(0, center - 5);
    const to = Math.min(emojis.length - 1, center + 5);
    for (let i = from; i <= to; i++) {
      const d = Math.abs(i - center);
      const s = Math.max(0.5, 1.26 - 0.23 * d).toFixed(3);
      const o = Math.max(0.2, 1 - 0.28 * d).toFixed(3);
      const cell = this.cells[i];
      if (cell._s === s) continue;
      cell._s = s;
      cell.style.setProperty("--s", s);
      cell.style.setProperty("--o", o);
      this.painted.add(i);
    }
    for (const i of this.painted) {
      if (i >= from && i <= to) continue;
      const cell = this.cells[i];
      cell.style.removeProperty("--s");
      cell.style.removeProperty("--o");
      cell._s = null;
      this.painted.delete(i);
    }
  }

  /** 直接定位（不带动画） */
  jump(i) {
    i = Math.min(emojis.length - 1, Math.max(0, i));
    this.index = i;
    this.root.scrollTop = i * this.itemH;
    this.paint(i);
  }

  /** 带缓动滚到某一格，做出老虎机的手感 */
  center(i, animate = true) {
    i = Math.min(emojis.length - 1, Math.max(0, i));
    if (!animate) return this.jump(i);

    const start = this.root.scrollTop;
    const target = i * this.itemH;
    if (Math.abs(target - start) < 2) {
      this.jump(i);
      this.onChange(i);
      return;
    }
    const dur = Math.min(760, 260 + Math.abs(target - start) * 1.1);
    const t0 = performance.now();

    this.frozen = true;
    this.animating = true;
    clearTimeout(this.settleTimer);

    return new Promise((resolve) => {
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        this.root.scrollTop = start + (target - start) * e;
        this.paint(Math.round(this.root.scrollTop / this.itemH));
        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          this.root.scrollTop = target;
          this.frozen = false;
          this.animating = false;
          this.index = i;
          this.paint(i);
          beep(700, 16);
          this.onChange(i);
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  /** 随机并滚过去 */
  random() {
    let next = Math.floor(Math.random() * emojis.length);
    if (next === this.index) next = (next + 1 + Math.floor(Math.random() * 8)) % emojis.length;
    return this.center(next, true);
  }

  refreshScale() {
    this.itemH = readVarInt("--item-h", 52);
    this.jump(this.index);
  }
}

/* ---------- 组合地址解析 ---------- */
const candidates = (a, b) => {
  const A = uOf(a.cps);
  const B = uOf(b.cps);
  return [...new Set([
    `${API}${a.date}/${A}/${A}_${B}.png`, // 正向 × 左侧批次
    `${API}${b.date}/${B}/${B}_${A}.png`, // 反向 × 右侧批次
    `${API}${b.date}/${A}/${A}_${B}.png`, // 正向 × 另一批次
    `${API}${a.date}/${B}/${B}_${A}.png`, // 反向 × 另一批次
  ])];
};

const probeCache = new Map();

/**
 * 探测某个地址是否真的存在。
 * 必须带超时：网络卡住时 new Image() 会一直挂着，界面就永久 loading。
 * 超时的结果不写缓存，下次还有机会重试。
 */
function probe(url, timeout = 5000) {
  if (probeCache.has(url)) return probeCache.get(url);

  const p = new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    let timedOut = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve({ ok, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish(false);
    }, timeout);

    img.crossOrigin = "anonymous";
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });

  p.then((r) => {
    if (r.timedOut) probeCache.delete(url);
  });

  probeCache.set(url, p);
  return p;
}

const RESOLVE_BUDGET = 8000;
const resolveCache = new Map();

function resolve(a, b) {
  const key = `${a.key}+${b.key}`;
  if (resolveCache.has(key)) return resolveCache.get(key);

  const p = (async () => {
    const list = candidates(a, b);
    const started = Date.now();

    // 第一个候选最可能命中，单独试，命中就只花一次请求
    const first = await probe(list[0]);
    if (first.ok) return list[0];
    if (Date.now() - started > RESOLVE_BUDGET) return null;

    // 没中就把剩下三个并发试，省掉三次串行往返
    const rest = await Promise.all(
      list.slice(1).map((url) => probe(url).then((r) => (r.ok ? url : null)))
    );
    return rest.find(Boolean) || null;
  })();

  resolveCache.set(key, p);
  return p;
}

/* ---------- 兜底：canvas 叠图 ---------- */
const backgroundish = [["heart", "rainbow", "colour"], ["explosion"]];
const fakeCache = new Map();

const loadImg = (src, cors = false) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

async function fakeMix(a, b) {
  const key = `${a.key}+${b.key}`;
  if (fakeCache.has(key)) return fakeCache.get(key);

  let left = a;
  let right = b;
  if (backgroundish.some((set) => set.every((s) => b.en.includes(s)))) [left, right] = [b, a];

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 534;
  const ctx = canvas.getContext("2d");
  try {
    const [img1, img2] = await Promise.all([loadImg(left.src), loadImg(right.src)]);
    ctx.drawImage(img1, 0, 0, 534, 534);

    // 第二张稍微压暗一点再叠上去，看起来像"叠了一层"而不是贴错图
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.28)";
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 6;
    ctx.drawImage(img2, 152, 152, 240, 240);
    ctx.restore();

    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const url = URL.createObjectURL(blob);
    fakeCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}

/* ---------- DOM ---------- */
const wheel1 = new Wheel($("#wheel1"), queueRender);
const wheel2 = new Wheel($("#wheel2"), queueRender);
const output = $("#output");
const placeholder = $("#placeholder");
const noMix = $("#noMix");
const spinner = $("#spinner");
const stage = $("#stage");
const heartBtn = $("#btnHeart");
const favBadge = $("#favBadge");

let renderToken = 0;
let renderTimer = 0;
let spinTimer = 0;

/** 以滚轮当前位置为准，避免防抖期间取到旧值 */
const pair = () => [emojis[wheel1.index], emojis[wheel2.index]];

function queueRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 70);
}

function setImage(url, isBlob) {
  if (!url) return;
  if (isBlob) output.removeAttribute("crossorigin");
  else output.setAttribute("crossorigin", "anonymous");
  output.hidden = false;
  placeholder.hidden = true;
  noMix.hidden = true;
  output.style.animation = "none";
  void output.offsetWidth;
  output.style.animation = "";
  output.src = url;
}

/** 官方没画过、且兜底也做不出来时的状态 */
function showNoMix() {
  output.hidden = true;
  output.removeAttribute("src");
  placeholder.hidden = true;
  noMix.hidden = false;
}

async function render() {
  const token = ++renderToken;
  const a = emojis[wheel1.index];
  const b = emojis[wheel2.index];

  clearTimeout(spinTimer);
  spinTimer = setTimeout(() => {
    if (token === renderToken) spinner.hidden = false;
  }, 220);

  syncURL();
  refreshHeart();

  const url = await resolve(a, b);
  if (token !== renderToken) return;

  if (url) {
    setImage(url, false);
  } else {
    const fake = await fakeMix(a, b);
    if (token !== renderToken) return;
    if (fake) setImage(fake, true);
    else showNoMix();
  }

  clearTimeout(spinTimer);
  spinner.hidden = true;
}

/* ---------- 地址栏同步 ---------- */
function syncURL() {
  const a = emojis[wheel1.index];
  const b = emojis[wheel2.index];
  const hash = `#${a.char}+${b.char}`;
  try {
    history.replaceState(null, "", hash);
  } catch {}
}

function loadFromURL() {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (!raw.includes("+")) return false;
  const [left, right] = raw.split("+");
  const parse = (str) => {
    if (!str) return null;
    const cps = [...str].map((c) => c.codePointAt(0));
    return byKey.get(hexOf(cps)) || null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return false;
  wheel1.jump(a.index);
  wheel2.jump(b.index);
  render();
  return true;
}

/* ---------- 收藏 ---------- */
function getFavs() {
  const list = store.get(LS.fav, []);
  return Array.isArray(list) ? list : [];
}

function setFavs(list) {
  store.set(LS.fav, list);
  refreshHeart();
  refreshFavBadge();
  if ($("#panel-fav").classList.contains("is-active")) renderFavs();
}

function favKey(a, b) {
  return `${a.key}|${b.key}`;
}

function isFaved(a, b) {
  const k = favKey(a, b);
  return getFavs().some((f) => f.k === k);
}

function toggleFav() {
  const [a, b] = pair();
  const k = favKey(a, b);
  const list = getFavs();
  const at = list.findIndex((f) => f.k === k);
  if (at >= 0) {
    list.splice(at, 1);
    toast("已取消收藏");
  } else {
    list.unshift({ k, a: a.key, b: b.key, t: Date.now() });
    toast("已收藏");
  }
  setFavs(list);
  buzz(8);
}

function refreshHeart() {
  const [a, b] = pair();
  const on = isFaved(a, b);
  heartBtn.classList.toggle("is-on", on);
  heartBtn.setAttribute("aria-pressed", String(on));
  heartBtn.querySelector("span").textContent = on ? "已收藏" : "收藏";
}

function refreshFavBadge() {
  const n = getFavs().length;
  favBadge.hidden = n === 0;
  favBadge.textContent = n > 99 ? "99+" : String(n);
}

async function renderFavs() {
  const grid = $("#favGrid");
  const empty = $("#favEmpty");
  const list = getFavs();
  grid.innerHTML = "";
  empty.hidden = list.length > 0;

  for (const f of list) {
    const a = byKey.get(f.a);
    const b = byKey.get(f.b);
    if (!a || !b) continue;

    const card = document.createElement("div");
    card.className = "fav-card";
    card.title = `${a.zh || a.char} + ${b.zh || b.char}`;

    const img = document.createElement("img");
    img.alt = card.title;
    img.loading = "lazy";
    card.append(img);

    const url = await resolve(a, b);
    if (url) img.src = url;
    else {
      const fake = await fakeMix(a, b);
      if (fake) img.src = fake;
    }

    const del = document.createElement("button");
    del.className = "fav-del";
    del.textContent = "×";
    del.title = "删除";
    del.onclick = (ev) => {
      ev.stopPropagation();
      setFavs(getFavs().filter((x) => x.k !== f.k));
      toast("已删除");
    };
    card.append(del);

    card.onclick = () => {
      wheel1.jump(a.index);
      wheel2.jump(b.index);
      render();
      switchTab("mix");
    };

    grid.append(card);
  }
}

/* ---------- 标签页 ---------- */
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  $("#panel-mix").classList.toggle("is-active", name === "mix");
  $("#panel-fav").classList.toggle("is-active", name === "fav");
  if (name === "fav") renderFavs();
}

$$(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

/* ---------- 导出图片 ---------- */
async function toBlob() {
  if (!noMix.hidden) throw new Error("这对没有官方图");
  const src = output.src;
  if (!src) throw new Error("还没有合成结果");
  const img = await loadImg(src, !src.startsWith("blob:"));
  const size = img.naturalWidth || 534;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, size, size);
  return new Promise((r) => canvas.toBlob(r, "image/png"));
}

const filename = () => {
  const [a, b] = pair();
  return `emojimix_${a.char}_${b.char}.png`;
};

/** 导出失败时的提示：区分"没有图"和"浏览器不支持" */
const failToast = (err, fallback) =>
  toast(err && err.message === "这对没有官方图" ? "这对没有官方图，换个组合吧" : fallback);

async function copyImage() {
  try {
    const blob = await toBlob();
    if (!blob) throw new Error("no blob");
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("图片已复制");
    } else {
      throw new Error("unsupported");
    }
    buzz();
  } catch (err) {
    failToast(err, "这个浏览器不支持复制，请用「保存」");
  }
}

async function downloadImage() {
  try {
    const blob = await toBlob();
    if (!blob) throw new Error("no blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("已保存 PNG");
    buzz();
  } catch (err) {
    failToast(err, "保存失败，试试右键图片另存为");
  }
}

async function shareImage() {
  try {
    const blob = await toBlob();
    const file = new File([blob], filename(), { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "emojimix" });
      return;
    }
    throw new Error("no share");
  } catch (err) {
    if (err && err.message === "这对没有官方图") {
      toast("这对没有官方图，换个组合吧");
      return;
    }
    await downloadImage();
  }
}

/* ---------- 搜索 ---------- */
let searchTarget = wheel1;
const searchSheet = $("#searchSheet");
const searchBackdrop = $("#searchBackdrop");
const searchInput = $("#searchInput");
const searchGrid = $("#searchGrid");
const searchEmpty = $("#searchEmpty");

function openSearch(wheel) {
  searchTarget = wheel;
  searchInput.value = "";
  fillSearch("");
  searchSheet.hidden = false;
  searchBackdrop.hidden = false;
  setTimeout(() => searchInput.focus(), 60);
  beep(660, 20);
}

function closeSearch() {
  searchSheet.hidden = true;
  searchBackdrop.hidden = true;
}

function fillSearch(q) {
  const query = q.trim().toLowerCase();
  const list = query ? emojis.filter((e) => e.haystack.includes(query)) : emojis;
  const frag = document.createDocumentFragment();
  for (const e of list.slice(0, 240)) {
    const cell = document.createElement("button");
    cell.className = "search-cell";
    cell.title = e.zh || e.char;
    const img = document.createElement("img");
    img.src = e.src;
    img.alt = cell.title;
    img.loading = "lazy";
    cell.append(img);
    cell.onclick = () => {
      searchTarget.jump(e.index);
      render();
      closeSearch();
      buzz();
    };
    frag.append(cell);
  }
  searchGrid.innerHTML = "";
  searchGrid.append(frag);
  searchEmpty.hidden = list.length > 0;
}

searchInput.addEventListener("input", () => fillSearch(searchInput.value));

/* ---------- 设置 / 主题 ---------- */
const mq = matchMedia("(prefers-color-scheme: dark)");

function applyTheme(mode) {
  const dark = mode === "dark" || (mode === "auto" && mq.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $$("#themeSeg button").forEach((b) => b.classList.toggle("is-on", b.dataset.themeVal === mode));
  store.set(LS.theme, mode);
}

mq.addEventListener("change", () => {
  if (store.get(LS.theme, "auto") === "auto") applyTheme("auto");
});

$$("#themeSeg button").forEach(
  (b) => (b.onclick = () => applyTheme(b.dataset.themeVal))
);

function bindSwitch(el, storageKey, onChange) {
  const sync = () => {
    const on = store.get(storageKey, true);
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-checked", String(on));
  };
  el.onclick = () => {
    const next = !store.get(storageKey, true);
    store.set(storageKey, next);
    sync();
    onChange && onChange(next);
    if (next) beep(620, 22);
  };
  sync();
}

bindSwitch($("#soundSwitch"), LS.sound, (on) => on && beep(700, 30));
bindSwitch($("#vibeSwitch"), LS.vibe, (on) => on && buzz(12));

/* ---------- 弹层通用 ---------- */
const sheets = {
  search: { sheet: searchSheet, backdrop: searchBackdrop, close: closeSearch },
  settings: { sheet: $("#settingsSheet"), backdrop: $("#settingsBackdrop") },
  credits: { sheet: $("#creditsSheet"), backdrop: $("#creditsBackdrop") },
};

function openSheet(name) {
  const s = sheets[name];
  if (!s) return;
  s.sheet.hidden = false;
  s.backdrop.hidden = false;
  beep(660, 20);
}

function closeSheet(name) {
  const s = sheets[name];
  if (!s) return;
  if (name === "search") return closeSearch();
  s.sheet.hidden = true;
  s.backdrop.hidden = true;
}

$$("[data-open]").forEach((b) => (b.onclick = () => openSheet(b.dataset.open)));
$$("[data-close]").forEach((b) => {
  b.onclick = () => {
    const sheet = b.closest(".sheet");
    const name = Object.keys(sheets).find((k) => sheets[k].sheet === sheet);
    if (name) closeSheet(name);
  };
});

Object.entries(sheets).forEach(([name, s]) => {
  s.backdrop.onclick = () => closeSheet(name);
});

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  Object.keys(sheets).forEach(closeSheet);
});

/* ---------- 事件绑定 ---------- */
$("#search1").onclick = () => openSearch(wheel1);
$("#search2").onclick = () => openSearch(wheel2);
$("#shuffle1").onclick = () => {
  wheel1.random();
  buzz();
};
$("#shuffle2").onclick = () => {
  wheel2.random();
  buzz();
};

/* 左右两边同时随机：按钮和点大图是同一个行为 */
function randomizeAll() {
  wheel1.random();
  wheel2.random();
  buzz(10);
}

$("#shuffleAll").onclick = randomizeAll;

$("#btnCopy").onclick = copyImage;
$("#btnDownload").onclick = downloadImage;
$("#btnShare").onclick = shareImage;
heartBtn.onclick = toggleFav;

stage.onclick = randomizeAll;

$("#btnClearFav").onclick = () => {
  if (!getFavs().length) return toast("还没有收藏");
  setFavs([]);
  toast("收藏已清空");
};

/* ---------- 初始化 ---------- */
function boot() {
  applyTheme(store.get(LS.theme, "auto"));
  refreshFavBadge();

  const restored = loadFromURL();
  if (!restored) {
    // 默认来一组好看的：😀 + 🥰
    const a = byKey.get("1f600") || emojis[0];
    const b = byKey.get("1f970") || emojis[10];
    wheel1.jump(a.index);
    wheel2.jump(b.index);
    render();
  }

  // 首次访问的小提示，6 秒后自动淡出
  if (!store.get(LS.hint, false)) {
    setTimeout(() => {
      $("#hint").classList.add("is-gone");
      store.set(LS.hint, true);
    }, 6000);
  } else {
    $("#hint").classList.add("is-gone");
  }
}

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    wheel1.refreshScale();
    wheel2.refreshScale();
  }, 180);
});

// 手动改地址栏里的组合也能生效
addEventListener("hashchange", () => {
  const raw = decodeURIComponent(location.hash.slice(1));
  if (raw.includes("+")) loadFromURL();
});

boot();

