import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readKeySetupForDocument,
  registerKeySetupForDocument,
} from './keySetupRegistry.js';

test('key setup resolves only the API registered for the exact document', () => {
  const hostDocument = {};
  const frameDocument = {};
  const hostApi = { open() {} };
  const frameApi = { open() {} };
  const unregisterHost = registerKeySetupForDocument(hostDocument, hostApi);
  const unregisterFrame = registerKeySetupForDocument(frameDocument, frameApi);
  assert.equal(readKeySetupForDocument(hostDocument), hostApi);
  assert.equal(readKeySetupForDocument(frameDocument), frameApi);
  assert.equal(readKeySetupForDocument({}), undefined);
  unregisterHost();
  assert.equal(readKeySetupForDocument(hostDocument), undefined);
  assert.equal(readKeySetupForDocument(frameDocument), frameApi);
  unregisterFrame();
  assert.equal(readKeySetupForDocument(frameDocument), undefined);
});

test('a retired setup teardown cannot remove the replacement for the same document', () => {
  const doc = {};
  const oldApi = { name: 'old' };
  const newApi = { name: 'replacement' };
  const removeOld = registerKeySetupForDocument(doc, oldApi);
  const removeNew = registerKeySetupForDocument(doc, newApi);
  removeOld();
  removeOld();
  assert.equal(readKeySetupForDocument(doc), newApi);
  removeNew();
  assert.equal(readKeySetupForDocument(doc), undefined);
  const thirdApi = {};
  const removeThird = registerKeySetupForDocument(doc, thirdApi);
  removeNew();
  assert.equal(readKeySetupForDocument(doc), thirdApi);
  removeThird();
});

test('invalid document inputs do not become a global setup registration', () => {
  for (const doc of [undefined, null, false, 'document', 1]) {
    assert.throws(
      () => registerKeySetupForDocument(doc, {}),
      /requires a document/,
    );
    assert.equal(readKeySetupForDocument(doc), undefined);
  }
});
