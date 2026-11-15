import assert from 'node:assert/strict';

const [base = 'http://127.0.0.1:3102', ...paths] = process.argv.slice(2);
assert.ok(paths.length, 'Provide the public paths to verify.');
const agents = ['Mozilla/5.0', 'Googlebot', 'Google-InspectionTool/1.0'];

for (const path of paths) {
  assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Use same-origin public paths.');
  const expected = new URL(path, 'https://news.wildteam.org.uk').href;
  for (const agent of agents) {
    const response = await fetch(new URL(path, base), { headers: { 'user-agent': agent } });
    assert.equal(response.status, 200, `${path}: GET status`);
    const body = await response.text();
    const head = body.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
    assert.ok(head, `${path}: document head`);
    const canonicals = body.match(/<link\b[^>]*\brel="canonical"[^>]*>/gi) ?? [];
    assert.equal(canonicals.length, 1, `${path}: exactly one canonical`);
    assert.ok(head.includes(canonicals[0]), `${path}: canonical is inside head`);
    const canonical = canonicals[0].match(/\bhref="([^"]+)"/)?.[1];
    assert.ok(canonical, `${path}: canonical href`);
    assert.equal(new URL(canonical).href, expected, `${path}: canonical destination`);
    assert.match(head, /<meta\b[^>]*name="robots"[^>]*content="index, follow"/, `${path}: public indexing metadata`);
    assert.doesNotMatch(response.headers.get('x-robots-tag') ?? '', /noindex/i, `${path}: no blocking response header`);
    const headers = await fetch(new URL(path, base), { method: 'HEAD', headers: { 'user-agent': agent } });
    assert.equal(headers.status, 200, `${path}: HEAD status`);
    assert.equal(await headers.text(), '', `${path}: HEAD has no body`);
    console.log(`PASS ${path} (${agent}; GET/HEAD; canonical in head)`);
  }
}
