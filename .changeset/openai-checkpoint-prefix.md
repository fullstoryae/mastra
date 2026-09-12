---
'@mastra/core': patch
---

Fixed OpenAI prompt cache reuse after history compaction by preserving assistant-first prompts without synthetic user padding. Other providers and callers without provider information retain their existing behavior.
