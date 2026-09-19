---
'@mastra/core': patch
---

Fixed images and files returned by tools being dropped when a model router resolves an AI SDK v6 provider. Tool-result media is now converted to the shape these providers expect before the request is sent.
