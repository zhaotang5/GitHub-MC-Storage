/* ============================================================
 * GitHub 网盘 v0.1.0
 * 存储：GitHub 仓库（API 读写）
 * 下载：jsDelivr CDN
 * 账号：仓库根目录 users.json（内置账号密码，加盐 SHA-256）
 * ============================================================ */

const CONFIG = {
  owner: "zhaotang5",          // 仓库所有者
  repo: "GitHub-MC-Storage",   // 存文件的仓库名
  branch: "main",              // 分支
  token: "",                   // 细粒度 Token（Contents: Read and write）
  usersPath: "users.json",     // 账号文件在仓库里的路径
  cdnBase: "https://cdn.jsdelivr.net/gh",
  rawBase: "https://raw.githubusercontent.com",
  cdnMaxSize: 20 * 1024 * 1024 // jsDelivr 单文件上限 20MB，超出走 raw
};

const API = "https://api.github.com";
const VERSION = "v0.1.0";
const SESSION_KEY = "ghdrive_session";

let session = null;
let usersFile = null; // { sha, data: { users: [...] } }
let cwd = "";
let items = [];
let selected = new Set();

/* ---------------- 工具 ---------------- */

const $ = (id) => document.getElementById(id);
const app = $("app");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtSize(n) {
  if (n == null) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function encPath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

function joinPath(base, name) {
  return base ? base + "/" + name : name;
}

function parentPath(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)))
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

/* ---------------- GitHub API ---------------- */

async function api(path, options = {}) {
  const headers = Object.assign({
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  }, options.headers || {});
  if (CONFIG.token) headers["Authorization"] = "Bearer " + CONFIG.token;
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try {
      const j = await res.json();
      if (j && j.message) msg += "：" + j.message;
    } catch (e) {}
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

/* ---------------- users.json ---------------- */

async function loadUsers() {
  try {
    const d = await api(contentsUrl(CONFIG.usersPath));
    usersFile = { sha: d.sha, data: JSON.parse(b64ToText(d.content)) };
    return true;
  } catch (e) {
    if (e.status === 404) { usersFile = null; return false; }
    throw e;
  }
}

async function saveUsers() {
  if (!CONFIG.token) throw new Error("未配置 Token，无法写入");
  // 写入前重新取 sha，避免冲突
  let sha = usersFile ? usersFile.sha : undefined;
  try {
    const d = await api(contentsUrl(CONFIG.usersPath));
    sha = d.sha;
  } catch (e) { if (e.status !== 404) throw e; }
  const body = {
    message: "chore: 更新用户数据",
    branch: CONFIG.branch,
    content: textToB64(JSON.stringify(usersFile.data, null, 2))
  };
  if (sha) body.sha = sha;
  const r = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(CONFIG.usersPath), {
    method: "PUT",
    body: JSON.stringify(body)
  });
  usersFile.sha = r.content.sha;
}

function findUser(name) {
  return usersFile.data.users.find((u) => u.u === name);
}

/* ---------------- 会话 ---------------- */

function saveSession() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (s && s.exp > Date.now()) session = s;
  } catch (e) {}
}

function logout() {
  session = null;
  sessionStorage.removeItem(SESSION_KEY);
  renderLogin();
}

function isAdmin() { return session && session.role === "admin"; }
function canUpload() { return session && (session.role === "admin" || session.perm.upload); }

/* ---------------- 状态提示 ---------------- */

function setStatus(msg, isErr) {
  const el = $("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "status" + (isErr ? " err" : "");
}

/* ================= 视图：初始化 ================= */

function renderInit() {
  app.innerHTML = `
    <div class="center-box">
      <ore-card>
        <div class="ore-card-body">
          <div class="ore-card-caption">
            <div class="ore-card-title">初始化网盘</div>
            <div class="ore-card-description">未在仓库中找到 ${esc(CONFIG.usersPath)}，请创建管理员账号。管理员默认拥有全部权限。</div>
          </div>
          <label class="f">管理员用户名</label>
          <input type="text" id="initName" autocomplete="off">
          <label class="f">管理员密码</label>
          <input type="password" id="initPwd">
          <div class="btn-col">
            <ore-button type="button" id="initBtn">创建并进入</ore-button>
          </div>
          <div class="status" id="status"></div>
        </div>
      </ore-card>
      <footer>GitHub 网盘 ${VERSION}</footer>
    </div>`;
  $("initBtn").addEventListener("click", async () => {
    const name = $("initName").value.trim();
    const pwd = $("initPwd").value;
    if (!name || !pwd) return setStatus("请填写用户名和密码", true);
    try {
      setStatus("正在创建…");
      const salt = randomSalt();
      usersFile = {
        sha: null,
        data: { version: 1, users: [{ u: name, role: "admin", salt: salt, hash: await sha256Hex(salt + pwd), perm: { upload: true, download: true } }] }
      };
      await saveUsers();
      session = { u: name, role: "admin", perm: { upload: true, download: true }, exp: Date.now() + 12 * 3600 * 1000 };
      saveSession();
      cwd = "";
      renderBrowser();
    } catch (e) {
      setStatus("创建失败：" + e.message, true);
    }
  });
}

/* ================= 视图：登录 ================= */

function renderLogin() {
  app.innerHTML = `
    <div class="center-box">
      <ore-card>
        <div class="ore-card-body">
          <div class="ore-card-caption">
            <div class="ore-card-title">GitHub 网盘</div>
            <div class="ore-card-description">请登录后访问文件</div>
          </div>
          <label class="f">用户名</label>
          <input type="text" id="loginName" autocomplete="off">
          <label class="f">密码</label>
          <input type="password" id="loginPwd">
          <div class="btn-col">
            <ore-button type="button" id="loginBtn">登录</ore-button>
          </div>
          <div class="status" id="status"></div>
        </div>
      </ore-card>
      <footer>GitHub 网盘 ${VERSION}</footer>
    </div>`;
  const doLogin = async () => {
    const name = $("loginName").value.trim();
    const pwd = $("loginPwd").value;
    if (!name || !pwd) return setStatus("请填写用户名和密码", true);
    try {
      setStatus("验证中…");
      await loadUsers();
      const u = findUser(name);
      if (!u) return setStatus("用户名或密码错误", true);
      const h = await sha256Hex(u.salt + pwd);
      if (h !== u.hash) return setStatus("用户名或密码错误", true);
      session = { u: u.u, role: u.role, perm: u.perm, exp: Date.now() + 12 * 3600 * 1000 };
      saveSession();
      cwd = "";
      renderBrowser();
    } catch (e) {
      setStatus("登录失败：" + e.message, true);
    }
  };
  $("loginBtn").addEventListener("click", doLogin);
  $("loginPwd").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
}

/* ================= 视图：文件浏览 ================= */

async function loadList() {
  try {
    const d = await api(contentsUrl(cwd));
    items = Array.isArray(d) ? d : [d];
    items.sort((a, b) => {
      if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    selected.clear();
  } catch (e) {
    if (e.status === 404) { items = []; selected.clear(); return; }
    throw e;
  }
}

function crumbHtml() {
  const parts = cwd ? cwd.split("/") : [];
  let html = `<a data-p="">根目录</a>`;
  let acc = "";
  for (const p of parts) {
    acc = joinPath(acc, p);
    html += ` / <a data-p="${esc(acc)}">${esc(p)}</a>`;
  }
  return html;
}

async function renderBrowser() {
  app.innerHTML = `
    <div class="title-row">
      <h1>GitHub 网盘</h1>
      <div class="btn-row">
        <ore-tag variant="informative">${esc(session.u)}${isAdmin() ? "（管理员）" : ""}</ore-tag>
        ${isAdmin() ? '<ore-button type="button" id="adminBtn">人员管理</ore-button>' : ""}
        <ore-button type="button" id="pwdBtn">修改密码</ore-button>
        <ore-button type="button" id="logoutBtn">退出登录</ore-button>
      </div>
    </div>
    <ore-card>
      <div class="ore-card-body">
        <div class="crumb" id="crumb"></div>
        <div class="toolbar" id="toolbar"></div>
        <div class="status" id="status"></div>
        <div id="listBox"><div class="empty-tip">加载中…</div></div>
      </div>
    </ore-card>
    <footer>GitHub 网盘 ${VERSION} · 存储：${esc(CONFIG.owner)}/${esc(CONFIG.repo)} · 下载加速：jsDelivr</footer>`;

  $("logoutBtn").addEventListener("click", logout);
  $("pwdBtn").addEventListener("click", changeMyPassword);
  if (isAdmin()) $("adminBtn").addEventListener("click", renderAdmin);
  $("crumb").innerHTML = crumbHtml();
  $("crumb").querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => { cwd = a.dataset.p; renderBrowser(); });
  });

  renderToolbar();
  try {
    await loadList();
    renderList();
  } catch (e) {
    $("listBox").innerHTML = `<div class="empty-tip">加载失败：${esc(e.message)}</div>`;
  }
}

function renderToolbar() {
  const t = $("toolbar");
  const up = canUpload();
  t.innerHTML = `
    ${up ? '<ore-button type="button" id="uploadBtn">上传文件</ore-button>' : ""}
    ${up ? '<ore-button type="button" id="mkdirBtn">新建文件夹</ore-button>' : ""}
    ${up ? '<ore-button type="button" id="batchDelBtn">批量删除</ore-button>' : ""}
    <ore-button type="button" id="batchDlBtn">批量下载</ore-button>
    <ore-button type="button" id="refreshBtn">刷新</ore-button>
    ${up ? '<span class="muted">上传限制：单文件 900KB 以上走 Git Blob 通道，建议 50MB 以内</span>' : '<span class="muted">你当前只有下载权限</span>'}
  `;
  if (up) {
    $("uploadBtn").addEventListener("click", () => $("filePicker").click());
    $("mkdirBtn").addEventListener("click", mkdir);
    $("batchDelBtn").addEventListener("click", batchDelete);
  }
  $("batchDlBtn").addEventListener("click", batchDownload);
  $("refreshBtn").addEventListener("click", renderBrowser);
}

function renderList() {
  const box = $("listBox");
  if (!items.length) {
    box.innerHTML = `<div class="empty-tip">空文件夹</div>`;
    return;
  }
  const rows = items.map((it, i) => {
    const isDir = it.type === "dir";
    return `<tr>
      <td><input type="checkbox" data-i="${i}" ${selected.has(it.path) ? "checked" : ""}></td>
      <td class="name" data-i="${i}">${isDir ? "[文件夹] " : ""}${esc(it.name)}</td>
      <td>${isDir ? "-" : fmtSize(it.size)}</td>
      <td class="row-actions">
        ${isDir ? "" : `<button data-dl="${i}">下载</button>`}
        ${canUpload() ? `<button class="danger" data-del="${i}">删除</button>` : ""}
      </td>
    </tr>`;
  }).join("");
  box.innerHTML = `<table class="files">
    <thead><tr><th></th><th>名称</th><th>大小</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const p = items[Number(cb.dataset.i)].path;
      if (cb.checked) selected.add(p); else selected.delete(p);
    });
  });
  box.querySelectorAll("td.name").forEach((td) => {
    td.addEventListener("click", () => {
      const it = items[Number(td.dataset.i)];
      if (it.type === "dir") { cwd = it.path; renderBrowser(); }
      else triggerDownload(it);
    });
  });
  box.querySelectorAll("button[data-dl]").forEach((b) => {
    b.addEventListener("click", () => triggerDownload(items[Number(b.dataset.dl)]));
  });
  box.querySelectorAll("button[data-del]").forEach((b) => {
    b.addEventListener("click", () => deleteItem(items[Number(b.dataset.del)]));
  });
}

function triggerDownload(item) {
  const a = document.createElement("a");
  a.href = downloadUrl(item);
  a.download = item.name;
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- 文件操作 ---------------- */

$("filePicker").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (!files.length) return;
  for (const f of files) {
    try {
      setStatus(`正在上传 ${f.name} …`);
      await uploadFile(f, joinPath(cwd, f.name));
      setStatus(`${f.name} 上传完成`);
    } catch (err) {
      setStatus(`${f.name} 上传失败：` + err.message, true);
    }
  }
  await loadList();
  renderList();
});

async function uploadFile(file, path) {
  if (!CONFIG.token) throw new Error("未配置 Token，无法上传");
  const b64 = await fileToB64(file);
  if (file.size <= 900 * 1024) {
    const body = { message: "upload: " + path, branch: CONFIG.branch, content: b64 };
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
    body: JSON.stringify({ content: b64, encoding: "base64" })
  });
  const ref = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/refs/heads/" + encodeURIComponent(CONFIG.branch));
  const commit = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/commits/" + ref.object.sha);
  const tree = await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: [{ path: path, mode: "100644", type: "blob", sha: blob.sha }]
    })
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

async function mkdir() {
  const name = prompt("文件夹名称：");
  if (!name || !name.trim()) return;
  const clean = name.trim().replace(/\/+/g, "");
  if (!clean) return setStatus("名称不能包含斜杠", true);
  try {
    setStatus("正在创建文件夹…");
    await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(joinPath(cwd, clean) + "/.gitkeep"), {
      method: "PUT",
      body: JSON.stringify({ message: "mkdir: " + joinPath(cwd, clean), branch: CONFIG.branch, content: "" })
    });
    setStatus("已创建");
    await loadList();
    renderList();
  } catch (e) {
    setStatus("创建失败：" + e.message, true);
  }
}

async function deleteRemote(path, sha) {
  await api("/repos/" + CONFIG.owner + "/" + CONFIG.repo + "/contents/" + encPath(path), {
    method: "DELETE",
    body: JSON.stringify({ message: "delete: " + path, branch: CONFIG.branch, sha: sha })
  });
}

async function deleteRecursive(item) {
  if (item.type !== "dir") return deleteRemote(item.path, item.sha);
  const list = await api(contentsUrl(item.path));
  for (const it of list) await deleteRecursive(it);
}

async function deleteItem(item) {
  if (!confirm("确定删除「" + item.name + "」？" + (item.type === "dir" ? "（将递归删除其中全部文件）" : ""))) return;
  try {
    setStatus("正在删除…");
    await deleteRecursive(item);
    setStatus("已删除");
    await loadList();
    renderList();
  } catch (e) {
    setStatus("删除失败：" + e.message, true);
  }
}

async function batchDelete() {
  if (!selected.size) return setStatus("请先勾选要删除的项目", true);
  if (!confirm(`确定删除选中的 ${selected.size} 个项目？`)) return;
  for (const p of Array.from(selected)) {
    const it = items.find((x) => x.path === p);
    if (!it) continue;
    try {
      setStatus("正在删除 " + it.name + " …");
      await deleteRecursive(it);
    } catch (e) {
      setStatus(it.name + " 删除失败：" + e.message, true);
    }
  }
  setStatus("批量删除完成");
  await loadList();
  renderList();
}

function batchDownload() {
  const files = items.filter((x) => selected.has(x.path) && x.type !== "dir");
  if (!files.length) return setStatus("请先勾选要下载的文件（文件夹不能批量下载）", true);
  files.forEach((f, i) => setTimeout(() => triggerDownload(f), i * 400));
  setStatus(`已开始下载 ${files.length} 个文件（浏览器可能拦截多个下载，请允许）`);
}

/* ---------------- 修改密码 ---------------- */

async function changeMyPassword() {
  const pwd = prompt("请输入新密码：");
  if (!pwd) return;
  try {
    setStatus("正在修改…");
    await loadUsers();
    const u = findUser(session.u);
    u.salt = randomSalt();
    u.hash = await sha256Hex(u.salt + pwd);
    await saveUsers();
    setStatus("密码已修改");
  } catch (e) {
    setStatus("修改失败：" + e.message, true);
  }
}

/* ================= 视图：人员管理 ================= */

async function renderAdmin() {
  app.innerHTML = `
    <div class="title-row">
      <h1>人员管理</h1>
      <ore-button type="button" id="backBtn">返回文件</ore-button>
    </div>
    <ore-card>
      <div class="ore-card-body">
        <h2>用户列表</h2>
        <div id="userBox"><div class="empty-tip">加载中…</div></div>
      </div>
    </ore-card>
    <div style="height:16px"></div>
    <ore-card>
      <div class="ore-card-body">
        <h2>添加用户</h2>
        <label class="f">用户名</label>
        <input type="text" id="newName" autocomplete="off">
        <label class="f">密码</label>
        <input type="password" id="newPwd">
        <label class="f"><input type="checkbox" id="newUp"> 允许上传（默认仅下载）</label>
        <div class="btn-col">
          <ore-button type="button" id="addBtn">添加用户</ore-button>
        </div>
        <div class="status" id="status"></div>
      </div>
    </ore-card>
    <footer>GitHub 网盘 ${VERSION}</footer>`;

  $("backBtn").addEventListener("click", renderBrowser);
  try {
    await loadUsers();
    renderUserTable();
  } catch (e) {
    $("userBox").innerHTML = `<div class="empty-tip">加载失败：${esc(e.message)}</div>`;
  }

  $("addBtn").addEventListener("click", async () => {
    const name = $("newName").value.trim();
    const pwd = $("newPwd").value;
    const up = $("newUp").checked;
    if (!name || !pwd) return setStatus("请填写用户名和密码", true);
    if (findUser(name)) return setStatus("用户名已存在", true);
    try {
      setStatus("正在添加…");
      const salt = randomSalt();
      usersFile.data.users.push({
        u: name, role: "user", salt: salt,
        hash: await sha256Hex(salt + pwd),
        perm: { upload: up, download: true }
      });
      await saveUsers();
      setStatus("已添加用户 " + name);
      renderUserTable();
      $("newName").value = "";
      $("newPwd").value = "";
      $("newUp").checked = false;
    } catch (e) {
      setStatus("添加失败：" + e.message, true);
    }
  });
}

function renderUserTable() {
  const rows = usersFile.data.users.map((u, i) => `<tr>
    <td>${esc(u.u)}</td>
    <td>${u.role === "admin" ? '<ore-tag variant="notice">管理员</ore-tag>' : '<ore-tag>用户</ore-tag>'}</td>
    <td><input type="checkbox" data-up="${i}" ${u.perm.upload ? "checked" : ""} ${u.role === "admin" ? "disabled" : ""}></td>
    <td>下载</td>
    <td class="row-actions">
      <button data-rp="${i}">重置密码</button>
      ${u.u === session.u || u.role === "admin" ? "" : `<button class="danger" data-rm="${i}">删除</button>`}
    </td>
  </tr>`).join("");
  $("userBox").innerHTML = `<table class="users">
    <thead><tr><th>用户名</th><th>角色</th><th>上传权限</th><th>下载权限</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  $("userBox").querySelectorAll("input[data-up]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const u = usersFile.data.users[Number(cb.dataset.up)];
      u.perm.upload = cb.checked;
      try {
        await saveUsers();
        setStatus(`已${cb.checked ? "开启" : "关闭"} ${u.u} 的上传权限`);
      } catch (e) {
        setStatus("保存失败：" + e.message, true);
      }
    });
  });
  $("userBox").querySelectorAll("button[data-rp]").forEach((b) => {
    b.addEventListener("click", async () => {
      const u = usersFile.data.users[Number(b.dataset.rp)];
      const pwd = prompt("为 " + u.u + " 设置新密码：");
      if (!pwd) return;
      try {
        u.salt = randomSalt();
        u.hash = await sha256Hex(u.salt + pwd);
        await saveUsers();
        setStatus("已重置 " + u.u + " 的密码");
      } catch (e) {
        setStatus("重置失败：" + e.message, true);
      }
    });
  });
  $("userBox").querySelectorAll("button[data-rm]").forEach((b) => {
    b.addEventListener("click", async () => {
      const u = usersFile.data.users[Number(b.dataset.rm)];
      if (!confirm("确定删除用户 " + u.u + "？")) return;
      try {
        usersFile.data.users.splice(Number(b.dataset.rm), 1);
        await saveUsers();
        setStatus("已删除用户 " + u.u);
        renderUserTable();
      } catch (e) {
        setStatus("删除失败：" + e.message, true);
      }
    });
  });
}

/* ---------------- 启动 ---------------- */

(async function boot() {
  loadSession();
  try {
    const ok = await loadUsers();
    if (!ok) return renderInit();
  } catch (e) {
    app.innerHTML = `<div class="center-box"><ore-card><div class="ore-card-body">
      <div class="empty-tip">初始化失败：${esc(e.message)}<br><br>
      请检查 app.js 顶部 CONFIG 中的 owner / repo / branch 是否正确，仓库必须为 Public。</div>
    </div></div></div>`;
    return;
  }
  if (session) renderBrowser(); else renderLogin();
})();
