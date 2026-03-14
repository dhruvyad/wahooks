import { WAHooks } from './src';

const API_KEY = process.env.WAHOOKS_API_KEY;
if (!API_KEY) {
  console.error('Set WAHOOKS_API_KEY environment variable');
  process.exit(1);
}
const client = new WAHooks({ apiKey: API_KEY });

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function run() {
  console.log('TypeScript SDK E2E Tests\n');

  let connectionId = '';
  let webhookId = '';
  let tokenId = '';

  // --- Connections ---
  await test('listConnections returns array', async () => {
    const connections = await client.listConnections();
    assert(Array.isArray(connections), 'expected array');
  });

  await test('createConnection returns connection with id', async () => {
    const conn = await client.createConnection();
    assert(typeof conn.id === 'string', 'expected id string');
    assert(conn.status === 'pending' || conn.status === 'scan_qr', `unexpected status: ${conn.status}`);
    connectionId = conn.id;
  });

  await test('getConnection returns same connection', async () => {
    const conn = await client.getConnection(connectionId);
    assert(conn.id === connectionId, 'id mismatch');
  });

  await test('listConnections includes new connection', async () => {
    const connections = await client.listConnections();
    assert(connections.some(c => c.id === connectionId), 'connection not found in list');
  });

  // --- Webhooks ---
  await test('createWebhook returns webhook with signing secret', async () => {
    const wh = await client.createWebhook(connectionId, 'https://httpbin.org/post', ['message', 'message.any']);
    assert(typeof wh.id === 'string', 'expected id');
    assert(typeof wh.signingSecret === 'string', 'expected signingSecret');
    assert(wh.url === 'https://httpbin.org/post', 'url mismatch');
    assert(Array.isArray(wh.events), 'expected events array');
    webhookId = wh.id;
  });

  await test('listWebhooks returns array with webhook', async () => {
    const webhooks = await client.listWebhooks(connectionId);
    assert(Array.isArray(webhooks), 'expected array');
    assert(webhooks.some(w => w.id === webhookId), 'webhook not found');
  });

  await test('updateWebhook changes url', async () => {
    const updated = await client.updateWebhook(webhookId, { url: 'https://httpbin.org/anything' });
    assert(updated.url === 'https://httpbin.org/anything', 'url not updated');
  });

  await test('testWebhook enqueues delivery', async () => {
    const result = await client.testWebhook(webhookId);
    assert(result.success === true, 'expected success');
    assert(typeof result.logId === 'string', 'expected logId');
  });

  await test('getWebhookLogs returns logs', async () => {
    // Wait briefly for delivery
    await new Promise(r => setTimeout(r, 2000));
    const logs = await client.getWebhookLogs(webhookId);
    assert(Array.isArray(logs), 'expected array');
    assert(logs.length > 0, 'expected at least one log');
    assert(logs[0].eventType === 'test', 'expected test event');
  });

  await test('deleteWebhook succeeds', async () => {
    const result = await client.deleteWebhook(webhookId);
    assert(result.success === true, 'expected success');
  });

  await test('listWebhooks is empty after delete', async () => {
    const webhooks = await client.listWebhooks(connectionId);
    assert(!webhooks.some(w => w.id === webhookId), 'webhook should be gone');
  });

  // --- Tokens ---
  await test('createToken returns raw token', async () => {
    const token = await client.createToken('test-sdk-token');
    assert(typeof token.token === 'string', 'expected token string');
    assert(token.token.startsWith('wh_'), 'expected wh_ prefix');
    assert(token.name === 'test-sdk-token', 'name mismatch');
    tokenId = token.id;
  });

  await test('listTokens includes new token', async () => {
    const tokens = await client.listTokens();
    assert(Array.isArray(tokens), 'expected array');
    assert(tokens.some(t => t.id === tokenId), 'token not found');
  });

  await test('revokeToken succeeds', async () => {
    const result = await client.revokeToken(tokenId);
    assert(result.success === true, 'expected success');
  });

  await test('listTokens excludes revoked token', async () => {
    const tokens = await client.listTokens();
    assert(!tokens.some(t => t.id === tokenId), 'revoked token should be gone');
  });

  // --- Error handling ---
  await test('getConnection with bad id throws 404', async () => {
    try {
      await client.getConnection('00000000-0000-0000-0000-000000000000');
      throw new Error('should have thrown');
    } catch (e: any) {
      assert(e.statusCode === 404, `expected 404, got ${e.statusCode}`);
    }
  });

  await test('invalid API key throws 401', async () => {
    const badClient = new WAHooks({ apiKey: 'wh_invalid' });
    try {
      await badClient.listConnections();
      throw new Error('should have thrown');
    } catch (e: any) {
      assert(e.statusCode === 401, `expected 401, got ${e.statusCode}`);
    }
  });

  // --- Cleanup ---
  await test('deleteConnection succeeds', async () => {
    const result = await client.deleteConnection(connectionId);
    assert(typeof result === 'object', 'expected object');
  });

  await test('listConnections excludes deleted connection', async () => {
    const connections = await client.listConnections();
    assert(!connections.some(c => c.id === connectionId), 'deleted connection should be gone');
  });

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
