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

  /**
   * 收起一个会话下还挂着的面板。
   * 用户在会话里发了新消息，这次提问就算过去了，面板不该继续占着输入框上方。
   */
  async function dismissPanels(sessionId) {
    for (const [id, record] of [...pending]) {
      if (sessionId && record.sessionId !== sessionId) continue;
      pending.delete(id);
      try {
        await sdk.userInteraction.dismiss({ sessionId: record.sessionId, id: record.panelId });
      } catch (error) {
        await sdk.logger.warn(`ask-choice: 收面板失败 ${errorText(error)}`);
      }
    }
  }

  // 用户一提交输入（也就是开启新一轮），先把还敞开的面板收掉。
  // 只做副作用，返回 undefined：完全不碰用户输入的内容。
  await sdk.hooks.onDecision("session/input", async (invocation) => {
    const sessionId = typeof invocation?.sessionId === "string" ? invocation.sessionId : "";
    await dismissPanels(sessionId);
    return undefined;
  });

  await sdk.routes.register((app) => {
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

  await sdk.tools.register({
    name: "ask_choice",
    description:
      "需要用户在几个方案之间拍板时用它：把选项挂到用户输入框上方，用户点选后答案会作为一条新消息回到对话里。" +
      "适合「用哪个方案」「要哪种风格」这类必须由人来定、且选项能穷举的问题。" +
      "调用后立刻返回「面板已挂出」的回执，用户点完你才会收到新消息，因此同一轮里不要重复调用。" +
      "不要用它问需要长篇回答的开放问题，那种直接问就行。",
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
              `选项面板已经挂在输入框上方（问题：${text}）。` +
              "用户点选后，答案会作为一条新消息发回来，你收到之后再接着做，不要在这一轮里重复调用。",
          },
        ],
        details: { panelId, options: list, multi: isMulti, allowCustom },
      };
    },
  });

  await sdk.logger.info("ask-choice ready");
});
