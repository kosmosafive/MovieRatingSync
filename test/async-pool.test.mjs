import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const FILES = [
    new URL('../movie-rating-sync.user.js', import.meta.url),
    new URL('../extension/content.js', import.meta.url),
];

function loadAsyncPool(url) {
    const src = readFileSync(url, 'utf8');
    const start = src.indexOf('async function asyncPool(');
    const end = src.indexOf('\n    function adjDelay(', start);
    assert.ok(start >= 0 && end > start, `asyncPool not found in ${url.pathname}`);
    const asyncPool = new Function(`${src.slice(start, end)}\nreturn asyncPool;`)();
    return { src, asyncPool };
}

// Pre-fix pool: calls worker().then and therefore rejects when the worker
// returns a plain value. Kept here so the regression test does not depend on git.
async function asyncPoolBroken(concurrency, items, worker) {
    const results = new Array(items.length);
    let index = 0;
    const executing = new Set();

    async function next() {
        while (index < items.length) {
            const i = index++;
            const promise = worker(items[i], i).then(
                r => ({ status: 'fulfilled', value: r }),
                e => ({ status: 'rejected', reason: e })
            );
            results[i] = promise;
            executing.add(promise);
            try {
                await promise;
            } finally {
                executing.delete(promise);
            }
            if (executing.size >= concurrency) await Promise.race(executing);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
    await Promise.all(workers);
    return await Promise.all(results);
}

// Mirrors resolveIMDb + the imdbProcess search worker (deep = false on the first pass).
function imdbSearchWorker(lookupTitle, deep) {
    const resolveIMDb = (title, year) => lookupTitle(title, year) ?? (deep ? Promise.resolve('tt-http') : null);
    return i => (i.ttId && /^tt\d+$/.test(i.ttId) ? Promise.resolve(i.ttId) : resolveIMDb(i.title, i.year));
}

test('shipped asyncPool wraps the worker result in Promise.resolve', () => {
    for (const url of FILES) {
        const { src } = loadAsyncPool(url);
        assert.equal(src.includes('worker(items[i], i).then'), false, url.pathname);
        assert.match(src, /Promise\.resolve\(worker\(items\[i\], i\)\)\.then\(/);
        assert.match(src, /lookupTitle\(title, year\) \?\? \(deep \? searchIMDbFallback\(title, year\) : null\)/);
    }
});

test('broken pool rejects with the reported TypeError on a synchronous tt id', async () => {
    const worker = imdbSearchWorker(() => 'tt0111161', false);
    await assert.rejects(
        () => asyncPoolBroken(20, [{ title: 'Побег из Шоушенка', year: 1994, ttId: '' }], worker),
        err => err instanceof TypeError && err.message === 'worker(...).then is not a function'
    );
});

test('broken pool rejects differently on a synchronous null miss', async () => {
    const worker = imdbSearchWorker(() => null, false);
    await assert.rejects(
        () => asyncPoolBroken(20, [{ title: 'Неизвестный фильм', year: 1970, ttId: '' }], worker),
        err => err instanceof TypeError && err.message === "Cannot read properties of null (reading 'then')"
    );
});

test('fixed pool accepts sync tt ids, null misses, and promises in one batch', async () => {
    for (const url of FILES) {
        const { asyncPool } = loadAsyncPool(url);
        const writes = [];
        const lookup = title => (title === 'Known' ? 'tt0000100' : null);
        const worker = imdbSearchWorker(lookup, false);
        const items = [
            { title: 'Known', year: 1999, ttId: '' },
            { title: 'Missing', year: 2001, ttId: '' },
            { title: 'Already', year: 2010, ttId: 'tt1234567' },
            { title: 'Slow', year: 2011, ttId: 'slow' },
        ];
        const searchWorker = i => (i.ttId === 'slow' ? Promise.resolve('tt7654321') : worker(i));

        const res = await asyncPool(20, items, searchWorker);
        assert.equal(writes.length, 0, 'search must not write ratings');

        assert.deepEqual(res.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
        assert.deepEqual(res.map(r => r.value), ['tt0000100', null, 'tt1234567', 'tt7654321']);

        for (const row of res) {
            if (row.status === 'fulfilled' && row.value) writes.push(row.value);
        }
        assert.deepEqual(writes, ['tt0000100', 'tt1234567', 'tt7654321']);
    }
});

test('fixed pool keeps a rejected worker inside the result instead of aborting the batch', async () => {
    const { asyncPool } = loadAsyncPool(FILES[0]);
    const res = await asyncPool(2, [1, 2, 3], async n => {
        if (n === 2) throw new Error('rate limited');
        return `ok-${n}`;
    });
    assert.equal(res[0].status, 'fulfilled');
    assert.equal(res[0].value, 'ok-1');
    assert.equal(res[1].status, 'rejected');
    assert.equal(res[1].reason.message, 'rate limited');
    assert.equal(res[2].status, 'fulfilled');
    assert.equal(res[2].value, 'ok-3');
});

test('fixed pool preserves input order and the concurrency cap', async () => {
    const { asyncPool } = loadAsyncPool(FILES[0]);
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);
    const res = await asyncPool(4, items, async n => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, n === 0 ? 40 : 5));
        active--;
        return n;
    });
    assert.equal(maxActive, 4);
    assert.deepEqual(res.map(r => r.value), items);
});

test('shallow search of a Kinopoisk-sized batch finishes with no writes on failure-shaped rows', async () => {
    const { asyncPool } = loadAsyncPool(FILES[0]);
    let mutations = 0;
    const applyIMDb = () => { mutations++; };
    const items = Array.from({ length: 1886 }, (_, i) => ({
        title: i === 0 ? 'Known' : `Film ${i}`,
        year: 1980 + (i % 40),
        ttId: i % 50 === 0 && i !== 0 ? `tt${1000000 + i}` : '',
    }));
    const worker = imdbSearchWorker(title => (title === 'Known' ? 'tt0111161' : null), false);

    const resolved = [];
    let cur = 0;
    const concurrency = 20;
    while (cur < items.length) {
        const slice = items.slice(cur, cur + concurrency);
        const res = await asyncPool(concurrency, slice, worker);
        res.forEach((r, j) => {
            const ttId = r.status === 'fulfilled' ? r.value : null;
            resolved.push({ item: slice[j], ttId });
        });
        cur += concurrency;
    }
    assert.equal(mutations, 0);
    assert.equal(resolved.length, 1886);
    assert.equal(resolved[0].ttId, 'tt0111161');
    assert.equal(resolved[1].ttId, null);
    assert.equal(resolved[50].ttId, 'tt1000050');

    for (const row of resolved) {
        if (row.ttId) applyIMDb(row.ttId);
    }
    assert.equal(mutations, resolved.filter(r => r.ttId).length);
});

test('broken pool aborts the first 20-item search slice before any apply call', async () => {
    let mutations = 0;
    const items = Array.from({ length: 20 }, (_, i) => ({
        title: i === 0 ? 'Known' : `Film ${i}`,
        year: 1994,
        ttId: '',
    }));
    const worker = imdbSearchWorker(title => (title === 'Known' ? 'tt0111161' : null), false);
    await assert.rejects(
        () => asyncPoolBroken(20, items, worker),
        err => err instanceof TypeError && err.message === 'worker(...).then is not a function'
    );
    assert.equal(mutations, 0);
});
