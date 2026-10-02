// ui/assets/settings.js — 设置页的脚手架：向宿主报到 + 跟随主题 + 读写提问形态
//
// 必须引 SDK 并调 hana.ready()：宿主用这个握手确认 App 的 UI 页面已经挂好，
// 少了它，设置页会一直转圈，最后被判「应用加载失败」。
import { hana } from "./sdk.js";

/** 要从宿主窗口镜像过来的变量（跟面板用的是同一批） */
const VARS = [
  "--bg",
  "--bg-card",
  "--text",
  "--text-light",
  "--text-muted",
  "--accent",
  "--accent-hover",
  "--accent-rgb",
  "--border",
  "--font-ui",
  "--font-mono",
  "--corner-radius-scale",
  "--green",
  "--danger",
];

let link = null;

/** 设置页与宿主同源，直接抄它当前正在用的那套变量最可靠
 *（宿主塞进 URL 的只是创建时的初值，而且它只在主题变化时才推送） */
function fromHostWindow() {
  try {
    const hostWindow = window.parent;
    if (!hostWindow || hostWindow === window) return false;
    const root = hostWindow.document && hostWindow.document.documentElement;
    if (!root) return false;
    const computed = hostWindow.getComputedStyle(root);
    let painted = 0;
    for (const name of VARS) {
      const value = computed.getPropertyValue(name).trim();
      if (!value) continue;
      document.documentElement.style.setProperty(name, value);
      painted += 1;
    }
    const theme = String(root.dataset.theme || "").trim();
    if (theme) {
      document.documentElement.dataset.theme = theme;
      document.body.dataset.hanaTheme = theme;
    }
    return painted > 0;
  } catch (error) {
    return false;
  }
}

/** 抄不到宿主变量时的兜底：URL 里那份主题表 */
function fromUrl() {
  const advertised = new URLSearchParams(window.location.search).get("hana-css");
  if (!advertised) return;
  try {
    const stylesheetUrl = new URL(advertised, window.location.href);
    if (
      stylesheetUrl.origin !== window.location.origin ||
      (stylesheetUrl.protocol !== "http:" && stylesheetUrl.protocol !== "https:") ||
      stylesheetUrl.pathname !== "/api/apps/theme.css" ||
      !stylesheetUrl.searchParams.get("theme") ||
      stylesheetUrl.username ||
      stylesheetUrl.password ||
      stylesheetUrl.hash
    ) {
      return;
    }
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== stylesheetUrl.href) link.setAttribute("href", stylesheetUrl.href);
  } catch (error) {
    console.warn("[answer-choice] 无法加载 Hana 主题样式", error);
  }
}

if (!fromHostWindow()) fromUrl();

// 宿主换主题就重新抄一遍
try {
  const hostWindow = window.parent;
  if (hostWindow && hostWindow !== window && hostWindow.document && hostWindow.document.documentElement) {
    new MutationObserver(() => {
      if (!fromHostWindow()) fromUrl();
    }).observe(hostWindow.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
  }
} catch (error) {
  /* 不在宿主里就没有可跟随的对象 */
}

// ── 提问形态：读写本 App 的 /settings 路由 ──

function routesBase() {
  const match = /^\/api\/apps\/([^/]+)\//.exec(window.location.pathname);
  return match ? `/api/apps/${match[1]}/routes` : "";
}

async function api(path, options) {
  const base = routesBase();
  if (!base) throw new Error("拿不到应用地址");
  const headers = { "Content-Type": "application/json" };
  const token = new URLSearchParams(window.location.search).get("appSurfaceSession") || "";
  if (token) headers["X-Hana-App-Surface-Session"] = token;
  const response = await fetch(base + path, { headers, ...options });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true) {
    throw new Error((data && data.message) || `请求失败（${response.status}）`);
  }
  return data;
}

function setStatus(text) {
  const element = document.getElementById("stStatus");
  if (element) element.textContent = text;
}

function selectForm(form) {
  for (const element of document.querySelectorAll('input[name="form"]')) {
    element.checked = element.value === form;
  }
}

function pickedForm() {
  const element = [...document.querySelectorAll('input[name="form"]')].find((item) => item.checked);
  return element ? element.value : "";
}

async function loadSettings() {
  try {
    const data = await api("/settings");
    selectForm(data.form === "card" ? "card" : "panel");
  } catch (error) {
    setStatus(`读不到当前设置：${String(error?.message || error)}`);
  }
}

async function saveSettings() {
  const button = document.getElementById("stSave");
  const picked = pickedForm();
  if (!picked) {
    setStatus("先选一个形态。");
    return;
  }
  if (button) button.disabled = true;
  setStatus("保存中…");
  try {
    const data = await api("/settings", { method: "POST", body: JSON.stringify({ form: picked }) });
    setStatus(data.needsReload ? "已保存。需重启HanaAgent应用生效" : "已保存。");
  } catch (error) {
    setStatus(`保存失败：${String(error?.message || error)}`);
  } finally {
    if (button) button.disabled = false;
  }
}

document.getElementById("stSave")?.addEventListener("click", saveSettings);
loadSettings();

try {
  hana.ready();
} catch (error) {
  console.warn("[answer-choice] ready 握手失败", error);
}
