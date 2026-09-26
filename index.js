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

/** 面板形态下工具本身的描述 */
const PANEL_DESCRIPTION =
  "只要答案能列成 2–8 个短语，就默认用它，而不是写一行文字去问：既要用于必须由用户拍板的岔路（用哪个方案、改哪个文件、按哪条路线），" +
  "也用于顺带收的偏好（这趟想带上什么、先动哪块、要不要一起处理）。把选项挂到用户输入框上方，用户点选后答案会作为一条新消息回到对话里。" +
  "只有这几种情况才用普通回复：答案需要展开解释或写成一句话以上的长文；答案只有一个合理选项；你自己能查到或能直接决定的事。" +
  "调用后立刻返回「面板已挂出」的回执，用户点完你才会收到新消息，因此同一轮里不要重复调用。";

/** 卡片形态下工具本身的描述：引导改走 show_card */
const CARD_DESCRIPTION =
  "用户把提问形态设成了「卡片」：需要用户拿主意时不要调用本工具，改用 show_card 把卡片挂进对话——" +
  "show_card({ template: \"ask-choice/assets/choice.card.html\", state: { uiLanguage, title, question, options, multi, allowCustom } })，" +
  "用户点选后选择会作为一条新消息回到对话里。判断标准不变：答案能列成 2–8 个短语才问，需要长篇展开的用文字问。";

function describeFor(form) {
  return form === FORM_CARD ? CARD_DESCRIPTION : PANEL_DESCRIPTION;
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

  /** 读当前形态设置；读不到就当面板。 */
  async function currentForm() {
    try {
      const value = await sdk.config.get("form");
      return value === FORM_CARD ? FORM_CARD : FORM_PANEL;
    } catch (error) {
      await sdk.logger.warn(`ask-choice: 读设置失败 ${errorText(error)}`);
      return FORM_PANEL;
    }
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
        await sdk.config.set("form", value);
      } catch (error) {
        return c.json({ ok: false, message: `保存失败：${errorText(error)}` }, 500);
      }
      // 设置存下之后立刻重注册工具，让新的形态当场生效
      try {
        await registerAskTool();
      } catch (error) {
        return c.json({ ok: false, message: `已保存，但重新注册工具失败：${errorText(error)}` }, 500);
      }
      return c.json({ ok: true, form: value });
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
    if (askTool) {
      try {
        await askTool.disposeAsync();
      } catch (error) {
        await sdk.logger.warn(`ask-choice: 注销旧工具失败 ${errorText(error)}`);
      }
      askTool = null;
    }
    askTool = await sdk.tools.register({
    name: "ask_choice",
    description: describeFor(await currentForm()),
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
      },
      required: ["question", "options"],
    },
    execute: async ({ question, options, allow_custom, multi, title, context } = {}) => {
      const sessionPath = typeof context?.sessionPath === "string" ? context.sessionPath : "";
      if (!sessionPath) throw new Error("ask_choice 只能在会话里调用（这次调用没带 sessionPath）。");

      const text = typeof question === "string" ? question.trim() : "";
      if (!text) throw new Error("ask_choice 需要 question。");
      const list = normalizeOptions(options);
      if (list.length < 2) throw new Error("ask_choice 至少需要 2 个不同的候选项。");

      const allowCustom = allow_custom !== false;
      const isMulti = multi === true;
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
