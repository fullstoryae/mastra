---
'@mastra/core': minor
---

Added `subagentToolInputs` to `AgentController` so you can choose which optional inputs the built-in `subagent` tool offers the model. Set `modelId` or `forked` to `false` to leave that input out of the tool, so the model cannot pick a different model or fork the conversation. Each subagent's own `defaultModelId` and `forked` settings still apply. When it is not set, the tool offers both inputs as before.

```ts
const controller = new AgentController({
  // ...
  subagents: [researcher],
  subagentToolInputs: { modelId: false, forked: false },
});
```
