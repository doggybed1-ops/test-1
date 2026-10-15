import { randomInt } from 'node:crypto';

// Register-machine compiler. User code is represented only by VM instructions;
// the generated program never reparses source or invokes load/loadstring.
const MOD = 16777213;
const BLOCKED_GLOBALS = new Set(['_ENV', 'getfenv', 'setfenv', 'debug']);
const BIN = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '^': 'POW',
  '..': 'CONCAT', '==': 'EQ', '~=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
};
const UN = { '-': 'NEG', not: 'NOT', '#': 'LEN' };
const OPS = [
  'K', 'NIL', 'BOOL', 'GETLOCAL', 'GETUP', 'GETGLOBAL', 'SETLOCAL', 'SETUP',
  'SETGLOBAL', 'NEWLOCAL', 'MOVE', 'CLOSURE', 'PACK0', 'PUSH1', 'PUSHM',
  'GETPACK', 'VARARG1', 'VARARGM', 'CALL1', 'CALLM', 'TAILCALL', 'RETURN', 'RETURN0',
  'GETTABLE', 'SETTABLE', 'NEWTABLE', 'SETLIST', 'CHECKITER', 'JUMP', 'JFALSE', 'JTRUE',
  'JNIL', 'FORPREP', 'FORCHECK', ...Object.values(BIN), ...Object.values(UN),
];

function unsupported(node, message) {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_FEATURE';
  error.loc = node?.loc;
  error.line = node?.loc?.start?.line;
  error.column = node?.loc?.start?.column;
  throw error;
}

function inverse(a, m) {
  let [r, nr, t, nt] = [m, a, 0, 1];
  while (nr) {
    const q = Math.floor(r / nr);
    [r, nr] = [nr, r - q * nr];
    [t, nt] = [nt, t - q * nt];
  }
  return (t % m + m) % m;
}

function fallbackRandom() {
  return {
    int: (a, b) => randomInt(a, b + 1),
    name: () => '_v' + randomInt(0x7fffffff).toString(36),
    shuffle: a => {
      const copy = [...a];
      for (let i = copy.length - 1; i; i--) {
        const j = randomInt(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
}

class Program {
  constructor(random, options, dialect) {
    this.random = random;
    this.options = options;
    this.dialect = dialect;
    this.prototypes = [];
    this.constants = [];
    this.constantMap = new Map();
    this.ids = new Set();
    this.opcodes = new Map(OPS.map(op => [op, this.id()]));
    this.instructions = 0;
    this.branches = 0;
    this.capturedCells = 0;
    this.iteratorGuards = 0;
    this.dataFactories = 0;
  }

  id() {
    let value;
    do value = this.random.int(1, MOD - 1); while (this.ids.has(value));
    this.ids.add(value);
    return value;
  }

  constant(type, value, node) {
    if (type === 'number') {
      value = String(node?.raw ?? value);
      if (/^0[xX].*[pP.]/.test(value)) {
        unsupported(node, 'Hexadecimal floating-point literals are not supported by the portable VM profile.');
      }
    }
    if (typeof value !== 'string' || [...value].some(c => c.charCodeAt(0) > 255)) {
      unsupported(node, 'String literals must be parsed as UTF-8 bytes before VM compilation.');
    }
    // Equal literals may share a pool entry, but each distinct entry gets its
    // own key, salt, encoding method, location, and ciphertext.
    const key = type + ':' + value;
    if (this.constantMap.has(key)) return this.constantMap.get(key);
    const id = this.id();
    const mode = this.random.int(1, 3);
    const k = this.random.int(0, 255);
    const split = this.random.int(0, 255);
    const stride = this.random.int(1, 255);
    const multiplier = this.random.int(0, 127) * 2 + 1;
    let previous = this.random.int(0, 255);
    const initial = previous;
    const bytes = [];
    for (let i = 0; i < value.length; i++) {
      const byte = value.charCodeAt(i);
      let encoded;
      if (mode === 1) encoded = (byte + k + (i + 1) * stride) % 256;
      if (mode === 2) encoded = (byte * multiplier + k + (i + 1) * stride) % 256;
      if (mode === 3) encoded = (byte + k + previous + (i + 1) * stride) % 256;
      bytes.push(encoded);
      previous = encoded;
    }
    this.constants.push({ id, type, mode, split, other: (k - split + 256) % 256, stride,
      inv: inverse(multiplier, 256), initial, bytes });
    this.constantMap.set(key, id);
    return id;
  }
}

class FunctionCompiler {
  constructor(program, parent, node, implicitSelf = false) {
    this.program = program;
    this.parent = parent;
    this.node = node;
    this.id = program.id();
    this.code = [];
    this.scopes = [new Map()];
    this.registers = 0;
    this.cells = 0;
    this.parameters = [];
    this.captures = [];
    this.captureMap = new Map();
    this.breaks = [];
    this.vararg = node.type === 'Chunk';
    program.prototypes.push(this);
    if (implicitSelf) this.parameters.push(this.declare('self').index);
    for (const parameter of node.parameters ?? []) {
      if (parameter.type === 'VarargLiteral') this.vararg = true;
      else if (parameter.type === 'Identifier') this.parameters.push(this.declare(parameter.name).index);
      else unsupported(parameter, 'This function parameter is not supported by the VM.');
    }
  }

  reg() {
    return ++this.registers;
  }

  emit(op, ...args) {
    const instruction = { op, args };
    this.code.push(instruction);
    this.program.instructions++;
    if (['JUMP', 'JFALSE', 'JTRUE', 'JNIL', 'FORCHECK'].includes(op)) this.program.branches++;
    return instruction;
  }

  mark() {
    return this.code.length;
  }

  jump(op, args = []) {
    return this.emit(op, ...args, null);
  }

  patch(instruction, position = this.mark()) {
    instruction.args[instruction.args.length - 1] = { target: position };
  }

  scope(fn) {
    this.scopes.push(new Map());
    fn();
    this.scopes.pop();
  }

  declare(name) {
    const binding = { kind: 'local', index: ++this.cells, name };
    this.scopes.at(-1).set(name, binding);
    return binding;
  }

  resolve(name, node) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i].get(name);
      if (binding) return binding;
    }
    if (this.parent) {
      const outer = this.parent.resolve(name, node);
      if (outer.kind !== 'global') {
        const key = outer.kind + ':' + outer.index;
        if (!this.captureMap.has(key)) {
          const binding = { kind: 'up', index: this.captures.length + 1, name };
          this.captures.push(outer);
          this.captureMap.set(key, binding);
          this.program.capturedCells++;
        }
        return this.captureMap.get(key);
      }
      return outer;
    }
    if (BLOCKED_GLOBALS.has(name)) {
      unsupported(node, `The VM does not preserve environment or debug introspection (${name}).`);
    }
    return { kind: 'global', index: this.program.constant('string', name, node), name };
  }

  load(binding) {
    const out = this.reg();
    this.emit({ local: 'GETLOCAL', up: 'GETUP', global: 'GETGLOBAL' }[binding.kind], out, binding.index);
    return out;
  }

  store(binding, register) {
    this.emit({ local: 'SETLOCAL', up: 'SETUP', global: 'SETGLOBAL' }[binding.kind], binding.index, register);
  }

  literal(node) {
    const out = this.reg();
    if (node.type === 'NilLiteral') this.emit('NIL', out);
    else if (node.type === 'BooleanLiteral') this.emit('BOOL', out, node.value ? 1 : 0);
    else this.emit('K', out, this.program.constant(node.type === 'NumericLiteral' ? 'number' : 'string', node.value, node));
    return out;
  }

  pack(expressions = [], prefix = []) {
    const out = this.reg();
    this.emit('PACK0', out);
    for (const register of prefix) this.emit('PUSH1', out, register);
    expressions.forEach((expression, i) => {
      const multiple = i === expressions.length - 1;
      const value = this.expression(expression, multiple ? 'multi' : 'one');
      this.emit(multiple ? 'PUSHM' : 'PUSH1', out, value);
    });
    return out;
  }

  extract(pack, index) {
    const out = this.reg();
    this.emit('GETPACK', out, pack, index);
    return out;
  }

  call(node) {
    let fn;
    const prefix = [];
    if (node.base.type === 'MemberExpression' && node.base.indexer === ':') {
      const base = this.expression(node.base.base);
      const key = this.literal({ type: 'StringLiteral', value: node.base.identifier.name, loc: node.base.loc });
      fn = this.reg();
      this.emit('GETTABLE', fn, base, key);
      prefix.push(base);
    } else fn = this.expression(node.base);
    const expressions = node.type === 'CallExpression' ? node.arguments
      : node.type === 'StringCallExpression' ? [node.argument] : [node.arguments];
    return { fn, args: this.pack(expressions, prefix) };
  }

  expression(node, mode = 'one') {
    const calls = ['CallExpression', 'TableCallExpression', 'StringCallExpression'];
    if (mode === 'multi' && (node.parenthesized || (!calls.includes(node.type) && node.type !== 'VarargLiteral'))) {
      const value = this.expression(node, 'one');
      const out = this.reg();
      this.emit('PACK0', out);
      this.emit('PUSH1', out, value);
      return out;
    }
    switch (node.type) {
      case 'Identifier': return this.load(this.resolve(node.name, node));
      case 'StringLiteral':
      case 'NumericLiteral':
      case 'BooleanLiteral':
      case 'NilLiteral': return this.literal(node);
      case 'VarargLiteral': {
        if (!this.vararg) unsupported(node, 'Varargs are only supported in variadic functions.');
        const out = this.reg();
        this.emit(mode === 'multi' ? 'VARARGM' : 'VARARG1', out);
        return out;
      }
      case 'UnaryExpression': {
        const op = UN[node.operator];
        if (!op) unsupported(node, `The portable VM does not implement unary operator ${node.operator}.`);
        const arg = this.expression(node.argument);
        const out = this.reg();
        this.emit(op, out, arg);
        return out;
      }
      case 'BinaryExpression': {
        const op = BIN[node.operator];
        if (!op) unsupported(node, `The portable VM does not implement operator ${node.operator}.`);
        const left = this.expression(node.left);
        const right = this.expression(node.right);
        const out = this.reg();
        this.emit(op, out, left, right);
        return out;
      }
      case 'LogicalExpression': {
        const left = this.expression(node.left);
        const out = this.reg();
        this.emit('MOVE', out, left);
        const branch = this.jump(node.operator === 'and' ? 'JFALSE' : 'JTRUE', [left]);
        this.emit('MOVE', out, this.expression(node.right));
        this.patch(branch);
        return out;
      }
      case 'MemberExpression': {
        if (node.indexer === ':') unsupported(node, 'A method reference must be used in a method call.');
        const base = this.expression(node.base);
        const key = this.literal({ type: 'StringLiteral', value: node.identifier.name, loc: node.loc });
        const out = this.reg();
        this.emit('GETTABLE', out, base, key);
        return out;
      }
      case 'IndexExpression': {
        const base = this.expression(node.base);
        const index = this.expression(node.index);
        const out = this.reg();
        this.emit('GETTABLE', out, base, index);
        return out;
      }
      case 'CallExpression':
      case 'TableCallExpression':
      case 'StringCallExpression': {
        const { fn, args } = this.call(node);
        const out = this.reg();
        this.emit(mode === 'multi' ? 'CALLM' : 'CALL1', out, fn, args);
        return out;
      }
      case 'TableConstructorExpression': {
        const out = this.reg();
        this.emit('NEWTABLE', out);
        let arrayIndex = 1;
        node.fields.forEach((field, i) => {
          if (field.type === 'TableValue') {
            if (i === node.fields.length - 1) {
              const values = this.expression(field.value, 'multi');
              this.emit('SETLIST', out, arrayIndex, values);
            } else {
              const key = this.literal({ type: 'NumericLiteral', value: arrayIndex, raw: String(arrayIndex) });
              this.emit('SETTABLE', out, key, this.expression(field.value));
            }
            arrayIndex++;
          } else if (field.type === 'TableKey' || field.type === 'TableKeyString') {
            const key = field.type === 'TableKey' ? this.expression(field.key)
              : this.literal({ type: 'StringLiteral', value: field.key.name, loc: field.loc });
            this.emit('SETTABLE', out, key, this.expression(field.value));
          } else unsupported(field, `Unsupported table field ${field.type}.`);
        });
        return out;
      }
      case 'FunctionDeclaration': return this.closure(node);
      default: unsupported(node, `The VM does not implement expression ${node.type}.`);
    }
  }

  closure(node, implicitSelf = false) {
    const child = new FunctionCompiler(this.program, this, node, implicitSelf);
    child.block(node.body);
    child.emit('RETURN0');
    const out = this.reg();
    this.emit('CLOSURE', out, child.id);
    return out;
  }

  target(node) {
    if (node.type === 'Identifier') return { binding: this.resolve(node.name, node) };
    if (node.type === 'MemberExpression') {
      return { base: this.expression(node.base), key: this.literal({ type: 'StringLiteral', value: node.identifier.name, loc: node.loc }) };
    }
    if (node.type === 'IndexExpression') return { base: this.expression(node.base), key: this.expression(node.index) };
    unsupported(node, `Unsupported assignment target ${node.type}.`);
  }

  assign(target, value) {
    if (target.binding) this.store(target.binding, value);
    else this.emit('SETTABLE', target.base, target.key, value);
  }

  loop(fn) {
    const exits = [];
    this.breaks.push(exits);
    fn();
    this.breaks.pop();
    for (const branch of exits) this.patch(branch);
  }

  block(body) {
    for (const statement of body) this.statement(statement);
  }

  statement(node) {
    switch (node.type) {
      case 'LocalStatement': {
        const values = this.pack(node.init);
        // All initializers see the enclosing scope, including local x = x.
        const bindings = node.variables.map(variable => this.declare(variable.name));
        bindings.forEach((binding, i) => this.emit('NEWLOCAL', binding.index, this.extract(values, i + 1)));
        return;
      }
      case 'AssignmentStatement': {
        const targets = node.variables.map(variable => this.target(variable));
        const values = this.pack(node.init);
        // Lua assigns right-to-left; Luau deliberately assigns left-to-right.
        // Target addresses were captured before RHS evaluation in both cases.
        const order = Array.from({ length: targets.length }, (_, i) => i);
        if (this.program.dialect !== 'luau') order.reverse();
        for (const i of order) this.assign(targets[i], this.extract(values, i + 1));
        return;
      }
      case 'CallStatement': this.expression(node.expression); return;
      case 'ReturnStatement': {
        if (!node.arguments.length) this.emit('RETURN0');
        else if (node.arguments.length === 1 && !node.arguments[0].parenthesized
          && ['CallExpression', 'TableCallExpression', 'StringCallExpression'].includes(node.arguments[0].type)) {
          const { fn, args } = this.call(node.arguments[0]);
          this.emit('TAILCALL', fn, args);
        } else this.emit('RETURN', this.pack(node.arguments));
        return;
      }
      case 'FunctionDeclaration': {
        if (!node.identifier) unsupported(node, 'A function statement needs an identifier.');
        if (node.isLocal) {
          const binding = this.declare(node.identifier.name);
          this.emit('NEWLOCAL', binding.index, 0);
          this.store(binding, this.closure(node));
        } else {
          const target = this.target(node.identifier);
          const method = node.identifier.type === 'MemberExpression' && node.identifier.indexer === ':';
          this.assign(target, this.closure(node, method));
        }
        return;
      }
      case 'DoStatement': this.scope(() => this.block(node.body)); return;
      case 'IfStatement': {
        const ends = [];
        for (const clause of node.clauses) {
          const branch = clause.condition ? this.jump('JFALSE', [this.expression(clause.condition)]) : null;
          this.scope(() => this.block(clause.body));
          ends.push(this.jump('JUMP'));
          if (branch) this.patch(branch);
        }
        for (const branch of ends) this.patch(branch);
        return;
      }
      case 'WhileStatement': {
        this.loop(() => {
          const top = this.mark();
          const exit = this.jump('JFALSE', [this.expression(node.condition)]);
          this.scope(() => this.block(node.body));
          this.emit('JUMP', { target: top });
          this.patch(exit);
        });
        return;
      }
      case 'RepeatStatement': {
        this.loop(() => this.scope(() => {
          const top = this.mark();
          this.block(node.body);
          const condition = this.expression(node.condition);
          this.emit('JFALSE', condition, { target: top });
        }));
        return;
      }
      case 'ForNumericStatement': {
        const index = this.expression(node.start);
        const limit = this.expression(node.end);
        const step = node.step ? this.expression(node.step)
          : this.literal({ type: 'NumericLiteral', value: 1, raw: '1' });
        const iterator = this.reg();
        this.emit('FORPREP', iterator, index, limit, step);
        this.scope(() => this.loop(() => {
          const binding = this.declare(node.variable.name);
          const top = this.mark();
          const exit = this.jump('FORCHECK', [index, iterator]);
          // A fresh cell per iteration preserves closure capture semantics.
          this.emit('NEWLOCAL', binding.index, index);
          this.scope(() => this.block(node.body));
          this.emit('JUMP', { target: top });
          this.patch(exit);
        }));
        return;
      }
      case 'ForGenericStatement': {
        if (this.program.dialect === 'luau' && node.iterators[0]?.type === 'TableConstructorExpression') {
          unsupported(node.iterators[0], 'Unsupported Luau generalized iteration; use pairs/ipairs or a function iterator.');
        }
        const values = this.pack(node.iterators);
        const fn = this.extract(values, 1);
        const state = this.extract(values, 2);
        const control = this.extract(values, 3);
        if (this.program.dialect === 'luau') {
          this.emit('CHECKITER', fn);
          this.program.iteratorGuards++;
        }
        this.scope(() => this.loop(() => {
          const bindings = node.variables.map(variable => this.declare(variable.name));
          const top = this.mark();
          const args = this.pack([], [state, control]);
          const result = this.reg();
          this.emit('CALLM', result, fn, args);
          this.emit('GETPACK', control, result, 1);
          const exit = this.jump('JNIL', [control]);
          bindings.forEach((binding, i) => this.emit('NEWLOCAL', binding.index, this.extract(result, i + 1)));
          this.scope(() => this.block(node.body));
          this.emit('JUMP', { target: top });
          this.patch(exit);
        }));
        return;
      }
      case 'BreakStatement': {
        if (!this.breaks.length) unsupported(node, 'break must be inside a loop.');
        this.breaks.at(-1).push(this.jump('JUMP'));
        return;
      }
      case 'EmptyStatement': return;
      default: unsupported(node, `The portable VM does not implement statement ${node.type}.`);
    }
  }
}

function emitRuntime(program, main) {
  const random = program.random;
  const usedNames = new Set();
  const name = () => {
    let candidate;
    do candidate = random.name(); while (usedNames.has(candidate));
    usedNames.add(candidate);
    return candidate;
  };
  const names = Object.fromEntries([
    'protos', 'pool', 'cache', 'getconst', 'pack', 'run', 'unpack', 'char', 'concat',
    'select', 'tonumber', 'type', 'error', 'env', 'prototype', 'up', 'args', 'cells',
    'regs', 'varargs', 'pc', 'row', 'op', 'a', 'b', 'c', 'd', 'next', 'decode',
    'i', 'j', 't', 'z', 'f', 'q', 'r', 'k', 's', 'previous', 'byte', 'value',
    'id', 'captured', 'meta', 'cipher', 'result', 'wrap', 'yield', 'pairs',
  ].map(key => [key, name()]));
  const n = names;
  const cv = id => `${n.getconst}(${id})`;
  const v = register => `${n.regs}[${register}]`;
  const localCell = index => `${n.cells}[${index}][1]`;
  const upCell = index => `${n.up}[${index}][1]`;
  const a = n.a, b = n.b, c = n.c, d = n.d;
  const va = v(a), vb = v(b), vc = v(c);

  // Lua 5.1 limits the constant table of each native function to 262,143
  // entries. Encoded instruction numbers are deliberately varied, so a large
  // single constructor would overflow that limit even though the VM program
  // itself is valid. Each data factory owns at most 1,000 sparse fields; its
  // numeric constants belong to its own native function rather than the loader.
  // The merge uses the original pairs function captured before user execution.
  const chunkedTable = fields => {
    const size = 1000;
    if (fields.length <= size) return `{${fields.join(',')}}`;
    const target = name(), key = name(), value = name();
    const chunks = [];
    for (let i = 0; i < fields.length; i += size) {
      chunks.push(`for ${key},${value} in ${n.pairs}((function() return {${fields.slice(i, i + size).join(',')}} end)()) do ${target}[${key}]=${value} end;`);
    }
    program.dataFactories += chunks.length + 1;
    return `(function() local ${target}={};${chunks.join('')}return ${target} end)()`;
  };

  const handlers = {
    K: `${va}=${cv(b)}`,
    NIL: `${va}=nil`,
    BOOL: `${va}=(${b}==1)`,
    GETLOCAL: `${va}=${localCell(b)}`,
    GETUP: `${va}=${upCell(b)}`,
    GETGLOBAL: `${va}=${n.env}[${cv(b)}]`,
    SETLOCAL: `${localCell(a)}=${vb}`,
    SETUP: `${upCell(a)}=${vb}`,
    SETGLOBAL: `${n.env}[${cv(a)}]=${vb}`,
    NEWLOCAL: `${n.cells}[${a}]={${vb}}`,
    MOVE: `${va}=${vb}`,
    CLOSURE: `local ${n.q}=${n.protos}[${b}];local ${n.captured}={};for ${n.i}=1,#${n.q}[4] do local ${n.meta}=((${n.q}[4][${n.i}]-${n.q}[7][3])*${n.q}[7][2])%${MOD};local ${n.j}=(${n.meta}-${n.meta}%2)/2;if ${n.meta}%2==0 then ${n.captured}[${n.i}]=${n.cells}[${n.j}] else ${n.captured}[${n.i}]=${n.up}[${n.j}] end end;${va}=function(...) return ${n.run}(${n.q},${n.captured},${n.pack}(...)) end`,
    PACK0: `${va}={n=0}`,
    PUSH1: `local ${n.t}=${va};${n.t}.n=${n.t}.n+1;${n.t}[${n.t}.n]=${vb}`,
    PUSHM: `local ${n.t}=${va};local ${n.z}=${vb};for ${n.i}=1,${n.z}.n do ${n.t}[${n.t}.n+${n.i}]=${n.z}[${n.i}] end;${n.t}.n=${n.t}.n+${n.z}.n`,
    GETPACK: `${va}=${vb}[${c}]`,
    VARARG1: `${va}=${n.varargs}[1]`,
    VARARGM: `${va}=${n.varargs}`,
    CALL1: `${va}=${vb}(${n.unpack}(${vc},1,${vc}.n))`,
    CALLM: `${va}=${n.pack}(${vb}(${n.unpack}(${vc},1,${vc}.n)))`,
    TAILCALL: `return ${va}(${n.unpack}(${vb},1,${vb}.n))`,
    RETURN: `return ${n.unpack}(${va},1,${va}.n)`,
    RETURN0: `return`,
    GETTABLE: `${va}=${vb}[${vc}]`,
    SETTABLE: `${va}[${vb}]=${vc}`,
    NEWTABLE: `${va}={}`,
    SETLIST: `local ${n.t}=${vc};for ${n.i}=1,${n.t}.n do ${va}[${b}+${n.i}-1]=${n.t}[${n.i}] end`,
    CHECKITER: `if ${n.type}(${va})~="function" then ${n.error}("unsupported Luau generalized iteration; use pairs/ipairs or a function iterator",0) end`,
    JUMP: `${n.next}=${a}`,
    JFALSE: `if not ${va} then ${n.next}=${b} end`,
    JTRUE: `if ${va} then ${n.next}=${b} end`,
    JNIL: `if ${va}==nil then ${n.next}=${b} end`,
    // Delegate only counter advancement to a native numeric-for. This preserves
    // each host's string coercion, integer/float subtype, zero-step behavior,
    // overflow termination, and infinity/NaN handling without rounding bounds.
    // The protected loop body always executes in the caller's VM coroutine.
    FORPREP: `local ${n.s},${n.t},${n.z}=${vb},${vc},${v(d)};${va}=${n.wrap}(function() for ${n.i}=${n.s},${n.t},${n.z} do ${n.yield}(${n.i}) end end)`,
    FORCHECK: `${va}=${vb}();if ${va}==nil then ${n.next}=${c} end`,
  };
  for (const [operator, opcode] of Object.entries(BIN)) handlers[opcode] = `${va}=${vb}${operator}${vc}`;
  for (const [operator, opcode] of Object.entries(UN)) handlers[opcode] = `${va}=${operator} ${vb}`;

  const prototypes = random.shuffle([...program.prototypes]).map(prototype => {
    const states = prototype.code.map(() => program.id());
    const multiplier = random.int(2, 31);
    const inv = inverse(multiplier, MOD);
    const add = random.int(1, 127), salt = random.int(1, 31), offset = random.int(1, 127);
    const meta = value => (value * multiplier + add) % MOD;
    const rows = prototype.code.map((instruction, i) => {
      const key = random.int(1, 127);
      const args = instruction.args.map(arg => typeof arg === 'object' && arg !== null ? states[arg.target] : arg);
      if (args.some(arg => arg == null)) throw new Error(`Unresolved VM branch in ${instruction.op}.`);
      while (args.length < 4) args.push(0);
      const values = [program.opcodes.get(instruction.op), ...args, states[i + 1] ?? 0];
      if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value >= MOD)) {
        throw new Error('VM instruction or operand exceeds the supported compilation limit.');
      }
      const encoded = values.map((value, j) => (value * multiplier + key * (add + (j + 2) * salt) + (j + 2) * offset) % MOD);
      return `[${states[i]}]={${key},${encoded.join(',')}}`;
    });
    const params = prototype.parameters.map(meta).join(',');
    const captures = prototype.captures.map(binding => meta(binding.index * 2 + (binding.kind === 'up' ? 1 : 0))).join(',');
    // A floating inverse forces exact IEEE-double mask arithmetic even on
    // 32-bit-integer Lua hosts (including Fengari). Products remain < 2^49.
    return `[${prototype.id}]={${states[0]},${chunkedTable(random.shuffle(rows))},{${params}},{${captures}},${prototype.vararg ? 1 : 0},${prototype.parameters.length},{${multiplier},${inv}.0,${add},${salt},${offset}}}`;
  });
  const constants = random.shuffle([...program.constants]).map(constant =>
    `[${constant.id}]={${constant.type === 'number' ? 1 : 0},${constant.mode},${constant.split},${constant.other},${constant.stride},${constant.inv},${constant.initial},{${constant.bytes.join(',')}}}`);
  const dispatch = random.shuffle([...OPS]).map((op, i) => `${i ? 'elseif' : 'if'} ${n.op}==${program.opcodes.get(op)} then ${handlers[op]}`).join(' ')
    + ` else ${n.error}("invalid protected instruction",0) end`;
  const cacheLookup = program.options.lazyStrings !== false ? `local ${n.t}=${n.cache}[${n.id}];if ${n.t} then return ${n.t}[1] end;` : '';
  const cacheStore = program.options.lazyStrings !== false ? `${n.cache}[${n.id}]={${n.value}};` : '';
  const opaque = program.options.opaquePredicates !== false
    ? `if (${n.pc}*${n.pc}+${n.pc})%2~=0 then ${n.error}("invalid protected state",0) end;` : '';
  const prototypeData = chunkedTable(prototypes);
  const constantData = chunkedTable(constants);

  return `return (function(...)
local ${n.env}=(getfenv and getfenv()) or _ENV or _G;
local ${n.unpack}=unpack or table.unpack;local ${n.char},${n.concat},${n.select},${n.tonumber},${n.type},${n.error}=string.char,table.concat,select,tonumber,type,error;
local ${n.wrap},${n.yield}=coroutine.wrap,coroutine.yield;
local ${n.pairs}=pairs;
local ${n.protos}=${prototypeData};local ${n.pool}=${constantData};local ${n.cache}={};
local function ${n.pack}(...) return {n=${n.select}("#",...),...} end;
local function ${n.getconst}(${n.id})
${cacheLookup}local ${n.q}=${n.pool}[${n.id}];local ${n.k}=(${n.q}[3]+${n.q}[4])%256;local ${n.s}={};local ${n.previous}=${n.q}[7];
for ${n.i}=1,#${n.q}[8] do local ${n.cipher}=${n.q}[8][${n.i}];local ${n.byte};if ${n.q}[2]==1 then ${n.byte}=(${n.cipher}-${n.k}-${n.i}*${n.q}[5])%256 elseif ${n.q}[2]==2 then ${n.byte}=((${n.cipher}-${n.k}-${n.i}*${n.q}[5])*${n.q}[6])%256 else ${n.byte}=(${n.cipher}-${n.k}-${n.previous}-${n.i}*${n.q}[5])%256 end;${n.previous}=${n.cipher};${n.s}[${n.i}]=${n.char}(${n.byte}) end;
local ${n.value}=${n.concat}(${n.s});if ${n.q}[1]==1 then ${n.value}=${n.tonumber}(${n.value});if ${n.value}==nil then ${n.error}("invalid protected constant",0) end end;${cacheStore}return ${n.value} end;
local ${n.run};${n.run}=function(${n.prototype},${n.up},${n.args})
local ${n.cells},${n.regs},${n.varargs}={},{},{n=0};local ${n.q}=${n.prototype}[7];
for ${n.i}=1,#${n.prototype}[3] do local ${n.j}=((${n.prototype}[3][${n.i}]-${n.q}[3])*${n.q}[2])%${MOD};${n.cells}[${n.j}]={${n.args}[${n.i}]} end;
if ${n.prototype}[5]==1 then ${n.varargs}.n=${n.args}.n-${n.prototype}[6];if ${n.varargs}.n<0 then ${n.varargs}.n=0 end;for ${n.i}=1,${n.varargs}.n do ${n.varargs}[${n.i}]=${n.args}[${n.i}+${n.prototype}[6]] end end;
local ${n.pc}=${n.prototype}[1];local function ${n.decode}(${n.row},${n.i}) return ((${n.row}[${n.i}]-${n.row}[1]*(${n.q}[3]+${n.i}*${n.q}[4])-${n.i}*${n.q}[5])*${n.q}[2])%${MOD} end;
while true do ${opaque}local ${n.row}=${n.prototype}[2][${n.pc}];if not ${n.row} then ${n.error}("invalid protected program counter",0) end;
local ${n.op},${a},${b},${c},${d},${n.next}=${n.decode}(${n.row},2),${n.decode}(${n.row},3),${n.decode}(${n.row},4),${n.decode}(${n.row},5),${n.decode}(${n.row},6),${n.decode}(${n.row},7);
${dispatch};${n.pc}=${n.next} end end;
return ${n.run}(${n.protos}[${main.id}],{},${n.pack}(...))
end)(...)`;
}

export function virtualize(ast, { random = fallbackRandom(), options = {}, dialect = 'lua51' } = {}) {
  if (!ast || ast.type !== 'Chunk') throw new TypeError('virtualize expects a luaparse Chunk AST.');
  const program = new Program(random, options, dialect);
  const main = new FunctionCompiler(program, null, ast);
  main.block(ast.body);
  main.emit('RETURN0');
  const code = emitRuntime(program, main);
  return {
    code,
    passes: ['lexical-cell-compilation', 'encrypted-constant-pool', 'register-vm', 'randomized-opcodes', 'masked-operands', 'shuffled-control-flow',
      ...(options.opaquePredicates !== false ? ['opaque-state-predicates'] : []),
      ...(options.lazyStrings !== false ? ['lazy-constant-cache'] : []),
      ...(program.iteratorGuards ? ['luau-function-iterator-check'] : []),
      ...(program.dataFactories ? ['chunked-instruction-data'] : [])],
    stats: {
      vmInstructions: program.instructions,
      vmFunctions: program.prototypes.length,
      vmRegisters: program.prototypes.reduce((sum, prototype) => sum + prototype.registers, 0),
      vmCapturedCells: program.capturedCells,
      vmBranches: program.branches,
      encryptedConstants: program.constants.length,
      encryptedStrings: program.constants.filter(constant => constant.type === 'string').length,
      encryptedNumbers: program.constants.filter(constant => constant.type === 'number').length,
      cachedConstants: options.lazyStrings !== false,
      iteratorGuards: program.iteratorGuards,
      vmDataFactories: program.dataFactories,
      opcodeVariants: OPS.length,
    },
    warnings: ['The generated VM requires the standard base, string, table, and coroutine libraries.',
      ...(program.iteratorGuards ? ['Luau VM generic loops require function iterators; dynamic table or userdata iterators raise a clear runtime error.'] : [])],
  };
}
