#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
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

  if (process.platform === 'win32') {
    guideWindowsUser();
    process.exit(1);
  }

  if (process.env.WSL_DISTRO_NAME && process.execPath.startsWith('/mnt/')) {
    console.error('');
    console.error(`Windows Node.js is running inside WSL2 (${process.execPath}).`);
    console.error('This causes native module build failures and Docker path issues.');
    console.error('');
    console.error('Fix: install nvm inside WSL2 and use its Node. In Ubuntu:');
    console.error('');
    console.error('  export NVM_DIR="$HOME/.nvm"');
    console.error('  git clone https://github.com/nvm-sh/nvm.git "$NVM_DIR"');
    console.error(
      '  (cd "$NVM_DIR" && git checkout "$(git describe --abbrev=0 --tags --match \'v[0-9]*\')")',
    );
    console.error('  echo \'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\' >> ~/.bashrc');
    console.error('  echo \'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\' >> ~/.profile');
    console.error('  source ~/.bashrc && nvm install --lts');
    console.error('');
    process.exit(1);
  }

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
  console.log('');
  console.log(`  Code: ${user_code}`);
  console.log(`  URL:  ${verification_uri}`);
  console.log('');

  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('  Copy the code above, then press Enter to open the browser...');
    } finally {
      rl.close();
    }
  }

  tryOpenBrowser(verification_uri);
  console.log('Waiting for authorization (this window stays open)...');

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
  await assertRepoVisible(token, INTERNAL_REPO);

  if (!existsSync(INTERNAL_DIR)) {
    console.log('Fetching Evolv developer tooling...');
    if (!cloneWithToken(INTERNAL_REPO, INTERNAL_DIR, token, source)) {
      console.error('Unable to fetch Evolv developer tooling.');
      console.error('Verify that your GitHub account is authorized for evolvco/create-evolve-internal, then rerun this command.');
      process.exit(1);
    }
    return;
  }

  if (!pullWithToken(INTERNAL_DIR, token)) {
    console.error(`Unable to update cached developer tooling at ${INTERNAL_DIR}.`);
    console.error('Remove that directory (rm -rf ' + INTERNAL_DIR + ') and rerun this command if the cache is stale or corrupted.');
    process.exit(1);
  }
}

function cloneWithToken(repo, destination, token, source) {
  if (source === 'gh') {
    const result = spawnSync('gh', ['repo', 'clone', repo, destination], { stdio: 'inherit' });
    return result.status === 0;
  }
  return runGitWithToken(token, [
    'clone',
    `https://github.com/${repo}.git`,
    destination,
  ]);
}

function pullWithToken(repoDir, token) {
  return runGitWithToken(token, ['pull', '--ff-only', 'origin', INTERNAL_BRANCH], { cwd: repoDir });
}

function runGitWithToken(token, gitArgs, { cwd } = {}) {
  const args = [
    '-c', 'credential.helper=',
    '-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ...gitArgs,
  ];
  const result = spawnSync('git', args, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.status === 0;
}

async function assertRepoVisible(token, repo) {
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
  // The internal repo became a monorepo; the scaffolder bin moved under
  // packages/scaffolder. Keep the old root path as a fallback for pinned
  // pre-monorepo checkouts.
  const candidates = [
    join(INTERNAL_DIR, 'packages', 'scaffolder', 'bin', 'create-evolve.js'),
    join(INTERNAL_DIR, 'bin', 'create-evolve.js'),
  ];
  const entry = candidates.find((p) => existsSync(p));
  if (!entry) {
    console.error(`Could not find the scaffolder entry point in ${INTERNAL_DIR}.`);
    console.error('Remove that directory (rm -rf ' + INTERNAL_DIR + ') and rerun this command.');
    process.exit(1);
  }
  const run = spawnSync(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: { ...process.env, GITHUB_TOKEN: token },
  });
  process.exit(run.status || 0);
}

function decodeWslUtf16(buf) {
  // WSL list commands output UTF-16LE. Strip the BOM (0xFF 0xFE) when present.
  const start = buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0;
  return buf.slice(start).toString('utf16le');
}

function detectDefaultDistro() {
  // Primary: parse `wsl -l -v` for the * (default) marker.
  const lv = spawnSync('wsl', ['-l', '-v'], { encoding: 'buffer', timeout: 5000 });
  if (!lv.error && lv.status === 0 && lv.stdout && lv.stdout.length > 0) {
    const text = decodeWslUtf16(lv.stdout);
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r/g, '').trim();
      if (line.startsWith('*')) {
        const name = line.slice(1).trim().split(/\s+/)[0];
        if (name) return name;
      }
    }
  }
  // Fallback: first non-empty name from --list --quiet (default distro is listed first).
  const lq = spawnSync('wsl', ['--list', '--quiet'], { encoding: 'buffer', timeout: 5000 });
  if (!lq.error && lq.status === 0 && lq.stdout && lq.stdout.length > 0) {
    const text = decodeWslUtf16(lq.stdout);
    const name = text
      .split('\n')
      .map((l) => l.replace(/\r/g, '').replace(/\0/g, '').trim())
      .find((l) => l.length > 0 && l !== '﻿');
    if (name) return name;
  }
  return null;
}

function guideWindowsUser() {
  console.log('');
  console.log('create-evolve does not support native Windows (PowerShell / cmd.exe).');
  console.log('Checking your WSL2 setup...');
  console.log('');

  // Step 1 — Is WSL installed?
  const wslCheck = spawnSync('wsl', ['--list', '--quiet'], {
    encoding: 'buffer',
    timeout: 5000,
  });

  if (wslCheck.error || wslCheck.status !== 0) {
    console.error('WSL2 is not installed on this machine.');
    console.error('');
    console.error('Install it by running in PowerShell (as Administrator):');
    console.error('  wsl --install');
    console.error('');
    console.error('After installation, restart your machine, open Ubuntu from the Windows');
    console.error('Start Menu, and run:');
    console.error('  npm create evolve@latest');
    return;
  }

  // Step 2 — Which distro is the default?
  const distro = detectDefaultDistro();

  if (!distro) {
    console.error('WSL2 is installed but no default distro is configured.');
    console.error('');
    console.error('Set up Ubuntu by running in PowerShell:');
    console.error('  wsl --install -d Ubuntu');
    console.error('');
    console.error('Then open Ubuntu from the Windows Start Menu and run:');
    console.error('  npm create evolve@latest');
    return;
  }

  console.log(`WSL2 distro: ${distro}`);

  // Step 3 — npm/node Windows PATH leak check.
  // Must use -ic (interactive) — Ubuntu .bashrc has an early-return guard for
  // non-interactive shells that skips nvm init, so -lc misses nvm entirely.
  const npmCheck = spawnSync('wsl', ['-d', distro, '--', 'bash', '-ic', 'which npm 2>/dev/null'], {
    encoding: 'utf8',
    timeout: 8000,
  });
  const npmPath = (npmCheck.stdout || '').trim();
  const npmIsLeaked = npmPath.startsWith('/mnt/');

  // Step 4 — Claude Code in WSL?
  const claudeCheck = spawnSync(
    'wsl',
    ['-d', distro, '--', 'bash', '-ic', 'which claude 2>/dev/null'],
    { encoding: 'utf8', timeout: 8000 },
  );
  const claudePath = (claudeCheck.stdout || '').trim();
  const claudeMissing = !claudePath || claudePath.startsWith('/mnt/');

  console.log('');

  if (npmIsLeaked) {
    console.error('Problem: Windows npm is leaking into WSL2 PATH.');
    console.error(`  which npm → ${npmPath}  (this is the Windows version, not WSL)`);
    console.error('');
    console.error('Fix: Install nvm inside WSL2. Open Ubuntu and run:');
    console.error('');
    console.error('  export NVM_DIR="$HOME/.nvm"');
    console.error('  git clone https://github.com/nvm-sh/nvm.git "$NVM_DIR"');
    console.error(
      '  (cd "$NVM_DIR" && git checkout "$(git describe --abbrev=0 --tags --match \'v[0-9]*\')")',
    );
    console.error('');
    console.error('  # Add to BOTH ~/.bashrc AND ~/.profile (required for interactive');
    console.error('  # and login shells — .bashrc alone is not enough):');
    console.error('  echo \'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\' >> ~/.bashrc');
    console.error('  echo \'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\' >> ~/.profile');
    console.error('');
    console.error('  source ~/.bashrc');
    console.error('  nvm install --lts');
    console.error('');
  }

  if (claudeMissing) {
    console.error('Problem: Claude Code is not installed inside WSL2.');
    console.error('');
    console.error('Fix: After installing nvm and Node above, run in Ubuntu:');
    console.error('  npm install -g @anthropic-ai/claude-code');
    console.error('');
  }

  // Step 5 — Browser bridge advisory.
  // explorer.exe splits OAuth URLs on & and opens multiple windows.
  // The correct fix is a wslview wrapper using powershell.exe Start-Process.
  console.log('Note: If the GitHub auth browser does not open automatically, set up');
  console.log('a WSL browser bridge. In Ubuntu:');
  console.log('');
  console.log("  sudo tee /usr/local/bin/wslview << 'EOF'");
  console.log('#!/bin/sh');
  console.log('powershell.exe -NoProfile -Command "Start-Process \'$1\'"');
  console.log('EOF');
  console.log('  sudo chmod +x /usr/local/bin/wslview');
  console.log('  echo \'export BROWSER=wslview\' >> ~/.bashrc');
  console.log('  echo \'export BROWSER=wslview\' >> ~/.profile');
  console.log('');
  console.log('  If no browser opens during auth, copy the URL from the terminal —');
  console.log('  the flow completes either way.');
  console.log('');

  // Step 6 — Final instruction. Do NOT attempt to re-launch via wsl -- npm ... :
  // the nvm non-interactive shell problem means npm may resolve to Windows npm
  // inside WSL even after the user installs nvm, producing a silent wrong-env launch.
  console.error('Open Ubuntu from the Windows Start Menu and run:');
  console.error('  npm create evolve@latest');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
