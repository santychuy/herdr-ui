#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, mkdir, link, unlink, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const exec = promisify(execFile);
const fail = message => { throw new Error(message); };

function argumentsFor(argv) {
    let home;
    let source;
    let mode;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--home' || arg === '--source') {
            const value = argv[++i];
            if (!value || !isAbsolute(value)) fail(`${arg} requires an absolute path.`);
            if (arg === '--home') {
                if (home) fail('Specify --home only once.');
                home = resolve(value);
            } else {
                if (mode) fail('Choose exactly one of --source, --paste, or --pick.');
                mode = 'source';
                source = value;
            }
        } else if (arg === '--paste' || arg === '--pick') {
            if (mode) fail('Choose exactly one of --source, --paste, or --pick.');
            mode = arg.slice(2);
        } else {
            fail(`Unknown argument: ${arg}`);
        }
    }
    if (!home || !mode) fail('Usage: node import.mjs --home /absolute/app-home (--source /absolute/image.png | --paste | --pick)');
    return {home, source, mode};
}

async function readSource(path) {
    const extension = extname(path).toLowerCase();
    if (extension !== '.svg' && extension !== '.png') fail('Choose a PNG or SVG file.');
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const info = await file.stat();
        if (!info.isFile()) fail('The selected image must be a regular file.');
        const limit = extension === '.svg' ? MAX_SVG_BYTES : MAX_BYTES;
        if (info.size < 1 || info.size > limit) fail(`The image must be nonempty and at most ${extension === '.svg' ? '1' : '8'} MiB.`);
        const bytes = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const result = await file.read(bytes, length, bytes.length - length, null);
            if (!result.bytesRead) break;
            length += result.bytesRead;
        }
        if (length !== info.size) fail('The image changed while it was being imported. Try again.');
        return {bytes: bytes.subarray(0, length), extension: extension.slice(1)};
    } finally {
        await file.close();
    }
}

async function nativeInput(mode) {
    if (process.platform !== 'darwin') fail('Clipboard import and the native file chooser require macOS. Use --source instead.');
    const helper = join(dirname(fileURLToPath(import.meta.url)), 'native.jxa');
    const {stdout} = await exec('/usr/bin/osascript', ['-l', 'JavaScript', helper, mode], {
        maxBuffer: MAX_BYTES * 2,
        timeout: mode === 'pick' ? 5 * 60 * 1000 : 30 * 1000,
    });
    let result;
    try { result = JSON.parse(stdout); } catch { fail('The native image helper returned an invalid response.'); }
    if (!result.ok) {
        const error = new Error(result.error || 'Image import failed.');
        error.cancelled = result.cancelled === true;
        throw error;
    }
    if (result.kind === 'file') return readSource(result.path);
    if (result.kind !== 'png' && result.kind !== 'svg') fail('The clipboard does not contain a supported image.');
    const bytes = result.text !== undefined ? Buffer.from(result.text, 'utf8') : Buffer.from(result.base64 || '', 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES) fail('Clipboard images must be nonempty and at most 8 MiB.');
    return {bytes, extension: result.kind};
}

const crcTable = Uint32Array.from({length: 256}, (_, n) => {
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
    return n >>> 0;
});
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes) {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('The file is not a PNG image.');
    let offset = 8;
    let header;
    let ended = false;
    let palette = false;
    let dataEnded = false;
    const compressed = [];
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > bytes.length) fail('The PNG is truncated.');
        const kind = bytes.toString('ascii', offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/.test(kind) || kind[2] !== kind[2].toUpperCase()) fail('The PNG contains an invalid chunk.');
        if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('The PNG checksum is invalid.');
        const data = bytes.subarray(offset + 8, end - 4);
        if (!header && kind !== 'IHDR') fail('The PNG header is missing.');
        if (kind === 'IHDR') {
            if (header || length !== 13) fail('The PNG header is invalid.');
            header = data;
        } else if (kind === 'PLTE') {
            if (palette || compressed.length || !length || length % 3 || length > 768) fail('The PNG palette is invalid.');
            palette = true;
        } else if (kind === 'IDAT') {
            if (dataEnded) fail('The PNG image chunks are out of order.');
            compressed.push(data);
        } else if (kind === 'IEND') {
            if (length || !compressed.length || end !== bytes.length) fail('The PNG ending is invalid.');
            ended = true;
            break;
        } else {
            if (compressed.length) dataEnded = true;
            if (kind[0] === kind[0].toUpperCase()) fail(`Unsupported PNG chunk: ${kind}.`);
            // Reject animation and bound compressed metadata, including embedded color profiles.
            if (['acTL', 'fcTL', 'fdAT'].includes(kind)) fail('Choose a still PNG rather than an animated PNG.');
            if (kind === 'iCCP' || kind === 'zTXt') {
                const zero = data.indexOf(0);
                if (zero < 1 || zero > 79 || data[zero + 1] !== 0) fail('The PNG metadata is invalid.');
                inflateSync(data.subarray(zero + 2), {maxOutputLength: MAX_SVG_BYTES});
            }
            if (kind === 'iTXt') {
                const zero = data.indexOf(0);
                if (zero < 1 || zero > 79 || data.length < zero + 5 || data[zero + 1] > 1 || data[zero + 2] !== 0) fail('The PNG text metadata is invalid.');
                const languageEnd = data.indexOf(0, zero + 3);
                const translatedEnd = data.indexOf(0, languageEnd + 1);
                if (languageEnd < 0 || translatedEnd < 0) fail('The PNG text metadata is invalid.');
                if (data[zero + 1] === 1) inflateSync(data.subarray(translatedEnd + 1), {maxOutputLength: MAX_SVG_BYTES});
            }
        }
        offset = end;
    }
    if (!header || !ended) fail('The PNG is incomplete.');
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const depth = header[8];
    const color = header[9];
    const allowedDepths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
    if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) fail('Images must be at most 8192 pixels per side and 16 megapixels.');
    if (!allowedDepths[color]?.includes(depth) || header[10] || header[11] || header[12] > 1) fail('The PNG encoding is invalid.');
    if (color === 3 && !palette) fail('The PNG palette is missing.');
    const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color];
    const passes = header[12] ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => {
        const w = Math.max(0, Math.ceil((width - x) / dx));
        const h = Math.max(0, Math.ceil((height - y) / dy));
        return {size: Math.ceil(w * channels * depth / 8) + 1, count: w ? h : 0};
    });
    const expected = rows.reduce((sum, row) => sum + row.size * row.count, 0);
    const pixels = inflateSync(Buffer.concat(compressed), {maxOutputLength: expected});
    if (pixels.length !== expected) fail('The PNG pixel data is incomplete.');
    let cursor = 0;
    for (const row of rows) {
        for (let i = 0; i < row.count; i++, cursor += row.size) {
            if (pixels[cursor] > 4) fail('The PNG contains an invalid pixel filter.');
        }
    }
}

const svgNodes = new Set('svg g defs path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask pattern filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence title desc text tspan textPath use symbol style'.split(' '));
const svgAttributes = new Set('id class style xmlns xmlns:xlink version viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits filter filterUnits primitiveUnits color color-interpolation color-interpolation-filters color-rendering shape-rendering text-rendering vector-effect paint-order display visibility overflow gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr patternUnits patternContentUnits patternTransform href xlink:href font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing dx dy rotate textLength lengthAdjust startOffset method spacing role aria-label aria-hidden focusable type values in in2 result mode operator k1 k2 k3 k4 stdDeviation edgeMode kernelMatrix order divisor bias targetX targetY preserveAlpha scale xChannelSelector yChannelSelector baseFrequency numOctaves seed stitchTiles surfaceScale diffuseConstant specularConstant specularExponent limitingConeAngle azimuth elevation pointsAtX pointsAtY pointsAtZ z amplitude exponent intercept slope tableValues flood-color flood-opacity lighting-color'.split(' '));
const cssProperties = new Set('fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color stop-color stop-opacity flood-color flood-opacity clip-path clip-rule mask filter font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing word-spacing display visibility paint-order vector-effect'.split(' '));

function decodeEntities(value) {
    return value.replace(/&([^;]*);|&/g, (whole, entity) => {
        const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
        if (Object.hasOwn(named, entity)) return named[entity];
        if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity || '')) fail('The SVG contains an unsupported XML entity.');
        const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (!(point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && point !== 0xfffe && point !== 0xffff)) fail('The SVG contains an invalid XML character.');
        return String.fromCodePoint(point);
    });
}

function safeValue(value) {
    if (/[\\\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f@]/.test(value) || /(?:javascript|data|https?|file):|expression\s*\(/i.test(value)) fail('SVG scripts and external resources are not allowed.');
    const remaining = value.replace(/url\(\s*(['"]?)#[A-Za-z_][\w.:-]*\1\s*\)/gi, '');
    if (/url\s*\(/i.test(remaining)) fail('SVG resource references must point to local #ids.');
}

function safeDeclarations(content) {
    for (const declaration of content.split(';')) {
        if (!declaration.trim()) continue;
        const colon = declaration.indexOf(':');
        if (colon < 1 || !cssProperties.has(declaration.slice(0, colon).trim().toLowerCase())) fail('The SVG contains unsupported CSS.');
        safeValue(declaration.slice(colon + 1));
    }
}

function validateSvg(bytes) {
    if (bytes.length > MAX_SVG_BYTES) fail('SVG images must be at most 1 MiB.');
    let source;
    try { source = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { fail('SVG images must use UTF-8 encoding.'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) fail('The SVG contains invalid XML characters.');
    const declaration = /^\s*<\?xml\s+([^?]*)\?>/.exec(source.replace(/^\uFEFF/, ''));
    const encoding = declaration && /\bencoding\s*=\s*(['"])([^'"]+)\1/i.exec(declaration[1]);
    if (encoding && encoding[2].toLowerCase() !== 'utf-8') fail('SVG images must declare UTF-8 encoding.');
    source = source.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s+[^?]*\?>/, '');
    const stack = [];
    let root = false;
    let count = 0;
    let cursor = 0;
    let match;
    const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>|[^<]+/gy;
    while ((match = tokens.exec(source))) {
        if (match.index !== cursor) fail('The SVG is not well-formed XML.');
        cursor = tokens.lastIndex;
        const token = match[0];
        if (token.startsWith('<!--')) {
            if (token.slice(4, -3).includes('--')) fail('The SVG contains an invalid comment.');
            continue;
        }
        if (!token.startsWith('<') || token.startsWith('<![CDATA[')) {
            if (!token.startsWith('<![CDATA[') && token.includes(']]>')) fail('The SVG contains invalid XML text.');
            const text = token.startsWith('<![CDATA[') ? token.slice(9, -3) : decodeEntities(token);
            if (!stack.length && text.trim()) fail('The SVG has content outside its root.');
            if (stack.at(-1) === 'style') {
                const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
                if (/[\\@<>]/.test(css)) fail('The SVG contains unsafe CSS.');
                let end = 0;
                const rules = /([^{}]+)\{([^{}]*)\}/g;
                let rule;
                while ((rule = rules.exec(css))) {
                    if (css.slice(end, rule.index).trim() || !/^[\w\s.#,:>+~*\[\]="'|^-]+$/.test(rule[1])) fail('The SVG contains unsupported CSS rules.');
                    safeDeclarations(rule[2]);
                    end = rules.lastIndex;
                }
                if (css.slice(end).trim()) fail('The SVG contains invalid CSS.');
            }
            continue;
        }
        if (token.startsWith('</')) {
            const close = /^<\/([A-Za-z][\w.-]*)\s*>$/.exec(token);
            if (!close || stack.pop() !== close[1]) fail('The SVG has mismatched closing tags.');
            continue;
        }
        const start = /^<([A-Za-z][\w.-]*)([\s\S]*?)(\/?)>$/.exec(token);
        if (!start || !svgNodes.has(start[1])) fail('The SVG contains unsupported or active content. Scripts, images, and external resources are not allowed.');
        const name = start[1];
        if (!stack.length) {
            if (root || name !== 'svg') fail('The image must have exactly one SVG root.');
            root = true;
        }
        if (++count > 10000 || stack.length > 64) fail('The SVG is too complex (maximum 10,000 elements and 64 levels).');
        const attributes = start[2];
        const attr = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy;
        const names = new Set();
        let position = 0;
        let item;
        while ((item = attr.exec(attributes))) {
            position = attr.lastIndex;
            const key = item[1];
            const value = decodeEntities(item[2] ?? item[3]);
            if (names.has(key) || !svgAttributes.has(key)) fail(`Unsupported SVG attribute: ${key}.`);
            names.add(key);
            if (key === 'xmlns') {
                if (value !== 'http://www.w3.org/2000/svg') fail('The SVG namespace is invalid.');
            } else if (key === 'xmlns:xlink') {
                if (value !== 'http://www.w3.org/1999/xlink') fail('The SVG link namespace is invalid.');
            } else {
                safeValue(value);
                if ((key === 'href' || key === 'xlink:href') && !/^#[A-Za-z_][\w.:-]*$/.test(value)) fail('SVG links must reference a local #id.');
                if (key === 'style') safeDeclarations(value);
                if (key === 'width' || key === 'height') {
                    const dimension = /^([0-9]+(?:\.[0-9]+)?)(px)?$/.exec(value.trim());
                    if (dimension && Number(dimension[1]) > 8192) fail('SVG dimensions must be at most 8192 pixels.');
                }
            }
        }
        if (attributes.slice(position).trim()) fail('The SVG has malformed attributes.');
        if (!start[3]) stack.push(name);
    }
    if (cursor !== source.length || stack.length || !root) fail('The SVG is incomplete or malformed.');
}

async function store(home, bytes, extension) {
    const resolvedHome = await realpath(home);
    const directory = join(resolvedHome, 'data', 'project-icons');
    await mkdir(directory, {recursive: true});
    const actualDirectory = await realpath(directory);
    const fromHome = relative(resolvedHome, actualDirectory);
    if (fromHome.startsWith(`..${sep}`) || fromHome === '..' || isAbsolute(fromHome)) fail('The icon data directory must be inside the app home.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const filename = `${hash}.${extension}`;
    const target = join(actualDirectory, filename);
    const temporary = join(actualDirectory, `.import-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o444);
    try {
        await file.writeFile(bytes);
        await file.close();
        try {
            await link(temporary, target);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const info = await existing.stat();
                if (!info.isFile() || info.size !== bytes.length) fail('An existing icon asset is invalid.');
                const content = await existing.readFile();
                if (!content.equals(bytes)) fail('An existing icon asset does not match its content hash.');
            } finally { await existing.close(); }
        }
    } finally {
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
    }
    return `data/project-icons/${filename}`;
}

try {
    const {home, source, mode} = argumentsFor(process.argv.slice(2));
    const {bytes, extension} = mode === 'source' ? await readSource(source) : await nativeInput(mode);
    if (extension === 'png') validatePng(bytes);
    else validateSvg(bytes);
    const path = await store(home, bytes, extension);
    process.stdout.write(`${JSON.stringify({ok: true, path})}\n`);
} catch (error) {
    const result = {ok: false, error: error.message || String(error)};
    if (error.cancelled) result.cancelled = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = error.cancelled ? 0 : 1;
}
