// ask-choice v2 App — 把「需要用户拿主意」变成输入框上方的一次点选
//
// Agent 调 ask_choice → 工具 execute 里用 sdk.userInteraction.ask 把一个自定义页面挂在
// 输入框上方（挂载位 slot: "input-panel"），用户确认后答案作为工具结果回到模型手里。
//
// 需要 app/input.panels 能力：等于用户允许本 App 往输入框上方渲染自己的界面。
// 宿主始终在 iframe 外面放确认 / 拒绝，页面不能替用户点头。
import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "ask-choice";

const MAX_OPTIONS = 8;
const MAX_QUESTION_CHARS = 2000;
// 宿主上限就是 10 分钟，这里按上限要
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

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

export default defineApp(async (sdk) => {
  await sdk.logger.info("ask-choice loaded");

  await sdk.tools.register({
    name: "ask_choice",
    description:
      "需要用户在几个方案之间拍板时用它：把选项列在用户输入框上方，等用户点完再把答案拿回来继续。" +
      "适合「用哪个方案」「要哪种风格」这类必须由人来定、且选项能穷举的问题。" +
      "不要用它问开放式的长回答问题，那种直接问就行。",
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
        title: { type: "string", description: "面板标题，省略时用「请选择」。" },
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

      let answer;
      try {
        answer = await sdk.userInteraction.ask({
          sessionPath,
          title: (typeof title === "string" && title.trim() ? title.trim() : "请选择").slice(0, 60),
          message: text.slice(0, MAX_QUESTION_CHARS),
          requestedSchema: {
            type: "object",
            properties: {
              choice: {
                type: "string",
                description: isMulti
                  ? "用户选中的项，多个用「、」连接；自定义答案就是原文"
                  : "用户选中的项，或自定义答案原文",
              },
            },
            required: ["choice"],
          },
          contentFrame: {
            route: "/choice.html",
            data: { question: text, options: list, allowCustom, multi: isMulti },
          },
          presentation: { height: null, collapsedHeight: 44, expanded: true },
          timeoutMs: ASK_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(`弹选项失败：${String(error?.message || error)}`);
      }

      if (answer?.action !== "confirmed") {
        const reason =
          answer?.action === "rejected"
            ? "用户放弃了这次选择"
            : answer?.action === "timeout"
              ? "等用户选择超时了（10 分钟）"
              : "面板被关掉了";
        return {
          content: [{ type: "text", text: `${reason}，没有拿到选择结果。可以问他要不要换个方式定，或直接给个默认方案。` }],
          details: { action: answer?.action ?? "unknown", choice: null },
        };
      }

      const choice = typeof answer?.value?.choice === "string" ? answer.value.choice.trim() : "";
      if (!choice) {
        return {
          content: [{ type: "text", text: "用户点了确认，但没给出具体选项。" }],
          details: { action: "confirmed", choice: null },
        };
      }

      return {
        content: [{ type: "text", text: `用户的选择：${choice}` }],
        details: { action: "confirmed", choice, multi: isMulti },
      };
    },
  });

  await sdk.logger.info("ask-choice ready");
});
