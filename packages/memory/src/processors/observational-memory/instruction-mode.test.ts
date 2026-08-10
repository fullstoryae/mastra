import { describe, expect, it } from 'vitest';

import {
  composeObservationExtractors,
  composeReflectionExtractors,
  resolveContinuationHints,
} from './built-in-extractors';
import { Extractor } from './extractor';
import {
  OBSERVER_EXTRACTION_INSTRUCTIONS,
  buildObserverSystemPrompt,
  resolveEffectiveObserverInstructions,
  resolveExtractionInstructions,
} from './observer-agent';
import { REFLECTOR_CONSOLIDATION_INSTRUCTIONS, buildReflectorSystemPrompt } from './reflector-agent';

const CUSTOM = 'Track entity IDs and the lifecycle state of every tool result.';

// A distinctive line from the built-in extraction guidance, used to assert whether the
// defaults are present without pinning the whole block into the test.
const DEFAULT_EXTRACTION_MARKER = 'CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS';
// A distinctive line from the built-in consolidation guidance.
const DEFAULT_CONSOLIDATION_MARKER = 'CRITICAL: USER ASSERTIONS vs QUESTIONS';
// From OBSERVER_GUIDELINES — part of the output contract OM retains in both modes.
const GUIDELINES_MARKER = 'Be specific enough for the assistant to act on';

describe('resolveExtractionInstructions', () => {
  it('returns the built-in instructions when no instruction is provided', () => {
    expect(resolveExtractionInstructions(undefined)).toBe(OBSERVER_EXTRACTION_INSTRUCTIONS);
    expect(resolveExtractionInstructions(undefined, 'replace')).toBe(OBSERVER_EXTRACTION_INSTRUCTIONS);
  });

  it('returns the built-in instructions in append mode', () => {
    expect(resolveExtractionInstructions(CUSTOM, 'append')).toBe(OBSERVER_EXTRACTION_INSTRUCTIONS);
  });

  it('returns the caller instruction in replace mode', () => {
    expect(resolveExtractionInstructions(CUSTOM, 'replace')).toBe(CUSTOM);
  });
});

describe('resolveEffectiveObserverInstructions', () => {
  it('combines the built-in guidance with the custom instruction in append mode', () => {
    const effective = resolveEffectiveObserverInstructions(CUSTOM, 'append');

    expect(effective).toContain(DEFAULT_EXTRACTION_MARKER);
    expect(effective).toContain('=== CUSTOM INSTRUCTIONS ===');
    expect(effective).toContain(CUSTOM);
  });

  it('returns only the caller instruction in replace mode', () => {
    const effective = resolveEffectiveObserverInstructions(CUSTOM, 'replace');

    expect(effective).toBe(CUSTOM);
    expect(effective).not.toContain(DEFAULT_EXTRACTION_MARKER);
  });

  it('returns the built-in guidance when no instruction is configured', () => {
    expect(resolveEffectiveObserverInstructions(undefined)).toBe(OBSERVER_EXTRACTION_INSTRUCTIONS);
  });

  // The Observer prompt interleaves the output format and guidelines between the extraction
  // block and the custom-instruction suffix, so the effective guidance is not one contiguous
  // slice of it — but every part of it must be present.
  it('covers the guidance the observer prompt actually carries', () => {
    for (const mode of ['append', 'replace'] as const) {
      const prompt = buildObserverSystemPrompt(false, CUSTOM, false, undefined, mode);
      const effective = resolveEffectiveObserverInstructions(CUSTOM, mode);

      expect(prompt).toContain(resolveExtractionInstructions(CUSTOM, mode));
      expect(effective).toContain(resolveExtractionInstructions(CUSTOM, mode));
      expect(effective).toContain(CUSTOM);
      expect(prompt).toContain(CUSTOM);
    }
  });
});

describe('buildObserverSystemPrompt instructionMode', () => {
  it('appends by default, keeping the built-in extraction guidance', () => {
    const prompt = buildObserverSystemPrompt(false, CUSTOM);

    expect(prompt).toContain(DEFAULT_EXTRACTION_MARKER);
    expect(prompt).toContain('=== CUSTOM INSTRUCTIONS ===');
    expect(prompt).toContain(CUSTOM);
  });

  it('replaces the built-in extraction guidance in replace mode', () => {
    const prompt = buildObserverSystemPrompt(false, CUSTOM, false, [], 'replace');

    expect(prompt).toContain(CUSTOM);
    expect(prompt).not.toContain(DEFAULT_EXTRACTION_MARKER);
    expect(prompt).not.toContain('=== CUSTOM INSTRUCTIONS ===');
  });

  it('retains the output format and guidelines in replace mode', () => {
    const prompt = buildObserverSystemPrompt(false, CUSTOM, false, [], 'replace');

    expect(prompt).toContain('<observations>');
    expect(prompt).toContain('=== OUTPUT FORMAT ===');
    expect(prompt).toContain(GUIDELINES_MARKER);
  });

  it('falls back to the built-in guidance when replace mode has no instruction', () => {
    const prompt = buildObserverSystemPrompt(false, undefined, false, [], 'replace');

    expect(prompt).toContain(DEFAULT_EXTRACTION_MARKER);
  });

  it('supports replace mode on the multi-thread prompt', () => {
    const prompt = buildObserverSystemPrompt(true, CUSTOM, false, [], 'replace');

    expect(prompt).toContain(CUSTOM);
    expect(prompt).toContain('=== MULTI-THREAD INPUT ===');
    expect(prompt).not.toContain(DEFAULT_EXTRACTION_MARKER);
  });

  it('leaves the default prompt unchanged when no instruction is given', () => {
    expect(buildObserverSystemPrompt(false, undefined, false, undefined, 'replace')).toBe(buildObserverSystemPrompt());
  });
});

describe('buildReflectorSystemPrompt instructionMode', () => {
  it('appends by default, keeping the built-in consolidation guidance', () => {
    const prompt = buildReflectorSystemPrompt(CUSTOM);

    expect(prompt).toContain(DEFAULT_CONSOLIDATION_MARKER);
    expect(prompt).toContain('=== CUSTOM INSTRUCTIONS ===');
    expect(prompt).toContain(CUSTOM);
  });

  it('replaces the built-in consolidation guidance in replace mode', () => {
    const prompt = buildReflectorSystemPrompt(CUSTOM, [], 'replace');

    expect(prompt).toContain(CUSTOM);
    expect(prompt).not.toContain(REFLECTOR_CONSOLIDATION_INSTRUCTIONS);
    expect(prompt).not.toContain('=== CUSTOM INSTRUCTIONS ===');
  });

  it('describes the observer guidance that is actually in effect', () => {
    const observerInstructions = resolveExtractionInstructions(CUSTOM, 'replace');
    const prompt = buildReflectorSystemPrompt(undefined, [], 'append', observerInstructions);

    expect(prompt).toContain('<observational-memory-instruction>');
    expect(prompt).toContain(CUSTOM);
    expect(prompt).not.toContain(DEFAULT_EXTRACTION_MARKER);
  });

  it('defaults to the built-in observer guidance when none is supplied', () => {
    expect(buildReflectorSystemPrompt()).toContain(DEFAULT_EXTRACTION_MARKER);
  });
});

describe('resolveContinuationHints', () => {
  it('enables both sections by default', () => {
    expect(resolveContinuationHints(undefined)).toEqual({ currentTask: true, suggestedResponse: true });
    expect(resolveContinuationHints(true)).toEqual({ currentTask: true, suggestedResponse: true });
  });

  it('disables both sections when false', () => {
    expect(resolveContinuationHints(false)).toEqual({ currentTask: false, suggestedResponse: false });
  });

  it('supports disabling sections individually', () => {
    expect(resolveContinuationHints({ suggestedResponse: false })).toEqual({
      currentTask: true,
      suggestedResponse: false,
    });
    expect(resolveContinuationHints({ currentTask: false })).toEqual({
      currentTask: false,
      suggestedResponse: true,
    });
  });
});

describe('continuationHints extractor composition', () => {
  const user = new Extractor({ name: 'Preference', instructions: 'Extract preference.' });

  it('registers both continuation extractors by default', () => {
    expect(composeObservationExtractors({ threadTitle: false, extract: [user] }).map(e => e.slug)).toEqual([
      'current-task',
      'suggested-response',
      'preference',
    ]);
  });

  it('omits both continuation extractors when disabled', () => {
    expect(
      composeObservationExtractors({ threadTitle: false, extract: [user], continuationHints: false }).map(e => e.slug),
    ).toEqual(['preference']);
  });

  it('omits only the suggested-response extractor when disabled individually', () => {
    expect(
      composeObservationExtractors({
        threadTitle: true,
        extract: [user],
        continuationHints: { suggestedResponse: false },
      }).map(e => e.slug),
    ).toEqual(['current-task', 'thread-title', 'preference']);
  });

  it('applies continuation hints to reflection extractors too', () => {
    expect(
      composeReflectionExtractors({ extract: [user], continuationHints: { suggestedResponse: false } }).map(
        e => e.slug,
      ),
    ).toEqual(['current-task', 'preference']);
  });
});

describe('prompts only reference continuation sections they define', () => {
  it('drops suggested-response guidance from the observer prompt when disabled', () => {
    const extractors = composeObservationExtractors({
      threadTitle: false,
      continuationHints: { suggestedResponse: false },
    });
    const prompt = buildObserverSystemPrompt(false, undefined, false, extractors);

    expect(prompt).not.toContain('<suggested-response>');
    expect(prompt).toContain('<current-task>');
  });

  it('drops all continuation guidance from the observer prompt when both are disabled', () => {
    const extractors = composeObservationExtractors({ threadTitle: false, continuationHints: false });
    const prompt = buildObserverSystemPrompt(false, undefined, false, extractors);

    expect(prompt).not.toContain('<suggested-response>');
    expect(prompt).not.toContain('<current-task>');
    expect(prompt).toContain('User messages are extremely important.');
  });

  it('drops suggested-response guidance from the reflector prompt when disabled', () => {
    const extractors = composeReflectionExtractors({ continuationHints: { suggestedResponse: false } });
    const prompt = buildReflectorSystemPrompt(undefined, extractors);

    expect(prompt).not.toContain('<suggested-response>');
    expect(prompt).toContain('<current-task>');
  });

  it('still describes both sections on the legacy path with no extractors', () => {
    const prompt = buildObserverSystemPrompt();

    expect(prompt).toContain('<current-task>');
    expect(prompt).toContain('<suggested-response>');
  });
});

describe('multi-thread prompt follows the active continuation sections', () => {
  const multiThreadPrompt = (
    continuationHints: Parameters<typeof composeObservationExtractors>[0]['continuationHints'],
  ) =>
    buildObserverSystemPrompt(
      true,
      undefined,
      false,
      composeObservationExtractors({ threadTitle: false, continuationHints }),
    );

  it('nests and demonstrates both sections by default', () => {
    const prompt = multiThreadPrompt(undefined);

    expect(prompt).toContain(
      "Each thread's observations, current-task, and suggested-response should be nested inside",
    );
    expect(prompt).toContain('<current-task>');
    expect(prompt).toContain('<suggested-response>');
  });

  it('omits suggested-response from the nesting instruction and examples when disabled', () => {
    const prompt = multiThreadPrompt({ suggestedResponse: false });

    expect(prompt).toContain("Each thread's observations and current-task should be nested inside");
    expect(prompt).toContain('<current-task>');
    expect(prompt).not.toContain('<suggested-response>');
  });

  it('omits current-task from the nesting instruction and examples when disabled', () => {
    const prompt = multiThreadPrompt({ currentTask: false });

    expect(prompt).toContain("Each thread's observations and suggested-response should be nested inside");
    expect(prompt).toContain('<suggested-response>');
    expect(prompt).not.toContain('<current-task>');
  });

  it('drops both sections entirely when continuation hints are disabled', () => {
    const prompt = multiThreadPrompt(false);

    expect(prompt).toContain("Each thread's observations should be nested inside");
    expect(prompt).not.toContain('<current-task>');
    expect(prompt).not.toContain('<suggested-response>');
    // The thread scaffolding itself must survive so multi-thread output stays parseable.
    expect(prompt).toContain('<thread id="thread_id_1">');
    expect(prompt).toContain('=== MULTI-THREAD INPUT ===');
  });

  it('still lists thread-title alongside the enabled sections', () => {
    const prompt = buildObserverSystemPrompt(
      true,
      undefined,
      true,
      composeObservationExtractors({ threadTitle: true, continuationHints: { suggestedResponse: false } }),
    );

    expect(prompt).toContain("Each thread's observations, current-task, and thread-title should be nested inside");
    expect(prompt).toContain('<thread-title>');
    expect(prompt).not.toContain('<suggested-response>');
  });

  it('leaves the default multi-thread prompt unchanged on the legacy path', () => {
    expect(buildObserverSystemPrompt(true, undefined, false, undefined)).toContain(
      "Each thread's observations, current-task, and suggested-response should be nested inside",
    );
  });

  // Pins the exact default example so the section-driven template can't silently drift
  // from the shape the multi-thread parser expects.
  it('renders the default per-thread example verbatim', () => {
    expect(buildObserverSystemPrompt(true, undefined, true, undefined)).toContain(
      `<observations>
<thread id="thread_id_1">
Date: Dec 4, 2025
* 🔴 (14:30) User prefers direct answers
* 🔴 (14:31) Working on feature X

<current-task>
What the agent is currently working on in this thread
</current-task>

<suggested-response>
Hint for the agent's next message in this thread
</suggested-response>
<thread-title>Feature X implementation</thread-title>
</thread>

<thread id="thread_id_2">
Date: Dec 5, 2025
* 🔴 (09:15) User asked about deployment

<current-task>
Current task for this thread
</current-task>

<suggested-response>
Suggested response for this thread
</suggested-response>
<thread-title>Deployment setup</thread-title>
</thread>
</observations>`,
    );
  });
});
