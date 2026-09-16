import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp, normalizeQuery } from '../src/worker.js';

test('normalizes IPs, domains, and URLs', () => {
  assert.deepEqual(normalizeQuery('8.8.8.8'), { type: 'ip', value: '8.8.8.8' });
  assert.deepEqual(normalizeQuery('https://Example.COM/path?q=1'), { type: 'domain', value: 'example.com' });
  assert.equal(normalizeQuery('not a domain'), null);
});

test('rejects private and documentation addresses from GeoIP lookups', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '192.0.2.1', '2001:db8::1', 'fc00::1', 'fe80::1', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
});
