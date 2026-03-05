import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const outputDir = '.copilot-generated-tests';
const marker = '<!-- copilot-generated-tests-comment -->';
const summaryPath = `${outputDir}/generation-summary.md`;
const jestJsonPath = `${outputDir}/jest-results.json`;
const commentPath = `${outputDir}/pr-comment.md`;

function countGeneratedTests() {
  if (!existsSync(outputDir)) return 0;

  return readdirSync(outputDir).filter((name) => name.endsWith('.generated.test.js')).length;
}

function loadGenerationSummary() {
  if (!existsSync(summaryPath)) return 'No generation summary available.';
  return readFileSync(summaryPath, 'utf8').trim();
}

function loadJestSummary() {
  if (!existsSync(jestJsonPath)) {
    return {
      statusLine: 'Jest did not produce a JSON report.',
      details: []
    };
  }

  try {
    const data = JSON.parse(readFileSync(jestJsonPath, 'utf8'));
    const passed = data.numPassedTests ?? 0;
    const failed = data.numFailedTests ?? 0;
    const total = data.numTotalTests ?? 0;
    const suitesFailed = data.numFailedTestSuites ?? 0;

    const statusLine = suitesFailed > 0 || failed > 0
      ? `❌ Tests failed (${passed}/${total} passed, ${failed} failed)`
      : `✅ Tests passed (${passed}/${total})`;

    const failingSuites = (data.testResults || [])
      .filter((suite) => suite.status === 'failed')
      .map((suite) => `- ${suite.name}`)
      .slice(0, 10);

    return {
      statusLine,
      details: failingSuites.length ? ['Failing suites:', ...failingSuites] : []
    };
  } catch {
    return {
      statusLine: 'Unable to parse Jest JSON report.',
      details: []
    };
  }
}

function main() {
  const generatedCount = countGeneratedTests();
  const generationSummary = loadGenerationSummary();
  const jestSummary = loadJestSummary();

  const body = [
    marker,
    '## Copilot-generated unit tests',
    '',
    `Generated test files: ${generatedCount}`,
    jestSummary.statusLine,
    '',
    '<details>',
    '<summary>Generation details</summary>',
    '',
    generationSummary,
    '',
    '</details>',
    '',
    ...(jestSummary.details.length ? jestSummary.details : []),
    '',
    '_Artifacts: `copilot-generated-tests` contains generated tests and `jest-results.json`._'
  ].join('\n');

  writeFileSync(commentPath, `${body.trim()}\n`);
  console.log(`Wrote ${commentPath}`);
}

main();
