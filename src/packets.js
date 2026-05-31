'use strict';

/**
 * Packet builder — assembles the single object a platform adapter consumes to
 * schedule one post.
 *
 * The post text, resolved absolute asset paths, and optional document title are
 * already on the state record (seeded from the manifest by `state.fromManifest`
 * → `manifest.loadManifest`). This module just validates asset existence and
 * shapes the packet. Read-only; browser-free.
 */

const { firstLine } = require('./helpers');

/**
 * Build a fully-resolved packet for a post.
 *
 * @param {import('./state').ScheduleState} state - the loaded state store
 * @param {string} postId - the post id
 * @returns {{postId:string, platform:string, template:string, target:string,
 *            assets:string[], postText:string, docTitle:(string|null),
 *            firstLine:string}}
 * @throws {Error} on an unknown post, missing post text, or a missing asset
 */
function buildPacket(state, postId) {
  const post = state.getPost(postId);
  if (!post) {
    throw new Error(`Unknown post "${postId}".`);
  }

  const { ok, paths, missing } = state.resolveAssets(postId);
  if (!ok) {
    throw new Error(`Post ${postId} has missing asset(s): ${missing.join(', ')}`);
  }

  const postText = post.postText;
  if (typeof postText !== 'string' || postText.trim().length === 0) {
    throw new Error(`Post ${postId} has no post text.`);
  }

  return {
    postId,
    platform: post.platform,
    template: post.template,
    target: post.target,
    assets: paths,
    postText,
    docTitle: post.docTitle || null,
    firstLine: firstLine(postText),
  };
}

module.exports = { buildPacket };
