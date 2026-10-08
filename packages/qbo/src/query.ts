import type { QboClient } from './http';
import type { MirrorEntity } from './types';

const PAGE = 1000; // QuickBooks maximum MAXRESULTS

/**
 * Pages through `select * from <Entity>` with STARTPOSITION/MAXRESULTS.
 * Ordered by MetaData.LastUpdatedTime: Intuit made Id non-sortable, and an
 * unordered paged query has no stable page boundaries.
 */
export async function* queryAll<T>(client: QboClient, entity: MirrorEntity, where?: string): AsyncGenerator<T[]> {
  for (let start = 1; ; start += PAGE) {
    const q = `select * from ${entity}${where ? ` where ${where}` : ''} orderby MetaData.LastUpdatedTime startposition ${start} maxresults ${PAGE}`;
    const res = await client.get<{ QueryResponse: Record<string, unknown> }>('/query', { query: { query: q }, entityName: entity });
    const rows = (res.QueryResponse?.[entity] as T[] | undefined) ?? [];
    if (rows.length > 0) yield rows;
    if (rows.length < PAGE) return;
  }
}
