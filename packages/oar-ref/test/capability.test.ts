import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCapability, referenceCapabilityDocument } from '../src/capability.js';

test('[OAR-FACT-24] capability collections reject duplicate and unknown entries', () => {
  for (const field of ['profiles', 'detectors']) {
    const doc = referenceCapabilityDocument();
    const entries = doc[field] as string[];
    entries.push(entries[0]!);
    assert.throws(() => loadCapability(doc), new RegExp(field));
  }
  for (const field of ['unsupported', 'host']) {
    const doc = referenceCapabilityDocument();
    const anchors = doc['anchors'] as Record<string, unknown>;
    anchors[field] = field === 'host' ? ['native.anchor', 'native.anchor'] : ['agent.finalize', 'agent.finalize'];
    if (field === 'unsupported') delete (anchors['core'] as Record<string, unknown>)['agent.finalize'];
    assert.throws(() => loadCapability(doc), /duplicate/);
  }
  const doc = referenceCapabilityDocument();
  (doc['anchors'] as Record<string, unknown>)['misspelled'] = [];
  assert.throws(() => loadCapability(doc), /misspelled/);
});

test('[OAR-FACT-24] host fact metadata uses the closed capability schema', () => {
  for (const extra of [{ unexpected: true }, { observation: 42 }]) {
    const doc = referenceCapabilityDocument();
    doc['host_facts'] = [{ name: 'openagentrules.reference.value', type: 'string', ...extra }];
    assert.throws(() => loadCapability(doc), /host_facts/);
  }
});
