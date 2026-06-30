'use strict';

/**
 * TIR → x64 backend (Phase 2 — partial).
 * Lowers verified TIR to ELF via tir-emit-linux.js.
 */
const { verifyModule } = require('../tir/verify.js');
const { emitModule } = require('./tir-emit-linux.js');

function compile(_src, opts, mod) {
  const v = verifyModule(mod);
  if (!v.ok) {
    throw new Error('TIR verify failed:\n' + v.errors.join('\n'));
  }
  if (opts && opts.verbose) {
    console.error('[tir-x64] handlers:', mod.meta?.handlerCount, 'fixups:', mod.meta?.fixupCount);
  }
  return emitModule(mod, opts);
}

module.exports = { compile };
