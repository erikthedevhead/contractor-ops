import { readFileSync } from 'node:fs';

/**
 * Minimal, safe Markdown -> HTML for agent replies: paragraphs, **bold**,
 * `code`, bullet and numbered lists, and pipe tables. Everything is
 * HTML-escaped FIRST, so text from QuickBooks (customer names, memos, which an
 * outsider can influence) can never inject markup or script.
 *
 * The renderer lives in render-markdown.browser.js and is read as RAW TEXT, so
 * the code the tests run and the code the browser runs are byte-identical.
 * (First version embedded a compiled function via toString(); in production
 * the TypeScript runner inserted a `__name()` helper that doesn't exist in
 * browsers, and every reply failed to render. See docs/failure-modes.md.)
 */
export const RENDER_MARKDOWN_SOURCE = readFileSync(new URL('./render-markdown.browser.js', import.meta.url), 'utf8');

export const renderMarkdown = new Function(`${RENDER_MARKDOWN_SOURCE}\nreturn renderMarkdown;`)() as (src: string) => string;
