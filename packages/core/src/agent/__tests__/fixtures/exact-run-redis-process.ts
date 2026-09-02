import type { Agent } from '../../agent';
import { AgentThreadStreamRuntime } from '../../thread-stream-runtime';

const role = process.argv[2];
const redisUrl = process.env.AGENT_REDIS_URL;
const keyPrefix = process.env.MASTRA_EXACT_RUN_REDIS_PREFIX;
const redisStreamsModulePath = process.env.MASTRA_REDIS_STREAMS_MODULE_PATH;

if (!redisUrl || !keyPrefix || !redisStreamsModulePath || (role !== 'owner' && role !== 'sender')) {
  throw new Error(
    'The Redis exact-run fixture requires a role, AGENT_REDIS_URL, MASTRA_EXACT_RUN_REDIS_PREFIX, and MASTRA_REDIS_STREAMS_MODULE_PATH',
  );
}

const { RedisStreamsPubSub } = await import(redisStreamsModulePath);
const pubsub = new RedisStreamsPubSub({
  url: redisUrl,
  keyPrefix,
  blockMs: 50,
  reclaimIntervalMs: 0,
  streamIdleTtlMs: 60_000,
});
const runtime = new AgentThreadStreamRuntime();
let streamCalls = 0;
const agent = {
  id: 'redis-exact-run-agent',
  stream: () => {
    streamCalls += 1;
    throw new Error('Exact-run steering must not start a replacement run');
  },
} as unknown as Agent<any, any, any, any>;
const target = { resourceId: 'owner', threadId: 'thread' };

function writeMessage(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runOwner() {
  const subscription = await runtime.subscribeToThread(agent, target, pubsub);
  let finish!: () => void;
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });

  await runtime.registerRun(
    agent,
    {
      runId: 'redis-run',
      status: 'running',
      fullStream: undefined,
      _waitUntilFinished: () => finished,
    } as any,
    { runId: 'redis-run', memory: { resource: target.resourceId, thread: target.threadId } } as any,
    pubsub,
  );
  writeMessage({ type: 'ready' });

  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (!chunk.includes('drain')) continue;
    const signals = runtime.drainPendingSignals('redis-run', pubsub);
    finish();
    await new Promise(resolve => setTimeout(resolve, 50));
    writeMessage({
      type: 'result',
      signalIds: signals.map(signal => signal.id),
      contents: signals.map(signal => signal.contents),
      streamCalls,
    });
    subscription.unsubscribe();
    await pubsub.close();
    return;
  }
}

async function runSender() {
  const input = { id: 'redis-signal', content: 'steer across processes', expectedRunId: 'redis-run' };
  const first = await runtime.sendSignalToRun(agent, input, target, pubsub);
  const duplicate = await runtime.sendSignalToRun(agent, input, target, pubsub);
  writeMessage({ type: 'accepted', first, duplicate, streamCalls });
  await pubsub.close();
}

try {
  await (role === 'owner' ? runOwner() : runSender());
} catch (error) {
  writeMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  await pubsub.close().catch(() => {});
  process.exitCode = 1;
}
