---
'@mastra/core': minor
---

Added `providerOptions` to `AgentController` subagent definitions. They are passed to the subagent's model calls, so a subagent can run with its own settings, such as a reasoning effort.

```ts
const researcher = {
  id: 'research',
  name: 'Research',
  description: 'Researches a topic.',
  instructions: 'You research topics.',
  providerOptions: { openai: { reasoningEffort: 'high' } },
};
```
