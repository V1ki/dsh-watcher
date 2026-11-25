import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

interface ModuleRegistration {
  id: string;
  factory: (require: (mod: string) => unknown) => {
    inject: string[];
    apply: (ctx: {
      slots: {
        inject: (name: string, factory: () => unknown) => void;
        register: (meta: Record<string, unknown>, component: unknown) => unknown;
      };
    }) => void;
  };
}

test('compiled lib/client.js executes as a classic script and registers @local/dsh-persona via __ModuleLoader__.load', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const clientPath = path.resolve(testDir, '..', '..', 'lib', 'client.js');
  const code = fs.readFileSync(clientPath, 'utf8');

  assert.equal(/^\s*export\b/m.test(code), false);
  assert.equal(/^\s*import\b/m.test(code), false);

  const registrations: ModuleRegistration[] = [];
  const sandboxWindow = {
    __ModuleLoader__: {
      load(spec: ModuleRegistration): void {
        registrations.push(spec);
      },
    },
  };

  const script = new vm.Script(code, { filename: 'lib/client.js' });
  const context = vm.createContext({ window: sandboxWindow, globalThis: sandboxWindow });
  script.runInContext(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, '@local/dsh-persona');
  assert.equal(typeof registrations[0].factory, 'function');

  const fakeReact = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    useState: <T,>(initial: T) => [initial, () => {}],
    useEffect: () => {},
    useCallback: <T,>(fn: T) => fn,
  };

  const plugin = registrations[0].factory((mod: string) => {
    assert.equal(mod, 'react');
    return fakeReact;
  });

  assert.deepEqual(Array.from(plugin.inject), ['slots']);
  assert.equal(typeof plugin.apply, 'function');

  const registeredSlots: Array<{ meta: Record<string, unknown>; component: unknown }> = [];
  const injectedSlotNames: string[] = [];

  plugin.apply({
    slots: {
      inject(name: string, factory: () => unknown): void {
        injectedSlotNames.push(name);
        factory();
      },
      register(meta: Record<string, unknown>, component: unknown): unknown {
        registeredSlots.push({ meta, component });
        return meta;
      },
    },
  });

  assert.deepEqual(injectedSlotNames, ['main', 'sidebar.panellist']);
  assert.equal(registeredSlots.length, 2);

  const mainSlot = registeredSlots.find((s) => s.meta.name === 'main');
  assert.equal(mainSlot?.meta.key, 'dsh-persona-panel');
  assert.equal(typeof mainSlot?.component, 'function');

  const renderedTree = (mainSlot!.component as () => unknown)();
  const renderedJson = JSON.stringify(renderedTree);
  assert.ok(renderedJson.includes('性格衣柜'));
  assert.ok(renderedJson.includes('我的分身'));
  assert.ok(renderedJson.includes('导入 wxarc 数据'));

  const sidebarSlot = registeredSlots.find((s) => s.meta.name === 'sidebar.panellist');
  assert.equal(sidebarSlot?.meta.id, 'dsh-persona-panel');
  assert.equal(sidebarSlot?.meta.order, 14);
  assert.equal((sidebarSlot?.meta.label as () => string)(), '性格衣柜');
});
