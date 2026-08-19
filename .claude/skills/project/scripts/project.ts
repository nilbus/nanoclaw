import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateMount } from '../../../../src/modules/mount-security/index.ts';

type AllowlistRoot = {
  path: string;
  allowReadWrite: boolean;
  description?: string;
};

type Allowlist = {
  allowedRoots: AllowlistRoot[];
  blockedPatterns: string[];
  [key: string]: unknown;
};

type Options = {
  directory: string;
  instructions: string | null;
  instructionsProvided: boolean;
  dryRun: boolean;
};

type AgentGroupRow = {
  id: string;
  name: string;
  folder: string;
};

type ContainerConfigRow = {
  additional_mounts: string;
};

type Mount = {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const nanoClawRoot = path.resolve(scriptDir, '../../../..');
const dbPath = path.join(nanoClawRoot, 'data', 'v2.db');
const mountAllowlistPath = path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
const phoebeLocalPath = path.join(nanoClawRoot, 'groups', 'phoebe', 'CLAUDE.local.md');

function fail(message: string): never {
  throw new Error(message);
}

function printUsage(): void {
  console.error(
    [
      'Usage: project.ts --dir <host-directory> [--instructions <text> | --instructions-file <file>] [--dry-run]',
      '',
      "The absence of an instructions flag clears Phoebe's existing project instructions.",
    ].join('\n'),
  );
}

function parseOptions(argv: string[]): Options {
  let directory: string | undefined;
  let instructions: string | null = null;
  let instructionsProvided = false;
  let instructionsFile: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--dir' || arg === '--directory') {
      directory = argv[++i];
      if (!directory) fail(`${arg} requires a value`);
      continue;
    }
    if (arg === '--instructions') {
      if (instructionsFile !== undefined) fail('Use only one of --instructions and --instructions-file');
      instructions = argv[++i];
      if (instructions === undefined) fail('--instructions requires a value');
      instructionsProvided = true;
      continue;
    }
    if (arg === '--instructions-file') {
      if (instructionsProvided) fail('Use only one of --instructions and --instructions-file');
      instructionsFile = argv[++i];
      if (!instructionsFile) fail('--instructions-file requires a value');
      instructionsProvided = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!directory) fail('--dir is required');
  if (instructionsFile !== undefined) {
    instructions = fs.readFileSync(resolveHostPath(instructionsFile), 'utf8');
  }

  return { directory, instructions, instructionsProvided, dryRun };
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveHostPath(input: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(nanoClawRoot, expanded);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readAllowlist(): { value: Allowlist; original: string | null } {
  if (!fs.existsSync(mountAllowlistPath)) {
    return {
      value: { allowedRoots: [], blockedPatterns: [] },
      original: null,
    };
  }

  const original = fs.readFileSync(mountAllowlistPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    fail(`Cannot parse ${mountAllowlistPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') fail(`${mountAllowlistPath} must contain a JSON object`);

  const value = parsed as Partial<Allowlist>;
  if (!Array.isArray(value.allowedRoots)) fail(`${mountAllowlistPath}.allowedRoots must be an array`);
  if (!Array.isArray(value.blockedPatterns)) fail(`${mountAllowlistPath}.blockedPatterns must be an array`);

  return { value: value as Allowlist, original };
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function restoreAllowlist(original: string | null): void {
  if (original === null) {
    fs.rmSync(mountAllowlistPath, { force: true });
  } else {
    writeAtomic(mountAllowlistPath, original);
  }
}

function ensureAllowedProjectDirectory(realDirectory: string, allowlist: Allowlist): boolean {
  const matchingRoot = allowlist.allowedRoots.find((root) => {
    const rootPath = resolveHostPath(root.path);
    return fs.existsSync(rootPath) && isPathInside(fs.realpathSync(rootPath), realDirectory);
  });

  if (matchingRoot) {
    if (!matchingRoot.allowReadWrite) {
      fail(`Project directory is under read-only allowlist root "${matchingRoot.path}"`);
    }
    return false;
  }

  allowlist.allowedRoots.push({
    path: realDirectory,
    allowReadWrite: true,
    description: 'Phoebe project workspace',
  });
  return true;
}

function readCurrentProjectContainerPath(): string | null {
  if (!fs.existsSync(phoebeLocalPath)) return null;
  const content = fs.readFileSync(phoebeLocalPath, 'utf8');
  const match = content.match(/\/workspace\/extra\/([A-Za-z0-9._-]+)/);
  return match?.[1] ?? null;
}

function updateProjectMounts(mounts: Mount[]): Mount[] {
  const currentContainerPath = readCurrentProjectContainerPath();
  const currentProjectMount =
    mounts.find((mount) => mount.containerPath === 'project') ??
    (currentContainerPath ? mounts.find((mount) => mount.containerPath === currentContainerPath) : undefined) ??
    (mounts.length === 1 ? mounts[0] : undefined);

  return [
    ...mounts.filter((mount) => mount !== currentProjectMount && mount.containerPath !== 'project'),
    { hostPath: '', containerPath: 'project', readonly: false },
  ];
}

function getPhoebe(db: Database.Database): AgentGroupRow {
  const row = db
    .prepare(
      `SELECT id, name, folder
       FROM agent_groups
       WHERE lower(name) = 'phoebe' OR lower(folder) = 'phoebe'
       ORDER BY CASE WHEN lower(folder) = 'phoebe' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get() as AgentGroupRow | undefined;
  if (!row) fail('No Phoebe agent group exists in data/v2.db');
  return row;
}

function restartPhoebe(agentGroupId: string): { attempted: boolean; succeeded: boolean; output: string } {
  const ncl = path.join(nanoClawRoot, 'bin', 'ncl');
  if (!fs.existsSync(ncl)) {
    return { attempted: false, succeeded: false, output: 'bin/ncl not found' };
  }

  const result = spawnSync(ncl, ['groups', 'restart', '--id', agentGroupId], {
    cwd: nanoClawRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return {
    attempted: true,
    succeeded: result.status === 0,
    output,
  };
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const requestedDirectory = resolveHostPath(options.directory);
  const rootDirectory = path.parse(requestedDirectory).root;
  const homeDirectory = path.resolve(os.homedir());
  if (requestedDirectory === rootDirectory || requestedDirectory === homeDirectory) {
    fail("Refusing to use the filesystem root or the home directory as Phoebe's project");
  }

  const createdDirectory = !fs.existsSync(requestedDirectory);
  if (createdDirectory && !options.dryRun) {
    fs.mkdirSync(requestedDirectory, { recursive: true });
  }
  if (!options.dryRun && !fs.statSync(requestedDirectory).isDirectory()) {
    fail(`Project path is not a directory: ${requestedDirectory}`);
  }

  const realDirectory = options.dryRun ? path.resolve(requestedDirectory) : fs.realpathSync(requestedDirectory);
  const { value: allowlist, original: originalAllowlist } = readAllowlist();
  const allowlistChanged = ensureAllowedProjectDirectory(realDirectory, allowlist);

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          directory: realDirectory,
          createdDirectory,
          instructions: options.instructionsProvided ? 'replace' : 'clear',
          allowlistChanged,
          containerPath: '/workspace/extra/project',
        },
        null,
        2,
      ),
    );
    return;
  }

  let allowlistWritten = false;
  try {
    if (allowlistChanged) {
      writeAtomic(mountAllowlistPath, JSON.stringify(allowlist, null, 2) + '\n');
      allowlistWritten = true;
    }

    const validation = validateMount({ hostPath: realDirectory, containerPath: 'project', readonly: false });
    if (!validation.allowed || validation.effectiveReadonly !== false) {
      fail(`Project directory cannot be mounted read-write: ${validation.reason}`);
    }

    const db = new Database(dbPath);
    try {
      const group = getPhoebe(db);
      const config = db
        .prepare('SELECT additional_mounts FROM container_configs WHERE agent_group_id = ?')
        .get(group.id) as ContainerConfigRow | undefined;
      if (!config) fail(`No container config exists for Phoebe (${group.id})`);

      const mounts = JSON.parse(config.additional_mounts) as Mount[];
      const nextMounts = updateProjectMounts(mounts).map((mount) =>
        mount.containerPath === 'project' ? { ...mount, hostPath: realDirectory } : mount,
      );

      const update = db.prepare(
        `UPDATE container_configs
         SET additional_mounts = ?, updated_at = ?
         WHERE agent_group_id = ?`,
      );
      const now = new Date().toISOString();
      db.transaction(() => {
        update.run(JSON.stringify(nextMounts), now, group.id);
      })();

      writeAtomic(
        phoebeLocalPath,
        options.instructionsProvided && options.instructions ? `${options.instructions}\n` : '',
      );

      const restart = restartPhoebe(group.id);
      console.log(
        JSON.stringify(
          {
            groupId: group.id,
            group: group.name,
            directory: realDirectory,
            createdDirectory,
            instructions: options.instructionsProvided ? 'replaced' : 'cleared',
            containerPath: '/workspace/extra/project',
            allowlistChanged,
            restart,
          },
          null,
          2,
        ),
      );
      if (!restart.succeeded) process.exitCode = 2;
    } finally {
      db.close();
    }
  } catch (error) {
    if (allowlistWritten) restoreAllowlist(originalAllowlist);
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(`project: ${error instanceof Error ? error.message : String(error)}`);
  printUsage();
  process.exitCode = 1;
}
