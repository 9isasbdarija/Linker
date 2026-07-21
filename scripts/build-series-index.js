// build-series-index.js
//
// Fetches all posts (metadata only) from a Blogger blog via API v3,
// groups them by label, sorts each group by published date,
// and writes one JSON file per label to output/series/<slug>.json
//
// Required environment variables:
//   BLOGGER_API_KEY  - Google Cloud API key with Blogger API v3 enabled
//   BLOG_ID          - Numeric Blogger blog ID
//
// Usage:
//   BLOGGER_API_KEY=xxx BLOG_ID=123456 node scripts/build-series-index.js

const fs = require('fs');
const path = require('path');
const { slugify } = require('./fnv-slugify.js');

const API_KEY = process.env.BLOGGER_API_KEY;
const BLOG_ID = process.env.BLOG_ID;
const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'series');
const LOG_DIR = path.join(__dirname, '..', 'output', 'logs');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(LOG_DIR, `${RUN_ID}.log`);
const RAW_DIR = path.join(LOG_DIR, `${RUN_ID}-raw`);
const DEBUG = process.env.DEBUG === '1'; // ponytail: env-gated, not machine-detected

if (DEBUG) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = DEBUG ? fs.createWriteStream(LOG_FILE, { flags: 'a' }) : null;

// Log to both console and the run's log file.
function log(...args) {
  const line = args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ');
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}
function logError(...args) {
  const line = args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ');
  console.error(line);
  logStream.write('ERROR: ' + line + '\n');
}

if (!API_KEY || !BLOG_ID) {
  logError('BLOGGER_API_KEY and BLOG_ID environment variables are required.');
  process.exit(1);
}

const BASE_URL = `https://www.googleapis.com/blogger/v3/blogs/${BLOG_ID}/posts`;
const MAX_RESULTS = 500; // max allowed by Blogger API v3 when fetchBodies=false
const FIELDS = 'items(title,url,labels,published,images)';

// Fetch a single page of posts, optionally bounded by endDate (inclusive).
async function fetchPage(endDate, pageNum) {
  const url = new URL(BASE_URL);
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('fetchBodies', 'false');
  url.searchParams.set('fetchImages', 'true');
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('orderBy', 'published');
  if (endDate) url.searchParams.set('endDate', endDate);

  const res = await fetch(url.toString());
  const bodyText = await res.text();

  // Save the raw response for debugging, success or failure.
  if (DEBUG) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, `page-${pageNum}.json`), bodyText);
  }

  if (!res.ok) {
    throw new Error(`Blogger API error ${res.status}: ${bodyText}`);
  }
  return JSON.parse(bodyText);
}

// Fetch all posts by walking backward through published dates using endDate,
// instead of Blogger's pageToken. pageToken's cursor is based on the published
// timestamp, not a unique row ID, so when a page boundary falls in the middle
// of a group of posts sharing the exact same published timestamp, some of
// those posts get silently skipped. To avoid that: whenever a page comes back
// full (MAX_RESULTS items), we don't trust the last timestamp group on that
// page to be complete (it may have been cut off), so we hold those posts back
// and re-fetch starting from the previous distinct timestamp instead. That
// re-fetch pulls the held-back group in full (deduped) and continues.
async function fetchAllPosts() {
  const seen = new Set(); // post urls already collected
  const posts = [];

  function addUnique(item) {
    if (seen.has(item.url)) return;
    seen.add(item.url);
    posts.push(item);
  }

  let endDate;
  let page = 1;

  for (;;) {
    log(`Fetching page ${page}${endDate ? ` (endDate: ${endDate})` : ''}...`);
    const data = await fetchPage(endDate, page);
    const items = data.items || [];
    if (items.length === 0) break;

    if (items.length < MAX_RESULTS) {
      // Short page: nothing after it, so nothing here can have been truncated.
      items.forEach(addUnique);
      break;
    }

    // Full page: the last timestamp group may be incomplete. Find where it starts.
    const lastTs = items[items.length - 1].published;
    let boundary = items.length - 1;
    while (boundary > 0 && items[boundary - 1].published === lastTs) boundary--;

    if (boundary === 0) {
      // ponytail: every post on this page shares one timestamp, so there's no
      // safe earlier boundary to re-anchor on. Accept the page as-is; this only
      // matters if >MAX_RESULTS posts share one exact published timestamp.
      logError(`All ${items.length} posts on page ${page} share timestamp ${lastTs}; cannot verify completeness.`);
      items.forEach(addUnique);
      break;
    }

    // Everything before the (possibly incomplete) tail group is safe to keep.
    for (let i = 0; i < boundary; i++) addUnique(items[i]);

    // Re-anchor on the last fully-confirmed group; it'll come back (deduped)
    // along with the rest of the tail group on the next fetch.
    endDate = items[boundary - 1].published;
    page++;
  }

  return posts;
}

// Group posts by each of their labels.
function groupByLabel(posts) {
  const groups = new Map(); // slug -> { label, posts: [] }

  for (const post of posts) {
    if (!post.labels || !post.url || !post.title) continue;

    for (const label of post.labels) {
      const slug = slugify(label);
      if (!slug) continue;

      if (!groups.has(slug)) {
        groups.set(slug, { label, posts: [] });
      }
      const entry = {
        title: post.title,
        url: post.url,
        published: post.published,
        labels: post.labels
      };
      if (post.images && post.images[0] && post.images[0].url) {
        entry.image = post.images[0].url;
      }
      groups.get(slug).posts.push(entry);
    }
  }

  // Sort each group's posts chronologically by published date.
  for (const group of groups.values()) {
    group.posts.sort((a, b) => new Date(a.published) - new Date(b.published));
  }

  return groups;
}

// Write one JSON file per label group, plus an index of all labels.
function writeOutput(groups) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const labelIndex = [];

  for (const [slug, group] of groups.entries()) {
    const filePath = path.join(OUTPUT_DIR, `${slug}.json`);
    fs.writeFileSync(filePath, JSON.stringify(group.posts));
    labelIndex.push({
      label: group.label,
      slug,
      count: group.posts.length,
    });
  }

  // Sort the label index alphabetically for readability.
  labelIndex.sort((a, b) => a.label.localeCompare(b.label));

  fs.writeFileSync(
    path.join(__dirname, '..', 'output', 'all-labels.json'),
    JSON.stringify(labelIndex)
  );

  return labelIndex;
}

async function main() {
  log(`Run started. Log file: ${LOG_FILE}`);
  log(`Fetching all posts for blog ${BLOG_ID}...`);
  const posts = await fetchAllPosts();
  log(`Fetched ${posts.length} posts.`);

  const groups = groupByLabel(posts);
  log(`Found ${groups.size} unique labels.`);

  const labelIndex = writeOutput(groups);

  log(`Wrote ${labelIndex.length} series files to ${OUTPUT_DIR}`);
  log('Done.');
}

main()
  .catch((err) => {
    logError('Build failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (logStream) logStream.end();
  });