// ask-choice v2 App — 把「需要用户拿主意」变成输入框上方的一次点选（非阻塞版）
//
// 为什么不用阻塞式 userInteraction.ask：宿主对 App 工具执行有 30 秒 RPC 硬超时
// （app-host-entry.js 的 APP_HOST_RPC_TIMEOUT_MS = 30000），指望用户在 30 秒内
// 读完选项再点完确认并不现实，超时后工具直接失败。
//
// 所以改成两段式：
//   1. 工具 execute 用 userInteraction.show 把面板挂到输入框上方，立刻返回回执；
//   2. 用户在面板上点确认，面板页面 POST 到本 App 的 /submit 路由，这里再用
//      session:send 把选择作为一条消息投回会话，唤醒 Agent 继续。
//
// 需要的能力：
//   app/input.panels        —— 往输入框上方渲染自己的面板
//   app/session.start-turn  —— 往会话里投一条会进入模型的回合
//   app/sessions.manage     —— 目标会话不属于本 App 时（scope: "all"）才需要
import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "ask-choice";

const MAX_OPTIONS = 8;
const MAX_QUESTION_CHARS = 2000;

/** 去空、去重、截断，最多 MAX_OPTIONS 项 */
function normalizeOptions(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out;
}

function newPanelId() {
  return `ask-choice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(error) {
  return String(error?.message || error);
}

const FORM_PANEL = "panel";
const FORM_CARD = "card";

/**
 * 工具本身的描述。形态指令不写在这里：工具描述在 App 启动时就固定了、改不了，
 * 用户切换形态后它会过期。形态相关的指令统一由 agent/before-start 每轮现读设置
 * 后注入（见下面的 buildRule），这里只留一句指路，说清以系统提示为准。
 */
const TOOL_DESCRIPTION =
  "【默认动作】只要你要问用户一个能拆成 2 到 8 个短语的问题，就必须调用本工具把选项挂出来，不要用文字去罗列问题或选项。" +
  "三种场景必用：① 需要用户拍板的岔路（用哪个方案、改哪个文件、走哪条路线）；② 你自己主动发起提问、想收集偏好或让用户挑方向；③ 顺带收的小选择（先动哪块、要不要一起处理）。" +
  "把选项挂到用户输入框上方，用户点选后答案会作为一条新消息回到对话里。" +
  "只有这几种情况才用普通回复：答案需要展开解释或写成一句话以上的长文；答案只有一个合理选项；你自己能查到或能直接决定的事。" +
  "调用后立刻返回「面板已挂出」的回执，用户点完你才会收到新消息，因此同一轮里不要重复调用。" +
  "用户可以把提问形态切成「卡片」，那时本工具不挂面板，而是返回一份已填好内容的卡片 HTML，" +
  "由你原样交给 show_card 的 code；当前该走哪条通道，以系统提示里的形态规则为准。";

/** 卡片形态的界面文案，按语言取一套，只把用得上的那套写进 HTML。 */
const CARD_TEXT = {
  zh: { skip: "跳过", submit: "提交", custom: "或输入你的答案", empty: "先选一个，或者自己写一个答案。", chosen: "已选择：", skipped: "（跳过了这题）", multi: "可多选", picked: "已选 ", noHost: "此卡片需要 Hana 才能把选择交回对话。", failed: "没能把这题交回对话。" },
  "zh-TW": { skip: "略過", submit: "送出", custom: "或輸入你的答案", empty: "先選一個，或者自己寫一個答案。", chosen: "已選擇：", skipped: "（略過了這題）", multi: "可多選", picked: "已選 ", noHost: "此卡片需要 Hana 才能把選擇交回對話。", failed: "沒能把這題交回對話。" },
  en: { skip: "Skip", submit: "Submit", custom: "Or type an answer", empty: "Pick one, or write your own answer.", chosen: "Chosen: ", skipped: "(skipped)", multi: "Multiple picks allowed", picked: "picked ", noHost: "This card needs Hana to send your answer back.", failed: "Could not send the answer back." },
  ja: { skip: "スキップ", submit: "送信", custom: "または回答を入力", empty: "1 つ選ぶか、回答を入力してください。", chosen: "選択：", skipped: "（スキップしました）", multi: "複数選択可", picked: "件選択 ", noHost: "回答を会話に返すには Hana が必要です。", failed: "回答を送信できませんでした。" },
  ko: { skip: "건너뛰기", submit: "제출", custom: "또는 답을 입력", empty: "하나를 고르거나 답을 입력하세요.", chosen: "선택: ", skipped: "(건너뜀)", multi: "복수 선택 가능", picked: "개 선택 ", noHost: "답을 대화로 보내려면 Hana가 필요합니다.", failed: "답을 보내지 못했습니다." },
};

/**
 * 生成卡片形态用的完整 HTML。
 *
 * 这条路径是为了不依赖 Recipe：show_card 的 template 只认全局安装的配方，装 App 装不来；
 * 而 file 源拿不到 state（“state is only valid with template”），路径也不在允许根内。
 * code 源没有这些限制，代价是内容要自带，所以数据在生成时直接写进文档。
 */
function renderCardHtml(input) {
  const lang = Object.prototype.hasOwnProperty.call(CARD_TEXT, input.uiLanguage) ? input.uiLanguage : "zh";
  const words = CARD_TEXT[lang];
  const data = JSON.stringify({
    q: input.question,
    t: input.title,
    o: input.options,
    m: input.multi === true,
    c: input.allowCustom !== false,
  }).replace(/</g, "\\u003c");
  const labels = JSON.stringify({
    sk: words.skip,
    sb: words.submit,
    cu: words.custom,
    em: words.empty,
    ch: words.chosen,
    skp: words.skipped,
    mu: words.multi,
    pk: words.picked,
    nh: words.noHost,
    fa: words.failed,
  }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ask choice</title>
</head>
<body>
<script type="application/json" data-card-manifest>{"spec":"1.0","display":{"preferredWidthPx":520}}</script>
<style>
html,body{margin:0;background:transparent}
body{font:400 13px/1.55 var(--font-ui,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);color:var(--text)}
.ac{padding:38px 2px 12px;max-width:460px;margin:0 auto}
.ac-box{display:flex;flex-direction:column;border:1px solid var(--border,color-mix(in srgb,var(--text) 12%,transparent));border-radius:calc(14px * var(--corner-radius-scale,1));background:color-mix(in srgb,var(--bg-card,#fff) 72%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
@supports ((-webkit-backdrop-filter:blur(2px)) or (backdrop-filter:blur(2px))){.ac-box{-webkit-backdrop-filter:blur(26px);backdrop-filter:blur(26px)}}
.ac-bar{display:flex;align-items:center;gap:8px;margin:0;padding:10px 10px 0 12px;flex:0 0 auto;background:transparent}
.ac-dot{flex:none;width:7px;height:7px;border-radius:2px;background:var(--accent)}
.ac-head{min-width:0;font-size:11.5px;line-height:1.4;color:var(--text-light,var(--text));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-tag{flex:none;font-size:11px;line-height:1.4;color:var(--text-light,var(--text));opacity:.72}
.ac-tools{display:flex;align-items:center;gap:5px;flex:none;margin-left:auto}
.ac-body{display:grid;gap:8px;padding:0 12px 10px}
.ac-question{margin:0;font-size:14px;font-weight:600;line-height:1.5;letter-spacing:-.01em;overflow-wrap:anywhere}
.ac-options{display:flex;flex-direction:column;gap:6px}
.ac-opt{display:flex;align-items:center;gap:11px;min-width:0;appearance:none;text-align:left;border:1px solid var(--border,color-mix(in srgb,var(--text) 14%,transparent));border-radius:calc(12px * var(--corner-radius-scale,1));background:transparent;color:var(--text);padding:9px 11px;font:inherit;font-size:13px;line-height:1.45;cursor:pointer;transition:background .16s ease,border-color .16s ease}
.ac-opt:hover{background:color-mix(in srgb,var(--text) 6%,transparent)}
.ac-opt.is-on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.ac-num{flex:none;width:19px;height:19px;display:grid;place-items:center;border-radius:calc(6px * var(--corner-radius-scale,1));background:color-mix(in srgb,var(--text) 9%,transparent);font-size:11px;line-height:1;color:var(--text-light,var(--text))}
.ac-opt.is-on .ac-num{background:var(--accent);color:#fff}
.ac-label{min-width:0;overflow-wrap:anywhere}
.ac-custom-row{display:flex}
.ac-custom{flex:1;min-width:0;border:1px solid var(--border,color-mix(in srgb,var(--text) 12%,transparent));border-radius:calc(12px * var(--corner-radius-scale,1));background:transparent;color:var(--text);padding:9px 11px;font:inherit;font-size:13px;transition:border-color .16s,box-shadow .16s}
.ac-custom:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 12%,transparent)}
.ac-custom::placeholder{color:var(--text-light,var(--text));opacity:.65}
.ac-hint{margin:0;font-size:11px;line-height:1.4;color:var(--danger,#d9534f)}
.ac-hint:empty{display:none}
.ac-done{margin:0;font-size:12.5px;line-height:1.5;color:var(--text)}
.ac-btn{padding:5px 12px;border:1px solid var(--border,color-mix(in srgb,var(--text) 14%,transparent));border-radius:calc(8px * var(--corner-radius-scale,1));background:transparent;color:var(--text);font:inherit;font-size:12px;line-height:1.5;cursor:pointer;transition:background .16s ease}
.ac-btn:hover{background:color-mix(in srgb,var(--text) 7%,transparent)}
.ac-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.ac-btn.primary:hover{background:var(--accent-hover)}
.ac-btn[disabled]{opacity:.5;cursor:default}
.ac-box.is-done .ac-options,.ac-box.is-done .ac-custom-row,.ac-box.is-done .ac-tools{display:none}
</style>
<div class="ac">
<section class="ac-box" id="box">
<p class="ac-bar">
<span class="ac-dot" aria-hidden="true"></span>
<span class="ac-head" id="head"></span>
<span class="ac-tag" id="tag" hidden></span>
<span class="ac-tools" id="tools">
<button type="button" class="ac-btn" id="skip"></button>
<button type="button" class="ac-btn primary" id="confirm"></button>
</span>
</p>
<div class="ac-body">
<p class="ac-question" id="q"></p>
<div class="ac-options" id="o"></div>
<div class="ac-custom-row" id="crow"><input class="ac-custom" id="custom" type="text" spellcheck="false"></div>
<p class="ac-hint" id="h"></p>
<p class="ac-done" id="done" hidden></p>
</div>
</section>
</div>
<script>
(function(){
var D=${data},L=${labels},api=window.card;
var box=document.getElementById("box"),ob=document.getElementById("o"),hn=document.getElementById("h"),ie=document.getElementById("custom");
var skb=document.getElementById("skip"),cfb=document.getElementById("confirm"),tg=document.getElementById("tag"),crow=document.getElementById("crow"),dn=document.getElementById("done"),tl=document.getElementById("tools");
var picked=[],done=false,multi=D.m,allowCustom=D.c;
document.getElementById("q").textContent=D.q;
document.getElementById("head").textContent=D.t?D.t:"";
skb.textContent=L.sk;cfb.textContent=L.sb;
if(allowCustom){ie.setAttribute("placeholder",L.cu);}else{crow.hidden=true;}
if(multi){tg.hidden=false;tg.textContent=L.mu;}
if(!multi&&!allowCustom){tl.removeChild(cfb);}
function paint(){for(var i=0;i<ob.children.length;i++){var b=ob.children[i],on=picked.indexOf(b.getAttribute("data-l"))!==-1;b.className="ac-opt"+(on?" is-on":"");b.setAttribute("aria-pressed",on?"true":"false");}if(multi){tg.textContent=picked.length?L.pk+picked.length:L.mu;}}
function hint(x){hn.textContent=x;}
function fin(kind,choice){done=true;box.className="ac-box is-done";dn.hidden=false;dn.textContent=kind==="skip"?L.skp:L.ch+choice;}
function send(name,payload,kind,choice){
if(!api||typeof api.capabilities!=="function"||typeof api.emit!=="function"){hint(L.nh);return;}
api.capabilities().then(function(env){
var res=env&&env.ok===true?env.result:null,caps=res&&res.capabilities?res.capabilities:null,word=caps&&typeof caps.emit==="string"?caps.emit:"";
if(word!=="available"&&word!=="local_fallback"){hint(L.nh);return;}
return api.emit(name,payload).then(function(reply){if(reply&&reply.ok===true){fin(kind,choice);}else{hint(L.fa);}});
}).catch(function(){hint(L.fa);});
}
D.o.forEach(function(label,index){
var b=document.createElement("button");b.type="button";b.className="ac-opt";b.setAttribute("data-l",label);b.setAttribute("aria-pressed","false");
var n=document.createElement("span");n.className="ac-num";n.setAttribute("aria-hidden","true");n.textContent=String(index+1);
var tx=document.createElement("span");tx.className="ac-label";tx.textContent=label;
b.appendChild(n);b.appendChild(tx);
b.addEventListener("click",function(){
if(done)return;
if(multi){var at=picked.indexOf(label);if(at===-1){picked.push(label);}else{picked.splice(at,1);}paint();hint("");return;}
picked=[label];ie.value="";paint();send("answer",{choice:label},"answer",label);
});
ob.appendChild(b);
});
if(allowCustom){ie.addEventListener("input",function(){if(ie.value.trim()&&!multi&&picked.length){picked=[];paint();}hint("");});}
cfb.addEventListener("click",function(){if(done)return;var typed=ie.value?ie.value.trim():"",v=typed||picked.join("、");if(!v){hint(L.em);return;}send("answer",{choice:v},"answer",v);});
skb.addEventListener("click",function(){if(done)return;send("skip",{},"skip","");});
})();
</script>
</body>
</html>`;
}

/**
 * 从会话路径解出 sessionId。
 * 宿主对 session:get 的定位方式在不同版本里换过：先试 legacySessionPath，再试 sessionPath，
 * 最后从会话列表里按 path 找。找不到就抛，外面会包上具体原因。
 */
async function resolveSessionId(sdk, sessionPath) {
  let lastError = null;
  for (const target of [
    { legacySessionPath: sessionPath, scope: "all" },
    { sessionPath, scope: "all" },
  ]) {
    try {
      const info = await sdk.sessions.get(target);
      const id = info && info.session ? info.session.sessionId : null;
      if (typeof id === "string" && id) return id;
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const listed = await sdk.sessions.list({ scope: "all" });
    const hit = ((listed && listed.sessions) || []).find((entry) => entry && entry.path === sessionPath);
    if (hit && typeof hit.sessionId === "string" && hit.sessionId) return hit.sessionId;
  } catch (error) {
    lastError = error;
  }
  throw new Error(`读会话标识失败：${errorText(lastError)}`);
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("ask-choice loaded");

  /** panelId -> { panelId, sessionPath, sessionId, callToken, question } */
  const pending = new Map();

  /** 当前的工具注册句柄：形态变了就注销重注册，不用等 App 重载 */
  let askTool = null;

  /**
   * 读当前形态。
   *
   * 存在 `sdk.storage.global`，不放在 manifest 的 settings schema 里：这个宿主版本上
   * `ctx.config` 写进去的值读不回来——保存会把值落进 preferences.json 的
   * settings_contributions，读取却一律返回空（get 给 null、getAll 给 {}），
   * 而 storage 落在本 App 自己的 app-data/<id>/storage/global.json，读写都稳。
   * 旧值曾写在 config 里，所以第一次读不到 storage 时顺手迁一次。
   */
  async function readForm() {
    try {
      const stored = await sdk.storage.global.get("form", null);
      if (stored === FORM_CARD || stored === FORM_PANEL) return stored;
    } catch (error) {
      await sdk.logger.warn(`ask-choice: 读 storage 失败 ${errorText(error)}`);
    }
    try {
      const legacy = await sdk.config.get("form");
      if (legacy === FORM_CARD || legacy === FORM_PANEL) {
        await sdk.storage.global.set("form", legacy);
        await sdk.logger.info(`ask-choice: 形态从 config 迁移到 storage = ${legacy}`);
        return legacy;
      }
    } catch {
      /* 老通道读不到就算了，不拦启动 */
    }
    return null;
  }

  /** 读当前形态设置；读不到就当面板。 */
  async function currentForm() {
    const stored = await readForm();
    await sdk.logger.info(`ask-choice: 形态读取 = ${JSON.stringify(stored)}`);
    return stored === FORM_CARD ? FORM_CARD : FORM_PANEL;
  }

  const form = await currentForm();
  await sdk.logger.info(`ask-choice: 提问形态 = ${form}`);

  /**
   * 收起一个会话下还挂着的面板。
   * 用户在会话里发了新消息，这次提问就算过去了，面板不该继续占着输入框上方。
   */
  async function dismissPanels(sessionId) {
    let count = 0;
    for (const [id, record] of [...pending]) {
      if (sessionId && record.sessionId !== sessionId) continue;
      pending.delete(id);
      count += 1;
      try {
        await sdk.userInteraction.dismiss({ sessionId: record.sessionId, id: record.panelId });
      } catch (error) {
        await sdk.logger.warn(`ask-choice: 收面板失败 ${errorText(error)}`);
      }
    }
    return count;
  }

  // 用户一提交输入（也就是开启新一轮），先把还敞开的面板收掉。
  // 只做副作用，返回 undefined：完全不碰用户输入的内容。
  await sdk.hooks.onDecision("session/input", async (invocation) => {
    const sessionId = typeof invocation?.sessionId === "string" ? invocation.sessionId : "";
    const count = await dismissPanels(sessionId);
    if (count > 0) await sdk.logger.info(`ask-choice: 收到新的输入，收起了 ${count} 个面板`);
    return undefined;
  });

  // ---------------------------------------------------------------------------
  // 每轮把「该用快捷回复」这条规则钉进系统提示。
  //
  // 光靠工具描述不够：模型在一长串工具里未必每次都想得起它，现实中往往要
  // 真人补一句「你怎么不用卡片」才触发。而发布给别人用之后，没有人会补这句。
  // 所以改成 App 自己每轮注入 —— 把「靠人提醒」换成「靠机制提醒」。
  //
  // 走 agent/before-start：它在每轮开始前拿到该轮的 systemPrompt，可以返回
  // 改写后的版本，代价小、位置最靠前。注入前先查标记，避免宿主重复传入时叠加。
  // ---------------------------------------------------------------------------
  const RULE_MARK = "【快捷回复 / ask-choice】";
  const RULE_TAIL =
    "需要长篇展开的、只剩一个合理选项的、你自己能查到或直接决定的问题，不问。";

  /**
   * 按当前形态拼这一轮要注入的规则。
   * form 在 App 启动时读一次就定格，所以用户在设置页切换形态后要重启宿主才生效——
   * 设置页的提示跟这句话对齐。不改成每轮现读，是因为工具面与会话快照都是启动时定下的，
   * 行为跟提示咬死比省一次重启更要紧。
   */
  function buildRule(form) {
    if (form === FORM_CARD) {
      return (
        RULE_MARK +
        "要用户拿主意时，只要问题能拆成 2 到 8 个短选项，就必须把选项挂出来，" +
        "不要在正文里罗列问题让用户自己找答案。" +
        "当前形态是「卡片」，两步走：" +
        "① 调 tool_call，server 传 \"ask-choice\"、tool 传 \"ask_choice\"、" +
        "arguments 传 { question, options, uiLanguage }（需要多选再加 multi: true），" +
        "它会返回一份内容已填好的完整卡片 HTML；" +
        "② 把返回的文本逐字原样交给 show_card 的 code 参数，title 自己起一个。" +
        "不要改动那份 HTML、不要精简、不要另写包装，也不要改回 template + state 的老写法：" +
        "卡片内容已经写在 HTML 里了。" +
        RULE_TAIL
      );
    }
    return (
      RULE_MARK +
      "要用户拿主意时，只要问题能拆成 2 到 8 个短选项，就必须把选项挂到用户输入框上方，" +
      "不要在正文里罗列问题让用户自己找答案。" +
      "当前形态是「弹窗」：调用内置工具 tool_call，参数 server 传 \"ask-choice\"、" +
      "tool 传 \"ask_choice\"、arguments 传 { question, options }。" +
      "ask_choice 是应用工具，通常不在你手边的工具表里，但按上面这个方式一步就能调到；" +
      "不要因为工具表里没有它或没搜到它，就改用文字提问，也不必先 tool_search。" +
      RULE_TAIL
    );
  }

  /** 启动时定格的那份规则，每轮原样注入。 */
  const RULE_TEXT = buildRule(form);

  await sdk.hooks.onDecision("agent/before-start", async (invocation) => {
    const base = typeof invocation?.systemPrompt === "string" ? invocation.systemPrompt : "";
    if (base.includes(RULE_MARK)) return undefined; // 已经在里面了，不再叠加
    return { systemPrompt: base ? `${base}\n\n${RULE_TEXT}` : RULE_TEXT };
  });

  await sdk.routes.register((app) => {
    // 设置页读当前形态
    app.get("/settings", async (c) => {
      return c.json({ ok: true, form: await currentForm() });
    });

    // 设置页保存形态
    app.post("/settings", async (c) => {
      let body = null;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      const value = body && body.form === FORM_CARD ? FORM_CARD : FORM_PANEL;
      try {
        await sdk.storage.global.set("form", value);
        await sdk.logger.info(`ask-choice: 形态已保存 = ${value}`);
      } catch (error) {
        await sdk.logger.warn(`ask-choice: 形态保存失败 = ${errorText(error)}`);
        return c.json({ ok: false, message: `保存失败：${errorText(error)}` }, 500);
      }
      // needsReload 恒为 true：设置页按「需重启生效」提示。
      return c.json({ ok: true, form: value, needsReload: true });
    });

    // 面板页面点「确认」或「跳过」后打到这里
    app.post("/submit", async (c) => {
      let body = null;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }

      const panelId = body && typeof body.panelId === "string" ? body.panelId : "";
      const record = panelId ? pending.get(panelId) : null;
      if (!record) {
        return c.json({ ok: false, message: "这次提问已经失效，直接在对话里说就行。" }, 409);
      }

      const skipped = body.skip === true;
      const choice = typeof body.choice === "string" ? body.choice.trim() : "";
      if (!skipped && !choice) {
        return c.json({ ok: false, message: "先选一个，或者自己写一个答案。" }, 400);
      }

      const text = skipped ? "（用户跳过了这次选择）" : `用户的选择：${choice}`;
      // 定位优先用 sessionId：hub 对 session:send 的路径解析不认 sessionPath，
      // 只认 sessionId 或 legacySessionPath。sessionId 在挂面板前已经拿到了。
      const attempts = [
        { label: "sessionId", target: { sessionId: record.sessionId } },
        { label: "legacySessionPath", target: { legacySessionPath: record.sessionPath } },
        { label: "sessionPath", target: { sessionPath: record.sessionPath } },
      ].filter((attempt) => {
        const value = attempt.target.sessionId ?? attempt.target.legacySessionPath ?? attempt.target.sessionPath;
        return typeof value === "string" && value.length > 0;
      });

      let sent = false;
      const failures = [];
      for (const attempt of attempts) {
        try {
          await sdk.sessions.send({ ...attempt.target, scope: "all", text, deliverAs: "followUp" });
          sent = true;
          break;
        } catch (error) {
          failures.push(`${attempt.label} → ${errorText(error)}`);
        }
      }
      if (!sent) {
        const detail = failures.join(" ｜ ");
        await sdk.logger.warn(`ask-choice: 回传选择失败：${detail}`);
        return c.json({ ok: false, message: `没能把答案送回对话：${detail}` }, 500);
      }

      pending.delete(panelId);
      try {
        await sdk.userInteraction.dismiss({ sessionId: record.sessionId, id: record.panelId });
      } catch (error) {
        await sdk.logger.warn(`ask-choice: 收起面板失败 ${errorText(error)}`);
      }
      return c.json({ ok: true });
    });
  });

  async function registerAskTool() {
    // 形态在 App 启动时读一次。宿主不允许同名工具重复注册，而先注销会让执行器映射失效
    //（工具表仍指着旧 handle，调用报 "no tool executor"），所以形态切换只能靠重载 App 生效。
    askTool = await sdk.tools.register({
    name: "ask_choice",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问用户的问题，一句话说清让他定什么。" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2 到 8 个候选项，每个写成简短短语，不要写成整句话。",
        },
        allow_custom: { type: "boolean", description: "是否允许用户自己写一个答案，默认允许。" },
        multi: { type: "boolean", description: "是否允许多选，默认单选。" },
        title: { type: "string", description: "面板标题，省略时用「需要你定一下」。" },
        uiLanguage: { type: "string", description: "卡片形态的界面语言：zh / zh-TW / en / ja / ko，取当前对话语言，省略按 zh。" },
      },
      required: ["question", "options"],
    },
    execute: async ({ question, options, allow_custom, multi, title, uiLanguage, context } = {}) => {
      const text = typeof question === "string" ? question.trim() : "";
      if (!text) throw new Error("ask_choice 需要 question。");
      const list = normalizeOptions(options);
      if (list.length < 2) throw new Error("ask_choice 至少需要 2 个不同的候选项。");

      const allowCustom = allow_custom !== false;
      const isMulti = multi === true;

      // 卡片形态不挂面板：交出一份内容已填好的 HTML，由模型原样交给 show_card 的 code。
      // 这样卡片形态就不依赖 Recipe——模板只认全局安装的配方，App 装不来；
      // 而 file 源拿不到 state，路径也不在允许根内。code 源两条都不占。
      if (form === FORM_CARD) {
        return {
          content: [
            {
              type: "text",
              text: renderCardHtml({
                uiLanguage: typeof uiLanguage === "string" ? uiLanguage : "zh",
                title: typeof title === "string" ? title.trim() : "",
                question: text,
                options: list,
                multi: isMulti,
                allowCustom,
              }),
            },
          ],
          details: { form: FORM_CARD, options: list, multi: isMulti, allowCustom },
        };
      }

      const sessionPath = typeof context?.sessionPath === "string" ? context.sessionPath : "";
      if (!sessionPath) throw new Error("ask_choice 只能在会话里调用（这次调用没带 sessionPath）。");

      const panelTitle = (typeof title === "string" && title.trim() ? title.trim() : "需要你定一下").slice(0, 60);

      let sessionId = "";
      try {
        sessionId = await resolveSessionId(sdk, sessionPath);
      } catch (error) {
        throw new Error(errorText(error));
      }
      if (!sessionId) throw new Error("没能拿到这个会话的 id，面板挂不出去。");

      const panelId = newPanelId();
      try {
        await sdk.userInteraction.show({
          sessionId,
          id: panelId,
          title: panelTitle,
          message: text.slice(0, MAX_QUESTION_CHARS),
          contentFrame: {
            route: "/choice.html",
            data: {
              panelId,
              title: panelTitle,
              question: text,
              options: list,
              allowCustom,
              multi: isMulti,
            },
          },
          presentation: { height: 240, collapsedHeight: 44, expanded: true },
        });
      } catch (error) {
        throw new Error(`挂选项面板失败：${errorText(error)}`);
      }

      pending.set(panelId, {
        panelId,
        sessionPath,
        sessionId,
        callToken: typeof context?.callToken === "string" ? context.callToken : "",
        question: text,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `选项弹窗已经挂在输入框上方（问题：${text}）。` +
              "用户点选后，答案会作为一条新消息发回来，你收到之后再接着做，不要在这一轮里重复调用。",
          },
        ],
        details: { panelId, options: list, multi: isMulti, allowCustom },
      };
    },
    });
  }

  await registerAskTool();
  await sdk.logger.info("ask-choice ready");
});
