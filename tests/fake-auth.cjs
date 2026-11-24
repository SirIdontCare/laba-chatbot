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
// Baza "zalogowanej osoby" w testach: prawdziwy klient supabase-js z tokenem testowym.
// Zapytania trafiają do globalnego fetch, który testy podstawiają.
const USER_DB_URL = "https://user-db.test";
const USER_DB_TOKEN = "test-user-access-token";
const state = { stillSignedIn: true };

function signedIn(request) {
  const cookies = (request.headers.get("cookie") ?? "").split(/;\s*/);
  return cookies.includes(TEST_AUTH_COOKIE);
}

function testUser() {
  const { createClient } = require("@supabase/supabase-js");
  const db = createClient(USER_DB_URL, "sb_publishable_test", { accessToken: async () => USER_DB_TOKEN });
  return { ...TEST_USER, db, stillSignedIn: async () => state.stillSignedIn };
}

function installFakeAuth() {
  const file = require.resolve("../lib/supabase-server.ts");
  const user = testUser();
  require.cache[file] = {
    id: file, filename: file, loaded: true, children: [], paths: [],
    exports: {
      requestUser: async (request) => (signedIn(request) ? user : null),
      currentUser: async () => null,
      createRouteClient: async () => null,
    },
  };
}

module.exports = { installFakeAuth, testUser, TEST_USER, TEST_AUTH_COOKIE, USER_DB_URL, USER_DB_TOKEN, fakeAuthState: state };
