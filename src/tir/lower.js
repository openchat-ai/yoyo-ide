'use strict';

const { createModule, createFunction } = require('./module.js');

/**
 * Vertical-slice stub: accept parsed yoyo program shape and return an empty TIR shell.
 * Real lowering will map handlers / opcodes incrementally.
 */
function lowerProgram(prog) {
  const mod = createModule('yoyo');
  const handlers = prog.handlers || {};
  for (const key of Object.keys(handlers).map(Number).sort((a, b) => a - b)) {
    mod.functions.push(createFunction('H' + key));
  }
  return mod;
}

module.exports = { lowerProgram };
