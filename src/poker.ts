import { INVALID_MOVE, TurnOrder } from 'boardgame.io/core';

export type Variant = 'texas' | 'omaha';
export type Suit = 'S' | 'H' | 'D' | 'C';
export type Card = { rank: number; suit: Suit };

export type PokerPlayer = {
  seat: number;
  sessionId: string | null;
  name: string;
  chips: number;
  holeCards: Card[];
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  streetBet: number;
  totalBet: number;
  acted: boolean;
  isConnected: boolean;
};

export type PokerState = {
  variant: Variant;
  stage: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  handNumber: number;
  players: PokerPlayer[];
  deck: Card[];
  board: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  currentPlayerIndex: number;
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  result: null | { winners: string[]; winningSeats: number[]; payouts: Record<string, number>; description: string };
  lastAction: string;
};

const DEFAULT_SMALL_BLIND = 5;
const DEFAULT_BIG_BLIND = 10;
const DEFAULT_STACK = 1000;

export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of ['S', 'H', 'D', 'C'] as Suit[]) {
    for (let rank = 2; rank <= 14; rank += 1) cards.push({ rank, suit });
  }
  return cards;
}

export function createPokerGame(variant: Variant, capacity: number) {
  const holeCount = variant === 'texas' ? 2 : 4;

  return {
    name: `bokerr-${variant}`,
    minPlayers: 2,
    maxPlayers: capacity,
    setup: ({ ctx }: { ctx: { numPlayers: number } }): PokerState => ({
      variant,
      stage: 'waiting',
      handNumber: 0,
      players: Array.from({ length: ctx.numPlayers }, (_, seat) => emptyPlayer(seat)),
      deck: [],
      board: [],
      pot: 0,
      currentBet: 0,
      minRaise: DEFAULT_BIG_BLIND,
      currentPlayerIndex: 0,
      buttonSeat: -1,
      smallBlind: DEFAULT_SMALL_BLIND,
      bigBlind: DEFAULT_BIG_BLIND,
      result: null,
      lastAction: '',
    }),
    turn: { order: TurnOrder.DEFAULT },
    moves: {
      // These server-only operations are never exposed by the Worker protocol.
      serverSeat: ({ G, ctx, playerID }: { G: PokerState; ctx: any; playerID: string }, seat: number, sessionId: string, name: string) => {
        if (!['waiting', 'showdown'].includes(G.stage) || playerID !== ctx.currentPlayer) return INVALID_MOVE;
        if (!Number.isInteger(seat) || seat < 0 || seat >= G.players.length || !sessionId || !name) return INVALID_MOVE;
        const player = G.players[seat];
        player.sessionId = sessionId;
        player.name = name.slice(0, 24);
        player.isConnected = true;
        if (player.chips <= 0) player.chips = DEFAULT_STACK;
      },
      serverDisconnected: ({ G, playerID }: { G: PokerState; playerID: string }, seat: number) => {
        if (playerID !== '0' || !Number.isInteger(seat) || !G.players[seat]) return INVALID_MOVE;
        G.players[seat].isConnected = false;
      },
      serverStartHand: (
        { G, ctx, events, random, playerID }: { G: PokerState; ctx: any; events: { endTurn: (args: { next: string }) => void }; random: { Shuffle: <T>(items: T[]) => T[] }; playerID: string },
        participants: Array<{ seat: number; id: string; name: string }>
      ) => {
        if (!['waiting', 'showdown'].includes(G.stage) || playerID !== ctx.currentPlayer) return INVALID_MOVE;
        const valid = participants
          .filter((p) => Number.isInteger(p.seat) && p.seat >= 0 && p.seat < G.players.length && p.id && p.name)
          .sort((a, b) => a.seat - b.seat);
        if (new Set(valid.map((p) => p.seat)).size !== valid.length || valid.length < 2) return INVALID_MOVE;

        for (const p of G.players) {
          p.inHand = false;
          p.folded = false;
          p.allIn = false;
          p.holeCards = [];
          p.streetBet = 0;
          p.totalBet = 0;
          p.acted = false;
        }
        for (const participant of valid) {
          const p = G.players[participant.seat];
          p.sessionId = participant.id;
          p.name = participant.name.slice(0, 24);
          p.isConnected = true;
          if (p.chips <= 0) p.chips = DEFAULT_STACK;
          p.inHand = true;
        }

        const candidates = valid.map((p) => G.players[p.seat]);
        let eligible = candidates.filter((p) => p.chips > 0);
        if (eligible.length < 2) {
          for (const p of candidates) p.chips = DEFAULT_STACK;
          eligible = candidates;
        }
        if (eligible.length < 2) return INVALID_MOVE;
        const eligibleSeats = new Set(eligible.map((p) => p.seat));
        for (const p of candidates) p.inHand = eligibleSeats.has(p.seat);

        const previousButton = G.buttonSeat;
        const orderedSeats = eligible.map((p) => p.seat);
        const button = previousButton < 0
          ? orderedSeats[0]
          : nextSeatIn(orderedSeats, previousButton);
        G.buttonSeat = button;
        const smallBlindSeat = eligible.length === 2 ? button : nextSeatIn(orderedSeats, button);
        const bigBlindSeat = nextSeatIn(orderedSeats, smallBlindSeat);

        G.deck = random.Shuffle(createDeck());
        G.board = [];
        G.pot = 0;
        G.currentBet = 0;
        G.minRaise = G.bigBlind;
        G.result = null;
        G.handNumber += 1;
        G.stage = 'preflop';
        G.lastAction = `بدأت الجولة ${G.handNumber}`;

        for (let n = 0; n < holeCount; n += 1) {
          for (const seat of orderedSeats) G.players[seat].holeCards.push(G.deck.pop()!);
        }
        postBlind(G, smallBlindSeat, G.smallBlind);
        postBlind(G, bigBlindSeat, G.bigBlind);
        G.currentBet = Math.max(G.players[smallBlindSeat].streetBet, G.players[bigBlindSeat].streetBet);

        const nominalFirstActor = eligible.length === 2
          ? button
          : nextSeatIn(orderedSeats, bigBlindSeat);
        const firstActor = nextEligibleFrom(G, nominalFirstActor);
        if (firstActor < 0) runoutAndShowdown(G);
        G.currentPlayerIndex = firstActor;
        events.endTurn({ next: String(firstActor < 0 ? button : firstActor) });
      },
      fold: ({ G, ctx, events, playerID }: { G: PokerState; ctx: any; events: any; playerID: string }) => applyAction(G, events, ctx, playerID, 'fold'),
      check: ({ G, ctx, events, playerID }: { G: PokerState; ctx: any; events: any; playerID: string }) => applyAction(G, events, ctx, playerID, 'check'),
      call: ({ G, ctx, events, playerID }: { G: PokerState; ctx: any; events: any; playerID: string }) => applyAction(G, events, ctx, playerID, 'call'),
      bet: ({ G, ctx, events, playerID }: { G: PokerState; ctx: any; events: any; playerID: string }, amount: number) => applyAction(G, events, ctx, playerID, 'bet', amount),
      raise: ({ G, ctx, events, playerID }: { G: PokerState; ctx: any; events: any; playerID: string }, raiseTo: number) => applyAction(G, events, ctx, playerID, 'raise', raiseTo),
      allIn: ({ G, ctx, events, playerID }: { G: PokerState; ctx: any; events: any; playerID: string }) => applyAction(G, events, ctx, playerID, 'allIn'),
    },
    playerView: ({ G, playerID }: { G: PokerState; playerID: string | null }) => ({
      ...G,
      deck: [],
      players: G.players.map((player) => ({
        ...player,
        holeCards: playerID !== null && String(player.seat) === playerID ? player.holeCards : [],
      })),
    }),
  };
}

function emptyPlayer(seat: number): PokerPlayer {
  return {
    seat, sessionId: null, name: `مقعد ${seat + 1}`, chips: DEFAULT_STACK,
    holeCards: [], inHand: false, folded: false, allIn: false,
    streetBet: 0, totalBet: 0, acted: false, isConnected: false,
  };
}

function nextSeatIn(seats: number[], current: number): number {
  return seats.find((seat) => seat > current) ?? seats[0];
}

function nextEligibleFrom(G: PokerState, startSeat: number): number {
  for (let offset = 0; offset < G.players.length; offset += 1) {
    const seat = (startSeat + offset) % G.players.length;
    const player = G.players[seat];
    if (player.inHand && !player.folded && !player.allIn && player.chips > 0) return seat;
  }
  return -1;
}

function postBlind(G: PokerState, seat: number, amount: number) {
  const player = G.players[seat];
  const paid = Math.min(player.chips, amount);
  player.chips -= paid;
  player.streetBet += paid;
  player.totalBet += paid;
  G.pot += paid;
  player.allIn = player.chips === 0;
}

function applyAction(G: PokerState, events: any, ctx: any, playerID: string, action: string, amount?: number) {
  if (!['preflop', 'flop', 'turn', 'river'].includes(G.stage)) return INVALID_MOVE;
  const seat = Number(playerID);
  const player = G.players[seat];
  if (!player || !player.inHand || player.folded || player.allIn || seat !== G.currentPlayerIndex) return INVALID_MOVE;
  const owed = Math.max(0, G.currentBet - player.streetBet);

  if (action === 'fold') {
    player.folded = true;
    player.acted = true;
  } else if (action === 'check') {
    if (owed > 0) return INVALID_MOVE;
    player.acted = true;
  } else if (action === 'call') {
    if (owed <= 0) return INVALID_MOVE;
    contribute(G, player, Math.min(owed, player.chips));
    player.acted = true;
  } else if (action === 'bet') {
    if (G.currentBet !== 0 || !validAmount(amount) || amount < G.bigBlind || amount > player.chips) return INVALID_MOVE;
    contribute(G, player, amount);
    G.currentBet = player.streetBet;
    G.minRaise = amount;
    resetOtherActors(G, seat);
    player.acted = true;
  } else if (action === 'raise') {
    if (G.currentBet <= 0 || !validAmount(amount) || amount <= G.currentBet || amount > player.streetBet + player.chips) return INVALID_MOVE;
    const raiseBy = amount - G.currentBet;
    if (raiseBy < G.minRaise && amount !== player.streetBet + player.chips) return INVALID_MOVE;
    contribute(G, player, amount - player.streetBet);
    G.currentBet = player.streetBet;
    if (raiseBy >= G.minRaise) G.minRaise = raiseBy;
    resetOtherActors(G, seat);
    player.acted = true;
  } else if (action === 'allIn') {
    if (player.chips <= 0) return INVALID_MOVE;
    const oldBet = G.currentBet;
    contribute(G, player, player.chips);
    if (player.streetBet > oldBet) {
      const raiseBy = player.streetBet - oldBet;
      G.currentBet = player.streetBet;
      if (raiseBy >= G.minRaise) {
        G.minRaise = raiseBy;
        resetOtherActors(G, seat);
      }
    }
    player.acted = true;
  } else {
    return INVALID_MOVE;
  }

  G.lastAction = `${player.name}: ${action}${Number.isFinite(amount) ? ` ${amount}` : ''}`;
  if (finishIfPossible(G)) {
    G.currentPlayerIndex = G.buttonSeat >= 0 ? G.buttonSeat : seat;
    events.endTurn({ next: String(G.currentPlayerIndex) });
    return;
  }

  const next = nextActionableSeat(G, seat, true);
  if (next === -1) {
    if (finishBettingStreet(G)) {
      const nextAfterStreet = G.currentPlayerIndex;
      events.endTurn({ next: String(nextAfterStreet) });
      return;
    }
  } else {
    G.currentPlayerIndex = next;
    if (allActionablePlayersSettled(G)) {
      finishBettingStreet(G);
      events.endTurn({ next: String(G.currentPlayerIndex) });
      return;
    }
  }
  events.endTurn({ next: String(G.currentPlayerIndex) });
}

function validAmount(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0;
}

function contribute(G: PokerState, player: PokerPlayer, requested: number) {
  const paid = Math.min(Math.max(0, requested), player.chips);
  player.chips -= paid;
  player.streetBet += paid;
  player.totalBet += paid;
  G.pot += paid;
  player.allIn = player.chips === 0;
}

function resetOtherActors(G: PokerState, exceptSeat: number) {
  for (const player of G.players) {
    if (player.inHand && !player.folded && !player.allIn && player.seat !== exceptSeat) player.acted = false;
  }
}

function nextActionableSeat(G: PokerState, after: number, requireAction: boolean): number {
  const count = G.players.length;
  for (let step = 1; step <= count; step += 1) {
    const seat = (after + step) % count;
    const player = G.players[seat];
    if (!player.inHand || player.folded || player.allIn || player.chips <= 0) continue;
    if (!requireAction || !player.acted || player.streetBet < G.currentBet) return seat;
  }
  return -1;
}

function allActionablePlayersSettled(G: PokerState): boolean {
  const actionable = G.players.filter((player) => player.inHand && !player.folded && !player.allIn && player.chips > 0);
  return actionable.length > 0 && actionable.every((player) => player.acted && player.streetBet === G.currentBet);
}

function finishIfPossible(G: PokerState): boolean {
  const remaining = G.players.filter((player) => player.inHand && !player.folded);
  if (remaining.length === 1) {
    awardUncontested(G, remaining[0]);
    return true;
  }
  return false;
}

function finishBettingStreet(G: PokerState): boolean {
  if (finishIfPossible(G)) return true;
  const canAct = G.players.filter((player) => player.inHand && !player.folded && !player.allIn && player.chips > 0);
  const active = G.players.filter((player) => player.inHand && !player.folded);
  if (canAct.length <= 1 && active.length > 1) {
    runoutAndShowdown(G);
    return true;
  }
  if (G.stage === 'river') {
    settleShowdown(G);
    return true;
  }

  dealNextStreet(G);
  for (const player of G.players) {
    player.streetBet = 0;
    player.acted = false;
  }
  G.currentBet = 0;
  G.minRaise = G.bigBlind;
  G.currentPlayerIndex = nextActionableSeat(G, G.buttonSeat, false);
  if (G.currentPlayerIndex < 0) {
    runoutAndShowdown(G);
    return true;
  }
  return false;
}

function maybeRunOut(G: PokerState) {
  const actionable = G.players.filter((player) => player.inHand && !player.folded && !player.allIn && player.chips > 0);
  const contenders = G.players.filter((player) => player.inHand && !player.folded);
  if (contenders.length === 1) {
    awardUncontested(G, contenders[0]);
    return;
  }
  if (actionable.length === 0) runoutAndShowdown(G);
}

function dealNextStreet(G: PokerState) {
  G.deck.pop(); // burn
  if (G.stage === 'preflop') {
    G.board.push(G.deck.pop()!, G.deck.pop()!, G.deck.pop()!);
    G.stage = 'flop';
  } else if (G.stage === 'flop') {
    G.board.push(G.deck.pop()!);
    G.stage = 'turn';
  } else if (G.stage === 'turn') {
    G.board.push(G.deck.pop()!);
    G.stage = 'river';
  }
  G.lastAction = `بطاقات ${G.stage}`;
}

function runoutAndShowdown(G: PokerState) {
  while (G.board.length < 5) dealNextStreet(G);
  settleShowdown(G);
}

function awardUncontested(G: PokerState, winner: PokerPlayer) {
  winner.chips += G.pot;
  G.result = {
    winners: winner.sessionId ? [winner.sessionId] : [],
    winningSeats: [winner.seat],
    payouts: winner.sessionId ? { [winner.sessionId]: G.pot } : {},
    description: `فاز ${winner.name} بعد انسحاب بقية اللاعبين`,
  };
  G.stage = 'showdown';
  G.lastAction = G.result.description;
}

function settleShowdown(G: PokerState) {
  const contenders = G.players.filter((player) => player.inHand && !player.folded);
  const payouts: Record<string, number> = {};
  const winningSeats = new Set<number>();
  const levels = [...new Set(G.players.filter((p) => p.totalBet > 0).map((p) => p.totalBet))].sort((a, b) => a - b);
  let previous = 0;
  for (const level of levels) {
    const contributors = G.players.filter((p) => p.totalBet >= level);
    const pot = (level - previous) * contributors.length;
    previous = level;
    if (pot <= 0) continue;
    const eligible = contenders.filter((p) => p.totalBet >= level);
    if (eligible.length === 0) eligible.push(...contenders);
    if (eligible.length === 0) continue;
    let best: number[] | null = null;
    let winners: PokerPlayer[] = [];
    for (const player of eligible) {
      const score = bestScore(G.variant, player.holeCards, G.board);
      const comparison = best === null ? 1 : compareScore(score, best);
      if (comparison > 0) { best = score; winners = [player]; }
      else if (comparison === 0) winners.push(player);
    }
    const share = Math.floor(pot / winners.length);
    let remainder = pot - share * winners.length;
    for (const winner of winners) {
      const amount = share + (remainder-- > 0 ? 1 : 0);
      winner.chips += amount;
      if (winner.sessionId) payouts[winner.sessionId] = (payouts[winner.sessionId] || 0) + amount;
      winningSeats.add(winner.seat);
    }
  }
  const seats = [...winningSeats];
  const names = seats.map((seat) => G.players[seat].name);
  G.result = {
    winners: seats.map((seat) => G.players[seat].sessionId).filter((id): id is string => Boolean(id)),
    winningSeats: seats,
    payouts,
    description: names.length ? `الفائز${names.length > 1 ? 'ون' : ''}: ${names.join('، ')}` : 'انتهت الجولة',
  };
  G.stage = 'showdown';
  G.lastAction = G.result.description;
}

export function bestScore(variant: Variant, hole: Card[], board: Card[]): number[] {
  const scores: number[][] = [];
  if (variant === 'omaha') {
    for (const two of combinations(hole, 2)) for (const three of combinations(board, 3)) scores.push(scoreFive([...two, ...three]));
  } else {
    scores.push(...combinations([...hole, ...board], 5).map(scoreFive));
  }
  return maxScore(scores);
}

export function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  return combinations(rest, size - 1).map((row) => [first, ...row]).concat(combinations(rest, size));
}

function maxScore(scores: number[][]): number[] {
  return scores.reduce((best, score) => compareScore(score, best) > 0 ? score : best, [-1]);
}

function scoreFive(cards: Card[]): number[] {
  const counts = new Map<number, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...counts.keys()].sort((a, b) => b - a);
  const wheel = unique.join(',') === '14,5,4,3,2';
  const straight = unique.length === 5 && (unique[0] - unique[4] === 4 || wheel);
  const highStraight = wheel ? 5 : unique[0];
  const flush = cards.every((card) => card.suit === cards[0].suit);
  if (straight && flush) return [8, highStraight];
  if (groups[0]?.[1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...unique];
  if (straight) return [4, highStraight];
  if (groups[0]?.[1] === 3) return [3, groups[0][0], ...groups.slice(1).map((group) => group[0])];
  if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0]?.[1] === 2) return [1, groups[0][0], ...groups.slice(1).map((group) => group[0])];
  return [0, ...unique];
}
