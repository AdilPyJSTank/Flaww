import type { PlatformName } from '../config';

/** Canonical shape every source normalises into before anything else runs. */
export interface RawPost {
  platform: PlatformName;
  externalId: string;
  url: string;

  /** reddit: subreddit name */
  subreddit?: string;
  /** x: the tracked tag · threads: the keyword · linkedin: parent post urn */
  matchedTag?: string;

  authorHandle: string;
  authorExternalId?: string;
  authorKarma?: number;
  authorFollowers?: number;

  title?: string;
  body: string;
  parentContext?: string;

  postedAt: Date;
  raw: unknown;
}
