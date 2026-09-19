---
'@mastra/core': patch
---

Fixed runs ending on intermediate OpenAI commentary. When a response marks its text as commentary, the agent loop and the durable agent loop now continue instead of treating it as the final answer, and AgentController keeps the provider's text metadata, including the response phase, on the messages it emits.
