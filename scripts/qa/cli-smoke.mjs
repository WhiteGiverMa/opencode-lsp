import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = join(repo, '.omo/evidence/20261002-feature09');
mkdirSync(evidence, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'lsp-cli-smoke-'));
const entry = join(repo, 'bin/opencode-lsp.js');
const runs = [];
for (const [args, expected] of [[['--help'], 0], [['config', 'v2'], 0], [['not-a-command'], 1]]) {
  const result = spawnSync(process.execPath, [entry, ...args], { env: { ...process.env, OPENCODE_LSP_HOME: home }, encoding: 'utf8' });
  runs.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr });
  console.log(`$ opencode-lsp ${args.join(' ')}\n${result.stdout}${result.stderr}exit=${result.status}\n`);
  assert.equal(result.status, expected);
}
writeFileSync(join(evidence, 'cli-smoke.json'), JSON.stringify({ terminal: process.env.TMUX ? 'tmux' : 'not-tmux', runs }, null, 2));
console.log('CLI_SMOKE_PASS');
