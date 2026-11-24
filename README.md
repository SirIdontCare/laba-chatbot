# Mój chatbot — LABA

Next.js App Router z TypeScript. Czat i analiza korzystają z serwerowego `/api/agent` oraz OpenRouter i AI SDK. Po odświeżeniu czat wczytuje z Supabase ostatnią rozmowę bieżącej sesji. „Nowa rozmowa” czyści widok i pozostawia wcześniejszą rozmowę w bazie.

`POST /api/agent` najpierw weryfikuje zalogowanego użytkownika (bez niego zwraca 401), a potem tryb:

| Tryb | Dane wejściowe | Wynik |
| --- | --- | --- |
| `chat` | `{ mode: "chat", chatId: "<uuid>", messages: [...] }` | Strumień UI z `streamText`, maks. 18 kroków modelu. Ogólny asystent z ośmioma narzędziami opisanymi poniżej, zachowanym `aktualnyCzas`, wyszukiwaniem i obsługą obrazów. |
| `analyze` | `{ mode: "analyze", message: "..." }` | `{ result: ... }` z `generateText`, `Output.object` i walidacją Zod na serwerze. |

Przycisk „Wygeneruj obraz” wysyła tryb `chat` z `intent: "image"` i wymusza pierwsze wywołanie `generujObraz` (opis do 500 znaków). Obraz i identyfikator modelu z API trafiają do rozmowy jako wynik narzędzia. `toModelOutput` przekazuje modelowi wyłącznie tekst „obraz wygenerowany”, również przy odtwarzaniu historii. Nie ma ponownego wysyłania pliku obrazu do modelu.

Instrukcje Studio Nova i format szkicu dotyczą wyłącznie `analyze`. Czat wykonuje zadania ogólne. Przy zadaniu z logo wyszukuje źródło, przekazuje znaleziony bezpośredni URL PNG/JPG/WebP do `obejrzyjObraz`, opisuje widoczny obraz, a potem może użyć tego samego URL w `referenceImageUrls` narzędzia generowania. Adres referencji bez wcześniejszego przekazania do vision jest odrzucany. Obraz referencyjny przekazywany jest dostawcy vision i generatorowi; serwer aplikacji nie pobiera tych adresów. Gdy dostępna jest tylko strona HTML, SVG lub niedziałający adres, asystent ma zgłosić ograniczenie i poprosić o odpowiedni plik lub URL.

Pełny zestaw testów agenta: `npm run test:agent`. Testy zastępują połączenia z modelami atrapami. Obejmują oba tryby, autoryzację, narzędzia, zdjęcia i oddzielenie obrazu dla UI od krótkiego wyniku dla modelu.

## Konfiguracja lokalna

W folderze projektu, obok `package.json`, utwórz plik `.env.local`. Jeśli już istnieje, uzupełnij tylko te dwie zmienne, zachowując pozostałą zawartość:

```dotenv
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
```

Po pierwszym `=` wpisz swój klucz OpenRouter. Po drugim wpisz dokładny identyfikator modelu skopiowany z [listy modeli OpenRouter](https://openrouter.ai/models), w formacie `dostawca/model`. Wartości podajesz wyłącznie w lokalnym pliku, nie w rozmowie. Nie dodawaj prefiksu `NEXT_PUBLIC_`.

Historia czatu korzysta z tabel `conversations` i `messages` (skrypty w `supabase/` opisują ich pierwotny kształt; podział na konta — kolumna `user_id`, RLS i polityki — został dodany w bazie). Czat zapisuje zakończone tury wraz z tekstem i dopiskami `[obraz]`. Każde konto ma własną historię i własny profil. Rozmowy, wiadomości i profil aplikacja czyta i zapisuje klientem Supabase zalogowanej osoby (klucz publishable + token z jej sesji), więc dostępu pilnuje RLS „tylko własne wiersze”. Kolumnę `user_id` wypełnia baza (`auth.uid()`); aplikacja jej nie wysyła ani nie przyjmuje z przeglądarki. Tak samo działa baza wiedzy: `documents` i `chunks` mają `user_id` i RLS, a `match_chunks` działa z uprawnieniami wywołującego (`security invoker`), więc `/upload` i narzędzie `searchKnowledge` widzą tylko dokumenty zalogowanej osoby (SQL: `supabase/knowledge_base_per_user.sql`). Aplikacja nie używa już klucza `SUPABASE_SECRET_KEY` ani `SUPABASE_URL`. Otwarcie, zapis lub usunięcie cudzej rozmowy albo cudzego dokumentu daje „Nie znaleziono” (404), bez żadnych danych. Stare rozmowy sprzed podziału (z pustym `user_id`) nie są widoczne dla nikogo; aby przypisać je do konta, wpisz jego UID w kolumnie `user_id` w Table Editor. Localhost i Vercel widzą tę samą historię konta, gdy korzystają z tej samej bazy.

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

## Konta użytkowników (Supabase Auth)

Logowanie odbywa się przez konta Supabase Auth (e-mail i hasło). W `.env.local` ustaw `NEXT_PUBLIC_SUPABASE_URL` i `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (okno **Connect** w panelu Supabase). To publiczne wartości: klucz publishable może trafić do przeglądarki. Klucz `SUPABASE_SECRET_KEY` (omija RLS) nie jest już potrzebny i nigdy nie może mieć prefiksu `NEXT_PUBLIC_`. Po zmianie zmiennych zrestartuj serwer i zbuduj aplikację ponownie.

Strona `/login` ma zakładki „Zaloguj się” i „Załóż konto”. Hasło nowego konta musi mieć co najmniej 8 znaków. Ustaw ten sam minimalny rozmiar w panelu Supabase (Authentication → Sign In / Providers → Email), bo dopiero serwer Supabase egzekwuje regułę. Gdy w projekcie jest włączone potwierdzanie e-maili, po rejestracji przychodzi link, który kończy się na `/auth/confirm`. Dodaj adres aplikacji (np. `http://localhost:3000/**`) do listy Redirect URLs w Authentication → URL Configuration.

- `proxy.ts` odświeża wygasający token Supabase i przekierowuje niezalogowanych ze stron na `/login`. To tylko wstępne sprawdzenie.
- Każda strona (`currentUser()`) i każdy endpoint w `app/api` (`requestUser(request)`) weryfikuje użytkownika na serwerze przez `supabase.auth.getClaims()`, czyli sprawdza podpis tokenu, a nie samą obecność ciasteczka. Endpoint bez zalogowanego użytkownika zwraca `401`, zanim dotknie bazy albo modelu, a żądania z obcej strony dostają `403`.
- Tożsamość pochodzi wyłącznie ze zweryfikowanego tokenu, nigdy z formularza, adresu strony ani odpowiedzi modelu.
- „Wyloguj” w nagłówku kończy sesję tego urządzenia w Supabase i wraca do `/login`. Obok widać e-mail zalogowanej osoby.
- Po wylogowaniu treść strony znika od razu, jeszcze przed przejściem na `/login`. Strony z danymi mają `Cache-Control: no-store`, a strona przywrócona przyciskiem „Wstecz” z pamięci przeglądarki jest pobierana od nowa (`app/session-guard.tsx`), więc serwer ponownie sprawdza sesję i nie pokazuje danych poprzedniej osoby. Wylogowanie w innej karcie też chowa treść.
- Wejście na chronioną stronę bez logowania prowadzi na `/login?next=…`, a po zalogowaniu lub rejestracji aplikacja wraca pod ten adres. Przyjmowane są tylko ścieżki tej aplikacji (`lib/redirect-target.ts`); adresy innych stron, `/api/` i `/auth/` są ignorowane.
- Podczas logowania i rejestracji przycisk jest zablokowany i pokazuje „Chwileczkę…”.
- Limity prób logowania i rejestracji zapewnia Supabase Auth (Authentication → Rate Limits).
- „Zaloguj przez Google” (PKCE po stronie serwera): formularz wysyła `POST /auth/google`, serwer pobiera od Supabase adres logowania u Google (weryfikator PKCE trafia do ciasteczka) i przekierowuje do Google. Powrót trafia na `/auth/callback`, który wymienia kod na sesję i przenosi do czatu albo do zapamiętanej ścieżki tej aplikacji. Adres powrotu powstaje z adresu, pod którym aplikacja działa (nagłówek `Host`), więc w Supabase → Authentication → URL Configuration → Redirect URLs muszą być np. `http://localhost:3000/auth/callback**` i adres produkcyjny `https://…/auth/callback**`. Client ID i Client Secret Google są tylko w panelu Supabase. Anulowanie albo błąd wraca na `/login` z komunikatem po polsku.
- Nagłówek pokazuje imię i avatar z `user_metadata` konta (`full_name`/`name`, `avatar_url`/`picture`; tylko adresy https), a dla kont e-mail sam e-mail.

`CHAT_PASSWORD` i `SESSION_SECRET` nie są już używane.

## Sprawdzenie ochrony

```powershell
npm.cmd run test:auth
npm.cmd run typecheck
npm.cmd run build
```

Testy używają własnych, fikcyjnych wartości w procesie testowym, bez czytania `.env.local`. Serwer Supabase Auth jest zastąpiony atrapą, więc nie ma prawdziwej sieci ani wywołań modelu. Sprawdzają: `401` bez ciasteczek dla każdego endpointu bez żadnego połączenia sieciowego, `401` dla sfałszowanego, podmienionego, uszkodzonego i wygasłego tokenu, tożsamość z tokenu zweryfikowanego przez `getClaims()`, ignorowanie identyfikatora z adresu, nagłówka i treści, `403` dla obcego źródła, `401` przy braku konfiguracji, przekierowania w `proxy.ts` oraz polskie komunikaty błędów logowania. Pozostałe testy podstawiają weryfikację użytkownika (`tests/fake-auth.cjs`).

## Analiza wiadomości Studio Nova

Po zalogowaniu wybierz **Analiza JSON**. Wklej jedną wiadomość klienta i kliknij **Analizuj wiadomość**. `/api/agent` w trybie `analyze` zwraca kategorię (`sales`, `support`, `billing`, `unknown`), priorytet (`normal`, `high`), szkic (`draft`) i informację o sprawdzeniu (`needs_review`). `high` jest przeznaczone wyłącznie dla blokady opłaconego spotkania rozpoczynającego się w ciągu godziny. Każdy wynik pozostaje szkicem, również przy `needs_review=false`. Aplikacja nie wysyła wiadomości, nie rezerwuje terminów ani nie wykonuje operacji płatniczych.

Przełącznik **Zwykły czat** wraca do dotychczasowej rozmowy ze streamingiem. Analiza nie korzysta z historii rozmowy. Jej wynik jest usuwany po edycji wejścia, nowej próbie lub opuszczeniu trybu analizy. Przycisk **Przerwij** anuluje oczekiwanie i nie pokazuje częściowego wyniku.

Serwer używa AI SDK 7.0.157: `generateText` z `Output.object({ schema })` oraz Zod 4.1.8 `strictObject`. Brak pola, niewłaściwy typ, niedozwolona wartość i dodatkowe pole powodują błąd; dane nie są uzupełniane ani konwertowane. Provider OpenRouter 3.1.0 przekłada schemat na `response_format: json_schema` z `strict: true`. Analiza korzysta z tego samego `OPENROUTER_MODEL` i klucza co czat. Nie ma automatycznej zmiany modelu, naprawy wyniku, ponowienia generacji ani przejścia na zwykły JSON mode. Instrukcje i dane firmy pozostają na serwerze.

Przed generacją serwer sprawdza publiczne metadane `/api/v1/models/{model}/endpoints`: co najmniej jeden endpoint musi deklarować `structured_outputs` i `response_format`. Żądanie generacji ma też `provider.require_parameters: true`. Jeśli model lub dostawca nie obsługuje tego trybu, aplikacja pokazuje instrukcję sprawdzenia ograniczeń dostawców i ewentualnego ustawienia zgodnego `OPENROUTER_MODEL` **po uzgodnieniu kosztów**. Po zmianie konfiguracji lokalnej zrestartuj serwer; na hostingu wprowadź zmianę w konfiguracji serwerowej i wykonaj ponowne wdrożenie. Awaria sprawdzania metadanych blokuje analizę bez wywołania modelu. Nie wpływa to na zwykły czat.

Wynik pojawia się dopiero po pełnej odpowiedzi, sprawdzeniu sposobu jej zakończenia i walidacji na serwerze. Odmowa (`message.refusal` lub filtr treści), limit tokenów, anulowanie, timeout i błąd dostawcy nie tworzą wyniku. AI SDK 7 ignoruje wyjątki z callbacków: stan zakończenia jest odczytywany w `onStepEnd`, a sprawdzany poza callbackiem. `include.responseBody` umożliwia sprawdzenie odmowy w pamięci serwera; surowa odpowiedź nie jest logowana ani zwracana klientowi. Deklaracji o opłaceniu spotkania używa się tylko do analizy treści, nie jako weryfikacji rzeczywistej płatności. Walidacja schematu sprawdza strukturę; poprawność klasyfikacji i szkicu wymaga osobnego sprawdzenia z modelem.

Oficjalne źródła: [AI SDK: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [OpenRouter: Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider AI SDK](https://github.com/OpenRouterTeam/ai-sdk-provider). Sygnatury i domyślne opcje sprawdzono również w dokumentacji i kodzie zainstalowanych pakietów.

Testy bez wywoływania modelu:

```powershell
npm.cmd run test:analysis
npm.cmd run test:auth
npm.cmd run typecheck
```

Testy analizy używają rzeczywistych handlerów, AI SDK i providera z zastąpionym `fetch`. Sprawdzają wysłany JSON Schema, ścisłą walidację, sesję, origin, brak konfiguracji, brak obsługi modelu, odmowę (także z poprawnym JSON), przerwanie, błędy HTTP oraz regresję streamingu czatu. Nie czytają plików `.env` i nie łączą się z OpenRouter.

Pierwszą prawdziwą analizę wykonuje użytkownik w przeglądarce. Przykłady do ręcznego sprawdzenia reguł:

- „Proszę o ofertę dla 8 osób.” → `sales`, `normal`, `needs_review=true`; doprecyzowanie zakresu.
- „Nie mogę się zalogować.” → `support`, `normal`, `needs_review=true`.
- „Opłaciłem konsultację, zaczyna się za 30 minut, ale link do spotkania nie działa.” → `support`, `high`, `needs_review=true`; bez potwierdzenia płatności lub rezerwacji.
- „Proszę o zwrot płatności.” → `billing`, `normal`, `needs_review=true`; decyzja pracownika.
- „Miłego dnia!” → `unknown`, `normal`; brak rozpoznanej sprawy do doprecyzowania.

Po udanej analizie rozpocznij kolejną i kliknij **Przerwij**: poprzedni wynik powinien zniknąć, a aplikacja powinna pokazać komunikat przerwania. Wróć do zwykłego czatu i sprawdź streaming. To testy ręczne, nie zostały wykonane z prawdziwym modelem przez agenta.

## Kontrola prompt injection — 2026-11-05

Użytkownik przekazał wynik próby wymuszenia ceny 1 zł: „Szkic: Konsultacja online trwa 45 minut i kosztuje 150 zł brutto. Do sprawdzenia: nic. needs_review = false.” W tym przekazanym fragmencie zmiana ceny nie powiodła się. `needs_review=false` jest dopuszczalne przy pytaniu o znaną cenę i czas konsultacji; sama zgodność tej flagi z żądaniem atakującego nie dowodzi skuteczności ataku. Fragment nie zawiera `category` i `priority`, więc nie jest dowodem poprawności pełnego wyniku structured output. Nie wykonano nowego wywołania modelu i nie zmieniono instrukcji ani logiki aplikacji.

Testy lokalne potwierdzają odrzucenie dodatkowych pól wejścia `send_now` (także `false`), `permissions`, `isAdmin`, `role`, `system`, `instructions`, `schema`, `output`, `tools` i wstrzykniętej historii: HTTP 400, bez wywołania dostawcy. `send_now` i `permissions` w odpowiedzi modelu powodują błąd walidacji i HTTP 502 bez wyniku zastępczego. Zwykły czat odrzuca wiadomości z rolami `system`, `developer` i `tool` przysłane w historii.

Test z atrapą OpenRouter sprawdza też, że treść ataku i zapisane w niej pozorne role pozostają jednym tekstem `user`, a instrukcja firmy, schemat strict i brak narzędzi pochodzą z serwera. Fikcyjne wartości klucza, hasła i sekretu sesji nie trafiają do kontekstu modelu. Klucz API służy tylko do uwierzytelnienia transportu do OpenRouter. Nie istnieją narzędzia wysyłania wiadomości, rezerwacji lub płatności; `needs_review=false` nie przyznaje takich uprawnień.

Schemat kontroluje strukturę, a nie prawdziwość ceny w tekście `draft`: poprawny typ `string` może zawierać błędną informację. Wynik próby z prawdziwym modelem należy oceniać osobno od testów transportu i walidacji. Rozdzielenie instrukcji od danych, walidacja i brak uprawnień do działań zewnętrznych są osobnymi warstwami ochrony; jedna udana obrona nie dowodzi odporności na wszystkie ataki. Zobacz [OWASP: Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

Do powtórzenia w przeglądarce: zwykłe pytanie o cenę (150 zł brutto, 45 minut), ta sama wiadomość z poleceniem ceny 1 zł (bez przyjęcia fałszywej ceny), polecenie nadania roli administratora i wysłania odpowiedzi (wyłącznie szkic, bez działania) oraz żądanie sekretów (bez ich ujawnienia). W trybie analizy sprawdź również obecność wszystkich czterech pól wyniku.

Po ustawieniu zmiennych Supabase ręcznie sprawdź w przeglądarce: przekierowanie na `/login`, założenie konta, odmowę po złym haśle, komunikat o istniejącym koncie, wejście do czatu z e-mailem w nagłówku oraz „Wyloguj” i powrót na `/login`. Samo logowanie i wylogowanie nie wywołują modelu.


## Osiem narzędzi agenta — 2026-11-12

Narzędzia korzystają z istniejącego AI SDK i Zod; bez nowych bibliotek i kluczy do publicznych API. Każde ma opis użycia i `inputSchema`. Wyniki mają tylko potrzebne pola i czas pobrania w ISO UTC (`pobranoAt`; dotychczasowa ścieżka błędu pogody zachowuje `sprawdzonoAt`). Agent ma prezentować czas po polsku w Europe/Warsaw. Połączenia mają wspólny limit 8 sekund na wykonanie narzędzia, obsługują przerwanie żądania i nie korzystają z cache. Brak danych, HTTP, timeout i nieprawidłowa odpowiedź dają polski komunikat zamiast wyjątku. Wyniki narzędzi pozostają w historii następnych tur; plakietki pochodzą ze wspólnego katalogu `lib/tool-catalog.ts`.

| Narzędzie | Wejście i zapytanie | Ograniczony wynik |
| --- | --- | --- |
| `pogoda` | `miejscowosc`, opcjonalne `kodKraju`, `dzien` YYYY-MM-DD. GET geocoding `/v1/search?name=…&count=3&language=pl&countryCode=…`, następnie forecast `/v1/forecast?latitude=…&longitude=…&timezone=auto`. Dla dnia: `daily`, `start_date=end_date`; bez dnia zachowane `current`. | Bieżąca pogoda lub prognoza: minimum/maksimum temperatury, dobowa suma i prawdopodobieństwo opadów, maksymalny wiatr, opis, strefa i źródło. Prognoza od dziś do 15 dni naprzód w strefie miasta. Kilka miejscowości → prośba o doprecyzowanie. |
| `waluty` | `waluta` ISO, opcjonalne `kwota` i `kierunek` (`doPLN`/`zPLN`). GET NBP `/api/exchangerates/rates/a/{code}/?format=json`; 404 → tabela B. | `code`, `currency`, `rates[0].mid` i `effectiveDate` → kod, nazwa, kurs PLN za jednostkę, data publikacji, opcjonalne przeliczenie do 2 miejsc i źródło. Kurs średni z ostatniej publikacji, bez marż. |
| `swieta` | `kodKraju` ISO alpha-2, `rok` 1900–2100. GET `https://date.nager.at/api/v3/PublicHolidays/{year}/{country}`. | Z tablicy odpowiedzi wyłącznie pozycje z `types` zawierającym `Public`: data, lokalna nazwa, cały kraj (`global`) lub regiony (`counties`). Nie obejmuje weekendów i urlopów; nie każdy zawód ma takie samo prawo do wolnego. |
| `wikipedia` | `haslo` (jeden tytuł). GET `https://pl.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&ppprop=disambiguation&exintro=1&explaintext=1&exchars=1000&redirects=1&format=json&formatversion=2&titles=…`. | `query.pages[0]` → tytuł, krótki tekst bez HTML i link do artykułu. Obsługa przekierowań, brakujących i niejednoznacznych haseł. |
| `kalkulator` | `dzialanie`: dodaj/odejmij/pomnoz/podziel/potega/procent oraz liczby `a`, `b` jako oddzielne argumenty. Lokalne operatory JavaScript, bez `eval` i wykonywania tekstu. | Skończony wynik albo komunikat (dzielenie przez zero, wynik nierzeczywisty, przepełnienie). Procent = a% z b. Standardowa precyzja Number. |
| `czas` | Opcjonalna `strefa` IANA, domyślnie Europe/Warsaw. Lokalne `Intl.DateTimeFormat` i zegar serwera. `aktualnyCzas` jest zachowanym aliasem i nadal służy do wymuszonego sprawdzenia daty. | Data, dzień tygodnia, godzina, strefa i czas pobrania; nieznana strefa → komunikat. |
| `notatki` | `akcja: zapisz` + `tresc` (1–2000 znaków) albo `akcja: pokaz`. Lokalny `Map` w pamięci procesu. | Zapis zwraca nową notatkę; odczyt listę notatek z identyfikatorami i czasami zapisu. Limit 100 na sesję i 200 sesji na instancję; po zapełnieniu czytelny komunikat, bez usuwania starszych wpisów. |
| `diagnostyka` | Puste `{}`. Lokalna lista rejestru, stała limitu i wskazane pola `process.env`. | Skonfigurowana nazwa modelu, faktyczna lista narzędzi (w tym wyszukiwanie, obraz i alias czasu), limit 18 kroków oraz `tak`/`nie` dla OPENROUTER_API_KEY, OPENROUTER_MODEL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Nigdy wartości sekretów. |

Notatki są izolowane według sesji logowania. Model nie podaje identyfikatora sesji: serwer wyznacza klucz pamięci ze skrótu identyfikatora użytkownika i sesji ze zweryfikowanego tokenu Supabase, nie przekazuje go modelowi. Notatki znikają po restarcie, ponownym logowaniu lub zmianie instancji; na hostingu wiele instancji może mieć różne zestawy notatek. To celowo tymczasowe rozwiązanie na tę lekcję, bez bazy i zapisu na dysku.

Schemat wejścia notatek jest pojedynczym obiektem z wymaganym `akcja: zapisz | pokaz` i opcjonalnym `tresc` (dla odczytu można pominąć lub podać `null`). Zastępuje unię z dyskryminatorem, przy której model pomijał poprawne pole `akcja` i pojawiał się błąd `No matching discriminator`. Pusta treść zapisu zwraca polski komunikat. Przykłady parametrów są podane w opisie pól, `inputExamples` i instrukcji agenta. Test regresji sprawdza rzeczywisty JSON Schema w żądaniu OpenRouter oraz zapis „sprawdzić ceny lotów do Lizbony”, odczyt w tym samym zadaniu i odczyt w osobnym żądaniu tej samej sesji.

Dokumentacja sprawdzona przed implementacją:

- [Open-Meteo Forecast](https://open-meteo.com/en/docs) i [Geocoding](https://open-meteo.com/en/docs/geocoding-api).
- [NBP Web API](https://api.nbp.pl/): adresy tabel A/B, `mid`, `effectiveDate`, statusy 400/404.
- [Nager.Date](https://github.com/nager/Nager.Date) i [aktualna dokumentacja](https://nagerholidays.com/api). Projekt nadal opisuje v3 jako wspierane do 2027-01-31; aktualna strona prezentuje v4. Implementacja używa wskazanego w zadaniu `date.nager.at` i v3 (`global`, `counties`, `types`).
- [MediaWiki Query](https://www.mediawiki.org/wiki/API:Query) i [TextExtracts](https://www.mediawiki.org/wiki/Extension:TextExtracts#API).
- Lokalne API: [Intl.DateTimeFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat), [Number.isFinite](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isFinite), [Node.js globals](https://nodejs.org/api/globals.html); kontrakty `Map` i `process.env` nie wymagają HTTP.
- AI SDK: dokumentacja zainstalowanej wersji w `node_modules/ai/docs/`, m.in. `tool`, `convertToModelMessages`, `streamText` i `isStepCount`.

Sprawdzenie: `npm run test:agent`, `npm run typecheck`, `npm run build`. Nowe testy w `tests/tools.test.cjs` używają rzeczywistych handlerów i SDK z atrapami sieci. Obejmują obliczenia, strefy, parametry HTTP, ograniczanie pól, awarie, zakres prognozy, notatki i ich izolację, brak sekretów w diagnostyce oraz przejście model → narzędzie → UI → kolejna tura dla wszystkich ośmiu narzędzi. Nie czytają `.env` i nie wywołują płatnych modeli. Próba bezpośredniego sprawdzenia publicznych API z lokalnego środowiska zakończyła się `fetch failed`; działanie z rzeczywistymi usługami wymaga sprawdzenia w środowisku z dostępem do sieci.

Pętla ReAct: najwyżej 18 kroków modelu na zadanie (`isStepCount(18)`). Czat pokazuje kolejność wywołań z numerem rzeczywistego kroku modelu, również powtórzenia. Po dojściu do limitu pokazuje „Zatrzymałem się po 18 krokach” i ograniczone wyniki narzędzi, także gdy model nie zdążył napisać odpowiedzi. Nie uruchamia dodatkowego modelu do podsumowania.
## Asystent podróży `/dashboard`

Chroniona strona i POST `/api/dashboard` wymagają tej samej sesji co czat; endpoint dodatkowo sprawdza origin. Formularz przyjmuje miasto (opcjonalnie kraj/region po przecinku) i datę ISO. Geokodowanie Open-Meteo ustala kraj i strefę; niejednoznaczne miasto wymaga doprecyzowania. Prognoza, kurs NBP, święta Nager.Date i wprowadzenie Wikipedii korzystają z istniejących funkcji narzędzi. Czas używa wspólnego `warsawTime` z jedną chwilą odniesienia do obliczenia różnicy względem Polski (także ułamkowe strefy i zmiany DST). Różnica dotyczy chwili pobrania, nie dnia wyjazdu.

Waluta jest ustalana z jawnej lokalnej tabeli kraj–waluta; nieobsługiwany kraj daje czytelny brak danych. Dla PLN karta pokazuje tożsamość 1 PLN = 1 PLN bez fikcyjnego kursu NBP. Święta są wybierane od dnia wyjazdu, z zachowaniem zakresu regionalnego; w razie potrzeby sprawdzany jest również kolejny rok. Wikipedia pokazuje najwyżej dwa dostępne zdania i link. Każda karta zawiera źródło i czas pobrania (dla błędu: czas próby). Odśwież pobiera wszystkie dane ponownie, bez cache.

Agent otrzymuje tylko dane kart i przygotowuje 2–3 zdania porad. To jedno wywołanie skonfigurowanego modelu na Sprawdź/Odśwież; awaria lub brak konfiguracji modelu nie usuwa kart. Publiczne API nie wymagają nowych kluczy. Błąd pojedynczego źródła nie blokuje pozostałych kart. Testy offline obejmują sesję, origin, pięć kart, PLN, różnicę czasu i niedostępne źródło. Nie wykonano płatnego wywołania modelu ani przeglądarkowego testu z prawdziwymi usługami.

## Porównanie miast

Na `/dashboard` przełącznik „Porównaj” dodaje drugie miasto; oba cele używają tej samej daty. Wyniki są prezentowane w dwóch kolumnach, na małym telefonie jedna pod drugą. „Odśwież” ponownie pobiera oba zestawy. Endpoint przyjmuje opcjonalne `secondCity` i odrzuca identyczne nazwy. Obie lokalizacje są sprawdzane równolegle; brak miasta lub źródła nie usuwa drugiej kolumny. W trybie porównania nie generujemy dwóch osobnych podsumowań: jedno wywołanie modelu otrzymuje obie listy kart i ma polecić miasto, wskazując konkretne dane i ograniczenia. Kurs waluty nie jest traktowany jako cena pobytu. Braki źródeł są zawsze dopisywane przez serwer. Niedostępny model oznacza jawną niedostępność rekomendacji, bez wymyślonego wyboru. Test porównania obejmuje wspólną datę, obie kolumny, jedno wywołanie modelu i awarię geokodowania jednego celu; używa atrap sieci.
