// ui/assets/choice.js — 输入框上方的选择面板（非阻塞版）
//
// 挂在 slot: "input-panel"：宿主只负责把它挂出来，确认按钮由页面自己画。
// 用户在页面里点选项 / 确认 / 跳过后，页面把结果 POST 到本 App 的 /submit 路由，
// App 后端再用 session:send 把选择变成一条消息送回会话。
//
// 顶栏（.ac-bar）整条是折叠开关，跟 prompt-optimizer 的面板用同一套做法：
// 收起时 iframe 只占 COLLAPSED_H，展开时才把问题和选项铺出来。
import { hana } from "./sdk.js";

// 收起后的总高：.ac 上下内边距 12 + 边框 2 + 顶栏 44
const COLLAPSED_H = 58;

const root = document.getElementById("root");
root.dataset.expanded = "true";

let panelId = "";
let panelTitle = "需要你定一下";
let question = "";
let options = [];
let allowCustom = false;
let multi = false;
let gotContext = false;
let settled = false;
let isExpanded = true;

const selected = new Set();
let customText = "";
let customEl = null;

/** 当前 App 的路由前缀，从 /api/apps/<appId>/ui/... 里取 */
function routesBase() {
  const match = /^\/api\/apps\/([^/]+)\//.exec(window.location.pathname);
  return match ? `/api/apps/${match[1]}/routes` : "";
}

/** iframe 加载时宿主挂在 query 上的 surface 凭证，调自己的路由要带回去 */
function surfaceToken() {
  return new URLSearchParams(window.location.search).get("appSurfaceSession") || "";
}

async function post(body) {
  const base = routesBase();
  if (!base) throw new Error("拿不到应用地址");
  const headers = { "Content-Type": "application/json" };
  const token = surfaceToken();
  if (token) headers["X-Hana-App-Surface-Session"] = token;
  const response = await fetch(`${base}/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true) {
    throw new Error((data && data.message) || `提交失败（${response.status}）`);
  }
  return data;
}

function pushPresentation(patch) {
  try {
    Promise.resolve(hana.inputPanel.setPresentation(patch)).catch(() => {});
  } catch {
    /* 宿主不支持时保持默认高度 */
  }
}

function measureHeight() {
  return Math.ceil(root.getBoundingClientRect().bottom + 8);
}

/**
 * 量好内容高度报给宿主。只在上报值真的变了才发：
 * 反复上报会把宿主拖进「改高度 → 重排 → 再上报」的循环，表现就是悬停时一直闪。
 */
let heightTimer = null;
let lastReportedHeight = 0;
function reportHeight() {
  if (!isExpanded) return; // 收起时宿主用 collapsedHeight，不用管内容高度
  if (heightTimer) clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    const height = measureHeight();
    if (height <= 0) return;
    if (lastReportedHeight && Math.abs(height - lastReportedHeight) < 2) return;
    lastReportedHeight = height;
    pushPresentation({ height, collapsedHeight: COLLAPSED_H, expanded: true });
  }, 60);
}

function applyExpanded(expanded) {
  isExpanded = Boolean(expanded);
  root.dataset.expanded = isExpanded ? "true" : "false";
}

function setExpanded(expanded) {
  applyExpanded(expanded);
  const patch = { expanded: isExpanded, collapsedHeight: COLLAPSED_H };
  if (isExpanded) {
    const height = measureHeight();
    if (height > 0) {
      lastReportedHeight = height;
      patch.height = height;
    }
  }
  pushPresentation(patch);
}

/** 自定义输入框只建一次：每次重绘都重建会让正在打字的人丢焦点 */
function ensureCustomInput() {
  if (customEl) return customEl;
  customEl = document.createElement("input");
  customEl.type = "text";
  customEl.className = "ac-custom";
  customEl.spellcheck = false;
  customEl.placeholder = "或输入你的答案";
  customEl.addEventListener("input", () => {
    customText = customEl.value;
    // 单选时「自己写」和「点选项」互斥，写了就把选项的选择让出来
    if (customText.trim() && !multi && selected.size) {
      selected.clear();
      renderOptions();
    }
  });
  return customEl;
}

function renderOptions() {
  const list = document.getElementById("ac-options");
  if (!list) return;
  list.replaceChildren();
  options.forEach((option, index) => {
    const on = selected.has(option);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ac-opt" + (on ? " is-on" : "");
    btn.setAttribute("aria-pressed", on ? "true" : "false");

    const mark = document.createElement("span");
    mark.className = "ac-num";
    mark.textContent = String(index + 1);
    mark.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "ac-label";
    label.textContent = option;

    btn.append(mark, label);
    btn.addEventListener("click", () => {
      if (settled) return;
      if (multi) {
        if (selected.has(option)) selected.delete(option);
        else selected.add(option);
        renderOptions();
        setHint("");
        return;
      }
      // 单选：点一下就走，不用再按确认
      selected.clear();
      selected.add(option);
      if (customEl) {
        customEl.value = "";
        customText = "";
      }
      renderOptions();
      submit({ panelId, choice: option });
    });
    list.appendChild(btn);
  });

  // 多选时把已选数量显示在顶栏，不另占一行
  const tag = document.getElementById("ac-tag");
  if (tag) tag.textContent = selected.size ? `已选 ${selected.size}` : "可多选";
}

function setHint(text) {
  const hint = document.getElementById("ac-hint");
  if (hint) hint.textContent = text;
}

function readChoice() {
  const picked = [...selected];
  const text = customText.trim();
  if (text) picked.push(text);
  return picked.join("、");
}

function showDone(message) {
  settled = true;
  const box = document.getElementById("ac-box");
  if (box) box.classList.add("is-done");
  const done = document.getElementById("ac-done");
  if (done) {
    done.textContent = message;
    done.hidden = false;
  }
  reportHeight();
}

async function submit(body) {
  if (settled) return;
  // 乐观锁定：单选是点一下就走，连点两下只能算一次
  settled = true;
  const confirmBtn = document.getElementById("ac-confirm");
  const skipBtn = document.getElementById("ac-skip");
  if (confirmBtn) confirmBtn.disabled = true;
  if (skipBtn) skipBtn.disabled = true;
  setHint("");
  try {
    await post(body);
    showDone(body.skip === true ? "已跳过，我把这题交回对话了。" : "已发回对话，我接着往下做。");
  } catch (error) {
    settled = false;
    if (confirmBtn) confirmBtn.disabled = false;
    if (skipBtn) skipBtn.disabled = false;
    setHint(String(error?.message || error));
    reportHeight();
  }
}

const TOGGLE_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round"><path d="M2.6 4.4 6 7.8l3.4-3.4"></path></svg>';

function render() {
  root.replaceChildren();

  if (!gotContext) {
    const waiting = document.createElement("p");
    waiting.className = "ac-waiting";
    waiting.textContent = "正在准备选项…";
    root.appendChild(waiting);
    return;
  }

  const box = document.createElement("section");
  box.className = "ac-box";
  box.id = "ac-box";

  // ── 顶栏：整条可点，用来收起 / 展开 ──
  const bar = document.createElement("p");
  bar.className = "ac-bar";
  bar.id = "ac-bar";
  bar.setAttribute("role", "button");
  bar.setAttribute("tabindex", "0");

  const dot = document.createElement("span");
  dot.className = "ac-dot";
  dot.setAttribute("aria-hidden", "true");

  const headText = document.createElement("span");
  headText.className = "ac-head-text";
  headText.textContent = panelTitle;

  bar.append(dot, headText);

  if (multi) {
    const tag = document.createElement("span");
    tag.className = "ac-tag";
    tag.id = "ac-tag";
    tag.textContent = "可多选";
    bar.appendChild(tag);
  }

  const tools = document.createElement("span");
  tools.className = "ac-tools";

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "ac-btn";
  skipBtn.id = "ac-skip";
  skipBtn.textContent = "跳过";
  skipBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!settled) submit({ panelId, skip: true });
  });

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "ac-btn primary";
  confirmBtn.id = "ac-confirm";
  confirmBtn.textContent = "确认";
  confirmBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (settled) return;
    const choice = readChoice();
    if (!choice) {
      setHint("先选一个，或者自己写一个答案。");
      return;
    }
    submit({ panelId, choice });
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "ac-icon";
  toggleBtn.id = "ac-toggle";
  toggleBtn.setAttribute("aria-label", "收起或展开");
  toggleBtn.innerHTML = TOGGLE_ICON;
  toggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setExpanded(!isExpanded);
  });

  tools.append(skipBtn);
  // 纯单选（不能自己写答案）时点选项即提交，确认按钮没有存在意义
  if (multi || allowCustom) tools.appendChild(confirmBtn);
  tools.appendChild(toggleBtn);
  bar.appendChild(tools);

  bar.addEventListener("click", () => setExpanded(!isExpanded));
  bar.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setExpanded(!isExpanded);
  });

  box.appendChild(bar);

  // ── 主体 ──
  const body = document.createElement("div");
  body.className = "ac-body";

  const q = document.createElement("p");
  q.className = "ac-question";
  q.textContent = question;
  body.appendChild(q);

  const optionsWrap = document.createElement("div");
  optionsWrap.id = "ac-options";
  optionsWrap.className = "ac-options";
  body.appendChild(optionsWrap);

  if (allowCustom) {
    const customRow = document.createElement("div");
    customRow.className = "ac-custom-row";
    customRow.appendChild(ensureCustomInput());
    body.appendChild(customRow);
  }

  // 只在报错时占位：平时是空的，不会把面板撑高
  const hint = document.createElement("p");
  hint.id = "ac-hint";
  hint.className = "ac-hint";
  body.appendChild(hint);

  const done = document.createElement("p");
  done.className = "ac-done";
  done.id = "ac-done";
  done.hidden = true;
  body.appendChild(done);

  box.appendChild(body);
  root.appendChild(box);
  renderOptions();
  reportHeight();
}

hana.inputPanel.onContextChanged((panel) => {
  if (!panel) return;
  const data = panel.data || {};
  panelId = typeof data.panelId === "string" ? data.panelId : "";
  panelTitle = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "需要你定一下";
  question = typeof data.question === "string" ? data.question : "";
  options = Array.isArray(data.options) ? data.options.map((item) => String(item)) : [];
  allowCustom = data.allowCustom !== false;
  multi = data.multi === true;
  gotContext = true;
  applyExpanded(panel.presentation ? panel.presentation.expanded !== false : true);
  render();
});

hana.ready();
render();
