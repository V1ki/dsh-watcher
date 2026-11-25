import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

interface LoadedPluginEntry {
  id: string;
  factory: (require: (id: string) => Record<string, unknown>) => {
    apply: (ctx: {
      slots: {
        inject: (name: string, fn: () => unknown) => unknown;
        register: (slot: Record<string, unknown>, render: unknown) => unknown;
      };
    }) => void;
  };
}

interface SlotRegistration {
  slot: {
    key?: string;
    id?: string;
    label?: () => string;
  };
  render: unknown;
}

const clientCandidates = [
  new URL('../../lib/client.js', import.meta.url),
  new URL('../lib/client.js', import.meta.url),
];

test('browser entry loads through DSH module factory and registers matching panel slots', () => {
  const clientUrl = clientCandidates.find((url) => existsSync(url)) ?? clientCandidates[0];
  let loaded: LoadedPluginEntry | undefined;
  const registrations: SlotRegistration[] = [];
  vm.runInNewContext(readFileSync(clientUrl, 'utf8'), {
    window: {
      __ModuleLoader__: {
        load: (entry: LoadedPluginEntry) => {
          loaded = entry;
        },
      },
    },
  });
  assert.ok(loaded);
  assert.equal(loaded.id, '@local/dsh-connector-wxarc');
  const plugin = loaded.factory((id) => {
    assert.equal(id, 'react');
    return {};
  });
  plugin.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (slot, render) => registrations.push({ slot, render }),
    },
  });
  assert.equal(registrations[0].slot.key, registrations[1].slot.id);
  assert.equal(registrations[1].slot.label?.(), '微信消息');
});
