/**
 * What the corpus knows about you, and how well the screener is doing.
 *
 * The number to watch is the answer rate. Below ~25% the screener is
 * surfacing noise and you should raise minConfidence — no amount of clever
 * drafting later will fix a screener that wastes your attention now.
 */
import { prisma } from '../db';

async function main() {
  const [published, carded, answered, rejected, prefiltered] = await Promise.all([
    prisma.reply.count({ where: { status: 'published' } }),
    prisma.card.count(),
    prisma.reply.count(),
    prisma.post.count({ where: { status: 'rejected' } }),
    prisma.post.count({ where: { status: 'prefiltered_out' } }),
  ]);

  const replies = await prisma.reply.findMany({
    where: { status: 'published' },
    include: { post: true },
  });

  const lengths = replies.map((r) => r.text.length).sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)]! : 0;
  const mean = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;

  const byPlatform = new Map<string, number>();
  const bySub = new Map<string, number>();
  for (const r of replies) {
    byPlatform.set(r.post.platform, (byPlatform.get(r.post.platform) ?? 0) + 1);
    if (r.post.subreddit) bySub.set(r.post.subreddit, (bySub.get(r.post.subreddit) ?? 0) + 1);
  }

  const spend = await prisma.verdict.aggregate({ _sum: { costUsd: true }, _count: true });

  console.log(`
CORPUS
  published replies   ${published}
  median length       ${median} chars
  mean length         ${mean} chars
  by platform         ${[...byPlatform].map(([k, v]) => `${k}=${v}`).join('  ') || '—'}
  top subreddits      ${
    [...bySub]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `r/${k}=${v}`)
      .join('  ') || '—'
  }

FUNNEL
  prefiltered out     ${prefiltered}   (free — no LLM call)
  screened out        ${rejected}
  cards sent          ${carded}
  answered            ${answered}${carded ? `   (${Math.round((answered / carded) * 100)}%)` : ''}

SCREENING SPEND
  calls               ${spend._count}
  estimated cost      $${(spend._sum.costUsd ?? 0).toFixed(3)}
  per answered reply  $${answered ? ((spend._sum.costUsd ?? 0) / answered).toFixed(3) : '—'}

${
  carded > 20 && answered / carded < 0.25
    ? 'Answer rate is below 25%. The screener is costing you more attention than it saves —\nraise screening.minConfidence or add terms to persona.negativeTerms.'
    : published >= 150
      ? `${published} examples — enough to start drafting in your voice.\nRun: npm run corpus:export`
      : `${150 - published} more replies until the corpus is large enough to learn from.`
}
`);

  await prisma.$disconnect();
}

void main();
