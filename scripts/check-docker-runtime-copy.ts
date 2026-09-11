import { readFileSync, existsSync } from 'node:fs';
import { dirname, normalize, relative, resolve } from 'node:path';

const repoRoot = process.cwd();
const entrypoint = 'server.ts';
const dockerfilePath = 'Dockerfile';

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function relativeTsImports(source: string): string[] {
  const imports = new Set<string>();
  const text = stripCommentsAndStrings(source);
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) imports.add(match[1]);
  }
  return [...imports];
}

function toTsPath(fromFile: string, specifier: string): string | null {
  const base = resolve(repoRoot, dirname(fromFile), specifier);
  const candidates = specifier.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts')]
    : specifier.endsWith('.ts')
      ? [base]
      : [`${base}.ts`, resolve(base, 'index.ts')];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const rel = normalize(relative(repoRoot, candidate)).replace(/\\/g, '/');
    if (!rel.startsWith('..')) return rel;
  }
  return null;
}

function walk(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];

  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of relativeTsImports(read(file))) {
      const resolved = toTsPath(file, specifier);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

function runtimeCopyFiles(dockerfile: string): Set<string> {
  const files = new Set<string>();
  const stage3 = dockerfile.split(/\nFROM\s+node:20-slim\s+AS\s+runtime\b/i)[1] ?? dockerfile;
  const logicalLines = stage3
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of logicalLines) {
    if (!line.startsWith('COPY ')) continue;
    if (line.includes('--from=')) continue;
    const withoutComment = line.replace(/\s+#.*$/, '');
    const parts = withoutComment.split(/\s+/).slice(1);
    if (parts[parts.length - 1] !== './') continue;
    for (const part of parts.slice(0, -1)) {
      if (part.startsWith('--')) continue;
      if (part.endsWith('.ts')) files.add(part);
    }
  }
  return files;
}

const reachable = walk(entrypoint);
const copied = runtimeCopyFiles(read(dockerfilePath));
const missing = [...reachable].filter((file) => !copied.has(file)).sort();

if (missing.length) {
  console.error('Docker runtime COPY list is missing TypeScript files reached from server.ts:');
  for (const file of missing) console.error(`  - ${file}`);
  console.error('These files exist in the repo during CI, but will be absent from the runtime image.');
  console.error("The deployed service can then fail at startup with ERR_MODULE_NOT_FOUND.");
  process.exit(1);
}

console.log(`Docker runtime COPY covers ${reachable.size} TypeScript files reached from ${entrypoint}.`);
