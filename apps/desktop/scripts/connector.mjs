// Builds what the app hands out so that an AI app can be connected to the
// optional AI assistant (route A of docs/PLAN.md, section 7):
//
//   out/connector/bridge.cjs          the bridge, one file that needs only Node.js
//   out/connector/rulz-ancestry.mcpb  the connector file for Claude Desktop
//
// An .mcpb file is a zip archive with a manifest.json and the server it
// names (https://github.com/modelcontextprotocol/mcpb, MANIFEST.md). It is
// written here without a further tool: two files, deflated.
//
// Run after `electron-vite build`, which empties out/ first.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'vite';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(desktopDir, 'out', 'connector');
const { version } = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));

await build({
  configFile: false,
  root: desktopDir,
  logLevel: 'warn',
  define: { __RULZ_VERSION__: JSON.stringify(version) },
  // Everything the bridge uses is put into its one file. Only what Node.js
  // itself brings stays outside.
  ssr: { noExternal: true },
  build: {
    ssr: 'src/bridge/index.ts',
    outDir,
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    rolldownOptions: {
      output: { format: 'cjs', entryFileNames: 'bridge.cjs', codeSplitting: false },
    },
  },
});

const bridge = readFileSync(join(outDir, 'bridge.cjs'));
// The file must stand alone: where it is installed there is no node_modules
// folder. So it is started once from a folder that has none, with nothing to
// read: it loads everything it needs, finds its input at an end, and leaves.
const alone = mkdtempSync(join(tmpdir(), 'rulz-connector-'));
try {
  copyFileSync(join(outDir, 'bridge.cjs'), join(alone, 'bridge.cjs'));
  execFileSync(process.execPath, [join(alone, 'bridge.cjs')], {
    cwd: alone,
    input: '',
    stdio: ['pipe', 'ignore', 'inherit'],
    timeout: 20_000,
  });
} finally {
  rmSync(alone, { recursive: true, force: true });
}

const tools = JSON.parse(
  readFileSync(resolve(desktopDir, '../../packages/ai/src/toolspec.json'), 'utf8'),
);

const manifest = {
  manifest_version: '0.3',
  name: 'rulz-ancestry',
  display_name: 'RulZ Ancestry',
  version,
  description:
    'Lets Claude look for records of people of your family tree in RulZ Ancestry, during a session you start there.',
  long_description:
    'Works only while RulZ Ancestry is open on this PC and you have started a session of its AI assistant. Claude can then read the people of your tree who are not living, ask the sources you ticked a few questions, and file proposals. It cannot change your tree: you decide about every proposal in RulZ Ancestry.',
  author: { name: 'RulZ Ancestry contributors' },
  license: 'MIT',
  server: {
    type: 'node',
    entry_point: 'server/bridge.cjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/bridge.cjs'],
      // The bridge takes this only when it is a full path (src/bridge/profile.ts),
      // so a setting that was left empty changes nothing.
      env: { RULZ_ANCESTRY_PROFILE: '${user_config.data_folder}' },
    },
  },
  user_config: {
    data_folder: {
      type: 'directory',
      title: 'Data folder of RulZ Ancestry (leave empty)',
      description:
        'Leave this empty for an installed copy of RulZ Ancestry. Only a copy that keeps its data in another folder needs it; the window "AI assistant" of that copy names the folder.',
      required: false,
    },
  },
  tools: tools.map(({ name, description }) => ({ name, description })),
  prompts_generated: true,
  compatibility: { platforms: ['win32'], runtimes: { node: '>=18.0.0' } },
};

/** A zip archive of the given files, each deflated. No folders, no dates. */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // version needed
    common.writeUInt16LE(0x0800, 2); // names are UTF-8
    common.writeUInt16LE(8, 4); // deflate
    common.writeUInt16LE(0, 6); // time
    common.writeUInt16LE(0x21, 8); // date: 1980-01-01
    common.writeUInt32LE(crc32(data), 10);
    common.writeUInt32LE(packed.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    common.writeUInt16LE(0, 24); // no extra field
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), common, nameBytes, packed]);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    common.copy(entry, 6);
    entry.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([entry, nameBytes]));
    parts.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

writeFileSync(
  join(outDir, 'rulz-ancestry.mcpb'),
  zip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { name: 'server/bridge.cjs', data: bridge },
  ]),
);
console.log(
  `connector: bridge.cjs ${Math.round(bridge.length / 1024)} kB, rulz-ancestry.mcpb written`,
);
