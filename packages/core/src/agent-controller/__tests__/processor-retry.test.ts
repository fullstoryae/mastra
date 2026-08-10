import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { Agent } from '../../agent';
import { MockMemory } from '../../memory/mock';
import type { Processor, ProcessOutputStepArgs } from '../../processors';
import { InMemoryStore } from '../../storage/mock';
import { createTool } from '../../tools/tool';
import { AgentController } from '../agent-controller';
import { createMockWorkspace } from '../test-utils';
import type { AgentControllerEvent } from '../types';

function textResponse(id: string, text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'response-metadata' as const, id: `response-${id}`, modelId: 'mock-model', timestamp: new Date(0) },
      { type: 'text-start' as const, id },
      { type: 'text-delta' as const, id, delta: text },
      { type: 'text-end' as const, id },
      {
        type: 'finish' as const,
        finishReason: 'stop' as const,
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
    warnings: [],
  };
}

describe('AgentController processor retry', () => {
  it('keeps accepted tool work and removes the rejected response from the final display', async () => {
    const prompts: unknown[][] = [];
    let modelCalls = 0;
    const lookup = vi.fn(async ({ query }: { query: string }) => ({ answer: `catalog result for ${query}` }));
    const storage = new InMemoryStore();
    const memory = new MockMemory({ storage });

    const model = new MockLanguageModelV2({
      doStream: async ({ prompt }) => {
        prompts.push([...prompt]);
        modelCalls += 1;

        if (modelCalls === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'response-metadata', id: 'response-tool', modelId: 'mock-model', timestamp: new Date(0) },
              {
                type: 'tool-call',
                toolCallId: 'lookup-1',
                toolName: 'lookup',
                input: JSON.stringify({ query: 'Eltiera Views' }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
              },
            ]),
            rawCall: { rawPrompt: null, rawSettings: {} },
            warnings: [],
          };
        }

        if (modelCalls === 2) return textResponse('rejected', 'rejected answer');
        if (modelCalls === 3) return textResponse('accepted', 'accepted answer');
        return textResponse('next-turn', 'next answer');
      },
    });

    const completionGate = {
      id: 'test-completion-gate',
      processOutputStep: async ({ text, abort, retryCount, messages }: ProcessOutputStepArgs) => {
        if (retryCount === 0 && text?.includes('rejected answer')) {
          abort('Response contract rejected the step', { retry: true });
        }
        return messages;
      },
    } satisfies Processor;

    const agent = new Agent({
      id: 'processor-retry-agent',
      name: 'Processor Retry Agent',
      instructions: 'Use the available evidence and answer the user.',
      model,
      outputProcessors: [completionGate],
      maxProcessorRetries: 1,
    });

    const controller = new AgentController({
      id: 'processor-retry-controller',
      storage,
      memory,
      workspace: createMockWorkspace(),
      agent,
      modes: [{ id: 'default', name: 'Default', default: true, defaultModelId: 'mock-model' }],
      tools: {
        lookup: createTool({
          id: 'lookup',
          description: 'Looks up one project.',
          inputSchema: z.object({ query: z.string() }),
          outputSchema: z.object({ answer: z.string() }),
          execute: lookup,
        }),
      },
      initialState: { yolo: true } as any,
    });

    await controller.init();
    const session = await controller.createSession({ id: 'test-session', ownerId: 'test-owner' });
    await controller.getMastra()?.startWorkers();
    await session.thread.create();

    const events: AgentControllerEvent[] = [];
    session.subscribe(event => events.push(event));
    const sendMessage = vi.spyOn(session, 'sendMessage');

    await session.sendMessage({ content: 'Look up the project and answer.' });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'agent_start')).toHaveLength(1);
    expect(
      events.filter(event => event.type === 'step_rejected'),
      events.map(event => event.type).join(','),
    ).toHaveLength(1);
    expect(modelCalls).toBe(3);
    expect(
      events.filter(event => event.type === 'tool_end'),
      JSON.stringify(events.filter(event => event.type === 'tool_end')),
    ).toContainEqual(expect.objectContaining({ type: 'tool_end', toolCallId: 'lookup-1', isError: false }));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(session.getTokenUsage().totalTokens).toBe(30);

    const messageEnd = [...events]
      .reverse()
      .find(
        (event): event is Extract<AgentControllerEvent, { type: 'message_end' }> =>
          event.type === 'message_end' && event.message.role === 'assistant',
      );
    const finalDisplay = JSON.stringify(messageEnd?.message.content);
    expect(finalDisplay).toContain('catalog result for Eltiera Views');
    expect(finalDisplay).toContain('accepted answer');
    expect(finalDisplay).not.toContain('rejected answer');
    expect(finalDisplay).not.toContain('Response contract rejected the step');

    let storedAfterFirstTurn = '';
    await vi.waitFor(async () => {
      storedAfterFirstTurn = JSON.stringify(await session.thread.listActiveMessages());
      expect(storedAfterFirstTurn).toContain('accepted answer');
    });
    expect(storedAfterFirstTurn).toContain('catalog result for Eltiera Views');
    expect(storedAfterFirstTurn).not.toContain('rejected answer');
    expect(storedAfterFirstTurn).not.toContain('Response contract rejected the step');

    await session.sendMessage({ content: 'Continue.' });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(modelCalls).toBe(4);
    const nextTurnPrompt = JSON.stringify(prompts[3]);
    expect(nextTurnPrompt).toContain('accepted answer');
    expect(nextTurnPrompt).toContain('catalog result for Eltiera Views');
    expect(nextTurnPrompt).not.toContain('rejected answer');
    expect(nextTurnPrompt).not.toContain('Response contract rejected the step');
  }, 30_000);

  it('keeps accepted tool results through consecutive retries', async () => {
    const prompts: unknown[][] = [];
    let modelCalls = 0;
    const lookup = vi.fn(async ({ query }: { query: string }) => ({ answer: `catalog result for ${query}` }));

    const model = new MockLanguageModelV2({
      doStream: async ({ prompt }) => {
        prompts.push([...prompt]);
        modelCalls += 1;

        if (modelCalls === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'response-metadata', id: 'response-tool', modelId: 'mock-model', timestamp: new Date(0) },
              {
                type: 'tool-call',
                toolCallId: 'lookup-1',
                toolName: 'lookup',
                input: JSON.stringify({ query: 'Eltiera Views' }),
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
              },
            ]),
            rawCall: { rawPrompt: null, rawSettings: {} },
            warnings: [],
          };
        }

        if (modelCalls === 2) return textResponse('rejected-one', 'first rejected answer');
        if (modelCalls === 3) return textResponse('rejected-two', 'second rejected answer');
        return textResponse('accepted', 'accepted answer');
      },
    });

    const completionGate = {
      id: 'test-completion-gate',
      processOutputStep: async ({ text, abort, retryCount, messages }: ProcessOutputStepArgs) => {
        if (retryCount < 2 && text?.includes('rejected answer')) {
          abort('Response contract rejected the step', { retry: true });
        }
        return messages;
      },
    } satisfies Processor;

    const agent = new Agent({
      id: 'processor-retry-tool-agent',
      name: 'Processor Retry Tool Agent',
      instructions: 'Use the available evidence and answer the user.',
      model,
      tools: {
        lookup: createTool({
          id: 'lookup',
          description: 'Looks up one project.',
          inputSchema: z.object({ query: z.string() }),
          outputSchema: z.object({ answer: z.string() }),
          execute: lookup,
        }),
      },
      outputProcessors: [completionGate],
      maxProcessorRetries: 2,
    });

    const stream = await agent.stream('Look up the project and answer.', { maxSteps: 5 });
    for await (const _ of stream.fullStream) {
    }
    const result = await stream.getFullOutput();

    expect(modelCalls).toBe(4);
    expect(lookup).toHaveBeenCalledTimes(1);

    const rejectedAttemptPrompt = JSON.stringify(prompts[1]);
    expect(rejectedAttemptPrompt).toContain('catalog result for Eltiera Views');

    const firstRetryPrompt = JSON.stringify(prompts[2]);
    expect(firstRetryPrompt).toContain('catalog result for Eltiera Views');
    expect(firstRetryPrompt).toContain('Response contract rejected the step');
    expect(firstRetryPrompt).not.toContain('first rejected answer');

    const secondRetryPrompt = JSON.stringify(prompts[3]);
    expect(secondRetryPrompt).toContain('catalog result for Eltiera Views');
    expect(secondRetryPrompt).toContain('Response contract rejected the step');
    expect(secondRetryPrompt).not.toContain('first rejected answer');
    expect(secondRetryPrompt).not.toContain('second rejected answer');

    expect(result.text).toBe('accepted answer');
    expect(JSON.stringify(result.steps)).not.toContain('rejected answer');
    expect(result.usage.totalTokens).toBe(40);
  }, 30_000);
});
