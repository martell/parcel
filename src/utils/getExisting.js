const fs = require('fs');
/**
 * Creates an object for source and a minified source
 * e.g. builtins.min.js and builtins.js.
 * If the first argument does not have an extension it will
 * try use min.js and .js with .js as the minified fallback
 */
module.exports = function(minified, source) {
  if(minified.split('.').length < 2 && source === undefined) {
    source = minified + '.js';
    minified = minified + 'min.js';
  }
  var sourceFile = fs.readFileSync(source, 'utf8').trim();
  return {
    source: sourceFile,
    minified: fs.existsSync(minified) ? fs
      .readFileSync(minified, 'utf8')
      .trim()
      .replace(/;$/, '') : sourceFile
  }
};
