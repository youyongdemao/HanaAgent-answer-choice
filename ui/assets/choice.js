// ui/assets/choice.js — 输入框上方的选择页
//
// 这个页面挂在 slot: "input-panel"：宿主在 iframe 外面放确认 / 拒绝，
// 页面只负责把题目和选项画出来，并在用户点确认时把选择交回去（onSubmit）。
import { hana } from "./sdk.js";

const root = document.getElementById("root");

let question = "";
let options = [];
let allowCustom = false;
let multi = false;
let gotContext = false;

const selected = new Set();
let customText = "";
let customEl = null;

/** 自定义输入框只建一次：每次重绘都重建会让正在打字的人丢焦点 */
function ensureCustomInput() {
  if (customEl) return customEl;
  customEl = document.createElement("input");
  customEl.type = "text";
  customEl.className = "ac-custom";
  customEl.spellcheck = false;
  customEl.placeholder = "其他：自己写一个答案";
  customEl.addEventListener("input", () => {
    customText = customEl.value;
    // 单选时「自己写」和「点按钮」互斥，写了就把按钮的选择让出来
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
  for (const option of options) {
    const on = selected.has(option);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ac-opt" + (on ? " is-on" : "");
    btn.setAttribute("aria-pressed", on ? "true" : "false");

    const mark = document.createElement("span");
    mark.className = "ac-mark";
    mark.textContent = on ? "✓" : "";
    mark.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "ac-label";
    label.textContent = option;

    btn.append(mark, label);
    btn.addEventListener("click", () => {
      if (multi) {
        if (selected.has(option)) selected.delete(option);
        else selected.add(option);
      } else {
        selected.clear();
        selected.add(option);
        if (customEl) {
          customEl.value = "";
          customText = "";
        }
      }
      renderOptions();
    });
    list.appendChild(btn);
  }
}

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

  const q = document.createElement("p");
  q.className = "ac-question";
  q.textContent = question;
  box.appendChild(q);

  const optionsWrap = document.createElement("div");
  optionsWrap.id = "ac-options";
  optionsWrap.className = "ac-options";
  box.appendChild(optionsWrap);

  if (allowCustom) {
    const customRow = document.createElement("div");
    customRow.className = "ac-custom-row";
    customRow.appendChild(ensureCustomInput());
    box.appendChild(customRow);
  }

  const foot = document.createElement("p");
  foot.className = "ac-foot";
  foot.textContent = multi
    ? "可多选；选好后点输入框旁边的确认按钮"
    : "选好后点输入框旁边的确认按钮；也可以自己写一个";
  box.appendChild(foot);

  root.appendChild(box);
  renderOptions();
}

/** 把当前选择拼成一个字符串：多选用「、」连接，自定义答案直接追加 */
function readChoice() {
  const picked = [...selected];
  const text = customText.trim();
  if (text) picked.push(text);
  return picked.join("、");
}

hana.inputPanel.onContextChanged((panel) => {
  if (!panel) return;
  const data = panel.data || {};
  question = typeof data.question === "string" ? data.question : "";
  options = Array.isArray(data.options) ? data.options.map((item) => String(item)) : [];
  allowCustom = data.allowCustom !== false;
  multi = data.multi === true;
  gotContext = true;
  render();
});

hana.inputPanel.onSubmit(() => {
  const choice = readChoice();
  if (!choice) {
    // 抛出明确错误，宿主会显示出来并让用户重试，而不是当成空答案收下
    throw new Error("先选一个，或者在「其他」里写点内容。");
  }
  return { choice };
});

hana.ready();
render();
