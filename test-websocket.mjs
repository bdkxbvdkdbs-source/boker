const base = process.argv[2];
if (!base) throw new Error('Usage: node test-websocket.mjs wss://api.example.com');
const table = 'berlin-9max';
const ws = new WebSocket(`${base.replace(/\/$/, '')}/ws/${table}`);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000);
ws.addEventListener('open', () => { console.log('connected'); ws.send(JSON.stringify({ type: 'start', variant: 'texas', players: ['u1', 'u2'], actionId: crypto.randomUUID(), turnToken: 'replace-with-token-from-ready' })); });
ws.addEventListener('message', (event) => { console.log(event.data); const data = JSON.parse(event.data); if (data.type === 'ready' && data.turnToken) ws.send(JSON.stringify({ type: 'start', variant: 'texas', players: ['u1', 'u2'], actionId: crypto.randomUUID(), turnToken: data.turnToken })); if (data.type === 'round_started') { clearTimeout(timer); ws.close(); process.exit(0); } });
ws.addEventListener('error', (event) => { console.error('websocket error', event); clearTimeout(timer); process.exit(1); });
