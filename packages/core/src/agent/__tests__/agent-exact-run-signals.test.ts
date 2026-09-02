import { describe, expect, it, vi } from 'vitest';

import { EventEmitterPubSub } from '../../events/event-emitter';
import type { Agent } from '../agent';
import { AgentThreadStreamRuntime } from '../thread-stream-runtime';
import { ExactRunSignalError } from '../types';

function createActiveOutput(runId: string) {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });
  return {
    output: {
      runId,
      status: 'running',
      fullStream: undefined,
      _waitUntilFinished: () => finished,
    } as any,
    finish,
  };
}

async function nextTick() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('exact-run signals', () => {
  it('delivers to the exact local run and accepts a repeated signal id only once', async () => {
    const pubsub = new EventEmitterPubSub();
    const runtime = new AgentThreadStreamRuntime();
    const agent = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;
    const { output, finish } = createActiveOutput('run-1');

    await runtime.registerRun(
      agent,
      output,
      { runId: 'run-1', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );

    await expect(
      runtime.sendSignalToRun(
        agent,
        { id: 'signal-1', content: 'steer once', expectedRunId: 'run-1' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).resolves.toEqual({ accepted: true, runId: 'run-1', signalId: 'signal-1' });
    await runtime.sendSignalToRun(
      agent,
      { id: 'signal-1', content: 'steer once', expectedRunId: 'run-1' },
      { resourceId: 'owner', threadId: 'thread' },
      pubsub,
    );

    expect(runtime.drainPendingSignals('run-1', pubsub)).toMatchObject([
      { id: 'signal-1', contents: 'steer once', type: 'user' },
    ]);
    finish();
  });

  it('acknowledges delivery from the runtime that owns the run', async () => {
    const pubsub = new EventEmitterPubSub();
    const ownerRuntime = new AgentThreadStreamRuntime();
    const senderRuntime = new AgentThreadStreamRuntime();
    const owner = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;
    const sender = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;
    const ownerSubscription = await ownerRuntime.subscribeToThread(
      owner,
      { resourceId: 'owner', threadId: 'thread' },
      pubsub,
    );
    const senderSubscription = await senderRuntime.subscribeToThread(
      sender,
      { resourceId: 'owner', threadId: 'thread' },
      pubsub,
    );
    const { output, finish } = createActiveOutput('run-remote');

    await ownerRuntime.registerRun(
      owner,
      output,
      { runId: 'run-remote', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    await nextTick();

    await expect(
      senderRuntime.sendSignalToRun(
        sender,
        { id: 'remote-signal', content: 'remote steer', expectedRunId: 'run-remote' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).resolves.toEqual({ accepted: true, runId: 'run-remote', signalId: 'remote-signal' });
    expect(ownerRuntime.drainPendingSignals('run-remote', pubsub)).toMatchObject([
      { id: 'remote-signal', contents: 'remote steer' },
    ]);
    expect(senderRuntime.drainPendingSignals('run-remote', pubsub)).toEqual([]);

    finish();
    ownerSubscription.unsubscribe();
    senderSubscription.unsubscribe();
  });

  it('rejects idle and mismatched targets without starting another run', async () => {
    const pubsub = new EventEmitterPubSub();
    const runtime = new AgentThreadStreamRuntime();
    const agent = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;

    await expect(
      runtime.sendSignalToRun(
        agent,
        { id: 'idle-signal', content: 'do not wake', expectedRunId: 'missing-run' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).rejects.toMatchObject<Partial<ExactRunSignalError>>({ code: 'no-active-run' });

    const { output, finish } = createActiveOutput('actual-run');
    await runtime.registerRun(
      agent,
      output,
      { runId: 'actual-run', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    await expect(
      runtime.sendSignalToRun(
        agent,
        { id: 'wrong-signal', content: 'do not retarget', expectedRunId: 'expected-run' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).rejects.toMatchObject<Partial<ExactRunSignalError>>({ code: 'run-mismatch', actualRunId: 'actual-run' });
    expect(agent.stream).not.toHaveBeenCalled();
    finish();
  });

  it('does not start a replacement run when the target finishes before draining', async () => {
    const pubsub = new EventEmitterPubSub();
    const runtime = new AgentThreadStreamRuntime();
    const agent = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;
    const { output, finish } = createActiveOutput('terminal-run');
    await runtime.registerRun(
      agent,
      output,
      { runId: 'terminal-run', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    await runtime.sendSignalToRun(
      agent,
      { id: 'terminal-signal', content: 'must stay in this run', expectedRunId: 'terminal-run' },
      { resourceId: 'owner', threadId: 'thread' },
      pubsub,
    );

    finish();
    await nextTick();
    await nextTick();

    expect(agent.stream).not.toHaveBeenCalled();
    expect(runtime.getThreadState({ resourceId: 'owner', threadId: 'thread' }, pubsub)).toBe('idle');
    expect(runtime.drainPendingSignals('terminal-run', pubsub)).toEqual([]);
  });
});
