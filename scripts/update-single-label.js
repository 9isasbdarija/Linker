// update-single-label.js
//
// Fetches posts for a SINGLE specific label from Blogger API v3,
// sorts them chronologically, and overwrites that specific label's JSON file.
//
// Required environment variables:
//   BLOGGER_API_KEY  - Google Cloud API key
//   BLOG_ID          - Numeric Blogger blog ID
//
// Usage:
//   BLOGGER_API_KEY=xxx BLOG_ID=123 node scripts/update-single-label.js "Story of Something"

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_KEY = process.env.BLOGGER_API_KEY;
const BLOG_ID = process.env.BLOG_ID;
const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'series');

// 1. Grab the target label passed from GitHub Actions
const TARGET_LABEL = process.argv[2];

if (!API_KEY || !BLOG_ID) {
  console.error('Error: BLOGGER_API_KEY and BLOG_ID environment variables are required.');
  process.exit(1);
}

if (!TARGET_LABEL) {
  console.error('Error: Please provide a target label as an argument.');
  console.log('Usage: node update-single-label.js "Story Of Something"');
  process.exit(1);
}

const BASE_URL = `https://www.googleapis.com/blogger/v3/blogs/${BLOG_ID}/posts`;
const MAX_RESULTS = 500;
const FIELDS = 'nextPageToken,items(title,url,labels,published)';

// 2. Use the exact same slugify logic to ensure we overwrite the right file
function slugify(label) {
  const hash = crypto.createHash('md5').update(label).digest('hex').slice(0, 10);
  return 'l-' + hash;
}

// 3. Fetch ONLY posts that contain the target label
async function fetchPostsByLabel(label) {
  let posts = [];
  let pageToken = undefined;
  let page = 1;

  do {
    console.log(`Fetching page ${page} for label "${label}"...`);
    const url = new URL(BASE_URL);
    url.searchParams.set('key', API_KEY);
    url.searchParams.set('fetchBodies', 'false');
    url.searchParams.set('maxResults', String(MAX_RESULTS));
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('orderBy', 'published');
    
    // This is the key addition: tell Blogger to filter the API response
    url.searchParams.set('labels', label);
    
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Blogger API error ${res.status}: ${body}`);
    }
    
    const data = await res.json();
    const items = data.items || [];
    posts = posts.concat(items);
    pageToken = data.nextPageToken;
    page++;
  } while (pageToken);

  return posts;
}

async function main() {
  console.log(`Starting targeted update for: "${TARGET_LABEL}"`);
  
  const posts = await fetchPostsByLabel(TARGET_LABEL);
  console.log(`Fetched ${posts.length} posts with label "${TARGET_LABEL}".`);

  if (posts.length === 0) {
    console.log('No posts found for this label. Exiting without changes.');
    return;
  }

  // 4. Format and sort the posts exactly like the main script
  const formattedPosts = posts
    .filter(post => post.url && post.title)
    .map(post => ({
      title: post.title,
      url: post.url,
      published: post.published,
    }))
    .sort((a, b) => new Date(a.published) - new Date(b.published));

  // 5. Generate the slug and overwrite the file
  const slug = slugify(TARGET_LABEL);
  const filePath = path.join(OUTPUT_DIR, `${slug}.json`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(formattedPosts));

  console.log(`Successfully updated ${filePath}`);
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});