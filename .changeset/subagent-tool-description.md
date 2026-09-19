---
'@mastra/core': minor
---

Added `subagentToolDescription` to `AgentController` so you can write the description of the built-in `subagent` tool yourself. It receives the registered subagents, so you can list them in your own words. When it is not set, the tool keeps its default description.

```ts
const controller = new AgentController({
  // ...
  subagents: [researcher],
  subagentToolDescription: subagents =>
    [
      'Hand work to a specialist.',
      ...subagents.map(subagent => `- ${subagent.id} (${subagent.name}): ${subagent.description}`),
    ].join('\n'),
});
```
