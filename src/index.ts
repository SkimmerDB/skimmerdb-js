// SkimmerDB: search for your apps and AI agents.
//
//   import { SkimmerDB } from "skimmerdb";
//   const db = new SkimmerDB("tb_...");                 // or SKIMMERDB_KEY
//   const ns = db.namespace("support");                 // the first write makes it
//   await ns.write([{ id: "t-1", text: "Refund requested for order ACME-1042", meta: { status: "open" } }]);
//   const { hits } = await ns.search("refund", { filter: { status: "open" } });
//
// Typed metadata: give the namespace your metadata's type, and writes, hits, documents and
// filters are checked against it (a filter's ranges only on numeric keys; nested values can't be
// filtered, as on the server):
//   type Ticket = { status: "open" | "closed"; priority: number; ts: number };
//   const tickets = db.namespace<Ticket>("support");
//   const { hits } = await tickets.search("refund", { filter: { status: "open", priority: { gte: 2 } } });
//   hits[0].meta.priority;                              // number
//
// This file is the thin, hand-written layer. Every operation is also generated from the OpenAPI
// document (https://api.skimmerdb.com/openapi.json) into ./api (import from "skimmerdb/api"), named
// by its operationId; db.client is the configured client to pass them:
//   import { search } from "skimmerdb/api";
//   const { data } = await search({ client: db.client, path: { name: "support" }, body: { q: "refund" } });
import { createClient, createConfig, type Client } from './api/client/index.js';
import * as api from './api/sdk.gen.js';
import type {
	BucketImportResult,
	CountResult,
	Document,
	DocumentPatch,
	EmbedConfig,
	EmbeddingKey,
	EmbeddingKeyList,
	Export,
	Filter,
	Hit,
	Me,
	S3Keys,
	Namespace as NamespaceInfo,
	NamespaceList,
	SearchRequest,
	SearchResult,
	SqlResult,
	StoredDocument,
	Usage,
	WarmResult,
	WriteResult
} from './api/types.gen.js';

export * from './api/types.gen.js';
export const DEFAULT_URL = 'https://api.skimmerdb.com';

/** An error answer: `status` (HTTP), `message` (the server's sentence), `code` (a word to act on: not_found, invalid, rate_limited, namespace_limit, write_busy, ...), `fields` (invalid input: field -> what's wrong), `retryAfter` (seconds, on 429). */
export class SkimmerDBError extends Error {
	constructor(
		public status: number,
		message: string,
		public retryAfter?: number,
		public code: string = '',
		public fields: Record<string, string> = {}
	) {
		super(code ? `${status} ${code}: ${message}` : `${status}: ${message}`);
		this.name = 'SkimmerDBError';
		this.message = message;
	}
}

export type Options = {
	/** Default: SKIMMERDB_URL, else https://api.skimmerdb.com (a trailing /v1 is dropped: the operations' paths carry it). */
	baseUrl?: string;
	/** A fetch to use (default: the global one). */
	fetch?: typeof fetch;
	/** Retries of 429 and 503 answers, after Retry-After or backing off (default 3). */
	retries?: number;
};

type Scalar = string | number | boolean;

/** Filter operators on one metadata value of type V (ranges only on numbers, as on the server). */
export type TypedFilterOps<V> = { eq?: V; ne?: V; in?: V[] } & (V extends number ? { gt?: number; gte?: number; lt?: number; lte?: number } : {});
type FilterValue<V> = [V] extends [Scalar] ? V | V[] | TypedFilterOps<V> : never;

/** A filter over metadata of type M: every key one of M's (top-level, scalar) keys. Untyped namespaces take any Filter. */
export type TypedFilter<M> = string extends keyof M ? Filter : { [K in keyof M]?: FilterValue<NonNullable<M[K]>> };

/** A document to write, its meta typed. */
export type TypedDocument<M> = Omit<Document, 'meta'> & { meta?: M };
/** A change to a document: meta merged key by key, null removes a key. */
export type TypedDocumentPatch<M> = Omit<DocumentPatch, 'meta'> & { meta?: { [K in keyof M]?: M[K] | null } };
/** A search hit, its meta typed (as written). */
export type TypedHit<M> = Omit<Hit, 'meta'> & { meta: M };
export type TypedSearchResult<M> = Omit<SearchResult, 'hits'> & { hits: TypedHit<M>[] };
export type TypedStoredDocument<M> = Omit<StoredDocument, 'meta'> & { meta: M };

export type SearchOptions<M = Record<string, unknown>> = Omit<SearchRequest, 'q' | 'filter'> & { filter?: TypedFilter<M> };
export type CountOptions<M = Record<string, unknown>> = { filter?: TypedFilter<M>; regex?: boolean; exact?: boolean };

type Answer<T> = { data?: T; error?: unknown; response?: Response };

function env(name: string): string {
	const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return p?.env?.[name] ?? '';
}

function baseUrl(url?: string): string {
	return (url || env('SKIMMERDB_URL') || DEFAULT_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
}

function errorOf(body: unknown, status: number, retryAfter?: number): SkimmerDBError {
	const b = (body ?? {}) as { error?: unknown; code?: unknown; fields?: unknown };
	const message = typeof b.error === 'string' ? b.error : status ? `request failed (${status})` : "couldn't reach SkimmerDB";
	const fields = b.fields && typeof b.fields === 'object' ? (b.fields as Record<string, string>) : {};
	return new SkimmerDBError(status, message, retryAfter, typeof b.code === 'string' ? b.code : '', fields);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(retries: number, f: () => Promise<Answer<T>>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const r = await f();
		const status = r.response?.status ?? 0;
		if (r.response && status >= 200 && status < 300) return r.data as T;
		const ra = Number(r.response?.headers.get('retry-after') ?? '') || undefined;
		const err = errorOf(r.error, status, ra);
		if ((status === 429 || status === 503) && attempt < retries) {
			await sleep(ra ? ra * 1000 : 250 * 2 ** attempt);
			continue;
		}
		throw err;
	}
}

/** One namespace: `db.namespace("support")`, or `db.namespace<Ticket>("support")` with typed metadata. Nothing is sent until a method is called; the server makes it on the first write if it doesn't exist (with vectors of the first vector's length when the documents have them; the answer's `created` says so). */
export class Namespace<M extends object = Record<string, unknown>> {
	constructor(
		readonly db: SkimmerDB,
		readonly name: string
	) {}

	private get path() {
		return { name: this.name };
	}

	/** Puts (inserts or replaces) documents and deletes ids: up to 10,000 a call. `wait`: answer once they're searchable (they're durable either way). */
	async write(docs: TypedDocument<M>[], opts: { deletes?: string[]; wait?: boolean } = {}): Promise<WriteResult> {
		const body = { docs: docs as Document[], deletes: opts.deletes, wait: opts.wait };
		return this.db.call(() => api.writeDocuments({ client: this.db.client, path: this.path, body }));
	}

	/** Changes existing documents: text replaced if given, meta merged key by key (null removes a key). */
	update(docs: TypedDocumentPatch<M>[], opts: { wait?: boolean } = {}): Promise<WriteResult> {
		return this.db.call(() => api.updateDocuments({ client: this.db.client, path: this.path, body: { docs: docs as DocumentPatch[], wait: opts.wait } }));
	}

	delete(ids: string[], opts: { wait?: boolean } = {}): Promise<WriteResult> {
		return this.db.call(() => api.deleteDocuments({ client: this.db.client, path: this.path, body: { ids, wait: opts.wait } }));
	}

	/** Exact text (literal, ignoring case) or regex, newest first; with `vector`, the nearest documents (`q` and `filter` narrow them: hybrid). Pass `next` as `cursor` for the next page. */
	search(q = '', opts: SearchOptions<M> = {}): Promise<TypedSearchResult<M>> {
		const body = { ...opts, q } as SearchRequest;
		return this.db.call(() => api.search({ client: this.db.client, path: this.path, body })) as Promise<TypedSearchResult<M>>;
	}

	/** How many documents match (exact; `exact: false` estimates). */
	async count(q = '', opts: CountOptions<M> = {}): Promise<number> {
		return (await this.countResult(q, opts)).count;
	}

	countResult(q = '', opts: CountOptions<M> = {}): Promise<CountResult> {
		const body = { ...opts, q } as { q: string; filter?: Filter; regex?: boolean; exact?: boolean };
		return this.db.call(() => api.count({ client: this.db.client, path: this.path, body }));
	}

	/** One document, whole (a SkimmerDBError with status 404 when there's none). */
	get(id: string): Promise<TypedStoredDocument<M>> {
		return this.db.call(() => api.getDocument({ client: this.db.client, path: { name: this.name, id } })) as Promise<TypedStoredDocument<M>>;
	}

	/** (beta) One SELECT ... FROM docs over the documents' metadata. */
	sql(query: string): Promise<SqlResult> {
		return this.db.call(() => api.querySql({ client: this.db.client, path: this.path, body: { sql: query } }));
	}

	/** (beta) A query's rows as they're streamed (NDJSON, no 10,000-row cap): `for await (const row of ns.sqlRows("SELECT ..."))`. */
	sqlRows(query: string): AsyncGenerator<Record<string, unknown>> {
		return this.db.streamRows(`/v1/namespaces/${encodeURIComponent(this.name)}/sql`, query);
	}

	/** Writes any number of documents in one streamed request (NDJSON, written in batches of 50,000 as the server reads them; each batch atomic, the stream not). */
	async writeStream(docs: Iterable<TypedDocument<M>> | AsyncIterable<TypedDocument<M>>, opts: { wait?: boolean } = {}): Promise<WriteResult & { batches?: number; lines?: number }> {
		const enc = new TextEncoder();
		async function* lines() {
			let buf = '';
			for await (const d of docs as AsyncIterable<TypedDocument<M>>) {
				buf += JSON.stringify(d) + '\n';
				if (buf.length >= 1 << 20) {
					yield enc.encode(buf);
					buf = '';
				}
			}
			if (buf) yield enc.encode(buf);
		}
		const it = lines();
		const body = new ReadableStream<Uint8Array>({
			async pull(c) {
				const r = await it.next();
				if (r.done) c.close();
				else c.enqueue(r.value);
			}
		});
		const res = await this.db.raw(`/v1/namespaces/${encodeURIComponent(this.name)}/docs/stream${opts.wait ? '?wait=true' : ''}`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-ndjson' }, duplex: 'half' } as RequestInit);
		if (res.status !== 200) throw errorOf(await res.json().catch(() => ({})), res.status);
		return res.json();
	}

	/** Opens the namespace ahead of queries (and fetches what these searches need). */
	/** Imports CSV, NDJSON or Parquet files from your own bucket: `s3://bucket/key`, a prefix (`s3://bucket/dir/`) or a pattern (`s3://bucket/dir/*.parquet`). `s3.endpoint` names an S3-compatible service (Cloudflare R2: `https://<account>.r2.cloudflarestorage.com` with region `auto`; B2, MinIO, Wasabi, GCS). Each request takes up to 100 files / 4 GB; with `follow` (the default) it goes on from each answer's `next` until every file is in. The answers, in order. */
	async importBucket(path: string, s3: S3Keys, opts: { id?: string; text?: string[]; format?: '' | 'csv' | 'ndjson' | 'parquet'; schema?: string; after?: string; follow?: boolean } = {}): Promise<BucketImportResult[]> {
		const out: BucketImportResult[] = [];
		let after = opts.after ?? '';
		for (;;) {
			const body = { path, s3, id: opts.id, text: opts.text, format: opts.format, schema: opts.schema, after };
			const r = await this.db.call(() => api.importBucket({ client: this.db.client, path: this.path, body }));
			out.push(r);
			after = r.next;
			if (opts.follow === false || !after) return out;
		}
	}

	warm(queries: string[] = []): Promise<WarmResult> {
		return this.db.call(() => api.warmNamespace({ client: this.db.client, path: this.path, body: { queries } }));
	}

	/** Sets or changes the model documents' text is embedded with (`{ provider: "openai" }`; the namespace's vector length must fit), or stops embedding (`null`). */
	setEmbedding(embed: EmbedConfig | null): Promise<NamespaceInfo> {
		return this.db.call(() => api.updateNamespace({ client: this.db.client, path: this.path, body: { embed } }));
	}

	info(): Promise<NamespaceInfo> {
		return this.db.call(() => api.getNamespace({ client: this.db.client, path: this.path }));
	}

	/** Deletes the namespace and its documents, for good. */
	async drop(): Promise<void> {
		await this.db.call(() => api.deleteNamespace({ client: this.db.client, path: this.path }));
	}
}

/** A connection with an API key (`key`, else SKIMMERDB_KEY). */
export class SkimmerDB {
	readonly key: string;
	readonly baseUrl: string;
	/** The generated layer's client, for any operation in "skimmerdb/api". */
	readonly client: Client;
	private retries: number;
	private fetchFn: typeof fetch;

	constructor(key?: string, opts: Options = {}) {
		this.key = key || env('SKIMMERDB_KEY');
		if (!this.key) throw new SkimmerDBError(401, 'no API key: pass new SkimmerDB(key) or set SKIMMERDB_KEY (make one at https://skimmerdb.com/dashboard)');
		this.baseUrl = baseUrl(opts.baseUrl);
		this.retries = opts.retries ?? 3;
		this.client = createClient(createConfig({ baseUrl: this.baseUrl, auth: this.key, fetch: opts.fetch }));
		this.fetchFn = opts.fetch ?? fetch;
	}

	/** (internal) a request with the key, outside the generated layer (streams). */
	raw(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('Authorization', `Bearer ${this.key}`);
		return this.fetchFn(this.baseUrl + path, { ...init, headers });
	}

	/** (internal) NDJSON rows of a streamed SQL answer. */
	async *streamRows(path: string, query: string): AsyncGenerator<Record<string, unknown>> {
		const res = await this.raw(path, { method: 'POST', body: JSON.stringify({ sql: query }), headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' } });
		if (res.status !== 200 || !res.body) throw errorOf(await res.json().catch(() => ({})), res.status);
		const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
		let buf = '';
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (value) buf += value;
				let nl = buf.indexOf('\n');
				while (nl >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line) {
						const row = JSON.parse(line) as Record<string, unknown>;
						if (Object.keys(row).length === 2 && typeof row.error === 'string' && typeof row.code === 'string') throw errorOf(row, 422);
						yield row;
					}
					nl = buf.indexOf('\n');
				}
				if (done) break;
			}
		} catch (e) {
			if (e instanceof SkimmerDBError) throw e;
			throw new SkimmerDBError(503, `the answer was cut short: ${e}`);
		}
	}

	/** (beta) A query over your namespaces (by name), its rows streamed (NDJSON, no row cap). A failure midway throws (never a short answer). */
	sqlRows(query: string): AsyncGenerator<Record<string, unknown>> {
		return this.streamRows('/v1/sql', query);
	}

	/** (beta) Starts an export of a query's answer (csv, ndjson or parquet), kept 24 hours: `waitExport`, then `downloadExport`. With `destination` (`{ path: "s3://bucket/key", s3: {...} }`) the file is delivered to your own bucket instead (AWS S3, R2, B2, MinIO, ...). */
	export(query: string, format: 'csv' | 'ndjson' | 'parquet' = 'csv', destination?: { path: string; s3: S3Keys }): Promise<Export> {
		return this.call(() => api.createExport({ client: this.client, body: { sql: query, format, destination } }));
	}

	exportStatus(id: string): Promise<Export> {
		return this.call(() => api.getExport({ client: this.client, path: { id } }));
	}

	/** Waits until the export is done (throws when it failed). */
	async waitExport(id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<Export> {
		const end = Date.now() + (opts.timeoutMs ?? 3_600_000);
		for (;;) {
			const e = await this.exportStatus(id);
			if (e.status === 'done') return e;
			if (e.status === 'failed' || e.status === 'expired') throw new SkimmerDBError(422, `the export ${e.status}: ${e.error}`);
			if (Date.now() > end) throw new SkimmerDBError(504, "the export didn't finish in time");
			await sleep(opts.pollMs ?? 1000);
		}
	}

	/** A done export's file as a Response (stream its body); `from` resumes at that byte (206). */
	async downloadExport(id: string, from = 0): Promise<Response> {
		const res = await this.raw(`/v1/sql/exports/${encodeURIComponent(id)}/download`, { headers: from > 0 ? { Range: `bytes=${from}-` } : {} });
		if (res.status !== 200 && res.status !== 206) throw errorOf(await res.json().catch(() => ({})), res.status);
		return res;
	}

	/** Makes an account: a ready connection with its first key, full access (`db.key`; keep it, it's shown only once). Give apps and agents narrower keys (`db.createKey`). */
	static async signup(email: string, password: string, opts: Options & { name?: string } = {}): Promise<SkimmerDB> {
		const url = baseUrl(opts.baseUrl);
		const anon = createClient(createConfig({ baseUrl: url, fetch: opts.fetch }));
		const { key } = await call(0, () => api.signup({ client: anon, body: { email, password, name: opts.name ?? email.split('@')[0] } }));
		return new SkimmerDB(key, { ...opts, baseUrl: url });
	}

	/** Logs in and makes a new API key (scope write) with it. */
	static async login(email: string, password: string, opts: Options & { keyName?: string } = {}): Promise<SkimmerDB> {
		const url = baseUrl(opts.baseUrl);
		const anon = createClient(createConfig({ baseUrl: url, fetch: opts.fetch }));
		const { token } = await call(0, () => api.login({ client: anon, body: { email, password } }));
		const owner = createClient(createConfig({ baseUrl: url, auth: token, fetch: opts.fetch }));
		const { key } = await call(0, () => api.createKey({ client: owner, body: { name: opts.keyName ?? 'default' } }));
		return new SkimmerDB(key, { ...opts, baseUrl: url });
	}

	/** @internal */
	call<T>(f: () => Promise<Answer<T>>): Promise<T> {
		return call(this.retries, f);
	}

	/** A new API key (needs an admin key): scope read, write or admin, optionally limited to some namespaces (names or "prefix*") and capped. The key is returned once. */
	async createKey(name = 'default', opts: { scope?: 'read' | 'write' | 'admin'; namespaces?: string[]; rate_per_s?: number; cap_queries?: number; cap_writes?: number } = {}): Promise<string> {
		const { key } = await this.call(() => api.createKey({ client: this.client, body: { name, ...opts } }));
		return key;
	}

	/** A namespace by name; `namespace<Ticket>(name)` types its metadata. */
	namespace<M extends object = Record<string, unknown>>(name: string): Namespace<M> {
		return new Namespace<M>(this, name);
	}

	/** Creates a namespace. `dims`: vectors of that length (yours); `embed`: documents' text embedded for you, with your own provider key (`{ provider: "openai" | "voyage" | "gemini" | "cohere" }`) or hosted at cost (`{ provider: "skimmerdb" }`), then `search("", { semantic: "..." })`. */
	async createNamespace<M extends object = Record<string, unknown>>(name: string, opts: { dims?: number; metric?: 'cosine' | 'euclidean'; embed?: EmbedConfig; existOk?: boolean } = {}): Promise<Namespace<M>> {
		const body: { name: string; vector?: { dims: number; metric: 'cosine' | 'euclidean' }; embed?: EmbedConfig } = { name };
		if (opts.dims) body.vector = { dims: opts.dims, metric: opts.metric ?? 'cosine' };
		if (opts.embed) body.embed = opts.embed;
		try {
			await this.call(() => api.createNamespace({ client: this.client, body }));
		} catch (e) {
			if (!(opts.existOk && e instanceof SkimmerDBError && e.status === 409)) throw e;
		}
		return new Namespace<M>(this, name);
	}

	namespaces(opts: { after?: string; limit?: number } = {}): Promise<NamespaceList> {
		return this.call(() => api.listNamespaces({ client: this.client, query: opts }));
	}

	/** Stores your own key for an embedding provider (checked with the provider, kept encrypted, never shown again). Needs an admin key. */
	setEmbeddingKey(provider: 'openai' | 'voyage' | 'gemini' | 'cohere', key: string): Promise<EmbeddingKey> {
		return this.call(() => api.setEmbeddingKey({ client: this.client, path: { provider }, body: { key } }));
	}

	embeddingKeys(): Promise<EmbeddingKeyList> {
		return this.call(() => api.listEmbeddingKeys({ client: this.client }));
	}

	async deleteEmbeddingKey(provider: 'openai' | 'voyage' | 'gemini' | 'cohere'): Promise<void> {
		await this.call(() => api.deleteEmbeddingKey({ client: this.client, path: { provider } }));
	}

	me(): Promise<Me> {
		return this.call(() => api.getMe({ client: this.client }));
	}

	usage(): Promise<Usage> {
		return this.call(() => api.getUsage({ client: this.client }));
	}
}
