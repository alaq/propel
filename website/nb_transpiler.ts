/*!
   Copyright 2018 Propel http://propel.site/.  All rights reserved.
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */
import * as acorn from "acorn/dist/acorn";
import * as walk from "acorn/dist/walk";
import { assert } from "../src/util";

const importFn = "__import";
const globalVar = "__global";
const parseOptions = { ecmaVersion: 8, allowImportExportEverywhere: true };

function noop() {}

function walkRecursiveWithAncestors(node, state, visitors) {
  const ancestors = [];
  const wrappedVisitors = {};

  for (const nodeType of Object.keys(walk.base)) {
    const visitor = visitors[nodeType] || walk.base[nodeType];
    wrappedVisitors[nodeType] = (node, state, c) => {
      const isNew = node !== ancestors[ancestors.length - 1];
      if (isNew) ancestors.push(node);
      visitor(node, state, c, ancestors);
      if (isNew) ancestors.pop();
    };
  }

  return walk.recursive(node, state, wrappedVisitors);
}

class SourceChar {
  constructor(readonly char: string, readonly pos: number = null,
              readonly file: string = null) {}
}

type Source = SourceChar[];
type SourceLike = string | Source;

function convert(source: SourceLike, file: string = null): Source {
  if (typeof source === "string") {
    source = Array.from(source).map(
      (char, pos) => new SourceChar(char, pos, file));
  }
  return source as Source;
}

class EditNode {
  current: Source;

  constructor(source: SourceLike) {
    this.replace(source);
  }

  prepend(source: SourceLike) {
    this.current = [...convert(source), ...this.current];
  }

  append(source: SourceLike) {
    this.current = [...this.current, ...convert(source)];
  }

  replace(source: SourceLike) {
    this.current = [...convert(source)];
  }

  clear() {
    this.current = [];
  }
}

class SourceEditor {
  private index: EditNode[];

  constructor(source: SourceLike, file: string = null) {
    this.source = convert(source, file);
  }

  get source(): Source {
    let source: Source = [];
    for (let i = 0; i < this.index.length; i++) {
      source = source.concat(this.index[i].current);
    }
    return source;
  }

  set source(source: Source) {
    if (source.length > 0) {
      this.index = source.map(char => new EditNode([char]));
    } else {
      this.index = [new EditNode([])];
    }
  }

  stratify() {
    const source = this.source;
    this.source = source;
    return this.text();
  }

  text(): string {
    return this.source.map(char => char.char).join("");
  }

  first(): EditNode {
    return this.index[0];
  }

  last(): EditNode {
    return this.index[this.index.length - 1];
  }

  replace(start, end, str) {
    this.index[start].replace(str);

    for (let i = start + 1; i < end; i++) {
      this.index[i].clear();
    }
  }

  prepend({ start }, str) {
    this.index[start].prepend(str);
  }

  append({ end }, str) {
    this.index[end - 1].append(str);
  }
}

/* tslint:disable:object-literal-sort-keys*/

const importVisitors = {
  ImportDeclaration(node, state, c) {
    const spec = node.specifiers;
    const src = node.source;

    if (spec.length) {
      let cur = spec[0];
      state.edit.replace(node.start, cur.start, "var {");
      for (let i = 1; i < spec.length; i++) {
        state.edit.replace(cur.end, spec[i].start, ",");
        cur = spec[i];
      }
      state.edit.replace(cur.end, src.start, `} = {_:await ${importFn}(`);
      state.edit.replace(src.end, node.end, ")};");
    } else {
      state.edit.replace(node.start, src.start, `await ${importFn}(`);
      state.edit.replace(src.end, node.end, ");");
    }

    walk.base.ImportDeclaration(node, state, c);
  },

  ImportSpecifier(node, state, c) {
    state.edit.prepend(node, "_:{");
    if (node.local.start > node.imported.end) {
      state.edit.replace(node.imported.end, node.local.start, ":");
    }
    state.edit.append(node, "}");
    walk.base.ImportSpecifier(node, state, c);
  },

  ImportDefaultSpecifier(node, state, c) {
    state.edit.prepend(node.local, "_:{default:");
    state.edit.append(node.local, "}");
    walk.base.ImportDefaultSpecifier(node, state, c);
  },

  ImportNamespaceSpecifier(node, state, c) {
    state.edit.replace(node.start, node.local.start, "_:");
    walk.base.ImportNamespaceSpecifier(node, state, c);
  },

  // Do not recurse into functions etc.
  FunctionDeclaration: noop,
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

const evalScopeVisitors = {
  // Turn function and class declarations into expressions that assign to
  // the global object. Do not recurse into function bodies.
  ClassDeclaration(node, state, c, ancestors) {
    walk.base.ClassDeclaration(node, state, c);

    // Classes are block-scoped, so don't do any transforms if the class
    // definition isn't at top-level.
    assert(ancestors.length >= 2);
    if (ancestors[ancestors.length - 2] !== state.body) {
      return;
    }

    state.edit.prepend(node, `${globalVar}.${node.id.name}=`);
    state.edit.append(node, `);`);
  },

  FunctionDeclaration(node, state, c) {
    state.edit.prepend(node, `void (${globalVar}.${node.id.name}=`);
    state.edit.append(node, `);`);
    // Don't do any translation inside the function body, therefore there's no
    // `walk.base.FunctionDeclaration()` call here.
  },

  VariableDeclaration(node, state, c, ancestors) {
    // Turn variable declarations into assignments to the global object.
    // TODO: properly hoist `var` declarations -- that is, insert
    // `global.varname = undefined` at the very top of the block.

    // Translate all `var` declarations as they are function-scoped.
    // `let` and `const` are only translated when they appear in the top level
    // block. Note that since we don't walk into function bodies, declarations
    // inside them are never translated.
    assert(ancestors.length >= 2);
    const translateDecl =
      node.kind === "var" || ancestors[ancestors.length - 2] === state.body;

    state.translatingVariableDeclaration = translateDecl;
    walk.base.VariableDeclaration(node, state, c);
    state.translatingVariableDeclaration = false;

    if (!translateDecl) {
      return;
    }

    state.edit.replace(node.start, node.start + node.kind.length + 1, "void (");

    let decl;
    for (decl of node.declarations) {
      if (decl.init) {
        state.edit.prepend(decl, "(");
        state.edit.append(decl, ")");
      } else {
        // A declaration without an initializer (e.g. `var a;`) turns into
        // an assignment with undefined. Note that for destructuring
        // declarations, an initializer is mandatory, hence it is safe to just
        // assign undefined here.
        // TODO: if the declaration kind is 'var', this should probably be
        // hoisted, as this is perfectly legal javascript :/
        //   function() {
        //     console.log(foo);
        //     foo = 4;
        //     var foo;
        //   }
        state.edit.prepend(decl, "(");
        state.edit.append(decl, "= undefined)");
      }
    }

    // Insert after `decl` rather than node, otherwise the closing bracket
    // might end up wrapping a semicolon.
    state.edit.append(decl, ")");
  },

  VariableDeclarator(node, state, c) {
    walk.base.VariableDeclarator(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    if (node.id.type === "Identifier") {
      state.edit.prepend(node.id, `${globalVar}` + ".");
    }
  },

  ObjectPattern(node, state, c) {
    walk.base.ObjectPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const p of node.properties) {
      if (p.shorthand) {
        state.edit.append(p.value, `:${globalVar}.${p.value.name}`);
      } else if (p.value.type === "Identifier") {
        state.edit.prepend(p.value, `${globalVar}.`);
      }
    }
  },

  ArrayPattern(node, state, c) {
    walk.base.ArrayPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const e of node.elements) {
      if (e.type === "Identifier") {
        state.edit.prepend(e, `${globalVar}.`);
      }
    }
  },

  // Don't do any translation inside function (etc.) bodies.
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

/* tslint:enable:object-literal-sort-keys*/

function parseAsyncWrapped(src) {
  console.log(" source : ", src);
  // Parse javascript code which has been wrapped in an async function
  // expression, then find function body node.
  const root = acorn.parse(src, parseOptions);
  const fnExpr = root.body[0].expression;
  assert(fnExpr.type === "ArrowFunctionExpression");
  const body = fnExpr.body;
  return { body, root };
}

// Transpiles a repl cell into an async function expression.
// The returning string has the form:
//   (async (global, import) => {
//     ... cell statements
//     return last_expression_result;
//   })
export function transpile(src: string): string {
  let body, edit, root;

  // Wrap code in async function.
  src = `(async (${globalVar}, ${importFn}, console) => {\n${src}\n})`;

  // Translate imports into async imports.
  edit = new SourceEditor(src);
  ({ body, root } = parseAsyncWrapped(src));
  walk.recursive(body, { edit }, importVisitors);

  src = edit.stratify();

  // Translate variable declarations into global assignments.
  ({ body, root } = parseAsyncWrapped(src));
  walkRecursiveWithAncestors(
    body,
    {
      body,
      edit,
      translatingVariableDeclaration: false
    },
    evalScopeVisitors
  );

  // If the last statement is an expression, turn it into a return statement.
  if (body.body.length > 0) {
    const last = body.body[body.body.length - 1];
    if (last.type === "ExpressionStatement") {
      edit.prepend(last, "return (");
      edit.append(last.expression, ")");
    }
  }

  src = edit.text();

  return src;
}
