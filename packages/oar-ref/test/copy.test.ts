import assert from 'node:assert/strict';
import test from 'node:test';

import { CopyLoadError, parseCopy, renderCopy } from '../src/copy.js';

test('parseCopy collects bindings and conditionals', () => {
  const refs = parseCopy('Use {{ tool }}{% if arg_validation_reason %} — {{ arg_validation_reason }}{% endif %}');
  const names = [...new Set(refs.map((r) => r.name))].sort();
  assert.deepEqual(names, ['arg_validation_reason', 'tool']);
  assert.equal(refs.find((r) => r.name === 'tool')?.interpolate, true);
});

test('parseCopy accepts dotted host names and insignificant whitespace', () => {
  const refs = parseCopy('{{lycaon.worker_leg}} and {{ lycaon.worker_leg }}');
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.name, 'lycaon.worker_leg');
});

test('parseCopy rejects a for-loop', () => {
  assert.throws(() => parseCopy('{% for p in paths %}{{ p }}{% endfor %}'), CopyLoadError);
});

test('parseCopy rejects an unknown tag', () => {
  assert.throws(() => parseCopy('{% include "x" %}'), CopyLoadError);
});

test('renderCopy substitutes lists and omits zero-value ifs', () => {
  const lookup = (name: string) => {
    if (name === 'tool') return 'command';
    if (name === 'arg_validation_reason') return '';
    if (name === 'fields') return ['host_resources', 'direct_ip'];
    return '';
  };
  assert.equal(
    renderCopy('{{ tool }}: {{ fields }}{% if arg_validation_reason %} — {{ arg_validation_reason }}{% endif %}', lookup),
    'command: host_resources, direct_ip',
  );
});

test('renderCopy honors if / else / not', () => {
  const lookup = (name: string) => (name === 'flag' ? true : '');
  assert.equal(renderCopy('{% if flag %}yes{% else %}no{% endif %}', lookup), 'yes');
  assert.equal(renderCopy('{% if not flag %}yes{% else %}no{% endif %}', lookup), 'no');
  const empty = (name: string) => (name === 'flag' ? false : '');
  assert.equal(renderCopy('{% if flag %}yes{% else %}no{% endif %}', empty), 'no');
});
