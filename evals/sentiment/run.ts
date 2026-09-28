import { readFile, writeFile } from 'node:fs/promises'
import { evaluateSentimentCorpus } from '../../packages/integration-typesafe/src/evaluation.js'
import type { SentimentEvaluationExample, SentimentEvaluationOptions } from '../../packages/integration-typesafe/src/evaluation.js'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) throw new Error('Usage: pnpm exec tsx evals/sentiment/run.ts <corpus.json> <report.json>')
const input = JSON.parse(await readFile(inputPath, 'utf8')) as { manifest: SentimentEvaluationOptions; examples: SentimentEvaluationExample[] }
if (!Array.isArray(input.examples) || !Array.isArray(input.manifest?.developmentGroups)) throw new Error('Expected a manifest and examples array.')
const report = evaluateSentimentCorpus(input.examples, input.manifest)
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(`Evaluated ${input.examples.length} supplied examples. Public release gate: ${report.releaseEligible ? 'passed' : 'not passed'}.\n`)
