const CONFIG = {
  owner: "zhaotang5",
  repo: "GitHub-MC-Storage",
  branch: "main",
  usersPath: "users.json",
  cdnBase: "https://cdn.jsdelivr.net/gh",
  rawBase: "https://raw.githubusercontent.com",
  cdnMaxSize: 20 * 1024 * 1024
};

const API = "https://api.github.com";
const VERSION = "v0.2.0";
const SESSION_KEY = "ghdrive_session";
const MASTER_KEY = "ghdrive_master";
const TOKEN_KEY = "ghdrive_token";
const PBKDF2_ITER = 150000;
const HIDDEN_NAMES = new Set(["doc", "docs", "license", "license.md", "users.json", ".gitkeep", ".gitignore"]);

const HISTORY = [
  { v: "v0.2.0", items: [
    "全站接入 OreUI 组件：导航栏、弹窗、复选框、通知、加载指示器、下拉菜单",
    "新增顶部导航栏：中间显示标题，右侧显示头像与用户下拉菜单",
    "Token 设置改为弹窗，可在弹窗内修改或删除 Token",
    "上传文件与新建文件夹合并为「新建」下拉菜单",
    "列表增加表头全选框，底部增加批量删除、批量下载",
    "目录区域加宽，列表行高与字号调整",
    "删除、上传后立即回验列表，不再出现刷新后仍显示旧条目",
    "人员操作改为即时反馈"
  ] },
  { v: "v0.1.8", items: [
    "上传流程更稳妥，中小体积文件统一走更安全的方式",
    "列表过滤更严格，隐藏文件不再出现在任何目录",
    "鉴权失败时自动降级为匿名读取，不影响浏览和下载",
    "补充了几种常见错误的中文提示"
  ] },
  { v: "v0.1.7", items: [
    "列表自动隐藏 docs 文件夹、LICENSE、users.json",
    "工具栏按钮固定在一排，超宽时横向滚动"
  ] },
  { v: "v0.1.6", items: [
    "所有页面统一加入 Token 与版本履历入口",
    "新增版本履历弹窗"
  ] },
  { v: "v0.1.5", items: [
    "移除源码中的内置 Token，改为页面内设置",
    "Token 只存 sessionStorage，关闭页面即失效"
  ] },
  { v: "v0.1.4", items: [
    "清空已失效的 Token",
    "app.js 加版本查询参数破除缓存",
    "401 单独提示 Token 无效"
  ] },
  { v: "v0.1.3", items: [
    "文件表格与用户表格改为横向滚动容器，窄屏不再挤压",
    "新增移动端媒体查询"
  ] },
  { v: "v0.1.2", items: ["修复卡片纵排、标题截断、输入框宽度、按钮错位"] },
  { v: "v0.1.1", items: [
    "users.json 使用 AES-GCM + PBKDF2 加密",
    "密码改为 PBKDF2 加盐哈希",
    "增加访问口令防止用户数据被离线解密"
  ] },
  { v: "v0.1.0", items: ["首个版本：登录、浏览下载、上传、删除、新建文件夹、批量操作、人员管理与权限"] }
];

let session = null;
let masterPass = null;
let usersFile = null;
let cwd = "";
let items = [];
let selected = new Set();

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const navEl = $("nav");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtSize(n) {
  if (n == null) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function encPath(p) {
  return String(p || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function joinPath(base, name) {
  return base ? base + "/" + name : name;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToText(b) {
  const bin = atob(String(b).replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64(buf) {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}

function randomSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function imageToAvatar(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 96;
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = String(r.result);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(pass, saltBytes) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function hashPassword(saltHex, pwd) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITER, hash: "SHA-256" }, base, 256
  );
  return "pbkdf2:" + Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(u, pwd) {
  if (String(u.hash).indexOf("pbkdf2:") === 0) return (await hashPassword(u.salt, pwd)) === u.hash;
  return (await sha256Hex(u.salt + pwd)) === u.hash;
}

async function encryptUsers(data, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return JSON.stringify({ v: 1, alg: "A256GCM", salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

async function decryptUsers(str, pass) {
  const env = JSON.parse(str);
  const key = await deriveKey(pass, unb64(env.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, key, unb64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

function isEncrypted(raw) {
  try {
    const j = JSON.parse(raw);
    return j && j.v === 1 && j.ct && j.salt && j.iv;
  } catch (e) {
    return false;
  }
}

function getToken() {
  try { return (sessionStorage.getItem(TOKEN_KEY) || "").trim(); } catch (e) { return ""; }
}

function saveToken(t) {
  try { sessionStorage.setItem(TOKEN_KEY, String(t).trim()); } catch (e) {}
}

function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
}

function toast(message, kind) {
  const el = document.createElement("ore-toast");
  el.setAttribute("position", "top-end");
  el.setAttribute("variant", kind === "error" ? "warning" : (kind === "info" ? "informative" : "primary"));
  el.duration = 2800;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => { try { el.show(); } catch (e) {} });
  setTimeout(() => el.remove(), 3600);
}

function spinBlock(text) {
  return `<div class="load-block"><span class="spin"><ore-spinner aria-label="${esc(text)}"></ore-spinner></span><span>${esc(text)}</span></div>`;
}

function openModal(opt) {
  const wrap = document.createElement("ore-modal");
  wrap.innerHTML = `<dialog class="ore-modal-dialog">
    <div class="ore-modal-content">
      <header class="ore-modal-header">
        <h2 class="ore-modal-title">${esc(opt.title || "")}</h2>
        <button class="ore-modal-close ore-modal-header-button" type="button" aria-label="关闭">✕</button>
      </header>
      <div class="modal-body">
        ${opt.description ? `<p class="ore-modal-description">${esc(opt.description)}</p>` : ""}
        ${opt.body || ""}
      </div>
      <div class="modal-actions"></div>
    </div>
  </dialog>`;
  document.body.appendChild(wrap);

  const ctl = {
    el: wrap,
    close: (reason) => { try { wrap.close(reason || "close"); } catch (e) {} },
    onClose: (cb) => wrap.addEventListener("modal-close", cb)
  };

  const box = wrap.querySelector(".modal-actions");
  (opt.actions || []).forEach((a) => {
    const b = document.createElement("ore-button");
    b.setAttribute("type", "button");
    if (a.color) b.setAttribute("color", a.color);
    b.textContent = a.label;
    b.addEventListener("click", () => { if (a.onClick) a.onClick(ctl); });
    box.appendChild(b);
  });

  wrap.addEventListener("modal-close", () => wrap.remove());
  requestAnimationFrame(() => {
    try { wrap.show(); } catch (e) { wrap.setAttribute("open", ""); }
    const first = wrap.querySelector("ore-textfield");
    if (first) setTimeout(() => { try { if (first.input) first.input.focus(); } catch (e) {} }, 80);
  });
  return ctl;
}

function readField(ref, id) {
  const tf = ref.el.querySelector("#" + id);
  if (!tf) return "";
  if (tf.input) return tf.input.value;
  return tf.value || "";
}

function confirmBox(message, opt) {
  opt = opt || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal({
      title: opt.title || "确认操作",
      body: `<p class="modal-text">${esc(message)}</p>`,
      actions: [
        { label: opt.okLabel || "确定", color: opt.danger ? "destructive" : undefined, onClick: (a) => { finish(true); a.close(); } },
        { label: "取消", color: "secondary", onClick: (a) => { finish(false); a.close(); } }
      ]
    });
    m.onClose(() => finish(false));
  });
}

function promptBox(opt) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const fid = "f" + Math.random().toString(36).slice(2, 8);
    const typeAttr = opt.type === "password" ? ' type="password"' : ' type="text"';
    const m = openModal({
      title: opt.title || "输入",
      description: opt.description,
      body: `<ore-textfield id="${fid}"${typeAttr} label="${esc(opt.label || "")}" placeholder="${esc(opt.placeholder || "")}" value="${esc(opt.value || "")}"></ore-textfield>`,
      actions: [
        { label: opt.okLabel || "确定", onClick: (a) => { finish(readField(m, fid).trim()); a.close(); } },
        { label: "取消", color: "secondary", onClick: (a) => { finish(null); a.close(); } }
      ]
    });
    m.onClose(() => finish(null));
  });
}

function send(path, options, token) {
  const headers = Object.assign({
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }, options.headers || {});
  if (token) headers["Authorization"] = "Bearer " + token;
  if (options.body) headers["Content-Type"] = "application/json";
  return fetch(API + path, Object.assign({ cache: "no-store" }, options, { headers }));
}

async function api(path, options) {
  options = options || {};
  const t = getToken();
  let res = await send(path, options, t);
  if (res.status === 401 && t) {
    const retry = await send(path, options, "");
    if (retry.ok) return retry.status === 204 ? null : retry.json();
    res = retry;
  }
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try {
      const j = await res.json();
      if (j && j.message) msg += "：" + j.message;
    } catch (e) {}
    if (res.status === 401) msg = "Token 无效或已被吊销，请在「Token 设置」中重新填写";
    if (res.status === 403 && /rate limit/i.test(msg)) msg = "匿名访问频率超限，请在「Token 设置」中填入 Token";
    if (res.status === 404 && /files/i.test(msg)) msg = "仓库中没有该文件";
    if (res.status === 422) msg = "提交被拒绝（常见原因：文件过大或名称冲突）";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function contentsUrl(path) {
  return "/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(path) +
    "?ref=" + encodeURIComponent(CONFIG.branch);
}

function downloadUrl(item) {
  const p = encPath(item.path);
  if (item.size <= CONFIG.cdnMaxSize) {
    return CONFIG.cdnBase + "/" + CONFIG.owner + "/" + CONFIG.repo + "@" + CONFIG.branch + "/" + p;
  }
  return CONFIG.rawBase + "/" + CONFIG.owner + "/" + CONFIG.repo + "/" + CONFIG.branch + "/" + p;
}

async function loadUsers() {
  const d = await api(contentsUrl(CONFIG.usersPath));
  const raw = b64ToText(d.content);
  usersFile = { sha: d.sha, raw: raw };
  if (isEncrypted(raw)) {
    usersFile.data = await decryptUsers(raw, masterPass);
    usersFile.encrypted = true;
  } else {
    usersFile.data = JSON.parse(raw);
    usersFile.encrypted = false;
  }
  return true;
}

async function loadUsersIfMissing() {
  if (!masterPass) throw new Error("缺少访问口令，请重新登录");
  await loadUsers();
}

async function saveUsers() {
  if (!getToken()) throw new Error("未设置 Token，请先在导航栏打开「Token 设置」");
  if (!masterPass) throw new Error("缺少访问口令");
  let sha;
  try {
    const d = await api(contentsUrl(CONFIG.usersPath));
    sha = d.sha;
  } catch (e) { if (e.status !== 404) throw e; }
  const json = await encryptUsers(usersFile.data, masterPass);
  const body = { message: "chore: 更新用户数据", branch: CONFIG.branch, content: textToB64(json) };
  if (sha) body.sha = sha;
  const r = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(CONFIG.usersPath), {
    method: "PUT",
    body: JSON.stringify(body)
  });
  usersFile.sha = r.content.sha;
  usersFile.encrypted = true;
}

function findUser(name) {
  return usersFile.data.users.find((u) => u.u === name);
}

function saveSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.setItem(MASTER_KEY, masterPass);
}

function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (s && s.exp > Date.now()) session = s;
    masterPass = sessionStorage.getItem(MASTER_KEY);
  } catch (e) {}
}

function isAdmin() { return !!(session && session.role === "admin"); }

function canUpload() {
  return !!(session && (session.role === "admin" || (session.perm && session.perm.upload)));
}

function permText(s) {
  if (!s) return "";
  if (s.role === "admin") return "管理员 · 上传与下载";
  return s.perm && s.perm.upload ? "上传与下载" : "仅下载";
}

function avatarMarkup(s, small) {
  const cls = "avatar" + (small ? " small" : "");
  if (s && s.avatar) return `<span class="${cls}"><img class="avatar-img" src="${s.avatar}" alt="${esc(s.u)}"></span>`;
  const ch = esc(String(s && s.u ? s.u : "?").slice(0, 1).toUpperCase());
  return `<span class="${cls}">${ch}</span>`;
}

function renderNav() {
  if (!session) {
    navEl.innerHTML = "";
    return;
  }
  navEl.innerHTML = `<ore-navbar aria-label="主导航">
    <div class="ore-navbar-start">
      <button class="ore-navbar-action" id="tokenBtn" type="button">
        <span class="ore-navbar-action-label">${getToken() ? "Token 已设置" : "Token 设置"}</span>
      </button>
    </div>
    <span class="ore-navbar-title">GitHub 网盘</span>
    <div class="ore-navbar-actions">
      <ore-dropdown class="user-drop" variant="borderless">
        <ore-button class="ore-dropdown-trigger" type="button" color="secondary">
          ${avatarMarkup(session)}
          <span class="uname">${esc(session.u)}</span>
        </ore-button>
        <div class="ore-dropdown-menu">
          <button class="ore-dropdown-item" type="button" data-value="who" disabled>${esc(session.u)}</button>
          <button class="ore-dropdown-item" type="button" data-value="perm" disabled>权限：${esc(permText(session))}</button>
          ${isAdmin() ? '<button class="ore-dropdown-item" type="button" data-value="admin">人员管理</button>' : ""}
          <button class="ore-dropdown-item" type="button" data-value="avatar">修改头像</button>
          <button class="ore-dropdown-item" type="button" data-value="password">修改密码</button>
          <button class="ore-dropdown-item" type="button" data-value="history">版本履历</button>
          <button class="ore-dropdown-item" type="button" data-value="logout">退出登录</button>
        </div>
      </ore-dropdown>
    </div>
  </ore-navbar>`;

  const tb = $("tokenBtn");
  if (tb) tb.addEventListener("click", openTokenModal);

  const dd = navEl.querySelector(".user-drop");
  if (dd) {
    dd.addEventListener("change", (e) => {
      const v = e.detail && e.detail.value;
      dd.open = false;
      if (v === "admin") renderAdmin();
      else if (v === "avatar") pickAvatar();
      else if (v === "password") changeMyPassword();
      else if (v === "history") showHistory();
      else if (v === "logout") doLogout();
    });
  }
}

function openTokenModal() {
  const cur = getToken();
  const m = openModal({
    title: "Token 设置",
    description: "只需要 Contents: Read and write 权限。Token 只保存在本次会话（关闭页面即失效），不会写进仓库。",
    body: `<ore-textfield id="tokenField" type="password" label="GitHub Token" placeholder="github_pat_..." value="${esc(cur)}"></ore-textfield>`,
    actions: [
      {
        label: "保存",
        onClick: (a) => {
          const v = readField(m, "tokenField").trim();
          if (!v) { toast("请输入 Token", "error"); return; }
          saveToken(v);
          renderNav();
          toast("Token 已保存（本次会话有效）");
          a.close();
        }
      },
      {
        label: "删除 Token",
        color: "destructive",
        onClick: (a) => {
          clearToken();
          renderNav();
          toast("Token 已删除", "info");
          a.close();
        }
      },
      { label: "取消", color: "secondary", onClick: (a) => a.close() }
    ]
  });
}

function showHistory() {
  const body = HISTORY.map((h) =>
    `<div class="hist"><b>${esc(h.v)}</b>${h.items.map((t) => `<p>· ${esc(t)}</p>`).join("")}</div>`
  ).join("");
  openModal({
    title: "版本履历",
    body: `<div class="hist-wrap">${body}</div>`,
    actions: [{ label: "关闭", color: "secondary", onClick: (a) => a.close() }]
  });
}

function doLogout() {
  session = null;
  masterPass = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(MASTER_KEY);
  } catch (e) {}
  renderLogin();
}

function pickAvatar() {
  const input = $("avatarPicker");
  input.value = "";
  input.click();
}

$("avatarPicker").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (!f.type || f.type.indexOf("image/") !== 0) { toast("请选择图片文件", "error"); return; }
  try {
    const data = await imageToAvatar(f);
    await loadUsersIfMissing();
    const u = findUser(session.u);
    if (!u) { toast("找不到当前用户", "error"); return; }
    u.avatar = data;
    await saveUsers();
    session.avatar = data;
    saveSession();
    renderNav();
    toast("头像已更新");
  } catch (err) {
    toast("头像更新失败：" + err.message, "error");
  }
});

function renderCenter(inner) {
  navEl.innerHTML = "";
  appEl.innerHTML = `<div class="center-box">${inner}<footer>GitHub 网盘 ${VERSION}</footer></div>`;
}

function readInline(id) {
  const e = $(id);
  if (!e) return "";
  if (e.input) return e.input.value;
  return e.value || "";
}

function renderInit() {
  renderCenter(`<ore-card>
    <div class="ore-card-body">
      <div class="ore-card-caption">
        <div class="ore-card-title">初始化网盘</div>
        <div class="ore-card-description">未在仓库中找到 ${esc(CONFIG.usersPath)}。请设置访问口令与管理员账号。访问口令用于加密用户数据，请牢记，不会存进仓库。</div>
      </div>
      <ore-textfield id="initMaster" type="password" label="访问口令"></ore-textfield>
      <ore-textfield id="initName" label="管理员用户名" placeholder="admin"></ore-textfield>
      <ore-textfield id="initPwd" type="password" label="管理员密码"></ore-textfield>
      <div class="btn-col"><ore-button type="button" id="initBtn">创建并进入</ore-button></div>
    </div>
  </ore-card>`);

  $("initBtn").addEventListener("click", async () => {
    const mp = readInline("initMaster").trim();
    const name = readInline("initName").trim();
    const pwd = readInline("initPwd");
    if (!mp || !name || !pwd) { toast("请填写访问口令、用户名和密码", "error"); return; }
    const btn = $("initBtn");
    btn.setAttribute("loading", "");
    try {
      masterPass = mp;
      const salt = randomSalt();
      usersFile = {
        sha: null,
        encrypted: false,
        data: { version: 2, users: [{ u: name, role: "admin", salt: salt, hash: await hashPassword(salt, pwd), perm: { upload: true, download: true } }] }
      };
      await saveUsers();
      session = { u: name, role: "admin", perm: { upload: true, download: true }, avatar: "", exp: Date.now() + 12 * 3600 * 1000 };
      saveSession();
      cwd = "";
      renderBrowser();
      toast("初始化完成");
    } catch (e) {
      btn.removeAttribute("loading");
      toast("创建失败：" + e.message, "error");
    }
  });
}

function renderLogin() {
  renderCenter(`<ore-card>
    <div class="ore-card-body">
      <div class="ore-card-caption">
        <div class="ore-card-title">GitHub 网盘</div>
        <div class="ore-card-description">请输入访问口令和账号密码</div>
      </div>
      <ore-textfield id="loginMaster" type="password" label="访问口令"></ore-textfield>
      <ore-textfield id="loginName" label="用户名"></ore-textfield>
      <ore-textfield id="loginPwd" type="password" label="密码"></ore-textfield>
      <div class="btn-col"><ore-button type="button" id="loginBtn">登录</ore-button></div>
      <div class="token-line"><button class="link-btn" id="loginToken" type="button">${getToken() ? "Token 已设置，点此修改" : "设置 Token（可选，提升接口限额）"}</button></div>
    </div>
  </ore-card>`);

  $("loginToken").addEventListener("click", openTokenModal);

  const doLogin = async () => {
    const mp = readInline("loginMaster").trim();
    const name = readInline("loginName").trim();
    const pwd = readInline("loginPwd");
    if (!mp || !name || !pwd) { toast("请填写访问口令、用户名和密码", "error"); return; }
    const btn = $("loginBtn");
    btn.setAttribute("loading", "");
    try {
      masterPass = mp;
      await loadUsers();
      const u = findUser(name);
      if (!u || !(await verifyPassword(u, pwd))) {
        btn.removeAttribute("loading");
        toast("用户名或密码错误", "error");
        return;
      }
      session = { u: u.u, role: u.role, perm: u.perm, avatar: u.avatar || "", exp: Date.now() + 12 * 3600 * 1000 };
      saveSession();
      cwd = "";
      if (!usersFile.encrypted && isAdmin()) await saveUsers();
      renderBrowser();
      toast("欢迎回来，" + u.u);
    } catch (e) {
      btn.removeAttribute("loading");
      toast(e.name === "OperationError" ? "访问口令错误" : ("登录失败：" + e.message), "error");
    }
  };

  $("loginBtn").addEventListener("click", doLogin);
  const pwdEl = $("loginPwd");
  if (pwdEl && pwdEl.input) pwdEl.input.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

async function loadList() {
  const d = await api(contentsUrl(cwd));
  const list = Array.isArray(d) ? d : [d];
  items = list.filter((it) => !HIDDEN_NAMES.has(String(it.name).toLowerCase()));
  items.sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function reloadList(expectGone) {
  const box = $("listBox");
  if (box) box.innerHTML = spinBlock("正在读取目录");
  try {
    let gone = false;
    for (let i = 0; i < 4; i++) {
      try {
        await loadList();
      } catch (e) {
        if (e.status === 404) items = [];
        else throw e;
      }
      if (!expectGone) { gone = true; break; }
      if (!items.some((x) => x.path === expectGone)) { gone = true; break; }
      await sleep(450);
    }
    selected.clear();
    renderList();
    if (expectGone && !gone) toast("操作可能未生效，请稍后手动刷新", "error");
  } catch (e) {
    if (box) box.innerHTML = `<div class="empty-tip">${esc("加载失败：" + e.message)}</div>`;
  }
}

function crumbHtml() {
  const parts = cwd ? cwd.split("/") : [];
  let html = '<a data-p="">根目录</a>';
  let acc = "";
  for (const p of parts) {
    acc = joinPath(acc, p);
    html += ' / <a data-p="' + esc(acc) + '">' + esc(p) + "</a>";
  }
  return html;
}

function renderBrowser() {
  renderNav();
  appEl.innerHTML = `<div class="page-head">
      <h1>文件</h1>
      <div class="muted">${esc(CONFIG.owner)}/${esc(CONFIG.repo)}</div>
    </div>
    <ore-card>
      <div class="ore-card-body">
        <div class="crumb" id="crumb"></div>
        <div class="toolbar" id="toolbar">
          ${canUpload() ? `<ore-dropdown class="new-drop" variant="bordered">
            <ore-button class="ore-dropdown-trigger" type="button"><span class="new-label">新建</span></ore-button>
            <div class="ore-dropdown-menu">
              <button class="ore-dropdown-item" type="button" data-value="upload">上传文件</button>
              <button class="ore-dropdown-item" type="button" data-value="folder">新建文件夹</button>
            </div>
          </ore-dropdown>` : ""}
          <ore-button type="button" id="refreshBtn">刷新</ore-button>
          <span class="muted">${canUpload() ? "单文件建议 50MB 以内" : "你当前只有下载权限"}</span>
        </div>
        <div id="listBox">${spinBlock("正在读取目录")}</div>
        <div class="batch-bar">
          <span class="muted" id="selInfo">已选 0 项</span>
          <div class="btn-row">
            ${canUpload() ? '<ore-button type="button" id="batchDelBtn" color="destructive" disabled>删除</ore-button>' : ""}
            <ore-button type="button" id="batchDlBtn" disabled>下载</ore-button>
          </div>
        </div>
      </div>
    </ore-card>
    <footer>GitHub 网盘 ${VERSION} · 存储：${esc(CONFIG.owner)}/${esc(CONFIG.repo)} · 下载加速：jsDelivr</footer>`;

  $("crumb").innerHTML = crumbHtml();
  $("crumb").querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => { cwd = a.dataset.p; renderBrowser(); });
  });

  $("refreshBtn").addEventListener("click", () => reloadList());

  const newDrop = appEl.querySelector(".new-drop");
  if (newDrop) {
    newDrop.addEventListener("change", (e) => {
      const v = e.detail && e.detail.value;
      newDrop.open = false;
      if (v === "upload") $("filePicker").click();
      else if (v === "folder") makeFolder();
    });
  }

  const delBtn = $("batchDelBtn");
  if (delBtn) delBtn.addEventListener("click", batchDelete);
  $("batchDlBtn").addEventListener("click", batchDownload);

  reloadList();
}

function updateSelUI() {
  const info = $("selInfo");
  if (info) info.textContent = "已选 " + selected.size + " 项";
  const dl = $("batchDlBtn");
  if (dl) { if (selected.size) dl.removeAttribute("disabled"); else dl.setAttribute("disabled", ""); }
  const del = $("batchDelBtn");
  if (del) { if (selected.size) del.removeAttribute("disabled"); else del.setAttribute("disabled", ""); }
  const all = $("selAll");
  if (all) {
    if (items.length && items.every((x) => selected.has(x.path))) all.setAttribute("checked", "");
    else all.removeAttribute("checked");
  }
}

function renderList() {
  const box = $("listBox");
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="empty-tip">此文件夹为空</div>';
    updateSelUI();
    return;
  }
  const rows = items.map((it, i) => {
    const isDir = it.type === "dir";
    return `<tr>
      <td class="c-check"><ore-checkbox class="row-check" data-i="${i}"${selected.has(it.path) ? " checked" : ""}></ore-checkbox></td>
      <td class="c-name" data-i="${i}"><span class="${isDir ? "ico-dir" : "ico-file"}">${isDir ? "▰" : "▤"}</span><span class="fname">${esc(it.name)}</span></td>
      <td class="c-size">${isDir ? "—" : fmtSize(it.size)}</td>
      <td class="c-act">
        ${isDir ? "" : `<button type="button" class="link-btn" data-dl="${i}">下载</button>`}
        ${canUpload() ? `<button type="button" class="link-btn danger" data-del="${i}">删除</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  box.innerHTML = `<div class="table-wrap"><table class="files">
    <thead><tr>
      <th class="c-check"><ore-checkbox id="selAll"></ore-checkbox></th>
      <th>名称</th>
      <th class="c-size">大小</th>
      <th class="c-act">操作</th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;

  box.querySelectorAll(".row-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      const p = items[Number(cb.dataset.i)].path;
      if (cb.checked) selected.add(p); else selected.delete(p);
      updateSelUI();
    });
  });

  const all = $("selAll");
  if (all) {
    all.addEventListener("change", () => {
      if (all.checked) items.forEach((it) => selected.add(it.path));
      else selected.clear();
      renderList();
    });
  }

  box.querySelectorAll("td.c-name").forEach((td) => {
    td.addEventListener("click", () => {
      const it = items[Number(td.dataset.i)];
      if (it.type === "dir") { cwd = it.path; renderBrowser(); }
      else triggerDownload(it);
    });
  });

  box.querySelectorAll("button[data-dl]").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); triggerDownload(items[Number(b.dataset.dl)]); });
  });

  box.querySelectorAll("button[data-del]").forEach((b) => {
    b.addEventListener("click", (e) => { e.stopPropagation(); deleteItem(items[Number(b.dataset.del)]); });
  });

  updateSelUI();
}

function triggerDownload(item) {
  const a = document.createElement("a");
  a.href = downloadUrl(item);
  a.download = item.name;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$("filePicker").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (!files.length) return;
  let okCount = 0;
  for (const f of files) {
    try {
      toast("正在上传 " + f.name, "info");
      await uploadFile(f, joinPath(cwd, f.name));
      okCount++;
    } catch (err) {
      toast(f.name + " 上传失败：" + err.message, "error");
    }
  }
  await reloadList();
  if (okCount) toast("已上传 " + okCount + " 个文件");
});

async function uploadFile(file, path) {
  if (!getToken()) throw new Error("未设置 Token，请先在导航栏打开「Token 设置」");
  const data = await fileToB64(file);
  if (file.size <= 650 * 1024) {
    const body = { message: "upload: " + path, branch: CONFIG.branch, content: data };
    try {
      const d = await api(contentsUrl(path));
      if (d && d.sha) body.sha = d.sha;
    } catch (e) { if (e.status !== 404) throw e; }
    await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(path), {
      method: "PUT",
      body: JSON.stringify(body)
    });
    return;
  }
  const blob = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/blobs", {
    method: "POST",
    body: JSON.stringify({ content: data, encoding: "base64" })
  });
  const ref = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/refs/heads/" + encodeURIComponent(CONFIG.branch));
  const commit = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/commits/" + ref.object.sha);
  const tree = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: [{ path: path, mode: "100644", type: "blob", sha: blob.sha }] })
  });
  const newCommit = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: "upload: " + path, tree: tree.sha, parents: [ref.object.sha] })
  });
  await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/refs/heads/" + encodeURIComponent(CONFIG.branch), {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha })
  });
}

async function makeFolder() {
  const raw = await promptBox({ title: "新建文件夹", label: "文件夹名称", placeholder: "例如 backups" });
  if (raw == null) return;
  const name = raw.replace(/\//g, "").trim();
  if (!name) { toast("名称不能为空", "error"); return; }
  const path = joinPath(cwd, name);
  if (items.some((it) => it.path === path)) { toast("同名文件夹已存在", "error"); return; }
  try {
    await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(path + "/.gitkeep"), {
      method: "PUT",
      body: JSON.stringify({ message: "mkdir: " + path, branch: CONFIG.branch, content: "" })
    });
    toast("已创建文件夹 " + name);
    await reloadList();
  } catch (e) {
    toast("创建失败：" + e.message, "error");
  }
}

async function deleteRemote(path, sha) {
  await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(path), {
    method: "DELETE",
    body: JSON.stringify({ message: "delete: " + path, branch: CONFIG.branch, sha: sha })
  });
}

async function deleteRecursive(item) {
  if (item.type !== "dir") { await deleteRemote(item.path, item.sha); return; }
  const list = await api(contentsUrl(item.path));
  for (const it of list) await deleteRecursive(it);
}

async function deleteItem(item) {
  const ok = await confirmBox(
    "确定删除「" + item.name + "」？" + (item.type === "dir" ? "其中的全部内容会一并删除。" : ""),
    { danger: true, okLabel: "删除", title: "删除确认" }
  );
  if (!ok) return;
  try {
    await deleteRecursive(item);
    toast("已删除 " + item.name);
    await reloadList(item.path);
  } catch (e) {
    toast("删除失败：" + e.message, "error");
  }
}

async function batchDelete() {
  if (!selected.size) { toast("请先勾选要删除的项目", "info"); return; }
  const ok = await confirmBox("确定删除选中的 " + selected.size + " 个项目？此操作不可撤销。", {
    danger: true, okLabel: "全部删除", title: "批量删除"
  });
  if (!ok) return;
  const targets = items.filter((x) => selected.has(x.path));
  for (const it of targets) {
    try { await deleteRecursive(it); }
    catch (e) { toast(it.name + " 删除失败：" + e.message, "error"); }
  }
  toast("批量删除完成");
  await reloadList(targets.length === 1 ? targets[0].path : null);
}

function batchDownload() {
  const files = items.filter((x) => selected.has(x.path) && x.type !== "dir");
  if (!files.length) { toast("请先勾选文件（文件夹不支持批量下载）", "info"); return; }
  files.forEach((f, i) => setTimeout(() => triggerDownload(f), i * 350));
  toast("已开始下载 " + files.length + " 个文件", "info");
}

async function changeMyPassword() {
  const pwd = await promptBox({ title: "修改密码", label: "新密码", type: "password", description: "至少 6 个字符" });
  if (pwd == null) return;
  if (pwd.length < 6) { toast("密码至少 6 个字符", "error"); return; }
  try {
    await loadUsersIfMissing();
    const u = findUser(session.u);
    u.salt = randomSalt();
    u.hash = await hashPassword(u.salt, pwd);
    await saveUsers();
    toast("密码已修改");
  } catch (e) {
    toast("修改失败：" + e.message, "error");
  }
}

function renderAdmin() {
  renderNav();
  appEl.innerHTML = `<div class="page-head">
      <h1>人员管理</h1>
      <ore-button type="button" id="backBtn" color="secondary">返回文件</ore-button>
    </div>
    <ore-card>
      <div class="ore-card-body">
        <div id="userBox">${spinBlock("正在读取用户")}</div>
      </div>
    </ore-card>
    <div class="gap"></div>
    <ore-card>
      <div class="ore-card-body">
        <div class="ore-card-title">添加用户</div>
        <ore-textfield id="newName" label="用户名"></ore-textfield>
        <ore-textfield id="newPwd" type="password" label="密码"></ore-textfield>
        <ore-checkbox id="newUp">允许上传（默认仅下载）</ore-checkbox>
        <div class="btn-col"><ore-button type="button" id="addBtn">添加用户</ore-button></div>
      </div>
    </ore-card>
    <footer>GitHub 网盘 ${VERSION}</footer>`;

  $("backBtn").addEventListener("click", renderBrowser);

  loadUsersIfMissing().then(renderUserTable).catch((e) => {
    $("userBox").innerHTML = `<div class="empty-tip">${esc("加载失败：" + e.message)}</div>`;
  });

  $("addBtn").addEventListener("click", async () => {
    const name = readInline("newName").trim();
    const pwd = readInline("newPwd");
    const up = $("newUp").checked;
    if (!name || !pwd) { toast("请填写用户名和密码", "error"); return; }
    if (findUser(name)) { toast("用户名已存在", "error"); return; }
    const btn = $("addBtn");
    btn.setAttribute("loading", "");
    try {
      const salt = randomSalt();
      usersFile.data.users.push({ u: name, role: "user", salt: salt, hash: await hashPassword(salt, pwd), perm: { upload: up, download: true } });
      renderUserTable();
      await saveUsers();
      toast("已添加用户 " + name);
      const n = $("newName");
      const p = $("newPwd");
      if (n.input) n.input.value = "";
      if (p.input) p.input.value = "";
      $("newUp").checked = false;
    } catch (e) {
      usersFile.data.users = usersFile.data.users.filter((x) => x.u !== name);
      renderUserTable();
      toast("添加失败：" + e.message, "error");
    } finally {
      btn.removeAttribute("loading");
    }
  });
}

function renderUserTable() {
  const rows = usersFile.data.users.map((u, i) => `<tr>
    <td><span class="user-cell">${avatarMarkup(u, true)}${esc(u.u)}</span></td>
    <td>${u.role === "admin" ? '<ore-tag variant="notice">管理员</ore-tag>' : '<ore-tag variant="neutral">用户</ore-tag>'}</td>
    <td><ore-checkbox class="perm-up" data-i="${i}"${u.perm.upload ? " checked" : ""}${u.role === "admin" ? " disabled" : ""}></ore-checkbox></td>
    <td>允许</td>
    <td class="c-act">
      <button type="button" class="link-btn" data-rp="${i}">重置密码</button>
      ${u.u === session.u || u.role === "admin" ? "" : `<button type="button" class="link-btn danger" data-rm="${i}">删除</button>`}
    </td>
  </tr>`).join("");

  $("userBox").innerHTML = `<div class="table-wrap"><table class="files users">
    <thead><tr><th>用户名</th><th>角色</th><th>上传权限</th><th>下载权限</th><th class="c-act">操作</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;

  $("userBox").querySelectorAll(".perm-up").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const u = usersFile.data.users[Number(cb.dataset.i)];
      const prev = u.perm.upload;
      u.perm.upload = cb.checked;
      if (session.u === u.u) { session.perm.upload = cb.checked; saveSession(); renderNav(); }
      try {
        await saveUsers();
        toast("已" + (cb.checked ? "开启" : "关闭") + " " + u.u + " 的上传权限");
      } catch (e) {
        u.perm.upload = prev;
        cb.checked = prev;
        toast("保存失败：" + e.message, "error");
      }
    });
  });

  $("userBox").querySelectorAll("button[data-rp]").forEach((b) => {
    b.addEventListener("click", async () => {
      const u = usersFile.data.users[Number(b.dataset.rp)];
      const pwd = await promptBox({ title: "重置密码", label: "用户 " + u.u + " 的新密码", type: "password" });
      if (pwd == null) return;
      if (pwd.length < 6) { toast("密码至少 6 个字符", "error"); return; }
      try {
        u.salt = randomSalt();
        u.hash = await hashPassword(u.salt, pwd);
        await saveUsers();
        toast("已重置 " + u.u + " 的密码");
      } catch (e) {
        toast("重置失败：" + e.message, "error");
      }
    });
  });

  $("userBox").querySelectorAll("button[data-rm]").forEach((b) => {
    b.addEventListener("click", async () => {
      const idx = Number(b.dataset.rm);
      const u = usersFile.data.users[idx];
      const ok = await confirmBox("确定删除用户 " + u.u + "？", { danger: true, okLabel: "删除", title: "删除用户" });
      if (!ok) return;
      const backup = usersFile.data.users.slice();
      usersFile.data.users.splice(idx, 1);
      renderUserTable();
      try {
        await saveUsers();
        toast("已删除用户 " + u.u);
      } catch (e) {
        usersFile.data.users = backup;
        renderUserTable();
        toast("删除失败：" + e.message, "error");
      }
    });
  });
}

(async function boot() {
  loadSession();
  if (session && masterPass) {
    renderBrowser();
    return;
  }
  try {
    await api(contentsUrl(CONFIG.usersPath));
    renderLogin();
  } catch (e) {
    if (e.status === 404) { renderInit(); return; }
    renderCenter(`<ore-card><div class="ore-card-body">
      <div class="ore-card-title">加载失败</div>
      <div class="ore-card-description">${esc(e.message)}</div>
      <div class="ore-card-description">请检查 app.js 顶部 CONFIG 中的 owner / repo / branch，仓库必须为 Public，并确认网络可以访问 api.github.com。</div>
    </div></ore-card>`);
  }
})();
