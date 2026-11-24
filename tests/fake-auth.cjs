// Atrapa weryfikacji użytkownika dla testów czatu, narzędzi i bazy wiedzy.
// Podstawia moduł lib/supabase-server.ts, więc te testy nie łączą się z Supabase Auth.
// Prawdziwą weryfikację tokenu (getClaims) sprawdza tests/auth.test.cjs.
// Wywołaj installFakeAuth() po rejestracji ładowania plików .ts i przed require handlerów.
const TEST_USER = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  email: "test@example.com",
  sessionId: "22222222-2222-4222-8222-222222222222",
});
const TEST_AUTH_COOKIE = "sb-test-auth-token=valid";
const state = { stillSignedIn: true };

function signedIn(request) {
  const cookies = (request.headers.get("cookie") ?? "").split(/;\s*/);
  return cookies.includes(TEST_AUTH_COOKIE);
}

function installFakeAuth() {
  const file = require.resolve("../lib/supabase-server.ts");
  const user = { ...TEST_USER, stillSignedIn: async () => state.stillSignedIn };
  require.cache[file] = {
    id: file, filename: file, loaded: true, children: [], paths: [],
    exports: {
      requestUser: async (request) => (signedIn(request) ? user : null),
      currentUser: async () => null,
      createRouteClient: async () => null,
    },
  };
}

module.exports = { installFakeAuth, TEST_USER, TEST_AUTH_COOKIE, fakeAuthState: state };
