import { describe, expect, it, vi } from 'vitest';
import type { MastraDBMessage } from '../../agent/message-list/state/types';
import { RequestContext } from '../../request-context';
import { Workspace } from '../../workspace';
import { LocalFilesystem } from '../../workspace/filesystem/local-filesystem';
import type { SessionMachinery } from '../session';
import { Session } from '../session';
import { SessionRunEngine } from '../session-run-engine';
import type { AgentControllerEvent } from '../types';

/**
 * BDD spec for the DB-native message contract of the run engine.
 *
 * Given a streamed run, the engine must build and emit `MastraDBMessage`s:
 * `content.format === 2` with nested `content.parts` accumulating
 * `text` / `reasoning` / `tool-invocation` parts in stream order — NOT the
 * legacy flat `AgentControllerMessageContent` union.
 */

type StreamChunk = Parameters<SessionRunEngine['processStreamChunk']>[1];

function createHarness() {
  const events: AgentControllerEvent[] = [];
  let idCounter = 0;

  const session = new Session({
    resourceId: 'resource-1',
    id: 'session-1',
    ownerId: 'owner-1',
    workspace: new Workspace({
      id: 'workspace-1',
      filesystem: new LocalFilesystem({ basePath: '/tmp' }),
    }),
  });
  session.thread.set({ threadId: 'thread-1' });
  session.subscribe(event => {
    events.push(event);
  });

  const machinery: SessionMachinery = {
    getAgent: () => {
      throw new Error('getAgent is not used by these stream-folding tests');
    },
    subscribeToThread: async () => {
      throw new Error('subscribeToThread is not used by these stream-folding tests');
    },
    buildStreamOptions: async () => ({}),
    buildSharedRunOptions: () => ({}),
    buildToolsets: async () => ({}),
    buildRequestContext: async requestContext => requestContext ?? new RequestContext(),
    persistTokenUsage: vi.fn(async () => {}),
    generateId: () => `msg-${++idCounter}`,
    resolveTransitionModeId: () => undefined,
    saveSystemReminder: vi.fn(async () => null),
  };

  const engine = new SessionRunEngine(session, machinery);
  return { engine, events, session };
}

function isMastraDBMessage(value: unknown): value is MastraDBMessage {
  return typeof value === 'object' && value !== null && 'content' in value && 'role' in value;
}

function lastMessageEvent(events: AgentControllerEvent[]): MastraDBMessage {
  for (const event of [...events].reverse()) {
    if ('message' in event && isMastraDBMessage(event.message)) {
      return event.message;
    }
  }
  throw new Error('no message event emitted');
}

function requestContext(): RequestContext {
  return new RequestContext();
}

function chunk(value: StreamChunk): StreamChunk {
  return value;
}

describe('SessionRunEngine — MastraDBMessage contract', () => {
  it('Given a text stream, When chunks arrive, Then it emits a MastraDBMessage with a text part', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), ctx);
    await engine.processStreamChunk(state, chunk({ type: 'text-delta', payload: { id: 't1', text: 'Hello' } }), ctx);
    await engine.processStreamChunk(state, chunk({ type: 'text-delta', payload: { id: 't1', text: ' world' } }), ctx);

    const message = lastMessageEvent(events);
    expect(message.content.format).toBe(2);
    expect(message.content.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(message.role).toBe('assistant');
  });

  it('Given text with provider metadata, When it starts and ends, Then the text part keeps the metadata', async () => {
    const { engine } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-start', payload: { id: 't1', providerMetadata: { openai: { itemId: 'msg_1' } } } }),
      ctx,
    );
    await engine.processStreamChunk(state, chunk({ type: 'text-delta', payload: { id: 't1', text: 'Done.' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'text-end',
        payload: { id: 't1', providerMetadata: { openai: { itemId: 'msg_1', phase: 'final_answer' } } },
      }),
      ctx,
    );

    // The provider's response phase reaches the message the run ends with.
    expect(state.currentMessage.content.parts).toEqual([
      { type: 'text', text: 'Done.', providerMetadata: { openai: { itemId: 'msg_1', phase: 'final_answer' } } },
    ]);
  });

  it('Given a reasoning stream, When chunks arrive, Then it emits a reasoning part', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(state, chunk({ type: 'reasoning-start', payload: { id: 'r1' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'reasoning-delta', payload: { id: 'r1', text: 'thinking…' } }),
      ctx,
    );

    const message = lastMessageEvent(events);
    const reasoningPart = message.content.parts.find(part => part.type === 'reasoning');
    expect(reasoningPart).toMatchObject({ type: 'reasoning', reasoning: 'thinking…' });
  });

  it('Given a tool call + result, When chunks arrive, Then it emits a tool-invocation part', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-call', payload: { toolCallId: 'tc1', toolName: 'read', args: { path: 'a.ts' } } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-result',
        payload: { toolCallId: 'tc1', toolName: 'read', result: 'ok', isError: true },
      }),
      ctx,
    );

    const message = lastMessageEvent(events);
    const toolPart = message.content.parts.find(part => part.type === 'tool-invocation');
    if (!toolPart || toolPart.type !== 'tool-invocation') throw new Error('no tool invocation part emitted');
    expect(toolPart.toolInvocation.toolCallId).toBe('tc1');
    expect(toolPart.toolInvocation.toolName).toBe('read');
    expect(toolPart.toolInvocation.state).toBe('result');
    expect(toolPart.toolInvocation.result).toBe('ok');
    expect((toolPart.toolInvocation as { isError?: boolean }).isError).toBe(true);
  });

  it('Given a signal data chunk, When it arrives, Then it emits a DB-native signal message', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();
    const payload = { signalId: 'sig-1', message: 'hello' };

    await engine.processStreamChunk(state, chunk({ type: 'data-signal', data: payload }), ctx);

    const message = lastMessageEvent(events);
    const [part] = message.content.parts;
    expect(message.role).toBe('signal');
    expect(message.content.format).toBe(2);
    expect(part).toEqual({ type: 'data-signal', data: payload });
    expect(message.content.metadata?.signal).toEqual(payload);
  });

  it('Given a user-message signal after assistant text, When it arrives, Then it ends the assistant and emits a separate signal message', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();
    const payload = { id: 'user-signal-1', message: 'next input', createdAt: '2026-01-02T03:04:05.000Z' };

    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't1', text: 'assistant text' } }),
      ctx,
    );
    await engine.processStreamChunk(state, chunk({ type: 'data-user-message', data: payload }), ctx);

    const messageEnds = events.filter(event => event.type === 'message_end');
    expect(messageEnds).toHaveLength(2);
    expect(messageEnds[0].message.role).toBe('assistant');
    expect(messageEnds[0].message.content).toMatchObject({
      format: 2,
      parts: [{ type: 'text', text: 'assistant text' }],
      metadata: { stopReason: 'complete' },
    });
    expect(messageEnds[1].message).toMatchObject({
      id: 'user-signal-1',
      role: 'signal',
      content: {
        format: 2,
        parts: [{ type: 'data-user-message', data: payload }],
        metadata: { signal: payload },
      },
    });
    expect(messageEnds[1].message.createdAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('Given an emitted snapshot, When later chunks mutate the message in place, Then the snapshot is unchanged', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), ctx);
    await engine.processStreamChunk(state, chunk({ type: 'text-delta', payload: { id: 't1', text: 'Hello' } }), ctx);
    const textSnapshot = lastMessageEvent(events);

    await engine.processStreamChunk(state, chunk({ type: 'text-delta', payload: { id: 't1', text: ' world' } }), ctx);
    expect(textSnapshot.content.parts).toEqual([{ type: 'text', text: 'Hello' }]);

    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-call', payload: { toolCallId: 'tc1', toolName: 'read', args: { path: 'a.ts' } } }),
      ctx,
    );
    const callSnapshot = lastMessageEvent(events);

    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-result', payload: { toolCallId: 'tc1', toolName: 'read', result: 'ok' } }),
      ctx,
    );

    const callPart = callSnapshot.content.parts.find(part => part.type === 'tool-invocation');
    if (!callPart || callPart.type !== 'tool-invocation') throw new Error('no tool invocation part in snapshot');
    expect(callPart.toolInvocation.state).toBe('call');
    expect(callPart.toolInvocation).not.toHaveProperty('result');
  });

  it('Given a non-success finish reason, When the stream finishes, Then terminal state lives on message metadata', async () => {
    const { engine, events } = createHarness();

    const result = await engine.processStream(
      {
        fullStream: (async function* () {
          yield chunk({ type: 'text-start', payload: { id: 't1' } });
          yield chunk({ type: 'text-delta', payload: { id: 't1', text: 'partial' } });
          yield chunk({ type: 'finish', payload: { stepResult: { reason: 'content-filter' } } });
        })(),
      },
      requestContext(),
    );

    expect(result?.message.content.format).toBe(2);
    expect(result?.message.content.parts).toEqual([{ type: 'text', text: 'partial' }]);
    expect(result?.message.content.metadata?.stopReason).toBe('error');
    expect(result?.message.content.metadata?.errorMessage).toEqual(expect.stringContaining('content filter'));
    const messageEnd = events.find(event => event.type === 'message_end');
    expect(messageEnd?.message.content.metadata?.stopReason).toBe('error');
    expect(events).toContainEqual({ type: 'agent_end', reason: 'error' });
  });

  it('Given a rejected model step, When the model retries, Then only accepted step content remains', async () => {
    const { engine, events, session } = createHarness();

    const result = await engine.processStream(
      {
        fullStream: (async function* () {
          yield chunk({ type: 'step-start', payload: {} });
          yield chunk({
            type: 'tool-call',
            payload: { toolCallId: 'accepted-tool', toolName: 'search', args: { query: 'accepted' } },
          });
          yield chunk({
            type: 'tool-result',
            payload: { toolCallId: 'accepted-tool', toolName: 'search', result: 'accepted result' },
          });
          yield chunk({
            type: 'step-finish',
            payload: { output: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } },
          });

          yield chunk({ type: 'step-start', payload: {} });
          yield chunk({ type: 'reasoning-start', payload: { id: 'rejected-reasoning' } });
          yield chunk({
            type: 'reasoning-delta',
            payload: { id: 'rejected-reasoning', text: 'rejected reasoning' },
          });
          yield chunk({ type: 'text-start', payload: { id: 'rejected-text' } });
          yield chunk({ type: 'text-delta', payload: { id: 'rejected-text', text: 'rejected answer' } });
          yield chunk({
            type: 'tool-call-input-streaming-start',
            payload: { toolCallId: 'rejected-tool', toolName: 'write' },
          });
          yield chunk({
            type: 'tool-call-delta',
            payload: { toolCallId: 'rejected-tool', toolName: 'write', argsTextDelta: '{"value":true}' },
          });
          yield chunk({
            type: 'tool-call',
            payload: { toolCallId: 'rejected-tool', toolName: 'write', args: { value: true } },
          });
          yield chunk({
            type: 'step-finish',
            payload: {
              output: { usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } },
              stepResult: { reason: 'retry' },
            },
          });

          yield chunk({ type: 'step-start', payload: {} });
          yield chunk({ type: 'text-start', payload: { id: 'accepted-text' } });
          yield chunk({ type: 'text-delta', payload: { id: 'accepted-text', text: 'accepted answer' } });
          yield chunk({
            type: 'step-finish',
            payload: { output: { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } },
          });
          yield chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } });
        })(),
      },
      requestContext(),
    );

    expect(result?.message.content.parts).toEqual([
      {
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolCallId: 'accepted-tool',
          toolName: 'search',
          args: { query: 'accepted' },
          result: 'accepted result',
          isError: false,
        },
      },
      { type: 'text', text: 'accepted answer' },
    ]);
    expect(JSON.stringify(result?.message.content)).not.toContain('rejected');
    expect(session.getTokenUsage()).toMatchObject({ promptTokens: 9, completionTokens: 6, totalTokens: 15 });
    expect(session.displayState.get().activeTools.get('accepted-tool')).toMatchObject({
      status: 'completed',
      result: 'accepted result',
    });
    expect(session.displayState.get().activeTools.has('rejected-tool')).toBe(false);
    expect(session.displayState.get().toolInputBuffers.has('rejected-tool')).toBe(false);

    const rejected = events.find(event => event.type === 'step_rejected');
    expect(rejected).toMatchObject({
      type: 'step_rejected',
      toolCallIds: ['rejected-tool'],
      message: {
        content: {
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: { state: 'result', toolCallId: 'accepted-tool', result: 'accepted result' },
            },
          ],
        },
      },
    });
  });

  it('Given a terminal tripwire, When the step is rejected, Then its provisional content is still rolled back', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(state, chunk({ type: 'step-start', payload: {} }), ctx);
    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't1', text: 'terminally rejected' } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'tripwire', payload: { reason: 'blocked', retry: false, processorId: 'validator' } }),
      ctx,
    );

    const rejected = events.find(
      (event): event is Extract<AgentControllerEvent, { type: 'step_rejected' }> => event.type === 'step_rejected',
    );
    expect(rejected?.message.content.parts).toEqual([]);
    expect(rejected?.toolCallIds).toEqual([]);
  });

  it('Given a tripwire before any step starts, Then it does not invent a rollback event', async () => {
    const { engine, events } = createHarness();

    await engine.processStreamChunk(
      engine.createStreamState(),
      chunk({ type: 'tripwire', payload: { reason: 'blocked', retry: false } }),
      requestContext(),
    );

    expect(events.some(event => event.type === 'step_rejected')).toBe(false);
  });

  it('Given an accepted step, When a later tripwire arrives before another step, Then accepted content remains', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const ctx = requestContext();

    await engine.processStreamChunk(state, chunk({ type: 'step-start', payload: {} }), ctx);
    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 'accepted' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 'accepted', text: 'accepted answer' } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'step-finish', payload: { stepResult: { reason: 'tool-calls' } } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'tripwire', payload: { reason: 'blocked before the next step', retry: false } }),
      ctx,
    );

    expect(events.some(event => event.type === 'step_rejected')).toBe(false);
    expect(state.currentMessage.content.parts).toEqual([{ type: 'text', text: 'accepted answer' }]);
  });

  it('Given a subscribed thread retry, Then the shared run engine publishes only the accepted step', async () => {
    const { engine, events, session } = createHarness();
    const subscription = {
      stream: (async function* () {
        yield chunk({ type: 'step-start', payload: {} });
        yield chunk({ type: 'text-start', payload: { id: 'rejected' } });
        yield chunk({ type: 'text-delta', payload: { id: 'rejected', text: 'rejected answer' } });
        yield chunk({ type: 'tripwire', payload: { reason: 'retry', retry: true } });
        yield chunk({ type: 'step-start', payload: {} });
        yield chunk({ type: 'text-start', payload: { id: 'accepted' } });
        yield chunk({ type: 'text-delta', payload: { id: 'accepted', text: 'accepted answer' } });
        yield chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } });
      })(),
      activeRunId: () => 'run-1',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });

    await engine.processSubscribedThreadStream(subscription);

    const messageEnd = events.find(
      (event): event is Extract<AgentControllerEvent, { type: 'message_end' }> => event.type === 'message_end',
    );
    expect(messageEnd?.message.content.parts).toEqual([{ type: 'text', text: 'accepted answer' }]);
    expect(JSON.stringify(messageEnd?.message.content)).not.toContain('rejected answer');
    expect(events).toContainEqual({ type: 'agent_end', reason: 'complete' });
  });
});
