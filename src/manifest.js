'use strict';

/**
 * Batch manifest loader — the public input layer.
 *
 * Reads a `batch.json` manifest, validates it with friendly errors, resolves
 * each post's text + asset paths (relative to the manifest's directory), and
 * maps the public post `kind` to the internal template the platform adapters
 * understand. The result feeds `state.fromManifest(...)`.
 *
 * Manifest shape (see examples/sample-batch/batch.json):
 *
 *   {
 *     "id": "my-week",                         // optional label (logs/report)
 *     "timezone": "America/Los_Angeles",       // optional; informational — see note
 *     "accounts": {                             // optional; enables a login-name guard
 *       "linkedin": { "displayName": "Your Name" },
 *       "x": { "handle": "@you" }
 *     },
 *     "posts": [
 *       {
 *         "id": "post-1",
 *         "platform": "linkedin",              // "linkedin" | "x"
 *         "kind": "image",                      // see KIND_TEMPLATE below
 *         "text": "Inline post text...",        // OR "textFile": "posts/post-1.md"
 *         "assets": ["assets/post-1.png"],      // paths relative to the manifest dir
 *         "scheduledAt": "2026-06-09 09:00",    // local wall-clock, see TIMEZONE note
 *         "title": "Optional doc title"         // LinkedIn document (kind:document) only
 *       }
 *     ]
 *   }
 *
 * TIMEZONE note: LinkedIn and X schedule in the BROWSER's local timezone, and
 * this tool sets the wall-clock you give in `scheduledAt` directly (no
 * conversion). So `scheduledAt` is interpreted in your browser/OS timezone; the
 * top-level `timezone` field documents which zone that should be (and is shown
 * in the report) — set your machine's timezone to match.
 *
 * Read-only: never writes or deletes anything under the manifest directory.
 */

const fs = require('fs');
const path = require('path');

/**
 * Map (platform, kind) → the internal template the adapters branch on.
 * The adapters only distinguish: LinkedIn document (PDF carousel) vs image, and
 * X multi-image carousel vs single image.
 */
const KIND_TEMPLATE = Object.freeze({
  linkedin: Object.freeze({ image: 'LI-SINGLE', document: 'LI-CAROUSEL' }),
  x: Object.freeze({ image: 'X-SINGLE', carousel: 'X-CAROUSEL' }),
});

/** Expected asset counts per kind. */
const ASSET_RULES = Object.freeze({
  image: { min: 1, max: 1, label: '1 image' },
  document: { min: 1, max: 1, label: '1 document (PDF)' },
  carousel: { min: 2, max: 4, label: '2–4 images' },
});

const SCHEDULED_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/**
 * Resolve the manifest file path from a file-or-directory argument.
 *
 * @param {string} batchPath - path to a batch.json file OR a directory holding one
 * @returns {{manifestFile:string, batchDir:string}}
 * @throws {Error} if no manifest is found
 */
function resolveManifestPath(batchPath) {
  const abs = path.resolve(batchPath);
  let manifestFile = abs;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    manifestFile = path.join(abs, 'batch.json');
  }
  if (!fs.existsSync(manifestFile)) {
    throw new Error(
      `No manifest found at ${manifestFile}. Point --batch at a batch.json file ` +
        'or a directory containing one.'
    );
  }
  return { manifestFile, batchDir: path.dirname(manifestFile) };
}

/**
 * Load + validate a batch manifest into resolved post records.
 *
 * @param {string} batchPath - path to batch.json (or its directory)
 * @returns {{batchId:string, timezone:(string|null), accounts:(object|null),
 *            manifestFile:string, batchDir:string, posts:object[]}}
 * @throws {Error} on any validation failure (message names the offending post)
 */
function loadManifest(batchPath) {
  const { manifestFile, batchDir } = resolveManifestPath(batchPath);

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`Manifest ${manifestFile} is not valid JSON: ${error.message}`);
  }
  if (!doc || !Array.isArray(doc.posts) || doc.posts.length === 0) {
    throw new Error(`Manifest ${manifestFile} must have a non-empty "posts" array.`);
  }

  const batchId =
    (typeof doc.id === 'string' && doc.id.trim()) || path.basename(batchDir) || 'batch';

  const seenIds = new Set();
  const posts = doc.posts.map((post, i) => resolvePost(post, i, batchDir, seenIds));

  return {
    batchId,
    timezone: typeof doc.timezone === 'string' ? doc.timezone : null,
    accounts: doc.accounts && typeof doc.accounts === 'object' ? doc.accounts : null,
    manifestFile,
    batchDir,
    posts,
  };
}

/**
 * Validate + resolve one post entry into an internal record.
 *
 * @param {object} post - a raw manifest post
 * @param {number} i - its index (for fallback id + error context)
 * @param {string} batchDir - the manifest directory (for relative resolution)
 * @param {Set<string>} seenIds - ids seen so far (uniqueness)
 * @returns {object} resolved record
 * @throws {Error} on any validation failure
 */
function resolvePost(post, i, batchDir, seenIds) {
  const where = `posts[${i}]${post && post.id ? ` (id "${post.id}")` : ''}`;
  if (!post || typeof post !== 'object') {
    throw new Error(`${where}: each post must be an object.`);
  }

  const id = (typeof post.id === 'string' && post.id.trim()) || `post-${i + 1}`;
  if (seenIds.has(id)) {
    throw new Error(`${where}: duplicate post id "${id}".`);
  }
  seenIds.add(id);

  const platform = post.platform;
  if (platform !== 'linkedin' && platform !== 'x') {
    throw new Error(`${where}: "platform" must be "linkedin" or "x" (got ${JSON.stringify(platform)}).`);
  }

  const kind = post.kind;
  const template = KIND_TEMPLATE[platform] && KIND_TEMPLATE[platform][kind];
  if (!template) {
    const allowed = Object.keys(KIND_TEMPLATE[platform]).join(', ');
    throw new Error(`${where}: "kind" ${JSON.stringify(kind)} is not valid for ${platform}. Allowed: ${allowed}.`);
  }

  // Text: inline `text` or `textFile` (path relative to the manifest dir).
  let postText;
  if (typeof post.textFile === 'string' && post.textFile.length > 0) {
    const tf = path.resolve(batchDir, post.textFile);
    try {
      postText = fs.readFileSync(tf, 'utf8');
    } catch (error) {
      throw new Error(`${where}: cannot read textFile ${tf}: ${error.message}`);
    }
  } else if (typeof post.text === 'string') {
    postText = post.text;
  } else {
    throw new Error(`${where}: provide "text" (inline string) or "textFile" (path).`);
  }
  postText = postText.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (postText.trim().length === 0) {
    throw new Error(`${where}: post text is empty.`);
  }

  // Assets: resolve relative to the manifest dir; validate count + existence.
  const rawAssets = Array.isArray(post.assets) ? post.assets : [];
  const rule = ASSET_RULES[kind];
  if (rawAssets.length < rule.min || rawAssets.length > rule.max) {
    throw new Error(`${where}: kind "${kind}" expects ${rule.label}, got ${rawAssets.length} asset(s).`);
  }
  const assets = rawAssets.map((a) => {
    if (typeof a !== 'string' || a.length === 0) {
      throw new Error(`${where}: each asset must be a non-empty path string.`);
    }
    const abs = path.resolve(batchDir, a);
    if (!fs.existsSync(abs)) {
      throw new Error(`${where}: asset not found: ${abs}`);
    }
    return abs;
  });

  // scheduledAt: local wall-clock "YYYY-MM-DD HH:mm".
  if (typeof post.scheduledAt !== 'string' || !SCHEDULED_AT.test(post.scheduledAt)) {
    throw new Error(`${where}: "scheduledAt" must be "YYYY-MM-DD HH:mm" (got ${JSON.stringify(post.scheduledAt)}).`);
  }

  const docTitle =
    template === 'LI-CAROUSEL' && typeof post.title === 'string' && post.title.trim()
      ? post.title.trim()
      : null;

  return {
    postId: id,
    platform,
    template,
    target: post.scheduledAt,
    assets,
    status: 'pending',
    attempts: 0,
    lastError: '',
    postText,
    docTitle,
  };
}

module.exports = {
  loadManifest,
  resolveManifestPath,
  KIND_TEMPLATE,
  ASSET_RULES,
};
