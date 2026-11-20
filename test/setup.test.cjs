'use strict';

const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../manifest.json');

test('manifest points at index.js', () => {
    assert.strictEqual(manifest.js, 'index.js');
    assert.strictEqual(manifest.display_name, 'TravelingTavern');
});
