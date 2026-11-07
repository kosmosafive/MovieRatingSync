#!/usr/bin/env node
// Fill empty TtId cells from a local copy of IMDb's documented title.basics dataset.
// Does not download the file and does not contact IMDb, Kinopoisk, or any account.
// Dataset docs: https://developer.imdb.com/non-commercial-datasets/
// File: https://datasets.imdbws.com/title.basics.tsv.gz
// Personal and non-commercial use only; the license is IMDb's, not this script's.

import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const YEAR_TOL = 1;
const ALLOWED_TYPES = new Set(['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries', 'tvSpecial', 'video']);

export function normTitle(s) {
    return String(s ?? '').toLowerCase().replace(/[\-–—.,!?'"«»()\[\]\\\/]/g, ' ').replace(/\s+/g, ' ').trim();
}

function yearOf(value) {
    const y = parseInt(String(value ?? '').match(/^(\d{4})/)?.[1], 10);
    return Number.isNaN(y) ? null : y;
}

export function yearsClose(a, b) {
    const ya = yearOf(a);
    const yb = yearOf(b);
    return ya != null && yb != null && Math.abs(ya - yb) <= YEAR_TOL;
}

function splitCsvLine(line) {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            cells.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    cells.push(current);
    return cells;
}

function csvEsc(s) {
    const v = String(s ?? '');
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function splitLines(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export function parseRatingsCsv(text) {
    const lines = splitLines(text).filter(l => l.trim());
    if (lines.length < 2) return { header: [], rows: [] };
    const header = splitCsvLine(lines[0]);
    const rows = lines.slice(1).map(line => {
        const cells = splitCsvLine(line);
        const obj = {};
        header.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
        return obj;
    });
    return { header, rows };
}

function col(row, header, ...names) {
    for (const h of header) {
        if (names.includes(h.toLowerCase().trim())) return row[h] ?? '';
    }
    return '';
}

export function ratingView(row, header) {
    const titleOrig = col(row, header, 'titleorig');
    const titleRu = col(row, header, 'titleru');
    const title = col(row, header, 'title');
    return {
        titleOrig,
        titleRu,
        title: title || titleOrig || titleRu,
        year: col(row, header, 'yearstart', 'year'),
        ttId: col(row, header, 'ttid').trim(),
    };
}

export function titlesNeeded(header, rows) {
    const needed = new Set();
    for (const row of rows) {
        const view = ratingView(row, header);
        if (/^tt\d+$/.test(view.ttId)) continue;
        for (const raw of [view.titleOrig, view.titleRu, view.title]) {
            const key = normTitle(raw);
            if (key) needed.add(key);
        }
    }
    return needed;
}

function takeBasicsRow(header, cells, needed, index) {
    const at = name => cells[header.indexOf(name)] ?? '';
    const titleType = at('titleType');
    if (!ALLOWED_TYPES.has(titleType)) return;
    const tconst = at('tconst');
    if (!/^tt\d+$/.test(tconst)) return;
    const rec = { tconst, year: at('startYear') };
    const keys = new Set([normTitle(at('primaryTitle')), normTitle(at('originalTitle'))].filter(k => k && needed.has(k)));
    for (const key of keys) {
        let list = index.get(key);
        if (!list) index.set(key, list = []);
        list.push(rec);
    }
}

export function indexBasicsText(text, needed) {
    const index = new Map();
    const lines = splitLines(text);
    if (!lines.length) return index;
    const header = lines[0].split('\t');
    for (const line of lines.slice(1)) {
        if (!line) continue;
        takeBasicsRow(header, line.split('\t'), needed, index);
    }
    return index;
}

export async function indexBasicsFile(path, needed) {
    const index = new Map();
    const raw = createReadStream(path);
    const input = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
    const rl = createInterface({ input, crlfDelay: Infinity });
    let header = null;
    for await (const line of rl) {
        if (!header) { header = line.split('\t'); continue; }
        if (!line) continue;
        takeBasicsRow(header, line.split('\t'), needed, index);
    }
    return index;
}

export function matchView(view, index) {
    if (/^tt\d+$/.test(view.ttId)) return { ttId: view.ttId, status: 'kept' };
    if (yearOf(view.year) == null) return { ttId: '', status: 'no-year' };
    const ids = new Set();
    for (const raw of new Set([view.titleOrig, view.titleRu, view.title])) {
        const key = normTitle(raw);
        if (!key) continue;
        for (const rec of index.get(key) ?? []) {
            if (yearsClose(rec.year, view.year)) ids.add(rec.tconst);
        }
    }
    if (ids.size === 1) return { ttId: [...ids][0], status: 'filled' };
    if (ids.size > 1) return { ttId: '', status: 'ambiguous' };
    return { ttId: '', status: 'unmatched' };
}

function ensureTtColumn(header) {
    const idx = header.findIndex(h => h.toLowerCase().trim() === 'ttid');
    if (idx >= 0) return { header, idx };
    const next = header.slice();
    next.push('TtId');
    return { header: next, idx: next.length - 1 };
}

export function enrichTable(header, rows, index) {
    const tt = ensureTtColumn(header);
    const counts = { filled: 0, kept: 0, ambiguous: 0, unmatched: 0, 'no-year': 0 };
    const outRows = rows.map(row => {
        const view = ratingView(row, header);
        const match = matchView(view, index);
        counts[match.status] += 1;
        const cells = tt.header.map((h, i) => (i === tt.idx ? '' : (row[h] ?? '')));
        if (match.ttId) cells[tt.idx] = match.ttId;
        else if (tt.idx < header.length) cells[tt.idx] = row[header[tt.idx]] ?? '';
        return cells;
    });
    return { header: tt.header, rows: outRows, counts };
}

export function serializeCsv(header, rows) {
    return [header.map(csvEsc).join(','), ...rows.map(cells => cells.map(csvEsc).join(','))].join('\n') + '\n';
}

export function enrichCsvText(csvText, basicsText) {
    const { header, rows } = parseRatingsCsv(csvText);
    const index = indexBasicsText(basicsText, titlesNeeded(header, rows));
    const enriched = enrichTable(header, rows, index);
    return { csv: serializeCsv(enriched.header, enriched.rows), counts: enriched.counts };
}

function usage() {
    return [
        'Usage: node scripts/enrich-imdb-ids.mjs --csv ratings.csv --basics title.basics.tsv[.gz] --out ratings-with-tt.csv',
        'Download title.basics yourself from https://datasets.imdbws.com/title.basics.tsv.gz',
        'Documentation: https://developer.imdb.com/non-commercial-datasets/',
        'The dataset is for personal and non-commercial use under IMDb terms.',
    ].join('\n');
}

async function main(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!key.startsWith('--')) continue;
        args[key.slice(2)] = argv[i + 1];
        i++;
    }
    if (!args.csv || !args.basics || !args.out) {
        console.error(usage());
        return 2;
    }
    const csvText = await readFile(args.csv, 'utf8');
    const { header, rows } = parseRatingsCsv(csvText);
    const index = await indexBasicsFile(args.basics, titlesNeeded(header, rows));
    const enriched = enrichTable(header, rows, index);
    await writeFile(args.out, serializeCsv(enriched.header, enriched.rows));
    console.error(JSON.stringify(enriched.counts));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
        console.error(err?.message || err);
        process.exit(1);
    });
}
