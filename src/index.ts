import { advance, bestScore, startRound, type Round } from './poker';

export interface Env {
  DB: D1Database;
  POKER_TABLE: DurableObjectNamespace;
  ALLOWED_ORIGIN: string;
  ADMIN_TOKEN: string;
  SMS_SIGNING_SECRET: string;
}

type User = { id: string; username: string; balanceSyp: number; status: string };
const json = (data: unknown, status = 200, origin = '*') => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
const tableConfig = { 'berlin-9max': { name: 'طاولة بوكر تكساس', variant: 'texas', capacity: 9, blinds: '5 / 10', buyInMin: 350, buyInMax: 5000 }, 'london-5max': { name: 'طاولة بوكر أوماها', variant: 'omaha', capacity: 5, blinds: '5 / 10', buyInMin: 500, buyInMax: 5000 } } as const;

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const origin = env.ALLOWED_ORIGIN || '*';
  if (request.method === 'OPTIONS') return json({}, 204, origin);
  const url = new URL(request.url);
  try {
    if (url.pathname === '/health') return json({ ok: true, service: 'bokerr-api' }, 200, origin);
    if (url.pathname === '/api/tables' && request.method === 'GET') return json(await listTables(env), 200, origin);
    if (url.pathname.startsWith('/ws/')) { const id = url.pathname.split('/').pop(); if (!id || !(id in tableConfig)) return json({ error: 'unknown_table' }, 404, origin); return env.POKER_TABLE.get(env.POKER_TABLE.idFromName(id)).fetch(request); }
    const user = await authenticateUser(request, env);
    if (url.pathname === '/api/wallet' && request.method === 'GET') return json(await wallet(env, user.id), 200, origin);
    if (url.pathname === '/api/withdraw' && request.method === 'POST') return json(await withdraw(request, env, user), 201, origin);
    if (url.pathname === '/api/payments/sms-proof' && request.method === 'POST') return json(await smsProof(request, env), 202, origin);
    if (url.pathname.startsWith('/api/admin/')) { if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403, origin); return json(await admin(url.pathname, request, env), 200, origin); }
    return json({ error: 'not_found' }, 404, origin);
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'internal_error' }, 400, origin); }
} };

async function authenticateUser(request: Request, env: Env): Promise<User> { const id = request.headers.get('x-user-id') || 'demo-user'; const row = await env.DB.prepare('SELECT id, username, balance_syp as balanceSyp, status FROM users WHERE id = ?').bind(id).first<User>(); if (row) { if (row.status === 'frozen') throw new Error('account_frozen'); return row; } await env.DB.prepare('INSERT INTO users(id, username) VALUES (?, ?)').bind(id, 'لاعب_جديد').run(); return { id, username: 'لاعب_جديد', balanceSyp: 0, status: 'active' }; }
async function listTables(env: Env) { return Promise.all(Object.entries(tableConfig).map(async ([id, config]) => { const state = await env.POKER_TABLE.get(env.POKER_TABLE.idFromName(id)).fetch('https://table/state'); const data = await state.json<{ seated: number }>(); return { id, ...config, seated: data.seated }; })); }
async function wallet(env: Env, userId: string) { const row = await env.DB.prepare('SELECT balance_syp as balanceSyp FROM users WHERE id = ?').bind(userId).first<{ balanceSyp: number }>(); const txs = await env.DB.prepare('SELECT id,type,amount_syp as amountSyp,status,method,external_ref as ref,created_at as date FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all(); return { balanceSyp: row?.balanceSyp || 0, transactions: txs.results }; }
async function withdraw(request: Request, env: Env, user: User) { const body = await request.json<{ amountSyp: number; phone: string }>(); if (!Number.isInteger(body.amountSyp) || body.amountSyp <= 0 || !body.phone) throw new Error('invalid_withdrawal'); const id = crypto.randomUUID(); const tx = crypto.randomUUID(); const result = await env.DB.batch([env.DB.prepare('UPDATE users SET balance_syp = balance_syp - ? WHERE id = ? AND balance_syp >= ?').bind(body.amountSyp, user.id, body.amountSyp), env.DB.prepare('INSERT INTO wallet_transactions(id,user_id,type,amount_syp,status) VALUES(?,?,?,?,?)').bind(tx, user.id, 'withdraw', body.amountSyp, 'pending'), env.DB.prepare('INSERT INTO withdrawal_requests(id,user_id,amount_syp,phone) VALUES(?,?,?,?)').bind(id, user.id, body.amountSyp, body.phone)]); if (!result[0].meta.changes) throw new Error('insufficient_balance'); return { id, status: 'pending' }; }
async function smsProof(request: Request, env: Env) { const body = await request.json<{ reference: string; amountSyp: number; proof: string }>(); if (!body.reference || !body.amountSyp || !body.proof) throw new Error('invalid_sms_proof'); const duplicate = await env.DB.prepare('SELECT id FROM wallet_transactions WHERE external_ref = ?').bind(body.reference).first(); if (duplicate) return { accepted: false, reason: 'duplicate' }; return { accepted: true, reference: body.reference, note: 'pending_provider_verification' }; }
function isAdmin(request: Request, env: Env) { return request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`; }
async function admin(path: string, request: Request, env: Env) { if (path === '/api/admin/overview') { const users = await env.DB.prepare('SELECT id,username,balance_syp as balanceSyp,status FROM users ORDER BY created_at DESC').all(); const transactions = await env.DB.prepare('SELECT t.id,t.type,t.amount_syp as amountSyp,t.status,u.username FROM wallet_transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 100').all(); return { users: users.results, transactions: transactions.results, tables: Object.entries(tableConfig).map(([id, c]) => ({ id, name: c.name, capacity: c.capacity, seated: 0 })) }; } const body = await request.json<Record<string, unknown>>(); if (path === '/api/admin/freeze') { await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(body.frozen ? 'frozen' : 'active', body.userId).run(); return { ok: true }; } if (path === '/api/admin/balance') { const amount = Number(body.balanceSyp); if (!Number.isInteger(amount) || amount < 0) throw new Error('invalid_balance'); await env.DB.prepare('UPDATE users SET balance_syp = ? WHERE id = ?').bind(amount, body.userId).run(); return { ok: true }; } throw new Error('unknown_admin_action'); }

export class PokerTable {
  state: DurableObjectState; env: Env; connections = new Set<WebSocket>(); round: Round | null = null; turnToken = crypto.randomUUID(); usedActions = new Set<string>();
  constructor(state: DurableObjectState, env: Env) { this.state = state; this.env = env; }
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') return Response.json({ seated: this.connections.size, stage: this.round?.stage || 'waiting', board: this.round ? this.round.board.slice(0, this.round.stage === 'preflop' ? 0 : this.round.stage === 'flop' ? 3 : this.round.stage === 'turn' ? 4 : 5) : [] });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair); server.accept(); this.connections.add(server); server.addEventListener('close', () => this.connections.delete(server)); server.addEventListener('message', (event) => this.handle(server, String(event.data))); server.send(JSON.stringify({ type: 'ready', turnSeconds: 20, turnToken: this.turnToken })); return new Response(null, { status: 101, webSocket: client });
  }
  handle(socket: WebSocket, raw: string) {
    try {
      const msg = JSON.parse(raw) as { type: string; actionId?: string; turnToken?: string; variant?: 'texas' | 'omaha'; players?: string[]; playerId?: string };
      if (!msg.actionId || msg.turnToken !== this.turnToken || this.usedActions.has(msg.actionId)) return socket.send(JSON.stringify({ type: 'error', error: 'invalid_or_replayed_action' }));
      this.usedActions.add(msg.actionId);
      if (msg.type === 'start') { if (!msg.variant || !msg.players) throw new Error('missing_round'); this.round = startRound(msg.variant, msg.players); this.broadcast({ type: 'round_started', stage: this.round.stage }); return; }
      if (!this.round || !msg.playerId) throw new Error('round_not_started');
      const player = this.round.players[this.round.turnIndex]; if (player.id !== msg.playerId) throw new Error('not_your_turn');
      if (!['fold', 'check', 'call', 'bet'].includes(msg.type)) throw new Error('unsupported_action');
      if (msg.type === 'fold') player.folded = true; else { const amount = msg.type === 'bet' ? 10 : 5; player.committed += amount; this.round.pot += amount; }
      this.round = advance(this.round); if (this.round.stage === 'showdown') { const winners = this.round.players.filter((p) => !p.folded).sort((a, b) => compare(bestScore(this.round as Round, b), bestScore(this.round as Round, a))).slice(0, 1).map((p) => p.id); this.broadcast({ type: 'showdown', pot: this.round.pot, winners }); } else this.broadcast({ type: 'action', action: msg.type, stage: this.round.stage, pot: this.round.pot });
    } catch (error) { socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'malformed_message' })); }
  }
  broadcast(data: unknown) { for (const client of this.connections) client.send(JSON.stringify(data)); }
}
function compare(a: number[], b: number[]) { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; }
