import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicIp, assertSafeUrl, resolvePublic } from '../../server/lib/ssrf.js';

test('private, loopback, link-local and reserved addresses are not public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2001:db8::1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '151.101.1.140', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
});

test('URL checks reject unsafe schemes, credentials, ports and internal names', () => {
  const bad = ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'http://user:pw@example.com/', 'http://example.com:22/',
    'http://localhost/', 'http://foo.localhost/', 'http://metadata.google.internal/', 'http://printer.local/', 'http://intranet/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://169.254.169.254/', 'not a url'];
  for (const u of bad) assert.throws(() => assertSafeUrl(u), undefined, u);
  for (const u of ['https://example.com/', 'http://example.com:8080/x', 'https://www.site.co.uk/path?q=1']) assert.doesNotThrow(() => assertSafeUrl(u), u);
});

test('DNS resolution that yields a private address is rejected (rebinding protection)', async () => {
  // "localtest.me"-style names resolve to 127.0.0.1; lookup itself may fail
  // offline, which must also reject.
  await assert.rejects(resolvePublic('localhost'));
});
