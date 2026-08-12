/**
 * Export the style corpus as JSONL.
 *
 * Each line is one (post, your_reply) pair — a labelled example of how you
 * answer a specific kind of post, in your own words. This is the file you
 * feed to a fine-tune, or sample from for few-shot examples, when you move to
 * Phase 2 and start drafting.
 *
 *   npm run corpus:export             # everything published
 *   npm run corpus:export -- --min 60 # only replies over 60 chars
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../db';

const args = process.argv.slice(2);
const minLen = Number(args[args.indexOf('--min') + 1]) || 0;

async function main() {
  const replies = await prisma.reply.findMany({
    where: { status: 'published' },
    include: { post: { include: { verdict: true } } },
    orderBy: { publishedAt: 'asc' },
  });

  const rows = replies
    .filter((r) => r.text.length >= minLen)
    .map((r) => ({
      platform: r.post.platform,
      context: r.post.platform === 'reddit' ? `r/${r.post.subreddit}` : r.post.matchedTag,
      post: {
        title: r.post.title,
        body: r.post.body,
        author: r.post.authorHandle,
        url: r.post.url,
      },
      // Why the screener surfaced it — useful signal about what kind of post
      // this reply was answering.
      screening_reason: r.post.verdict?.reason ?? null,
      confidence: r.post.verdict?.confidence ?? null,
      // Verbatim. Never normalised, never cleaned.
      reply: r.text,
      reply_chars: r.text.length,
      published_at: r.publishedAt?.toISOString() ?? null,
      score: r.score,
    }));

  const stamp = new Date().toISOString().slice(0, 10);
  const path = `corpus-export-${stamp}.jsonl`;
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  console.log(`Wrote ${rows.length} examples to ${path}`);
  if (rows.length < 150) {
    console.log(`${150 - rows.length} more before there's enough to reliably learn your voice.`);
  }

  await prisma.$disconnect();
}

void main();
