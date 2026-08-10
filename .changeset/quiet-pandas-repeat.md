---
'@mastra/memory': minor
---

Added `instructionMode` and `continuationHints` to observational memory configuration.

`instruction` was append-only, so a domain whose extraction needs differ from the built-in
guidance could only argue with it from the end of the prompt. `instructionMode: 'replace'`
substitutes that guidance instead, while observational memory keeps the persona, output
format, and guidelines so the parsing contract is unchanged. The Reflector now also receives
the extraction guidance the Observer is actually running under.

`continuationHints` controls whether the `<current-task>` and `<suggested-response>` sections
are produced. Disable both, or either individually, when the agent drives its own control flow
and should not be steered by memory. Prompts now describe only the sections they define.

```ts
import { Memory } from '@mastra/memory';

const memory = new Memory({
  options: {
    observationalMemory: {
      observation: {
        instruction: 'Track entity IDs and the lifecycle state of every tool result.',
        instructionMode: 'replace',
        continuationHints: { suggestedResponse: false },
      },
      reflection: {
        continuationHints: false,
      },
    },
  },
});
```

Both options default to current behaviour.
