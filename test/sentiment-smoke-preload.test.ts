import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const preload = pathToFileURL(path.resolve('scripts/sentiment-smoke-preload.mjs')).href
function run(code: string) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { installSentimentSmokeGuard } from ${JSON.stringify(preload)};
    const payload = { model: 'jev-1.13.0', state: { subject: 'synthetic' }, questions: { identity: { type: 'choice', criteria: { correct: 'Correct', wrong: 'Wrong' } } } };
    const request = () => fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: 'Bearer synthetic-smoke-secret' }, body: JSON.stringify(payload) });
    const valid = { model: 'jev-1.13.0', answers: { identity: { type: 'choice', choice: 'correct', probabilities: { correct: 1, wrong: 0 }, confidence: 1 } }, usage: { input_tokens: 20, output_tokens: 0 } };
    ${code}
  `], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim()) as Record<string, unknown>
}

describe('installed sentiment smoke provider guard', () => {
  it('preserves HTTP request serialization and redacts receipt contents', () => {
    const result = run(`
      let observed;
      const guard = installSentimentSmokeGuard({ providerUrl: 'http://127.0.0.1:9999/stub', transport: async request => { observed = { url: request.url, method: request.method, body: JSON.parse(await request.text()), keyPresent: request.headers.has('authorization') }; return Response.json(valid); } });
      await request(); console.log(JSON.stringify({ observed, receipt: guard.snapshot() }));
    `)
    expect(result.observed).toMatchObject({ url: 'http://127.0.0.1:9999/stub', method: 'POST', keyPresent: true, body: { model: 'jev-1.13.0' } })
    expect(result.receipt).toMatchObject({ attempts: 1, assessments: 1, reportedInputTokens: 20, unknownUsageAttempts: 0, stopped: false })
    expect(JSON.stringify(result.receipt)).not.toContain('synthetic-smoke-secret')
  })
  it('counts retries against one finite request budget', () => {
    expect(run(`
      const guard = installSentimentSmokeGuard({ live: true, maxAttempts: 2, transport: async () => Response.json(valid) });
      await request(); await request(); let blocked = false; try { await request(); } catch { blocked = true; }
      console.log(JSON.stringify({ blocked, ...guard.snapshot() }));
    `)).toMatchObject({ blocked: true, attempts: 2, assessments: 1 })
  })
  it('refuses token overflow before sending and blocks unrelated egress', () => {
    expect(run(`
      let calls = 0; const guard = installSentimentSmokeGuard({ live: true, maxInputTokens: 1, transport: async () => { calls++; return Response.json(valid); } });
      let blocked = 0; for (const operation of [request, () => fetch('https://unrelated.example')]) { try { await operation(); } catch { blocked++; } }
      console.log(JSON.stringify({ calls, blocked, ...guard.snapshot() }));
    `)).toMatchObject({ calls: 0, blocked: 2, attempts: 0 })
  })
  it('refuses redirects before a loopback request can leave the allowlist', () => {
    expect(run(`
      const { createServer } = await import('node:http');
      let redirected = 0;
      const target = createServer((_request, response) => { redirected++; response.end('unexpected redirect'); });
      await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
      const server = createServer((_request, response) => { response.writeHead(302, { location: 'http://127.0.0.1:' + target.address().port }); response.end(); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const guard = installSentimentSmokeGuard({ live: true });
      let blocked = false; try { await fetch('http://127.0.0.1:' + server.address().port); } catch { blocked = true; }
      guard.restore();
      await Promise.all([server, target].map(instance => new Promise(resolve => instance.close(resolve))));
      console.log(JSON.stringify({ blocked, redirected }));
    `)).toEqual({ blocked: true, redirected: 0 })
  })
  it.each([
    { probabilities: { correct: 0.2, wrong: 0.2 } },
    { confidence: -0.1 },
    { confidence: 1.1 },
    { confidence: 'high' },
  ])('stops on invalid distribution or confidence %j', invalid => {
    expect(run(`
      const guard = installSentimentSmokeGuard({ live: true, transport: async () => Response.json({ ...valid, answers: { identity: { ...valid.answers.identity, ...${JSON.stringify(invalid)} } } }) });
      await request(); let blocked = false; try { await request(); } catch { blocked = true; }
      console.log(JSON.stringify({ blocked, ...guard.snapshot() }));
    `)).toMatchObject({ blocked: true, attempts: 1, stopped: true })
  })
  it('stops after a malformed successful response before the next assessment', () => {
    expect(run(`
      const guard = installSentimentSmokeGuard({ live: true, transport: async () => Response.json({ ...valid, answers: { identity: { type: 'choice', choice: 'invented' } } }) });
      await request(); let blocked = false; try { await request(); } catch { blocked = true; }
      console.log(JSON.stringify({ blocked, ...guard.snapshot() }));
    `)).toMatchObject({ blocked: true, attempts: 1, stopped: true })
  })
})
