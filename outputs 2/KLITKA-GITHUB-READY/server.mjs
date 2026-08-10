import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const START_CASH = 5_000_000;
export const START_PRICE = 2_000_000;
export const AUCTION_MS = 8_000;
export const COUNTDOWN_MS = 2_900;
export const RESULT_MS = 1_300;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

// Kolejność musi odpowiadać LISTINGS w index.html.
export const LISTING_RENTS = [
  850, 2350, 1450, 2100, 1400,
  1400, 2200, 1200, 1500, 2350,
  2350, 1750, 1600, 1500, 1200,
  950, 1850, 850, 2400, 2500
];

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();

const json = (response, status, body) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
};

const cleanName = value => String(value || '')
  .trim()
  .replace(/[<>]/g, '')
  .slice(0, 16);

const shuffle = input => {
  const values = input.slice();
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
};

const createCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = Array.from(
      { length: 5 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join('');
    if (!rooms.has(code)) return code;
  }
  throw new Error('Nie udało się utworzyć kodu pokoju.');
};

const makePlayer = (name, index) => ({
  id: crypto.randomUUID(),
  token: crypto.randomBytes(24).toString('hex'),
  name,
  cash: START_CASH,
  properties: [],
  avatarIndex: index % MAX_PLAYERS
});

const publicPlayer = player => ({
  id: player.id,
  name: player.name,
  cash: player.cash,
  properties: player.properties,
  avatarIndex: player.avatarIndex
});

const snapshot = (room, selfId) => ({
  serverNow: Date.now(),
  revision: room.revision,
  roomCode: room.code,
  selfId,
  hostId: room.hostId,
  phase: room.phase,
  players: room.players.map(publicPlayer),
  readyIds: [...room.ready],
  round: room.round,
  totalListings: room.deck.length,
  listingId: room.deck[room.round] ?? null,
  auctionStartsAt: room.auctionStartsAt,
  auctionEndsAt: room.auctionEndsAt,
  result: room.result
});

const writeEvent = (response, eventName, data) => {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
};

const broadcast = room => {
  room.revision += 1;
  room.updatedAt = Date.now();
  for (const [playerId, responses] of room.streams) {
    for (const response of responses) writeEvent(response, 'state', snapshot(room, playerId));
  }
};

const clearRoomTimers = room => {
  for (const timer of room.timers) clearTimeout(timer);
  room.timers.clear();
};

const schedule = (room, callback, delay) => {
  const timer = setTimeout(() => {
    room.timers.delete(timer);
    callback();
  }, delay);
  room.timers.add(timer);
};

const beginAuction = room => {
  if (room.phase !== 'countdown') return;
  room.phase = 'auction';
  room.auctionStartsAt = Date.now();
  room.auctionEndsAt = room.auctionStartsAt + AUCTION_MS;
  broadcast(room);
  schedule(room, () => settleUnsold(room), AUCTION_MS + 25);
};

const beginCountdown = room => {
  if (room.phase !== 'ready') return;
  room.phase = 'countdown';
  room.auctionStartsAt = Date.now() + COUNTDOWN_MS;
  room.auctionEndsAt = room.auctionStartsAt + AUCTION_MS;
  broadcast(room);
  schedule(room, () => beginAuction(room), COUNTDOWN_MS);
};

const advanceRound = room => {
  if (room.phase !== 'result') return;
  room.round += 1;
  room.ready.clear();
  room.result = null;
  room.auctionStartsAt = null;
  room.auctionEndsAt = null;
  room.phase = room.round >= room.deck.length ? 'final' : 'ready';
  broadcast(room);
};

const settleUnsold = room => {
  if (room.phase !== 'auction') return false;
  clearRoomTimers(room);
  room.phase = 'result';
  room.result = {
    type: 'unsold',
    listingId: room.deck[room.round],
    price: 0,
    playerId: null
  };
  broadcast(room);
  schedule(room, () => advanceRound(room), RESULT_MS);
  return true;
};

const settleBuy = (room, player) => {
  if (room.phase !== 'auction') return { ok: false, status: 409, error: 'Aukcja nie jest aktywna.' };
  const elapsed = Math.max(0, Date.now() - room.auctionStartsAt);
  const price = Math.max(0, Math.floor(START_PRICE * (1 - elapsed / AUCTION_MS)));
  if (price <= 0) return { ok: false, status: 409, error: 'Cena spadła już do zera.' };
  if (price > player.cash) return { ok: false, status: 409, error: 'Nie masz wystarczającego salda.' };

  clearRoomTimers(room);
  const listingId = room.deck[room.round];
  player.cash -= price;
  player.properties.push({ listingId, rent: LISTING_RENTS[listingId], paid: price });
  room.phase = 'result';
  room.result = { type: 'sold', listingId, price, playerId: player.id };
  broadcast(room);
  schedule(room, () => advanceRound(room), RESULT_MS);
  return { ok: true, price };
};

const newRoom = name => {
  const code = createCode();
  const host = makePlayer(name, 0);
  const room = {
    code,
    hostId: host.id,
    phase: 'lobby',
    players: [host],
    ready: new Set(),
    deck: [],
    round: 0,
    auctionStartsAt: null,
    auctionEndsAt: null,
    result: null,
    streams: new Map(),
    timers: new Set(),
    revision: 0,
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  return { room, player: host };
};

const authenticate = (room, playerId, token) => {
  if (!room) return null;
  return room.players.find(player => player.id === playerId && player.token === token) || null;
};

const readBody = request => new Promise((resolve, reject) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 12_000) reject(new Error('Żądanie jest za duże.'));
  });
  request.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); }
    catch { reject(new Error('Nieprawidłowe dane.')); }
  });
  request.on('error', reject);
});

const serveFile = (response, requestPath) => {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  if (relativePath !== 'index.html' && !relativePath.startsWith('assets/')) return false;
  const filePath = path.resolve(rootDirectory, relativePath);
  if (!filePath.startsWith(rootDirectory + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  response.writeHead(200, {
    'content-type': contentTypes[extension] || 'application/octet-stream',
    'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=86400'
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
};

export const createRequestHandler = () => async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
    return json(response, 200, { ok: true, rooms: rooms.size });
  }

  if (request.method === 'GET' && requestUrl.pathname === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('User-agent: *\nDisallow: /\n');
  }

  const streamMatch = requestUrl.pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})\/stream$/);
  if (request.method === 'GET' && streamMatch) {
    const room = rooms.get(streamMatch[1]);
    const player = authenticate(room, requestUrl.searchParams.get('playerId'), requestUrl.searchParams.get('token'));
    if (!player) return json(response, 401, { error: 'Nieprawidłowa sesja gracza.' });
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.write('retry: 1500\n\n');
    if (!room.streams.has(player.id)) room.streams.set(player.id, new Set());
    room.streams.get(player.id).add(response);
    writeEvent(response, 'state', snapshot(room, player.id));
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 20_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      room.streams.get(player.id)?.delete(response);
    });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/rooms') {
    try {
      const body = await readBody(request);
      const name = cleanName(body.name);
      if (!name) return json(response, 400, { error: 'Podaj imię albo przezwisko.' });
      const { room, player } = newRoom(name);
      return json(response, 201, { roomCode: room.code, playerId: player.id, token: player.token });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const actionMatch = requestUrl.pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})\/(join|start|ready|buy)$/);
  if (request.method === 'POST' && actionMatch) {
    const room = rooms.get(actionMatch[1]);
    if (!room) return json(response, 404, { error: 'Nie ma pokoju o takim kodzie.' });
    try {
      const body = await readBody(request);
      const action = actionMatch[2];

      if (action === 'join') {
        if (room.phase !== 'lobby') return json(response, 409, { error: 'Ta gra już się rozpoczęła.' });
        if (room.players.length >= MAX_PLAYERS) return json(response, 409, { error: 'Pokój jest pełny.' });
        const name = cleanName(body.name);
        if (!name) return json(response, 400, { error: 'Podaj imię albo przezwisko.' });
        const player = makePlayer(name, room.players.length);
        room.players.push(player);
        broadcast(room);
        return json(response, 201, { roomCode: room.code, playerId: player.id, token: player.token });
      }

      const player = authenticate(room, body.playerId, body.token);
      if (!player) return json(response, 401, { error: 'Nieprawidłowa sesja gracza.' });

      if (action === 'start') {
        if (player.id !== room.hostId) return json(response, 403, { error: 'Tylko gospodarz może rozpocząć grę.' });
        if (room.phase !== 'lobby') return json(response, 409, { error: 'Gra już się rozpoczęła.' });
        if (room.players.length < MIN_PLAYERS) return json(response, 409, { error: 'Potrzeba co najmniej 2 graczy.' });
        room.deck = shuffle(LISTING_RENTS.map((_, index) => index)).slice(0, room.players.length + 8);
        room.round = 0;
        room.phase = 'ready';
        room.ready.clear();
        room.result = null;
        broadcast(room);
        return json(response, 200, { ok: true });
      }

      if (action === 'ready') {
        if (room.phase !== 'ready') return json(response, 409, { error: 'Teraz nie można zgłosić gotowości.' });
        room.ready.add(player.id);
        broadcast(room);
        if (room.ready.size === room.players.length) beginCountdown(room);
        return json(response, 200, { ok: true });
      }

      const outcome = settleBuy(room, player);
      return json(response, outcome.ok ? 200 : outcome.status, outcome);
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  if (request.method === 'GET' && serveFile(response, decodeURIComponent(requestUrl.pathname))) return;
  json(response, 404, { error: 'Nie znaleziono.' });
};

export const createKlitkaServer = () => http.createServer(createRequestHandler());

export const __test = {
  rooms,
  newRoom,
  makePlayer,
  authenticate,
  settleBuy,
  settleUnsold,
  beginCountdown,
  clearRoomTimers
};

const cleanup = setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff) {
      clearRoomTimers(room);
      rooms.delete(code);
    }
  }
}, 60_000);
cleanup.unref();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8765);
  createKlitkaServer().listen(port, '0.0.0.0', () => {
    console.log(`KLITKA online: http://0.0.0.0:${port}`);
  });
}
