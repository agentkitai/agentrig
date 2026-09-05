import { readEvaluationReport, formatEvaluationReport } from '../packages/cli/dist/evaluation.js';

try {
  if (process.argv.length < 3 || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--text')) {
    throw new Error('usage: node eval/report.mjs BUNDLE_MANIFEST [--text]');
  }
  const report = await readEvaluationReport(process.argv[2]);
  console.log(process.argv[3] === '--text' ? formatEvaluationReport(report) : JSON.stringify(report, null, 2));
  process.exitCode = report.outcome === 'PASS' || report.outcome === 'SKIP' ? 0 : report.outcome === 'FAIL' ? 1 : 2;
} catch (error) {
  console.log(JSON.stringify({ outcome: 'BLOCKED', reason: error.message })); process.exitCode = 2;
}
