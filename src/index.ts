// SkimmerDB: search for your apps and AI agents.
//
//   import { SkimmerDB } from "skimmerdb";
//   const db = new SkimmerDB("tb_...");                 // or SKIMMERDB_KEY
//   const ns = db.namespace("support");                 // the first write makes it
//   await ns.write([{ id: "t-1", text: "Refund requested for order ACME-1042", meta: { status: "open" } }]);
//   const { hits } = await ns.search("refund", { filter: { status: "open" } });
//
// This file is the thin, hand-written layer. Every operation is also generated from the OpenAPI
// document (https://api.skimmerdb.com/openapi.json) into ./api (import from "skimmerdb/api"), named
// by its operationId; db.client is the configured client to pass them:
//   import { search } from "skimmerdb/api";
//   const { data } = await search({ client: db.client, path: { name: "support" }, body: { q: "refund" } });
import { createClient, createConfig, type Client } from './api/client/index.js';
import * as api from './api/sdk.gen.js';
import type {
	CountResult,
	Document,
	DocumentPatch,
	Filter,
	Me,
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

export type SearchOptions = Omit<SearchRequest, 'q'> & { filter?: Filter };

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

/** One namespace: `db.namespace("support")`. Nothing is sent until a method is called; the server makes it on the first write if it doesn't exist (with vectors of the first vector's length when the documents have them; the answer's `created` says so). */
export class Namespace {
	constructor(
		readonly db: SkimmerDB,
		readonly name: string
	) {}

	private get path() {
		return { name: this.name };
	}

	/** Puts (inserts or replaces) documents and deletes ids: up to 10,000 a call. `wait`: answer once they're searchable (they're durable either way). */
	async write(docs: Document[], opts: { deletes?: string[]; wait?: boolean } = {}): Promise<WriteResult> {
		const body = { docs, deletes: opts.deletes, wait: opts.wait };
		return this.db.call(() => api.writeDocuments({ client: this.db.client, path: this.path, body }));
	}

	/** Changes existing documents: text replaced if given, meta merged key by key (null removes a key). */
	update(docs: DocumentPatch[], opts: { wait?: boolean } = {}): Promise<WriteResult> {
		return this.db.call(() => api.updateDocuments({ client: this.db.client, path: this.path, body: { docs, wait: opts.wait } }));
	}

	delete(ids: string[], opts: { wait?: boolean } = {}): Promise<WriteResult> {
		return this.db.call(() => api.deleteDocuments({ client: this.db.client, path: this.path, body: { ids, wait: opts.wait } }));
	}

	/** Exact text (literal, ignoring case) or regex, newest first; with `vector`, the nearest documents (`q` and `filter` narrow them: hybrid). Pass `next` as `cursor` for the next page. */
	search(q = '', opts: SearchOptions = {}): Promise<SearchResult> {
		return this.db.call(() => api.search({ client: this.db.client, path: this.path, body: { ...opts, q } }));
	}

	/** How many documents match (exact; `exact: false` estimates). */
	async count(q = '', opts: { filter?: Filter; regex?: boolean; exact?: boolean } = {}): Promise<number> {
		return (await this.countResult(q, opts)).count;
	}

	countResult(q = '', opts: { filter?: Filter; regex?: boolean; exact?: boolean } = {}): Promise<CountResult> {
		return this.db.call(() => api.count({ client: this.db.client, path: this.path, body: { ...opts, q } }));
	}

	/** One document, whole (a SkimmerDBError with status 404 when there's none). */
	get(id: string): Promise<StoredDocument> {
		return this.db.call(() => api.getDocument({ client: this.db.client, path: { name: this.name, id } }));
	}

	/** (beta) One SELECT ... FROM docs over the documents' metadata. */
	sql(query: string): Promise<SqlResult> {
		return this.db.call(() => api.querySql({ client: this.db.client, path: this.path, body: { sql: query } }));
	}

	/** Opens the namespace ahead of queries (and fetches what these searches need). */
	warm(queries: string[] = []): Promise<WarmResult> {
		return this.db.call(() => api.warmNamespace({ client: this.db.client, path: this.path, body: { queries } }));
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

	constructor(key?: string, opts: Options = {}) {
		this.key = key || env('SKIMMERDB_KEY');
		if (!this.key) throw new SkimmerDBError(401, 'no API key: pass new SkimmerDB(key) or set SKIMMERDB_KEY (make one at https://skimmerdb.com/dashboard)');
		this.baseUrl = baseUrl(opts.baseUrl);
		this.retries = opts.retries ?? 3;
		this.client = createClient(createConfig({ baseUrl: this.baseUrl, auth: this.key, fetch: opts.fetch }));
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

	namespace(name: string): Namespace {
		return new Namespace(this, name);
	}

	/** Creates a namespace (`dims`: give it vectors of that length). */
	async createNamespace(name: string, opts: { dims?: number; metric?: 'cosine' | 'euclidean'; existOk?: boolean } = {}): Promise<Namespace> {
		const body = opts.dims ? { name, vector: { dims: opts.dims, metric: opts.metric ?? 'cosine' } } : { name };
		try {
			await this.call(() => api.createNamespace({ client: this.client, body }));
		} catch (e) {
			if (!(opts.existOk && e instanceof SkimmerDBError && e.status === 409)) throw e;
		}
		return new Namespace(this, name);
	}

	namespaces(opts: { after?: string; limit?: number } = {}): Promise<NamespaceList> {
		return this.call(() => api.listNamespaces({ client: this.client, query: opts }));
	}

	me(): Promise<Me> {
		return this.call(() => api.getMe({ client: this.client }));
	}

	usage(): Promise<Usage> {
		return this.call(() => api.getUsage({ client: this.client }));
	}
}
