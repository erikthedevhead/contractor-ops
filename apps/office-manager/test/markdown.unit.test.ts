import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown';

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

  it('is self-contained so the page can embed it verbatim', () => {
    const fn = new Function(`return (${renderMarkdown.toString()})`)() as typeof renderMarkdown;
    expect(fn('**hi** <b>')).toBe('<p><strong>hi</strong> &lt;b&gt;</p>');
  });
});
