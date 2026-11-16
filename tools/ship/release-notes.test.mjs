import { describe, expect, it } from 'vitest';
import { notesFor } from './release-notes.mjs';

const TEXT = [
  '# Release notes',
  '',
  '## 1.1.0',
  '',
  'Newer.',
  '',
  '## 1.0.0',
  '',
  '### Part',
  '',
  'Older.',
  '',
].join('\r\n');

describe('notesFor', () => {
  it('takes one section, up to the next version', () => {
    expect(notesFor(TEXT, '1.1.0')).toBe('Newer.\n');
  });
  it('keeps the subheadings of the last section', () => {
    expect(notesFor(TEXT, '1.0.0')).toBe('### Part\n\nOlder.\n');
  });
  it('refuses a version with no section', () => {
    expect(() => notesFor(TEXT, '2.0.0')).toThrow(/no "## 2.0.0" section/);
  });
  it('refuses an empty section', () => {
    expect(() => notesFor('## 3.0.0\n\n## 2.0.0\nx', '3.0.0')).toThrow(/empty/);
  });
  it('does not take a version that only starts the same', () => {
    expect(() => notesFor('## 1.0.10\nx', '1.0.1')).toThrow();
  });
});
