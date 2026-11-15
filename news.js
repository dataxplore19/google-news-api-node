/**
 * Google News in Node.js: search articles by keyword or date range, monitor new articles, export to CSV.
 *
 * Gets the data through the Apify Actor data_xplorer/google-news-scraper-fast: real article URLs
 * (not news.google.com redirects), source, publication date, image, description and, optionally,
 * the full article text.
 *
 * Examples:
 *   node news.js openai nvidia --timeframe 1d
 *   node news.js "electric cars" --region FR:fr --max 300 --full-text
 *   node news.js tesla --from 2026-10-01 --to 2026-10-31 --max 500
 *   node news.js "my brand" --timeframe 1h --alert      # run it every hour for alerts
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ApifyClient } from 'apify-client';

const ACTOR = 'data_xplorer/google-news-scraper-fast';
const FIELDS = ['keyword', 'publishedAt', 'source', 'title', 'url', 'description', 'image', 'fullText'];
const TIMEFRAMES = ['1h', '1d', '7d', '30d', '1y', 'all'];

const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (cells) => `${cells.map(csvCell).join(',')}\n`;

/** Telegram message if TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are set, console otherwise. */
async function notify(text) {
    const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
    if (!token || !chat) return console.log(text);
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
}

/** Minimal CSV reader (handles quotes, commas and newlines inside cells). */
function readCsv(path) {
    const text = readFileSync(path, 'utf8');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') quoted = false;
            else cell += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [header = [], ...body] = rows;
    return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const { values: opts, positionals: keywords } = parseArgs({
    allowPositionals: true,
    options: {
        timeframe: { type: 'string', default: '1d' },
        from: { type: 'string' },
        to: { type: 'string' },
        region: { type: 'string', default: 'US:en' },
        max: { type: 'string', default: '100' },
        'full-text': { type: 'boolean', default: false },
        alert: { type: 'boolean', default: false },
        out: { type: 'string', default: 'news.csv' },
    },
});

if (!keywords.length) {
    console.log('Usage: node news.js <keyword> [<keyword>...] [--timeframe 1d] [--from YYYY-MM-DD --to YYYY-MM-DD]\n'
        + '       [--region US:en] [--max 100] [--full-text] [--alert] [--out news.csv]');
    process.exit(1);
}
if (!process.env.APIFY_TOKEN) throw new Error('Set the APIFY_TOKEN environment variable.');
if (!TIMEFRAMES.includes(opts.timeframe)) throw new Error(`--timeframe must be one of: ${TIMEFRAMES.join(', ')}`);

const input = {
    keywords,
    maxArticles: Number(opts.max),
    region_language: opts.region,
    decodeUrls: true,
    extractDescriptions: true,
    extractImages: true,
    extractFullText: opts['full-text'],
};
if (opts.from || opts.to) Object.assign(input, { dateFrom: opts.from ?? '', dateTo: opts.to ?? '' });
else input.timeframe = opts.timeframe;

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor(ACTOR).call(input);
const { items: articles } = await client.dataset(run.defaultDatasetId).listItems();
console.log(`${articles.length} articles found`);

const seen = new Set(existsSync(opts.out) ? readCsv(opts.out).map((r) => r.url) : []);
const fresh = articles
    .filter((a) => a.url && !seen.has(a.url))
    .sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''));

if (!existsSync(opts.out)) appendFileSync(opts.out, csvLine(FIELDS));
for (const a of fresh) {
    const row = { ...a, keyword: a.metadata?.keyword ?? '' };
    appendFileSync(opts.out, csvLine(FIELDS.map((f) => row[f])));
    if (opts.alert && seen.size) await notify(`${a.source ?? ''}: ${a.title ?? ''}\n${a.url}`);
}

console.log(`${fresh.length} new articles added to ${opts.out} (${articles.length - fresh.length} already there)`);
if (opts.alert && !seen.size) console.log('First run: articles saved without alerts. The next runs alert on new articles only.');
