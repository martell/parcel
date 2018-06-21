const Packager = require('./Packager');
const path = require('path');
const fs = require('fs');
const concat = require('../scope-hoisting/concat');
const urlJoin = require('../utils/urlJoin');
const walk = require('babylon-walk');
const babylon = require('babylon');
const t = require('babel-types');

const prelude = {};
const preludePath = path.join(__dirname, '../builtins/prelude2.js');
prelude.minified = prelude.source = fs.readFileSync(preludePath, 'utf8').trim();
const preludeMinPath = path.join(__dirname, '../builtins/prelude2.min.js');
if (fs.existsSync(preludeMinPath)) {
  prelude.minified = fs
    .readFileSync(preludeMinPath, 'utf8')
    .trim()
    .replace(/;$/, '');
}

const helpers = {};
const helpersPath = path.join(__dirname, '../builtins/helpers.js');
helpers.minified = helpers.source = fs.readFileSync(helpersPath, 'utf8').trim();
const helpersMinPath = path.join(__dirname, '../builtins/helpers.min.js');
if (fs.existsSync(helpersMinPath)) {
  helpers.minified = fs
    .readFileSync(helpersMinPath, 'utf8')
    .trim()
    .replace(/;$/, '');
}

class JSConcatPackager extends Packager {
  async start() {
    this.addedAssets = new Set();
    this.exposedModules = new Set();
    this.externalModules = new Set();
    this.size = 0;
    this.needsPrelude = false;
    this.statements = [];
    this.assetPostludes = new Map();

    for (let asset of this.bundle.assets) {
      // If this module is referenced by another JS bundle, it needs to be exposed externally.
      let isExposed = !Array.from(asset.parentDeps).every(dep => {
        let depAsset = this.bundler.loadedAssets.get(dep.parent);
        return this.bundle.assets.has(depAsset) || depAsset.type !== 'js';
      });

      if (
        isExposed ||
        (this.bundle.entryAsset === asset &&
          this.bundle.parentBundle &&
          this.bundle.parentBundle.childBundles.size !== 1)
      ) {
        this.exposedModules.add(asset);
        this.needsPrelude = true;
      }

      for (let mod of asset.depAssets.values()) {
        if (
          !this.bundle.assets.has(mod) &&
          this.options.bundleLoaders[asset.type]
        ) {
          this.needsPrelude = true;
          break;
        }
      }
    }

    if (this.bundle.entryAsset) {
      this.markUsedExports(this.bundle.entryAsset);
    }

    if (this.needsPrelude) {
      if (
        this.bundle.entryAsset &&
        this.options.bundleLoaders[this.bundle.entryAsset.type]
      ) {
        this.exposedModules.add(this.bundle.entryAsset);
      }
    }

    this.write(helpers);
  }

  write(string) {
    this.statements.push(...this.parse(string));
  }

  getSize() {
    return this.size;
  }

  markUsedExports(asset) {
    if (asset.usedExports) {
      return;
    }

    asset.usedExports = new Set();

    for (let identifier in asset.cacheData.imports) {
      let [source, name] = asset.cacheData.imports[identifier];
      let dep = asset.depAssets.get(asset.dependencies.get(source));
      this.markUsed(dep, name);
    }
  }

  markUsed(mod, id) {
    let exp = mod.cacheData.exports[id];
    if (Array.isArray(exp)) {
      let depMod = mod.depAssets.get(mod.dependencies.get(exp[0]));
      return this.markUsed(depMod, exp[1]);
    }

    this.markUsedExports(mod);
    mod.usedExports.add(id);
  }

  getExportIdentifier(asset) {
    let id = '$' + asset.id + '$exports';
    if (this.shouldWrap(asset)) {
      return `($${asset.id}$init(), ${id})`;
    }

    return id;
  }

  async addAsset(asset) {
    if (this.addedAssets.has(asset)) {
      return;
    }
    this.addedAssets.add(asset);
    let {js} = asset.generated;

    // If the asset's package has the sideEffects: false flag set, and there are no used
    // exports marked, exclude the asset from the bundle.
    if (
      asset.cacheData.sideEffects === false &&
      (!asset.usedExports || asset.usedExports.size === 0)
    ) {
      return;
    }

    for (let [dep, mod] of asset.depAssets) {
      if (dep.dynamic && this.bundle.childBundles.has(mod.parentBundle)) {
        for (let child of mod.parentBundle.siblingBundles) {
          if (!child.isEmpty) {
            await this.addBundleLoader(child.type, asset);
          }
        }

        await this.addBundleLoader(mod.type, asset, true);
      } else {
        // If the dep isn't in this bundle, add it to the list of external modules to preload.
        // Only do this if this is the root JS bundle, otherwise they will have already been
        // loaded in parallel with this bundle as part of a dynamic import.
        if (
          !this.bundle.assets.has(mod) &&
          (!this.bundle.parentBundle ||
            this.bundle.parentBundle.type !== 'js') &&
          this.options.bundleLoaders[mod.type]
        ) {
          this.externalModules.add(mod);
          await this.addBundleLoader(mod.type, asset);
        }
      }
    }

    // if (this.bundle.entryAsset === asset && this.externalModules.size > 0) {
    //   js = `
    //     function $parcel$entry() {
    //       ${js.trim()}
    //     }
    //   `;
    // }

    // js = js.trim() + '\n';
    this.size += js.length;
  }

  shouldWrap(asset) {
    if (!asset) {
      return false;
    }

    if (asset.cacheData.shouldWrap != null) {
      return asset.cacheData.shouldWrap;
    }

    // Set to false initially so circular deps work
    asset.cacheData.shouldWrap = false;

    // We need to wrap if any of the deps are marked by the hoister, e.g.
    // when the dep is required inside a function or conditional.
    // We also need to wrap if any of the parents are wrapped - transitive requires
    // shouldn't be evaluated until their parents are.
    let shouldWrap = [...asset.parentDeps].some(
      dep =>
        dep.shouldWrap ||
        this.shouldWrap(this.bundler.loadedAssets.get(dep.parent))
    );

    asset.cacheData.shouldWrap = shouldWrap;
    return shouldWrap;
  }

  addDeps(asset, included) {
    if (!this.bundle.assets.has(asset) || included.has(asset)) {
      return [];
    }

    included.add(asset);

    let depAsts = new Map();
    for (let depAsset of asset.depAssets.values()) {
      let depAst = this.addDeps(depAsset, included);
      depAsts.set(depAsset, depAst);
    }

    let statements;
    if (
      asset.cacheData.sideEffects === false &&
      (!asset.usedExports || asset.usedExports.size === 0)
    ) {
      statements = [];
    } else {
      statements = this.parse(asset.generated.js, asset.name);
    }

    if (this.shouldWrap(asset)) {
      statements = this.wrapModule(asset, statements);
    }

    if (statements[0]) {
      if (!statements[0].leadingComments) {
        statements[0].leadingComments = [];
      }
      statements[0].leadingComments.push({
        type: 'CommentLine',
        value: ` ASSET: ${path.relative(this.options.rootDir, asset.name)}`
      });
    }

    let statementIndices = new Map();
    for (let i = 0; i < statements.length; i++) {
      let statement = statements[i];
      if (t.isExpressionStatement(statement)) {
        for (let depAsset of this.findRequires(asset, statement)) {
          if (!statementIndices.has(depAsset)) {
            statementIndices.set(depAsset, i);
          }
        }
      }
    }

    let reverseDeps = [...asset.depAssets.values()].reverse();
    for (let dep of reverseDeps) {
      let index = statementIndices.has(dep) ? statementIndices.get(dep) : 0;
      statements.splice(index, 0, ...depAsts.get(dep));
    }

    if (this.assetPostludes.has(asset)) {
      statements.push(...this.parse(this.assetPostludes.get(asset)));
    }

    return statements;
  }

  wrapModule(asset, statements) {
    let body = [];
    let decls = [];
    let fns = [];
    for (let node of statements) {
      // Hoist all declarations out of the function wrapper
      // so that they can be referenced by other modules directly.
      if (t.isVariableDeclaration(node)) {
        for (let decl of node.declarations) {
          decls.push(t.variableDeclarator(decl.id));
          if (decl.init) {
            body.push(
              t.expressionStatement(
                t.assignmentExpression(
                  '=',
                  t.identifier(decl.id.name),
                  decl.init
                )
              )
            );
          }
        }
      } else if (t.isFunctionDeclaration(node)) {
        // Function declarations can be hoisted out of the module initialization function
        fns.push(node);
      } else if (t.isClassDeclaration(node)) {
        // Class declarations are not hoisted. We declare a variable outside the
        // function convert to a class expression assignment.
        decls.push(t.variableDeclarator(t.identifier(node.id.name)));
        body.push(
          t.expressionStatement(
            t.assignmentExpression(
              '=',
              t.identifier(node.id.name),
              t.toExpression(node)
            )
          )
        );
      } else {
        body.push(node);
      }
    }

    let executed = `$${asset.id}$executed`;
    decls.push(
      t.variableDeclarator(t.identifier(executed), t.booleanLiteral(false))
    );

    let init = t.functionDeclaration(
      t.identifier(`$${asset.id}$init`),
      [],
      t.blockStatement([
        t.ifStatement(t.identifier(executed), t.returnStatement()),
        t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.identifier(executed),
            t.booleanLiteral(true)
          )
        ),
        ...body
      ])
    );

    return [t.variableDeclaration('var', decls), ...fns, init];
  }

  parse(code, filename) {
    let ast = babylon.parse(code, {
      sourceFilename: filename,
      allowReturnOutsideFunction: true
    });

    return ast.program.body;
  }

  findRequires(asset, ast) {
    let result = [];
    walk.simple(ast, {
      CallExpression(node) {
        let {arguments: args, callee} = node;

        if (!t.isIdentifier(callee)) {
          return;
        }

        if (callee.name === '$parcel$require') {
          result.push(
            asset.depAssets.get(asset.dependencies.get(args[1].value))
          );
        }
      }
    });

    return result;
  }

  getBundleSpecifier(bundle) {
    let name = path.basename(bundle.name);
    if (bundle.entryAsset) {
      return [name, bundle.entryAsset.id];
    }

    return name;
  }

  async addAssetToBundle(asset) {
    if (this.bundle.assets.has(asset)) {
      return;
    }
    this.bundle.addAsset(asset);
    if (!asset.parentBundle) {
      asset.parentBundle = this.bundle;
    }

    // Add all dependencies as well
    for (let child of asset.depAssets.values()) {
      await this.addAssetToBundle(child, this.bundle);
    }

    await this.addAsset(asset);
  }

  async addBundleLoader(bundleType, parentAsset, dynamic) {
    let loader = this.options.bundleLoaders[bundleType];
    if (!loader) {
      return;
    }

    let bundleLoader = this.bundler.loadedAssets.get(
      require.resolve('../builtins/bundle-loader')
    );
    if (!bundleLoader && !dynamic) {
      bundleLoader = await this.bundler.getAsset('_bundle_loader');
    }

    if (bundleLoader) {
      // parentAsset.depAssets.set({name: '_bundle_loader'}, bundleLoader);
      await this.addAssetToBundle(bundleLoader);
    } else {
      return;
    }

    let target = this.options.target === 'node' ? 'node' : 'browser';
    let asset = await this.bundler.getAsset(loader[target]);
    if (!this.bundle.assets.has(asset)) {
      let dep = {name: asset.name};
      asset.parentDeps.add(dep);
      parentAsset.dependencies.set(dep.name, dep);
      parentAsset.depAssets.set(dep, asset);
      this.assetPostludes.set(
        asset,
        `${this.getExportIdentifier(bundleLoader)}.register(${JSON.stringify(
          bundleType
        )},${this.getExportIdentifier(asset)});\n`
      );

      await this.addAssetToBundle(asset);
    }
  }

  async end() {
    let included = new Set();
    for (let asset of this.bundle.assets) {
      this.statements.push(...this.addDeps(asset, included));
    }

    // Preload external modules before running entry point if needed
    if (this.externalModules.size > 0) {
      let bundleLoader = this.bundler.loadedAssets.get(
        require.resolve('../builtins/bundle-loader')
      );

      let preload = [];
      for (let mod of this.externalModules) {
        // Find the bundle that has the module as its entry point
        let bundle = Array.from(mod.bundles).find(b => b.entryAsset === mod);
        if (bundle) {
          preload.push([path.basename(bundle.name), mod.id]);
        }
      }

      let loads = `${this.getExportIdentifier(
        bundleLoader
      )}.load(${JSON.stringify(preload)})`;
      if (this.bundle.entryAsset) {
        loads += '.then($parcel$entry)';
      }

      loads += ';';
      this.write(loads);
    }

    let entryExports =
      this.bundle.entryAsset &&
      this.getExportIdentifier(this.bundle.entryAsset);
    if (
      entryExports &&
      this.bundle.entryAsset.generated.js.includes(entryExports)
    ) {
      this.write(`
        if (typeof exports === "object" && typeof module !== "undefined") {
          // CommonJS
          module.exports = ${entryExports};
        } else if (typeof define === "function" && define.amd) {
          // RequireJS
          define(function () {
            return ${entryExports};
          });
        } ${
          this.options.global
            ? `else {
          // <script>
          this[${JSON.stringify(this.options.global)}] = ${entryExports};
        }`
            : ''
        }
      `);
    }

    if (this.needsPrelude) {
      let exposed = [];
      let prepareModule = [];
      for (let m of this.exposedModules) {
        if (m.cacheData.isES6Module) {
          prepareModule.push(
            `${this.getExportIdentifier(m)}.__esModule = true;`
          );
        }

        exposed.push(`${m.id}: ${this.getExportIdentifier(m)}`);
      }

      this.write(`
        ${prepareModule.join('\n')}
        return {${exposed.join(', ')}};
      `);
    }

    let ast = t.file(t.program(this.statements));
    let {code: output} = concat(this, ast);

    if (!this.options.minify) {
      output = '\n' + output + '\n';
    }

    if (this.needsPrelude) {
      output = prelude + '(function (require) {' + output + '});';
    } else {
      output = '(function () {' + output + '})();';
    }

    this.bundle.totalSize = output.length;

    let {sourceMaps} = this.options;
    if (sourceMaps) {
      // Add source map url if a map bundle exists
      let mapBundle = this.bundle.siblingBundlesMap.get('map');
      if (mapBundle) {
        output += `\n//# sourceMappingURL=${urlJoin(
          this.options.publicURL,
          path.basename(mapBundle.name)
        )}`;
      }
    }

    await super.write(output);
  }
}

module.exports = JSConcatPackager;
