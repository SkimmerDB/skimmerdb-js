# skimmerdb

TypeScript / JavaScript client for [SkimmerDB](https://skimmerdb.com): a hosted search
database for apps and AI agents. Make a namespace per user, task or project, write documents,
and find them by exact text or regex with metadata filters, count them, search them by vector
(alone or hybrid), or query their metadata with SQL (beta). No dependencies; Node 18+, Deno,
Bun, browsers and edge runtimes (anything with `fetch`).

## Quick start

```sh
npm install skimmerdb
```

```ts
import { SkimmerDB } from "skimmerdb";

const db = new SkimmerDB("tb_...");           // or set SKIMMERDB_KEY
const ns = db.namespace("support");           // created on first write
await ns.write([{ id: "t-1", text: "Refund requested for order ACME-1042", meta: { status: "open" } }]);
const { hits } = await ns.search("refund", { filter: { status: "open" } });
```

No key yet? Make one at [skimmerdb.com](https://skimmerdb.com/signup), or:

```ts
const db = await SkimmerDB.signup("you@example.com", "a long password"); // one call
console.log(db.key);                          // full access, shown once: keep it
const appKey = await db.createKey("my agent"); // a write key for an app or agent (can't make keys)
```

## More

```ts
await ns.write(docs, { deletes: ["t-2"], wait: true });   // wait: searchable before it answers
await ns.update([{ id: "t-1", meta: { status: "closed" } }]);
await ns.delete(["t-1"]);

const res = await ns.search("E[0-9]{3}", { regex: true, filter: { priority: { gte: 1, lt: 4 } }, limit: 50 });
res.hits; res.next;                           // pass next as cursor for the next page
await ns.count("refund");                     // exact
(await ns.get("t-1")).text;

// vectors: the first write with vectors creates the namespace with their length
const notes = db.namespace("notes");
await notes.write([{ id: "n-1", text: "Webhook timeouts", vector: embedding }]);
await notes.search("timeout", { vector: queryEmbedding, filter: { team: "api" }, limit: 10 });

// SQL over the documents' metadata (beta)
(await ns.sql("SELECT status, COUNT(*) FROM docs WHERE contains(text, 'refund') GROUP BY status")).rows;
```

Errors throw `SkimmerDBError` with `status`, `code` (`not_found`, `invalid`, `rate_limited`, `namespace_limit`, ...), `message`, `fields` (invalid input) and `retryAfter`; 429 and 503 answers
are retried for you (after `Retry-After`) up to 3 times. It talks to
`https://api.skimmerdb.com`; point it at another server with `{ baseUrl }` or `SKIMMERDB_URL`.

## The whole API

Every operation in the [API reference](https://docs.skimmerdb.com/api) is generated
from the [OpenAPI document](https://api.skimmerdb.com/openapi.json) with
[@hey-api/openapi-ts](https://heyapi.dev) into `skimmerdb/api`, typed and named by its
operationId:

```ts
import { search } from "skimmerdb/api";

const { data, error } = await search({ client: db.client, path: { name: "support" }, body: { q: "refund" } });
```

`src/api` is generated (`npm run generate`): don't edit it by hand.

## Tests

The tests run against a SkimmerDB server given by `SKIMMERDB_URL` (they sign up throwaway
accounts, so don't point them at production) and are skipped when none answers. They run
against a local server before every release.

```sh
npm install && SKIMMERDB_URL=http://127.0.0.1:8080 npm test
```

## Source

This repository is a snapshot of the client published with each release; `src/api` is generated
from the OpenAPI document, so changes to it come from the API. Issues and pull requests to the
hand-written layer (`src/index.ts`) are welcome: https://github.com/SkimmerDB/skimmerdb-js
