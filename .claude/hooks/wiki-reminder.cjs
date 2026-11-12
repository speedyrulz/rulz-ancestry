// Claude Code PostToolUse hook for the Bash and PowerShell tools.
//
// After a push or pull-request merge of the main repository, it tells Claude
// to update the project's GitHub wiki. It prints nothing for other commands.
// Wired up in .claude/settings.json.

'use strict';

/** Options that can sit between `git` and its subcommand, such as `-C <dir>`. */
const GIT_OPTIONS = String.raw`(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*`;

const PUSH_OR_MERGE = [
  new RegExp(String.raw`\bgit\s+${GIT_OPTIONS}push\b`),
  /\bgh\s+pr\s+merge\b/,
  /\bgh\s+repo\s+create\b[^;&|\n]*--push\b/,
];

/** A push made from inside a wiki clone is the wiki update itself. */
const WIKI_PATH = String.raw`(?:"[^"]*wiki[^"]*"|'[^']*wiki[^']*'|[^\s;&|]*wiki[^\s;&|]*)`;
const TARGETS_WIKI = new RegExp(
  String.raw`(?:\b(?:cd|pushd|Set-Location)|\s-C)\s+${WIKI_PATH}|\.wiki\.git\b`,
  'i',
);

const REMINDER = [
  'Project rule: the owner wants the GitHub wiki updated after every push or merge.',
  'A push or pull-request merge of the main repository just ran.',
  'If it succeeded, update the wiki before you end this turn:',
  "(1) clone this repository's wiki (the origin URL with `.wiki.git` in place of `.git`, branch `master`) into a temporary folder;",
  '(2) add an entry at the top of `Changelog.md` with the date, a link to the commit or pull request, and what changed;',
  '(3) update every other page the change makes out of date (`Home.md` status, `Roadmap.md`, `Architecture.md`, `Data-Sources.md`, `Development.md`);',
  '(4) commit and push the wiki.',
  'The wiki is public: include no personal details, local user paths or secrets.',
  'Ignore this reminder if the push failed or was a push of the wiki itself.',
].join(' ');

function reminderFor(command) {
  if (/--dry-run\b/.test(command)) return null;
  if (TARGETS_WIKI.test(command)) return null;
  return PUSH_OR_MERGE.some((pattern) => pattern.test(command)) ? REMINDER : null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let command;
  try {
    command = String(JSON.parse(input)?.tool_input?.command ?? '');
  } catch {
    return; // Not hook input; stay silent.
  }

  const reminder = reminderFor(command);
  if (!reminder) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reminder },
    }),
  );
});
