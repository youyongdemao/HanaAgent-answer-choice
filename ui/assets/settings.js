// ui/assets/settings.js — 设置页的脚手架：向宿主报到 + 跟随主题
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
    console.warn("[ask-choice] 无法加载 Hana 主题样式", error);
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

try {
  hana.ready();
} catch (error) {
  console.warn("[ask-choice] ready 握手失败", error);
}
