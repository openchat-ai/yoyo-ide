'use strict';

/**
 * TIR → x64 backend skeleton (Phase 2).
 * Emits nothing yet; validates module and reports codegen readiness.
 */
const { verifyModule } = require('../tir/verify.js');

function compile(_src, opts, mod) {
  const v = verifyModule(mod);
  if (!v.ok) {
    throw new Error('TIR verify failed:\n' + v.errors.join('\n'));
  }
  if (opts && opts.verbose) {
    console.error('[tir-x64] handlers:', mod.meta?.handlerCount, 'fixups:', mod.meta?.fixupCount);
    console.error('[tir-x64] codegen not implemented — use --backend=x64 for ELF output');
  }
  throw new Error('backend tir-x64: codegen not implemented (Phase 2). Use --backend=x64');
}

module.exports = { compile };
