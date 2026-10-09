/**
 * In-memory QuickBooks Online fake, plugged in through QboClient's fetchFn.
 *
 * Implements just enough behavior to test our integration honestly:
 * - creates assign Id/SyncToken/MetaData and line Ids; totals computed from lines
 * - requestid dedupe: same requestid returns the original response, no new object
 * - duplicate Item/Customer names fail with Fault code 6240
 * - payments reduce invoice Balance and bump the invoice's SyncToken
 * - `select * from X [where F = 'v'] orderby ... startposition N maxresults M`
 * - fault injection hooks (Day 6 builds on this): queue statuses to return
 */
type Obj = Record<string, any>;

export class FakeQbo {
  readonly store = new Map<string, Map<string, Obj>>();
  readonly requests: Array<{ method: string; path: string; requestId: string | null }> = [];
  private readonly byRequestId = new Map<string, unknown>();
  private nextId = 1000;
  private clock = Date.now() - 60_000;
  /** Statuses to return before handling normally, e.g. [429, 503]. */
  readonly injected: number[] = [];
  /** Tombstones for CDC: entity -> (id -> deletion time). */
  private readonly deleted = new Map<string, Map<string, string>>();
  /** Max objects per entity in a CDC response (Intuit: 1000). */
  cdcCap = 1000;
  /**
   * Auth simulation. null = accept any bearer token. Otherwise only this
   * access token is accepted (others get 401), and the token endpoint issues
   * a new one and accepts only that from then on (rotation).
   */
  acceptedToken: string | null = null;
  private tokenSeq = 0;
  readonly tokenRequests: string[] = [];

  constructor() {
    this.put('Account', { Id: '1', SyncToken: '0', Name: 'Services', AccountType: 'Income', Active: true, MetaData: this.meta() });
    this.put('Account', { Id: '2', SyncToken: '0', Name: 'Sales of Product Income', AccountType: 'Income', Active: true, MetaData: this.meta() });
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname === 'oauth.platform.intuit.com') return this.token(init);
    if (this.acceptedToken !== null) {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== `Bearer ${this.acceptedToken}`) return json(401, { Fault: { type: 'AUTHENTICATION', Error: [{ code: '3200', Message: 'AuthenticationFailed' }] } });
    }
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/v3\/company\/[^/]+/, '');
    const requestId = url.searchParams.get('requestid');
    this.requests.push({ method, path, requestId });

    const injected = this.injected.shift();
    if (injected) return json(injected, injected === 429 ? {} : { Fault: { Error: [{ Message: 'injected' }] } });

    if (method === 'GET' && path === '/query') return this.query(url.searchParams.get('query') ?? '');
    if (method === 'GET' && path === '/cdc') return this.cdc(url.searchParams.get('entities') ?? '', url.searchParams.get('changedSince') ?? '');
    const read = /^\/(\w+)\/([^/]+)$/.exec(path);
    if (method === 'GET' && read) {
      const entity = capitalize(read[1]!);
      const obj = this.store.get(entity)?.get(decodeURIComponent(read[2]!));
      if (!obj) return json(400, { Fault: { type: 'ValidationFault', Error: [{ code: '610', Message: 'Object Not Found' }] } });
      return json(200, { [entity]: obj, time: new Date(this.clock).toISOString() });
    }
    if (method === 'POST') {
      if (requestId && this.byRequestId.has(requestId)) return json(200, this.byRequestId.get(requestId));
      const entity = capitalize(path.slice(1));
      const res = this.create(entity, JSON.parse(String(init?.body ?? '{}')));
      if (res.status === 200 && requestId) this.byRequestId.set(requestId, res.body);
      return json(res.status, res.body);
    }
    return json(404, { Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] } });
  };

  private token(init?: RequestInit): Response {
    const form = new URLSearchParams(String(init?.body ?? ''));
    this.tokenRequests.push(form.get('grant_type') ?? '');
    const access = `fake-access-${++this.tokenSeq}`;
    this.acceptedToken = access;
    return json(200, { access_token: access, refresh_token: `fake-refresh-${this.tokenSeq}`, token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8_726_400 });
  }

  /** Simulate an edit made in the QuickBooks UI: bumps SyncToken and LastUpdatedTime. */
  update(entity: string, id: string, patch: Obj): Obj {
    const obj = this.store.get(entity)?.get(id);
    if (!obj) throw new Error(`fake: no ${entity} ${id}`);
    Object.assign(obj, patch, { SyncToken: String(Number(obj.SyncToken) + 1), MetaData: { ...obj.MetaData, LastUpdatedTime: this.meta().LastUpdatedTime } });
    return obj;
  }

  remove(entity: string, id: string): void {
    this.store.get(entity)?.delete(id);
    if (!this.deleted.has(entity)) this.deleted.set(entity, new Map());
    this.deleted.get(entity)!.set(id, this.meta().LastUpdatedTime);
  }

  /** Insert directly, bypassing API semantics (bulk fixtures). */
  insert(entity: string, obj: Obj): Obj {
    const full = { SyncToken: '0', ...obj, Id: obj.Id ?? String(this.nextId++), MetaData: this.meta() };
    this.put(entity, full);
    return full;
  }

  all(entity: string): Obj[] {
    return [...(this.store.get(entity)?.values() ?? [])];
  }

  private meta() {
    // Monotonic and never behind real time, like a real server clock.
    this.clock = Math.max(this.clock + 1, Date.now());
    const t = new Date(this.clock).toISOString();
    return { CreateTime: t, LastUpdatedTime: t };
  }

  private put(entity: string, obj: Obj) {
    if (!this.store.has(entity)) this.store.set(entity, new Map());
    this.store.get(entity)!.set(obj.Id, obj);
  }

  private create(entity: string, body: Obj): { status: number; body: unknown } {
    const nameField = entity === 'Item' ? 'Name' : entity === 'Customer' ? 'DisplayName' : null;
    if (nameField && this.all(entity).some((o) => o[nameField] === body[nameField])) {
      return { status: 400, body: { Fault: { type: 'ValidationFault', Error: [{ code: '6240', Message: 'Duplicate Name Exists Error' }] } } };
    }
    const obj: Obj = { ...body, Id: String(this.nextId++), SyncToken: '0', MetaData: this.meta() };
    if (Array.isArray(obj.Line) && (entity === 'Estimate' || entity === 'Invoice')) {
      obj.Line = obj.Line.map((l: Obj, i: number) => ({ Id: String(i + 1), LineNum: i + 1, ...l }));
      obj.TotalAmt = round2(obj.Line.reduce((s: number, l: Obj) => s + l.Amount, 0));
      if (entity === 'Invoice') obj.Balance = obj.TotalAmt;
    }
    if (entity === 'Payment') {
      for (const line of obj.Line ?? []) {
        for (const link of line.LinkedTxn ?? []) {
          const inv = this.store.get('Invoice')?.get(link.TxnId);
          if (!inv) return { status: 400, body: { Fault: { Error: [{ code: '610', Message: 'Invoice not found' }] } } };
          inv.Balance = round2(inv.Balance - line.Amount);
          inv.SyncToken = String(Number(inv.SyncToken) + 1);
          inv.MetaData = { ...inv.MetaData, LastUpdatedTime: this.meta().LastUpdatedTime };
        }
      }
    }
    this.put(entity, obj);
    return { status: 200, body: { [entity]: obj, time: new Date(this.clock).toISOString() } };
  }

  private query(q: string): Response {
    const m = /^select \* from (\w+)(?: where ([\w.]+) (=|>=) '((?:\\.|[^'])*)')?(?: orderby [\w.]+)?(?: startposition (\d+))?(?: maxresults (\d+))?$/i.exec(q.trim());
    if (!m) return json(400, { Fault: { Error: [{ code: '4000', Message: `fake cannot parse: ${q}` }] } });
    const [, entity, field, op, rawValue, start, max] = m;
    let rows = this.all(entity!).sort((a, b) => a.MetaData.LastUpdatedTime.localeCompare(b.MetaData.LastUpdatedTime));
    if (field) {
      const value = rawValue!.replace(/\\(.)/g, '$1');
      const get = (r: Obj) => field.split('.').reduce((o: any, k) => o?.[k], r);
      rows = rows.filter((r) => (op === '=' ? String(get(r)) === value : String(get(r)) >= value));
    }
    const s = Number(start ?? 1) - 1;
    const page = rows.slice(s, s + Number(max ?? 100));
    return json(200, { QueryResponse: page.length ? { [entity!]: page, startPosition: s + 1, maxResults: page.length } : {} });
  }
  private cdc(entities: string, changedSince: string): Response {
    if (!changedSince) return json(400, { Fault: { Error: [{ Message: 'changedSince required' }] } });
    const since = new Date(changedSince).toISOString();
    const qr = entities.split(',').map((entity) => {
      const live = this.all(entity).filter((o) => o.MetaData.LastUpdatedTime >= since);
      const gone = [...(this.deleted.get(entity) ?? [])]
        .filter(([, t]) => t >= since)
        .map(([Id, t]) => ({ Id, status: 'Deleted', MetaData: { LastUpdatedTime: t } }));
      return { [entity]: [...live, ...gone].slice(0, this.cdcCap) };
    });
    return json(200, { CDCResponse: [{ QueryResponse: qr }], time: new Date(this.clock).toISOString() });
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const round2 = (n: number) => Math.round(n * 100) / 100;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
