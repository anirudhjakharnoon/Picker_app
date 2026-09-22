/**
 * Minimal in-memory stand-in for the subset of the Supabase JS client's
 * Postgrest query builder that lib/crawlEngine.ts (and its collaborators)
 * actually use: .from().select/insert/update/upsert with .eq/.order/.limit
 * and .maybeSingle/.single, plus .rpc() and .storage.from().upload(). Not a
 * general Postgrest emulator - just enough real chaining/filtering/ordering
 * semantics to run the crawl engine against a real in-memory "database" in
 * tests, instead of hand-mocking every individual call.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, unknown>;

interface TableConfig {
  primaryKey: string;
  autoIncrement: boolean;
  uniqueKeys?: string[][];
}

class FakeTable {
  private rowsById: Row[] = [];
  private nextId = 1;

  constructor(private config: TableConfig) {}

  all(): Row[] {
    return this.rowsById.map((r) => ({ ...r }));
  }

  /** Live references (not copies) - only for internal query-builder use, so updates persist. */
  raw(): Row[] {
    return this.rowsById;
  }

  insert(row: Row): Row {
    const toInsert = { ...row };
    if (this.config.autoIncrement && toInsert[this.config.primaryKey] === undefined) {
      toInsert[this.config.primaryKey] = this.nextId++;
    }
    this.rowsById.push(toInsert);
    return { ...toInsert };
  }

  update(existing: Row, patch: Row): Row {
    Object.assign(existing, patch);
    return { ...existing };
  }

  upsert(row: Row, onConflict: string | undefined, ignoreDuplicates: boolean | undefined): Row | null {
    const conflictKeys = onConflict ? onConflict.split(",").map((s) => s.trim()) : [this.config.primaryKey];
    const existing = this.rowsById.find((r) => conflictKeys.every((k) => r[k] === row[k]));
    if (existing) {
      if (ignoreDuplicates) return null;
      Object.assign(existing, row);
      return { ...existing };
    }
    return this.insert(row);
  }
}

type PendingOp =
  | { type: "select" }
  | { type: "insert"; rows: Row[] }
  | { type: "update"; patch: Row }
  | { type: "upsert"; rows: Row[]; onConflict?: string; ignoreDuplicates?: boolean };

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private orderings: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private wantReturn = false;
  private wantSingle: "maybe" | "one" | null = null;
  private op: PendingOp = { type: "select" };

  constructor(private table: FakeTable) {}

  eq(column: string, value: unknown): this {
    this.filters.push((r) => r[column] === value);
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderings.push({ column, ascending: opts?.ascending ?? true });
    return this;
  }

  limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  select(_columns?: string): this {
    this.wantReturn = true;
    return this;
  }

  maybeSingle(): this {
    this.wantSingle = "maybe";
    this.wantReturn = true;
    return this;
  }

  single(): this {
    this.wantSingle = "one";
    this.wantReturn = true;
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.op = { type: "insert", rows: Array.isArray(rows) ? rows : [rows] };
    return this;
  }

  update(patch: Row): this {
    this.op = { type: "update", patch };
    return this;
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = {
      type: "upsert",
      rows: Array.isArray(rows) ? rows : [rows],
      onConflict: opts?.onConflict,
      ignoreDuplicates: opts?.ignoreDuplicates,
    };
    return this;
  }

  private matched(): Row[] {
    let rows = this.table.raw().filter((r) => this.filters.every((f) => f(r)));
    for (const { column, ascending } of this.orderings) {
      rows = rows.sort((a, b) => {
        const av = a[column] as number | string;
        const bv = b[column] as number | string;
        if (av < bv) return ascending ? -1 : 1;
        if (av > bv) return ascending ? 1 : -1;
        return 0;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  private execute(): { data: unknown; error: null } {
    if (this.op.type === "insert") {
      const inserted = this.op.rows.map((r) => this.table.insert(r));
      return { data: this.wantReturn ? inserted : null, error: null };
    }
    if (this.op.type === "upsert") {
      const results = this.op.rows.map((r) => this.table.upsert(r, this.op.type === "upsert" ? this.op.onConflict : undefined, this.op.type === "upsert" ? this.op.ignoreDuplicates : undefined));
      return { data: this.wantReturn ? results.filter((r) => r !== null) : null, error: null };
    }
    if (this.op.type === "update") {
      const targets = this.matched();
      const patch = this.op.patch;
      const updated = targets.map((r) => this.table.update(r, patch));
      return { data: this.wantReturn ? updated : null, error: null };
    }
    // select
    const rows = this.matched();
    if (this.wantSingle) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

const TABLES: Record<string, TableConfig> = {
  crawl_jobs: { primaryKey: "id", autoIncrement: false },
  crawl_queue: { primaryKey: "id", autoIncrement: true },
  crawl_pages: { primaryKey: "id", autoIncrement: true },
  crawl_assets: { primaryKey: "id", autoIncrement: true },
  robots_cache: { primaryKey: "domain", autoIncrement: false },
  crawl_events: { primaryKey: "id", autoIncrement: true },
  job_rate_limits: { primaryKey: "owner", autoIncrement: false },
};

export class FakeSupabase {
  private tables = new Map<string, FakeTable>();
  public uploadedFiles = new Map<string, { data: Buffer; contentType?: string }>();
  public rpcCalls: Array<{ name: string; args: unknown }> = [];
  public rpcHandlers = new Map<string, (args: any) => unknown>();

  storage = {
    from: (_bucket: string) => ({
      upload: async (path: string, data: Buffer | string, opts?: { contentType?: string }) => {
        this.uploadedFiles.set(path, {
          data: Buffer.isBuffer(data) ? data : Buffer.from(data),
          contentType: opts?.contentType,
        });
        return { data: { path }, error: null };
      },
    }),
  };

  constructor(seed?: Partial<Record<string, Row[]>>) {
    for (const [name, config] of Object.entries(TABLES)) {
      const table = new FakeTable(config);
      this.tables.set(name, table);
      const seedRows = seed?.[name];
      if (seedRows) {
        for (const row of seedRows) table.insert(row);
      }
    }
  }

  from(name: string): FakeQueryBuilder {
    const table = this.tables.get(name);
    if (!table) throw new Error(`FakeSupabase: unknown table "${name}"`);
    return new FakeQueryBuilder(table);
  }

  getAll(name: string): Row[] {
    const table = this.tables.get(name);
    if (!table) throw new Error(`FakeSupabase: unknown table "${name}"`);
    return table.all();
  }

  async rpc(name: string, args: unknown): Promise<{ data: unknown; error: null }> {
    this.rpcCalls.push({ name, args });
    const handler = this.rpcHandlers.get(name);
    if (handler) {
      return { data: handler(args), error: null };
    }
    return { data: null, error: null };
  }
}
