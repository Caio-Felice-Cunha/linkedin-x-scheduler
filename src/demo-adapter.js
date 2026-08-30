'use strict';

const PLATFORM_STEPS = Object.freeze({
  linkedin: ['validate post', 'open composer', 'attach media', 'set schedule', 'verify queue'],
  x: ['validate post', 'open composer', 'attach media', 'set schedule', 'verify queue'],
});

class DemoAdapter {
  simulate(post) {
    const labels = PLATFORM_STEPS[post.platform];
    if (!labels) throw new Error(`unsupported demo platform: ${post.platform}`);
    return {
      id: post.id,
      platform: post.platform,
      kind: post.kind,
      scheduledAt: post.scheduledAt,
      status: 'simulated',
      steps: labels.map((label, index) => ({ id: index + 1, label, status: 'complete' })),
    };
  }
}

module.exports = { DemoAdapter, PLATFORM_STEPS };
