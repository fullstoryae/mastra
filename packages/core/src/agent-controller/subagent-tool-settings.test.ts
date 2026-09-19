import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';

import { RequestContext } from '../request-context';
import { standardSchemaToJSONSchema } from '../schema';

import { createTestSession } from './test-utils';
import { createSubagentTool } from './tools';
import type { AgentControllerSubagent } from './types';

const subagents: AgentControllerSubagent[] = [
  { id: 'explore', name: 'Explore', description: 'Read-only codebase exploration.', instructions: 'Explore.' },
];

describe('AgentController subagentToolInputs', () => {
  it('offers only the subagent tool inputs that are not turned off', async () => {
    const { controller, session } = await createTestSession({
      subagents,
      subagentToolInputs: { modelId: false, forked: false },
    });

    const toolsets = await (controller as any).buildToolsets(session, new RequestContext());
    const inputSchema = standardSchemaToJSONSchema(toolsets.controllerBuiltIn.subagent.inputSchema, { io: 'input' });

    expect(Object.keys(inputSchema.properties as Record<string, unknown>)).toEqual(['agentType', 'task']);
  });
});

describe('AgentControllerSubagent providerOptions', () => {
  it("passes the subagent's providerOptions to its model calls", async () => {
    const modelCalls: Array<{ providerOptions?: unknown }> = [];
    const model = new MockLanguageModelV2({
      doStream: async options => {
        modelCalls.push(options);
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'id-0', modelId: 'mock', timestamp: new Date(0) },
            { type: 'text-start', id: 'text-0' },
            { type: 'text-delta', id: 'text-0', delta: 'Done.' },
            { type: 'text-end', id: 'text-0' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          ]),
        };
      },
    });

    const tool = createSubagentTool({
      subagents: [{ ...subagents[0]!, providerOptions: { openai: { reasoningEffort: 'high' } } }],
      resolveModel: () => model,
      fallbackModelId: 'mock',
    });

    const result = await (tool as any).execute(
      { agentType: 'explore', task: 'Look around' },
      { agent: { toolCallId: 'tc-provider-options' } },
    );

    expect(result).toEqual({ content: 'Done.', isError: false });
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });
});
