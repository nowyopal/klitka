import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const target = process.argv[2]
  ? new URL(process.argv[2], `file://${process.cwd()}/`)
  : new URL('./index.html', import.meta.url);
const html = fs.readFileSync(target, 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const allElements = [];
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = '';
    this.classList = {
      add: (...names) => names.forEach(name => {
        if (!this.className.split(/\s+/).includes(name)) this.className += ` ${name}`;
      }),
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const has = this.className.split(/\s+/).includes(name);
        const add = force === undefined ? !has : force;
        if (add && !has) this.className += ` ${name}`;
        if (!add && has) this.className = this.className.split(/\s+/).filter(item => item !== name).join(' ');
        return add;
      }
    };
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.offsetHeight = 50;
    this.listeners = {};
    this._innerHTML = '';
    allElements.push(this);
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    if (this._innerHTML === '<span>0</span>') {
      const span = new FakeElement('span');
      span.textContent = '0';
      this.children.push(span);
    }
  }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector(selector) {
    if (selector === 'span') return this.children.find(child => child.tagName === 'SPAN') || null;
    return null;
  }
  focus() {}
}

const singleton = new Map();
const one = selector => {
  if (!singleton.has(selector)) singleton.set(selector, new FakeElement());
  return singleton.get(selector);
};
globalThis.document = {
  querySelector: one,
  querySelectorAll(selector) {
    if (selector === '.ticker-digit') return allElements.filter(el => el.className.split(/\s+/).includes('ticker-digit'));
    return [];
  },
  createElement(tag) { return new FakeElement(tag); }
};
globalThis.window = globalThis;
globalThis.window.scrollTo = () => {};
globalThis.performance = { now: () => 1_000 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};

vm.runInThisContext(source, { filename: 'index.html' });

const game = window.__KLITKA__;
assert.ok(game, 'diagnostic API should exist');
assert.equal(one('#demo-button').disabled, true);
assert.equal(one('#create-button').disabled, true);
assert.equal(one('#join-button').disabled, true);

one('#name-input').value = 'Rafał';
one('#name-input').listeners.input();
assert.equal(one('#demo-button').disabled, false);
assert.equal(one('#create-button').disabled, false);
assert.equal(one('#join-button').disabled, true);

one('#join-code').value = 'K7M2X';
one('#join-code').listeners.input({ target: one('#join-code') });
assert.equal(one('#join-button').disabled, false);

assert.equal(game.constants.START_CASH, 5_000_000);
assert.equal(game.constants.START_PRICE, 2_000_000);
assert.equal(game.constants.AUCTION_MS, 8_000);
assert.equal(game.listings.length, 20);
assert.ok(game.listings.every(listing => listing.area < 25));
assert.ok(game.listings.every(listing => listing.photos.length >= 1 && listing.photos.length <= 3));
assert.ok(game.listings.every(listing => listing.photos.every(photo => photo.startsWith('assets/listings/'))));
assert.ok(game.listings.every(listing => listing.photos.every(photo => fs.existsSync(new URL(photo, target)))));
assert.ok(!html.includes('PHOTO_SETS'));
assert.match(html, /<strong id="my-wallet" hidden>/);
assert.match(html, /\.balances-heading/);

for (const count of [2, 3, 4, 5, 6]) {
  game.startDemo(count);
  assert.equal(game.state.players.length, count);
  assert.equal(game.state.listings.length, count + 8);
  assert.ok(game.state.players.every(player => player.cash === 5_000_000));
  assert.equal(game.state.phase, 'ready');
}

game.startDemo(4);
assert.equal(game.state.listings.length, 12);
game.beginAuction();
assert.equal(game.state.phase, 'auction');
assert.equal(game.priceAt(1_000), 2_000_000);
assert.equal(game.priceAt(5_000), 1_000_000);
assert.equal(game.priceAt(9_000), 0);

const rent = game.state.listings[0].rent;
game.settleSale('p0', 456_250);
assert.equal(game.state.players[0].cash, 4_543_750);
assert.equal(game.state.players[0].properties.length, 1);
assert.equal(game.state.players[0].properties[0].rent, rent);

game.state.players[1].properties.push({ rent: rent + 500, paid: 300_000 });
game.showFinal();
assert.equal(game.state.phase, 'final');

console.log('KLITKA flow test: OK');
