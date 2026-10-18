export type Variant = 'texas' | 'omaha';
export type Suit = 'S' | 'H' | 'D' | 'C';
export type Card = { rank: number; suit: Suit };
export type Player = { id: string; hole: Card[]; folded: boolean; committed: number };
export type Round = { variant: Variant; players: Player[]; board: Card[]; pot: number; stage: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'; turnIndex: number };

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of ['S', 'H', 'D', 'C'] as Suit[]) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}

export function startRound(variant: Variant, ids: string[]): Round {
  const max = variant === 'texas' ? 9 : 5;
  if (ids.length < 2 || ids.length > max) throw new Error('invalid_player_count');
  const deck = createDeck();
  const holeCount = variant === 'texas' ? 2 : 4;
  const players = ids.map((id) => ({ id, hole: deck.splice(0, holeCount), folded: false, committed: 0 }));
  return { variant, players, board: deck.splice(0, 5), pot: 0, stage: 'preflop', turnIndex: 0 };
}

export function visibleBoard(round: Round) { return round.board.slice(0, round.stage === 'preflop' ? 0 : round.stage === 'flop' ? 3 : round.stage === 'turn' ? 4 : 5); }

export function advance(round: Round): Round { const live = round.players.filter((p) => !p.folded); if (live.length <= 1) return { ...round, stage: 'showdown' }; const order: Round['stage'][] = ['preflop', 'flop', 'turn', 'river', 'showdown']; const stage = order[Math.min(order.indexOf(round.stage) + 1, order.length - 1)]; return { ...round, stage, turnIndex: nextTurn(round) }; }

export function nextTurn(round: Round) { const count = round.players.length; for (let i = 1; i <= count; i++) { const index = (round.turnIndex + i) % count; if (!round.players[index].folded) return index; } return round.turnIndex; }

export function bestScore(round: Round, player: Player): number[] {
  const board = visibleBoard(round);
  if (round.variant === 'omaha') { const scores: number[][] = []; for (const two of combinations(player.hole, 2)) for (const three of combinations(board, 3)) scores.push(scoreFive([...two, ...three])); return maxScore(scores); }
  return maxScore(combinations([...player.hole, ...board], 5).map((cards) => scoreFive(cards)));
}

function combinations<T>(items: T[], n: number): T[][] { if (n === 0) return [[]]; if (items.length < n) return []; const [first, ...rest] = items; return combinations(rest, n - 1).map((x) => [first, ...x]).concat(combinations(rest, n)); }
function maxScore(scores: number[][]) { return scores.sort((a, b) => compareScore(a, b))[scores.length - 1] || [0]; }
function compareScore(a: number[], b: number[]) { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; }
function scoreFive(cards: Card[]): number[] { const counts = new Map<number, number>(); cards.forEach((c) => counts.set(c.rank, (counts.get(c.rank) || 0) + 1)); const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); const unique = [...counts.keys()].sort((a, b) => b - a); const straight = unique.length === 5 && (unique[0] - unique[4] === 4 || unique.join(',') === '14,5,4,3,2'); const flush = cards.every((c) => c.suit === cards[0].suit); if (straight && flush) return [8, unique[0] === 14 && unique[1] === 5 ? 5 : unique[0]]; if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]]; if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]]; if (flush) return [5, ...unique]; if (straight) return [4, unique[0] === 14 && unique[1] === 5 ? 5 : unique[0]]; if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0])]; if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]]; if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0])]; return [0, ...unique]; }
