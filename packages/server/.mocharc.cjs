module.exports = {
  spec: ["__tests__/**/*.test.ts"],
  recursive: true,
  extension: ["ts"],
  "node-option": ["import=tsx"],
  file: [
    "__tests__/setup.createDb.ts",
    "__tests__/setup.root.ts",
    "__tests__/setup.eachTest.ts",
  ],
  timeout: 15000,
  slow: 1000,
  reporter: "spec",
  exit: true,
  "fail-zero": true,
};