import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { memo, useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import katex from 'katex';
import markedKatex from 'marked-katex-extension';
import { openBrowser, openClass, openFile } from '../utils/bridge';
import {
  captureRangeOffsets,
  restoreRangeOffsets,
  type TextSelectionOffsets,
} from '../utils/selectionOffsets';
import { useMarkdownFileLinkTooltip } from '../hooks/useMarkdownFileLinkTooltip';
import {
  decorateExistingAnchors,
  linkifyHtml,
  linkifyPlainTextSegment,
} from '../utils/linkify';
import {
  getLinkifyCapabilities,
  subscribeLinkifyCapabilities,
  type LinkifyCapabilities,
} from '../utils/linkifyCapabilities';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.css';
import { markedHighlight } from 'marked-highlight';

const SAFE_HREF_PROTOCOL_REGEX = /^(?:https?|mailto):/i;
const FILE_URI_SCHEME_REGEX = /^file:/i;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
let hrefSanitizerHookInstalled = false;
const LATEX_CODE_LANGUAGES = new Set(['latex', 'tex', 'math']);

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) {
      return true;
    }
  }
  return false;
}

function isAllowedHrefValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  // Reject hrefs containing C0 control characters (Tab/LF/CR/etc.). They can
  // split the scheme checks below, yet a browser strips those characters from
  // the URL and then executes the underlying scheme (e.g. `java<Tab>script:`
  // resolves to `javascript:`). See MarkdownBlock.test.tsx regression guard.
  if (containsControlCharacter(trimmed)) {
    return false;
  }

  if (WINDOWS_DRIVE_PATH_REGEX.test(trimmed)) {
    return true;
  }

  if (FILE_URI_SCHEME_REGEX.test(trimmed)) {
    return true;
  }

  if (!URI_SCHEME_REGEX.test(trimmed)) {
    return true;
  }

  return SAFE_HREF_PROTOCOL_REGEX.test(trimmed);
}

function ensureSafeHrefSanitizerHook(): void {
  if (hrefSanitizerHookInstalled) {
    return;
  }

  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'href' || typeof data.attrValue !== 'string') {
      return;
    }

    if (isAllowedHrefValue(data.attrValue)) {
      data.forceKeepAttr = true;
      return;
    }

    data.keepAttr = false;
  });

  hrefSanitizerHookInstalled = true;
}

ensureSafeHrefSanitizerHook();

const MARKDOWN_LINK_SANITIZE_OPTIONS = {
  ALLOW_UNKNOWN_PROTOCOLS: true,
} as const;

const highlightLanguages: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ['bash', bash],
  ['css', css],
  ['diff', diff],
  ['dockerfile', dockerfile],
  ['go', go],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['markdown', markdown],
  ['plaintext', plaintext],
  ['python', python],
  ['rust', rust],
  ['shell', shell],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
];

highlightLanguages.forEach(([name, language]) => {
  hljs.registerLanguage(name, language);
});

hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['html', 'xhtml', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

// Lazy-loaded mermaid singleton (deferred until first diagram is encountered)
let mermaidInstance: typeof import('mermaid').default | null = null;
async function getMermaid() {
  if (!mermaidInstance) {
    const mod = await import('mermaid');
    mermaidInstance = mod.default;
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
  }
  return mermaidInstance;
}

// Configure marked to use syntax highlighting
marked.use(
  markedKatex({
    throwOnError: false,
  }),
  markedHighlight({
    highlight(code: string, lang: string) {
      // Skip syntax highlighting for mermaid code blocks
      if (lang === 'mermaid') {
        return code;
      }
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          // Silently fall through to auto-highlight
        }
      }
      return hljs.highlightAuto(code).value;
    },
  })
);

// Mermaid syntax keywords used to detect diagram content (Set for O(1) lookup)
const MERMAID_KEYWORDS = new Set([
  'flowchart',
  'graph',
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantchart',
  'requirementdiagram',
  'gitgraph',
  'mindmap',
  'timeline',
  'zenuml',
  'sankey',
  'xychart',
  'xychart-beta',
  'block-beta',
]);

const MERMAID_FENCE_REGEX = /```mermaid[\s\S]*?```/i;

// Pre-compiled regex: matches any mermaid keyword at the start of a line
const MERMAID_KEYWORD_REGEX = new RegExp(
  `(^|\\n)\\s*(?:${[...MERMAID_KEYWORDS].join('|')})\\b`,
  'i',
);

function hasPossibleMermaidContent(content: string): boolean {
  if (!content) return false;
  return MERMAID_FENCE_REGEX.test(content) || MERMAID_KEYWORD_REGEX.test(content);
}

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: unknown;
  isStreaming?: boolean;
}

function safeStringifyContent(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeStringifyContent(item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (typeof record.content === 'string') {
      return record.content;
    }
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Stream-safe processing: handle unclosed code blocks and other markdown structures.
 * During streaming, code blocks may be truncated, causing markdown parsing errors.
 * This function detects and temporarily closes incomplete code blocks.
 */
function makeStreamSafe(content: string): string {
  if (!content) return content;

  let result = content;

  // Handle code blocks: detect unclosed fenced code blocks (```)
  // Track code block state using a state machine approach
  const lines = result.split('\n');
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    // Detect code block opening or closing
    if (trimmedLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }

  // If still inside a code block, append a closing fence
  if (inCodeBlock) {
    result = result + '\n```';
  }

  // Handle inline code: detect unclosed inline code (`)
  // Only process the last line to avoid affecting multiline structures
  const lastNewlineIndex = result.lastIndexOf('\n');
  const lastLine = lastNewlineIndex >= 0 ? result.slice(lastNewlineIndex + 1) : result;

  // Count single backticks in the last line (excluding double and triple backticks)
  const singleBacktickMatches = lastLine.match(/(?<!`)`(?!`)/g);
  if (singleBacktickMatches && singleBacktickMatches.length % 2 !== 0) {
    result = result + '`';
  }

  return result;
}

/**
 * Strip system-internal XML tags injected by Claude Code's prompt protocol.
 * Mirrors `stripPromptXMLTags` from the CLI source (src/utils/messages.ts).
 */
const SYSTEM_XML_TAGS_RE =
  /<(commit_analysis|context|function_analysis|pr_analysis)>[\s\S]*?<\/\1>\n?/g;

function stripSystemTags(content: string): string {
  const result = content.replace(SYSTEM_XML_TAGS_RE, '');
  return result !== content ? result.trim() : result;
}

/**
 * Escape XML/HTML-like tags in prose text so they are rendered as literal text
 * rather than being parsed as DOM elements by the browser.
 * Matches opening <tag>, closing </tag>, self-closing <tag/>, and <!-- comments -->.
 * Does NOT touch content inside code fences (caller responsibility).
 */
const XML_TAG_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;

function escapeXmlTags(text: string): string {
  return text.replace(XML_TAG_RE, (match) =>
    match.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
}

/**
 * Strip system XML tags and escape remaining XML tags only in prose segments
 * (outside fenced code blocks and inline code). Preserves code content as-is
 * so marked can handle XML tags inside code naturally (auto-escape).
 */
const CODE_FENCE_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /(`[^`\n]+`)/g;
const BOLD_SYNTAX_RE = /(\*\*[^*]+\*\*)/g;
const DISPLAY_MATH_DELIMITER_LINE_RE = /^([ \t]*)\$\$\s*$/;
const BRACKET_MATH_DELIMITER_RE = /(?<!\\)(\\\[|\\\]|\\\(|\\\))/g;
const BRACKET_MATH_DELIMITER_MAP: Record<string, string> = {
  '\\[': '$$',
  '\\]': '$$',
  '\\(': '$',
  '\\)': '$',
};

/**
 * Normalize bracket-style math delimiters (\[...\] and \(...\)) — which many
 * models emit instead of dollar delimiters — into the $$...$$ / $...$ forms
 * that marked-katex-extension understands. Only prose segments are rewritten;
 * fenced code blocks and inline code keep their literal backslash delimiters.
 */
function normalizeBracketMathDelimiters(content: string): string {
  return content
    .split(CODE_FENCE_RE)
    .map((fencePart, fenceIdx) => {
      if (fenceIdx % 2 === 1) return fencePart;

      return fencePart
        .split(INLINE_CODE_RE)
        .map((inlinePart, inlineIdx) => {
          if (inlineIdx % 2 === 1) return inlinePart;
          return inlinePart.replace(
            BRACKET_MATH_DELIMITER_RE,
            (match) => BRACKET_MATH_DELIMITER_MAP[match],
          );
        })
        .join('');
    })
    .join('');
}

function normalizeIndentedDisplayMath(content: string): string {
  return content
    .split(CODE_FENCE_RE)
    .map((part, partIndex) => {
      if (partIndex % 2 === 1) return part;

      const lines = part.split('\n');
      let mathIndent = '';
      let inDisplayMath = false;

      return lines
        .map((line) => {
          const delimiterMatch = DISPLAY_MATH_DELIMITER_LINE_RE.exec(line);
          if (delimiterMatch) {
            if (!inDisplayMath) {
              mathIndent = delimiterMatch[1];
              inDisplayMath = true;
            } else {
              inDisplayMath = false;
            }
            return '$$';
          }

          if (inDisplayMath && mathIndent && line.startsWith(mathIndent)) {
            return line.slice(mathIndent.length);
          }

          return line;
        })
        .join('\n');
    })
    .join('');
}

function stripAndEscapeOutsideCodeBlocks(content: string): string {
  // First split by fenced code blocks
  const fenceParts = content.split(CODE_FENCE_RE);

  return fenceParts
    .map((fencePart, fenceIdx) => {
      // Odd indices are code fence matches — leave untouched
      if (fenceIdx % 2 === 1) return fencePart;

      // Then split by inline code within prose segments
      const inlineParts = fencePart.split(INLINE_CODE_RE);
      return inlineParts
        .map((inlinePart, inlineIdx) => {
          // Odd indices are inline code matches — leave untouched for marked to handle
          if (inlineIdx % 2 === 1) return inlinePart;
          return escapeXmlTags(stripSystemTags(inlinePart));
        })
        .join('');
    })
    .join('');
}

/**
 * Lightweight renderer for streaming content.
 * Provides basic formatting (code fences, line breaks, inline code, bold)
 * without the heavy marked.parse() + DOMPurify + DOMParser pipeline.
 * Full markdown parsing is deferred to when streaming ends.
 */
/** Sanitize code language identifier — only allow safe characters for HTML class attribute. */
function safeLang(lang: string): string {
  return lang.replace(/[^a-zA-Z0-9_.-]/g, '');
}

function isLatexCodeLanguage(language: string | null): boolean {
  return language !== null && LATEX_CODE_LANGUAGES.has(language.toLowerCase());
}

function unwrapLatexCodeBlockSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  const displayBlockMatch = trimmed.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
  if (displayBlockMatch) {
    return (displayBlockMatch[1] ?? '').trim();
  }

  const bracketBlockMatch = trimmed.match(/^\\\[\s*([\s\S]*?)\s*\\\]$/);
  if (bracketBlockMatch) {
    return (bracketBlockMatch[1] ?? '').trim();
  }

  const inlineParenMatch = trimmed.match(/^\\\(\s*([\s\S]*?)\s*\\\)$/);
  if (inlineParenMatch) {
    return (inlineParenMatch[1] ?? '').trim();
  }

  return trimmed;
}

function renderLatexPreviewHtml(source: string): string | null {
  const latex = unwrapLatexCodeBlockSource(source);
  if (!latex) {
    return null;
  }

  try {
    const rendered = katex.renderToString(latex, {
      displayMode: true,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    return rendered.includes('katex-error') ? null : rendered;
  } catch {
    return null;
  }
}

function renderStreamingInlineText(
  text: string,
  capabilities: LinkifyCapabilities,
  handleInlineCode: boolean = true,
): string {
  if (handleInlineCode) {
    return text
      .split(INLINE_CODE_RE)
      .map((inlinePart) => {
        const inlineCodeMatch = /^`([^`\n]+)`$/.exec(inlinePart);
        if (inlineCodeMatch) {
          // Inline code content should also be linkified
          const linkifiedCode = linkifyPlainTextSegment(inlineCodeMatch[1], capabilities);
          return `<code>${linkifiedCode}</code>`;
        }

        return inlinePart
          .split(BOLD_SYNTAX_RE)
          .map((part) => {
            const boldMatch = /^\*\*([^*]+)\*\*$/.exec(part);
            if (boldMatch) {
              return `<strong>${linkifyPlainTextSegment(boldMatch[1], capabilities)}</strong>`;
            }

            return linkifyPlainTextSegment(part, capabilities);
          })
          .join('');
      })
      .join('');
  }

  // When inline code is already handled upstream, just process bold and linkify
  return text
    .split(BOLD_SYNTAX_RE)
    .map((part) => {
      const boldMatch = /^\*\*([^*]+)\*\*$/.exec(part);
      if (boldMatch) {
        return `<strong>${linkifyPlainTextSegment(boldMatch[1], capabilities)}</strong>`;
      }

      return linkifyPlainTextSegment(part, capabilities);
    })
    .join('');
}

function renderStreamingProseSegment(
  segment: string,
  capabilities: LinkifyCapabilities,
): string {
  // First strip system-internal XML tags from the prose segment
  const cleaned = stripSystemTags(segment);

  // Split by inline code to avoid double-escaping
  // linkifyPlainTextSegment already handles HTML escaping for inline code content
  const inlineParts = cleaned.split(INLINE_CODE_RE);

  const processedParts = inlineParts.map((part, idx) => {
    // Odd indices are inline code — pass to linkifyPlainTextSegment which escapes HTML
    if (idx % 2 === 1) {
      const inlineContent = part.slice(1, -1); // Remove surrounding backticks
      return `<code>${linkifyPlainTextSegment(inlineContent, capabilities)}</code>`;
    }
    // Even indices are prose — escape XML tags then render inline formatting
    return renderStreamingInlineText(escapeXmlTags(part), capabilities, false);
  });

  // Now wrap in paragraph/heading structure based on paragraph breaks
  const combined = processedParts.join('');
  return combined
    .split(/\n{2,}/)
    .filter((block) => block.length > 0)
    .map((block) => {
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(block);
      if (headingMatch && !block.includes('\n')) {
        const level = headingMatch[1].length;
        return `<h${level}>${headingMatch[2]}</h${level}>`;
      }

      // Match marked's `breaks: false` (MarkdownBlock line ~220): a single
      // newline inside a paragraph flows as whitespace, NOT a <br>. The full
      // pipeline collapses single newlines this way, so emitting <br> here
      // made the streaming HTML taller than the final HTML - and since the
      // thinking block flips between these renderers on every sub-turn (each
      // tool call ends and restarts the stream), that height gap surfaced as
      // a visible collapse-then-reexpand plus a scroll jump. Keeping the two
      // renderers height-aligned lets the renderer switch happen invisibly.
      return `<p>${block}</p>`;
    })
    .join('');
}

function renderStreamingContent(
  content: string,
  capabilities: LinkifyCapabilities,
): string {
  if (!content) return '';

  const safeContent = makeStreamSafe(content);

  // Split by code fence blocks, keeping delimiters
  const segments: string[] = [];
  let current = '';
  let inCode = false;
  let codeLang = '';

  for (const line of safeContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (!inCode) {
        // Flush prose before code block
        if (current) segments.push(current);
        current = '';
        inCode = true;
        codeLang = safeLang(trimmed.slice(3).trim());
      } else {
        // End code block — emit as <pre><code>
        const escaped = current
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        segments.push(
          `<pre><code${codeLang ? ` class="language-${codeLang}"` : ''}>${escaped}</code></pre>`
        );
        current = '';
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    current += (current ? '\n' : '') + line;
  }

  // Handle remaining content
  if (current) {
    if (inCode) {
      const escaped = current
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      segments.push(
        `<pre><code${codeLang ? ` class="language-${codeLang}"` : ''}>${escaped}</code></pre>`
      );
    } else {
      segments.push(current);
    }
  }

  // Process prose segments (non-code)
  const raw = segments
    .map((seg) => {
      // Already wrapped in <pre> — pass through
      if (seg.startsWith('<pre>')) return seg;

      // renderStreamingProseSegment handles stripSystemTags + escapeXmlTags internally,
      // and preserves inline code content for natural HTML escaping
      return renderStreamingProseSegment(seg, capabilities);
    })
    .join('');

  // Sanitize the assembled HTML to prevent XSS even during streaming
  return DOMPurify.sanitize(raw, {
    ...MARKDOWN_LINK_SANITIZE_OPTIONS,
    ALLOWED_TAGS: ['a', 'p', 'br', 'pre', 'code', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    ALLOWED_ATTR: ['class', 'href', 'data-linkify'],
  });
}

// Mermaid render counter for generating unique IDs
let mermaidIdCounter = 0;

// Copy icon SVG (hoisted to module scope to avoid recreation on each render)
const copyIconSvg = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fill-opacity="0.9"/>
      <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fill-opacity="0.6"/>
    </svg>
  `;

const MarkdownBlock = ({ content = '', isStreaming = false }: MarkdownBlockProps) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [linkifyCapabilities, setLinkifyCapabilities] = useState<LinkifyCapabilities>(() =>
    getLinkifyCapabilities(),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();
  const normalizedContent = useMemo(() => safeStringifyContent(content), [content]);

  // Track previous isStreaming state to detect when streaming ends
  const prevIsStreamingRef = useRef(isStreaming);

  // Ref for tracking retry count
  const mermaidRetryRef = useRef(0);
  const MERMAID_MAX_RETRIES = 3;

  const fileLinkTooltip = useMarkdownFileLinkTooltip();

  useEffect(() => {
    return subscribeLinkifyCapabilities(setLinkifyCapabilities);
  }, []);

  // Render mermaid diagrams
  const renderMermaidDiagrams = useCallback(async () => {
    if (!containerRef.current) return;

    const codeBlocks = containerRef.current.querySelectorAll('pre code');

    // If no code blocks found, reset retry count
    if (codeBlocks.length === 0) {
      mermaidRetryRef.current = 0;
      return;
    }

    let renderedAny = false;

    for (const codeBlock of codeBlocks) {
      const pre = codeBlock.parentElement;
      if (!pre) continue;

      const wrapper = pre.parentElement;
      if (wrapper?.classList.contains('mermaid-rendered')) continue;

      // Get the text content of the code block
      let code = codeBlock.textContent || '';

      // Clean up any remaining markdown markers (e.g., ```mermaid)
      code = code.replace(/^```mermaid\s*/i, '').replace(/```\s*$/, '').trim();

      if (!code) continue;

      // Check if the content is mermaid syntax (starts with a keyword)
      const firstWord = code.split(/[\s\n]/)[0].toLowerCase();
      const isMermaid = MERMAID_KEYWORDS.has(firstWord);

      if (!isMermaid) continue;

      // Show loading placeholder while mermaid library loads
      const loadingEl = document.createElement('div');
      loadingEl.className = 'mermaid-loading';
      loadingEl.textContent = 'Loading diagram\u2026';
      loadingEl.style.cssText = 'padding:12px;color:var(--text-secondary,#888);';
      if (wrapper?.classList.contains('code-block-wrapper')) {
        wrapper.insertBefore(loadingEl, pre);
      } else {
        pre.parentNode?.insertBefore(loadingEl, pre);
      }

      try {
        const mmd = await getMermaid();
        const id = `mermaid-${++mermaidIdCounter}`;
        const { svg } = await mmd.render(id, code);

        const mermaidContainer = document.createElement('div');
        mermaidContainer.className = 'mermaid-diagram';
        mermaidContainer.innerHTML = svg;

        // Remove loading placeholder
        loadingEl.remove();

        if (wrapper?.classList.contains('code-block-wrapper')) {
          wrapper.classList.add('mermaid-rendered');
          pre.style.display = 'none';
          wrapper.insertBefore(mermaidContainer, pre);
        } else {
          const newWrapper = document.createElement('div');
          newWrapper.className = 'code-block-wrapper mermaid-rendered';
          newWrapper.appendChild(mermaidContainer);
          pre.parentNode?.replaceChild(newWrapper, pre);
        }
        renderedAny = true;
      } catch {
        // Mermaid render error - remove loading indicator and silently skip
        loadingEl.remove();
      }
    }

    // If any diagrams were rendered, reset retry count
    if (renderedAny) {
      mermaidRetryRef.current = 0;
    }

    return renderedAny;
  }, []);

  // Render mermaid diagrams after HTML updates (skip during streaming to prevent flicker)
  useEffect(() => {
    if (isStreaming) return;
    if (!hasPossibleMermaidContent(normalizedContent)) {
      mermaidRetryRef.current = 0;
      return;
    }

    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let retryRafId: number | null = null;

    // Use double requestAnimationFrame to ensure the DOM is fully rendered
    let rafId1 = requestAnimationFrame(() => {
      rafId1 = requestAnimationFrame(() => {
        renderMermaidDiagrams().then((rendered) => {
          // If no diagrams were rendered and retry limit not reached, retry after a delay
          if (!rendered && mermaidRetryRef.current < MERMAID_MAX_RETRIES) {
            mermaidRetryRef.current++;
            retryTimeoutId = setTimeout(() => {
              retryRafId = requestAnimationFrame(() => {
                renderMermaidDiagrams();
              });
            }, 100 * mermaidRetryRef.current);
          }
        });
      });
    });

    return () => {
      cancelAnimationFrame(rafId1);
      if (retryTimeoutId) clearTimeout(retryTimeoutId);
      if (retryRafId) cancelAnimationFrame(retryRafId);
    };
  }, [normalizedContent, isStreaming, renderMermaidDiagrams]);

  // Copy to clipboard implementation
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Fallback method for environments where navigator.clipboard is not available
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        return successful;
      } catch (e) {
        console.error('Copy failed:', e);
        return false;
      }
    }
  };

  const html = useMemo(() => {
    try {
      const trimmedContent = normalizedContent.replace(/[\r\n]+$/, '');

      // During streaming, use lightweight renderer to avoid heavy parsing on every delta
      if (isStreaming) {
        return renderStreamingContent(trimmedContent, linkifyCapabilities);
      }

      // Non-streaming: full markdown pipeline
      // Strip system-internal XML tags and escape remaining XML tags outside code blocks
      // (mirrors CLI's stripPromptXMLTags + html token discard)
      const cleaned = stripAndEscapeOutsideCodeBlocks(
        normalizeIndentedDisplayMath(normalizeBracketMathDelimiters(trimmedContent)),
      );
      const parsed = marked.parse(cleaned);
      const sanitized = DOMPurify.sanitize(
        typeof parsed === 'string' ? parsed : String(parsed),
        {
          ...MARKDOWN_LINK_SANITIZE_OPTIONS,
          ADD_ATTR: ['class', 'data-lang', 'data-copy-success', 'data-copy-title'],
        }
      );
      const rawHtml = sanitized.trim();

      if (typeof window === 'undefined' || !rawHtml) {
        return rawHtml;
      }

      const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
      const pres = doc.querySelectorAll('pre');

      pres.forEach((pre) => {
        const code = pre.querySelector('code');
        const languageTag = code ? (code.className.match(/language-([\w-]+)/i)?.[1] ?? null) : null;
        if (!isLatexCodeLanguage(languageTag)) {
          return;
        }

        const previewHtml = renderLatexPreviewHtml(code?.textContent ?? '');
        if (!previewHtml) {
          return;
        }

        const wrapper = doc.createElement('div');
        wrapper.className = 'code-block-wrapper latex-code-block-wrapper';
        pre.parentNode?.insertBefore(wrapper, pre);

        const preview = doc.createElement('div');
        preview.className = 'latex-code-block-preview';
        preview.innerHTML = previewHtml;

        wrapper.appendChild(preview);
        wrapper.appendChild(pre);
        pre.style.display = 'none';
      });

    decorateExistingAnchors(doc.body);
      const copySuccessText = t('markdown.copySuccess');
      const copyCodeTitle = t('markdown.copyCode');

      pres.forEach((pre) => {
        const parent = pre.parentElement;
        if (parent && parent.classList.contains('code-block-wrapper')) {
          return;
        }

        const wrapper = doc.createElement('div');
        wrapper.className = 'code-block-wrapper';

        pre.parentNode?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-code-btn';
        btn.title = copyCodeTitle;
        btn.setAttribute('aria-label', copyCodeTitle);

        const iconSpan = doc.createElement('span');
        iconSpan.className = 'copy-icon';
        iconSpan.innerHTML = copyIconSvg;

        const tooltipSpan = doc.createElement('span');
        tooltipSpan.className = 'copy-tooltip';
        tooltipSpan.textContent = copySuccessText;

        btn.appendChild(iconSpan);
        btn.appendChild(tooltipSpan);

        wrapper.appendChild(btn);
      });

      linkifyHtml(doc.body, linkifyCapabilities);

      return doc.body.innerHTML.trim();
    } catch (e) {
      // If marked/DOMPurify throws, never return raw `content` to
      // dangerouslySetInnerHTML — escape HTML special chars so any malicious
      // payload renders as literal text instead of executable markup.
      if (typeof console !== 'undefined' && console.error) {
        console.error('[MarkdownBlock] Render failed, falling back to escaped text:', e);
      }
      return normalizedContent.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#39;';
          default: return ch;
        }
      });
    }
  }, [normalizedContent, isStreaming, i18n.language, linkifyCapabilities, t]);

  // ── Streaming selection preservation ─────────────────────────────────────
  // Every streaming delta rewrites the container's innerHTML, which destroys
  // the text nodes underneath an active selection. We don't freeze the DOM
  // (freezing would also stall the visible content mid-stream); instead we
  // ferry the selection across the rebuild. Because streaming only appends,
  // the prefix the user selected keeps its character offsets stable, so we
  // capture them *before* React commits the new HTML — i.e. during render,
  // while the old text nodes are still in place — then re-anchor the Range on
  // the rebuilt text nodes in a layout effect, before paint, so there is no
  // flicker.
  //
  // committedHtmlRef is read here but only mutated inside the layout effect
  // below, so a discarded concurrent render can't poison the "last committed"
  // comparison. rescuedSelectionRef is written during render as a deferred
  // payload for that effect; the value is idempotent across double-invoked
  // renders and never influences render output.
  const committedHtmlRef = useRef(html);
  const rescuedSelectionRef = useRef<TextSelectionOffsets | null>(null);

  if (committedHtmlRef.current !== html) {
    if (containerRef.current) {
      rescuedSelectionRef.current = captureRangeOffsets(containerRef.current);
    }
  }

  // After React commits the new HTML (rebuilding the text nodes), re-anchor
  // any captured selection onto the fresh nodes. useLayoutEffect runs
  // synchronously before paint, so the user never sees the selection drop.
  useLayoutEffect(() => {
    committedHtmlRef.current = html;
    const rescued = rescuedSelectionRef.current;
    if (rescued && containerRef.current) {
      restoreRangeOffsets(containerRef.current, rescued);
    }
    rescuedSelectionRef.current = null;
  }, [html]);

  // Force DOM refresh when streaming ends to fix potential layout corruption from streaming render
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming && containerRef.current) {
      let rafId2: number | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let done = false;

      const applyRefresh = () => {
        if (done || !containerRef.current) return;
        done = true;
        // The forced innerHTML rewrite destroys any active selection's text
        // nodes just like a streaming delta does. Capture the offsets on the
        // pre-rewrite DOM, then re-anchor them on the fresh nodes.
        const rescued = captureRangeOffsets(containerRef.current);
        containerRef.current.innerHTML = html;
        if (rescued) {
          restoreRangeOffsets(containerRef.current, rescued);
        }
        renderMermaidDiagrams();
      };

      // Use double requestAnimationFrame to ensure DOM is fully updated
      const rafId1 = requestAnimationFrame(() => {
        rafId2 = requestAnimationFrame(() => {
          applyRefresh();
        });
        // Fallback: use setTimeout in case rAF doesn't fire in some environments
        fallbackTimer = setTimeout(() => {
          applyRefresh();
        }, 100);
      });

      prevIsStreamingRef.current = isStreaming;
      return () => {
        cancelAnimationFrame(rafId1);
        if (rafId2) cancelAnimationFrame(rafId2);
        if (fallbackTimer) clearTimeout(fallbackTimer);
      };
    }
    prevIsStreamingRef.current = isStreaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, html, renderMermaidDiagrams]);

  const handleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    // React synthetic events may have a Text node as target when the user
    // clicks inside an <a> element. Walk up to the parent element so that
    // element.closest() can be used safely.
    const targetNode = event.target as unknown as Node;
    const target = targetNode.nodeType === Node.TEXT_NODE
      ? (targetNode as Text).parentElement
      : (event.target as HTMLElement);

    const copyBtn = target?.closest('button.copy-code-btn') as HTMLButtonElement | null;
    if (copyBtn && containerRef.current?.contains(copyBtn)) {
      event.preventDefault();
      event.stopPropagation();

      const wrapper = copyBtn.closest('.code-block-wrapper');
      const codeElement = wrapper?.querySelector('pre code') as HTMLElement | null;
      const text = codeElement?.innerText || codeElement?.textContent || '';
      const success = await copyToClipboard(text);

      if (success) {
        copyBtn.classList.add('copied');
        window.setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      }
      return;
    }

    const img = target?.closest('img');
    if (img && img.getAttribute('src')) {
      setPreviewSrc(img.getAttribute('src'));
      return;
    }

    let anchor = target?.closest('a');

    // Fallback: if the click target is not inside an <a> (e.g. a portal
    // tooltip with broken pointer-events overlaying the link), use the
    // click coordinates to find which <a> was actually clicked.
    if (!anchor && containerRef.current) {
      const x = event.clientX;
      const y = event.clientY;
      const links = containerRef.current.querySelectorAll('a');
      for (const link of Array.from(links)) {
        const rect = link.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          anchor = link as HTMLAnchorElement;
          break;
        }
      }
    }

    if (!anchor) {
      return;
    }

    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }

    const linkType = anchor.getAttribute('data-linkify');

    if (linkType === 'file') {
      openFile(href);
      return;
    }

    if (linkType === 'class') {
      openClass(href);
      return;
    }

    if (linkType === 'url' || /^(https?:|mailto:)/.test(href)) {
      openBrowser(href);
    } else {
      openFile(href);
    }
  };

  // `html` is committed directly: streaming selection is preserved by
  // re-anchoring the Range in the layout effect above, not by freezing the
  // output, so the visible content keeps flowing while the user holds a
  // selection.
  return (
    <>
      <div
        ref={containerRef}
        className="markdown-content"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
        onMouseOver={fileLinkTooltip.handleMouseOver}
        onMouseMove={fileLinkTooltip.handleMouseMove}
        onMouseOut={fileLinkTooltip.handleMouseOut}
      />
      {/* Tooltip is managed via native DOM API in handleMouseOver/handleMouseOut
          to avoid React re-render issues that break click events in JCEF. */}
      {previewSrc && (
        <div
          className="image-preview-overlay"
          onClick={() => setPreviewSrc(null)}
          onKeyDown={(e) => e.key === 'Escape' && setPreviewSrc(null)}
          tabIndex={0}
        >
          <img
            className="image-preview-content"
            src={previewSrc}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="image-preview-close"
            onClick={() => setPreviewSrc(null)}
            title={t('chat.closePreview')}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default memo(MarkdownBlock);
