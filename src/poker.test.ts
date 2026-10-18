import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'boardgame.io/client';
import { bestScore, createPokerGame, type PokerState } from './poker';

function makeState(variant: 'texas' | 'omaha', seats = 2) {
  const client = Client({ game: createPokerGame(variant, seats) as any, numPlayers: seats, playerID: '0' });
  client.start();
  const move = (type: string, playerID: string, args: unknown[] = []) => {
    client.updatePlayerID(playerID);
    (client.moves as any)[type](...args);
  };
  return {
    client,
    get state() { return client.getState() as any as { G: PokerState; ctx: any; _stateID: number }; },
    move,
    stop: () => client.stop(),
  };
}

function startTwoPlayerHand(variant: 'texas' | 'omaha') {
  const match = makeState(variant, 2);
  match.move('serverSeat', '0', [0, 'session-a', 'أحمد']);
  match.move('serverSeat', '0', [1, 'session-b', 'سامي']);
  match.move('serverStartHand', '0', [[
    { seat: 0, id: 'session-a', name: 'أحمد' },
    { seat: 1, id: 'session-b', name: 'سامي' },
  ]]);
  return match;
}

test('Texas hand starts with two private cards and heads-up blinds', () => {
  const match = startTwoPlayerHand('texas');
  assert.equal(match.state.G.stage, 'preflop');
  assert.equal(match.state.G.players[0].holeCards.length, 2);
  assert.equal(match.state.G.players[1].holeCards.length, 0); // Player view hides opponent cards.
  assert.equal(match.state.G.players[0].streetBet, 5);
  assert.equal(match.state.G.players[1].streetBet, 10);
  assert.equal(match.state.G.pot, 15);
  assert.equal(match.state.ctx.currentPlayer, '0');

  match.move('call', '0');
  assert.equal(match.state.ctx.currentPlayer, '1');
  match.move('check', '1');
  assert.equal(match.state.G.stage, 'flop');
  assert.equal(match.state.G.board.length, 3);
  assert.equal(match.state.ctx.currentPlayer, '1');
  match.stop();
});

test('Omaha deals four private cards per player', () => {
  const match = startTwoPlayerHand('omaha');
  assert.equal(match.state.G.variant, 'omaha');
  assert.equal(match.state.G.players[0].holeCards.length, 4);
  match.client.updatePlayerID('1');
  assert.equal(match.state.G.players[1].holeCards.length, 4);
  match.stop();
});

test('a player cannot check while facing an outstanding blind', () => {
  const match = startTwoPlayerHand('texas');
  const beforeId = match.state._stateID;
  match.move('check', '0');
  assert.equal(match.state._stateID, beforeId);
  assert.equal(match.state.G.pot, 15);
  match.stop();
});

test('fold awards the pot to the last remaining player', () => {
  const match = startTwoPlayerHand('texas');
  match.move('fold', '0');
  assert.equal(match.state.G.stage, 'showdown');
  assert.deepEqual(match.state.G.result?.winners, ['session-b']);
  assert.equal(match.state.G.players[1].chips, 1005);
  match.stop();
});

test('all-in call runs the remaining board and conserves the total chip count', () => {
  const match = startTwoPlayerHand('texas');
  match.move('call', '0');
  match.move('check', '1');
  assert.equal(match.state.G.stage, 'flop');
  match.move('allIn', '1');
  match.move('call', '0');
  assert.equal(match.state.G.stage, 'showdown');
  assert.equal(match.state.G.board.length, 5);
  assert.equal(match.state.G.players.reduce((sum, player) => sum + player.chips, 0), 2000);
  assert.equal(match.state.G.players.reduce((sum, player) => sum + (match.state.G.result?.payouts[player.sessionId || ''] || 0), 0), 2000);
  match.stop();
});

test('Texas can use any five of seven cards while Omaha must use exactly two hole cards', () => {
  const hole = [{ rank: 14, suit: 'H' as const }, { rank: 2, suit: 'H' as const }];
  const board = [
    { rank: 13, suit: 'H' as const }, { rank: 12, suit: 'H' as const },
    { rank: 11, suit: 'H' as const }, { rank: 10, suit: 'H' as const },
    { rank: 9, suit: 'C' as const },
  ];
  assert.equal(bestScore('texas', hole, board)[0], 8);
  assert.equal(bestScore('omaha', hole, board)[0], 5);
});
