#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
const INTERNAL_REPO = 'evolvco/create-evolve-internal';
const INTERNAL_BRANCH = 'main';
const CACHE_DIR = join(homedir(), '.cache', 'create-evolve');
const INTERNAL_DIR = process.env.CREATE_EVOLVE_INTERNAL_PATH || join(CACHE_DIR, 'internal');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--launcher-version')) {
    console.log(PKG.version);
    return;
  }
  if (args.includes('--launcher-help')) {
    printUsage();
    return;
  }

  ensureGhInstalled();
  ensureAuth();
  ensureInternalImplementation();
  runInternal(args);
}

function printUsage() {
  console.log(`create-evolve v${PKG.version}`);
  console.log('');
  console.log('Public launcher for Evolv authorized developer tooling.');
  console.log('');
  console.log('Usage:');
  console.log('  npm create evolve@latest <directory>');
  console.log('  npm create evolve@latest <directory> -- <internal-options>');
  console.log('');
  console.log('Launcher options:');
  console.log('  --launcher-help       Show this launcher help.');
  console.log('  --launcher-version    Show this launcher version.');
  console.log('');
  console.log('Requires the GitHub CLI (gh) and an authorized GitHub account.');
}

function ensureGhInstalled() {
  const result = spawnSync('gh', ['--version'], { stdio: 'pipe' });
  if (result.status !== 0) {
    console.error('GitHub CLI (gh) is not installed.');
    console.error('Install it from https://cli.github.com/ and re-run.');
    process.exit(1);
  }
}

function ensureAuth() {
  const status = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe', encoding: 'utf8' });

  if (status.status !== 0) {
    console.log('No active GitHub authentication. Opening browser to log in...');
    const login = spawnSync(
      'gh',
      ['auth', 'login', '--web', '-s', 'repo'],
      { stdio: 'inherit' },
    );
    if (login.status !== 0) {
      console.error('GitHub login failed. Re-run after authenticating manually with `gh auth login`.');
      process.exit(1);
    }
    return;
  }
}

function commandExists(cmd) {
  const result = spawnSync('which', [cmd], { stdio: 'pipe' });
  return result.status === 0;
}

function ensureInternalImplementation() {
  mkdirSync(CACHE_DIR, { recursive: true });

  if (!existsSync(INTERNAL_DIR)) {
    console.log('Fetching Evolv developer tooling...');
    const clone = spawnSync('gh', ['repo', 'clone', INTERNAL_REPO, INTERNAL_DIR], { stdio: 'inherit' });
    if (clone.status !== 0) {
      console.error('Unable to fetch Evolv developer tooling.');
      console.error('Verify that your GitHub account is authorized, then rerun this command.');
      process.exit(clone.status || 1);
    }
    return;
  }

  const update = spawnSync('git', ['pull', '--ff-only', 'origin', INTERNAL_BRANCH], {
    cwd: INTERNAL_DIR,
    stdio: 'inherit',
  });
  if (update.status !== 0) {
    console.error(`Unable to update cached developer tooling at ${INTERNAL_DIR}.`);
    console.error('Remove that directory and rerun this command if the cache is stale or corrupted.');
    process.exit(update.status || 1);
  }
}

function runInternal(args) {
  const entry = join(INTERNAL_DIR, 'bin', 'create-evolve.js');
  const run = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
  process.exit(run.status || 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
