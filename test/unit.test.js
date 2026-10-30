import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, totpAt, totpCheck, hashPassword, verifyPassword } from '../src/crypto.js';
import { calc } from '../src/tools/basic.js';
import { isReadOnly } from '../src/tools/ssh.js';
import { cmpVer } from '../src/updates.js';

test('TOTP matches RFC 6238 test vector', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.ok(totpCheck(secret, '287082', 59000) >= 0);
  assert.equal(totpCheck(secret, '000000', 59000), -1);
});
test('password hashing', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!h.includes('correct'));
});
test('calculator is safe arithmetic only', () => {
  assert.equal(calc('(12.5*4)/3'), 16.666666666667);
  assert.equal(calc('2^10'), 1024);
  assert.equal(calc('-3+5*2'), 7);
  assert.throws(() => calc('process.exit()'));
  assert.throws(() => calc('1/0'));
});
test('read-only command classifier', () => {
  const ro = ['df -h', 'ls -la /var/www', 'uptime', 'systemctl status nginx', 'systemctl --no-pager status nginx', 'docker ps -a', 'journalctl -u nginx -n 50 --no-pager', 'git status', 'cat /etc/os-release | grep VERSION', 'free -m', 'ps aux | grep node | head -5', 'tail -n 100 /var/log/syslog', 'ip -br a', 'find /var/www -name "*.php"', 'docker stats --no-stream', 'top -b -n 1 | head -20', 'node -v', 'ss -tlnp'];
  const rw = ['rm -rf /tmp/x', 'sudo systemctl restart nginx', 'systemctl restart nginx', 'apt install nginx', 'echo hi > /etc/motd', 'ls; rm -rf /', 'cat x && reboot', 'docker rm -f web', 'find / -name x -delete', 'find . -exec rm {} \\;', 'git push', 'git branch -D main', 'tail -f /var/log/syslog', 'curl -X POST http://x', 'sed -i s/a/b/ f', 'echo $(whoami)', 'bash -c "ls"', '/bin/rm x', 'node app.js', 'crontab -r', 'docker stats', 'top', 'awk \'{system("rm x")}\'', 'ls `rm x`', 'X=1 ls', 'reboot', 'kill -9 1', 'mysql -e "drop database x"', 'ufw allow 22', 'nginx -s reload'];
  for (const c of ro) assert.ok(isReadOnly(c), 'should be read-only: ' + c);
  for (const c of rw) assert.ok(!isReadOnly(c), 'should need approval: ' + c);
});
test('version compare', () => {
  assert.equal(cmpVer('2.1.0', '2.0.9'), 1);
  assert.equal(cmpVer('2.0.0', '2.0.0'), 0);
  assert.equal(cmpVer('1.9', '2.0.0'), -1);
});
