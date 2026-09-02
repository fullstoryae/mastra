import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

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

function waitForMessage(child: ReturnType<typeof spawn>, expectedType: string) {
  const lines = createInterface({ input: child.stdout! });
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for Redis fixture ${expectedType}`)), 10_000);
    const onLine = (line: string) => {
      const message = JSON.parse(line) as Record<string, any>;
      if (message.type !== expectedType) return;
      clearTimeout(timeout);
      lines.off('line', onLine);
      resolve(message);
    };
    lines.on('line', onLine);
  });
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

  it.each([
    { name: 'has no lease owner', leaseOwner: undefined, code: 'no-active-run' },
    {
      name: 'cannot read the lease owner',
      leaseOwner: new Error('Redis unavailable'),
      code: 'coordination-unavailable',
    },
  ] as const)('fails closed when a locally registered run $name', async ({ leaseOwner, code }) => {
    const pubsub = new EventEmitterPubSub();
    const runtime = new AgentThreadStreamRuntime();
    const agent = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;
    const { output, finish } = createActiveOutput('local-run');
    await runtime.registerRun(
      agent,
      output,
      { runId: 'local-run', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    const ownerLookup = vi.spyOn(pubsub, 'getLeaseOwner');
    if (leaseOwner instanceof Error) ownerLookup.mockRejectedValueOnce(leaseOwner);
    else ownerLookup.mockResolvedValueOnce(leaseOwner);

    await expect(
      runtime.sendSignalToRun(
        agent,
        { id: 'signal-1', content: 'do not accept locally', expectedRunId: 'local-run' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).rejects.toMatchObject<Partial<ExactRunSignalError>>({ code });
    expect(runtime.drainPendingSignals('local-run', pubsub)).toEqual([]);
    finish();
  });

  it('rejects a local delivery that loses its lease after the owner lookup', async () => {
    const pubsub = new EventEmitterPubSub();
    const runtime = new AgentThreadStreamRuntime();
    const agent = { id: 'agent', stream: vi.fn() } as unknown as Agent<any, any, any, any>;
    const { output, finish } = createActiveOutput('local-run');
    await runtime.registerRun(
      agent,
      output,
      { runId: 'local-run', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    vi.spyOn(pubsub, 'renewLease').mockResolvedValueOnce(false);

    await expect(
      runtime.sendSignalToRun(
        agent,
        { id: 'signal-1', content: 'do not accept after lease loss', expectedRunId: 'local-run' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).rejects.toMatchObject<Partial<ExactRunSignalError>>({ code: 'not-steerable' });
    expect(runtime.drainPendingSignals('local-run', pubsub)).toEqual([]);
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

  it.each([
    { name: 'loses ownership', renewal: false, code: 'not-steerable' },
    { name: 'cannot reach coordination', renewal: new Error('Redis unavailable'), code: 'coordination-unavailable' },
  ] as const)('rejects remote delivery when the owner $name before enqueue', async ({ renewal, code }) => {
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
    const { output, finish } = createActiveOutput('remote-run');
    await ownerRuntime.registerRun(
      owner,
      output,
      { runId: 'remote-run', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    await nextTick();
    const renewLease = vi.spyOn(pubsub, 'renewLease');
    if (renewal instanceof Error) renewLease.mockRejectedValueOnce(renewal);
    else renewLease.mockResolvedValueOnce(renewal);

    await expect(
      senderRuntime.sendSignalToRun(
        sender,
        { id: 'remote-signal', content: 'do not accept remotely', expectedRunId: 'remote-run' },
        { resourceId: 'owner', threadId: 'thread' },
        pubsub,
      ),
    ).rejects.toMatchObject<Partial<ExactRunSignalError>>({ code });
    expect(ownerRuntime.drainPendingSignals('remote-run', pubsub)).toEqual([]);

    finish();
    ownerSubscription.unsubscribe();
    senderSubscription.unsubscribe();
  });

  it('uses independent replies for concurrent retries while deduplicating the signal', async () => {
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
    const { output, finish } = createActiveOutput('remote-run');
    await ownerRuntime.registerRun(
      owner,
      output,
      { runId: 'remote-run', memory: { resource: 'owner', thread: 'thread' } } as any,
      pubsub,
    );
    await nextTick();
    const subscribe = vi.spyOn(pubsub, 'subscribe');
    const clearTopic = vi.spyOn(pubsub, 'clearTopic');
    const input = { id: 'remote-signal', content: 'accept once', expectedRunId: 'remote-run' };

    const results = await Promise.all([
      senderRuntime.sendSignalToRun(sender, input, { resourceId: 'owner', threadId: 'thread' }, pubsub),
      senderRuntime.sendSignalToRun(sender, input, { resourceId: 'owner', threadId: 'thread' }, pubsub),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(ownerRuntime.drainPendingSignals('remote-run', pubsub)).toMatchObject([
      { id: 'remote-signal', contents: 'accept once' },
    ]);
    const replyTopics = subscribe.mock.calls
      .map(([topic]) => topic)
      .filter(topic => topic.includes('.exact-signal-reply.'));
    expect(new Set(replyTopics).size).toBe(2);
    expect(
      new Set(clearTopic.mock.calls.map(([topic]) => topic).filter(topic => topic.includes('.exact-signal-reply.'))),
    ).toEqual(new Set(replyTopics));

    finish();
    ownerSubscription.unsubscribe();
    senderSubscription.unsubscribe();
  });

  const redisIt = process.env.AGENT_REDIS_URL && process.env.MASTRA_REDIS_STREAMS_MODULE_PATH ? it : it.skip;

  redisIt(
    'acknowledges exact delivery across two Redis-backed processes',
    async () => {
      const fixture = new URL('./fixtures/exact-run-redis-process.ts', import.meta.url);
      const env = {
        ...process.env,
        MASTRA_EXACT_RUN_REDIS_PREFIX: `fullstory:test:exact-run:${randomUUID()}:`,
      };
      const spawnFixture = (role: 'owner' | 'sender') =>
        spawn(process.execPath, ['--import', 'tsx', fixture.pathname, role], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      const owner = spawnFixture('owner');
      const ownerExit = once(owner, 'exit');

      try {
        await waitForMessage(owner, 'ready');
        const sender = spawnFixture('sender');
        const senderExit = once(sender, 'exit');
        const accepted = await waitForMessage(sender, 'accepted');
        const [senderExitCode] = await senderExit;
        expect(senderExitCode).toBe(0);
        expect(accepted.first).toMatchObject({ accepted: true, runId: 'redis-run', signalId: 'redis-signal' });
        expect(accepted.duplicate).toEqual(accepted.first);
        expect(accepted.streamCalls).toBe(0);

        owner.stdin!.write('drain\n');
        const result = await waitForMessage(owner, 'result');
        const [ownerExitCode] = await ownerExit;
        expect(ownerExitCode).toBe(0);
        expect(result).toMatchObject({
          signalIds: ['redis-signal'],
          contents: ['steer across processes'],
          streamCalls: 0,
        });
      } finally {
        owner.kill();
      }
    },
    20_000,
  );

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
