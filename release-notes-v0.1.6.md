v0.1.6

修复
- 注入的调用规则不再在每个工具返回后重复一遍。v0.1.5 把注入放在 agent/pre-step，
  而它注入的消息是 request-only、不落盘，下一次 pre-step 拿到的历史里没有上一轮的痕迹，
  按 customType 去重永远不命中，结果每个工具返回后都再注入一次；宿主又把 custom 转成
  user 交给模型，模型当成新指令，会回一句「记住了」。现在改走 agent/before-start 的
  message 字段：每个会话只注入一条，落盘后留在历史里，后面每一轮、每一步都看得到。
- 系统提示保持原样，缓存契约不再被判前缀漂移（v0.1.5 已经修好，这次继续不碰 systemPrompt）。

加固
- 长会话压缩之后规则会销声匿迹：压缩把落盘的规则折进摘要，而内存里「已注入」的记号还在，
  该会话后面再也不补。现在观察 session/compacted，压缩完成后清掉记号，下一轮自动补一条。
- 切换提问形态后新旧两条规则会同时留在历史里、互相矛盾：规则末尾加一句「若会话里出现多条
  本条规则，以最后一条为准」；闩锁键也带上了形态，新形态的规则一定补得进去。

注意
- 授权词从 app/hooks.agent-pre-step 换成了 app/hooks.agent-before-start，并新增
  app/hooks.observe，升级后需要在「设置 → 应用 → 应用能力」里确认一次。
  observe 不打开不影响别的功能，只是压缩之后规则不会自动补回来。
- 为什么不用 session.beforeCompact 做这件事：那个决策词宿主自己已经有一个裁决者
  （compaction-guard），多个裁决者要求彼此 order 两两不同，而 App 侧 onDecision 没有
  order 参数，注册会被拒、整个 App 跟着 failed。观察事件不参与裁决，没有这个冲突。
