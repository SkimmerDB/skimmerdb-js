// The client against a SkimmerDB test server: SKIMMERDB_URL (default http://127.0.0.1:8080).
// It signs up a throwaway account, so never point it at production. Skipped when nothing answers.
//   SKIMMERDB_URL=http://127.0.0.1:8080 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkimmerDB, SkimmerDBError } from '../dist/index.js';
import { search } from '../dist/api/index.js';

const URL = process.env.SKIMMERDB_URL ?? 'http://127.0.0.1:8080';
const up = await fetch(URL + '/healthz').then((r) => r.ok, () => false);
const opts = { skip: up ? false : `no SkimmerDB server at ${URL}` };

const email = `ts-${Math.random().toString(36).slice(2, 12)}@example.com`;
const db = up ? await SkimmerDB.signup(email, 'correct horse', { baseUrl: URL }) : null;

test('quickstart', opts, async () => {
	const ns = db.namespace('support');
	const w = await ns.write(
		[
			{ id: 't-1', text: 'Refund requested for order ACME-1042', meta: { status: 'open', priority: 3 } },
			{ id: 't-2', text: 'Login fails with error E401 on mobile', meta: { status: 'closed', priority: 1 } }
		],
		{ wait: true }
	);
	assert.equal(w.written, 2);
	assert.equal(w.created, true);
	const { hits } = await ns.search('acme-1042', { filter: { status: 'open' } });
	assert.deepEqual(hits.map((h) => h.id), ['t-1']);
	assert.equal(hits[0].line, 'Refund requested for order ACME-1042');
	assert.equal((await ns.search('E[0-9]{3}', { regex: true, filter: { priority: { gte: 1, lt: 4 } } })).hits[0].match, 'E401');
	assert.equal(await ns.count('refund'), 1);
	assert.equal((await ns.get('t-1')).text, 'Refund requested for order ACME-1042');
	await ns.write([{ id: 'a/b c', text: 'an id with a slash and a space' }], { wait: true });
	assert.equal((await ns.get('a/b c')).text, 'an id with a slash and a space');
	await ns.delete(['a/b c'], { wait: true });
});

test('paging, update, delete', opts, async () => {
	const ns = db.namespace('paging');
	await ns.write([0, 1, 2, 3, 4].map((i) => ({ id: `d-${i}`, text: `note ${i}` })), { wait: true });
	const first = await ns.search('note', { limit: 2 });
	assert.equal(first.hits.length, 2);
	const second = await ns.search('note', { limit: 10, cursor: first.next });
	assert.equal(second.hits.length, 3);
	assert.equal(second.next, '');
	await ns.update([{ id: 'd-1', meta: { tag: 'x' } }], { wait: true });
	assert.deepEqual((await ns.get('d-1')).meta, { tag: 'x' });
	await ns.delete(['d-1'], { wait: true });
	await assert.rejects(ns.get('d-1'), (e) => e instanceof SkimmerDBError && e.status === 404);
	assert.equal(await ns.count(), 4);
});

test('vectors, SQL, account', opts, async () => {
	const notes = db.namespace('notes');
	await notes.write(
		[
			{ id: 'n-1', text: 'Webhook timeouts since Tuesday', meta: { team: 'api' }, vector: [0.12, -0.03, 0.99] },
			{ id: 'n-2', text: 'Dark mode request', meta: { team: 'web' }, vector: [0.9, 0.1, 0.05] }
		],
		{ wait: true }
	);
	const v = await notes.search('', { vector: [0.1, 0.0, 0.98], limit: 2 });
	assert.equal(v.hits[0].id, 'n-1');
	assert.ok(v.hits[0].score > 0.9);
	assert.deepEqual((await notes.search('dark', { vector: [0.1, 0.0, 0.98] })).hits.map((h) => h.id), ['n-2']);
	const r = await db.namespace('support').sql('SELECT status, COUNT(*) AS n FROM docs GROUP BY status ORDER BY status');
	assert.deepEqual(r.columns, ['status', 'n']);
	assert.deepEqual(r.rows, [['closed', 1], ['open', 1]]);
	assert.equal((await notes.info()).vector.dims, 3);
	assert.ok((await db.namespaces()).namespaces.some((n) => n.name === 'notes'));
	assert.equal((await db.me()).scope, 'admin');
	const app = new SkimmerDB(await db.createKey('app'), { baseUrl: URL });
	assert.equal((await app.me()).scope, 'write');
	await assert.rejects(app.createKey('more'), (e) => e instanceof SkimmerDBError && e.status === 403 && e.code === 'forbidden');
	assert.ok((await db.usage()).queries > 0);
	await notes.drop();
});

test('errors and the generated layer', opts, async () => {
	await assert.rejects(db.namespace('missing').search('x'), (e) => e instanceof SkimmerDBError && e.status === 404 && e.code === 'not_found' && e.message === 'no such namespace');
	await assert.rejects(db.createNamespace('Bad Name'), (e) => e.status === 422 && e.code === 'invalid');
	await assert.rejects(SkimmerDB.signup('not-an-email', '1', { baseUrl: URL }), (e) => e.status === 422 && e.code === 'invalid' && 'password' in e.fields);
	await assert.rejects(new SkimmerDB('tb_nope', { baseUrl: URL }).namespaces(), (e) => e.status === 401);
	const { data } = await search({ client: db.client, path: { name: 'support' }, body: { q: 'refund' } });
	assert.deepEqual(data.hits.map((h) => h.id), ['t-1']);
});
