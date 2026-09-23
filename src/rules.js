// Rules data from the Games Workshop "Warhammer 40,000 Teams Event Companion"
// (version 1.0, file eng_22-07_warhammer_40,000_teams_event_companion).
// Kept as plain data so the solver never hard-codes team-size specifics.

// Section 2 "Pairing System": modules used per team size.
//   S = Initial Skirmish, M = Main Engagement, C = Champion System.
export const MODULES_BY_SIZE = {
  3: ['M'],
  4: ['M', 'C'],
  5: ['S', 'M'],
  6: ['S', 'M', 'C'],
  7: ['S', 'S', 'M'],
  8: ['S', 'S', 'M', 'C'],
};

// Section 14 "Team Scoring": a team must exceed its opponent by at least Y BP to win.
export const WIN_DIFFERENTIAL = { 3: 4, 4: 6, 5: 6, 6: 8, 7: 10, 8: 12 };

// Section 14: VP difference -> Battle Points (player, opponent). Sum is always 20.
export const BP_TABLE = [
  [5, 10], [10, 11], [15, 12], [20, 13], [25, 14], [30, 15],
  [35, 16], [40, 17], [45, 18], [50, 19],
];

export function vpDiffToBp(diff) {
  const d = Math.abs(diff);
  let bp = 20;
  for (const [max, v] of BP_TABLE) if (d <= max) { bp = v; break; }
  return diff >= 0 ? bp : 20 - bp;
}

// Team Points: win 3, draw 2, loss 1.
export const TEAM_POINTS = { win: 3, draw: 2, loss: 1 };

export const LAYOUTS = ['A', 'B', 'C'];

// Refused attackers (Main Engagement step 8) and Champions use the layout
// given by the round: round 1 -> A, round 2 -> B, round 3 -> C, repeating.
export function layoutForRound(round) {
  return (((round - 1) % 3) + 3) % 3;
}

// Team BP thresholds on "our" total (both totals sum to 20 * n).
//   win  : ours - theirs >= Y  <=> ours >= 10n + Y/2
//   loss : theirs - ours >= Y  <=> ours <= 10n - Y/2
export function thresholds(n) {
  const y = WIN_DIFFERENTIAL[n];
  return { win: 10 * n + y / 2, loss: 10 * n - y / 2, total: 20 * n, differential: y };
}
