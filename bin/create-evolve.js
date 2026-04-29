#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const INTERNAL_REPO = 'evolvco/create-evolve-internal';
const INTERNAL_BRANCH = 'main';
const CACHE_DIR = join(homedir(), '.cache', 'create-evolve');
const INTERNAL_DIR = process.env.CREATE_EVOLVE_INTERNAL_PATH || join(CACHE_DIR, 'internal');

const GITHUB_APP_CLIENT_ID = 'Iv23liREGyY5AVpmWcyt';
const REQUIRED_SCOPES = ['read:packages', 'repo'];
const PAT_URL =
  'https://github.com/settings/personal-access-tokens/new' +
  '?name=create-evolve' +
  '&target_name=evolvco' +
  '&description=Used+by+create-evolve+to+access+evolvco+repos+and+packages';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

async function main() {
  console.log(`[create-evolve launcher v${PKG.version}]`);
  const { launcherArgs, forwardArgs } = splitArgs(process.argv.slice(2));

  if (launcherArgs.help) {
    printUsage();
    return;
  }
  if (launcherArgs.version) {
    console.log(PKG.version);
    return;
  }

  const { token, source } = await resolveToken({
    cliToken: launcherArgs.token,
    authMode: launcherArgs.authMode,
    allowGh: launcherArgs.allowGh,
  });
  console.log(`[diag] auth source: ${source} | token prefix: ${token.slice(0, 4)}... | length: ${token.length}`);

  await ensureInternalImplementation(token, source);
  runInternal(forwardArgs, token);
}

function splitArgs(args) {
  const launcherArgs = {
    help: false,
    version: false,
    token: null,
    authMode: 'auto',
    allowGh: true,
  };
  const forwardArgs = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--launcher-help') {
      launcherArgs.help = true;
      continue;
    }
    if (arg === '--launcher-version') {
      launcherArgs.version = true;
      continue;
    }
    if (arg === '--token') {
      launcherArgs.token = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--token=')) {
      launcherArgs.token = arg.slice('--token='.length);
      continue;
    }
    if (arg === '--auth') {
      launcherArgs.authMode = normalizeAuthMode(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--auth=')) {
      launcherArgs.authMode = normalizeAuthMode(arg.slice('--auth='.length));
      continue;
    }
    if (arg === '--no-gh') {
      launcherArgs.allowGh = false;
      continue;
    }
    forwardArgs.push(arg);
  }

  return { launcherArgs, forwardArgs };
}

function normalizeAuthMode(mode) {
  const valid = ['auto', 'env', 'gh', 'device', 'pat'];
  if (valid.includes(mode)) return mode;
  console.error(`Unknown --auth mode: ${mode}. Expected one of: ${valid.join(', ')}.`);
  process.exit(1);
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
  console.log('  --launcher-help        Show this launcher help.');
  console.log('  --launcher-version     Show this launcher version.');
  console.log('  --token <pat>          Use this GitHub token instead of running auth.');
  console.log('  --auth <mode>          Force one source: env | gh | device | pat | auto (default).');
  console.log('  --no-gh                Skip the gh CLI even if it is installed.');
  console.log('');
  console.log('Authentication (tried in order, first match wins):');
  console.log('  --token <pat>          Highest priority.');
  console.log('  GITHUB_TOKEN env       Used if set.');
  console.log('  gh CLI                 Used if installed and authenticated.');
  console.log('  Device flow            Browser authorization against the create-evolve-cli GitHub App.');
  console.log('  PAT paste              Last-resort manual token entry.');
}

async function resolveToken({ cliToken, authMode, allowGh }) {
  if (cliToken) {
    return { token: cliToken, source: 'flag' };
  }

  if (authMode && authMode !== 'auto') {
    return resolveExplicitMode(authMode);
  }

  if (process.env.GITHUB_TOKEN) {
    return { token: process.env.GITHUB_TOKEN, source: 'env' };
  }

  if (allowGh && hasGh()) {
    const ghToken = readGhToken();
    if (ghToken) {
      return { token: ghToken, source: 'gh' };
    }
  }

  if (!process.stdin.isTTY) {
    console.error('No GitHub credentials available and stdin is not a TTY.');
    console.error('Set GITHUB_TOKEN or pass --token <token> before re-running.');
    process.exit(1);
  }

  try {
    const token = await deviceFlowLogin();
    return { token, source: 'device' };
  } catch (err) {
    console.error('');
    console.error(`Device flow failed: ${err.message}`);
    console.error('Falling back to manual token entry.');
    const token = await promptForPat();
    return { token, source: 'pat' };
  }
}

async function resolveExplicitMode(mode) {
  if (mode === 'env') {
    if (!process.env.GITHUB_TOKEN) {
      console.error('--auth env requested but GITHUB_TOKEN is not set.');
      process.exit(1);
    }
    return { token: process.env.GITHUB_TOKEN, source: 'env' };
  }
  if (mode === 'gh') {
    if (!hasGh()) {
      console.error('--auth gh requested but the GitHub CLI is not installed.');
      process.exit(1);
    }
    const token = readGhToken();
    if (!token) {
      console.error('--auth gh requested but `gh auth token` did not return a token. Run `gh auth login` first.');
      process.exit(1);
    }
    return { token, source: 'gh' };
  }
  if (mode === 'device') {
    const token = await deviceFlowLogin();
    return { token, source: 'device' };
  }
  if (mode === 'pat') {
    const token = await promptForPat();
    return { token, source: 'pat' };
  }
  console.error(`Unknown --auth mode: ${mode}`);
  process.exit(1);
}

function hasGh() {
  return spawnSync('gh', ['--version'], { stdio: 'pipe' }).status === 0;
}

function readGhToken() {
  const status = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  if (status.status !== 0) return null;
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

async function deviceFlowLogin() {
  const codeRes = await postJson(DEVICE_CODE_URL, {
    client_id: GITHUB_APP_CLIENT_ID,
    scope: REQUIRED_SCOPES.join(' '),
  });

  if (!codeRes.device_code) {
    throw new Error(`Device code request failed: ${JSON.stringify(codeRes)}`);
  }

  const { device_code, user_code, verification_uri, expires_in, interval } = codeRes;

  console.log('');
  console.log('Sign in to GitHub to authorize create-evolve:');
  console.log(`  1. Open ${verification_uri}`);
  console.log(`  2. Enter the code: ${user_code}`);
  console.log('');
  console.log('Waiting for authorization (this window stays open)...');
  tryOpenBrowser(verification_uri);

  const expiresAt = Date.now() + expires_in * 1000;
  let pollInterval = Math.max(interval, 1);

  while (Date.now() < expiresAt) {
    await sleep(pollInterval * 1000);

    const tokenRes = await postJson(ACCESS_TOKEN_URL, {
      client_id: GITHUB_APP_CLIENT_ID,
      device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (tokenRes.access_token) {
      console.log('GitHub authorization complete.');
      return tokenRes.access_token;
    }

    switch (tokenRes.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        pollInterval += 5;
        continue;
      case 'expired_token':
        throw new Error('Device code expired before authorization completed.');
      case 'access_denied':
        throw new Error('GitHub authorization was cancelled.');
      default:
        throw new Error(`Device flow failed: ${tokenRes.error_description || tokenRes.error || 'unknown error'}`);
    }
  }

  throw new Error('Device code expired before authorization completed.');
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'create-evolve-launcher',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryOpenBrowser(url) {
  const opener = pickOpener();
  if (!opener) return;
  try {
    const child = spawn(opener.cmd, [...opener.args, url], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // best effort; URL is already on screen
  }
}

function pickOpener() {
  const p = platform();
  if (p === 'darwin') return { cmd: 'open', args: [] };
  if (p === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  return { cmd: 'xdg-open', args: [] };
}

async function promptForPat() {
  console.log('');
  console.log('Create a fine-grained personal access token here:');
  console.log(`  ${PAT_URL}`);
  console.log('Required permissions: Repository contents (read), Packages (read).');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let token;
  try {
    token = (await rl.question('Paste token: ')).trim();
  } finally {
    rl.close();
  }

  if (!token) {
    throw new Error('No token provided.');
  }
  return token;
}

async function ensureInternalImplementation(token, source) {
  mkdirSync(CACHE_DIR, { recursive: true });

  if (!existsSync(INTERNAL_DIR)) {
    await assertRepoVisible(token, INTERNAL_REPO);
    console.log('Fetching Evolv developer tooling...');
    if (!cloneWithToken(INTERNAL_REPO, INTERNAL_DIR, token, source)) {
      console.error('Unable to fetch Evolv developer tooling.');
      console.error('Verify that your GitHub account is authorized for evolvco/create-evolve-internal, then rerun this command.');
      process.exit(1);
    }
    return;
  }

  const update = spawnSync('git', ['pull', '--ff-only', 'origin', INTERNAL_BRANCH], {
    cwd: INTERNAL_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...gitTokenEnv(token) },
  });
  if (update.status !== 0) {
    console.error(`Unable to update cached developer tooling at ${INTERNAL_DIR}.`);
    console.error('Remove that directory and rerun this command if the cache is stale or corrupted.');
    process.exit(update.status || 1);
  }
}

function cloneWithToken(repo, destination, token, source) {
  if (source === 'gh') {
    const result = spawnSync('gh', ['repo', 'clone', repo, destination], { stdio: 'inherit' });
    return result.status === 0;
  }

  const askPassDir = writeAskPassScript(token);
  const askPassLog = join(askPassDir, 'askpass.log');
  const args = [
    '-c', 'credential.helper=',
    '-c', 'credential.useHttpPath=true',
    'clone',
    `https://github.com/${repo}.git`,
    destination,
  ];
  console.log(`[diag] running: git ${args.join(' ')}`);

  try {
    const result = spawnSync('git', args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_ASKPASS: join(askPassDir, 'askpass.sh'),
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    console.log(`[diag] git exit code: ${result.status}`);
    dumpAskPassLog(askPassLog);
    return result.status === 0;
  } finally {
    rmSync(askPassDir, { recursive: true, force: true });
  }
}

function gitTokenEnv(token) {
  const askPassDir = writeAskPassScript(token);
  process.on('exit', () => {
    try {
      rmSync(askPassDir, { recursive: true, force: true });
    } catch {}
  });
  return {
    GIT_ASKPASS: join(askPassDir, 'askpass.sh'),
    GIT_TERMINAL_PROMPT: '0',
  };
}

function dumpAskPassLog(logPath) {
  if (!existsSync(logPath)) {
    console.log('[diag] GIT_ASKPASS was never invoked by git (no log entries).');
    console.log('[diag]   This usually means a credential helper short-circuited the prompt.');
    return;
  }
  const log = readFileSync(logPath, 'utf8').trim();
  console.log('[diag] GIT_ASKPASS invocations:');
  for (const line of log.split('\n')) {
    console.log(`[diag]   ${line}`);
  }
}

function writeAskPassScript(token) {
  const askPassDir = mkdtempSync(join(tmpdir(), 'create-evolve-askpass-'));
  const askPassScript = join(askPassDir, 'askpass.sh');
  const askPassLog = join(askPassDir, 'askpass.log');
  // git calls GIT_ASKPASS with prompts like "Username for 'https://...':" and
  // "Password for 'https://x-access-token@...':". GitHub App user-to-server
  // tokens (ghu_*) require the username to be the literal string
  // 'x-access-token'; using the token as both username and password yields
  // a misleading 404 on private repos. Branch on the prompt to send the
  // right value, and log every invocation so we can confirm git is
  // actually using us instead of a credential helper.
  const escaped = escapeForShell(token);
  const escapedLog = askPassLog.replace(/'/g, `'\\''`);
  writeFileSync(
    askPassScript,
    [
      '#!/bin/sh',
      `prompt="$1"`,
      `case "$prompt" in`,
      `  Username*) reply="x-access-token"; replyKind="username='x-access-token'" ;;`,
      `  *) reply="${escaped}"; replyKind="password=<token-len-${token.length}>" ;;`,
      `esac`,
      `printf '%s\\n' "prompt=$prompt -> $replyKind" >> '${escapedLog}'`,
      `printf '%s' "$reply"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(askPassScript, 0o700);
  return askPassDir;
}

function escapeForShell(value) {
  return value.replace(/(["\\$`])/g, '\\$1');
}

async function assertRepoVisible(token, repo) {
  console.log(`[diag] probing GET https://api.github.com/repos/${repo} with Bearer token...`);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'create-evolve-launcher',
      },
    });
  } catch (err) {
    console.error(`Could not reach the GitHub API to verify access to ${repo}: ${err.message}`);
    process.exit(1);
  }

  console.log(`[diag] API probe HTTP ${res.status} (${res.statusText || ''})`);
  if (res.ok) return;

  if (res.status === 401) {
    console.error('Your GitHub token is invalid or expired. Re-run create-evolve to re-authorize.');
    process.exit(1);
  }
  if (res.status === 403 || res.status === 404) {
    console.error(`Your GitHub token cannot read ${repo}.`);
    console.error('');
    console.error('This usually means the create-evolve-cli GitHub App is not installed on the');
    console.error('evolvco organization, or it is installed without access to this repo. Ask an');
    console.error('evolvco admin to install or extend the App at:');
    console.error('  https://github.com/apps/create-evolve-cli');
    console.error('');
    console.error('After installation, re-run `npm create evolve@latest`.');
    process.exit(1);
  }
  console.error(`Unexpected response from GitHub API while checking ${repo}: HTTP ${res.status}`);
  process.exit(1);
}

function runInternal(args, token) {
  const entry = join(INTERNAL_DIR, 'bin', 'create-evolve.js');
  const run = spawnSync(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: { ...process.env, GITHUB_TOKEN: token },
  });
  process.exit(run.status || 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
