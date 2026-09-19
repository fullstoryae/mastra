import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider-v6';
import { describe, expect, it, vi } from 'vitest';
import { AISDKV6LanguageModel } from './model';

function createMockV3Model() {
  return {
    specificationVersion: 'v3',
    provider: 'openai',
    modelId: 'test-v3-model',
    supportedUrls: {},
    doGenerate: vi.fn(async () => ({
      content: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    })),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream(),
    })),
  } as unknown as LanguageModelV3;
}

// ModelRouter hands the adapter a V2 prompt, where tool results carry media as `media` parts.
function createToolResultMediaPrompt() {
  return [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read_file',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'Two files' },
              { type: 'media', data: 'aW1hZ2U=', mediaType: 'image/png' },
              { type: 'media', data: 'cGRm', mediaType: 'application/pdf' },
            ],
          },
        },
      ],
    },
  ] as unknown as LanguageModelV3CallOptions['prompt'];
}

describe('AISDKV6LanguageModel', () => {
  describe('serializeForSpan', () => {
    it('returns only identity fields', () => {
      const wrapped = new AISDKV6LanguageModel(createMockV3Model());

      expect(wrapped.serializeForSpan()).toEqual({
        specificationVersion: 'v3',
        modelId: 'test-v3-model',
        provider: 'openai',
      });
    });

    it('does not expose the wrapped provider SDK client', () => {
      const wrapped = new AISDKV6LanguageModel(createMockV3Model());

      const serialized = JSON.stringify(wrapped.serializeForSpan());

      expect(serialized).not.toContain('supportedUrls');
      expect(serialized).not.toContain('doGenerate');
      expect(serialized).not.toContain('doStream');
    });
  });

  describe('tool result media', () => {
    it.each(['doStream', 'doGenerate'] as const)(
      'converts V2 media parts to the V3 content shape for %s',
      async method => {
        const model = createMockV3Model();
        const wrapped = new AISDKV6LanguageModel(model);

        await wrapped[method]({ prompt: createToolResultMediaPrompt() });

        const passed = (model[method] as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(passed.prompt[0].content[0].output.value).toEqual([
          { type: 'text', text: 'Two files' },
          { type: 'image-data', data: 'aW1hZ2U=', mediaType: 'image/png' },
          { type: 'file-data', data: 'cGRm', mediaType: 'application/pdf' },
        ]);
      },
    );
  });
});
