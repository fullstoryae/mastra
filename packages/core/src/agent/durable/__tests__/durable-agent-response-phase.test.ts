/**
 * DurableAgent response phase tests
 *
 * A provider can mark assistant text as intermediate commentary (OpenAI's
 * `phase`). A step that ends with commentary has not given its answer yet, so
 * the durable loop continues even when the step finishes with `stop`.
 */

import type { LanguageModelV2 } from '@ai-sdk/provider-v5';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitterPubSub } from '../../../events/event-emitter';
import { Agent } from '../../agent';
import { createDurableAgent } from '../create-durable-agent';

function createPhasedTextModel(steps: Array<{ text: string; phase: 'commentary' | 'final_answer' }>) {
  let callCount = 0;
  const model = new MockLanguageModelV2({
    doStream: async () => {
      const { text, phase } = steps[Math.min(callCount, steps.length - 1)]!;
      callCount += 1;
      const providerMetadata = { openai: { itemId: `msg-${callCount}`, phase } };

      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: `id-${callCount}`, modelId: 'mock-model-id', timestamp: new Date(0) },
          { type: 'text-start', id: `text-${callCount}`, providerMetadata },
          { type: 'text-delta', id: `text-${callCount}`, delta: text },
          { type: 'text-end', id: `text-${callCount}`, providerMetadata },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
  });

  return { model, getCallCount: () => callCount };
}

async function drain(stream: ReadableStream<any>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // Read the run to its end.
  }
}

describe('DurableAgent response phases', () => {
  let pubsub: EventEmitterPubSub;

  beforeEach(() => {
    pubsub = new EventEmitterPubSub();
  });

  afterEach(async () => {
    await pubsub.close();
  });

  it.each([
    { first: 'commentary', callCount: 2 },
    { first: 'final_answer', callCount: 1 },
  ] as const)('continues after a stop only when its text is commentary ($first)', async ({ first, callCount }) => {
    const { model, getCallCount } = createPhasedTextModel([
      { text: 'Checking the files.', phase: first },
      { text: 'Both files are signed.', phase: 'final_answer' },
    ]);
    const baseAgent = new Agent({
      id: 'response-phase-agent',
      name: 'Response Phase Agent',
      instructions: 'Answer the question.',
      model: model as LanguageModelV2,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent, pubsub });

    const result = await durableAgent.stream('Are the files signed?', { maxSteps: 5 });
    await drain(result.fullStream as ReadableStream<any>);

    expect(getCallCount()).toBe(callCount);
    result.cleanup();
  });
});
