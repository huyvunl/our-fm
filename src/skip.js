import { SKIP_VOTES, SKIP_VOTES_WITH_REQUESTER } from './config.js';

export function normalizeName(name) {
  return String(name).trim().toLowerCase();
}

// A vote counts only when both its clientId and normalized name are new.
export function countVoters(votes) {
  const ids = new Set();
  const names = new Set();
  let n = 0;
  for (const v of votes) {
    const name = normalizeName(v.voterName);
    if (!ids.has(v.voterId) && !names.has(name)) n++;
    ids.add(v.voterId);
    names.add(name);
  }
  return n;
}

export function votesNeeded(play, votes) {
  if (play.source === 'auto') return 1;
  if (play.requesterId != null && votes.some((v) => v.voterId === play.requesterId)) {
    return SKIP_VOTES_WITH_REQUESTER;
  }
  return SKIP_VOTES;
}

export function evaluateSkip(play, votes) {
  const counted = countVoters(votes);
  const needed = votesNeeded(play, votes);
  return { votes: counted, needed, passed: counted >= needed };
}
