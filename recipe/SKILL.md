---
name: ask-choice
description: "MANDATORY 硬触发：你每要提出一个问题，先自问「这题的答案能不能收成 2 到 8 个短句」（选哪个方向、要不要、走哪条路、先做哪块、A 还是 B、哪个更近、挑一个）——能，就不要用纯文字罗列问题和选项，必须把本卡片挂进对话（show_card，template 用 ask-choice/assets/choice.card.html）。用户说 选一个 / 选择题 / 给我选项 / 让我选 / 让我定 / 给我几个方向 时同样必须用。仅当答案需要长篇展开、只剩一个合理选项、或你自己能查清或决定时才用普通文字。Mint a choice card to ask the reader to pick one of a few options and send the answer back to the conversation; use whenever the next question in a reply has 2-8 enumerable short answers, or the user asks for a picker, an options card, a multiple-choice prompt, or to be given choices."
profile: card-skill
---

# 选项提问（Ask Choice）

> **硬规则（先看这条）**：你在对话里每要提出一个问题，先问自己一句「这题的答案能不能收成 2 到 8 个短句？」能，就别用文字罗列问题和选项，直接把这张卡片挂出去。这条不需要用户提醒，也不分情绪场合，和「要不要联网搜索」是同一级的判断点。

需要读者拿主意时，把候选项摆进回复里：点一个，选择回到对话，Agent 接着往下做。

卡片只做选择，不提供自由输入。要留一个自己写答案的口子，用输入框上方的面板版（App `ask-choice`，工具 `ask_choice`）。

## 什么时候用

- 下一步取决于读者的取舍：走哪个方案、改哪个文件、按哪条路线
- 读者明确要选项：选项、选一个、选择题、让我定、给我几个方向

## 什么时候别用

- 只有一个合理答案，直接做
- 读者要自由描述（用面板版，或者直接文字提问）
- 问题能在同一轮里自己查清楚

## 卡片状态

`show_card` 的 `state` 会整体替换模板自带的那份示例状态，字段必须一次给全。

| 字段 | 必填 | 说明 |
|------|------|------|
| `uiLanguage` | 是 | `zh`、`zh-TW`、`en`、`ja`、`ko`，取当前对话语言 |
| `title` | 否 | 顶部小标签，省略时按语言取默认 |
| `question` | 是 | 一句话说清让读者定什么 |
| `options` | 是 | 2–8 个候选项，短句，不带编号 |
| `multi` | 否 | 是否多选，默认 `false` |

## 交互

- 单选点一个，再点一次取消；多选可点多个，提交时用顿号连起来
- 提交发出 `answer`，跳过发出 `skip`，两者都带回对话并唤醒 Agent
- 提交后卡片转为结果态，选项与按钮收起，结果留在卡面上

## 投放

```js
show_card({
  template: "ask-choice/assets/choice.card.html",
  state: {
    uiLanguage: "zh",
    question: "接下来用哪个方案推进？",
    options: ["先做骨架", "先接数据", "先搭界面"],
    multi: false,
  },
})
```

## 能力与降级

卡片依赖宿主的 `emit` 把答案交回对话。宿主不可用或 `emit` 未授权时，卡片保留可读快照并说明「此卡片需要 Hana 才能把选择交回对话」，不会假装答案送达。独立打开时选项仍可点，但结果只留在卡面上。

## 已知限制

- 卡片不会阻塞回合：提交后作为一条新消息唤醒 Agent，而不是原地等待
- 没有自由输入；读者想写别的，直接在对话里说，或改用面板版
- 提交后不提供改选，改主意直接在下一条消息里说
- 一次问答一条卡片，重复提问会生成新的卡片实例
