import type { Db } from '@co/db';

/**
 * Cost per LLM call from the model_prices table (prices are data, not code:
 * a price change is an INSERT with a new effective_from, and historical calls
 * keep the price they were billed at).
 */
export interface Price {
  input: number;      // USD per MTok
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export class PriceBook {
  private constructor(private readonly prices: Map<string, Price>) {}

  static async load(db: Db, at = new Date()): Promise<PriceBook> {
    const rows = await db.selectFrom('model_prices').selectAll()
      .where('effective_from', '<=', at.toISOString().slice(0, 10)).orderBy('effective_from', 'asc').execute();
    const m = new Map<string, Price>();
    for (const r of rows) {
      m.set(r.model, {
        input: Number(r.input_usd_per_mtok),
        output: Number(r.output_usd_per_mtok),
        cacheRead: Number(r.cache_read_usd_per_mtok ?? r.input_usd_per_mtok),
        cacheWrite: Number(r.cache_write_usd_per_mtok ?? r.input_usd_per_mtok),
      });
    }
    return new PriceBook(m);
  }

  static fromEntries(entries: Record<string, Price>): PriceBook {
    return new PriceBook(new Map(Object.entries(entries)));
  }

  price(model: string): Price {
    const p = this.prices.get(model);
    if (!p) throw new Error(`no price for model ${model}; add a model_prices row before using it`);
    return p;
  }

  /** USD, rounded to 6 decimals (micro-dollars), matching numeric(12,6). */
  cost(model: string, u: TokenUsage): number {
    const p = this.price(model);
    const usd =
      (u.input_tokens * p.input +
        u.output_tokens * p.output +
        (u.cache_read_input_tokens ?? 0) * p.cacheRead +
        (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1_000_000;
    return Math.round(usd * 1e6) / 1e6;
  }

  /** Upper bound before a call: every input token uncached, every output token used. */
  worstCase(model: string, estInputTokens: number, maxOutputTokens: number): number {
    const p = this.price(model);
    return Math.ceil(((estInputTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output) / 1_000_000) * 1e6) / 1e6;
  }
}
