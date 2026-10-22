// Type-level tests of typed metadata (no server): `npm run typecheck`. Each @ts-expect-error
// line must fail to compile, so a mistake the types should catch can't slip through unnoticed.
import { SkimmerDB } from '../src/index.js';

type Ticket = { status: 'open' | 'closed'; priority: number; ts: number; urgent?: boolean; tags?: string[] };

async function typed(db: SkimmerDB) {
	const t = db.namespace<Ticket>('support');
	await t.write([{ id: 't-1', text: 'Refund', meta: { status: 'open', priority: 3, ts: 1760572800 } }]);
	// @ts-expect-error: a status Ticket doesn't have
	await t.write([{ id: 't-2', meta: { status: 'pending', priority: 1, ts: 0 } }]);
	// @ts-expect-error: priority is a number
	await t.write([{ id: 't-3', meta: { status: 'open', priority: 'high', ts: 0 } }]);
	await t.update([{ id: 't-1', meta: { status: 'closed', urgent: null } }]);

	const r = await t.search('refund', { filter: { status: 'open', priority: { gte: 2, lt: 5 }, urgent: true, ts: [1, 2] } });
	const p: number = r.hits[0].meta.priority;
	const s: 'open' | 'closed' = r.hits[0].meta.status;
	await t.search('', { filter: { status: ['open', 'closed'] } });
	// @ts-expect-error: no such key
	await t.search('', { filter: { team: 'api' } });
	// @ts-expect-error: ranges only on numbers
	await t.search('', { filter: { status: { gte: 'a' } } });
	// @ts-expect-error: arrays can't be filtered (the server compares whole values)
	await t.search('', { filter: { tags: 'urgent' } });
	await t.count('', { filter: { priority: { gt: 1 } } });
	const d = await t.get('t-1');
	const ts: number = d.meta.ts;

	// untyped namespaces keep taking anything
	const u = db.namespace('free');
	await u.write([{ id: 'x', meta: { anything: [1, 2], nested: { ok: true } } }]);
	await u.search('', { filter: { whatever: { gte: 1 } } });
	const v: unknown = (await u.search('')).hits[0].meta['anything'];
	return [p, s, ts, v];
}
void typed;
