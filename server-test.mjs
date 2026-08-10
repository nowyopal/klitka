import assert from 'node:assert/strict';
import fs from 'node:fs';
import { START_CASH, START_PRICE, AUCTION_MS, LISTING_RENTS, __test } from './server.mjs';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const clientRents = [...html.matchAll(/\{ city: '[^']+', area: [\d.]+, rent: (\d+), photos:/g)]
  .map(match => Number(match[1]));
assert.deepEqual(LISTING_RENTS, clientRents);

const { room, player: host } = __test.newRoom('Rafał');
const guest = __test.makePlayer('Piotr', 1);
room.players.push(guest);
room.deck = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
room.phase = 'ready';

room.ready.add(host.id);
room.ready.add(guest.id);
__test.beginCountdown(room);
assert.equal(room.phase, 'countdown');
assert.ok(room.auctionStartsAt > Date.now());

__test.clearRoomTimers(room);
room.phase = 'auction';
room.auctionStartsAt = Date.now() - AUCTION_MS / 2;
const hostBuy = __test.settleBuy(room, host);
assert.equal(hostBuy.ok, true);
assert.ok(hostBuy.price > 0 && hostBuy.price <= START_PRICE);
assert.equal(host.cash, START_CASH - hostBuy.price);
assert.equal(host.properties.length, 1);
assert.equal(host.properties[0].rent, LISTING_RENTS[0]);

const guestBuy = __test.settleBuy(room, guest);
assert.equal(guestBuy.ok, false);
assert.equal(guestBuy.status, 409);
assert.equal(guest.cash, START_CASH);

__test.clearRoomTimers(room);
__test.rooms.delete(room.code);

console.log('KLITKA network server test: OK');
