import { describe, expect, it } from 'vitest';
import { AI_TOOLS, AI_TOOL_INPUTS, AI_TOOL_NAMES } from './tools';

describe('the tools of the AI assistant', () => {
  it('are these, each with words for what it is for', () => {
    expect(AI_TOOL_NAMES).toEqual([
      'get_session',
      'list_sources',
      'search_tree',
      'get_person',
      'get_relatives',
      'search_records',
      'get_record',
      'propose_match',
    ]);
    for (const tool of AI_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.input, tool.name).toBe(AI_TOOL_INPUTS[tool.name]);
    }
  });

  it('take nothing beside what they ask for', () => {
    for (const name of AI_TOOL_NAMES) {
      expect(AI_TOOL_INPUTS[name].safeParse({ path: 'C:/x' }).success, name).toBe(false);
    }
    expect(AI_TOOL_INPUTS.get_session.safeParse({}).success).toBe(true);
    expect(AI_TOOL_INPUTS.get_person.safeParse({ personId: 'p1' }).success).toBe(true);
    expect(AI_TOOL_INPUTS.get_person.safeParse({ personId: 'p1', url: 'x' }).success).toBe(false);
    expect(AI_TOOL_INPUTS.get_person.safeParse({ personId: 'x'.repeat(65) }).success).toBe(false);
  });

  it('take a question to a source as a person, a source, a name and two years', () => {
    const asked = {
      personId: 'p1',
      sourceId: 'wikitree',
      given: 'Marten',
      surname: 'Veldkamp',
      birthYear: 1850,
      deathYear: null,
    };
    expect(AI_TOOL_INPUTS.search_records.safeParse(asked).success).toBe(true);
    expect(AI_TOOL_INPUTS.search_records.safeParse({ ...asked, offset: 20 }).success).toBe(false);
    expect(AI_TOOL_INPUTS.search_records.safeParse({ ...asked, words: 'x' }).success).toBe(false);
  });

  it('take a proposal as a person, a reference, a verdict, a confidence and reasons', () => {
    const proposal = {
      personId: 'p1',
      ref: 'r1',
      verdict: 'fits',
      confidence: 'medium',
      reasons: [{ side: 'for', text: 'The year is the same.', quote: '1850' }],
    };
    expect(AI_TOOL_INPUTS.propose_match.safeParse(proposal).success).toBe(true);
    expect(AI_TOOL_INPUTS.propose_match.safeParse({ ...proposal, reasons: [] }).success).toBe(
      false,
    );
    expect(AI_TOOL_INPUTS.propose_match.safeParse({ ...proposal, attach: true }).success).toBe(
      false,
    );
  });
});
