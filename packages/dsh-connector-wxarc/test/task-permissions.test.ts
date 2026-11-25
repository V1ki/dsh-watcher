import assert from 'node:assert/strict';
import test from 'node:test';
import { needsOperationConfirmation, taskReusable } from '../src/task-permissions.js';

const bash = (command: string) => ({ name: 'bash', arguments: { command } });

test('task grants cover verifiable inspection commands, not destructive or opaque execution', () => {
  for (const command of [
    'pwd',
    'ls -l /Applications; command -v swiftc',
    'cd /work && head -c 300 page.html',
    '/usr/bin/du -sh /Applications',
    'ls /Applications | grep -i browser',
    'ls missing 2>/dev/null; echo done',
    '~/Applications/SwiftCUA.app/Contents/MacOS/cua windows --app com.google.Chrome 2>&1 | head -20',
  ]) {
    assert.equal(taskReusable(bash(command)), true, command);
  }
  for (const command of [
    'rm -f temp',
    '/bin/rm -f temp',
    'brew install ffmpeg',
    'npm install x',
    'sudo installer -pkg a',
    'defaults write domain key value',
    'osascript -e script',
    'launchctl kickstart test',
    'python3 -c "import os"',
    'sh script',
    'eval "ls"',
    'find /work -delete',
    'find /work -exec sh script ;',
    'find /work -fls out',
    'rg --pre=script x',
    'ls > /etc/config',
    'ls $(rm file)',
    'ls `touch x`',
    'ls\nrm file',
    '/tmp/ls',
    '/tmp/cua state',
    'command rm file',
    'curl -X POST https://example.com',
    'plutil -replace x -string y plist',
    'cua click --x 1 --y 2',
  ]) {
    assert.equal(taskReusable(bash(command)), false, command);
  }
  for (const command of [
    'brew install package',
    'pip install package',
    'npm install package',
    'softwareupdate --install --all',
    'installer -pkg p',
    'sudo chmod 777 file',
  ]) {
    assert.equal(needsOperationConfirmation(bash(command)), true, command);
  }
  assert.equal(taskReusable({ name: 'job_output', arguments: { job_id: 'current' } }), true);
  assert.equal(taskReusable({ name: 'job_kill', arguments: { job_id: 'current' } }), false);
  assert.equal(
    taskReusable({
      ...bash('ls'),
      arguments: { command: 'ls', sandbox_permissions: 'require_escalated' },
    }),
    false,
  );
});
