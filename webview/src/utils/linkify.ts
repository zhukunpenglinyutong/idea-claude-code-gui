import type { LinkifyCapabilities } from './linkifyCapabilities';

export type LinkifyType = 'file' | 'class' | 'url';

export interface FileLinkTarget {
  path: string;
  lineStart: number;
  lineEnd?: number;
}

export interface LinkifyMatch {
  type: LinkifyType;
  value: string;
  start: number;
  end: number;
}

interface Detector {
  type: LinkifyType;
  priority: number;
  matcher: RegExp;
  enabled?: (capabilities: LinkifyCapabilities) => boolean;
  validate?: (text: string, match: LinkifyMatch) => boolean;
}

interface RankedMatch extends LinkifyMatch {
  priority: number;
}

const URL_REGEX = /https?:\/\/[^\s<>()]+[^\s<>().,!?;:'")\]]/g;
const WINDOWS_ABSOLUTE_PATH_REGEX = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s]+\\)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?!:\d)/g;
const POSIX_ABSOLUTE_PATH_REGEX = /\/(?:[^/\s]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?!:\d)/g;
const EXPLICIT_RELATIVE_PATH_REGEX = /(?:\.\/|(?:\.\.\/)+)(?:[^/\s]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?!:\d)/g;
const PROJECT_RELATIVE_PATH_REGEX = /(?:[A-Za-z0-9_-]+\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?!:\d)/g;
const FILE_WITH_LINE_REGEX = /(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n\s]+\\)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+|\/(?:[^/\s]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+|(?:\.\/|(?:\.\.\/)+)(?:[^/\s]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+|(?:[A-Za-z0-9_-]+\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+):\d+(?:-\d+)?(?!:\d)/g;
const JAVA_FQCN_REGEX = /[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*\.[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*/g;
const FILE_LINE_INFO_REGEX = /^(.*):(\d+)(?:-(\d+))?$/;
const HTTP_LINK_REGEX = /^(https?:|mailto:)/i;
const JAVA_FQCN_CANDIDATE_REGEX = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*\.[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*$/;

// Standalone filename regex: matches single filenames with common source file extensions
// Must have at least one char before extension, and extension must be 2+ chars
const STANDALONE_FILENAME_REGEX = /[A-Za-z0-9._-]+\.[A-Za-z]{2,}(?!:\d)/g;

// Common source file extensions - used to validate standalone filenames
const SOURCE_FILE_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  // JVM
  'java', 'kt', 'kts', 'scala', 'groovy', 'clj', 'cljs', 'cljc',
  // Python
  'py', 'pyw', 'pyi',
  // Go / Rust / C / C++
  'go', 'rs', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
  // C# / VB / F#
  'cs', 'vb', 'fs', 'fsx',
  // Styles
  'css', 'less', 'scss', 'sass',
  // Data / Config
  'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf', 'config',
  'properties', 'cfg', 'rc', 'prefs',
  // Documentation
  'md', 'markdown', 'rst', 'txt', 'adoc', 'tex', 'latex', 'rtf',
  // SQL
  'sql', 'ddl', 'dml',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Build
  'dockerfile', 'makefile', 'cmake', 'gradle', 'maven', 'mk',
  // Web / Templates
  'html', 'htm', 'jsp', 'jspx', 'vue', 'svelte', 'astro',
  'hbs', 'ejs', 'pug', 'njk', 'twig', 'blade',
  'php', 'phtml', 'asp', 'aspx',
  'erb',
  // API / Schema
  'graphql', 'gql', 'proto', 'thrift', 'avsc',
  // Lock / Module
  'lock', 'mod', 'sum',
  // Misc
  'log', 'env', 'gitignore', 'dockerignore', 'editorconfig',
  // Ruby
  'rb', 'gemspec', 'rake',
  // Perl / R
  'pl', 'pm', 'r', 'R',
  // Lua / Swift / Dart / Zig / Nim
  'lua', 'swift', 'm', 'mm', 'dart', 'zig', 'nim',
  // Haskell / Erlang / Elixir
  'hs', 'erl', 'hrl', 'ex', 'exs',
  // Assembly / Misc languages
  'asm', 's', 'sol', 'tf', 'hcl',
  // Template / Resource
  'ftl', 'vm', 'mustache',
  // Data interchange
  'csv', 'tsv', 'svg',
]);

// Validate standalone filename matches before linking them as file references.
// Uses a multi-layered defense to avoid false positives on domain names,
// package segments, and version strings:
//  1. Source file extension whitelist (SOURCE_FILE_EXTENSIONS)
//  2. Lowercase-only names check against common config filenames (commonLowercaseNames)
//  3. Separator detection (_, -, .) for multi-word lowercase filenames
//  4. Length threshold for single-word lowercase names (>10 chars rejected)
function isSourceFileName(value: string): boolean {
  if (!value || value.length < 3) {
    return false;
  }

  // Extract extension first
  const lastDot = value.lastIndexOf('.');
  if (lastDot < 1 || lastDot >= value.length - 1) {
    return false;
  }

  const namePart = value.slice(0, lastDot);
  const extension = value.slice(lastDot + 1).toLowerCase();

  // Must be a known source file extension
  if (!SOURCE_FILE_EXTENSIONS.has(extension)) {
    return false;
  }

  // Additional check for lowercase-only names:
  // If name starts with lowercase and has no uppercase, be more cautious
  // to avoid matching domain names or package segments like "example.com"
  const firstChar = namePart[0];
  if (firstChar >= 'a' && firstChar <= 'z' && !/[A-Z]/.test(namePart)) {
    // Allow only if the name looks like a real filename:
    // - Has underscores, dots, or hyphens (common in filenames)
    // - Is a well-known lowercase file name
    const lowerName = namePart.toLowerCase();
    const commonLowercaseNames = ['readme', 'changelog', 'license', 'contributing',
      'todo', 'notes', 'makefile', 'dockerfile', 'vagrantfile', 'gemfile',
      'rakefile', 'procfile', 'bower', 'package', 'tsconfig', 'webpack',
      'rollup', 'vite', 'eslint', 'prettier', 'stylelint', 'babel',
      'jest', 'karma', 'mocha', 'nyc', 'istanbul', 'svgo', 'postcss'];

    // If name contains typical filename separators, it's likely a filename
    if (namePart.includes('_') || namePart.includes('-') || namePart.includes('.')) {
      return true;
    }

    // If it's a common lowercase config/utility file name, allow it
    if (commonLowercaseNames.some((n) => lowerName.startsWith(n) || lowerName.endsWith(n))) {
      return true;
    }

    // Single lowercase word like "linkify" is acceptable for source files
    // but reject things that look like package names (multiple dots in name part)
    if (namePart.includes('.')) {
      return false;
    }

    // Reject if it looks like a domain (no separators, just lowercase word)
    // But allow short names (< 10 chars) as they're more likely to be filenames
    if (namePart.length > 10 && /^[a-z]+$/.test(namePart)) {
      return false;
    }
  }

  return true;
}

const HTML_ESCAPE_LOOKUP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const GENERIC_LEADING_BOUNDARY_CHARS = /[\s([\]{}<>"'`=,:;!?]/;
const GENERIC_TRAILING_BOUNDARY_CHARS = /[\s)\]}>"'`.,:;!?]/;

function createGlobalRegex(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_LOOKUP[char] ?? char);
}

function hasLeadingBoundary(text: string, start: number, boundaryChars: RegExp): boolean {
  if (start <= 0) {
    return true;
  }
  return boundaryChars.test(text[start - 1]);
}

function hasTrailingBoundary(text: string, end: number, boundaryChars: RegExp): boolean {
  if (end >= text.length) {
    return true;
  }
  return boundaryChars.test(text[end]);
}

function isValidFileBoundary(text: string, match: LinkifyMatch): boolean {
  if (!hasLeadingBoundary(text, match.start, GENERIC_LEADING_BOUNDARY_CHARS)) {
    return false;
  }

  if (match.end < text.length && text[match.end] === ':') {
    return false;
  }

  return hasTrailingBoundary(text, match.end, GENERIC_TRAILING_BOUNDARY_CHARS);
}

function isValidClassBoundary(text: string, match: LinkifyMatch): boolean {
  if (!hasLeadingBoundary(text, match.start, GENERIC_LEADING_BOUNDARY_CHARS)) {
    return false;
  }

  const nextChar = match.end < text.length ? text[match.end] : '';
  if (!nextChar) {
    return true;
  }

  if (/[A-Za-z0-9_]/.test(nextChar)) {
    return false;
  }

  return nextChar !== '.' && nextChar !== '#' && nextChar !== '(';
}

function isValidUrlBoundary(text: string, match: LinkifyMatch): boolean {
  return hasLeadingBoundary(text, match.start, GENERIC_LEADING_BOUNDARY_CHARS);
}

const DETECTORS: Detector[] = [
  {
    type: 'file',
    priority: 1,
    matcher: createGlobalRegex(FILE_WITH_LINE_REGEX),
    validate: (text, match) => parseFileLinkTarget(match.value) !== null && isValidFileBoundary(text, match),
  },
  {
    type: 'file',
    priority: 2,
    matcher: createGlobalRegex(WINDOWS_ABSOLUTE_PATH_REGEX),
    validate: isValidFileBoundary,
  },
  {
    type: 'file',
    priority: 3,
    matcher: createGlobalRegex(POSIX_ABSOLUTE_PATH_REGEX),
    validate: isValidFileBoundary,
  },
  {
    type: 'file',
    priority: 4,
    matcher: createGlobalRegex(EXPLICIT_RELATIVE_PATH_REGEX),
    validate: isValidFileBoundary,
  },
  {
    type: 'file',
    priority: 5,
    matcher: createGlobalRegex(PROJECT_RELATIVE_PATH_REGEX),
    validate: isValidFileBoundary,
  },
  {
    type: 'class',
    priority: 6,
    matcher: createGlobalRegex(JAVA_FQCN_REGEX),
    enabled: (capabilities) => capabilities.classNavigationEnabled,
    validate: (text, match) => isJavaFqcnCandidate(match.value) && isValidClassBoundary(text, match),
  },
  {
    type: 'url',
    priority: 7,
    matcher: createGlobalRegex(URL_REGEX),
    validate: isValidUrlBoundary,
  },
  {
    // Standalone filename detector - lowest priority, only matches if nothing else matched
    type: 'file',
    priority: 8,
    matcher: createGlobalRegex(STANDALONE_FILENAME_REGEX),
    validate: (text, match) => isSourceFileName(match.value) && isValidFileBoundary(text, match),
  },
];

const DETECTORS_WITH_URLS: ReadonlyArray<Detector> = Object.freeze(DETECTORS);
const DETECTORS_NO_URLS: ReadonlyArray<Detector> = Object.freeze(
  DETECTORS.filter((detector) => detector.type !== 'url'),
);

function getDetectors(includeUrls: boolean): ReadonlyArray<Detector> {
  return includeUrls ? DETECTORS_WITH_URLS : DETECTORS_NO_URLS;
}

function createLinkElement(document: Document, match: LinkifyMatch): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', match.value);
  anchor.setAttribute('data-linkify', match.type);
  anchor.classList.add(`${match.type}-link`);
  anchor.textContent = match.value;
  return anchor;
}

function buildAnchorHtml(match: LinkifyMatch): string {
  const escapedValue = escapeHtml(match.value);
  return `<a class="${match.type}-link" data-linkify="${match.type}" href="${escapedValue}">${escapedValue}</a>`;
}

function findNextMatch(
  text: string,
  startIndex: number,
  capabilities: LinkifyCapabilities,
  includeUrls: boolean,
): LinkifyMatch | null {
  let bestMatch: RankedMatch | undefined;

  for (const detector of getDetectors(includeUrls)) {
    if (detector.enabled && !detector.enabled(capabilities)) {
      continue;
    }

    const regex = detector.matcher;
    regex.lastIndex = startIndex;

    let candidate: RegExpExecArray | null = regex.exec(text);
    while (candidate) {
      const value = candidate[0];
      const match: RankedMatch = {
        type: detector.type,
        value,
        start: candidate.index,
        end: candidate.index + value.length,
        priority: detector.priority,
      };

      const isValid = detector.validate ? detector.validate(text, match) : true;
      if (isValid) {
        if (
          !bestMatch
          || match.start < bestMatch.start
          || (match.start === bestMatch.start && match.priority < bestMatch.priority)
        ) {
          bestMatch = match;
        }
        break;
      }

      if (regex.lastIndex <= candidate.index) {
        regex.lastIndex = candidate.index + 1;
      }
      candidate = regex.exec(text);
    }

    regex.lastIndex = 0;
  }

  if (bestMatch === undefined) {
    return null;
  }

  const { type, value, start, end } = bestMatch;
  return {
    type,
    value,
    start,
    end,
  };
}

function collectLinkifyMatches(
  text: string,
  capabilities: LinkifyCapabilities,
  includeUrls: boolean,
): LinkifyMatch[] {
  const matches: LinkifyMatch[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const nextMatch = findNextMatch(text, cursor, capabilities, includeUrls);
    if (!nextMatch) {
      break;
    }

    matches.push(nextMatch);
    cursor = nextMatch.end;
  }

  return matches;
}

function replaceTextNodeWithLinks(
  textNode: Text,
  matches: LinkifyMatch[],
): void {
  const document = textNode.ownerDocument;
  if (!document) {
    return;
  }

  const text = textNode.nodeValue ?? '';
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  matches.forEach((match) => {
    if (match.start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
    }
    fragment.appendChild(createLinkElement(document, match));
    cursor = match.end;
  });

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }

  textNode.parentNode?.replaceChild(fragment, textNode);
}

function shouldSkipTextNode(textNode: Text): boolean {
  const parentElement = textNode.parentElement;
  if (!parentElement) {
    return true;
  }

  // Skip anchors (already linked), code fences (pre blocks), and KaTeX output.
  // Note: <code> is NOT skipped - inline code content should be linkified
  return parentElement.closest('a, pre, .katex') !== null;
}

const FILE_URI_SCHEME_REGEX = /^file:/i;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

/**
 * Percent-decode an href, repeating to collapse double-encoding such as
 * `%2520` -> `%20` -> ` `. Decoding eagerly is also a safety measure: it
 * surfaces encoded control characters (e.g. `%09`) so the downstream
 * `isValidOpenFileTarget` control-char guard in bridge.ts can reject them.
 * Trade-off: a real filename containing a literal `%20` would be over-decoded,
 * which is exceedingly rare for navigation targets.
 */
function decodeHrefRepeatedly(value: string, maxPasses = 3): string {
  let current = value;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    try {
      const decoded = decodeURIComponent(current.replace(/\+/g, ' '));
      if (decoded === current) {
        break;
      }
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let pathname = decodeHrefRepeatedly(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    const withoutScheme = uri.replace(/^file:\/\//i, '');
    if (/^[A-Za-z]:\//.test(withoutScheme)) {
      return decodeHrefRepeatedly(withoutScheme);
    }
    const posixish = withoutScheme.startsWith('/') ? withoutScheme : `/${withoutScheme}`;
    return decodeHrefRepeatedly(posixish);
  }
}

/**
 * Normalize markdown/file hrefs into a filesystem path suitable for open_file.
 * Handles percent-encoding, repeated encoding, and file:// URIs.
 */
export function normalizeFileNavigationTarget(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (FILE_URI_SCHEME_REGEX.test(trimmed)) {
    return fileUriToPath(trimmed);
  }

  return decodeHrefRepeatedly(trimmed);
}

export function isMarkdownFileNavigationHref(href: string): boolean {
  const normalized = normalizeFileNavigationTarget(href);
  if (!normalized) {
    return false;
  }

  if (FILE_URI_SCHEME_REGEX.test(href.trim())) {
    return true;
  }

  if (WINDOWS_DRIVE_PATH_REGEX.test(normalized)) {
    return true;
  }

  if (normalized.startsWith('./') || normalized.startsWith('../') || normalized.startsWith('/')) {
    return true;
  }

  return /\.[A-Za-z0-9._-]+$/.test(normalized);
}

export function parseFileLinkTarget(value: string): FileLinkTarget | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const match = FILE_LINE_INFO_REGEX.exec(trimmedValue);
  if (!match) {
    return null;
  }

  const [, path, lineStartRaw, lineEndRaw] = match;
  if (/:\d+$/.test(path)) {
    return null;
  }

  const lineStart = Number.parseInt(lineStartRaw, 10);
  const lineEnd = lineEndRaw ? Number.parseInt(lineEndRaw, 10) : undefined;

  if (!Number.isInteger(lineStart) || lineStart <= 0) {
    return null;
  }

  if (lineEnd !== undefined && (!Number.isInteger(lineEnd) || lineEnd < lineStart)) {
    return null;
  }

  return {
    path,
    lineStart,
    lineEnd,
  };
}

export function isJavaFqcnCandidate(value: string): boolean {
  if (!value) {
    return false;
  }

  if (!JAVA_FQCN_CANDIDATE_REGEX.test(value)) {
    return false;
  }

  return !value.includes('#') && !value.includes('(');
}

export function decorateExistingAnchors(root: Element): void {
  root.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) {
      return;
    }

    if (HTTP_LINK_REGEX.test(href)) {
      anchor.classList.add('url-link');
      anchor.setAttribute('data-linkify', 'url');
      return;
    }

    if (isMarkdownFileNavigationHref(href)) {
      anchor.classList.add('file-link');
      anchor.setAttribute('data-linkify', 'file');
    }
  });
}

export function linkifyHtml(root: Element, capabilities: LinkifyCapabilities): void {
  const document = root.ownerDocument;
  if (!document) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let currentNode = walker.nextNode();

  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  textNodes.forEach((textNode) => {
    if (shouldSkipTextNode(textNode)) {
      return;
    }

    const text = textNode.nodeValue ?? '';
    if (!text.trim()) {
      return;
    }

    const matches = collectLinkifyMatches(text, capabilities, false);
    if (matches.length === 0) {
      return;
    }

    replaceTextNodeWithLinks(textNode, matches);
  });
}

export function linkifyPlainTextSegment(
  text: string,
  capabilities: LinkifyCapabilities,
): string {
  if (!text) {
    return '';
  }

  const matches = collectLinkifyMatches(text, capabilities, true);
  if (matches.length === 0) {
    return escapeHtml(text);
  }

  let html = '';
  let cursor = 0;

  matches.forEach((match) => {
    if (match.start > cursor) {
      html += escapeHtml(text.slice(cursor, match.start));
    }
    html += buildAnchorHtml(match);
    cursor = match.end;
  });

  if (cursor < text.length) {
    html += escapeHtml(text.slice(cursor));
  }

  return html;
}
