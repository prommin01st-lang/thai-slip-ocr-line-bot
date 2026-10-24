// All tests are offline by default, including inherited developer credentials.
globalThis.fetch = async () => {
  throw new Error("Network disabled in tests; install an explicit mock");
};
