import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FILES = [
    new URL('../movie-rating-sync.user.js', import.meta.url),
    new URL('../extension/content.js', import.meta.url),
];

function loadBlock(url) {
    const src = readFileSync(url, 'utf8');
    const start = src.indexOf('function blockFromFindStatus');
    const end = src.indexOf('\n    function registerTitle', start);
    assert.ok(start >= 0 && end > start, url.pathname);
    const blockFromFindStatus = new Function(`${src.slice(start, end)}\nreturn blockFromFindStatus;`)();
    return { src, blockFromFindStatus };
}

test('5xx from the find page stops the search; 4xx does not', () => {
    for (const url of FILES) {
        const { src, blockFromFindStatus } = loadBlock(url);
        for (const status of [500, 503, 599]) {
            const err = blockFromFindStatus(status);
            assert.equal(err.code, 'IMDB_FIND_UNAVAILABLE');
            assert.equal(err.status, status);
        }
        for (const status of [404, 429, 200, 0]) assert.equal(blockFromFindStatus(status), null);
        assert.equal(blockFromFindStatus(undefined), null);
        assert.match(src, /https:\/\/www\.imdb\.com\/find\/\?q=/);
        assert.equal(src.includes('datasets.imdbws.com'), false);
        assert.equal(src.includes('proxy'), false);
    }
});
