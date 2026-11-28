"use strict";

const js = require("@eslint/js");

const sharedGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  __dirname: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly"
};

module.exports = [
  js.configs.recommended,
  {
    files: ["index.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: sharedGlobals
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none" }]
    }
  },
  {
    files: ["lib/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: sharedGlobals
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none" }]
    }
  }
];
