import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import './style.css';

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };
const $ = (id) => document.getElementById(id);
const LIMIT = 512 * 1024;
const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const examples = {
  closures: `-- A small stateful module. A lot worth protecting.\nlocal function makeCounter(start)\n    local value = start\n\n    return function(step)\n        value = value + (step or 1)\n        return value\n    end\nend\n\nlocal counter = makeCounter(10)\nlocal results = {}\n\nfor i = 1, 4 do\n    results[i] = counter(i)\nend\n\nprint("Counter:", table.concat(results, ", "))\nreturn results`,
  tables: `-- Methods and metatables, with ordinary Lua semantics.\nlocal Vector = {}\nVector.__index = Vector\n\nfunction Vector.new(x, y)\n    return setmetatable({ x = x, y = y }, Vector)\nend\n\nfunction Vector:lengthSquared()\n    return self.x * self.x + self.y * self.y\nend\n\nlocal point = Vector.new(3, 4)\nprint("Length squared:", point:lengthSquared())\nreturn point:lengthSquared()`,
  varargs: `-- Keep nil positions in multiple return values.\nlocal function collect(...)\n    local count = select("#", ...)\n    local values = { ... }\n    return count, values\nend\n\nlocal function relay(...)\n    return collect(...)\nend\n\nlocal count, values = relay("first", nil, "third")\nprint("Arguments:", count)\nprint(values[1], values[2], values[3])\nreturn count, values`,
};
const defaults = {
  standard: { rename: true, stringProtection: true, constantProtection: true, controlFlow: false, opaquePredicates: false, lazyStrings: true },
  advanced: { rename: true, stringProtection: true, constantProtection: true, controlFlow: true, opaquePredicates: true, lazyStrings: true },
  maximum: { rename: true, stringProtection: true, constantProtection: true, controlFlow: true, opaquePredicates: true, lazyStrings: true },
};
const descriptions = { standard: 'Scope-aware source changes and protected literals.', advanced: 'Source protection with randomized control-flow transformations.', maximum: 'The full stack, including a randomized virtual machine.' };
let profile = 'maximum';
let currentOutput = '';
let busy = false;
let capabilities = null;
let toastTimer;

monaco.editor.defineTheme('veil', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: '', foreground: 'B7C2B1' },
    { token: 'comment', foreground: '748568', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'B3CF9E' },
    { token: 'string', foreground: 'BDCD8E' },
    { token: 'number', foreground: 'C9AC83' },
    { token: 'delimiter', foreground: '7E9271' },
    { token: 'operator', foreground: '90A67E' },
    { token: 'identifier', foreground: 'B7C2B1' },
  ],
  colors: {
    'editor.background': '#111512', 'editor.foreground': '#B7C2B1',
    'editorLineNumber.foreground': '#3E4C38', 'editorLineNumber.activeForeground': '#8EAA78',
    'editor.lineHighlightBackground': '#182015', 'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#C0F775', 'editor.selectionBackground': '#3B512D88',
    'editor.inactiveSelectionBackground': '#26382066', 'editorGutter.background': '#111512',
    'editorIndentGuide.background1': '#22301C', 'editorIndentGuide.activeBackground1': '#415732',
    'scrollbarSlider.background': '#62735222', 'scrollbarSlider.hoverBackground': '#62735244',
    'scrollbarSlider.activeBackground': '#62735266', 'editorWidget.background': '#1A2415',
    'editorWidget.border': '#435435', 'editorError.foreground': '#E99682',
  },
});
const editorOptions = {
  language: 'lua', theme: 'veil', fontFamily: "Consolas, 'Courier New', monospace",
  fontSize: 11, lineHeight: 21, fontWeight: '400', minimap: { enabled: false },
  scrollBeyondLastLine: false, automaticLayout: true, tabSize: 4,
  padding: { top: 18, bottom: 18 }, lineNumbersMinChars: 3, lineDecorationsWidth: 12,
  folding: true, showFoldingControls: 'mouseover', glyphMargin: false,
  renderLineHighlight: 'none', overviewRulerLanes: 0, overviewRulerBorder: false,
  scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5, useShadows: false },
  contextmenu: true, smoothScrolling: false, fixedOverflowWidgets: true,
  bracketPairColorization: { enabled: false }, guides: { indentation: false },
  wordWrap: 'off', renderValidationDecorations: 'on', ariaLabel: 'Lua source code editor',
};
const source = monaco.editor.create($('source-editor'), { ...editorOptions, value: examples.closures });
const output = monaco.editor.create($('output-editor'), { ...editorOptions, value: '', readOnly: true, domReadOnly: true, folding: false, ariaLabel: 'Read-only protected Lua output' });

function bytes(value) { return new TextEncoder().encode(value).byteLength; }
function formatSize(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10240 ? 2 : 1)} KiB`; }
function setStatus(message, kind = '') {
  $('status').className = `status ${kind}`;
  $('status-text').textContent = message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}
function clearError() {
  $('error-box').hidden = true;
  monaco.editor.setModelMarkers(source.getModel(), 'compiler', []);
}
function showError(code, message, location = {}) {
  $('error-title').textContent = code ? code.replaceAll('_', ' ') : 'Build could not complete';
  const position = location.line ? `Line ${location.line}${location.column ? `, column ${location.column}` : ''}. ` : '';
  $('error-message').textContent = `${position}${message}`;
  $('error-box').hidden = false;
  setStatus('Build stopped. Review the error above.', 'error');
  if (location.line) {
    const line = Math.max(1, Math.min(source.getModel().getLineCount(), location.line));
    const column = Math.max(1, location.column || 1);
    monaco.editor.setModelMarkers(source.getModel(), 'compiler', [{
      startLineNumber: line, startColumn: column, endLineNumber: line,
      endColumn: Math.max(column + 1, source.getModel().getLineMaxColumn(line)),
      message, severity: monaco.MarkerSeverity.Error,
    }]);
    source.revealLineInCenter(line);
  }
}
function invalidateOutput() {
  $('input-size').textContent = formatSize(bytes(source.getValue()));
  if (currentOutput) {
    $('output-tag').textContent = 'SOURCE CHANGED';
    $('output-tag').className = 'output-tag stale';
    $('output-state').textContent = 'Build needs refresh';
    $('output-dot').className = 'language-dot muted';
    $('copy-output').disabled = true;
    $('download-output').disabled = true;
    $('build-report').hidden = true;
  }
  if (!busy) setStatus(currentOutput ? 'Source changed. Compile a fresh build.' : 'Ready when you are.');
}
source.onDidChangeModelContent(() => { clearError(); invalidateOutput(); });
source.onDidChangeCursorPosition(({ position }) => { $('source-position').textContent = `Ln ${position.lineNumber}, Col ${position.column}`; });

function applyProfile(next, reset = true) {
  profile = next;
  document.querySelectorAll('[data-profile]').forEach((button) => {
    const selected = button.dataset.profile === next;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.setting input').forEach((input) => {
    const advancedOption = ['controlFlow', 'opaquePredicates'].includes(input.name);
    const required = next === 'maximum' && ['rename', 'stringProtection', 'constantProtection', 'controlFlow'].includes(input.name);
    input.disabled = required || advancedOption && next === 'standard';
    input.closest('.setting').classList.toggle('required', required);
    input.title = required ? 'Required for Maximum VM protection' : '';
    const description = input.closest('.setting').querySelector('small');
    description.dataset.defaultText ||= description.textContent;
    description.textContent = required ? 'Required for VM compilation' : description.dataset.defaultText;
    if (reset) input.checked = defaults[next][input.name];
  });
  syncStringOptions();
  $('profile-description').textContent = descriptions[next];
  $('vm-note').textContent = next === 'maximum' ? 'Maximum includes custom VM virtualization. Runtime introspection is unsupported.' : 'Source transformations preserve lexical scopes. Select Maximum to add the custom VM.';
  invalidateOutput();
}
function syncStringOptions() {
  const enabled = document.querySelector('input[name="stringProtection"]').checked;
  document.querySelector('input[name="lazyStrings"]').disabled = !enabled;
}
function getOptions() {
  return Object.fromEntries([...document.querySelectorAll('.setting input')].map((input) => [input.name, input.checked && !(input.name === 'lazyStrings' && input.disabled)]));
}
document.querySelectorAll('[data-profile]').forEach((button) => {
  button.addEventListener('click', () => applyProfile(button.dataset.profile));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const profiles = ['standard', 'advanced', 'maximum'];
    const index = profiles.indexOf(profile);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    applyProfile(profiles[next]);
    document.querySelector(`[data-profile="${profiles[next]}"]`).focus();
  });
});
document.querySelectorAll('.setting input').forEach((input) => input.addEventListener('change', () => { syncStringOptions(); invalidateOutput(); }));
$('reset-settings').addEventListener('click', () => { applyProfile(profile); toast('Protection defaults restored.'); });
$('dialect').addEventListener('change', () => {
  $('source-language').textContent = $('dialect').selectedOptions[0].textContent.split(' ·')[0];
  $('compatibility-copy').textContent = $('dialect').value === 'lua51' ? 'Lua 5.1 syntax is the baseline. Other runtimes use the shared subset. Unsupported syntax is reported before generation.' : 'This target supports the Lua 5.1-compatible subset. Runtime-specific syntax is rejected with a source error.';
  clearError(); invalidateOutput();
});
$('example').addEventListener('change', () => {
  if (!examples[$('example').value]) return;
  source.setValue(examples[$('example').value]);
  $('source-filename').textContent = `${$('example').value}.lua`;
  source.setPosition({ lineNumber: 1, column: 1 });
  $('example').value = '';
});

async function loadFile(file) {
  if (!file) return;
  if (!/\.(lua|txt)$/i.test(file.name)) { showError('UNSUPPORTED FILE', 'Choose a .lua or .txt file encoded as UTF-8.'); return; }
  if (file.size > LIMIT) { showError('SOURCE TOO LARGE', `This file is ${formatSize(file.size)}. The source limit is 512 KiB.`); return; }
  try {
    const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (contents.includes('\0')) throw new Error('This file contains binary content. Choose a UTF-8 Lua source file.');
    source.setValue(contents.replace(/^\uFEFF/, ''));
    $('source-filename').textContent = file.name;
    source.setPosition({ lineNumber: 1, column: 1 });
    clearError(); setStatus(`Loaded ${file.name}. Ready to compile.`);
  } catch (error) { showError('FILE READ FAILED', error.message || 'The file could not be read.'); }
}
$('upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => { loadFile(event.target.files[0]); event.target.value = ''; });
let dragDepth = 0;
const dropZone = $('drop-zone');
dropZone.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault(); dragDepth += 1; dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
dropZone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; dropZone.classList.remove('dragging');
  if (event.dataTransfer.files.length > 1) { showError('ONE FILE AT A TIME', 'Drop one Lua or text file to replace the source editor.'); return; }
  loadFile(event.dataTransfer.files[0]);
});
window.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });

function renderReport(result) {
  $('build-report').hidden = false;
  $('build-id').textContent = result.buildId || 'Build complete';
  $('applied-passes').replaceChildren();
  for (const pass of result.passes || []) {
    const chip = document.createElement('span');
    chip.className = 'pass-chip';
    chip.textContent = typeof pass === 'string' ? pass : pass.name || pass.id || 'Transformation';
    $('applied-passes').append(chip);
  }
  $('build-warnings').replaceChildren();
  const warnings = result.warnings || [];
  $('build-warnings').hidden = warnings.length === 0;
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = typeof warning === 'string' ? warning : warning.message;
    $('build-warnings').append(item);
  }
}
async function compile() {
  if (busy) return;
  clearError();
  const text = source.getValue();
  if (!text.trim()) { showError('EMPTY SOURCE', 'Add Lua source to the editor or load one of the examples.'); source.focus(); return; }
  if (bytes(text) > LIMIT) { showError('SOURCE TOO LARGE', `Your source is ${formatSize(bytes(text))}. The limit is 512 KiB.`); return; }
  busy = true;
  $('obfuscate').disabled = true;
  $('obfuscate-label').textContent = 'Compiling…';
  $('copy-output').disabled = true;
  $('download-output').disabled = true;
  $('output-tag').textContent = 'COMPILING';
  $('output-tag').className = 'output-tag';
  $('build-report').hidden = true;
  setStatus('Parsing, transforming, and validating…', 'loading');
  const options = getOptions();
  const requestProfile = profile;
  const requestDialect = $('dialect').value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${apiBase}/api/obfuscate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: text, profile: requestProfile, dialect: requestDialect, options }), signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
      const error = data?.error;
      showError(error?.code || `HTTP ${response.status}`, error?.message || 'The compiler service could not complete this request. Try again shortly.', error || {});
      $('output-tag').textContent = 'BUILD FAILED';
      $('output-tag').className = 'output-tag stale';
      return;
    }
    if (!data || typeof data.code !== 'string' || data.code.length === 0 || data.compatibility?.syntaxValidated !== true || !Array.isArray(data.passes) || data.passes.length === 0 || data.profile !== requestProfile || data.dialect !== requestDialect) throw new Error('The compiler returned an incomplete or mismatched build. No output was accepted.');
    currentOutput = data.code;
    output.setValue(currentOutput);
    output.setScrollTop(0);
    $('output-empty').hidden = true;
    const duration = Number(data.stats?.durationMs);
    $('output-size').textContent = formatSize(data.stats?.outputBytes ?? bytes(currentOutput));
    $('build-duration').textContent = Number.isFinite(duration) ? `${duration.toFixed(duration < 100 ? 1 : 0)} ms` : '— ms';
    $('output-state').textContent = 'Syntax validated';
    $('output-dot').className = 'language-dot';
    $('output-tag').textContent = 'BUILD COMPLETE';
    $('output-tag').className = 'output-tag success';
    $('copy-output').disabled = false;
    $('download-output').disabled = false;
    renderReport(data);
    if (source.getValue() !== text || profile !== requestProfile || $('dialect').value !== requestDialect || JSON.stringify(options) !== JSON.stringify(getOptions())) {
      invalidateOutput();
      setStatus('Build complete. Inputs changed; compile again.');
    } else setStatus(`Build complete. ${data.passes?.length || 0} protection passes applied.`, 'success');
  } catch (error) {
    const message = error.name === 'AbortError' ? 'The compiler request timed out. Try a smaller source file or try again.' : error instanceof TypeError ? 'Cannot reach the compiler service. Check your connection and the configured API endpoint, then retry.' : error.message;
    showError('COMPILER UNAVAILABLE', message);
    $('output-tag').textContent = 'BUILD FAILED';
    $('output-tag').className = 'output-tag stale';
  } finally {
    clearTimeout(timeout); busy = false;
    $('obfuscate').disabled = false;
    $('obfuscate-label').textContent = 'Obfuscate code';
  }
}
$('obfuscate').addEventListener('click', compile);
source.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, compile);
window.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); compile(); } });
$('dismiss-error').addEventListener('click', clearError);
$('copy-output').addEventListener('click', async () => {
  if (!currentOutput || $('copy-output').disabled) return;
  try { await navigator.clipboard.writeText(currentOutput); toast('Protected output copied.'); }
  catch { output.focus(); output.setSelection(output.getModel().getFullModelRange()); toast('Select and copy the output with Ctrl+C or ⌘C.'); }
});
$('download-output').addEventListener('click', () => {
  if (!currentOutput || $('download-output').disabled) return;
  const url = URL.createObjectURL(new Blob([currentOutput], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${$('source-filename').textContent.replace(/\.(lua|txt)$/i, '') || 'script'}.protected.lua`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Protected script downloaded.');
});

document.querySelectorAll('[data-dialog]').forEach((button) => button.addEventListener('click', () => $(button.dataset.dialog).showModal()));
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
document.querySelectorAll('[data-switch-dialog]').forEach((button) => button.addEventListener('click', () => { button.closest('dialog').close(); $(button.dataset.switchDialog).showModal(); }));
$('source-editor').addEventListener('focus', () => source.focus());

async function checkService() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${apiBase}/api/capabilities`, { signal: controller.signal });
    if (!response.ok) throw new Error('Service unavailable');
    capabilities = await response.json();
    if (capabilities.version) document.querySelector('.version-tag').textContent = `v${capabilities.version}`;
    $('service-state').textContent = 'Compiler connected';
  } catch { $('service-state').textContent = 'Compiler not connected'; }
  finally { clearTimeout(timeout); }
}
if (navigator.platform?.toLowerCase().includes('mac')) document.querySelector('.keyboard-hint').innerHTML = '<kbd>⌘</kbd> <kbd>↵</kbd> to compile';
applyProfile('maximum');
checkService();
