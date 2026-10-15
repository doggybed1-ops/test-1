import luaparse from 'luaparse';

export class CompilerError extends Error {
  constructor(code, message, node) { super(message); this.code = code; this.line = node?.loc?.start?.line; this.column = node?.loc?.start?.column; }
}
export const DIALECTS = {
  lua51: { label:'Lua 5.1', parser:'5.1', scope:'Lua 5.1 syntax, documented exclusions' },
  lua52: { label:'Lua 5.2', parser:'5.2', scope:'Lua 5.1 common subset; no goto or lexical _ENV' },
  lua53: { label:'Lua 5.3', parser:'5.3', scope:'Lua 5.1 common subset; no integer division or bitwise operators' },
  lua54: { label:'Lua 5.4', parser:'5.3', scope:'Lua 5.1 common subset; no variable attributes or version extensions' },
  luau: { label:'Roblox Luau', parser:'5.1', scope:'Lua 5.1 common subset only; no types, continue, interpolation, or compound assignment' },
};
export function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'comments' || key === 'globals') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, fn);
    else if (value && typeof value === 'object') walk(value, fn);
  }
}
export function parse(source, dialect='lua51') {
  if (typeof dialect!=='string'||!Object.hasOwn(DIALECTS,dialect)) throw new CompilerError('INVALID_DIALECT', 'Select a supported compatibility profile.');
  const settings = DIALECTS[dialect];
  let ast;
  try { ast = luaparse.parse(source, {luaVersion:settings.parser, locations:true, ranges:true, scope:true, comments:true, encodingMode:'pseudo-latin1'}); }
  catch (error) {
    const suffix = dialect === 'luau' ? ' Luau-specific syntax is outside the implemented Lua 5.1 subset.' : '';
    const result = new CompilerError('SYNTAX_ERROR', `${error.message}${suffix}`);
    result.line = error.line; result.column = error.column; throw result;
  }
  return ast;
}

export function validateSyntax(source,dialect='lua51') {
  // Output includes large nested data tables. Validate the complete grammar,
  // but release completed table contents instead of retaining a second huge AST.
  // Parser syntax checks use node kinds, not constructed table field arrays.
  luaparse.parse(source,{luaVersion:DIALECTS[dialect].parser,comments:false,scope:false,locations:false,ranges:false,encodingMode:'none',
    onCreateNode(node){if(node.type==='TableConstructorExpression')node.fields=[];}});
}

// luaparse discards grouping syntax. Recover grouping for multivalue expressions
// from lexer tokens, distinguishing call parentheses from grouping parentheses.
export function annotateParentheses(ast, source, dialect) {
  const lexer = luaparse.parse(source, { wait:true, luaVersion:DIALECTS[dialect].parser, encodingMode:'pseudo-latin1', comments:false });
  const tokens = [];
  for (;;) { const token=lexer.lex(); if(token.type===luaparse.tokenTypes.EOF) break; tokens.push(token); }
  const stack=[], groups=new Set();
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i], previous=tokens[i-1];
    if(token.value==='(') {
      const call=previous && (previous.type===luaparse.tokenTypes.Identifier || [')',']','end'].includes(previous.value));
      stack.push({i,group:!call});
    } else if(token.value===')') {
      const open=stack.pop();
      if(open?.group && i>open.i+1) groups.add(`${tokens[open.i+1].range[0]}:${tokens[i-1].range[1]}`);
    }
  }
  walk(ast,node=>{ if(node.range && groups.has(`${node.range[0]}:${node.range[1]}`)) node.parenthesized=true; });
}

export function validateSupported(ast, profile, dialect='lua51') {
  let nodes=0;
  walk(ast, node=>{
    if (++nodes > 120000) throw new CompilerError('PROGRAM_TOO_COMPLEX', 'AST exceeds the 120,000-node compilation limit.', node);
    if (['GotoStatement','LabelStatement'].includes(node.type)) throw new CompilerError('UNSUPPORTED_FEATURE','goto and labels are not implemented.',node);
    if (['BinaryExpression','UnaryExpression'].includes(node.type) && ['//','&','|','~','<<','>>'].includes(node.operator)) throw new CompilerError('UNSUPPORTED_FEATURE',`Operator ${node.operator} is outside the implemented common subset.`,node);
    if (node.type==='Identifier' && ['_ENV','getfenv','setfenv','debug','module'].includes(node.name)) throw new CompilerError('UNSUPPORTED_FEATURE',`Environment mutation and stack introspection (${node.name}) cannot be safely transformed.`,node);
    if (node.type==='MemberExpression'&&node.base.type==='Identifier'&&node.base.name==='string'&&node.identifier.name==='dump') throw new CompilerError('UNSUPPORTED_FEATURE','Function bytecode reflection (string.dump) changes under obfuscation.',node);
    if (profile==='maximum'&&node.type==='Identifier'&&node.name==='collectgarbage') throw new CompilerError('UNSUPPORTED_FEATURE','Explicit garbage-collection behavior is outside VM equivalence: virtual registers retain references.',node);
    if (profile==='maximum'&&((node.type==='TableKeyString'&&['__mode','__close','__iter'].includes(node.key.name))||(node.type==='StringLiteral'&&['__mode','__close','__iter'].includes(node.value)))) throw new CompilerError('UNSUPPORTED_FEATURE','Weak/closing metatables and Luau generalized iteration are outside VM equivalence.',node);
    if (dialect==='lua51'&&node.type==='FunctionDeclaration'&&node.parameters.some(parameter=>parameter.type==='VarargLiteral')) {
      walk(node,child=>{if(child.type==='Identifier'&&child.name==='arg')throw new CompilerError('UNSUPPORTED_FEATURE','Legacy Lua 5.1 implicit arg bindings are unsupported; use select and explicit varargs.',child);});
    }
  });
  return nodes;
}
