// MUST be the first import of the server entry point.
// gramjs (and any future dependency) may write to console.log; on a stdio MCP
// transport that corrupts the protocol stream. ESM hoists imports above module
// body statements, so the redirect has to live in its own module that is
// imported before anything that could log.
console.log = (...args: unknown[]): void => {
  console.error(...args);
};
