import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outputDir = '.copilot-generated-tests';
const summaryPath = `${outputDir}/generation-summary.md`;
const model = process.env.COPILOT_MODEL || 'openai/gpt-4.1';
const apiUrl = process.env.COPILOT_API_URL || 'https://models.github.ai/inference/chat/completions';
const token = process.env.COPILOT_TOKEN || process.env.GITHUB_TOKEN;
const baseRef = process.env.PR_BASE_REF || 'main';

mkdirSync(outputDir, { recursive: true });

function run(command) {
  return execSync(command, { encoding: 'utf8' }).trim();
}

function listChangedFiles() {
  let diffOutput = '';

  try {
    diffOutput = run(`git diff --name-only --diff-filter=AMRT origin/${baseRef}...HEAD`);
  } catch {
    diffOutput = run('git diff --name-only --diff-filter=AMRT HEAD~1...HEAD');
  }

  const files = diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /\.js$/.test(file))
    .filter((file) => /^src\/.+\/(actions\/.+|utils)\.js$/.test(file));

  return [...new Set(files)];
}

function stripCodeFences(text) {
  const fenced = text.match(/```(?:javascript|js)?\n([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  return text.trim();
}

async function generateTestsForFile(filePath) {
  const source = readFileSync(filePath, 'utf8');

  const prompt = [
    'Generate Jest unit tests for the JavaScript file below.',
    'Constraints:',
    '- Return ONLY runnable JavaScript test code.',
    '- Use CommonJS (require/module.exports style).',
    '- Do not include explanations.',
    '- Mock external dependencies when needed.',
    '- Focus on meaningful behavior and edge cases.',
    '',
    `Source file path: ${filePath}`,
    '',
    source
  ].join('\n');

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are GitHub Copilot. Produce high-quality Jest tests with deterministic assertions.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Copilot API request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error(`Unexpected API response format for ${filePath}: ${JSON.stringify(data)}`);
  }

  return stripCodeFences(content);
}

function makeOutputName(filePath) {
  const relative = filePath.replace(/^src\//, '').replace(/\.js$/, '');
  const safe = relative.replace(/[\\/]/g, '__');
  return `${safe}.generated.test.js`;
}

async function main() {
  if (!token) {
    throw new Error('Missing COPILOT_TOKEN or GITHUB_TOKEN environment variable.');
  }

  const changedFiles = listChangedFiles();

  if (changedFiles.length === 0) {
    writeFileSync(summaryPath, '# Copilot test generation\n\nNo eligible changed JS files were detected.\n');
    console.log('No eligible files detected.');
    return;
  }

  const generated = [];

  for (const filePath of changedFiles) {
    let testCode = await generateTestsForFile(filePath);
    // patch any require/import paths that point to the source file so they
    // are correct relative to the output directory (which is a hidden folder).
    // Copilot may produce paths like '../../src/...' depending on its view of
    // the repo; we compute the proper relative path from the generated test
    // file location.
    const sourceAbs = path.resolve(filePath);
    const relFromOutput = path.relative(outputDir, sourceAbs).replace(/\\/g, '/');
    // ensure it starts with './' or '../'
    let relRequire = relFromOutput;
    if (!relRequire.startsWith('.')) {
      relRequire = './' + relRequire;
    }
    // replace occurrences of the original src path string with relRequire
    testCode = testCode.replace(/(['"])(\.\.?\/)*src\/[\w\-\/\.]+?\.js\1/g, (match) => {
      const quote = match[0];
      return quote + relRequire + quote;
    });

    const fileName = makeOutputName(filePath);
    const outputPath = path.join(outputDir, fileName);

    writeFileSync(outputPath, `${testCode}\n`);
    generated.push({ source: filePath, test: outputPath });
    console.log(`Generated ${outputPath}`);
  }

  const summaryLines = [
    '# Copilot test generation',
    '',
    `Model: ${model}`,
    '',
    'Generated tests:',
    ...generated.map((item) => `- ${item.source} -> ${item.test}`),
    ''
  ];

  writeFileSync(summaryPath, summaryLines.join('\n'));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
