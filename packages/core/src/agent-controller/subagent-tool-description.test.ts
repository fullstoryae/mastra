import { describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../request-context';

import { createTestSession } from './test-utils';
import { createSubagentTool } from './tools';
import type { AgentControllerConfig, AgentControllerSubagent } from './types';

const subagents: AgentControllerSubagent[] = [
  { id: 'explore', name: 'Explore', description: 'Read-only codebase exploration.', instructions: 'Explore.' },
  { id: 'execute', name: 'Execute', description: 'Task execution with write capabilities.', instructions: 'Execute.' },
];

async function subagentToolDescription(config: Partial<AgentControllerConfig>) {
  const { controller, session } = await createTestSession({ subagents, ...config });
  const toolsets = await (controller as any).buildToolsets(session, new RequestContext());
  return toolsets.controllerBuiltIn.subagent.description as string;
}

describe('AgentController subagentToolDescription', () => {
  it('builds the subagent tool description from the registered subagents', async () => {
    const describeSubagents = vi.fn((registered: AgentControllerSubagent[]) =>
      registered.map(subagent => `${subagent.id}: ${subagent.description}`).join('\n'),
    );

    const description = await subagentToolDescription({ subagentToolDescription: describeSubagents });

    expect(describeSubagents).toHaveBeenCalledWith(subagents);
    expect(description).toBe(
      'explore: Read-only codebase exploration.\nexecute: Task execution with write capabilities.',
    );
  });

  it('keeps the default description when it is not set', async () => {
    const description = await subagentToolDescription({});

    expect(description).toBe(createSubagentTool({ subagents, resolveModel: modelId => modelId }).description);
  });
});
