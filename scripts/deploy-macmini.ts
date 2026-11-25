import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

interface DeployConfig {
  host: string;
  remoteDir: string;
  service: string;
  sshOpts: string[];
  healthUrl: string;
}

const RUNTIME_PACKAGES = [
  '@local/dsh-persona',
  '@local/dsh-hub',
  '@local/dsh-router',
  '@local/dsh-connector-github',
  '@local/dsh-trigger-memo',
  '@local/dsh-connector-wxarc',
] as const;

const PLACEHOLDER_HOST = 'user@your-host';
const PLACEHOLDER_REMOTE_DIR = '/path/to/plugins';

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = stripQuotes(line.slice(eqIndex + 1));
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function splitArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).filter(Boolean);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function loadDeployConfig(repoRoot: string): DeployConfig {
  const fileVars = parseEnvFile(path.join(repoRoot, '.env.deploy'));
  const readVar = (name: string): string => {
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
      return fromEnv.trim();
    }
    return (fileVars[name] ?? '').trim();
  };

  const host = readVar('DSH_DEPLOY_HOST');
  const remoteDir = readVar('DSH_DEPLOY_REMOTE_DIR');
  const service = readVar('DSH_DEPLOY_SERVICE');
  const sshOpts = splitArgs(readVar('DSH_DEPLOY_SSH_OPTS'));
  const healthUrl = readVar('DSH_DEPLOY_HEALTH_URL');

  if (!host || host === PLACEHOLDER_HOST) {
    throw new Error(
      'Missing or placeholder DSH_DEPLOY_HOST. Copy .env.deploy.example to .env.deploy and fill in your host.',
    );
  }
  if (!remoteDir || remoteDir === PLACEHOLDER_REMOTE_DIR) {
    throw new Error(
      'Missing or placeholder DSH_DEPLOY_REMOTE_DIR. Copy .env.deploy.example to .env.deploy and fill in the remote plugin directory.',
    );
  }

  return { host, remoteDir, service, sshOpts, healthUrl };
}

function runSync(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
}

function captureSync(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureCleanGitTree(repoRoot: string): { shortSha: string; fullSha: string } {
  const porcelain = captureSync('git', ['status', '--porcelain'], repoRoot);
  if (porcelain.length > 0) {
    throw new Error(
      `Working tree is not clean. Commit or stash all changes before deploying:\n${porcelain}`,
    );
  }
  const fullSha = captureSync('git', ['rev-parse', 'HEAD'], repoRoot);
  const shortSha = captureSync('git', ['rev-parse', '--short', 'HEAD'], repoRoot);
  return { shortSha, fullSha };
}

function packRuntimePlugins(repoRoot: string): string[] {
  const distDir = path.join(repoRoot, 'dist-tgz');
  fs.mkdirSync(distDir, { recursive: true });
  for (const entry of fs.readdirSync(distDir)) {
    if (entry.endsWith('.tgz')) {
      fs.rmSync(path.join(distDir, entry), { force: true });
    }
  }

  const tarballs: string[] = [];
  for (const pkgName of RUNTIME_PACKAGES) {
    const before = new Set(fs.readdirSync(distDir).filter((f) => f.endsWith('.tgz')));
    runSync('pnpm', ['--filter', pkgName, 'pack', '--pack-destination', distDir], repoRoot);
    const created = fs
      .readdirSync(distDir)
      .filter((f) => f.endsWith('.tgz') && !before.has(f))
      .sort();
    if (created.length !== 1) {
      throw new Error(`Expected 1 tarball for ${pkgName}, found ${created.length}`);
    }
    tarballs.push(path.join(distDir, created[0]));
  }
  return tarballs;
}

function buildRemoteInstallScript(
  config: DeployConfig,
  tarballNames: string[],
  rev: { shortSha: string; fullSha: string },
): string {
  const remoteTarballs = tarballNames.map((name) =>
    shellQuote(path.posix.join(config.remoteDir, name)),
  );
  const packageArgs = RUNTIME_PACKAGES.map((pkg) => shellQuote(pkg)).join(' ');
  const revLine = `${rev.shortSha} ${rev.fullSha} ${new Date().toISOString()}`;

  const steps: string[] = [
    'set -euo pipefail',
    'mkdir -p "$HOME/.dsh"',
    `dsh plugin --profile web remove ${packageArgs} >/dev/null 2>&1 || true`,
    `dsh plugin --profile web add ${remoteTarballs.join(' ')}`,
    `printf '%s\\n' ${shellQuote(revLine)} > "$HOME/.dsh/dsh-watcher.deployed-rev"`,
  ];

  if (config.service) {
    steps.push(`launchctl kickstart -k ${shellQuote(config.service)}`);
  }

  if (config.healthUrl) {
    steps.push('sleep 2');
    steps.push(`curl -fsS ${shellQuote(config.healthUrl)} >/dev/null`);
  }

  return steps.join(' && ');
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: node scripts/deploy-macmini.ts [--dry-run] [--help]',
      '',
      'Reads target host configuration from .env.deploy (see .env.deploy.example) or environment variables:',
      '  DSH_DEPLOY_HOST         SSH target (e.g. user@your-host)',
      '  DSH_DEPLOY_REMOTE_DIR   Remote directory for uploaded .tgz plugin tarballs',
      '  DSH_DEPLOY_SERVICE      Optional launchctl service target (e.g. gui/501/local.dsh-web)',
      '  DSH_DEPLOY_SSH_OPTS     Optional extra ssh/scp flags',
      '  DSH_DEPLOY_HEALTH_URL   Optional health check URL verified after restart',
      '',
    ].join('\n'),
  );
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }

  const dryRun = args.has('--dry-run');
  const repoRoot = process.cwd();
  const rev = ensureCleanGitTree(repoRoot);
  const config = loadDeployConfig(repoRoot);

  runSync('pnpm', ['run', 'check:comments'], repoRoot);
  runSync('pnpm', ['run', 'build'], repoRoot);
  runSync('pnpm', ['test'], repoRoot);

  const tarballs = packRuntimePlugins(repoRoot);
  const tarballNames = tarballs.map((t) => path.basename(t));
  const remoteScript = buildRemoteInstallScript(config, tarballNames, rev);

  if (dryRun) {
    process.stdout.write(
      `[dry-run] rev=${rev.shortSha} host=${config.host} remoteDir=${config.remoteDir} tarballs=${tarballNames.join(', ')}\n`,
    );
    return;
  }

  runSync(
    'ssh',
    [...config.sshOpts, config.host, `mkdir -p ${shellQuote(config.remoteDir)}`],
    repoRoot,
  );
  runSync(
    'scp',
    [...config.sshOpts, ...tarballs, `${config.host}:${config.remoteDir}/`],
    repoRoot,
  );
  runSync('ssh', [...config.sshOpts, config.host, remoteScript], repoRoot);

  process.stdout.write(`Deployed dsh-watcher ${rev.shortSha} to ${config.host}.\n`);
}

main();
