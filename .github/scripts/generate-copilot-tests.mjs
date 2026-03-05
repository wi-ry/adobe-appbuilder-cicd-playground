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
    .filter((file) => {
      // Generate tests for:
      // - src/*/actions/... files
      // - src/*/utils.js files
      // - src/*/web-src/src/... files (components, utilities, entry points)
      // - But exclude test files, e2e, and node_modules
      const excluded = /\/(test|e2e|__tests__|node_modules)\//.test(file);
      const matched = /^src\/.+\/(actions\/.+|utils\.js|web-src\/src\/.+)\.js$/.test(file);
      return matched && !excluded;
    });

  return [...new Set(files)];
}

function stripCodeFences(text) {
  const fenced = text.match(/```(?:javascript|js)?\n([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  return text.trim();
}

function validateTestCode(testCode, filePath) {
  const forbiddenPatterns = [
    /window\.location\s*=\s*\{/g,  // Direct assignment to window.location object
    /global\.window\.location\s*=\s*\{/g,
    /window\.location\.\w+\s*=\s*[^=]/g,  // Direct assignment to window.location properties like hostname
    /global\.window\.location\.\w+\s*=\s*[^=]/g,
  ];

  const errors = [];

  for (const pattern of forbiddenPatterns) {
    const matches = testCode.match(pattern);
    if (matches) {
      errors.push(`Forbidden pattern found: ${pattern.source} (matches: ${matches.length})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Generated test for ${filePath} contains problematic code:\n${errors.join('\n')}\n\nPlease review the generated test and fix the mocking approach.`);
  }

  // Additional checks can be added here, e.g., ensure Jest spies are used properly
}

async function generateTestsForFile(filePath) {
  const source = readFileSync(filePath, 'utf8');

  const prompt = [
    'Generate comprehensive Jest unit tests for the JavaScript file below.',
    '',
    'Requirements:',
    '- Return ONLY runnable JavaScript test code.',
    '- Use CommonJS (require/module.exports style) for test files.',
    '- For requires: if the source uses "export default X", use require(...).default; if it uses "module.exports = X", use require(...) directly.',
    '- Detect the export style from the source code and require() accordingly.',
    '- Do NOT include explanations or comments outside test code.',
    '- Mock external dependencies (fetch, DOM methods, external modules) appropriately.',
    '- Test multiple scenarios: success paths, error cases, edge cases, boundary conditions.',
    '',
    'Testing Guidelines:',
    '- For async functions: test both success and rejection cases.',
    '- For functions that serialize data (JSON.stringify, etc): verify output format and types.',
    '- For functions that make HTTP requests: verify headers, body format, method, and URL.',
    '- For DOM functions: mock document and window methods; verify correct element selection and method calls.',
    '- For browser APIs like window.location in jsdom: Use Jest spies (e.g., jest.spyOn(window.location, \'hostname\', \'get\').mockReturnValue(\'value\')) instead of direct assignment to avoid navigation errors. Restore spies in afterEach.',
    '- For data transformation: test with null, undefined, empty values, and type mismatches.',
    '- Test error handling: verify that errors are thrown/caught appropriately.',
    '- Use explicit assertions: check exact values, not just truthiness.',
    '',
    'Example pattern for HTTP functions:',
    'test("should send properly formatted POST request", async () => {',
    '  const mockFetch = jest.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });',
    '  global.fetch = mockFetch;',
    '  const params = { key: "value", num: 42 };',
    '  await myFunction("https://example.com", {}, params);',
    '  // CRITICAL: body MUST be a string (JSON.stringify), never a raw object',
    '  expect(mockFetch).toHaveBeenCalledWith("https://example.com", expect.objectContaining({',
    '    method: "POST",',
    '    headers: expect.objectContaining({ "Content-Type": "application/json" }),',
    '    body: JSON.stringify(params)  // ← MUST serialize to string',
    '  }));',
    '  // WRONG: body: params would fail; Fetch API requires body as string/Blob/FormData',
    '});',
    '',
    'Example pattern for DOM functions:',
    'test("should mount component to correct element", () => {',
    '  document.body.innerHTML = "<div id=\\"root\\"></div>";',
    '  myRender(<App />, document.getElementById("root"));',
    '  expect(document.getElementById("root").innerHTML).toContain("expected content");',
    '});',
    '',
    'Example pattern for mocking window.location in jsdom:',
    'let hostnameSpy;',
    'beforeEach(() => {',
    '  hostnameSpy = jest.spyOn(window.location, \'hostname\', \'get\').mockReturnValue(\'localhost\');',
    '});',
    'afterEach(() => {',
    '  hostnameSpy.mockRestore();',
    '});',
    '',
    'Example pattern for error cases:',
    'test("should throw on invalid input", () => {',
    '  expect(() => myFunction(null)).toThrow();',
    '  expect(() => myFunction(undefined)).toThrow();',
    '});',
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
          content: 'You are GitHub Copilot. Produce high-quality Jest tests with thorough, deterministic assertions. Include edge cases, error handling, data validation, and format verification. Focus on catching bugs in serialization, API calls, DOM manipulation, and boundary conditions. When the source uses ES6 "export default", require it as require(path).default. When it uses CommonJS "module.exports", require it directly. For browser APIs like window.location in jsdom, always use Jest spies (e.g., jest.spyOn(window.location, \'hostname\', \'get\').mockReturnValue(\'value\')) and restore them in afterEach to avoid navigation errors.'
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

    // Validate the generated test code for best practices
    validateTestCode(testCode, filePath);

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
