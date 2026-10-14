// Setup controls belong to their exact document, including embedded hosts.
const setupApis = new WeakMap();

export function readKeySetupForDocument(doc) {
  return doc && typeof doc === 'object' ? setupApis.get(doc) : undefined;
}

export function registerKeySetupForDocument(doc, api) {
  if (!doc || typeof doc !== 'object')
    throw new TypeError('Key setup requires a document');
  setupApis.set(doc, api);
  return () => {
    if (setupApis.get(doc) === api) setupApis.delete(doc);
  };
}
