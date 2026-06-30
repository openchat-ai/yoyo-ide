'use strict';

const tir = require('../tir/index.js');

function compileX64(src, opts) {
  const yoyo = require('../yoyo.js');
  return yoyo.compile(src, { ...opts, backend: 'x64' });
}

const backends = {
  x64: {
    id: 'x64',
    description: 'Direct x64 meta-emitter (default bootstrap path)',
    compile: compileX64,
  },
  tir: {
    id: 'tir',
    description: 'TIR lowering stub (vertical slice — still emits via x64)',
    compile(src, opts) {
      const { parse, analyze } = require('../yoyo.js');
      const mod = tir.lowerProgram(analyze(parse(src)));
      if (opts && opts.verbose) {
        console.error('[tir] lowered functions:', mod.functions.length);
      }
      return compileX64(src, opts);
    },
  },
};

function resolveBackend(name) {
  const id = (name || 'x64').toLowerCase();
  const backend = backends[id];
  if (!backend) {
    throw new Error('Unknown backend: ' + id + ' (available: ' + Object.keys(backends).join(', ') + ')');
  }
  return backend;
}

module.exports = { backends, resolveBackend };
