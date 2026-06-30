'use strict';

const { createModule, createFunction } = require('./module.js');
const { lowerProgram } = require('./lower.js');

module.exports = {
  createModule,
  createFunction,
  lowerProgram,
};
