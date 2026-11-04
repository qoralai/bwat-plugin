// Loaded with `node --import` ahead of the bundle in tests only: sends the bundle's Google token
// requests to the fake at BWAT_TEST_GOOGLE_TOKEN_URL, so the shipped code keeps Google's real URL.
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const real = globalThis.fetch;
globalThis.fetch = (input, init) =>
  real(String(input) === GOOGLE_TOKEN_URL ? process.env.BWAT_TEST_GOOGLE_TOKEN_URL : input, init);
