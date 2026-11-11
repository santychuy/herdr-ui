#!/usr/bin/env node
// Local-only Mermaid rendering. The worker bounds synchronous parser/layout work.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_HOME = path.resolve(path.dirname(SCRIPT), '../..');
const SOURCE_LIMIT = 50_000;
const OUTPUT_LIMIT = 4_000_000;
const RENDER_TIMEOUT = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const execute = promisify(execFile);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function errorResult(error) {
  return { ok: false, error: {
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'render_failed',
    message: String(error?.message ?? error).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 1600),
  } };
}

// Split CSS declarations/fallbacks without breaking nested functions or quoted values.
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function declarations(style) {
  return splitTopLevel(style, ';').flatMap(part => {
    const colon = part.indexOf(':');
    return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
  });
}

function resolveVariables(value, variables, active = new Set(), depth = 0) {
  if (depth > 40) fail('svg_theme', 'CSS variable nesting exceeds the safe limit.');
  let result = '', start = 0;
  for (;;) {
    const index = value.indexOf('var(', start);
    if (index < 0) return result + value.slice(start);
    result += value.slice(start, index);
    let end = index + 4, nesting = 1, quote = '';
    for (; end < value.length; end++) {
      const c = value[end];
      if (quote) {
        if (c === '\\') end++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '(') nesting++;
      else if (c === ')' && --nesting === 0) break;
    }
    if (nesting !== 0) fail('svg_theme', 'Unbalanced CSS variable in rendered SVG.');
    const args = splitTopLevel(value.slice(index + 4, end), ',');
    const name = args.shift().trim();
    if (!/^--[\w-]+$/.test(name)) fail('svg_theme', 'Invalid CSS variable in rendered SVG.');
    const definition = variables.get(name);
    let replacement;
    if (definition !== undefined && !active.has(name)) {
      const next = new Set(active);
      next.add(name);
      replacement = resolveVariables(definition, variables, next, depth + 1);
    } else if (args.length) {
      replacement = resolveVariables(args.join(','), variables, active, depth + 1);
    } else fail('svg_theme', `Cannot resolve SVG color or style variable ${name}.`);
    result += replacement;
    start = end + 1;
  }
}

const DEFAULT_COLORS = {
  background: '#ffffff', foreground: '#1f1f1f', muted: '#6e6e6e',
  surface: '#f3f3f3', raised: '#e6e6e6', border: '#8a8a8a', accent: '#5b7bd5',
  ansi1: '#e45756', ansi2: '#54a24b', ansi3: '#eeca3b',
  ansi4: '#4c78a8', ansi5: '#b279a2', ansi6: '#72b7b2',
};

function themeVariables(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) fail('invalid_theme', 'Theme must be a JSON object of color strings.');
  const colors = {};
  for (const [key, fallback] of Object.entries(DEFAULT_COLORS)) {
    const value = theme[key] ?? fallback;
    // Native themes use hex; concrete rgb/hsl colors are accepted without arbitrary CSS.
    if (typeof value !== 'string' || !/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|hsl)a?\([\d\s.,%+\/-]+\))$/i.test(value)) {
      fail('invalid_theme', `Theme color ${key} must be a concrete hex, rgb or hsl color.`);
    }
    colors[key] = value;
  }
  const mappings = {
    bg: colors.background, fg: colors.foreground, muted: colors.muted,
    line: colors.foreground, surface: colors.surface, 'surface-alt': colors.raised,
    border: colors.border, accent: colors.accent, critical: colors.ansi1, error: colors.ansi1,
    'fg-on-light': '#1f1f1f', 'fg-on-dark': '#ffffff',
    font: 'sans-serif', 'font-mono': 'monospace', radius: '4px',
    'title-weight': 'bold', 'heading-weight': 'bold', 'bold-weight': 'bold',
  };
  const series = [colors.ansi4, colors.accent, colors.ansi2, colors.ansi1,
    colors.ansi6, colors.ansi3, colors.ansi5, colors.muted];
  series.forEach((value, i) => { mappings[`series-${i + 1}`] = value; });
  return new Map(Object.entries(mappings).map(([name, value]) => [`--pele-${name}`, value]));
}

const PRESENTATION = new Set(('fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit opacity color font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing word-spacing direction visibility display rx ry').split(' '));
const CSS_ATTRIBUTES = new Set([...PRESENTATION, 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity']);

function concreteSVG(svg, theme) {
  const variables = themeVariables(theme);
  const root = svg.match(/^<svg\b[^>]*>/)?.[0];
  if (!root) fail('invalid_svg', 'Pele did not return an SVG document.');
  const rootStyle = root.match(/\bstyle="([^"]*)"/)?.[1] ?? '';
  for (const [name, value] of declarations(rootStyle)) {
    if (name.startsWith('--')) variables.set(name, value);
  }
  // Pele produces XML with double-quoted attributes and escapes all source text.
  // Resolve only CSS attributes: literal variable syntax in labels/metadata is text.
  const output = svg.replace(/<[A-Za-z][^>]*>/g, tag => {
    const name = tag.match(/^<([\w:-]+)/)[1];
    if (/^(?:script|style|image|foreignObject|a|iframe)$/i.test(name)) {
      fail('unsafe_svg', `Unexpected ${name} element in local-only SVG.`);
    }
    const attrs = new Map([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    for (const [key, value] of attrs) {
      if (/^on/i.test(key)) fail('unsafe_svg', 'Event handlers are not permitted in SVG.');
      const resolved = key === 'style'
        ? declarations(value).filter(([property]) => !property.startsWith('--'))
          .map(([property, val]) => `${property}:${resolveVariables(val, variables)}`).join(';')
        : CSS_ATTRIBUTES.has(key) ? resolveVariables(value, variables) : value;
      if (/(?:^|:)href$/i.test(key) && !resolved.startsWith('#')) fail('unsafe_svg', 'External SVG references are disabled.');
      for (const match of (CSS_ATTRIBUTES.has(key) || key === 'style' ? resolved : '').matchAll(/url\(([^)]*)\)/gi)) {
        if (!match[1].trim().replace(/^["']|["']$/g, '').startsWith('#')) {
          fail('unsafe_svg', 'External SVG resources are disabled.');
        }
      }
      attrs.set(key, resolved);
    }
    // Presentation attributes work in native SVG readers without CSS custom properties
    // or the browser's font shorthand parser. Explicit diagram styles still win.
    const remaining = [];
    for (const [property, value] of declarations(attrs.get('style') ?? '')) {
      if (PRESENTATION.has(property)) attrs.set(property, value);
      else if (property !== 'font' || name !== 'svg') remaining.push(`${property}:${value}`);
    }
    if (name === 'svg') {
      attrs.set('font-size', '16');
      if (!attrs.has('font-family')) attrs.set('font-family', 'sans-serif');
    }
    if (remaining.length) attrs.set('style', remaining.join(';'));
    else attrs.delete('style');
    return `<${name}${[...attrs].map(([key, value]) => ` ${key}="${value}"`).join('')}${tag.endsWith('/>') ? '/' : ''}>`;
  });
  if (output.length > OUTPUT_LIMIT) fail('output_limit', 'Rendered SVG exceeds the 4,000,000 character limit.');
  return output;
}

async function workerRender({ source, width, theme }) {
  const { render } = await import('./vendor/pele.mjs');
  const result = render(source, {
    maxWidth: width, autoDirection: true, responsive: false, padding: 16,
    fontFamily: 'sans-serif', fontFamilyMono: 'monospace', fontSize: 16,
    links: false, images: false, linkSchemes: [], imageSchemes: [],
    limit: SOURCE_LIMIT, outputLimit: OUTPUT_LIMIT, maxEdges: 5000,
  });
  if (![result.width, result.height].every(value => Number.isFinite(value) && value > 0)) {
    fail('invalid_dimensions', 'Pele returned nonpositive or nonfinite dimensions.');
  }
  return { type: result.type, width: result.width, height: result.height, svg: concreteSVG(result.svg, theme) };
}

function renderBounded(source, width, theme) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { source, width, theme }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Diagram rendering exceeded 15 seconds.'), { code: 'render_timeout' })), RENDER_TIMEOUT);
    worker.once('message', message => {
      if (message.ok) finish(null, message.result);
      else finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!settled) finish(Object.assign(new Error(`Render worker exited without a result (status ${code}).`), { code: 'render_worker' }));
    });
  });
}

async function readLimited(file, byteLimit) {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('invalid_file', 'Expected a regular file.');
    if (info.size > byteLimit) fail('file_limit', `File exceeds the ${byteLimit} byte limit.`);
    const buffer = Buffer.alloc(byteLimit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > byteLimit) fail('file_limit', `File exceeds the ${byteLimit} byte limit.`);
    return buffer.toString('utf8', 0, used);
  } finally { await handle.close(); }
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

function revisionPaths(revision) {
  if (typeof revision !== 'string' || !UUID.test(revision)) fail('invalid_revision', 'Revision must be a published UUID.');
  const directory = `data/diagrams/${revision}`;
  return { directory, source: `${directory}/source.mmd`, svg: `${directory}/diagram.svg`, manifest: `${directory}/manifest.json` };
}

function validateManifest(manifest, expectedRevision) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('invalid_state', 'Diagram manifest must be an object.');
  const paths = revisionPaths(manifest.revision);
  if (manifest.version !== 1 || (expectedRevision && manifest.revision !== expectedRevision)
      || typeof manifest.title !== 'string' || manifest.title.length > 200
      || typeof manifest.type !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(manifest.type)
      || ![manifest.width, manifest.height].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || manifest.source !== paths.source || manifest.svg !== paths.svg) {
    fail('invalid_state', 'Diagram manifest has invalid fields or noncanonical file paths.');
  }
  return { version: 1, revision: manifest.revision, title: manifest.title, type: manifest.type,
    width: manifest.width, height: manifest.height, svg: paths.svg, source: paths.source };
}

async function readManifest(file, expectedRevision) {
  let value;
  try { value = JSON.parse(await readLimited(file, 8192)); }
  catch (error) {
    if (error.code === 'ENOENT') throw error;
    fail('invalid_state', `Cannot read diagram manifest: ${error.message}`);
  }
  return validateManifest(value, expectedRevision);
}

async function currentManifest(home) {
  let manifest;
  try { manifest = await readManifest(path.join(home, 'data/diagrams/current.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const stored = await readManifest(path.join(home, revisionPaths(manifest.revision).manifest), manifest.revision);
  if (JSON.stringify(stored) !== JSON.stringify(manifest)) fail('invalid_state', 'Current diagram does not match its immutable revision.');
  for (const relative of [manifest.source, manifest.svg]) {
    if (!(await fs.lstat(path.join(home, relative))).isFile()) fail('invalid_state', 'Published diagram files must be regular files.');
  }
  return manifest;
}

function parseArguments(args) {
  const action = args.shift();
  const allowed = {
    init: new Set(['home']), clear: new Set(['home']), publish: new Set(['home', 'file', 'title', 'no-show']),
    view: new Set(['home', 'revision', 'width', 'theme']),
  }[action];
  if (!allowed) fail('usage', 'Usage: render.mjs init | clear | publish --file /absolute/diagram.mmd [--title Title] [--no-show] | view --revision UUID --width NUMBER --theme JSON [--home APPHOME]');
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2)) || Object.hasOwn(options, flag.slice(2))) fail('usage', `Unknown or repeated argument: ${flag}`);
    const key = flag.slice(2);
    if (key === 'no-show') options[key] = true;
    else {
      if (!args.length || args[0].startsWith('--')) fail('usage', `Missing value for ${flag}.`);
      options[key] = args.shift();
    }
  }
  const home = options.home === undefined ? DEFAULT_HOME : options.home;
  if (!path.isAbsolute(home)) fail('usage', '--home must be an absolute app home path.');
  return { action, options, home: path.resolve(home) };
}

async function showPanel(home) {
  try {
    for (const [command, args] of [
      ['layout.select', { stack: 'panel-body', child: 'diagrams' }],
      ['layout.show', { id: 'panel' }], ['diagrams.reload', {}],
    ]) {
      await execute('herdr-app', ['do', command, JSON.stringify(args)], {
        env: { ...process.env, HERDR_APP_HOME: home }, timeout: 2500, maxBuffer: 64 * 1024,
      });
    }
    return { shown: true };
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    return { shown: false, showError: `Diagram saved; could not open the Herdr panel: ${String(detail).slice(0, 1000)}` };
  }
}

async function main() {
  const { action, options, home } = parseArguments(process.argv.slice(2));
  const directory = path.join(home, 'data/diagrams');
  await fs.mkdir(directory, { recursive: true });
  if (action === 'init') return { ok: true, current: await currentManifest(home) };
  if (action === 'clear') {
    if (!(await fs.lstat(directory)).isDirectory()) fail('invalid_state', 'Diagram storage must be a real directory, not a symbolic link.');
    // Keep the watched directory itself; unlink children without following symlinks.
    await fs.rm(path.join(directory, 'current.json'), { recursive: true, force: true });
    for (const name of await fs.readdir(directory)) {
      await fs.rm(path.join(directory, name), { recursive: true, force: true });
    }
    return { ok: true };
  }
  if (action === 'publish') {
    if (!options.file || !path.isAbsolute(options.file)) fail('usage', '--file must name one absolute Mermaid source file.');
    const title = options.title ?? path.basename(options.file, path.extname(options.file));
    if (!title.trim() || title.length > 200) fail('usage', 'Title must contain 1–200 characters.');
    const source = await readLimited(options.file, SOURCE_LIMIT * 4);
    if (!source.trim()) fail('empty_source', 'The Mermaid source file is empty.');
    if (source.length > SOURCE_LIMIT) fail('source_limit', 'Mermaid source exceeds the 50,000 character limit.');
    const rendered = await renderBounded(source, 960, {});
    const revision = randomUUID();
    const paths = revisionPaths(revision);
    const manifest = validateManifest({ version: 1, revision, title, type: rendered.type,
      width: rendered.width, height: rendered.height, svg: paths.svg, source: paths.source });
    const target = path.join(home, paths.directory);
    await fs.mkdir(target);
    // Publish the pointer last: render/IO failures never replace the previous diagram.
    await fs.writeFile(path.join(home, paths.source), source, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(home, paths.svg), rendered.svg, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(home, paths.manifest), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    await atomicWrite(path.join(directory, 'current.json'), JSON.stringify(manifest));
    return { ok: true, ...manifest, ...(options['no-show'] ? { shown: false } : await showPanel(home)) };
  }
  const paths = revisionPaths(options.revision);
  const width = Number(options.width);
  if (!Number.isFinite(width) || width < 1 || width > 100_000) fail('usage', '--width must be a finite number between 1 and 100000 logical pixels.');
  let theme;
  try { theme = JSON.parse(options.theme); }
  catch { fail('invalid_theme', '--theme must be a JSON color object.'); }
  themeVariables(theme);
  const manifest = await readManifest(path.join(home, paths.manifest), options.revision);
  const sourceFile = path.join(home, paths.source);
  if (!(await fs.lstat(sourceFile)).isFile()) fail('invalid_state', 'Revision source must be a regular file.');
  const source = await readLimited(sourceFile, SOURCE_LIMIT * 4);
  if (source.length > SOURCE_LIMIT) fail('source_limit', 'Mermaid source exceeds the 50,000 character limit.');
  const rendered = await renderBounded(source, width, theme);
  if (rendered.type !== manifest.type) fail('invalid_state', 'Revision diagram type no longer matches its manifest.');
  // Include concrete output, width and theme in the filename: native image caches
  // cannot confuse an old size/theme with this view, even across renderer upgrades.
  const hash = createHash('sha256').update(JSON.stringify({ width, theme })).update(rendered.svg).digest('hex').slice(0, 24);
  const svg = `${paths.directory}/view-${hash}.svg`;
  await atomicWrite(path.join(home, svg), rendered.svg);
  return { ok: true, ...manifest, width: rendered.width, height: rendered.height, svg };
}

if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, result: await workerRender(workerData) }); }
  catch (error) { parentPort.postMessage(errorResult(error)); }
} else {
  try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = 1;
  }
}
