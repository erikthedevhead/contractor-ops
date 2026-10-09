import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { renderMarkdown, RENDER_MARKDOWN_SOURCE } from '../src/markdown';
import { chatPage } from '../src/web';

describe('renderMarkdown (agent replies in the web chat)', () => {
  it('renders the formats the agent actually uses', () => {
    const html = renderMarkdown('Westside owes **$24,996.00**.\n\n| Invoice | Days |\n|---|---|\n| 1066 | 61 |\n\n- one\n- two\n\n1. first');
    expect(html).toContain('<strong>$24,996.00</strong>');
    expect(html).toContain('<table><thead><tr><th>Invoice</th><th>Days</th></tr></thead><tbody><tr><td>1066</td><td>61</td></tr></tbody></table>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li></ol>');
  });

  it('escapes markup from QuickBooks data before formatting (no XSS)', () => {
    const evil = 'Customer: <img src=x onerror=alert(1)> **<script>alert(2)</script>**\n| <b>x</b> |\n|---|\n| "><svg onload=alert(3)> |';
    const html = renderMarkdown(evil);
    expect(html).not.toMatch(/<img|<script|<svg|<b>/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('runs in a bare context with no Node or bundler globals (as in the browser)', () => {
    // Regression: the first version referenced a compiler helper (__name) that only existed in Node.
    const ctx = vm.createContext({});
    vm.runInContext(RENDER_MARKDOWN_SOURCE, ctx);
    expect(vm.runInContext('renderMarkdown("**hi** <b>")', ctx)).toBe('<p><strong>hi</strong> &lt;b&gt;</p>');
  });

  it('the whole page script runs in a bare context without reference errors', () => {
    const html = chatPage('N');
    const script = html.split('<script nonce="N">')[1]!.split('</script>')[0]!;
    // Minimal DOM/browser stubs: enough for top-level code; any undefined global throws.
    const el = () => ({ hidden: false, value: '', onclick: null, oninput: null, onkeydown: null, focus() {}, querySelectorAll: () => [], setCustomValidity() {}, reportValidity() {} });
    const ctx = vm.createContext({ document: { getElementById: el, createElement: el }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, console });
    vm.runInContext(script, ctx);
    expect(vm.runInContext('typeof renderMarkdown', ctx)).toBe('function');
    expect(script).not.toContain('__name');
  });
});
