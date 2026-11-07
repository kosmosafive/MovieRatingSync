import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { enrichCsvText, normTitle } from '../scripts/enrich-imdb-ids.mjs';

const BASICS = [
    'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
    'tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama',
    'tt0111162\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1950\t\\N\t90\tDrama',
    'tt9990001\ttvEpisode\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t40\tDrama',
    'tt0137523\tmovie\tFight Club\tFight Club\t0\t1999\t\\N\t139\tDrama',
    'tt0137524\tmovie\tFight Club\tFight Club\t0\t1998\t\\N\t100\tDrama',
    'tt0903747\ttvSeries\tBreaking Bad\tBreaking Bad\t0\t2008\t2013\t49\tCrime,Drama',
    'tt0000009\tshort\tThe Short\tThe Short\t0\t2001\t\\N\t5\tShort',
].join('\n');

const CSV = [
    'TitleRu,TitleOrig,Type,KpId,TtId,LbSlug,YearStart,YearEnd,Rating10,Genres',
    '"Побег из Шоушенка","The Shawshank Redemption",Film,326,,,"1994",,9,"драма"',
    '"Бойцовский клуб","Fight Club",Film,361,,,"1999",,8,"драма"',
    '"Во все тяжкие","Breaking Bad",TvSeries,404900,,,"2008",2013,10,"криминал"',
    '"Только по-русски","",Film,1,,,"1994",,7,""',
    '"Без года","Mystery Title",Film,2,,,"",,6,""',
    '"Уже есть","Already There",Film,3,tt0000999,,2000,,5,""',
    '"Короткометражка","The Short",Film,4,,,"2001",,4,""',
].join('\n');

test('unique original title and year fills TtId; collisions and gaps stay empty', () => {
    const { csv, counts } = enrichCsvText(CSV, BASICS);
    const lines = csv.trim().split('\n');
    const tt = i => lines[i].split(',')[4];
    assert.equal(normTitle('The Shawshank Redemption'), 'the shawshank redemption');
    assert.equal(tt(1), 'tt0111161');
    assert.equal(tt(2), '');
    assert.equal(tt(3), 'tt0903747');
    assert.equal(tt(4), '');
    assert.equal(tt(5), '');
    assert.equal(tt(6), 'tt0000999');
    assert.equal(tt(7), '');
    assert.deepEqual(counts, { filled: 2, kept: 1, ambiguous: 1, unmatched: 2, 'no-year': 1 });
});

test('cli reads a gzipped basics file and does not require a network call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrs-enrich-'));
    try {
        const csvPath = join(dir, 'in.csv');
        const basicsPath = join(dir, 'title.basics.tsv.gz');
        const outPath = join(dir, 'out.csv');
        await writeFile(csvPath, CSV);
        await writeFile(basicsPath, gzipSync(BASICS));
        const run = spawnSync(process.execPath, [
            new URL('../scripts/enrich-imdb-ids.mjs', import.meta.url).pathname,
            '--csv', csvPath,
            '--basics', basicsPath,
            '--out', outPath,
        ], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        const out = await readFile(outPath, 'utf8');
        assert.match(out, /tt0111161/);
        assert.match(out, /tt0000999/);
        assert.doesNotMatch(run.stderr, /http/i);
        assert.deepEqual(JSON.parse(run.stderr), { filled: 2, kept: 1, ambiguous: 1, unmatched: 2, 'no-year': 1 });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
