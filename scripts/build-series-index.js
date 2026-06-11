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
const crypto = require('crypto');

const API_KEY = process.env.BLOGGER_API_KEY;
const BLOG_ID = process.env.BLOG_ID;
const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'series');

if (!API_KEY || !BLOG_ID) {
  console.error('Error: BLOGGER_API_KEY and BLOG_ID environment variables are required.');
  process.exit(1);
}

const BASE_URL = `https://www.googleapis.com/blogger/v3/blogs/${BLOG_ID}/posts`;
const MAX_RESULTS = 500; // max allowed by Blogger API v3 when fetchBodies=false
const FIELDS = 'nextPageToken,items(title,url,labels,published)';

// Slugify a label for use as a filename/URL segment.
// All labels are hashed uniformly (deterministic MD5-based), avoiding
// any edge cases with collisions, mixed-script labels, or unsafe
// filename characters. The human-readable label is preserved separately
// in all-labels.json for lookup/debugging.
function slugify(label) {
  const hash = crypto.createHash('md5').update(label).digest('hex').slice(0, 10);
  return 'l-' + hash;
}

// Fetch a single page of posts.
async function fetchPage(pageToken) {
  const url = new URL(BASE_URL);
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('fetchBodies', 'false');
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('orderBy', 'published');
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Blogger API error ${res.status}: ${body}`);
  }
  return res.json();
}

// Fetch all posts across all pages.
async function fetchAllPosts() {
  let posts = [];
  let pageToken = undefined;
  let page = 1;

  do {
    console.log(`Fetching page ${page}${pageToken ? ` (token: ${pageToken.slice(0, 12)}...)` : ''}...`);
    const data = await fetchPage(pageToken);
    const items = data.items || [];
    posts = posts.concat(items);
    pageToken = data.nextPageToken;
    page++;
  } while (pageToken);

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
      groups.get(slug).posts.push({
        title: post.title,
        url: post.url,
        published: post.published,
      });
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
    fs.writeFileSync(filePath, JSON.stringify(group.posts, null, 2));
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
    JSON.stringify(labelIndex, null, 2)
  );

  return labelIndex;
}

async function main() {
  console.log(`Fetching all posts for blog ${BLOG_ID}...`);
  const posts = await fetchAllPosts();
  console.log(`Fetched ${posts.length} posts.`);

  const groups = groupByLabel(posts);
  console.log(`Found ${groups.size} unique labels.`);

  const labelIndex = writeOutput(groups);

  console.log(`Wrote ${labelIndex.length} series files to ${OUTPUT_DIR}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
