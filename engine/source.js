/*
 * Source backend: every change is attached to a parsed AST node. Bindings are
 * resolved in lexical order; untouched syntax is copied from its original range.
 * The control-flow backend lowers eligible regions into an actual CFG and emits
 * randomized states. Regions whose locals or breaks cannot move safely retain
 * their lexical blocks, and are counted rather than silently advertised.
 */

const KEYWORDS = new Set(('and break do else elseif end false for function goto if in local nil not or repeat return then true until while').split(' '));

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'comments', 'globals'].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, fn);
    else if (value && typeof value === 'object') walk(value, fn);
  }
}

class Scope {
  constructor(parent) { this.parent = parent; this.bindings = new Map(); }
  find(name) { return this.bindings.get(name) || this.parent?.find(name); }
}

// Lua's compiler caps simultaneously active locals at 200. Hidden for-loop
// variables consume slots too. Count them before introducing helper/state locals.
function localUsage(ast, dialect) {
  const functions = [], root = { max: 0 }, topVararg = { value: false };
  functions.push(root);
  const expression = (node, info, active) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VarargLiteral' && info === root) topVararg.value = true;
    if (node.type === 'FunctionDeclaration') {
      const count = node.parameters.filter(p => p.type === 'Identifier').length + (node.identifier?.indexer === ':' ? 1 : 0);
      const child = { max: count }; functions.push(child); block(node.body, child, count); return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'comments', 'globals'].includes(key)) continue;
      if (Array.isArray(value)) { for (const child of value) if (child?.type) expression(child, info, active); }
      else if (value?.type) expression(value, info, active);
    }
  };
  const block = (body, info, inherited) => {
    let active = inherited;
    for (const node of body) {
      switch (node.type) {
        case 'LocalStatement':
          for (const init of node.init) expression(init, info, active);
          active += node.variables.length; break;
        case 'FunctionDeclaration':
          if (node.isLocal) active++;
          expression(node, info, active); break;
        case 'IfStatement':
          for (const clause of node.clauses) { expression(clause.condition, info, active); block(clause.body, info, active); }
          break;
        case 'RepeatStatement': {
          const end = block(node.body, info, active); expression(node.condition, info, end); break;
        }
        case 'WhileStatement': expression(node.condition, info, active); block(node.body, info, active); break;
        case 'DoStatement': block(node.body, info, active); break;
        case 'ForNumericStatement':
          expression(node.start, info, active); expression(node.end, info, active); expression(node.step, info, active);
          info.max = Math.max(info.max, active + 4); block(node.body, info, active + 4); break;
        case 'ForGenericStatement':
          for (const iterator of node.iterators) expression(iterator, info, active);
          // Lua 5.4 additionally reserves a to-be-closed iterator slot.
          const hidden = dialect === 'lua54' ? 4 : 3;
          info.max = Math.max(info.max, active + hidden + node.variables.length);
          block(node.body, info, active + hidden + node.variables.length); break;
        default: expression(node, info, active);
      }
      info.max = Math.max(info.max, active);
    }
    return active;
  };
  block(ast.body, root, 0);
  let maximumDepth = 1;
  const depth = (node, current = 0) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') {
      for (const child of node.body) depth(child, 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'comments', 'globals'].includes(key)) continue;
      if (Array.isArray(value)) {
        const next = current + Number(key === 'body'); maximumDepth = Math.max(maximumDepth, next);
        for (const child of value) if (child?.type) depth(child, next);
      } else if (value?.type) depth(value, current);
    }
  };
  depth(ast);
  return { root: root.max, maximum: Math.max(...functions.map(info => info.max)), depth: maximumDepth, topVararg: topVararg.value };
}

// Changes are nonoverlapping. Replacing a whole CFG region consumes its already
// transformed descendants, so renaming/literal passes survive flattening.
class Edits {
  constructor(source, edits) {
    this.source = source;
    this.items = [...edits.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    this.regions = [];
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i].start < this.items[i - 1].end) throw new Error('Overlapping AST source edits');
    }
  }
  lowerBound(start, items = this.items) {
    let lo = 0, hi = items.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (items[mid].start < start) lo = mid + 1; else hi = mid; }
    return lo;
  }
  render(start, end, usedRegions) {
    let cursor = start, covered = start;
    const out = [], replacements = [];
    // An outer machine may lower individual statements from a region that was
    // already flattened. Keep original leaf edits available, and select only
    // completed child machines wholly inside the requested node's own range.
    for (let i = this.lowerBound(start, this.regions); i < this.regions.length && this.regions[i].start < end; i++) {
      const edit = this.regions[i];
      if (edit.end <= end && edit.start >= covered) { replacements.push(edit); covered = edit.end; }
    }
    for (let i = this.lowerBound(start); i < this.items.length && this.items[i].start < end; i++) {
      const edit = this.items[i];
      if (edit.start === start && edit.end === start) continue;
      if (edit.end > end) throw new Error('AST edit crosses its rendered node');
      replacements.push(edit);
    }
    replacements.sort((a, b) => a.start - b.start || (a.end === a.start ? -1 : b.end === b.start ? 1 : b.end - a.end));
    for (const edit of replacements) {
      if (edit.start < cursor) {
        if (edit.end > cursor) throw new Error('Source edits cross a CFG boundary');
        continue;
      }
      if (edit.metadata && usedRegions) {
        usedRegions.add(edit.metadata);
        for (const dependency of edit.metadata.dependencies) usedRegions.add(dependency);
      }
      out.push(this.source.slice(cursor, edit.start), edit.text); cursor = edit.end;
    }
    out.push(this.source.slice(cursor, end));
    return out.join('');
  }
  replace(start, end, text, metadata) {
    let at = this.lowerBound(start, this.regions);
    while (at < this.regions.length && this.regions[at].start === start && this.regions[at].end > end) at++;
    this.regions.splice(at, 0, { start, end, text, metadata });
  }
}

function renameBindings(ast, enabled, name, addEdit, stats) {
  const root = new Scope(null);
  const declare = (node, scope, implicit = false) => {
    const binding = { name: node.name, output: enabled && !implicit ? name() : node.name };
    scope.bindings.set(node.name, binding);
    if (binding.output !== node.name) { addEdit(node.range, binding.output); stats.identifiersRenamed++; }
    return binding;
  };
  const reference = (node, scope) => {
    const binding = scope.find(node.name);
    if (binding && binding.output !== node.name) { addEdit(node.range, binding.output); stats.identifierReferencesRenamed++; }
  };
  const functionNode = (node, scope) => {
    if (node.identifier) {
      if (node.isLocal) declare(node.identifier, scope);
      else expression(node.identifier, scope);
    }
    const child = new Scope(scope);
    // Colon declarations create an implicit local named self. Its spelling is
    // dictated by Lua syntax, so preserve it, including references in closures.
    if (node.identifier?.type === 'MemberExpression' && node.identifier.indexer === ':') {
      declare({ name: 'self' }, child, true);
    }
    for (const parameter of node.parameters) if (parameter.type === 'Identifier') declare(parameter, child);
    block(node.body, child);
  };
  const expression = (node, scope) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': reference(node, scope); return;
      case 'FunctionDeclaration': functionNode(node, scope); return;
      case 'MemberExpression': expression(node.base, scope); return;
      case 'IndexExpression': expression(node.base, scope); expression(node.index, scope); return;
      case 'TableConstructorExpression':
        for (const field of node.fields) {
          if (field.type === 'TableKey') expression(field.key, scope);
          expression(field.value, scope);
        }
        return;
      default:
        for (const [key, value] of Object.entries(node)) {
          if (['loc', 'range', 'comments', 'globals'].includes(key)) continue;
          if (Array.isArray(value)) {
            for (const child of value) if (child?.type) expression(child, scope);
          } else if (value?.type) expression(value, scope);
        }
    }
  };
  const statement = (node, scope) => {
    switch (node.type) {
      case 'LocalStatement':
        // A local is not in scope within its own initializer (local x = x).
        for (const init of node.init) expression(init, scope);
        for (const variable of node.variables) declare(variable, scope);
        return;
      case 'FunctionDeclaration': functionNode(node, scope); return;
      case 'IfStatement':
        for (const clause of node.clauses) {
          expression(clause.condition, scope);
          block(clause.body, new Scope(scope));
        }
        return;
      case 'WhileStatement': expression(node.condition, scope); block(node.body, new Scope(scope)); return;
      case 'RepeatStatement': {
        // Unlike while, repeat's condition can read locals declared in its body.
        const child = new Scope(scope); block(node.body, child); expression(node.condition, child); return;
      }
      case 'DoStatement': block(node.body, new Scope(scope)); return;
      case 'ForNumericStatement': {
        expression(node.start, scope); expression(node.end, scope); expression(node.step, scope);
        const child = new Scope(scope); declare(node.variable, child); block(node.body, child); return;
      }
      case 'ForGenericStatement': {
        for (const value of node.iterators) expression(value, scope);
        const child = new Scope(scope); for (const variable of node.variables) declare(variable, child);
        block(node.body, child); return;
      }
      case 'LabelStatement': case 'GotoStatement': case 'BreakStatement': return;
      default: expression(node, scope);
    }
  };
  const block = (body, scope) => { for (const node of body) statement(node, scope); };
  block(ast.body, root);
}

function inverse256(n) {
  for (let i = 1; i < 256; i += 2) if ((i * n) % 256 === 1) return i;
  throw new Error('Invalid affine byte key');
}

function stringPrelude(records, decoder, { name, random, lazy }) {
  const pool = name(), cache = name(), char = name(), concat = name(), get = name();
  const slot = name(), value = name(), record = name(), out = name(), i = name(), byte = name();
  const entries = random.shuffle(records).map(r => `[${r.slot}]={${r.method},${r.key},${r.step},${r.inverse},{${r.bytes.join(',')}}}`).join(',');
  const eager = lazy ? '' : records.map(r => `${get}(${r.slot});`).join('');
  return `local ${decoder}=(function()\nlocal ${pool}={${entries}}\nlocal ${cache}={}\nlocal ${char},${concat}=string.char,table.concat\nlocal function ${get}(${slot})\nlocal ${value}=${cache}[${slot}]\nif ${value}~=nil then return ${value} end\nlocal ${record}=${pool}[${slot}]\nlocal ${out}={}\nfor ${i}=1,#${record}[5] do\nlocal ${byte}=(${record}[5][${i}]-${record}[2]-(${i}*${record}[3])%256)%256\nif ${record}[1]==2 then ${byte}=(${byte}*${record}[4])%256 end\n${out}[${i}]=${char}(${byte})\nend\n${value}=${concat}(${out})\n${cache}[${slot}]=${value}\nreturn ${value}\nend\n${eager}return ${get}\nend)();\n`;
}

function numberPrelude(records, getter, { name, random }) {
  const pool = name(), slot = name();
  const entries = random.shuffle(records).map(r => `[${r.slot}]=${r.expression}`).join(',');
  return `local ${getter}=(function() local ${pool}={${entries}}; return function(${slot}) return ${pool}[${slot}] end end)();\n`;
}

const introducesBinding = node => node.type === 'LocalStatement' || (node.type === 'FunctionDeclaration' && node.isLocal);
const blockHasBindings = body => body.some(introducesBinding);

function escapingBreak(node, depth = 0) {
  if (!node) return false;
  if (node.type === 'FunctionDeclaration') return false;
  if (node.type === 'BreakStatement') return depth === 0;
  const loop = ['WhileStatement', 'RepeatStatement', 'ForNumericStatement', 'ForGenericStatement'].includes(node.type);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'comments', 'globals'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type && escapingBreak(child, depth + (loop && key === 'body' ? 1 : 0))) return true;
    } else if (value?.type && escapingBreak(value, depth)) return true;
  }
  return false;
}

function flattenControlFlow(ast, edits, { name, random, opaque, stats }) {
  const lowerable = new WeakMap();
  const canCompile = node => {
    if (introducesBinding(node)) return false;
    if (node.type === 'BreakStatement') return true;
    if (canLower(node)) return true;
    return !escapingBreak(node);
  };
  const canLower = node => {
    if (lowerable.has(node)) return lowerable.get(node);
    let result = false;
    if (node.type === 'IfStatement') result = node.clauses.every(c => !blockHasBindings(c.body) && c.body.every(canCompile));
    if (['WhileStatement', 'RepeatStatement', 'DoStatement'].includes(node.type)) result = !blockHasBindings(node.body) && node.body.every(canCompile);
    lowerable.set(node, result); return result;
  };
  const eligible = node => !introducesBinding(node) && !['BreakStatement', 'LabelStatement', 'GotoStatement'].includes(node.type) && !escapingBreak(node);

  const machine = body => {
    const states = [], used = new Set();
    const dependencies = new Set();
    const metrics = { flattenedBlocks: 1, virtualStates: 0, loweredLoops: 0, opaquePredicates: 0, deadStates: 0 };
    const stateId = () => { let id; do { id = random.int(10000, 1000000000); } while (used.has(id)); used.add(id); return id; };
    const exit = stateId(), state = name();
    const atom = (node, next) => {
      const id = stateId();
      states.push({ id, code: edits.render(...node.range, dependencies), next, terminal: node.type === 'ReturnStatement' });
      return id;
    };
    const condition = (node, yes, no, id = stateId()) => { states.push({ id, condition: edits.render(...node.range, dependencies), yes, no }); return id; };
    const sequence = (nodes, next, context) => {
      for (let i = nodes.length - 1; i >= 0; i--) next = compile(nodes[i], next, context);
      return next;
    };
    const compile = (node, next, context) => {
      if (node.type === 'BreakStatement') {
        if (context.breakTarget === undefined) throw new Error('Break escaped its flattened loop');
        return context.breakTarget;
      }
      if (node.type === 'IfStatement' && canLower(node)) {
        let no = next;
        for (let i = node.clauses.length - 1; i >= 0; i--) {
          const clause = node.clauses[i], yes = sequence(clause.body, next, context);
          no = clause.condition ? condition(clause.condition, yes, no) : yes;
        }
        return no;
      }
      if (node.type === 'WhileStatement' && canLower(node)) {
        const check = stateId(), body = sequence(node.body, check, { breakTarget: next });
        condition(node.condition, body, next, check); metrics.loweredLoops++; return check;
      }
      if (node.type === 'RepeatStatement' && canLower(node)) {
        const check = stateId(), body = sequence(node.body, check, { breakTarget: next });
        condition(node.condition, next, body, check); metrics.loweredLoops++; return body;
      }
      if (node.type === 'DoStatement' && canLower(node)) return sequence(node.body, next, context);
      return atom(node, next);
    };
    const entry = sequence(body, exit, {});
    if (states.length < 2) return null;
    let initial = String(entry);
    if (opaque) {
      const p = random.int(20, 4000), dead = stateId(), decoy = name(), n = random.int(10, 10000);
      initial = `((${p}*${p}-${p})%2==0) and ${entry} or ${dead}`;
      states.push({ id: dead, code: `local ${decoy}=(${n}+${n})-${n}`, next: exit });
      metrics.opaquePredicates++; metrics.deadStates++;
    }
    const branches = random.shuffle(states).map((block, index) => {
      const offset = random.int(1, 100000), form = random.int(0, 2);
      const check = form === 0 ? `${state}==${block.id}` : form === 1 ? `(${state}-${offset})==${block.id - offset}` : `(${state}+${offset})==${block.id + offset}`;
      let content;
      if (block.condition !== undefined) content = `if ${block.condition} then ${state}=${block.yes} else ${state}=${block.no} end`;
      else content = `${block.code}\n${block.terminal ? '' : `${state}=${block.next}`}`;
      return `${index ? 'elseif' : 'if'} ${check} then\n${content}\n`;
    }).join('');
    metrics.virtualStates = states.length;
    return { code: `do\nlocal ${state}=${initial}\nwhile ${state}~=${exit} do\n${branches}else ${state}=${exit} end\nend\nend`, metadata: { metrics, dependencies } };
  };

  const visited = new WeakSet();
  const visit = node => {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    // Post-order edits allow an outer region to absorb complete child machines.
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'comments', 'globals'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child);
      } else if (value?.type) visit(value);
    }
    if (!Array.isArray(node.body)) return;
    const body = node.body;
    let start = 0;
    while (start < body.length) {
      if (!eligible(body[start])) { stats.controlFlowBarriers++; start++; continue; }
      let end = start + 1;
      while (end < body.length && eligible(body[end])) end++;
      const nodes = body.slice(start, end);
      if (nodes.length > 1 || canLower(nodes[0])) {
        const result = machine(nodes);
        if (result) edits.replace(nodes[0].range[0], nodes.at(-1).range[1], result.code, result.metadata);
      }
      start = end;
    }
  };
  let labels = false;
  walk(ast, node => { if (['GotoStatement', 'LabelStatement'].includes(node.type)) labels = true; });
  if (labels) { stats.controlFlowSkippedLabels = true; return; }
  visit(ast);
}

export function transformSource(ast, source, { random, options = {}, profile = 'standard', dialect = 'lua51' } = {}) {
  if (!random || typeof random.name !== 'function') throw new Error('A randomized build context is required');
  const advanced = profile !== 'standard';
  const settings = { rename: true, stringProtection: true, constantProtection: true, controlFlow: advanced, opaquePredicates: advanced, lazyStrings: true, ...options };
  const locals = localUsage(ast, dialect);
  if (locals.maximum > 200) {
    const error = new Error('The program exceeds Lua\'s 200 simultaneously active local-variable limit.');
    error.code = 'LOCAL_LIMIT'; throw error;
  }
  const usedNames = new Set(KEYWORDS);
  walk(ast, node => { if (node.type === 'Identifier') usedNames.add(node.name); });
  const name = () => { let next; do { next = random.name(); } while (usedNames.has(next)); usedNames.add(next); return next; };
  const base = new Map();
  const addEdit = (range, text) => {
    if (!range || range.length !== 2) throw new Error('Source transformations require AST ranges');
    const key = range.join(':');
    if (base.has(key) && base.get(key).text !== text) throw new Error('Conflicting AST transformation');
    base.set(key, { start: range[0], end: range[1], text });
  };
  const stats = { identifiersRenamed: 0, identifierReferencesRenamed: 0, stringsProtected: 0, propertiesProtected: 0, numbersProtected: 0, integerExpressions: 0, exactNumericLiterals: 0, flattenedBlocks: 0, virtualStates: 0, loweredLoops: 0, opaquePredicates: 0, deadStates: 0, controlFlowBarriers: 0 };
  const passes = [];
  renameBindings(ast, settings.rename, name, addEdit, stats);
  if (stats.identifiersRenamed) passes.push('scope-aware-renaming');

  const strings = [], numbers = [], slots = new Set();
  const slot = () => { let value; do { value = random.int(1000, 16777215); } while (slots.has(value)); slots.add(value); return value; };
  let decoder, numberGetter;
  const protectString = value => {
    decoder ||= name();
    const method = random.int(1, 2), key = random.int(1, 255), step = random.int(1, 255), multiplier = random.int(1, 127) * 2 + 1;
    const bytes = [];
    for (let i = 0; i < value.length; i++) {
      const byte = value.charCodeAt(i);
      if (byte > 255) throw new Error('String decoding requires byte-oriented parser input');
      bytes.push((byte * (method === 2 ? multiplier : 1) + key + ((i + 1) * step) % 256) % 256);
    }
    const id = slot();
    strings.push({ slot: id, method, key, step, inverse: method === 2 ? inverse256(multiplier) : 1, bytes });
    return `${decoder}(${id})`;
  };

  const declarationPaths = new WeakSet(), stringCallArguments = new WeakSet();
  walk(ast, node => {
    if (node.type === 'FunctionDeclaration' && node.identifier) {
      for (let path = node.identifier; path?.type === 'MemberExpression'; path = path.base) declarationPaths.add(path);
    }
    if (node.type === 'StringCallExpression') stringCallArguments.add(node.argument);
  });
  walk(ast, node => {
    if (node.type === 'StringLiteral' && settings.stringProtection) {
      if (typeof node.value !== 'string') throw new Error('Parser did not decode a string literal');
      let text = protectString(node.value);
      // Lua's shorthand f"text" / f[[text]] call requires parentheses when the
      // literal becomes a decoder call. Normal argument/index contexts accept it.
      // Parent relationships are recorded below rather than inferred from text.
      if (stringCallArguments.has(node)) text = `(${text})`;
      addEdit(node.range, text); stats.stringsProtected++;
    }
    if (node.type === 'NumericLiteral' && settings.constantProtection) {
      numberGetter ||= name();
      const raw = source.slice(...node.range);
      let expression = raw;
      // Exact spelling preserves float/int distinction, hex floats, rounding,
      // signed zero (the unary minus remains outside), and large integer tokens.
      // Arithmetic is used only where both operands and sum are exactly safe.
      // Stay within signed 32-bit arithmetic too: supported testing/embedded Lua
      // runtimes can use 32-bit integers even when the host Lua uses 64-bit ints.
      if (/^\d{1,10}$/.test(raw) && Number(raw) <= 1000000000) {
        const n = Number(raw), mask = random.int(1, 1000000);
        expression = random.int(0, 1) ? `(${n + mask}-${mask})` : `(${n - mask}+${mask})`;
        stats.integerExpressions++;
      } else stats.exactNumericLiterals++;
      const id = slot(); numbers.push({ slot: id, expression });
      addEdit(node.range, `${numberGetter}(${id})`); stats.numbersProtected++;
    }
    if (advanced && settings.stringProtection && node.type === 'MemberExpression' && node.indexer === '.' && !declarationPaths.has(node)) {
      let dot = node.identifier.range[0] - 1;
      while (dot >= node.base.range[1] && /\s/.test(source[dot])) dot--;
      // Comments between dot and property can simply retain their original form.
      if (source[dot] === '.' && dot >= node.base.range[1]) {
        addEdit([dot, node.identifier.range[1]], `[${protectString(node.identifier.name)}]`); stats.propertiesProtected++;
      }
    }
    if (advanced && settings.stringProtection && node.type === 'TableKeyString') {
      addEdit(node.key.range, `[${protectString(node.key.name)}]`); stats.propertiesProtected++;
    }
  });
  if (strings.length) passes.push('per-string-byte-encryption', settings.lazyStrings ? 'lazy-string-cache' : 'eager-string-cache');
  if (stats.propertiesProtected) passes.push('encrypted-property-indirection');
  if (numbers.length) passes.push('exact-constant-pooling');
  if (stats.integerExpressions) passes.push('exact-integer-expressions');

  // A literal was not originally a call prefix. After replacing it with a
  // decoder/getter call, a following parenthesized statement could otherwise
  // become a call suffix across a newline. Separate those parsed siblings,
  // respecting an existing semicolon and semicolons inside comments.
  const commentEnds = new Map((ast.comments || []).map(comment => [comment.range[0], comment.range[1]]));
  const hasSeparator = (start, end) => {
    for (let i = start; i < end; i++) {
      if (commentEnds.has(i)) { i = commentEnds.get(i) - 1; continue; }
      if (source[i] === ';') return true;
    }
    return false;
  };
  walk(ast, node => {
    if (!Array.isArray(node.body)) return;
    for (let i = 0; i + 1 < node.body.length; i++) {
      const end = node.body[i].range[1], next = node.body[i + 1].range[0];
      if (source[next] === '(' && !hasSeparator(end, next)) addEdit([end, end], ';');
    }
  });

  const edits = new Edits(source, base);
  const helperLocals = Number(strings.length > 0) + Number(numbers.length > 0);
  // Every nested eligible body can add one state local. Two additional slots
  // cover the decoy branch and Lua 5.1's optional implicit vararg `arg` local.
  const controlFlowFits = locals.maximum + locals.depth + helperLocals + 2 <= 200;
  if (settings.controlFlow && controlFlowFits) flattenControlFlow(ast, edits, { name, random, opaque: settings.opaquePredicates, stats });
  if (settings.controlFlow && !controlFlowFits) stats.controlFlowSkippedLocalLimit = true;
  let prelude = '';
  if (strings.length) prelude += stringPrelude(strings, decoder, { name, random, lazy: settings.lazyStrings });
  if (numbers.length) prelude += numberPrelude(numbers, numberGetter, { name, random });
  const wrapChunk = locals.root + helperLocals > 200;
  if (wrapChunk && locals.topVararg) {
    const error = new Error('Safe helper insertion would exceed Lua\'s local-variable limit in this vararg chunk. Split it into smaller functions.');
    error.code = 'LOCAL_LIMIT'; throw error;
  }
  // Keep shebangs, header comments, and Luau compiler directives first. A chunk
  // near Lua's local limit can share helpers as upvalues of a normal function.
  const insertion = ast.body[0]?.range[0] ?? source.length;
  const usedRegions = new Set();
  let body = edits.render(insertion, source.length, usedRegions);
  for (const { metrics } of usedRegions) for (const [key, value] of Object.entries(metrics)) stats[key] += value;
  if (stats.flattenedBlocks) passes.push('randomized-cfg-state-machines');
  if (stats.opaquePredicates) passes.push('opaque-dispatch-entry', 'unreachable-states');
  if (wrapChunk) { body = `return (function()\n${body}\nend)()`; stats.chunkWrapped = true; passes.push('local-limit-safe-wrapper'); }
  const code = edits.render(0, insertion) + prelude + body;
  const warnings = [];
  if (stats.controlFlowSkippedLocalLimit) warnings.push('Control-flow flattening was skipped because the program is near Lua\'s active-local limit.');
  else if (settings.controlFlow && !stats.flattenedBlocks) warnings.push('No block was eligible for safe control-flow flattening; the other reported passes were applied.');
  return { code, stats, passes, warnings };
}

