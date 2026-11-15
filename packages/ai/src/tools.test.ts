import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_TOOLS, AI_TOOL_INPUTS, AI_TOOL_NAMES, aiToolSpecs } from './tools';

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

describe('the tools as an AI app lists them', () => {
  const file = join(import.meta.dirname, 'toolspec.json');

  it('are in toolspec.json exactly as the tools stand', () => {
    const specs = aiToolSpecs();
    // RULZ_WRITE_TOOLSPEC=1 writes the file anew, after a tool was changed.
    if (process.env['RULZ_WRITE_TOOLSPEC'] === '1') {
      writeFileSync(file, `${JSON.stringify(specs, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(specs);
  });

  it('give every tool a description, an object to take, and nothing beyond what it names', () => {
    const specs = aiToolSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(AI_TOOL_NAMES);
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(spec.inputSchema).not.toHaveProperty('$schema');
    }
  });

  it('say of every value a tool takes what it is', () => {
    const undescribed: string[] = [];
    const look = (schema: unknown, path: string): void => {
      if (typeof schema !== 'object' || schema === null) return;
      const node = schema as Record<string, unknown>;
      const properties = (node['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      for (const [key, value] of Object.entries(properties)) {
        if (typeof value['description'] !== 'string') undescribed.push(`${path}.${key}`);
        look(value, `${path}.${key}`);
        look(value['items'], `${path}.${key}[]`);
      }
    };
    for (const spec of aiToolSpecs()) look(spec.inputSchema, spec.name);
    expect(undescribed).toEqual([]);
  });
});
