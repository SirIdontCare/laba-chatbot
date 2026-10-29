# Mój chatbot — LABA

Next.js App Router z TypeScript. Czat korzysta z serwerowego `/api/chat`, OpenRouter i strumieniowych odpowiedzi AI SDK. Historia jest przechowywana tylko w bieżącej karcie; odświeżenie strony ją usuwa.

## Konfiguracja lokalna

W folderze projektu, obok `package.json`, utwórz plik `.env.local`. Jeśli już istnieje, uzupełnij tylko te dwie zmienne, zachowując pozostałą zawartość:

```dotenv
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
```

Po pierwszym `=` wpisz swój klucz OpenRouter. Po drugim wpisz dokładny identyfikator modelu skopiowany z [listy modeli OpenRouter](https://openrouter.ai/models), w formacie `dostawca/model`. Wartości podajesz wyłącznie w lokalnym pliku, nie w rozmowie. Nie dodawaj prefiksu `NEXT_PUBLIC_`.

Zapisz plik. Jeśli serwer działał podczas zmiany konfiguracji, uruchom go ponownie: zakończ go przez `Ctrl+C`, a następnie wpisz w terminalu:

```powershell
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
```

Otwórz [http://127.0.0.1:3000](http://127.0.0.1:3000). Pierwszą prawdziwą wiadomość wysyła użytkownik w przeglądarce. Wybrany model może naliczać opłaty zgodnie z cennikiem OpenRouter.

`.env` i `.env.local` są ignorowane przez Git. `.env.example` zawiera wyłącznie puste pola. Klucz odczytuje tylko serwerowy endpoint. Brak wartości powoduje czytelny komunikat; aplikacja nie generuje zastępczej odpowiedzi.

## Wersje i sprawdzenie

- `ai`: 7.0.157
- `@ai-sdk/react`: 4.0.161 (zależność od `ai` 7.0.157)
- `@openrouter/ai-sdk-provider`: 3.1.0 (wymaga `ai` ^7.0.0 i Node.js >=22)
- `zod`: 4.1.8 (zgodne wymagania obu pakietów)

Wersje są przypięte w `package.json` i zapisane w zachowanym `package-lock.json`. Zgodność sprawdzono w [oficjalnej dokumentacji OpenRouter](https://github.com/OpenRouterTeam/ai-sdk-provider#setup-for-ai-sdk-v7), [przykładzie czatu AI SDK 7](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot) oraz metadanych zainstalowanych pakietów.

W AI SDK 7 serwer używa `streamText` → `toUIMessageStream` → `createUIMessageStreamResponse`, a klient `useChat` z `DefaultChatTransport`. Transport wysyła całą historię; serwer przekształca ją przez `convertToModelMessages`.

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Test lokalny z zastąpionym połączeniem sieciowym potwierdził strumieniowe fragmenty, przekazywanie historii, odrzucanie pustych wiadomości, brak konfiguracji i bezpieczny błąd dostawcy. Nie wykonano prawdziwych wywołań OpenRouter.

## Hasło warsztatowe

W `.env.local` dodaj `CHAT_PASSWORD=` i wpisz po znaku `=` własne, długie hasło warsztatowe. Dla wartości zawierających `#` lub spacje użyj cudzysłowów, np. `CHAT_PASSWORD="twoje hasło"`. Nie umieszczaj hasła w kodzie ani w rozmowie. Zachowaj pozostałe zmienne.

`SESSION_SECRET` został wygenerowany kryptograficznie (32 losowe bajty) i dopisany do `.env.local` bez odczytywania istniejących sekretów i bez wyświetlania wartości. Nie zastępuj go hasłem. Aby świadomie wygenerować nowy sekret i unieważnić dotychczasowe sesje, uruchom:

```powershell
npm.cmd run session:secret
```

Skrypt dopisuje nową linię `SESSION_SECRET` bez czytania pliku; ostatnia definicja tej zmiennej obowiązuje po ponownym uruchomieniu Next.js. Hasło i sekret konfiguruj wyłącznie na serwerze, bez prefiksu `NEXT_PUBLIC_`. Po zmianach zrestartuj serwer.

Przed czatem pojawia się „Wpisz hasło”. Poprawne hasło tworzy podpisany JWT ważny 8 godzin. Cookie zawiera wyłącznie standardowe dane sesji, nie hasło. Ma `HttpOnly`, `SameSite=Strict`, `Path=/`, termin ważności i `Secure` w produkcji. W produkcji nazwa ma prefiks `__Host-`, a strona wymaga HTTPS. Zmiana hasła albo sekretu unieważnia poprzednie sesje. Brak lub zbyt krótki sekret (mniej niż 32 bajty) blokuje dostęp.

`Wyjdź` przerywa odbieranie odpowiedzi, usuwa cookie i rozmowę w tej karcie oraz wraca do ekranu hasła. To sesje bez bazy danych: wylogowanie usuwa cookie z przeglądarki, nie prowadzi listy unieważnionych kopii tokenów. Skopiowany token pozostaje ważny do wygaśnięcia lub zmiany sekretu/hasła.

Serwer sprawdza podpis i wygaśnięcie również w `/api/chat`, zanim odczyta konfigurację OpenRouter lub uruchomi model. Bez prawidłowej sesji zwraca `401`. Logowanie, wylogowanie i czat odrzucają żądania pochodzące z obcej strony.

## Ograniczanie prób hasła

Lokalnie działa limit **5 prób na minutę dla całego procesu**, także dla poprawnego hasła; szósta próba zwraca `429`. Restart procesu zeruje ten licznik. To pomoc do pracy lokalnej, nie globalna ochrona hostingu.

Produkcja nie korzysta z tego licznika. Na Vercel używa usługi `@vercel/firewall` i reguły o identyfikatorze **`workshop-login`**. Wspólny klucz ogranicza łączną liczbę prób, a liczniki są współdzielone między instancjami w regionie Vercel; nie jest to jeden licznik dla wszystkich regionów świata. Brak reguły, awaria usługi, brak systemowych zmiennych `VERCEL`/`VERCEL_PROJECT_PRODUCTION_URL` lub hosting poza Vercel blokują logowanie (`503`). Publiczny adres produkcyjny w domenie `vercel.app` dostarcza automatycznie Vercel. Nie używamy technicznego `VERCEL_URL`, który może przekierowywać do logowania Vercel zamiast odpowiadać na sprawdzenie limitu.

Przed udostępnieniem na Vercel skonfiguruj regułę zgodnie z [oficjalną instrukcją Rate Limiting SDK](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk): w projekcie otwórz Firewall → Configure → New Rule, wybierz warunek `@vercel/firewall` i Rate limit ID `workshop-login`. Ustaw limit **5 żądań / 60 sekund**, z akcją blokującą po przekroczeniu limitu (odpowiedź `429`, nie tryb `log`). Reguła musi być aktywna dla wywołań przez publiczny adres `VERCEL_PROJECT_PRODUCTION_URL`. Zapisz i opublikuj regułę po przeglądzie konfiguracji. Nie dodawaj warunku ścieżki `/api/auth/login` do reguły SDK: sprawdzanie limitu trafia pod `/.well-known/vercel/rate-limit-api/workshop-login`.

Projekt `laba-super-agent` ma opublikowaną regułę `Workshop login limit` dla identyfikatora `workshop-login`. Na preview wykonaj test sześciu prób i potwierdź blokadę; lokalne testy automatyczne sprawdzają również brak reguły i awarię usługi. Preview i produkcja korzystają ze wspólnego limitu przez adres produkcyjny. Na innym hostingu najpierw trzeba podłączyć usługę współdzielonych limitów, nie włączać lokalnego licznika w produkcji.

## Sprawdzenie ochrony

```powershell
npm.cmd run test:auth
npm.cmd run typecheck
npm.cmd run build
```

Testy używają własnych, fikcyjnych wartości w procesie testowym, bez czytania `.env.local`. Sieć jest zastąpiona atrapą, więc nie ma wywołań modelu. Sprawdzają poprawne i błędne hasło, atrybuty cookie, wygaśnięcie, zmianę hasła, usunięcie cookie przy wyjściu, `401` dla `/api/chat` bez sesji, obce źródło żądania, limit lokalny i blokowanie dostępu przy braku/awarii usługi limitującej w produkcji.

Po ustawieniu własnego `CHAT_PASSWORD` ręcznie sprawdź w przeglądarce: ekran hasła, odmowę po błędnym haśle, wejście po poprawnym, wyjście i powrót do ekranu hasła po odświeżeniu. Samo logowanie i wyjście nie wywołują modelu. Nie testowano wyglądu w przeglądarce ani prawdziwego Vercel Firewall; test produkcji używa atrap odpowiedzi usługi.
